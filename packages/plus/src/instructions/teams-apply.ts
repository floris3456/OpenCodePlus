import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Effect, Exit, Scope, type Types } from "effect"
import fs from "node:fs/promises"
import { agentBody } from "./discover.js"
import type { AgentSource } from "./model.js"
import { discoverTeams, resolveTeams, type TeamRecord } from "./teams.js"

// Enabled teams become real core-visible agents. Every publish resolves the
// enabled teams against the discovered regular agents (the resolveTeams
// collision rule already favours an established same-level regular, so a
// losing team copy never reaches the installer) and installs each winner
// through its own agent.transform registration. The registrations join
// state.applied beside apply's own, so disabling a team drops its members
// when the next publish disposes the superseded set, and deactivation clears
// them all. A member installs as a full agent definition: the markdown body
// after the frontmatter fence becomes system, defined frontmatter fields
// overlay the host's current registry entry. A file that disappears or cannot
// be read fails the pass and unwinds the members installed earlier in it.
export interface TeamApplied {
  readonly registrations: Registration[]
}

export async function resolveTeamAgents(
  directory: string,
  records: readonly TeamRecord[],
  regular: readonly AgentSource[],
): Promise<readonly AgentSource[]> {
  const discovered = await Promise.all([discoverTeams("project", directory), discoverTeams("global", directory)])
  return resolveTeams(discovered.flat(), records, regular).agents
}

// First entry per id wins: discover returns the effective agent followed by
// its shadowed scope identities, and every apply loop (roles, skills, base,
// tools, instructions) iterates agents in order with last write winning —
// without this the shadowed copy overwrites the effective one. Discovery
// itself keeps the shadows for scope resolution and the UI; only the apply
// input is deduped.
export function dedupeAgents(agents: readonly AgentSource[]): readonly AgentSource[] {
  return agents.filter((agent, index) => agents.findIndex((entry) => entry.id === agent.id) === index)
}

export async function installTeamAgents(ctx: Context, agents: readonly AgentSource[]): Promise<TeamApplied> {
  const installed: Registration[] = []
  // Registrations live on detached scopes so a partial failure must be unwound explicitly.
  try {
    for (const agent of agents) {
      if (agent.path === undefined) continue
      const text = await fs.readFile(agent.path, "utf8")
      const fields = parseFrontmatter(text)
      // A member file marked disabled follows core file semantics: it removes
      // rather than installs, so there is nothing to register for it.
      if (fields.disabled === true) continue
      installed.push(await runTeamRegistration(ctx, agent.id, agentBody(text), fields))
    }
    if (installed.length > 0) await Effect.runPromise(ctx.agent.reload())
    return { registrations: [...installed] }
  } catch (error) {
    await disposeRegistrations(installed)
    throw error
  }
}

type Draft = Types.DeepMutable<Agent.Info>

export interface TeamPermission {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

export interface TeamRequest {
  readonly headers?: Record<string, string>
  readonly body?: Record<string, unknown>
}

export interface TeamFields {
  readonly model?: string
  readonly variant?: string
  readonly description?: string
  readonly mode?: Draft["mode"]
  readonly hidden?: boolean
  readonly color?: string
  readonly steps?: number
  readonly disabled?: boolean
  readonly request?: TeamRequest
  readonly permissions: readonly TeamPermission[]
}

// One registration per member so a later member's failure unwinds the earlier
// members. Core's editor.update upserts against the host's current registry
// entry: nothing pre-exists for a team-only id (team files are invisible to
// core, which only decodes its own agent directories), and an id the host
// already holds (a defaults template the team outranks) is overwritten with
// the member body and fields while leaving the other registered fields (name,
// request defaults, core permissions) in place. Disposing the registration
// rebuilds the host view without it, which removes team-only ids and restores
// overwritten ones.
async function runTeamRegistration(ctx: Context, id: string, body: string, fields: TeamFields): Promise<Registration> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      return yield* Effect.suspend(() =>
        ctx.agent.transform((editor: AgentEditor) => applyTeamAgent(editor, id, body, fields)),
      ).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)).pipe(Effect.ignoreCause)),
      )
    }),
  )
}

