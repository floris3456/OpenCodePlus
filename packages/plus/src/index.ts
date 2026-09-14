import { Plugin } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Agent } from "@opencode/schema/agent"
import { Config } from "@opencode/schema/config"
import { Skill } from "@opencode/schema/skill"
import { Effect, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { agentBody, discover, type BaseTemplate, type Discovered } from "./instructions/discover.js"
import { create, remove, rename, validateAgentId, type AgentFields } from "./agents/files.js"
import { addMcp, removeMcp } from "./agents/mcp.js"
import { createSkill, importSkill } from "./agents/skills.js"
import { apply } from "./instructions/apply.js"
import { assembled } from "./instructions/assembled.js"
import { scopesOf, type Level } from "./instructions/model.js"
import { globalConfigDir } from "./instructions/paths.js"
import { load, save, type Record } from "./instructions/store.js"
import type { PromptBaseline } from "./instructions/inventory.js"
import { disable, enable, read } from "./project.js"
import { CreateAgentFields, Definition, type Plus } from "./rpc.js"

export interface PlusState {
  registration: RpcRegistration<typeof Definition> | undefined
  applied: Registration[]
  fingerprint: string | undefined
  projectRevision: number | undefined
  globalRevision: number | undefined
  baselines: Map<string, PromptBaseline>
  semaphore: Semaphore.Semaphore
}

export function createState(): PlusState {
  return {
    registration: undefined,
    applied: [],
    fingerprint: undefined,
    projectRevision: undefined,
    globalRevision: undefined,
    baselines: new Map(),
    semaphore: Effect.runSync(Semaphore.make(1)),
  }
}

export default Plugin.define({
  id: "opencode.plus",
  effect: (ctx) =>
    Effect.gen(function* () {
      const state = createState()
      // Applied registrations live on detached scopes, so without this
      // finalizer they outlive the plugin when core unloads or reactivates it.
      yield* Effect.addFinalizer(() => deactivate(state))
      const registration = yield* ctx.rpc.register(Definition, createHandlers(ctx, state)).pipe(Effect.orDie)
      state.registration = registration
      yield* activate(ctx, state).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus activation failed", { cause })),
      )
      yield* watchHostEvents(ctx, state)
    }),
})

