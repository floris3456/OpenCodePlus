// I2c: the host catalogue expires after five minutes and drops on a model
// update (the event Plus refreshes from, not only the deferred refresh).
import { afterEach, expect, test } from "bun:test"
import type { ModelDomain } from "@opencode/plugin/effect/model"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Effect, Exit, PubSub, Scope, Stream } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { activate, createHandlers, createPlusApi, createState, deactivate, watchHostEvents } from "../src/index.js"
import { agentInfo, fullContext, modelInfo, modelRef } from "./harness.js"
import { onSharedStoreChanged } from "../src/shared-store-bus.js"

const MINUTE = 60_000
const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-host-catalogue-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "share")
  return path.join(root, "project")
}

function countingModel(domain: ModelDomain, counts: { list: number }): ModelDomain {
  return {
    ...domain,
    list: (...args: Parameters<ModelDomain["list"]>) => {
      counts.list++
      return domain.list(...args)
    },
  }
}

function throwing(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type: string, message: string, data?: unknown): never => {
      throw { type, message, data }
    },
  }
}

test("the host catalogue is read once within five minutes, and again past them", async () => {
  const project = await tempProject()
  const base = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build the thing.", modelRef("anthropic", "claude"))],
    models: [modelInfo("anthropic", "claude")],
    classifications: { "": "general", claude: "general" },
  })
  const counts = { list: 0 }
  const ctx = { ...base, model: countingModel(base.model, counts) }
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })
  const picker = () => Effect.runPromise(handlers["catalog.models"](undefined, throwing()))

  await picker()
  expect(counts.list).toBe(1)
  await picker()
  expect(counts.list).toBe(1)

  // The stamp is the state's own field; setting it past the bound is the clock the code reads.
  state.hostCatalogAt = Date.now() - 5 * MINUTE
  await picker()
  expect(counts.list).toBe(2)
  await picker()
  expect(counts.list).toBe(2)
})

test("a model-updated event drops the host catalogue even when the refresh waits for idle", async () => {
  const project = await tempProject()
  const base = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build the thing.", modelRef("anthropic", "claude"))],
    models: [modelInfo("anthropic", "claude")],
    classifications: { "": "general", claude: "general" },
  })
  const counts = { list: 0 }
  const model = countingModel(base.model, counts)
  const state = createState()
  // Idle (no run, last used long ago): the watcher defers the refresh, so only the event itself can drop the catalogue now.
  state.lastUsedAt = 0
  const handlers = createHandlers({ ...base, model }, state, { builtins: [] })
  const picker = () => Effect.runPromise(handlers["catalog.models"](undefined, throwing()))
  await picker()
  expect(counts.list).toBe(1)

  const watch = (type: string) => {
    const ctx = { ...base, model, event: { subscribe: () => Stream.fromIterable([{ type, data: {} }]) as never } }
    return Effect.runPromise(Effect.scoped(Effect.andThen(watchHostEvents(ctx, state), Effect.sleep("50 millis"))))
  }

  await watch(Agent.Event.Updated.type)
  expect(state.hostCatalog).toBeDefined()
  expect(counts.list).toBe(1)

  await watch(Model.Event.Updated.type)
  expect(state.hostCatalog).toBeUndefined()
  expect(state.hostModels).toBeUndefined()
  await picker()
  expect(counts.list).toBe(2)
})

test("a catalogue-only update advances snapshots without reinstalling unchanged instructions", async () => {
  const project = await tempProject()
  const models = [modelInfo("acceptance", "initial")]
  const events = await Effect.runPromise(PubSub.unbounded<{ type: string; data: unknown }>())
  const base = fullContext({ directory: project, models })
  const ctx = { ...base, event: { subscribe: () => Stream.fromPubSub(events) } as never }
  const state = createState()
  const api = createPlusApi(ctx, state, { builtins: [] })
  const scope = await Effect.runPromise(Scope.make())
  const notices = { count: 0 }
  const unsubscribe = onSharedStoreChanged((source) => { if (source === state) notices.count++ })
  try {
    await Effect.runPromise(activate(ctx, state))
    const before = (await api.snapshot()).value
    const plans = [...state.appliedParts.values()]
    const published = state.publishedHostModels
    const announced = notices.count
    await Effect.runPromise(watchHostEvents(ctx, state).pipe(Scope.provide(scope)))
    models.push(modelInfo("acceptance", "canary"))
    // Control: the already cached snapshot still lacks the newly listed model.
    expect((await api.snapshot()).value.hostModels?.some((model) => model.modelID === "canary")).toBe(false)
    await Effect.runPromise(PubSub.publish(events, { type: Model.Event.Updated.type, data: {} }))
    const deadline = Date.now() + 3000
    while (state.publishedHostModels === published && Date.now() < deadline) await Bun.sleep(10)
    expect(state.publishedHostModels).not.toBe(published)
    expect(notices.count).toBe(announced + 1)
    const after = (await api.snapshot()).value
    expect(after.hostModels?.some((model) => model.modelID === "canary")).toBe(true)
    expect(after.revision).toBe(before.revision)
    expect(after.globalRevision).toBe(before.globalRevision)
    expect([...state.appliedParts.values()]).toEqual(plans)
  } finally {
    unsubscribe()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await Effect.runPromise(deactivate(state))
  }
})