async function disposeRegistrations(registrations: readonly Registration[]): Promise<void> {
  const reversed = registrations.slice().reverse()
  for (const registration of reversed) {
    await Effect.runPromise(registration.dispose).catch(() => {})
  }
}

export function applyTeamAgent(editor: AgentEditor, id: string, body: string, fields: TeamFields): void {
  editor.update(id, (agent) => {
    const ref = parseModelRef(fields.model, fields.variant)
    if (ref !== undefined) agent.model = ref
    if (fields.description !== undefined) agent.description = fields.description
    if (fields.mode !== undefined) agent.mode = fields.mode
    if (fields.hidden !== undefined) agent.hidden = fields.hidden
    if (fields.color !== undefined) agent.color = fields.color
    // PositiveInt is a branded number; the >0 integer check happens at parse.
    if (fields.steps !== undefined) agent.steps = fields.steps as Draft["steps"]
    if (fields.request?.headers !== undefined) Object.assign(agent.request.headers, fields.request.headers)
    if (fields.request?.body !== undefined) Object.assign(agent.request.body, fields.request.body)
    agent.system = body
    agent.permissions.push(...fields.permissions)
  })
}

// Team files share the files.ts frontmatter+body format: `model` is a
// provider/id#variant ref string with an optional separate `variant` legacy
// join. An unparseable model leaves the registry entry untouched rather than
// failing the whole pass.
function parseModelRef(model: string | undefined, variant: string | undefined): Model.Ref | undefined {
  if (model === undefined) return undefined
  const suffixed = variant === undefined || model.includes("#") ? model : `${model}#${variant}`
  try {
    return Model.Ref.parse(suffixed)
  } catch {
    return undefined
  }
}

// Exported so the publish fingerprint can compare the host back against the
// file-applied fields: while the host still shows exactly what the team file
// installed, discovery must report upstream (absent) instead of Plus output.
export function parseTeamFields(markdown: string): TeamFields {
  return parseFrontmatter(markdown)
}

function parseFrontmatter(markdown: string): TeamFields {
  const fields = readFrontmatter(markdown)
  if (fields === undefined) return { permissions: [] }
  const mode = fields.mode === "subagent" || fields.mode === "primary" || fields.mode === "all" ? fields.mode : undefined
  const steps =
    typeof fields.steps === "number" && Number.isInteger(fields.steps) && fields.steps > 0 ? fields.steps : undefined
  const color = typeof fields.color === "string" && /^#[0-9a-fA-F]{6}$/.test(fields.color) ? fields.color : undefined
  const request = parseRequest(fields.request)
  return {
    ...(typeof fields.model === "string" ? { model: fields.model } : {}),
    ...(typeof fields.variant === "string" ? { variant: fields.variant } : {}),
    ...(typeof fields.description === "string" ? { description: fields.description } : {}),
    ...(mode === undefined ? {} : { mode }),
    ...(typeof fields.hidden === "boolean" ? { hidden: fields.hidden } : {}),
    ...(color === undefined ? {} : { color }),
    ...(steps === undefined ? {} : { steps }),
    ...(fields.disabled === true ? { disabled: true as const } : {}),
    ...(request === undefined ? {} : { request }),
    permissions: parsePermissions(fields.permissions),
  }
}

function readFrontmatter(markdown: string): Record<string, unknown> | undefined {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return undefined
  try {
    const data = Bun.YAML.parse(match[1] ?? "")
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
    return data as Record<string, unknown>
  } catch {
    return undefined
  }
}

function parseRequest(value: unknown): TeamRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const request = value as Record<string, unknown>
  const headers = stringRecord(request.headers)
  const body = recordOf(request.body)
  if (headers === undefined && body === undefined) return undefined
  return { ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  )
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function parsePermissions(value: unknown): readonly TeamPermission[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((rule): readonly TeamPermission[] => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return []
    const candidate = rule as Record<string, unknown>
    if (typeof candidate.action !== "string" || typeof candidate.resource !== "string") return []
    if (candidate.effect !== "allow" && candidate.effect !== "deny" && candidate.effect !== "ask") return []
    return [{ action: candidate.action, resource: candidate.resource, effect: candidate.effect }]
  })
}