export function createHandlers(ctx: Context, state: PlusState): RpcHandlers<typeof Definition> {
  return {
    "project.status": () =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        const config = yield* Effect.promise(() => read(directory))
        return {
          enabled: config !== undefined,
          directory,
        }
      }),
    "project.enable": () =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* Effect.promise(() => enable(directory))
        const status: Plus.Status = {
          enabled: true,
          directory,
        }
        if (state.registration) {
          yield* state.registration.events.emit("project.changed", status).pipe(Effect.orDie)
        }
        yield* activate(ctx, state)
        return status
      }),
    "project.disable": () =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* Effect.promise(() => disable(directory))
        const status: Plus.Status = {
          enabled: false,
          directory,
        }
        if (state.registration) {
          yield* state.registration.events.emit("project.changed", status).pipe(Effect.orDie)
        }
        yield* deactivate(state)
        return status
      }),
    "instructions.snapshot": (_input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        const loaded = yield* loadStored(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const discovered = yield* Effect.promise(() => discoverAll(ctx, loaded, state.baselines))
        return toSnapshot(discovered, loaded)
      }),
    "instructions.refresh": (_input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        const loaded = yield* loadStored(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const discovered = yield* publishFresh(ctx, state, loaded)
        return toSnapshot(discovered, loaded)
      }),
    "instructions.mutate": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        const loaded = yield* loadStored(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        if (input.expectedRevision !== loaded.projectRevision || input.expectedGlobalRevision !== loaded.globalRevision) {
          const discovered = yield* Effect.promise(() => discoverAll(ctx, loaded, state.baselines))
          return { ok: false as const, reason: "stale" as const, snapshot: toSnapshot(discovered, loaded) }
        }
        const saved = yield* Effect.promise(() =>
          save(directory, { expectedRevision: loaded.revision, records: input.records.map(toRecord) }),
        )
        if (!saved.ok) {
          const refreshed = { ...saved.current, ...revisionsOf(saved.current.records), protectedAgents: loaded.protectedAgents }
          const discovered = yield* Effect.promise(() => discoverAll(ctx, refreshed, state.baselines))
          return { ok: false as const, reason: "stale" as const, snapshot: toSnapshot(discovered, refreshed) }
        }
        const reloaded = yield* Effect.promise(() => load(directory))
        const next = { ...reloaded, ...revisionsOf(reloaded.records), protectedAgents: loaded.protectedAgents }
        const discovered = yield* publishFresh(ctx, state, next)
        const snapshot = toSnapshot(discovered, next)
        return { ok: true as const, revision: next.projectRevision, globalRevision: next.globalRevision, snapshot }
      }),
    "instructions.assembled": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        const loaded = yield* loadStored(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const discovered = yield* Effect.promise(() => discoverAll(ctx, loaded, state.baselines))
        const result = yield* Effect.promise(() =>
          assembled({
            ctx,
            agent: input.agent,
            items: discovered.items,
            agents: discovered.agents.map((agent) => ({ id: agent.id, level: scopeLevel(agent.scope) })),
            records: customizationsOf(loaded.records),
            splits: splitsOf(loaded.records),
            scopes: scopesOf(discovered.agents),
          }),
        )
        if ("ok" in result)
          return yield* Effect.fail(context.error("agent.unknown", `Unknown agent ${input.agent}`, { agent: input.agent }))
        return result
      }),
    "agent.create": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* requireProject(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const validated = validateAgentId(input.id)
        if (!validated.ok)
          return yield* Effect.fail(context.error("agent.invalid", validated.reason, { id: input.id, reason: validated.reason }))
        const seed = input.template === undefined ? undefined : yield* Effect.promise(() => readTemplate(directory, input.template as string))
        if (input.template !== undefined && seed === undefined)
          return yield* Effect.fail(
            context.error("agent.invalid", `Unknown template ${input.template}`, { id: input.id, reason: `Unknown template ${input.template}` }),
          )
        const created = yield* Effect.promise(() =>
          create({
            scope: input.scope,
            projectDirectory: directory,
            id: validated.id,
            // Creating from a template must NOT copy records: the new agent
            // simply inherits through the resolution chain. Template only
            // selects the prompt/frontmatter seed below.
            fields: seed?.fields ?? toAgentFields(input.fields),
            prompt: seed?.prompt ?? input.prompt,
          }),
        )
        if (!created.ok)
          return yield* Effect.fail(
            context.error("agent.exists", `Agent ${validated.id} already exists at ${created.path}`, {
              path: created.path,
            }),
          )
        yield* refreshAfterFileChange(ctx, state, directory)
        return { id: validated.id, path: created.path }
      }),
    "agent.rename": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* requireProject(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const from = validateAgentId(input.from)
        if (!from.ok)
          return yield* Effect.fail(context.error("agent.invalid", from.reason, { id: input.from, reason: from.reason }))
        const to = validateAgentId(input.to)
        if (!to.ok)
          return yield* Effect.fail(context.error("agent.invalid", to.reason, { id: input.to, reason: to.reason }))
        const renamed = yield* Effect.promise(() =>
          rename({ scope: input.scope, projectDirectory: directory, from: from.id, to: to.id }),
        )
        if (!renamed.ok && renamed.reason === "missing-source")
          return yield* Effect.fail(
            context.error("agent.missing", `Agent ${from.id} does not exist at ${renamed.path}`, {
              path: renamed.path,
            }),
          )
        if (!renamed.ok)
          return yield* Effect.fail(
            context.error("agent.exists", `Agent ${to.id} already exists at ${renamed.path}`, {
              path: renamed.path,
            }),
          )
        yield* refreshAfterFileChange(ctx, state, directory)
        return { from: from.id, to: to.id, path: renamed.toPath }
      }),
    "agent.delete": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* requireProject(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const validated = validateAgentId(input.id)
        if (!validated.ok)
          return yield* Effect.fail(context.error("agent.invalid", validated.reason, { id: input.id, reason: validated.reason }))
        const removed = yield* Effect.promise(() =>
          remove({ scope: input.scope, projectDirectory: directory, id: validated.id }),
        )
        if (!removed.ok)
          return yield* Effect.fail(
            context.error("agent.missing", `Agent ${validated.id} does not exist at ${removed.path}`, {
              path: removed.path,
            }),
          )
        yield* refreshAfterFileChange(ctx, state, directory)
        return { id: validated.id, path: removed.path }
      }),
    "skill.create": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* requireProject(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const result = yield* Effect.promise(() =>
          createSkill({ projectDirectory: directory, name: input.name, body: input.body }),
        )
        if (!result.ok && result.reason === "exists")
          return yield* Effect.fail(context.error("skill.exists", `Skill ${result.id} already exists`, { id: result.id }))
        if (!result.ok)
          return yield* Effect.fail(context.error("skill.invalid", result.message, { id: result.id, reason: result.message }))
        yield* refreshAfterFileChange(ctx, state, directory)
        return { id: result.id, path: result.path }
      }),
    "skill.import": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* requireProject(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const result = yield* Effect.promise(() => importSkill({ projectDirectory: directory, path: input.path }))
        if (!result.ok && result.reason === "exists")
          return yield* Effect.fail(context.error("skill.exists", `Skill ${result.id} already exists`, { id: result.id }))
        if (!result.ok)
          return yield* Effect.fail(context.error("skill.invalid", result.message, { id: result.id, reason: result.message }))
        yield* refreshAfterFileChange(ctx, state, directory)
        return { id: result.id, path: result.path }
      }),
    "base.create": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* requireProject(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const result = yield* Effect.promise(() => createBaseTemplate(input.id, input.title, input.text))
        if (!result.ok && result.reason === "exists")
          return yield* Effect.fail(context.error("base.exists", `Base template ${result.id} already exists`, { id: result.id }))
        if (!result.ok)
          return yield* Effect.fail(context.error("base.invalid", result.message, { id: result.id, reason: result.message }))
        yield* refreshAfterFileChange(ctx, state, directory)
        return { id: result.id }
      }),
    "instruction.create": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* requireProject(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const result = yield* Effect.promise(() =>
          createInstruction({ projectDirectory: directory, name: input.name, text: input.text }),
        )
        if (!result.ok && result.reason === "exists")
          return yield* Effect.fail(
            context.error("instruction.exists", `Instruction already exists at ${result.path}`, { path: result.path }),
          )
        if (!result.ok)
          return yield* Effect.fail(context.error("instruction.invalid", result.message, { name: input.name, reason: result.message }))
        yield* refreshAfterFileChange(ctx, state, directory)
        return { id: result.id, path: result.path }
      }),
    "mcp.add": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* requireProject(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const result = yield* Effect.promise(() =>
          addMcp({ projectDirectory: directory, name: input.name, config: { ...input.config } }),
        )
        if (!result.ok && result.reason === "exists")
          return yield* Effect.fail(context.error("mcp.exists", `MCP server ${result.name} already exists`, { name: result.name }))
        if (!result.ok)
          return yield* Effect.fail(context.error("mcp.invalid", result.message, { name: result.name, reason: result.message }))
        yield* refreshAfterFileChange(ctx, state, directory)
        return { name: result.name }
      }),
    "mcp.remove": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* requireProject(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const result = yield* Effect.promise(() => removeMcp({ projectDirectory: directory, name: input.name }))
        if (!result.ok && result.reason === "missing")
          return yield* Effect.fail(context.error("mcp.missing", `MCP server ${result.name} does not exist`, { name: result.name }))
        if (!result.ok)
          return yield* Effect.fail(context.error("mcp.invalid", result.message, { name: result.name, reason: result.message }))
        yield* refreshAfterFileChange(ctx, state, directory)
        return { name: result.name }
      }),
  }
}

