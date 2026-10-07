import { afterEach, expect, test } from "bun:test"
import type { ModelDomain } from "@opencode/plugin/effect/model"
import type { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState, refreshFromHost } from "../src/index.js"
import { hostModelsOf } from "../src/instructions/discover.js"
import { agentInfo, fullContext, modelInfo, modelRef } from "./harness.js"

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
  const root = await fs.mkdtemp(path.join(parent, "plus-catalogue-nav-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "share")
  return path.join(root, "project")
}

function modelWith(providerID: string, id: string, options: { name?: string; variants?: string[]; warming?: unknown } = {}): Model.Info {
  const base = options.name === undefined ? modelInfo(providerID, id) : modelInfo(providerID, id, options.name)
  return {
    ...base,
    variants: (options.variants ?? []).map((variant) => ({ id: variant }) as Model.Info["variants"][number]),
    ...(options.warming === undefined ? {} : { settings: { warming: options.warming } }),
  }
}

interface ModelCounts {
  list: number
  transform: number
  reload: number
}

function countingModel(domain: ModelDomain, counts: ModelCounts): ModelDomain {
  return {
    ...domain,
    list: (...args: Parameters<ModelDomain["list"]>) => {
      counts.list++
      return domain.list(...args)
    },
    transform: (...args: Parameters<ModelDomain["transform"]>) => {
      counts.transform++
      return domain.transform(...args)
    },
    reload: (...args: Parameters<ModelDomain["reload"]>) => {
      counts.reload++
      return domain.reload(...args)
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

test("navigation reads no provider catalogue; the picker reads it once, then cached", async () => {
  const project = await tempProject()
  const models = [
    modelWith("anthropic", "claude", { name: "Claude", variants: ["low", "high"], warming: { interval: "3.5 minutes", duration: "30 minutes" } }),
    modelWith("acme", "nova", { name: "Nova" }),
  ]
  const base = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build the thing.", modelRef("anthropic", "claude"))],
    models,
    classifications: { "": "general", claude: "general", nova: "general" },
  })
  const counts: ModelCounts = { list: 0, transform: 0, reload: 0 }
  const ctx = { ...base, model: countingModel(base.model, counts) }
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })
  const throwingContext = throwing()

  // A picker open on a cold cache reads the catalogue once.
  const picker = await Effect.runPromise(handlers["catalog.models"](undefined, throwingContext))
  expect(picker.models.map((entry) => `${entry.providerID}/${entry.modelID}${entry.variant === undefined ? "" : `@${entry.variant}`}`)).toEqual(["anthropic/claude", "anthropic/claude@low", "anthropic/claude@high", "acme/nova"])
  expect(counts.list).toBe(1)

  // The scripted navigation the TUI performs while moving through the tree:
  // snapshots on open and on change events, refreshes, and another picker
  // open. None of them may touch the provider catalogue again.
  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext))
  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext))
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext))
  await Effect.runPromise(handlers["catalog.models"](undefined, throwingContext))
  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext))
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext))
  expect(counts.list).toBe(1)

  // Plus never installs a model transform and never reloads the model
  // registry, so navigation also causes no model notifications.
  expect(counts.transform).toBe(0)
  expect(counts.reload).toBe(0)
})

test("a cold navigation reads the catalogue once, and a host change refreshes it once", async () => {
  const project = await tempProject()
  const models = [modelWith("anthropic", "claude", { variants: ["low", "high"] })]
  const base = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build the thing.", modelRef("anthropic", "claude"))],
    models,
    classifications: { "": "general", claude: "general" },
  })
  const counts: ModelCounts = { list: 0, transform: 0, reload: 0 }
  const ctx = { ...base, model: countingModel(base.model, counts) }
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })
  const throwingContext = throwing()

  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext))
  expect(counts.list).toBe(1)
  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext))
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext))
  expect(counts.list).toBe(1)

  // A host config/agent/skill change drops the cache at the host lifecycle
  // point, so the next refresh re-reads once and then holds again.
  state.pendingHostChange = true
  await Effect.runPromise(refreshFromHost(ctx, state))
  expect(counts.list).toBe(2)
  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext))
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext))
  expect(counts.list).toBe(2)
})

test("the cached catalogue keeps names, variants and effective warming", async () => {
  const project = await tempProject()
  const base = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build the thing.", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude", { name: "Claude", variants: ["low", "high"], warming: { interval: "3.5 minutes", duration: "30 minutes" } }),
    ],
    classifications: { "": "general", claude: "general" },
  })
  const ctx = { ...base }
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })
  const fresh = await hostModelsOf(ctx)
  const first = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing()))
  // Navigate repeatedly; every snapshot must carry the same catalogue the
  // host reports, with names, variants and warming intact.
  for (let i = 0; i < 3; i++) {
    const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing()))
    expect(snapshot.hostModels).toEqual(first.hostModels)
  }
  expect(first.hostModels).toEqual(
    fresh.map((entry) => ({
      providerID: entry.providerID,
      modelID: entry.modelID,
      variants: [...entry.variants],
      ...(entry.warming === undefined ? {} : { warming: { ...entry.warming } }),
    })),
  )
  expect(first.hostModels).toEqual([
    {
      providerID: "anthropic",
      modelID: "claude",
      variants: ["low", "high"],
      warming: { on: true, interval: 3.5 * 60 * 1000, duration: 30 * 60 * 1000 },
    },
  ])
})

test("model validation reuses the cached catalogue instead of re-reading it", async () => {
  const project = await tempProject()
  const base = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build the thing.", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude", { variants: ["low", "high"] })],
    classifications: { "": "general", claude: "general" },
  })
  const counts: ModelCounts = { list: 0, transform: 0, reload: 0 }
  const ctx = { ...base, model: countingModel(base.model, counts) }
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })
  const throwingContext = throwing()

  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext))
  expect(counts.list).toBe(1)
  const added = await Effect.runPromise(
    handlers["model.add"]({ level: "project", agent: "build", providerID: "anthropic", modelID: "claude", variant: "high" }, throwingContext),
  )
  expect(added.providerID).toBe("anthropic")
  const picked = await Effect.runPromise(
    handlers["model.pick"]({ agent: "build", providerID: "anthropic", modelID: "claude", variant: "low" }, throwingContext),
  )
  expect(picked.status.length).toBeGreaterThan(0)
  expect(counts.list).toBe(1)
})

test("a model that arrives after the cache was filled is accepted with one more read", async () => {
  const project = await tempProject()
  const models = [modelWith("anthropic", "claude", { variants: ["low", "high"] })]
  const base = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build the thing.", modelRef("anthropic", "claude"))],
    models,
    classifications: { "": "general", claude: "general", fresh: "general" },
  })
  const counts: ModelCounts = { list: 0, transform: 0, reload: 0 }
  const ctx = { ...base, model: countingModel(base.model, counts) }
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwingContext = throwing()
  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext))
  expect(counts.list).toBe(1)
  // A provider plugin's catalogue sync adds a model without a host event Plus watches.
  models.push(modelWith("anthropic", "fresh", { variants: ["high"] }))
  const picked = await Effect.runPromise(
    handlers["model.pick"]({ agent: "build", providerID: "anthropic", modelID: "fresh", variant: "high" }, throwingContext),
  )
  expect(picked.status.length).toBeGreaterThan(0)
  expect(counts.list).toBe(2)
})
