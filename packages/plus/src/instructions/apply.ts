import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration, Transform } from "@opencode/plugin/effect/registration"
import type { SessionContext, SessionHooks } from "@opencode/plugin/effect/session"
import type { SkillEditor } from "@opencode/plugin/effect/skill"
import { Skill } from "@opencode/schema/skill"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect, Exit, Scope } from "effect"
import path from "node:path"
import { applies, catalogPath, resolve, resolveActiveModel, type CustomizationRecord, type Item, type Level, type ModelRecord, type Scopes, type SplitRecord } from "./model.js"
import { actionForToolId, scrubLines } from "./tool-permissions.js"
import { teachingFilePath, teachingItemId } from "./paths.js"

export interface ApplyAgent {
  readonly id: string
  readonly level: Level
  /** Display/active-badge classification from discover; request fallback only, never the per-request answer. */
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
  readonly models?: readonly ModelRecord[]
}

export interface ToolPlan {
  readonly agent: string
  readonly tool: string
  readonly enabled: boolean
  readonly text: string
  readonly codemode?: boolean
  readonly catalogPath?: string
  readonly pinned?: boolean
}

export interface Applied {
  readonly registrations: Registration[]
  readonly tools: readonly ToolPlan[]
}

export async function apply(ctx: Context, input: ApplyInput): Promise<Applied> {
  const models = input.models ?? []
  if (input.records.length === 0 && models.length === 0) return { registrations: [], tools: [] }
  const installed: Registration[] = []
  // Registrations live on detached scopes so a partial failure must be unwound explicitly.
  try {
    const role = await applyRoles(ctx, input)
    if (role !== undefined) installed.push(role)
    const model = await applyModels(ctx, { agents: input.agents, models, scopes: input.scopes })
    if (model !== undefined) installed.push(model)
    const skills = await applySkills(ctx, input, (registration) => installed.push(registration))
    const session = await applySession(ctx, input)
    for (const registration of session.registrations) installed.push(registration)
    const mcp = await applyMcp(ctx, input)
    if (mcp !== undefined) installed.push(mcp)
    if (role !== undefined || model !== undefined || skills.agentChanged || session.agentChanged) await runVoid(ctx.agent.reload())
    if (skills.skillChanged) await runVoid(ctx.skill.reload())
    if (mcp !== undefined) await runVoid(ctx.mcp.reload())
    return { registrations: [...installed], tools: session.tools }
  } catch (error) {
    await disposeRegistrations(installed)
    throw error
  }
}

// Per-agent model selection: resolve each effective agent's active model down
// the existing chain and set the host agent's model in one transform. No
// active model means Plus installs nothing for that agent, so an unchanged
// save stays a no-op.
export async function applyModels(
  ctx: Context,
  input: { agents: readonly ApplyAgent[]; models: readonly ModelRecord[]; scopes: Scopes },
): Promise<Registration | undefined> {
  const updates = input.agents.flatMap((agent) => {
    const winner = resolveActiveModel({ models: input.models, scopes: input.scopes, level: agent.level, agent: agent.id })
    if (winner === undefined) return []
    if (winner.source === "upstream") return []
    return [{ agent: agent.id, providerID: winner.providerID, modelID: winner.modelID, ...(winner.variant === undefined ? {} : { variant: winner.variant }) }]
  })
  if (updates.length === 0) return undefined
  return runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
    for (const update of updates) {
      if (!editor.get(update.agent)) continue
      editor.update(update.agent, (agent) => {
        agent.model = Model.Ref.make({
          providerID: Provider.ID.make(update.providerID),
          id: Model.ID.make(update.modelID),
          ...(update.variant === undefined ? {} : { variant: Model.VariantID.make(update.variant) }),
        })
      })
    }
  })
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

