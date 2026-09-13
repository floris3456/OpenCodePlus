import { Plugin } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Agent } from "@opencode/schema/agent"
import { Config } from "@opencode/schema/config"
import { Skill } from "@opencode/schema/skill"
import { Effect, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import { create, remove, rename, validateAgentId, type AgentFields } from "./agents/files.js"
import { apply } from "./instructions/apply.js"
import { discover, type Discovered, type PromptBaseline } from "./instructions/discover.js"
import { effective, mergeCustomization, type Customization, type Item } from "./instructions/model.js"
import { load, save, type Stored } from "./instructions/store.js"
import { disable, enable, read } from "./project.js"
import {
  CreateAgentFields,
  Definition,
  MutateResult,
  Snapshot,
  SnapshotCustomization,
  Status,
} from "./rpc.js"

export interface PlusState {
  registration: RpcRegistration<typeof Definition> | undefined
  applied: Registration[]
  fingerprint: string | undefined
  revision: number | undefined
  baselines: Map<string, PromptBaseline>
  semaphore: Semaphore.Semaphore
}

export function createState(): PlusState {
  return {
    registration: undefined,
    applied: [],
    fingerprint: undefined,
    revision: undefined,
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
        const status: Status = {
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
        const status: Status = {
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
        const discovered = yield* Effect.promise(() => discover(ctx, loaded.stored, state.baselines))
        return toSnapshot(discovered, loaded.protectedAgents)
      }),
    "instructions.mutate": (input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        const loaded = yield* loadStored(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const current = yield* Effect.promise(() => discover(ctx, loaded.stored, state.baselines))
        const customizations = normalizeCustomizations(
          input.customizations.map(toCustomization),
          current.snapshot.items,
        )
        const saved = yield* Effect.promise(() =>
          save(directory, { expectedRevision: input.expectedRevision, customizations }),
        )
        if (!saved.ok) {
          const conflict = yield* Effect.promise(() => discover(ctx, saved.current, state.baselines))
          return conflictResult(conflict, loaded.protectedAgents)
        }
        const discovered = yield* publishFresh(ctx, state, { revision: saved.revision, customizations })
        return successResult(saved.revision, discovered, loaded.protectedAgents)
      }),
    "instructions.refresh": (_input, context) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        const loaded = yield* loadStored(directory, () =>
          context.error("project.disabled", disabledMessage(directory), { directory }),
        )
        const discovered = yield* publishFresh(ctx, state, loaded.stored)
        return toSnapshot(discovered, loaded.protectedAgents)
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
        const created = yield* Effect.promise(() =>
          create({
            scope: input.scope,
            projectDirectory: directory,
            id: validated.id,
            fields: toAgentFields(input.fields),
            prompt: input.prompt,
          }),
        )
        if (!created.ok)
          return yield* Effect.fail(
            context.error("agent.exists", `Agent ${validated.id} already exists at ${created.path}`, {
              path: created.path,
            }),
          )
        const stored = yield* Effect.promise(() => load(directory))
        yield* publishFresh(ctx, state, stored)
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
        const stored = yield* Effect.promise(() => load(directory))
        yield* publishFresh(ctx, state, stored)
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
        const stored = yield* Effect.promise(() => load(directory))
        yield* publishFresh(ctx, state, stored)
        return { id: validated.id, path: removed.path }
      }),
  }
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

function loadStored<E>(directory: string, disabled: () => E): Effect.Effect<{ stored: Stored; protectedAgents: readonly string[] }, E> {
  return Effect.gen(function* () {
    const protectedAgents = yield* requireProject(directory, disabled)
    const stored = yield* Effect.promise(() => load(directory))
    return { stored, protectedAgents }
  })
}

function activate(ctx: Context, state: PlusState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const config = yield* Effect.promise(() => read(ctx.location.directory))
    if (config === undefined) return
    const stored = yield* Effect.promise(() => load(ctx.location.directory))
    yield* publishFresh(ctx, state, stored)
  })
}

function deactivate(state: PlusState): Effect.Effect<void> {
  return state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* disposeApplied(state)
      state.fingerprint = undefined
      state.revision = undefined
      state.baselines = new Map()
    }),
  )
}

// Only publishFresh and deactivate acquire the semaphore, and neither calls the
// other, so a caller never blocks on a permit it already holds.
function publishFresh(ctx: Context, state: PlusState, stored: Stored): Effect.Effect<Discovered> {
  return state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      const discovered = yield* Effect.promise(() => discover(ctx, stored, state.baselines))
      // A newer publish already won; this read is stale, so leave the applied
      // registrations and the last emitted revision untouched.
      if (state.revision !== undefined && stored.revision < state.revision) return discovered
      const fingerprint = fingerprintDiscovered(discovered)
      if (state.revision !== undefined && fingerprint === state.fingerprint) {
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
      const applied = yield* Effect.promise(() => apply(ctx, discovered.snapshot, stored.customizations))
      const previous = state.applied
      state.applied = [...applied.registrations]
      state.fingerprint = fingerprint
      state.revision = stored.revision
      refreshBaselines(state, discovered)
      yield* Effect.forEach(previous, (registration) => registration.dispose, { discard: true })
      yield* emitChanged(state, stored.revision)
      return discovered
    }),
  )
}

