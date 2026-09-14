import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration, Transform } from "@opencode/plugin/effect/registration"
import type { SessionContext, SessionHooks } from "@opencode/plugin/effect/session"
import type { SkillEditor } from "@opencode/plugin/effect/skill"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Skill } from "@opencode/schema/skill"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Deferred, Effect, Exit, Scope } from "effect"
import { applies, resolve, type CustomizationRecord, type Item, type Level, type Scopes, type SplitRecord } from "./model.js"

export interface ApplyAgent {
  readonly id: string
  readonly level: Level
  /** Host classification of the base template active for this agent. Threaded from discover; never re-derived. */
  readonly base?: string | undefined
  /** True when the agent defines its own custom system prompt. Base edits never touch such agents. */
  readonly customSystem?: boolean | undefined
}

export interface ApplyInput {
  readonly items: readonly Item[]
  readonly agents: readonly ApplyAgent[]
  readonly records: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
}

export interface Applied {
  readonly registrations: Registration[]
}

export async function apply(ctx: Context, input: ApplyInput): Promise<Applied> {
  if (input.records.length === 0) return { registrations: [] }
  const installed: Registration[] = []
  // Registrations live on detached scopes so a partial failure must be unwound explicitly.
  try {
    const role = await applyRoles(ctx, input)
    if (role !== undefined) installed.push(role)
    const skills = await applySkills(ctx, input, (registration) => installed.push(registration))
    const session = await applySession(ctx, input)
    if (session !== undefined) installed.push(session)
    const mcp = await applyMcp(ctx, input)
    if (mcp !== undefined) installed.push(mcp)
    if (role !== undefined || skills.agentChanged) await runVoid(ctx.agent.reload())
    if (skills.skillChanged) await runVoid(ctx.skill.reload())
    if (mcp !== undefined) await runVoid(ctx.mcp.reload())
    return { registrations: [...installed] }
  } catch (error) {
    await disposeRegistrations(installed)
    throw error
  }
}

async function disposeRegistrations(registrations: readonly Registration[]): Promise<void> {
  const reversed = registrations.slice().reverse()
  for (const registration of reversed) {
    await Effect.runPromise(registration.dispose).catch(() => {})
  }
}

async function runVoid(effect: Effect.Effect<void>): Promise<void> {
  await Effect.runPromise(effect)
}

async function runRegistration<Editor>(
  transform: Transform<Editor>,
  callback: (editor: Editor) => void,
): Promise<Registration> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      return yield* Effect.suspend(() => transform(callback)).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)).pipe(Effect.ignoreCause)),
      )
    }),
  )
}

async function runHook<Name extends "context">(
  hook: (name: Name, callback: (input: SessionHooks[Name]) => Effect.Effect<void>) => Effect.Effect<Registration, never, Scope.Scope>,
  name: Name,
  callback: (input: SessionHooks[Name]) => Effect.Effect<void>,
): Promise<Registration> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      return yield* Effect.suspend(() => hook(name, callback)).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)).pipe(Effect.ignoreCause)),
      )
    }),
  )
}

interface ChainArgs {
  readonly records: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
}

function resolvedFor(item: Item, agent: ApplyAgent, args: ChainArgs) {
  return resolve({
    upstream: item,
    records: args.records,
    splits: args.splits,
    scopes: args.scopes,
    address: { level: agent.level, agent: agent.id, item: item.id, section: null },
  })
}

function isNoop(item: Item, resolved: { assembled: string; enabled: boolean }): boolean {
  return resolved.assembled === item.text && resolved.enabled === item.enabled
}

// A skill installs a copy, denial or rule only when its resolved view for
// that agent differs from upstream: changed text, changed enablement, or a
// changed assembled body (section exclusions). Comparing the assembled body
// alone cannot decide this, because assemble also normalizes whitespace —
// so an unchanged resolution with lossy text must install nothing, while a
// section exclusion that changes the assembled body beyond normalization
// still installs its private copy.
function skillCustomized(item: Item, resolved: { text: string; assembled: string; enabled: boolean }): boolean {
  if (resolved.text !== item.text) return true
  if (resolved.enabled !== item.enabled) return true
  if (normalizeLossless(resolved.assembled) !== normalizeLossless(item.text)) return true
  return false
}

// The assemble normalization applied to text that carries no sections and no
// exclusions: whitespace collapsing plus trim. When the assembled body equals
// this, the difference from raw upstream is formatting loss, not a user
// customization.
function normalizeLossless(text: string): string {
  return text.replace(/\n(?:[ \t]*\n)+/g, "\n\n").trim()
}

function parseId(id: string, prefix: string): string {
  if (id.startsWith(prefix)) return id.slice(prefix.length)
  return id
}