export async function runRegistration<Editor>(
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

async function runHook<Name extends "context" | "catalog">(
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
  // assemble normalizes whitespace (collapses blank runs, trims), so an
  // unchanged resolution never round-trips byte-identically when the raw
  // upstream carries a trailing newline or extra blank lines. Compare through
  // the same normalization (like skillCustomized does) so an unrelated save
  // installs no plan for an untouched template.
  return normalizeLossless(resolved.assembled) === normalizeLossless(item.text) && resolved.enabled === item.enabled
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
      if (isNoop(item, resolved)) return []
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
      : input.agents.map((agent) => ({ agent: agent.id, action: "skill" as const, resource: copyPattern(), effect: "deny" as const }))
  const rules = [
    ...denials.map((denial) => ({ agent: denial.agent, action: "skill" as const, resource: denial.skill, effect: "deny" as const })),
    ...namespaceDenies,
    ...addedCopies.flatMap((copy) => [
      { agent: copy.agent, action: "skill" as const, resource: copy.skill, effect: "deny" as const },
      { agent: copy.agent, action: "skill" as const, resource: copyName(copy.agent, copy.skill), effect: "allow" as const },
    ]),
  ]
  if (rules.length === 0) return { agentChanged: false, skillChanged: added !== undefined }
  const agentRegistration = await runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
    for (const rule of rules) pushRule(editor, rule)
  })
  onInstall(agentRegistration)
  return { agentChanged: true, skillChanged: added !== undefined }
}

function pushRule(editor: AgentEditor, rule: { agent: string; action: string; resource: string; effect: "deny" | "allow" }) {
  const current = editor.get(rule.agent)
  if (!current) return
  // Core evaluates permissions last-match-wins, so appending is always
  // sufficient and always correct, whereas deciding a rule is redundant
  // requires reimplementing core's wildcard semantics and still cannot
  // reason about concrete resources covered by a wildcard.
  editor.update(rule.agent, (agent) => {
    agent.permissions.push({ action: rule.action, resource: rule.resource, effect: rule.effect })
  })
}

// Tool-specific permission rules: every perm item OFF for an agent installs
// one core deny per pattern through the existing agent registration. Because
// Permission.evaluate is last-match-wins, appending is always sufficient.
// The action prefers the per-rule `permAction` carried on the perm item by
// discovery (patch operation rules carry `patch.add`/`patch.update`/
// `patch.delete`; other tools carry their own `options.permission`),
// falling back to the tool id map (edit/write share core's `edit` action).
function permDenials(input: ApplyInput): { agent: string; action: string; resource: string; effect: "deny" }[] {
  return input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "perm") return []
      if (item.patterns === undefined || item.patterns.length === 0) return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      if (resolved.enabled) return []
      const tool = item.permTool ?? item.id.slice("perm:".length).split(":")[0] ?? ""
      if (tool.length === 0) return []
      const action = item.permAction ?? actionForToolId(tool)
      return item.patterns.map((pattern) => ({ agent: agent.id, action, resource: pattern, effect: "deny" as const }))
    }),
  )
}

// Disabled-rule scrub keywords per agent: the union of keywords from every
// OFF perm item for that agent. Empty means no scrub, so unrelated saves
// install no extra hooks and stay no-ops.
function scrubKeywordsByAgent(input: ApplyInput): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const agent of input.agents) {
    const keywords = input.items.flatMap((item) => {
      if (item.kind !== "perm") return []
      if (item.keywords === undefined || item.keywords.length === 0) return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      if (resolved.enabled) return []
      return [...item.keywords]
    })
    if (keywords.length > 0) out.set(agent.id, [...new Set(keywords)])
  }
  return out
}

// Scrub the session prompt: drop whole lines containing disabled keywords
// from every tool description and every system part (base plus instructions).
// Runs inside the existing session.context hook, after the text plans.
// Preservation discipline (mirroring spliceToolGuidance): if scrubbing would
// empty a description or system text entirely, leave the original text rather
// than installing nothing.
function applyRuleScrub(event: SessionContext, keywords: readonly string[]): void {
  if (keywords.length === 0) return
  for (const tool of Object.values(event.tools)) {
    const scrubbed = scrubLines(tool.description, keywords).text
    if (scrubbed.trim().length === 0) continue
    tool.description = scrubbed
  }
  for (let index = 0; index < event.system.length; index++) {
    const part = event.system[index]
    if (part === undefined || typeof part.text !== "string") continue
    const scrubbed = scrubLines(part.text, keywords).text
    if (scrubbed.trim().length === 0) continue
    if (scrubbed !== part.text) event.system[index] = { ...part, text: scrubbed }
  }
}