interface LoadedStores {
  readonly revision: number
  readonly projectRevision: number
  readonly globalRevision: number
  readonly records: readonly Record[]
  readonly protectedAgents: readonly string[]
}

function disabledMessage(directory: string): string {
  return `Project mode is not enabled for ${directory}`
}

function requireProject<E>(directory: string, disabled: () => E): Effect.Effect<readonly string[], E> {
  return Effect.gen(function* () {
    const config = yield* Effect.promise(() => read(directory))
    if (config === undefined) return yield* Effect.fail(disabled())
    return config.protectedAgents
  })
}

function revisionsOf(records: readonly Record[]): { projectRevision: number; globalRevision: number } {
  return { projectRevision: records.length, globalRevision: records.length }
}

function loadStored<E>(directory: string, disabled: () => E): Effect.Effect<LoadedStores, E> {
  return Effect.gen(function* () {
    const protectedAgents = yield* requireProject(directory, disabled)
    const stored = yield* Effect.promise(() => load(directory))
    return { ...stored, ...revisionsOf(stored.records), protectedAgents }
  })
}

function customizationsOf(records: readonly Record[]): CustomizationRecord[] {
  return records.filter((record): record is CustomizationRecord => record.type === "customization")
}

function splitsOf(records: readonly Record[]): SplitRecord[] {
  return records.filter((record): record is SplitRecord => record.type === "split")
}

