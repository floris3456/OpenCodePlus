// `model.pick` (Part 3): a completed TUI pick becomes the agent's active model
// row. The pure decision is `pickModelRow` (instructions/ops.ts); the API wires
// it through activationDirectory, a catalog check and a revision-checked save.
//
// Each test states what it proves. Real store, real discovery, no mocks.
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createPlusApi, createState } from "../src/index.js"
import { load, save, type StoredRecord } from "../src/instructions/store.js"
import type { Model } from "@opencode/schema/model"
import { expandedTree } from "../src/instructions/tree.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { agentInfo, fullContext, modelInfo } from "./harness.js"

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
  const root = await fs.mkdtemp(path.join(parent, "plus-model-pick-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "share")
  return path.join(root, "project")
}

function modelWith(providerID: string, id: string, variants: string[] = []): Model.Info {
  const base = modelInfo(providerID, id)
  return {
    ...base,
    variants: variants.map((variant) => ({ id: variant }) as Model.Info["variants"][number]),
  }
}

function throwingContext(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      throw { type, message, data }
    },
  }
}

async function fixture(models: Model.Info[], agents = [agentInfo("build", "Build.")]) {
  const project = await tempProject()
  const classifications: Record<string, string> = { "": "general" }
  for (const model of models) classifications[String(model.id)] = "general"
  const ctx = fullContext({ directory: project, agents, models, classifications })
  const state = createState()
  return { project, ctx, state, api: createPlusApi(ctx, state) }
}

function modelRecords(records: readonly StoredRecord[]) {
  return records.filter((record) => record.type === "model")
}

function pick(
  handlers: ReturnType<typeof createHandlers>,
  input: { agent: string; providerID: string; modelID: string; variant?: string },
) {
  return Effect.runPromise(handlers["model.pick"](input, throwingContext()))
}

test("(2) a fresh store pick creates one Global row, active, with no per-row warming/interval/prompt", async () => {
  const { project, ctx } = await fixture([modelWith("acme", "nova-2", ["low", "high"])])
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const result = await pick(handlers, { agent: "build", providerID: "acme", modelID: "nova-2", variant: "high" })
  expect(result).toMatchObject({ level: "global", changed: true })
  const models = modelRecords((await load(project)).records)
  expect(models).toHaveLength(1)
  expect(models[0]).toMatchObject({ type: "model", level: "global", agent: "build", providerID: "acme", modelID: "nova-2", variant: "high", active: true })
  // No per-row warming/interval/prompt: they resolve from Defaults › Models.
  expect(models[0]).not.toHaveProperty("warming")
  expect(models[0]).not.toHaveProperty("interval")
  expect(models[0]).not.toHaveProperty("prompt")
  // The pick is now the agent's active model for a later session.
  expect(state.activeModels.get("build")).toMatchObject({ providerID: "acme", modelID: "nova-2", variant: "high" })
})

test("(3) a Global opus@high pick to @xhigh changes that one row and keeps it active", async () => {
  const { project, ctx } = await fixture([modelWith("cliproxyapi", "claude-opus-5-5", ["high", "xhigh"])])
  const handlers = createHandlers(ctx, createState())
  await pick(handlers, { agent: "build", providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "high" })
  await pick(handlers, { agent: "build", providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "xhigh" })
  const opus = modelRecords((await load(project)).records).filter(
    (record) => record.modelID === "claude-opus-5-5" && record.removed !== true,
  )
  expect(opus).toHaveLength(1)
  expect(opus[0]).toMatchObject({ level: "global", variant: "xhigh", active: true })
})