// Scrub Code Mode catalog descriptions inside the existing session.catalog
// hook, after the text/pin plans. Same preservation: never install an emptied
// description.
function applyCatalogScrub(event: { agent: unknown; tools: Record<string, { description?: string }> }, keywords: readonly string[]): void {
  if (keywords.length === 0) return
  for (const entry of Object.values(event.tools)) {
    if (typeof entry.description !== "string") continue
    const scrubbed = scrubLines(entry.description, keywords).text
    if (scrubbed.trim().length === 0) continue
    entry.description = scrubbed
  }
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
  /** Raw upstream host template; the alignment fallback when the host lacks the per-request raw seam. */
  readonly upstream: string
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
      return [{ agent: agent.id, template: parseId(item.id, "base:"), text: resolved.assembled, upstream: item.text }]
    }),
  )
}

interface ToolCandidate {
  readonly agent: string
  readonly item: Item
  readonly tool: string
  readonly enabled: boolean
  readonly text: string
  readonly pinned: boolean
}

function toolCandidates(input: ApplyInput): ToolCandidate[] {
  return input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "tool") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      // isNoop compares only text and enablement (it is shared with base and
      // instruction plans, which have no pin), so a pin-only change on a Code
      // Mode tool would be discarded here before catalogPlans ever sees it.
      // Let the candidate survive when the resolved pin differs from the
      // registry default.
      if (isNoop(item, resolved) && resolved.pinned === (item.pinned ?? false)) return []
      return [{
        agent: agent.id,
        item,
        tool: parseId(item.id, "tool:"),
        enabled: resolved.enabled,
        text: resolved.assembled,
        pinned: resolved.pinned,
      }]
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
      return [{ agent: agent.id, path: instructionPlanPath(item.id), text: resolved.assembled, enabled: resolved.enabled }]
    }),
  )
}

// The teaching row carries a stable id instead of a location-relative path,
// so it cannot resolve against the location directory like other instruction
// rows. Core keys that part by the seeded absolute path, so plan it
// absolutely; resolveInstructionId leaves the seeded path untouched.
function instructionPlanPath(id: string): string {
  if (id === teachingItemId) return teachingFilePath()
  return parseId(id, "system:")
}