async function applyRoles(ctx: Context, input: ApplyInput): Promise<Registration | undefined> {
  const updates = input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "system") return []
      if (item.id !== "system:role") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      if (resolved.assembled === item.text && resolved.enabled === item.enabled) return []
      // A disabled role never clears the agent system text.
      if (!resolved.enabled) return []
      return [{ agent: agent.id, text: resolved.assembled }]
    }),
  )
  if (updates.length === 0) return undefined
  return runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
    for (const update of updates) {
      if (!editor.get(update.agent)) continue
      editor.update(update.agent, (agent) => {
        agent.system = update.text
      })
    }
  })
}

interface SkillApplied {
  readonly agentChanged: boolean
  readonly skillChanged: boolean
}

async function applySkills(
  ctx: Context,
  input: ApplyInput,
  onInstall: (registration: Registration) => void,
): Promise<SkillApplied> {
  const denials = input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "skill") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      if (!skillCustomized(item, resolved)) return []
      if (resolved.enabled) return []
      return [{ agent: agent.id, skill: parseId(item.id, "skill:") }]
    }),
  )
  const copies = input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "skill") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      if (!skillCustomized(item, resolved)) return []
      if (!resolved.enabled) return []
      // A copy identical to upstream adds nothing. Note this compares the
      // assembled body (what the copy would hold) against the raw upstream:
      // the one case where they differ without a user customization is
      // assemble's whitespace normalization, and skillCustomized already
      // excluded that, so any remaining difference is a real customization.
      if (resolved.assembled === item.text) return []
      return [{ agent: agent.id, skill: parseId(item.id, "skill:"), text: resolved.assembled }]
    }),
  )
  if (denials.length === 0 && copies.length === 0) return { agentChanged: false, skillChanged: false }
  const added = copies.length === 0 ? undefined : await addSkillCopies(ctx, copies)
  if (added !== undefined) onInstall(added.registration)
  const addedIDs = added?.added ?? new Set<string>()
  const addedCopies = copies.filter((copy) => addedIDs.has(copyName(copy.agent, copy.skill)))
  const namespaceDenies =
    addedCopies.length === 0
      ? []
      : input.agents.map((agent) => ({ agent: agent.id, resource: copyPattern(), effect: "deny" as const }))
  const rules = [
    ...denials.map((denial) => ({ agent: denial.agent, resource: denial.skill, effect: "deny" as const })),
    ...namespaceDenies,
    ...addedCopies.flatMap((copy) => [
      { agent: copy.agent, resource: copy.skill, effect: "deny" as const },
      { agent: copy.agent, resource: copyName(copy.agent, copy.skill), effect: "allow" as const },
    ]),
  ]
  if (rules.length === 0) return { agentChanged: false, skillChanged: added !== undefined }
  const agentRegistration = await runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
    for (const rule of rules) pushSkillRule(editor, rule)
  })
  onInstall(agentRegistration)
  return { agentChanged: true, skillChanged: added !== undefined }
}

function pushSkillRule(editor: AgentEditor, rule: { agent: string; resource: string; effect: "deny" | "allow" }) {
  const current = editor.get(rule.agent)
  if (!current) return
  // Core evaluates permissions last-match-wins, so appending is always
  // sufficient and always correct, whereas deciding a rule is redundant
  // requires reimplementing core's wildcard semantics and still cannot
  // reason about concrete resources covered by a wildcard.
  editor.update(rule.agent, (agent) => {
    agent.permissions.push({ action: "skill", resource: rule.resource, effect: rule.effect })
  })
}

const copyPrefix = "plus/"

export function copyName(agent: string, skill: string): string {
  return `${copyPrefix}${agent}/${skill}`
}

export function copyPattern(): string {
  return `${copyPrefix}*`
}

export function isSkillCopy(id: string): boolean {
  return id.startsWith(copyPrefix)
}

interface SkillCopy {
  readonly agent: string
  readonly skill: string
  readonly text: string
}

async function addSkillCopies(
  ctx: Context,
  copies: SkillCopy[],
): Promise<{ registration: Registration; added: Set<string> } | undefined> {
  const added = new Set<string>()
  const registration = await runRegistration(ctx.skill.transform, (editor: SkillEditor) => {
    for (const copy of copies) {
      const original = editor.get(copy.skill)
      if (!original) continue
      const id = copyName(copy.agent, copy.skill)
      added.add(id)
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make(id),
          name: Skill.Name.make(original.name),
          ...(original.description === undefined ? {} : { description: original.description }),
          ...(original.slash === undefined ? {} : { slash: original.slash }),
          ...(original.autoinvoke === undefined ? {} : { autoinvoke: original.autoinvoke }),
          location: original.location,
          content: copy.text,
        }),
      )
    }
  })
  if (added.size === 0) {
    await Effect.runPromise(registration.dispose)
    return undefined
  }
  return { registration, added }
}

interface BasePlan {
  readonly agent: string
  readonly template: string
  readonly text: string
}