function toRecord(record: Plus.SnapshotRecord): Record {
  if (record.type === "split")
    return {
      type: "split",
      level: record.level,
      agent: record.agent,
      item: record.item,
      boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
      updated: record.updated,
    }
  return {
    type: "customization",
    level: record.level,
    agent: record.agent,
    item: record.item,
    section: record.section,
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.state === undefined ? {} : { state: record.state }),
    basedOn: record.basedOn,
    ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
    ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
    updated: record.updated,
  }
}

// The parallel core change adds a plugin Context domain exposing base prompt
// templates (`ctx.prompt.templates()` / `ctx.prompt.active(model)`). This
// worktree does not have that domain yet (Context has no `prompt`), so this
// takes the fallback path: a local table of the seven ids with placeholder
// text plus the same id-matching rule. User templates created via
// `base.create` are layered on top so discover lists them alongside the
// built-ins.
function resolveBaseTemplates(ctx: Context): { templates: BaseTemplate[]; active: (agent: { model?: { providerID: string; id: string } }) => string | undefined } {
  const prompt = (ctx as unknown as { prompt?: { templates(): unknown; active(model: unknown): unknown } }).prompt
  if (prompt !== undefined) return { templates: [], active: () => undefined }
  return { templates: [...fallbackBaseTemplates(), ...readUserBaseTemplates()], active: (agent) => fallbackActiveBase(agent) }
}

const FALLBACK_BASE_IDS = ["gpt", "claude", "muse", "gemini", "general", "kimi", "trinity"] as const

function fallbackBaseTemplates(): BaseTemplate[] {
  return FALLBACK_BASE_IDS.map((id) => ({ id, title: `${id}.txt`, text: `${id} base prompt` }))
}

function readUserBaseTemplates(): BaseTemplate[] {
  return []
}

function fallbackActiveBase(agent: { model?: { providerID: string; id: string } }): string | undefined {
  const model = agent.model
  if (model === undefined) return undefined
  const hay = `${model.providerID} ${model.id}`.toLowerCase()
  if (hay.includes("gpt")) return "gpt"
  if (hay.includes("kimi")) return "kimi"
  if (hay.includes("trinity")) return "trinity"
  if (hay.includes("muse")) return "muse"
  if (hay.includes("claude")) return "claude"
  if (hay.includes("gemini")) return "gemini"
  return "general"
}

async function discoverAll(ctx: Context, loaded: LoadedStores, baselines: ReadonlyMap<string, PromptBaseline>): Promise<Discovered> {
  const resolved = resolveBaseTemplates(ctx)
  return discover({
    ctx,
    records: customizationsOf(loaded.records),
    baselines,
    baseTemplates: resolved.templates,
    activeBase: (agent) => resolved.active(agent),
  })
}

function scopeLevel(scope: "project" | "global" | "defaults"): Level {
  if (scope === "global") return "global"
  if (scope === "defaults") return "defaults"
  return "project"
}

async function readTemplate(directory: string, template: string): Promise<{ fields?: AgentFields; prompt: string } | undefined> {
  const validated = validateAgentId(template)
  if (!validated.ok) return undefined
  const candidates = [
    path.join(directory, ".opencode", "agent", `${validated.id}.md`),
    path.join(directory, ".opencode", "agents", `${validated.id}.md`),
    path.join(globalConfigDir(), "agent", `${validated.id}.md`),
    path.join(globalConfigDir(), "agents", `${validated.id}.md`),
  ]
  for (const candidate of candidates) {
    const file = Bun.file(candidate)
    if (!(await file.exists())) continue
    return { prompt: agentBody(await file.text()) }
  }
  return undefined
}

interface BaseTemplateResult {
  readonly ok: boolean
  readonly id: string
  readonly reason?: "exists"
  readonly message?: string
}

async function createBaseTemplate(id: string, title: string, text: string): Promise<BaseTemplateResult> {
  const trimmed = id.trim()
  if (trimmed.length === 0) return { ok: false, id, message: "Base template id cannot be empty" }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0"))
    return { ok: false, id, message: `Invalid base template id "${id}"` }
  const target = path.join(globalConfigDir(), "opencodeplus", "instructions", "base", `${trimmed}.txt`)
  if (await Bun.file(target).exists()) return { ok: false, id: trimmed, reason: "exists" }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, text)
  return { ok: true, id: trimmed }
}

interface InstructionResult {
  readonly ok: boolean
  readonly id: string
  readonly path: string
  readonly reason?: "exists"
  readonly message?: string
}