async function applySession(
  ctx: Context,
  input: ApplyInput,
): Promise<{ registrations: Registration[]; tools: readonly ToolPlan[]; agentChanged: boolean }> {
  const base = basePlans(input)
  const candidates = toolCandidates(input)
  const instructions = instructionPlans(input)
  const native: ToolPlan[] = candidates
    .filter((candidate) => candidate.item.codemode !== true && candidate.item.execute !== true)
    .map((candidate) => ({ agent: candidate.agent, tool: candidate.tool, enabled: candidate.enabled, text: candidate.text }))
  const denials = candidates.filter(
    (candidate) => (candidate.item.codemode === true || candidate.item.execute === true) && !candidate.enabled,
  )
  const catalogPlans: ToolPlan[] = candidates
    .filter((candidate) => {
      if (candidate.item.codemode !== true) return false
      if (candidate.item.execute === true) return false
      if (normalizeLossless(candidate.text) !== normalizeLossless(candidate.item.text)) return true
      return candidate.pinned !== (candidate.item.pinned ?? false)
    })
    .map((candidate) => ({
      agent: candidate.agent,
      tool: candidate.tool,
      enabled: candidate.enabled,
      text: candidate.text,
      codemode: true as const,
      catalogPath: catalogPath(candidate.item),
      pinned: candidate.pinned,
    }))
  const permDenies = permDenials(input)
  const scrubByAgent = scrubKeywordsByAgent(input)
  const needsScrub = [...scrubByAgent.values()].some((keywords) => keywords.length > 0)
  if (base.length === 0 && native.length === 0 && instructions.length === 0 && denials.length === 0 && catalogPlans.length === 0 && permDenies.length === 0 && !needsScrub)
    return { registrations: [], tools: [], agentChanged: false }
  const installed: Registration[] = []
  try {
    if (denials.length > 0) {
      const agentRegistration = await runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
        for (const denial of denials) pushRule(editor, { agent: denial.agent, action: denial.tool, resource: "*", effect: "deny" })
      })
      installed.push(agentRegistration)
    }
    if (permDenies.length > 0) {
      const permRegistration = await runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
        for (const rule of permDenies) pushRule(editor, rule)
      })
      installed.push(permRegistration)
    }
    if (base.length > 0 || native.length > 0 || instructions.length > 0 || needsScrub) {
      const pins = new Map<string, string>()
      for (const agent of input.agents) {
        if (agent.base !== undefined) pins.set(agent.id, agent.base)
      }
      const catalog = await Effect.runPromise(
        ctx.catalog.model.list().pipe(Effect.catchCause(() => Effect.succeed({ data: [] as readonly Model.Info[] }))),
      )
      const classifier: RequestClassifier = { pinned: pins, catalog: catalog.data, prompt: ctx.prompt }
      const customByAgent = await readCustomSystem(ctx, input.agents)
      const registration = await runHook(ctx.session.hook, "context", (event) => {
        applyBasePlan(event, base, classifier, customByAgent)
        applyToolPlan(event, native.filter((plan) => plan.agent === String(event.agent)))
        applyInstructionPlans(ctx, event, instructions.filter((plan) => plan.agent === String(event.agent)))
        applyRuleScrub(event, scrubByAgent.get(String(event.agent)) ?? [])
        return Effect.void
      })
      installed.push(registration)
    }
    if (catalogPlans.length > 0 || needsScrub) {
      const catalogRegistration = await runHook(ctx.session.hook, "catalog", (event) => {
        for (const plan of catalogPlans) {
          if (plan.agent !== String(event.agent)) continue
          const path = plan.catalogPath
          if (path === undefined) continue
          const entry = event.tools[path]
          if (entry === undefined) continue
          entry.description = plan.text
          if (plan.pinned !== undefined) entry.pinned = plan.pinned
        }
        applyCatalogScrub(event, scrubByAgent.get(String(event.agent)) ?? [])
        return Effect.void
      })
      installed.push(catalogRegistration)
    }
    return { registrations: installed, tools: [...native, ...catalogPlans], agentChanged: denials.length > 0 || permDenies.length > 0 }
  } catch (error) {
    await disposeRegistrations(installed)
    throw error
  }
}

// The one host-sourced classification: mirror the core optimize plugin
// (core/src/plugin/optimize.ts lines 59-62) — look the REQUEST model ref up
// in the catalog list, defaulting to a bare ref (name = id, like
// `Model.Info.default`) when the catalog has no entry, then ask
// `ctx.prompt.active`. Classification happens per request from `event.model`
// because a session can select or switch to a model family that differs from
// the agent's configured model; classifying once at install time would serve
// the configured family's customization to the wrong model. The per-agent
// base threaded from discover (index.ts derives it from the agent's
// configured model) is display/active-badge state and only a fallback when
// the request model yields no classification.
interface RequestClassifier {
  readonly pinned: ReadonlyMap<string, string>
  readonly catalog: readonly Model.Info[]
  readonly prompt: Context["prompt"]
}

function classifyRequest(
  classifier: RequestClassifier,
  agent: string,
  ref: { providerID: unknown; id: unknown },
): string | undefined {
  const model = requestModel(classifier, ref)
  const request = Effect.runSync(
    classifier.prompt.active(model).pipe(Effect.catchCause(() => Effect.succeed(undefined as string | undefined))),
  )
  if (request !== undefined) return request
  return classifier.pinned.get(agent)
}

// The request model resolved the way the core optimize plugin resolves it:
// look the event's model ref up in the catalog list, defaulting to a bare
// ref (name = id) when the catalog has no entry. Shared by classification
// and raw-template lookup so the two answer for the same model.
function requestModel(
  classifier: RequestClassifier,
  ref: { providerID: unknown; id: unknown },
): { id: string; name: string } {
  const providerID = String(ref.providerID)
  const id = String(ref.id)
  const found = classifier.catalog.find((entry) => String(entry.providerID) === providerID && String(entry.id) === id)
  if (found !== undefined) return { id: found.id, name: found.name }
  return { id, name: id }
}