interface ToolPlan {
  readonly agent: string
  readonly tool: string
  readonly enabled: boolean
  readonly text: string
}

interface InstructionPlan {
  readonly agent: string
  readonly path: string
  readonly text: string
  readonly enabled: boolean
}

function basePlans(input: ApplyInput): BasePlan[] {
  return input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "base") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      if (isNoop(item, resolved)) return []
      if (!resolved.enabled) return []
      return [{ agent: agent.id, template: parseId(item.id, "base:"), text: resolved.assembled }]
    }),
  )
}

function toolCandidates(input: ApplyInput): ToolPlan[] {
  return input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "tool") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      if (isNoop(item, resolved)) return []
      return [{ agent: agent.id, tool: parseId(item.id, "tool:"), enabled: resolved.enabled, text: resolved.assembled }]
    }),
  )
}

function instructionPlans(input: ApplyInput): InstructionPlan[] {
  return input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "system") return []
      if (item.id === "system:role") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      if (isNoop(item, resolved)) return []
      return [{ agent: agent.id, path: parseId(item.id, "system:"), text: resolved.assembled, enabled: resolved.enabled }]
    }),
  )
}

async function applySession(ctx: Context, input: ApplyInput): Promise<Registration | undefined> {
  const base = basePlans(input)
  const candidates = toolCandidates(input)
  const instructions = instructionPlans(input)
  if (base.length === 0 && candidates.length === 0 && instructions.length === 0) return undefined
  let tools: ToolPlan[] = []
  if (candidates.length > 0) {
    const inventory = await readTools(ctx)
    tools = candidates.filter((plan) => !isCodeModeTool(inventory, plan.tool))
  }
  if (base.length === 0 && tools.length === 0 && instructions.length === 0) return undefined
  const activeByAgent = await readActiveBase(ctx, input.agents)
  const customByAgent = await readCustomSystem(ctx, input.agents)
  return runHook(ctx.session.hook, "context", (event) => {
    applyBasePlan(event, base, activeByAgent, customByAgent)
    applyToolPlan(event, tools.filter((plan) => plan.agent === String(event.agent)))
    applyInstructions(event.system, instructions.filter((plan) => plan.agent === String(event.agent)))
    return Effect.void
  })
}

// The one host-sourced classification: resolve each agent's model through the
// catalog exactly like the core optimize plugin, then ask `ctx.prompt.active`.
// An explicit per-agent base threaded from discover wins; otherwise the
// agent's configured model (or the catalog default) classifies it. Custom
// agents are classified too — the caller skips them — so the map stays total.
async function readActiveBase(
  ctx: Context,
  agents: readonly ApplyAgent[],
): Promise<ReadonlyMap<string, string | undefined>> {
  const catalog = await Effect.runPromise(
    ctx.catalog.model.list().pipe(Effect.catchCause(() => Effect.succeed({ data: [] as readonly Model.Info[] }))),
  )
  const fallback = await Effect.runPromise(
    ctx.catalog.model
      .default()
      .pipe(Effect.catchCause(() => Effect.succeed({ data: undefined as Model.Info | undefined }))),
  )
  const listed = await Effect.runPromise(
    ctx.agent.list().pipe(Effect.catchCause(() => Effect.succeed({ data: [] as readonly Agent.Info[] }))),
  )
  return new Map(
    agents.map((agent) => {
      if (agent.base !== undefined) return [agent.id, agent.base] as const
      const info = listed.data.find((entry) => String(entry.id) === agent.id)
      const ref = info?.model ?? fallback.data
      const model =
        ref === undefined
          ? { id: "", name: "" }
          : (catalog.data.find((entry) => entry.providerID === ref.providerID && entry.id === ref.id) ?? {
              id: ref.id,
              name: ref.id,
            })
      const active = Effect.runSync(
        ctx.prompt.active(model).pipe(Effect.catchCause(() => Effect.succeed(undefined as string | undefined))),
      )
      return [agent.id, active] as const
    }),
  )
}

// "Custom system" comes from real agent info in the context hook's host:
// `ctx.agent.list()` reports the live system prompt, and an agent with one
// defined owns its own base — Plus must not overwrite `system[0]` for it. An
// explicit per-agent flag threaded from the caller wins. Hosts without an
// agent list (older tests) report no custom systems.
async function readCustomSystem(
  ctx: Context,
  agents: readonly ApplyAgent[],
): Promise<ReadonlySet<string>> {
  const explicit = new Set(agents.filter((agent) => agent.customSystem === true).map((agent) => agent.id))
  const listed = await Effect.runPromise(
    ctx.agent.list().pipe(Effect.catchCause(() => Effect.succeed({ data: [] as readonly Agent.Info[] }))),
  )
  for (const entry of listed.data) {
    if ((entry.system ?? "") !== "") explicit.add(String(entry.id))
  }
  return explicit
}