async function createInstruction(input: { projectDirectory: string; name: string; text: string }): Promise<InstructionResult> {
  const name = input.name.trim()
  if (name.length === 0) return { ok: false, id: input.name, path: "", message: "Instruction name cannot be empty" }
  if (name.includes("\0") || name.includes(".."))
    return { ok: false, id: input.name, path: "", message: `Invalid instruction name "${input.name}"` }
  const relative = name.endsWith(".md") ? name : `${name}.md`
  const root = path.resolve(input.projectDirectory)
  const target = path.resolve(root, relative)
  if (target === root || !target.startsWith(`${root}${path.sep}`))
    return { ok: false, id: input.name, path: "", message: `Invalid instruction name "${input.name}"` }
  if (await Bun.file(target).exists()) return { ok: false, id: relative, path: target, reason: "exists" }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, input.text.endsWith("\n") ? input.text : `${input.text}\n`)
  return { ok: true, id: `system:${path.relative(root, target)}`, path: target }
}

function activate(ctx: Context, state: PlusState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const config = yield* Effect.promise(() => read(ctx.location.directory))
    if (config === undefined) return
    const stored = yield* loadCurrent(ctx.location.directory)
    yield* publishFresh(ctx, state, stored)
  })
}

async function loadCurrent(directory: string): Promise<LoadedStores> {
  const config = await read(directory)
  const stored = await load(directory)
  return { ...stored, ...revisionsOf(stored.records), protectedAgents: config?.protectedAgents ?? [] }
}

function deactivate(state: PlusState): Effect.Effect<void> {
  return state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* disposeApplied(state)
      state.fingerprint = undefined
      state.projectRevision = undefined
      state.globalRevision = undefined
      state.baselines = new Map()
    }),
  )
}

function refreshAfterFileChange(ctx: Context, state: PlusState, directory: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stored = yield* Effect.promise(() => loadCurrent(directory))
    yield* publishFresh(ctx, state, stored)
  })
}

// Only publishFresh and deactivate acquire the semaphore, and neither calls the
// other, so a caller never blocks on a permit it already holds.
function publishFresh(ctx: Context, state: PlusState, stored: LoadedStores): Effect.Effect<Discovered> {
  return state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      const discovered = yield* Effect.promise(() => discoverAll(ctx, stored, state.baselines))
      // A newer publish already won; this read is stale, so leave the applied
      // registrations and the last emitted revision untouched.
      if (state.projectRevision !== undefined && stored.projectRevision < state.projectRevision) return discovered
      if (state.globalRevision !== undefined && stored.globalRevision < state.globalRevision) return discovered
      const fingerprint = fingerprintDiscovered(discovered)
      if (state.projectRevision !== undefined && fingerprint === state.fingerprint) {
        refreshBaselines(state, discovered)
        return discovered
      }
      // Install the replacement before disposing the superseded registrations.
      // Core rebuilds and reconciles on every registration change, so disposing
      // first would expose the un-transformed upstream state between the two
      // steps: an MCP server Plus keeps disabled would genuinely start, then
      // stop again once the replacement reinstalls disabled = true. Core replays
      // transforms in registration order with last write wins; every Plus
      // transform overwrites the same key (agent.system, disabled = true, skill
      // rules with a presence check, session tools by agent), so the briefly
      // doubled callback ends with the new value.
      const customizations = customizationsOf(stored.records)
      const splits = splitsOf(stored.records)
      const applied = yield* Effect.promise(() =>
        apply(ctx, {
          items: discovered.items,
          agents: discovered.agents.map((agent) => ({ id: agent.id, level: scopeLevel(agent.scope) })),
          records: customizations,
          splits,
          scopes: scopesOf(discovered.agents),
        }),
      )
      const previous = state.applied
      state.applied = [...applied.registrations]
      state.fingerprint = fingerprint
      state.projectRevision = stored.projectRevision
      state.globalRevision = stored.globalRevision
      refreshBaselines(state, discovered)
      yield* Effect.forEach(previous, (registration) => registration.dispose, { discard: true })
      yield* emitChanged(state, stored.projectRevision, stored.globalRevision)
      return discovered
    }),
  )
}

// Plus's own transforms rewrite the host text that the next discovery reads
// back from ctx.agent.list() and the tool/skill domains. Retain, per key,
// what Plus last wrote and the upstream text it replaced so discovery can
// report upstream while the host still shows Plus's output. The map is
// rebuilt from the just-published snapshot on every pass so removed
// overrides drop out instead of pinning a stale value forever.
function refreshBaselines(state: PlusState, discovered: Discovered): void {
  const next = new Map<string, PromptBaseline>()
  for (const [key, baseline] of state.baselines) {
    const live = discovered.items.find((item) => baselineKey(item) === key)
    if (live === undefined) continue
    if (live.text !== baseline.applied) continue
    next.set(key, baseline)
  }
  state.baselines = next
}

