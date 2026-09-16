import type { Context } from "@opencode/plugin/effect/plugin"
import type { Transform } from "@opencode/plugin/effect/registration"
import type { Agent } from "@opencode/schema/agent"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Deferred, Effect } from "effect"
import { copyName, isSkillCopy, type ToolPlan } from "./apply.js"
import { catalogPath, isCodeModeToolEntry, resolve, type CustomizationRecord, type Item, type Level, type Scopes, type SplitRecord } from "./model.js"
import { scrubLines } from "./tool-permissions.js"
import type { Plus } from "../rpc.js"

interface AssembledInput {
  readonly ctx: Context
  readonly agent: string
  readonly items: readonly Item[]
  readonly agents: readonly { readonly id: string; readonly level: Level }[]
  readonly records: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
  readonly installedTools?: readonly ToolPlan[] | undefined
}

// Assembled view for one agent: the agent's installed system text read back
// from the host (agent transforms are registry-level, so agent.list reflects
// application), plus the skill and tool domains filtered to what this agent
// can use. Tool descriptions are a registry-level read: per-agent native tool
// text installs through a session context hook, which is session-scoped for a
// specific agent, so assembled reports the registry (upstream) description
// even when the override applies correctly inside that agent's sessions.
// Code Mode tool text installs through the session catalog hook instead, and
// assembled reports the installed catalog plan's text and pin for that agent
// when one exists, falling back to the live registry defaults. Membership is host-effective wherever the host proves it; a stored
// `off` is desired state, never proof that anything was excluded. Code Mode
// denials (including the execute row) install as agent permission rules, so an
// installed deny decides — the same principle as the skill path below. Skill
// denials install as agent permission rules, so an installed deny decides —
// except a deny left behind without its private copy alongside an enabled
// desire is a torn install, and the missing copy means the customization is
// not live, so the registry original is reported (the same principle as the
// content readback below). Native tool denials install through the session
// context hook, which no registry seam can observe per agent; assembled
// consults the installed tool plan set published by apply/index.ts so a
// stored-but-unpublished off does not hide a tool the host still serves.
export async function assembled(input: AssembledInput): Promise<Plus.Assembled | { ok: false; agent: string }> {
  const owner = input.agents.find((entry) => entry.id === input.agent)
  if (owner === undefined) return { ok: false, agent: input.agent }
  const addressOf = (item: Item) => ({ level: owner.level, agent: owner.id, item: item.id, section: null })
  const resolved = new Map(input.items.map((item) => [item.id, resolve({
    upstream: item,
    records: input.records,
    splits: input.splits,
    scopes: input.scopes,
    address: addressOf(item),
  })]))
  const systemEntry = await readAgentEntry(input.ctx, input.agent)
  const scrubbed = scrubKeywords(input.items, resolved)
  const system = systemEntry?.system === undefined ? [] : [preserveScrub(systemEntry.system, scrubbed)]
  const tools = await listTools(input.ctx)
  const deniedTools = new Set(
    (input.installedTools ?? [])
      .filter((plan) => plan.agent === input.agent && !plan.enabled && plan.codemode !== true)
      .map((plan) => plan.tool),
  )
  const liveRules = systemEntry?.permissions
  const executeDenied = liveRules !== undefined && toolDenied("execute", "execute", liveRules)
  const visibleTools: Plus.AssembledTool[] = input.items
    .filter((item) => item.kind === "tool")
    .flatMap((item): Plus.AssembledTool[] => {
      if (item.execute === true) {
        if (executeDenied) return []
        return [{ id: "execute", description: item.text }]
      }
      const live = tools.get(item.id.slice("tool:".length))
      if (live === undefined) return []
      // Code Mode entries install denials as agent permission rules (host-
      // effective proof, like skills) and text/pin through the session catalog
      // hook. An installed deny excludes the tool, and denying `execute`
      // disables the Code Mode executor and catalog in core's `Tool.snapshot`,
      // so none of that agent's Code Mode tools are reachable. Otherwise
      // report the installed catalog plan's text and pin for this agent when
      // one exists, falling back to the live registry description and default
      // pin. A stored pin that was never published — or one left behind after
      // teardown cleared the installed set — is desired state, never proof, so
      // it never sets `pinned`.
      if (live.codemode) {
        if (executeDenied) return []
        if (liveRules !== undefined && toolDenied(live.id, live.group, liveRules)) return []
        const installed = (input.installedTools ?? []).find(
          (plan) => plan.agent === input.agent && plan.codemode === true && plan.catalogPath === catalogPath(item),
        )
        const description = preserveScrub(installed?.text ?? live.description, scrubbed)
        const pinned = installed?.pinned ?? live.pinned
        return [{ id: live.id, description, codemode: true as const, pinned }]
      }
      // Native tool denials install through the session context hook, which no
      // registry seam can observe per agent. The installed plan set published
      // by apply records what was actually installed for this agent: an
      // installed denial excludes the tool, while an unapplied or cleared
      // stored off leaves the tool present because the host still serves it.
      if (deniedTools.has(live.id)) return []
      return [{ id: live.id, description: preserveScrub(live.description, scrubbed) }]
    })
  const skills = await listSkills(input.ctx)
  const deniedSkills: ReadonlySet<string> | undefined =
    systemEntry === undefined ? undefined : new Set(
      input.items
        .filter((item) => item.kind === "skill")
        .map((item) => item.id.slice("skill:".length))
        .filter((id) => skillDenied(id, systemEntry.permissions)),
    )
  const installedCopies: ReadonlySet<string> = new Set(
    [...skills.keys()]
      .filter((id) => isSkillCopy(id) && id.startsWith(copyName(input.agent, "")))
      .map((id) => id.slice(copyName(input.agent, "").length)),
  )
  const visibleSkills = input.items
    .filter((item) => item.kind === "skill")
    .flatMap((item) => {
      const id = item.id.slice("skill:".length)
      // Host-effective membership: apply installs a whole-skill exclusion as
      // an agent deny rule for the original id, so an installed deny excludes
      // the skill. The deny rule alone cannot tell a whole-item off from the
      // deny half of an enabled customization (apply denies the original and
      // allows the private copy for those too), so consult the stored desire
      // to separate them: a denied id with an enabled desire reports the
      // installed copy's content. A deny with no installed copy alongside an
      // enabled desire is a torn install — the customization is not live —
      // so the registry original is reported. A stored off with no installed
      // deny (apply never ran, failed, or unwound it) stays present.
      if (deniedSkills !== undefined) {
        const state = resolved.get(item.id)
        const desired = state === undefined || state.enabled
        if (deniedSkills.has(id) && (!desired || !installedCopies.has(id))) {
          if (!desired) return []
        }
      } else {
        const state = resolved.get(item.id)
        if (state === undefined || !state.enabled) return []
      }
      // Prefer the agent's private copy: Plus never removes the original from
      // the registry, it only denies it for that agent and allows the
      // plus/<agent>/<skill> copy, so reading the original first would always
      // win and the copy would never be consulted.
      const current = skillContent(skills, input.agent, id)
      if (current === undefined) return []
      return [{ id, content: preserveScrub(current, scrubbed) }]
    })
  return { agent: input.agent, system, tools: visibleTools, skills: visibleSkills }
}