function applyBasePlan(
  event: SessionContext,
  plans: readonly BasePlan[],
  activeByAgent: ReadonlyMap<string, string | undefined>,
  customByAgent: ReadonlySet<string>,
) {
  if (customByAgent.has(String(event.agent))) return
  const candidates = plans.filter((plan) => plan.agent === String(event.agent))
  if (candidates.length === 0) return
  // Only the template active for this request's model changes what the model
  // sees; stored edits for other templates wait until the agent switches model.
  const active = activeByAgent.get(String(event.agent))
  if (active === undefined) return
  const match = candidates.find((plan) => plan.template === active)
  if (match === undefined) return
  // Host templates already carry core's rendered tool guidance: the plugin
// host serves `PromptTemplate.templates` (raw bundled text), the core
// optimize plugins run first (`pre`) and overwrite `system[0]` with the
// rendered family template, and Plus runs last (`post`) after the rendered
// text is already in place. Stored custom text replaces it verbatim — there
// is no second render seam to call.
  const first = event.system[0]
  if (first === undefined) {
    event.system.push({ type: "text", text: match.text })
    return
  }
  event.system[0] = { ...first, text: match.text }
}

type ToolInventory = ReadonlyMap<string, boolean>

async function readTools(ctx: Context): Promise<ToolInventory> {
  return readTransform(ctx.tool.transform, (editor: ToolEditor) => {
    const inventory = new Map<string, boolean>()
    for (const tool of editor.list()) inventory.set(tool.id, tool.options?.codemode === false)
    return inventory
  })
}

function readTransform<Editor, Value>(transform: Transform<Editor>, read: (editor: Editor) => Value): Promise<Value> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<Value, never>()
        yield* transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed(read(editor)))
        })
        return yield* Deferred.await(deferred)
      }),
    ),
  )
}

function isCodeModeTool(inventory: ToolInventory, id: string): boolean {
  return inventory.get(id) !== true
}

function applyToolPlan(event: SessionContext, plans: readonly ToolPlan[]) {
  for (const plan of plans) {
    if (!plan.enabled) {
      delete event.tools[plan.tool]
      continue
    }
    const tool = event.tools[plan.tool]
    if (tool) tool.description = plan.text
  }
}

// Core per-file instruction seam: one baseline part per instruction source
// file, with the canonical absolute file path on `metadata.instruction.path`.
// Match parts to plans by comparing that canonical path; a relative plan path
// also matches the trailing segments of the absolute part path.
export function applyInstructions(
  system: SessionContext["system"],
  plans: readonly InstructionPlan[],
): void {
  for (const plan of plans) {
    const relative = plan.path.replace(/^\/+/, "")
    const index = system.findIndex((part) => matchesPart(partPath(part), plan.path, relative))
    if (!plan.enabled) {
      if (index !== -1) system.splice(index, 1)
      continue
    }
    if (index !== -1) {
      const current = system[index]
      if (current === undefined) continue
      if (current.text !== plan.text) system[index] = { ...current, text: plan.text }
      continue
    }
    system.push({ type: "text", text: plan.text, metadata: { instruction: { path: plan.path } } })
  }
}

function matchesPart(candidate: string | undefined, absolute: string, relative: string): boolean {
  if (candidate === undefined) return false
  if (candidate === absolute || candidate === relative) return true
  if (candidate.endsWith(`/${relative}`)) return true
  return false
}

function partPath(part: SessionContext["system"][number]): string | undefined {
  const metadata = part.metadata as Record<string, unknown> | undefined
  const fromMetadata = metadata?.["path"]
  if (typeof fromMetadata === "string") return fromMetadata
  const nested = (metadata?.["instruction"] as Record<string, unknown> | undefined)?.["path"]
  if (typeof nested === "string") return nested
  const direct = (part as { path?: unknown }).path
  if (typeof direct === "string") return direct
  return undefined
}

async function applyMcp(ctx: Context, input: ApplyInput): Promise<Registration | undefined> {
  const updates = input.items.flatMap((item) => {
    if (item.kind !== "mcp") return []
    const resolved = resolve({
      upstream: item,
      records: input.records,
      splits: input.splits,
      scopes: input.scopes,
      address: { level: "defaults", agent: null, item: item.id, section: null },
    })
    // Server configuration is file-owned: a stored text on an MCP row is never applied.
    if (resolved.enabled === item.enabled) return []
    return [{ name: parseId(item.id, "mcp:"), enabled: resolved.enabled }]
  })
  if (updates.length === 0) return undefined
  return runRegistration(ctx.mcp.transform, (editor: MCPEditor) => {
    for (const update of updates) {
      const current = editor.get(update.name)
      if (!current) continue
      if (update.enabled) {
        delete current.disabled
        continue
      }
      current.disabled = true
    }
  })
}