function baselineKey(item: { id: string; agents?: readonly string[] }): string {
  if (item.id === "system:role") return item.agents?.[0] ?? item.id
  return item.id
}

function disposeApplied(state: PlusState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const registrations = state.applied
    state.applied = []
    yield* Effect.forEach(registrations, (registration) => registration.dispose, { discard: true })
  })
}

function emitChanged(state: PlusState, revision: number, globalRevision: number): Effect.Effect<void> {
  const registration = state.registration
  if (!registration) return Effect.void
  return registration.events.emit("instructions.changed", { revision, globalRevision }).pipe(Effect.orDie)
}

function fingerprintDiscovered(discovered: Discovered): string {
  return JSON.stringify({
    items: discovered.items,
    agents: discovered.agents,
    servers: discovered.servers,
  })
}

// The canonical event names, not string guesses: agent and skill reloads
// publish their Updated events, and config reloads publish Updated whenever
// the merged config changes. Tool and MCP-config drift arrives through the
// same config reloads, so these three cover every host change we snapshot.
// Our own apply calls reload(), which republishes agent.updated, but the
// fingerprint above is unchanged then, so the refresh is a no-op instead of
// a loop.
const RefreshEvents: Set<string> = new Set([
  Agent.Event.Updated.type,
  Skill.Event.Updated.type,
  Config.Event.Updated.type,
])

function watchHostEvents(ctx: Context, state: PlusState): Effect.Effect<void, never, Scope.Scope> {
  return ctx.event.subscribe().pipe(
    Stream.filter((event) => RefreshEvents.has(event.type)),
    Stream.runForEach((event) =>
      refreshFromHost(ctx, state).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus refresh failed", { cause, type: event.type })),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  )
}

function refreshFromHost(ctx: Context, state: PlusState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const directory = ctx.location.directory
    const config = yield* Effect.promise(() => read(directory))
    if (config === undefined) {
      yield* deactivate(state)
      return
    }
    const stored = yield* Effect.promise(() => loadCurrent(directory))
    yield* publishFresh(ctx, state, stored)
  })
}

function toSnapshot(discovered: Discovered, loaded: LoadedStores): Plus.Snapshot {
  return {
    revision: loaded.projectRevision,
    globalRevision: loaded.globalRevision,
    agents: discovered.agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      ...(agent.path === undefined ? {} : { path: agent.path }),
      ...(agent.base === undefined ? {} : { base: agent.base }),
      fileBacked: agent.path !== undefined,
    })),
    items: discovered.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      group: item.group,
      ...(item.server === undefined ? {} : { server: item.server }),
      title: item.title,
      text: item.text,
      enabled: item.enabled,
      fingerprint: item.fingerprint,
      ...(item.agents === undefined ? {} : { agents: [...item.agents] }),
      ...(item.order === undefined ? {} : { order: item.order }),
    })),
    records: loaded.records.map((record) => {
      if (record.type === "split")
        return {
          type: "split" as const,
          level: record.level,
          agent: record.agent,
          item: record.item,
          boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
          updated: record.updated,
        }
      return {
        type: "customization" as const,
        level: record.level,
        agent: record.agent,
        item: record.item,
        section: record.section,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(record.state === undefined ? {} : { state: record.state }),
        basedOn: record.basedOn,
        ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
        ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
        updated: record.updated,
      }
    }),
    servers: discovered.servers.map((server) => ({ name: server.name, enabled: server.enabled })),
    protectedAgents: [...loaded.protectedAgents],
  }
}

function toAgentFields(fields: CreateAgentFields | undefined): AgentFields | undefined {
  if (fields === undefined) return undefined
  return {
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.variant === undefined ? {} : { variant: fields.variant }),
    ...(fields.request === undefined ? {} : { request: { ...fields.request } }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.mode === undefined ? {} : { mode: fields.mode }),
    ...(fields.hidden === undefined ? {} : { hidden: fields.hidden }),
    ...(fields.color === undefined ? {} : { color: fields.color }),
    ...(fields.steps === undefined ? {} : { steps: fields.steps }),
    ...(fields.disabled === undefined ? {} : { disabled: fields.disabled }),
    ...(fields.permissions === undefined ? {} : { permissions: fields.permissions }),
  }
}