// Plus's own agent transform rewrites the system text that the next discovery
// reads back from ctx.agent.list(). Retain, per agent, what Plus last wrote
// and the upstream text it replaced so discovery can report upstream while the
// host still shows Plus's output. The map is rebuilt from the just-published
// snapshot on every pass, mirroring apply.ts promptUpdates exactly, so removed
// overrides drop out instead of pinning a stale value forever. The retained
// file body is only a fallback for builtin agents: file-backed agents reread
// their markdown on every discovery, so genuine upstream edits surface while
// the override stays installed.
function refreshBaselines(state: PlusState, discovered: Discovered): void {
  const next = new Map<string, PromptBaseline>()
  const prompts = discovered.snapshot.items.filter((item) => item.kind === "prompt")
  for (const item of prompts) {
    const resolved = effective(discovered.snapshot, item, item.owner)
    if (!resolved.customized || resolved.text === item.text) continue
    const file = discovered.files.get(item.owner)
    next.set(item.owner, {
      applied: resolved.text,
      upstream: item.text,
      fileBacked: file !== undefined,
      ...(file === undefined ? {} : { file }),
    })
  }
  state.baselines = next
}

function disposeApplied(state: PlusState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const registrations = state.applied
    state.applied = []
    yield* Effect.forEach(registrations, (registration) => registration.dispose, { discard: true })
  })
}

function emitChanged(state: PlusState, revision: number): Effect.Effect<void> {
  const registration = state.registration
  if (!registration) return Effect.void
  return registration.events.emit("instructions.changed", { revision }).pipe(Effect.orDie)
}

function fingerprintDiscovered(discovered: Discovered): string {
  return JSON.stringify({
    revision: discovered.snapshot.revision,
    items: discovered.snapshot.items,
    agents: discovered.agents,
    tools: discovered.tools,
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
    const stored = yield* Effect.promise(() => load(directory))
    yield* publishFresh(ctx, state, stored)
  })
}

function toSnapshot(discovered: Discovered, protectedAgents: readonly string[]): Snapshot {
  return {
    revision: discovered.snapshot.revision,
    agents: discovered.agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      ...(agent.path === undefined ? {} : { path: agent.path }),
      fileBacked: agent.path !== undefined,
    })),
    tools: discovered.tools.map((tool) => ({ id: tool.id, native: tool.native })),
    items: discovered.snapshot.items,
    customizations: discovered.snapshot.customizations.map((record) => ({
      item: record.item,
      agent: record.agent,
      ...(record.text === undefined ? {} : { text: record.text }),
      state: record.state,
      basedOn: record.basedOn,
      ...(record.reviewed === undefined ? {} : { reviewed: record.reviewed }),
      updated: record.updated,
    })),
    protectedAgents: [...protectedAgents],
  }
}

function successResult(revision: number, discovered: Discovered, protectedAgents: readonly string[]): MutateResult {
  return { ok: true, revision, snapshot: toSnapshot(discovered, protectedAgents) }
}

function conflictResult(discovered: Discovered, protectedAgents: readonly string[]): MutateResult {
  return { ok: false, reason: "stale", snapshot: toSnapshot(discovered, protectedAgents) }
}

function normalizeCustomizations(
  customizations: readonly Customization[],
  items: readonly Item[],
): Customization[] {
  const itemMap = new Map(items.map((item) => [item.id, item]))
  const sharedNormalized = new Map(
    customizations
      .filter((record) => record.agent === "*")
      .map((record) => {
        const item = itemMap.get(record.item)
        if (!item) return [record.item, record]
        return [record.item, normalizeRecord(record, item, [])]
      }),
  )
  return customizations.map((record) => {
    const item = itemMap.get(record.item)
    if (!item) return record
    if (record.agent === "*") return sharedNormalized.get(record.item) ?? record
    const shared = sharedNormalized.get(record.item)
    return normalizeRecord(record, item, shared ? [shared] : [])
  })
}

function normalizeRecord(
  record: Customization,
  item: Item,
  context: readonly Customization[],
): Customization {
  const merged = mergeCustomization(context, item, record.agent, {
    text: record.text ?? "",
    state: record.state,
    reviewed: record.reviewed,
  })
  const candidate = merged.find((entry) => entry.item === item.id && entry.agent === record.agent)
  return {
    item: record.item,
    agent: record.agent,
    ...(record.text === undefined ? {} : { text: record.text }),
    state: candidate?.state ?? record.state,
    basedOn: record.basedOn,
    ...(record.reviewed === undefined ? {} : { reviewed: record.reviewed }),
    updated: record.updated,
  }
}

function toCustomization(record: SnapshotCustomization): Customization {
  return {
    item: record.item,
    agent: record.agent,
    ...(record.text === undefined ? {} : { text: record.text }),
    state: record.state,
    basedOn: record.basedOn,
    ...(record.reviewed === undefined ? {} : { reviewed: record.reviewed }),
    updated: record.updated,
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