// The RAW template core actually rendered for this request. Classification
// alone cannot key the guidance splice: gpt-6 classifies as gpt but
// renders the astra text, so aligning discovery's gpt upstream against
// astra live finds no suffix and would wipe the guidance. Hosts without
// the seam (older hosts, and tests that predate it) leave `raw`
// undefined; fall back to upstream, which matches whenever classification
// and rendering agree — every family except gpt-6.
function rawForRequest(classifier: RequestClassifier, event: SessionContext): string | undefined {
  const raw = classifier.prompt.raw
  if (typeof raw !== "function") return undefined
  return Effect.runSync(
    raw(requestModel(classifier, event.model)).pipe(Effect.catchCause(() => Effect.succeed(undefined as string | undefined))),
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
  classifier: RequestClassifier,
  customByAgent: ReadonlySet<string>,
) {
  if (customByAgent.has(String(event.agent))) return
  const candidates = plans.filter((plan) => plan.agent === String(event.agent))
  if (candidates.length === 0) return
  // Only the template active for this request's model changes what the model
  // sees; stored edits for other templates wait until the agent switches model.
  const active = classifyRequest(classifier, String(event.agent), event.model)
  if (active === undefined) return
  const match = candidates.find((plan) => plan.template === active)
  if (match === undefined) return
  // System[0] already carries core's rendered family template: core's
  // optimize plugins run first (`pre`) and overwrite `system[0]` with the
  // rendered text, and Plus runs last (`post`). Stored custom text is raw
  // host template text, so render it through the host-owned seam before
  // writing: splice the rendered guidance out of the live system[0] in place
  // of the raw placeholder, and substitute the request model name for the
  // model placeholder.
  const first = event.system[0]
  const text = renderBaseText(match.text, match.upstream, event, classifier)
  // An unresolvable alignment leaves the live text exactly as core
  // rendered it: the customization is lost for this request, but the
  // model's tool guidance is never stripped (see spliceToolGuidance).
  if (text === undefined) return
  if (first === undefined) {
    event.system.push({ type: "text", text })
    return
  }
  event.system[0] = { ...first, text }
}

// Render one stored base customization the way core's optimize plugin renders
// the family template it replaces (core/src/plugin/optimize.ts + system
// prompt seam): the raw `${OPENCODE_TOOL_GUIDANCE}` marker becomes the live
// tool guidance visible in system[0], and `{{MODEL_NAME}}` becomes the
// request model name. The live text — not a regenerated guidance string —
// is the source of truth for what core rendered for this request, so Plus
// never invents guidance for tools the request does not have.
function renderBaseText(
  text: string,
  upstream: string,
  event: SessionContext,
  classifier: RequestClassifier,
): string | undefined {
  const rendered = spliceToolGuidance(text, rawForRequest(classifier, event) ?? upstream, event.system[0]?.text)
  if (rendered === undefined) return undefined
  return rendered.replaceAll("{{MODEL_NAME}}", requestModelName(classifier, event))
}

function requestModelName(classifier: RequestClassifier, event: SessionContext): string {
  const providerID = String(event.model.providerID)
  const id = String(event.model.id)
  const found = classifier.catalog.find((entry) => String(entry.providerID) === providerID && String(entry.id) === id)
  return found === undefined ? id : found.name
}

// The stored customization only knows the RAW placeholder; the live system[0]
// already carries core's rendered guidance for this request's tool set. Take
// the guidance span out of the live text by aligning the RAW template core
// actually rendered (the per-request `ctx.prompt.raw` text, or the discovery
// upstream on hosts without the seam) around its placeholder: the raw text
// before the marker locates the guidance start in the live text, and the raw
// text after the marker locates its end. Customized surroundings cannot align
// because editing them is the point of the feature. No marker in the stored
// text means nothing to render; no live text, or a raw template that itself
// carries no marker, means core rendered no guidance, so the marker resolves
// to empty rather than inventing any.
const toolGuidanceMarker = "${OPENCODE_TOOL_GUIDANCE}"

function spliceToolGuidance(stored: string, upstream: string, live: string | undefined): string | undefined {
  const at = stored.indexOf(toolGuidanceMarker)
  if (at === -1) return stored
  if (live === undefined) return stored.replaceAll(toolGuidanceMarker, "")
  const upstreamAt = upstream.indexOf(toolGuidanceMarker)
  if (upstreamAt === -1) return stored.replaceAll(toolGuidanceMarker, "")
  const before = upstream.slice(0, upstreamAt)
  const after = upstream.slice(upstreamAt + toolGuidanceMarker.length)
  const start = before === "" ? 0 : live.indexOf(before)
  // The live text genuinely lacks the raw surroundings, so something besides
  // core's renderer owns system[0]. Return undefined and let the caller keep
  // the live text unmodified: dropping one request's customization loses an
  // edit, but overwriting with guidance-stripped text would silently delete
  // every tool instruction the model sees. Guidance is only ever sliced out
  // of live text, never synthesized.
  if (start === -1) return undefined
  const guidanceStart = start + before.length
  const guidanceEnd = after === "" ? live.length : live.indexOf(after, guidanceStart)
  if (guidanceEnd === -1) return undefined
  return stored.replaceAll(toolGuidanceMarker, live.slice(guidanceStart, guidanceEnd))
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
// file, with the canonical absolute file path on `metadata.instruction.path`
// (core/src/session/model-request.ts `instructionPart`). A plan path is the
// location-relative discovery id (`AGENTS.md`, `../AGENTS.md`, or a longer
// climb for the global file — discover.ts `instructionFileItems`, never
// edited here), so resolve it against the owning location before comparing:
// the plan applies to the event's session directory exactly the way
// discovery resolved it, and the comparison is against the absolute part
// path. Without the session directory the id is ambiguous — `AGENTS.md`
// alone cannot tell the global file from the project file, and `..`
// segments never match a canonical path — so the context-hook caller passes
// the full event and apply reads `event.sessionID`'s location from the host.
export function applyInstructions(
  event: Pick<SessionContext, "system">,
  plans: readonly InstructionPlan[],
): void {
  applyInstructionsToSystem(event.system, plans)
}

// The context-hook path: resolve each plan id against the owning session
// directory to a canonical absolute path, then match parts by canonical
// identity. `ctx.location.directory` is that directory: the plugin host is
// location-scoped (core PluginHost binds one Location.Service per location),
// the context event fires for sessions of that location, and discovery
// resolved these same ids against `ctx.location.directory`. `..` segments
// resolve here instead of silently matching nothing, and a bare `AGENTS.md`
// resolves to the session file rather than the first same-named part.
function applyInstructionPlans(ctx: Context, event: SessionContext, plans: readonly InstructionPlan[]): void {
  const resolved = plans.map((plan) => ({ ...plan, path: resolveInstructionId(ctx.location.directory, plan.path) }))
  applyInstructionsToSystem(event.system, resolved)
}

function resolveInstructionId(directory: string, id: string): string {
  if (id === teachingFilePath()) return id
  const relative = id.replace(/^\/+/, "")
  if (relative === "") return directory
  return path.resolve(directory, relative)
}

// Direct system-array form for unit callers that already hold the real event
// system (the exported shape keeps the event wrapper so the location-aware
// resolution has a home once discover.ts carries the owning directory).
function applyInstructionsToSystem(
  system: SessionContext["system"],
  plans: readonly InstructionPlan[],
): void {
  for (const plan of plans) {
    const index = system.findIndex((part) => matchesPart(partPath(part), plan.path))
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

// Canonical-path identity: a part matches only when its absolute path equals
// the plan's absolute path. Suffix matching is gone — `AGENTS.md` used to
// match the FIRST part ending in that name (normally the global file, not
// the project one), and ids containing `..` never matched at all, so
// disabling an ancestor or global instruction silently did nothing while
// editing it appended a duplicate.
function matchesPart(candidate: string | undefined, absolute: string): boolean {
  if (candidate === undefined) return false
  return candidate === absolute
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