function scrubKeywords(items: readonly Item[], resolved: ReadonlyMap<string, { enabled: boolean }>): string[] {
  const keywords = items.flatMap((item) => {
    if (item.kind !== "perm" || item.keywords === undefined) return []
    const state = resolved.get(item.id)
    if (state === undefined || state.enabled) return []
    return [...item.keywords]
  })
  return [...new Set(keywords)]
}

// Live request scrub (apply.ts applyRuleScrub/applyCatalogScrub) never
// installs an emptied description: when every line matches, it keeps the
// original text. The assembled readback mirrors that preservation so the
// view agrees with what sessions actually receive.
function preserveScrub(text: string, keywords: readonly string[]): string {
  const scrubbed = scrubLines(text, keywords).text
  if (scrubbed.trim().length === 0) return text
  return scrubbed
}

async function readAgentEntry(ctx: Context, agent: string): Promise<Agent.Info | undefined> {
  const output = await Effect.runPromise(ctx.agent.list())
  return output.data.find((entry) => String(entry.id) === agent) as Agent.Info | undefined
}

async function listTools(ctx: Context): Promise<Map<string, { id: string; description: string; codemode: boolean; group: string; pinned: boolean }>> {
  return readTransform(ctx.tool.transform, (editor: ToolEditor) => {
    const live = new Map<string, { id: string; description: string; codemode: boolean; group: string; pinned: boolean }>()
    for (const tool of editor.list())
      live.set(tool.id, {
        id: tool.id,
        description: tool.description,
        codemode: isCodeModeToolEntry(tool),
        group: tool.options?.permission ?? tool.id,
        pinned: (tool.options as { pinned?: boolean } | undefined)?.pinned ?? false,
      })
    return live
  })
}