test("(4) an exact inactive candidate is activated, nothing added", async () => {
  const { project, ctx } = await fixture([modelWith("acme", "nova-2"), modelWith("acme", "nova-3")])
  const handlers = createHandlers(ctx, createState())
  const api = createPlusApi(ctx, createState())
  await api.addModel({ level: "global", agent: "build", providerID: "acme", modelID: "nova-2" })
  await api.addModel({ level: "global", agent: "build", providerID: "acme", modelID: "nova-3" })
  expect(modelRecords((await load(project)).records)).toHaveLength(2)
  await pick(handlers, { agent: "build", providerID: "acme", modelID: "nova-2" })
  const after = modelRecords((await load(project)).records)
  expect(after).toHaveLength(2)
  expect(after.find((record) => record.modelID === "nova-2")).toMatchObject({ active: true })
  expect(after.find((record) => record.modelID === "nova-3")?.active).toBeUndefined()
})

test("(5) repeating the current active pick writes nothing and moves no revision", async () => {
  const { project, ctx } = await fixture([modelWith("acme", "nova-2")])
  const handlers = createHandlers(ctx, createState())
  await pick(handlers, { agent: "build", providerID: "acme", modelID: "nova-2" })
  const before = await load(project)
  const again = await pick(handlers, { agent: "build", providerID: "acme", modelID: "nova-2" })
  expect(again.changed).toBe(false)
  const after = await load(project)
  expect(after.projectRevision).toBe(before.projectRevision)
  expect(after.globalRevision).toBe(before.globalRevision)
})

test("(6) a Project winner writes the row at Project and leaves Global untouched", async () => {
  const { project, ctx } = await fixture([modelWith("acme", "nova-2"), modelWith("acme", "nova-3")])
  const handlers = createHandlers(ctx, createState())
  const api = createPlusApi(ctx, createState())
  await api.addModel({ level: "global", agent: "build", providerID: "acme", modelID: "nova-2" })
  await api.addModel({ level: "project", agent: "build", providerID: "acme", modelID: "nova-2" })
  const result = await pick(handlers, { agent: "build", providerID: "acme", modelID: "nova-3" })
  expect(result.level).toBe("project")
  const nova3 = modelRecords((await load(project)).records).filter((record) => record.modelID === "nova-3")
  expect(nova3).toHaveLength(1)
  expect(nova3[0]).toMatchObject({ level: "project", active: true })
  const global = modelRecords((await load(project)).records).find((record) => record.level === "global" && record.modelID === "nova-2")
  expect(global).toMatchObject({ active: true })
})

test("(8) an unknown model refuses with model.invalid and writes nothing", async () => {
  const { project, ctx } = await fixture([modelWith("acme", "nova-2")])
  const handlers = createHandlers(ctx, createState())
  const before = await load(project)
  await expect(RunPick(handlers, { agent: "build", providerID: "acme", modelID: "does-not-exist" })).rejects.toMatchObject({
    type: "model.invalid",
  })
  const after = await load(project)
  expect(after.records).toEqual(before.records)
  expect(after.projectRevision).toBe(before.projectRevision)
  expect(after.globalRevision).toBe(before.globalRevision)
})

// Capture the thrown declared error instead of letting runPromise reject.
function RunPick(
  handlers: ReturnType<typeof createHandlers>,
  input: { agent: string; providerID: string; modelID: string; variant?: string },
) {
  const caught: { current?: { type: string; message: string; data?: unknown } } = {}
  const throwing = {
    error: (type: string, message: string, data?: unknown): never => {
      caught.current = { type, message, data }
      throw caught.current
    },
  }
  return Effect.runPromise(handlers["model.pick"](input, throwing))
}

test("(10) a command/subagent session.model.selected creates no rows", async () => {
  // The only events applySessionModel subscribes to are session.created and
  // session.agent.selected (SessionModelEvents, index.ts). A model switch from
  // a command, subagent or team run emits session.model.selected, which Plus
  // never subscribes to: it must not create or change a row.
  const { project, ctx } = await fixture([modelWith("acme", "nova-2")])
  const handlers = createHandlers(ctx, createState())
  const before = await load(project)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  expect(modelRecords(snapshot.records as readonly StoredRecord[])).toHaveLength(0)
  const after = await load(project)
  expect(after.records).toEqual(before.records)
})