async function listSkills(ctx: Context): Promise<Map<string, string>> {
  const output = await Effect.runPromise(ctx.skill.list())
  return new Map(output.data.map((skill) => [String(skill.id), skill.content]))
}

// Tool denials install as agent permission rules (apply pushes
// `{ action: <tool id>, resource: "*", effect: "deny" }` onto the owning
// agent), mirroring core's `Tool.snapshot` (core/src/tool.ts): core evaluates
// two independent last-match checks and ORs them —
// `whollyDisabled(group) || whollyDisabled(id)` — where each check takes the
// last rule whose action pattern matches that target and denies only when it
// is `{ resource: "*", effect: "deny" }`. The host-effective tool set is the
// registry filtered by THIS agent's live rules.
function toolDenied(action: string, group: string, rules: readonly Agent.Info["permissions"][number][]): boolean {
  return isWhollyDenied(action, rules) || isWhollyDenied(group, rules)
}

function isWhollyDenied(target: string, rules: readonly Agent.Info["permissions"][number][]): boolean {
  const match = rules.findLast((rule) => wildcardMatch(target, rule.action))
  if (match === undefined) return false
  return match.resource === "*" && match.effect === "deny"
}

// Skill denials install as agent permission rules (applySkills pushes
// `{ action: "skill", resource, effect: "deny" }` onto the owning agent), and
// core filters by last-match-wins (core/src/permission.ts evaluate via
// findLast). The host-effective skill set is therefore the registry filtered
// by THIS agent's live rules: a stored off with no installed deny stays
// present, and an explicit allow later in the list resurrects the skill even
// with a stored off. Callers fall back to the locally resolved desire when the
// agent cannot be read.
function skillDenied(id: string, rules: readonly Agent.Info["permissions"][number][]): boolean {
  const match = rules.findLast((rule) => wildcardMatch("skill", rule.action) && wildcardMatch(id, rule.resource))
  if (match === undefined) return false
  return match.effect === "deny"
}

// Core's wildcard matcher (core/src/util/wildcard.ts): `*` spans any run,
// `?` matches one char. Local copy because assembled cannot depend on Core.
function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(normalized)
}

// Prefer the agent's private copy: Plus never removes the original from the
// registry, it only denies it for that agent and allows the
// plus/<agent>/<skill> copy, so reading the original first would always win
// and the copy would never be consulted. When no copy exists, report the
// registry original: that is what the host holds. A missing copy alongside a
// customization means the customization is not live (apply never ran, failed,
// or skipped it); returning the local projection here would conflate saved
// with loaded. Discovery excludes copies from inventory
// (packages/plus/src/instructions/discover.ts:285 backed by isSkillCopyId at
// :380-382), but that filter never touches this readback: ctx.skill.list()
// returns the full registry including installed copies (core/src/skill.ts
// :123-125), so a missing copy is genuinely absent, not a view limitation.
function skillContent(skills: ReadonlyMap<string, string>, agent: string, id: string): string | undefined {
  const copy = skills.get(copyName(agent, id))
  if (copy !== undefined) return copy
  return skills.get(id)
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