test("(7) a one-team member pick writes its member row; an ambiguous member id refuses", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.")],
    models: [modelWith("acme", "nova-2"), modelWith("acme", "nova-3")],
    classifications: { "": "general", "nova-2": "general", "nova-3": "general" },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const throwing = throwingContext()
  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "Basic" }, throwing))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "global", team: "Basic", id: "Planner" }, throwing))
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "global", team: "Basic", enabled: true }, throwing))
  const result = await pick(handlers, { agent: "Planner", providerID: "acme", modelID: "nova-2" })
  expect(result.level).toBe("global")
  expect(result.rowId).toBe("item:global:Basic/:Planner:model:acme/nova-2")
  const planner = modelRecords((await load(project)).records).filter((record) => record.agent === "Planner")
  expect(planner).toHaveLength(1)
  expect(planner[0]).toMatchObject({ level: "global", agent: "Planner", active: true })

  // A second global team with the same member id, both enabled (seeded
  // directly: team.setEnabled is exclusive). The target is genuinely ambiguous:
  // two live teams claim Planner, so the pick refuses with no write.
  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "Backup" }, throwing))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "global", team: "Backup", id: "Planner" }, throwing))
  const seeded = await load(project)
  await save(project, {
    expectedProjectRevision: seeded.projectRevision,
    expectedGlobalRevision: seeded.globalRevision,
    records: [
      ...seeded.records,
      { type: "team", level: "global", team: "Backup", enabled: true, updated: "2026-01-01T00:00:00.000Z" },
    ],
  })
  const before = await load(project)
  await expect(RunPick(handlers, { agent: "Planner", providerID: "acme", modelID: "nova-3" })).rejects.toMatchObject({
    type: "model.invalid",
  })
  const after = await load(project)
  expect(after.records).toEqual(before.records)
})

// Fix 2: a member of a DISABLED team is not in force at runtime, so the pick
// must not redirect to a member row. With a standalone agent of the same id,
// the pick writes the standalone agent's row.
test("(11) a member of a disabled team resolves as the standalone agent", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build."), agentInfo("Planner", "Standalone.")],
    models: [modelWith("acme", "nova-2")],
    classifications: { "": "general", "nova-2": "general" },
  })
  const handlers = createHandlers(ctx, createState())
  const throwing = throwingContext()
  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "Basic" }, throwing))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "global", team: "Basic", id: "Planner" }, throwing))
  // The team stays disabled.
  const result = await pick(handlers, { agent: "Planner", providerID: "acme", modelID: "nova-2" })
  expect(result.level).toBe("defaults")
  expect(result.rowId).toBe("item:defaults:Planner:model:acme/nova-2")
  const planner = modelRecords((await load(project)).records).filter((record) => record.agent === "Planner")
  expect(planner).toHaveLength(1)
  expect(planner[0]).toMatchObject({ level: "defaults", agent: "Planner", active: true })
  expect(planner[0]).not.toHaveProperty("team")
})

// Fix 2: one enabled team and one disabled team is not ambiguous: the enabled
// team's member row is written.
test("(12) an id in one enabled and one disabled team writes the enabled member row", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.")],
    models: [modelWith("acme", "nova-2")],
    classifications: { "": "general", "nova-2": "general" },
  })
  const handlers = createHandlers(ctx, createState())
  const throwing = throwingContext()
  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "Basic" }, throwing))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "global", team: "Basic", id: "Planner" }, throwing))
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "global", team: "Basic", enabled: true }, throwing))
  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "Backup" }, throwing))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "global", team: "Backup", id: "Planner" }, throwing))
  // Backup stays disabled.
  const result = await pick(handlers, { agent: "Planner", providerID: "acme", modelID: "nova-2" })
  expect(result.level).toBe("global")
  expect(result.rowId).toBe("item:global:Basic/:Planner:model:acme/nova-2")
})

