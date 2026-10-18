// Defaults › Models (model-settings.ts): the model settings every agent falls
// back to. The unit tests cover parsing, the record store, the per-field
// resolution order and the rows; the API tests cover modelSettings.set, the
// snapshot fields, mutate carry-over and the instructions tools.
import { afterEach, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import { Tool } from "@opencode/schema/tool"
import { Agent as AgentSchema } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { createHandlers, createPlusApi, createState } from "../src/index.js"
import { buildMemo, expandedTree } from "../src/instructions/tree.js"
import { query } from "../src/instructions/query.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { load, save, canonical } from "../src/instructions/store.js"
import { editModelRow } from "../src/instructions/ops.js"
import { formatDuration, parseInterval, parsePrompt, parseWarming, setModelSettings, type ModelRecord } from "../src/instructions/model.js"
import {
  BUILT_IN_WARMING,
  decodeHostWarming,
  effectiveWarming,
  everySettings,
  hostModelOf,
  isModelDefaultRowId,
  modelDefaultItemId,
  modelDefaultKeys,
  modelDefaultRowId,
  modelDefaultValue,
  modelDefaultView,
  isModelSettingRowId,
  modelFieldItemId,
  modelSettingItemId,
  modelSettingParentRowId,
  modelSettingRowId,
  modelSettingValue,
  parseModelDefaultItemId,
  parseModelSettingItemId,
  roundedWarmingFor,
  roundWarming,
  setModelSettingsRecord,
  settingsFor,
  warmingFieldsOf,
  type HostModel,
  type ModelSettingsRecord,
} from "../src/instructions/model-settings.js"
import { registerInstructionTools } from "../src/tools.js"
import { agentInfo, fullContext, modelInfo, modelRef } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const MINUTE = 60_000

const record = (overrides: Partial<ModelSettingsRecord>): ModelSettingsRecord => ({
  type: "modelSettings",
  level: "defaults",
  updated: UPDATED,
  ...overrides,
})

const modelRow = (overrides: Partial<ModelRecord>): ModelRecord => ({
  type: "model",
  level: "project",
  agent: "alpha",
  providerID: "anthropic",
  modelID: "claude",
  updated: UPDATED,
  ...overrides,
})

const host = (overrides: Partial<HostModel>): HostModel => ({
  providerID: "anthropic",
  modelID: "claude",
  variants: [],
  ...overrides,
})

test("intervals parse to 30s..24h and format back canonically", () => {
  expect(parseInterval("4m")).toEqual({ interval: 4 * MINUTE })
  expect(parseInterval("3m 30s")).toEqual({ interval: 3.5 * MINUTE })
  expect(parseInterval("1h")).toEqual({ interval: 60 * MINUTE })
  expect("error" in parseInterval("soon")).toBe(true)
  expect("error" in parseInterval("10s")).toBe(true)
  expect("error" in parseInterval("25h")).toBe(true)
  expect("error" in parseInterval("")).toBe(true)
  expect(formatDuration(3.5 * MINUTE)).toBe("3m30s")
})

test("keep-alive prompts must be non-empty and at most 2000 characters", () => {
  expect(parsePrompt("  hello  ")).toEqual({ prompt: "hello" })
  expect("error" in parsePrompt("   ")).toBe(true)
  expect("error" in parsePrompt("x".repeat(2001))).toBe(true)
})

test("warming fields parse to stored values, empty clears, bad values refuse", () => {
  expect(warmingFieldsOf({ warming: "45m", interval: "3m30s", prompt: " hi " })).toEqual({
    fields: { warming: "45m", interval: "3m30s", prompt: "hi" },
  })
  expect(warmingFieldsOf({ warming: "2h", interval: "", prompt: "" })).toEqual({
    fields: { warming: "2h", interval: null, prompt: null },
  })
  const bad = warmingFieldsOf({ interval: "soon" })
  expect("error" in bad && bad.error).toContain("not an interval")
  expect(warmingFieldsOf({})).toEqual({ fields: {} })
  // The warming time still gates through parseWarming (off/on/1m..24h).
  expect(parseWarming("off")).toEqual({ on: false })
})

test("decodeHostWarming reads the scoped config forms and ignores anything else", () => {
  expect(decodeHostWarming(false)).toEqual({ on: false })
  expect(decodeHostWarming(true)).toEqual({ on: true })
  expect(decodeHostWarming({ interval: "3.5 minutes", duration: "30 minutes" })).toEqual({
    on: true,
    interval: 3.5 * MINUTE,
    duration: 30 * MINUTE,
  })
  expect(decodeHostWarming({ prompt: "ping" })).toEqual({ on: true, prompt: "ping" })
  expect(decodeHostWarming("on")).toBeUndefined()
  expect(decodeHostWarming({ interval: "soon" })).toBeUndefined()
  expect(decodeHostWarming(undefined)).toBeUndefined()
})

test("setModelSettingsRecord sets, merges and clears fields; an empty row is removed", () => {
  expect(modelDefaultItemId({})).toBe("modeldefault:*")
  const created = setModelSettingsRecord([], {}, { warming: "30m", interval: "5m" }, UPDATED)
  expect(created).toEqual([record({ warming: "30m", interval: "5m" })])
  const merged = setModelSettingsRecord(created, {}, { interval: "6m" }, "2026-02-01T00:00:00.000Z")
  expect(merged).toEqual([record({ warming: "30m", interval: "6m", updated: "2026-02-01T00:00:00.000Z" })])
  // An unchanged save returns an equal list.
  expect(setModelSettingsRecord(merged, {}, { warming: "30m" }, UPDATED)).toEqual(merged)
  // Clearing the last field removes the row; clearing nothing changes nothing.
  expect(setModelSettingsRecord(merged, {}, { warming: null, interval: null }, UPDATED)).toEqual([])
  expect(setModelSettingsRecord(merged, { providerID: "anthropic", modelID: "claude" }, { warming: null }, UPDATED)).toEqual(merged)
  const two = setModelSettingsRecord(merged, { providerID: "anthropic", modelID: "claude" }, { interval: "4m" }, UPDATED)
  expect(two).toHaveLength(2)
  expect(everySettings(two)?.interval).toBe("6m")
  expect(settingsFor(two, { providerID: "anthropic", modelID: "claude" })).toMatchObject({ interval: "4m" })
  expect(hostModelOf([host({})], { providerID: "anthropic", modelID: "claude" })?.modelID).toBe("claude")
})

test("model rows carry their own interval and prompt, set and cleared field by field", () => {
  const row = modelRow({})
  const warmed = setModelSettings([row], { level: "project", agent: "alpha" }, { providerID: "anthropic", modelID: "claude" }, { interval: "5m", prompt: "ping" }, UPDATED)
  expect(warmed[0]?.interval).toBe("5m")
  expect(warmed[0]?.prompt).toBe("ping")
  const cleared = setModelSettings(warmed, { level: "project", agent: "alpha" }, { providerID: "anthropic", modelID: "claude" }, { prompt: null }, UPDATED)
  expect(cleared[0]?.interval).toBe("5m")
  expect("prompt" in (cleared[0] ?? {})).toBe(false)
  // Clearing a field nothing sets on this row returns the same list.
  expect(setModelSettings([row], { level: "project", agent: "alpha" }, { providerID: "anthropic", modelID: "claude" }, { prompt: null }, UPDATED)).toEqual([row])
})

test("editModelRow carries the interval and prompt with the warming time", () => {
  const input = {
    items: [],
    records: [
      {
        type: "model" as const,
        level: "project" as const,
        agent: "alpha",
        providerID: "anthropic",
        modelID: "claude",
        updated: UPDATED,
      },
    ],
    agents: [{ id: "alpha", scope: "project" as const }],
  }
  const rowId = "item:project:alpha:model:anthropic/claude"
  const applied = editModelRow(input, rowId, { providerID: "anthropic", modelID: "claude", interval: "3m30s", prompt: "  ping  " })
  if ("refusal" in applied) throw new Error(applied.refusal)
  expect(applied.models[0]).toMatchObject({ interval: "3m30s", prompt: "ping" })
  const cleared = editModelRow({ ...input, records: applied.models }, rowId, { providerID: "anthropic", modelID: "claude", prompt: "" })
  if ("refusal" in cleared) throw new Error(cleared.refusal)
  expect(cleared.models[0]?.interval).toBe("3m30s")
  expect("prompt" in (cleared.models[0] ?? {})).toBe(false)
  const bad = editModelRow(input, rowId, { providerID: "anthropic", modelID: "claude", interval: "soon" })
  expect("refusal" in bad && bad.refusal).toContain("not an interval")
})

test("modelDefaultKeys unions stored rows, agent models and every host model, sorted and deduped", () => {
  const keys = modelDefaultKeys({
    modelSettings: [record({ providerID: "zeta", modelID: "one" }), record({})],
    models: [modelRow({}), modelRow({ providerID: "zeta", modelID: "one", variant: "high" })],
    agents: [{ model: { providerID: "beta", modelID: "two" } }, { model: { providerID: "anthropic", modelID: "claude" } }],
    hostModels: [host({ warming: { on: true, interval: MINUTE } }), host({ providerID: "gamma", modelID: "unused" })],
  })
  expect(keys).toEqual([
    { providerID: "anthropic", modelID: "claude" },
    { providerID: "beta", modelID: "two" },
    { providerID: "gamma", modelID: "unused" },
    { providerID: "zeta", modelID: "one" },
  ])
  expect(modelDefaultItemId({ providerID: "zeta", modelID: "one" })).toBe("modeldefault:zeta/one")
  expect(modelDefaultRowId({ providerID: "zeta", modelID: "one" })).toBe("item:defaults:/models:modeldefault:zeta/one")
  expect(modelDefaultRowId({})).toBe("item:defaults:/models:modeldefault:*")
  expect(parseModelDefaultItemId("modeldefault:*")).toEqual({})
  expect(parseModelDefaultItemId("modeldefault:a/b@c")).toEqual({ providerID: "a", modelID: "b@c" })
  expect(parseModelDefaultItemId("model:anthropic/claude")).toBeUndefined()
  expect(isModelDefaultRowId("item:defaults:/models:modeldefault:*")).toBe(true)
  expect(isModelDefaultRowId("item:defaults::models:model:anthropic/claude")).toBe(false)
})

test("a catalog model with no warming and no record still lists in Defaults › Models, writing nothing", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude", { variants: ["low", "high"] }),
      // No `settings`: no opencode.json warming. The model must still list.
      modelWith("deepseek", "v4-flash"),
    ],
    classifications: { "": "general", claude: "general", "v4-flash": "general" },
  })
  const api = createPlusApi(ctx, createState())
  const before = await load(project)
  const snapshot = (await api.snapshot()).value
  const keys = modelDefaultKeys({
    modelSettings: snapshot.modelSettings ?? [],
    models: [],
    agents: [],
    hostModels: [
      host({ providerID: "anthropic", modelID: "claude", warming: { on: true, interval: MINUTE } }),
      host({ providerID: "deepseek", modelID: "v4-flash" }),
    ],
  })
  expect(keys).toEqual([
    { providerID: "anthropic", modelID: "claude" },
    { providerID: "deepseek", modelID: "v4-flash" },
  ])
  // The tree row exists for the warming-less model.
  const rows = expandedTree(memoInputOf(snapshot)).filter((row) => isModelDefaultRowId(row.id))
  expect(rows.map((row) => row.label)).toEqual(["Every model", "anthropic/claude", "deepseek/v4-flash"])
  // Listing wrote nothing: no modelSettings rows, same revisions.
  const after = await load(project)
  expect(after.records.filter((record) => record.type === "modelSettings")).toHaveLength(0)
  expect(after.projectRevision).toBe(before.projectRevision)
  expect(after.globalRevision).toBe(before.globalRevision)
})

test("a Defaults › Models row resolves field by field: own, Every model, opencode.json, built-in", () => {
  const every = record({ warming: "on", interval: "25m", prompt: "every-ping" })
  const own = record({ providerID: "anthropic", modelID: "claude", interval: "3m" })
  const config = { on: true, duration: 90 * MINUTE, interval: 30 * MINUTE, prompt: "config-ping" }
  const mixed = modelDefaultView({ record: own, every, host: config })
  // own interval, Every model's warming/prompt, config's duration.
  expect(mixed.on).toEqual({ value: true, from: "every" })
  expect(mixed.interval).toEqual({ value: 3 * MINUTE, from: "model" })
  expect(mixed.prompt).toEqual({ value: "every-ping", from: "every" })
  expect(mixed.duration).toEqual({ value: 90 * MINUTE, from: "config" })
  expect(mixed.own).toBe(true)
  expect(modelDefaultValue(mixed)).toBe("warm 1h30m · every 3m")
  // Without an own row the summary names the sources. 90m with a 25m ping
  // warms four whole pings: 1h40m.
  expect(modelDefaultValue(modelDefaultView({ every, host: config }))).toBe("warm 1h40m · every 25m · every model · opencode.json")
  expect(modelDefaultValue(modelDefaultView({ host: config }))).toBe("warm 1h30m · every 30m · opencode.json")
  // Nothing sets warming, and the built-in default is off.
  expect(modelDefaultValue(modelDefaultView({}))).toBe("warming off · built-in")
  const off = modelDefaultView({ host: { on: false } })
  expect(off.on).toEqual({ value: false, from: "config" })
  expect(modelDefaultValue(off)).toBe("warming off · opencode.json")
})

test("the default effort comes from the model's row, else Every model when the model has that variant", () => {
  const variants = ["low", "high"]
  expect(modelDefaultView({ record: record({ effort: "high" }), variants }).effort).toEqual({ value: "high", from: "model" })
  expect(modelDefaultView({ record: record({ effort: "max" }), variants }).effort).toBeUndefined()
  expect(modelDefaultView({ every: record({ effort: "low" }), variants }).effort).toEqual({ value: "low", from: "every" })
  expect(modelDefaultView({ every: record({ effort: "max" }), variants }).effort).toBeUndefined()
  // Unknown variants (no catalog entry) keep the model's own effort.
  expect(modelDefaultView({ record: record({ effort: "max" }) }).effort).toEqual({ value: "max", from: "model" })
})

test("effectiveWarming orders the layers row, model, Every model, config, built-in", () => {
  const effective = effectiveWarming({
    row: { interval: { value: "3m", level: "project" } },
    model: record({ interval: "4m", warming: "45m" }),
    every: record({ interval: "5m", warming: "on", prompt: "every" }),
    host: { on: true, duration: 30 * MINUTE, interval: 10 * MINUTE, prompt: "config" },
  })
  expect(effective.interval).toEqual({ value: 3 * MINUTE, from: "project" })
  expect(effective.duration).toEqual({ value: 45 * MINUTE, from: "model" })
  expect(effective.prompt).toEqual({ value: "every", from: "every" })
  expect(effective.on).toEqual({ value: true, from: "model" })
  // Every model beats per-model opencode.json; config beats the built-in.
  const everyOverConfig = effectiveWarming({ every: record({ warming: "on", interval: "5m" }), host: { on: true, interval: 10 * MINUTE } })
  expect(everyOverConfig.interval).toEqual({ value: 5 * MINUTE, from: "every" })
  expect(everyOverConfig.on).toEqual({ value: true, from: "every" })
  // An interval alone never turns warming on: the config's on-state stands.
  expect(effectiveWarming({ every: record({ interval: "5m" }), host: { on: true, interval: 10 * MINUTE } }).on).toEqual({
    value: true,
    from: "config",
  })
})

// ---------------------------------------------------------------------------
// Rows, the RPC and the tools.

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
  const root = await fs.mkdtemp(path.join(parent, "plus-model-settings-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "share")
  return path.join(root, "project")
}

function modelWith(providerID: string, id: string, options: { variants?: string[]; warming?: unknown } = {}): Model.Info {
  const base = modelInfo(providerID, id)
  return {
    ...base,
    variants: (options.variants ?? []).map((variant) => ({ id: variant }) as Model.Info["variants"][number]),
    ...(options.warming === undefined ? {} : { settings: { warming: options.warming } }),
  }
}

function thrownContext() {
  return {
    error: (type: string, message: string, data?: unknown): never => {
      throw { type, message, data }
    },
  }
}

test("the RPC writes the row into the global store and the snapshot carries it", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build the thing.", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude", { variants: ["low", "high"], warming: { interval: "3.5 minutes", duration: "30 minutes" } })],
    classifications: { "": "general", claude: "general" },
  })
  const api = createPlusApi(ctx, createState())
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const written = await Effect.runPromise(
    handlers["modelSettings.set"]({ providerID: "anthropic", modelID: "claude", interval: "3m", warming: "2h" }, thrownContext()),
  )
  expect(written.record).toMatchObject({ type: "modelSettings", level: "defaults", providerID: "anthropic", modelID: "claude", interval: "3m", warming: "2h" })
  expect((await load(project)).records.filter((entry) => entry.type === "modelSettings")).toHaveLength(1)
  const snapshot = await api.snapshot()
  expect(snapshot.value.modelSettings).toEqual([
    { type: "modelSettings", level: "defaults", providerID: "anthropic", modelID: "claude", interval: "3m", warming: "2h", updated: expect.any(String) },
  ])
  expect(snapshot.value.hostModels).toEqual([
    { providerID: "anthropic", modelID: "claude", variants: ["low", "high"], warming: { on: true, interval: 3.5 * MINUTE, duration: 30 * MINUTE } },
  ])
  // Every model has no ids; bad fields refuse through the declared error.
  const every = await Effect.runPromise(handlers["modelSettings.set"]({ effort: "high" }, thrownContext()))
  expect(every.record).toMatchObject({ effort: "high" })
  await expect(Effect.runPromise(handlers["modelSettings.set"]({ interval: "soon" }, thrownContext()))).rejects.toMatchObject({
    type: "modelSettings.invalid",
  })
  await expect(Effect.runPromise(handlers["modelSettings.set"]({ providerID: "anthropic" }, thrownContext()))).rejects.toMatchObject({
    type: "modelSettings.invalid",
  })
})

test("a mutate carries the Defaults › Models rows over and cannot drop them", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.", modelRef("anthropic", "claude"))],
    classifications: { "": "general", claude: "general" },
  })
  const api = createPlusApi(ctx, createState())
  await api.setModelSettings({ warming: "45m" })
  await api.setModelSettings({ providerID: "anthropic", modelID: "claude", interval: "4m" })
  const before = await load(project)
  const after = await api.mutate({ expectedRevision: before.projectRevision, expectedGlobalRevision: before.globalRevision, records: [] })
  if (!after.ok) throw new Error(`mutate refused: ${after.error.message}`)
  expect(after.value.ok).toBe(true)
  const stored = await load(project)
  expect(
    canonical(stored.records).flatMap((entry) =>
      entry.type === "modelSettings" ? [`${entry.providerID ?? "*"}/${entry.modelID ?? "*"}`] : [],
    ),
  ).toEqual(["*/*", "anthropic/claude"])
})

// The delta path a TUI model-row write takes: the upsert's compaction fields
// survive the server's toRecord and the snapshot round trip.
test("a model mutate delta keeps the per-model compaction fields", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.", modelRef("anthropic", "claude"))],
    classifications: { "": "general", claude: "general" },
  })
  const api = createPlusApi(ctx, createState())
  const before = await load(project)
  const after = await api.mutate({
    expectedRevision: before.projectRevision,
    expectedGlobalRevision: before.globalRevision,
    changes: {
      upsert: [{
        type: "model",
        level: "project",
        agent: "build",
        providerID: "anthropic",
        modelID: "claude",
        coldCompact: "on",
        coldModels: ["cheap/one", "cheap/two"],
        compactionStrategy: "local",
        updated: UPDATED,
      }],
      remove: [],
    },
  })
  if (!after.ok) throw new Error(`mutate refused: ${after.error.message}`)
  const stored = (await load(project)).records.find((entry): entry is ModelRecord => entry.type === "model")
  expect(stored).toMatchObject({ coldCompact: "on", coldModels: ["cheap/one", "cheap/two"], compactionStrategy: "local" })
  const snapshot = (await api.snapshot()).value
  expect(snapshot.records.find((entry) => entry.type === "model")).toMatchObject({
    coldCompact: "on",
    coldModels: ["cheap/one", "cheap/two"],
    compactionStrategy: "local",
  })
})

test("Defaults › Models rows render Every model first with per-model rows and their values", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.", modelRef("openai", "gpt-6-astra"))],
    models: [
      modelWith("anthropic", "claude", { warming: { interval: "3.5 minutes", duration: "30 minutes" } }),
      modelWith("openai", "gpt-6-astra"),
    ],
    classifications: { "": "general", claude: "general", "gpt-6-astra": "general" },
  })
  const api = createPlusApi(ctx, createState())
  await api.setModelSettings({ warming: "on", interval: "5m" })
  const snapshot = (await api.snapshot()).value
  const rows = expandedTree(memoInputOf(snapshot)).filter((row) => isModelDefaultRowId(row.id))
  expect(rows.map((row) => row.label)).toEqual(["Every model", "anthropic/claude", "openai/gpt-6-astra"])
  // The Every model row shows its own values; the others inherit them, so the
  // summary names the source.
  expect(rows[0]?.badges.value).toBe("warm 30m · every 5m")
  // Claude keeps its own config duration while inheriting the rest.
  expect(rows[1]?.badges.value).toBe("warm 30m · every 5m · every model · opencode.json")
  expect(rows[2]?.badges.value).toBe("warm 30m · every 5m · every model")
  // The row itself opens into its fields; the fields edit.
  expect(rows[0]?.actions).toMatchObject({ toggle: false, edit: false, reset: true, remove: true })
  // A model with no Plus row and no config shows the built-in values.
  expect(rows[2]?.badges.modified).toBeUndefined()
})

test("the query engine finds Defaults › Models rows with item:modeldefault and label", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude")],
    classifications: { "": "general", claude: "general" },
  })
  const api = createPlusApi(ctx, createState())
  await api.setModelSettings({ warming: "on" })
  const input = memoInputOf((await api.snapshot()).value)
  const memo = buildMemo(input)
  expect(query(input, { where: "item:modeldefault", fields: ["id"] }, memo).rows.map((row) => row.id)).toEqual([
    "item:defaults:/models:modeldefault:*",
    "item:defaults:/models:modeldefault:anthropic/claude",
  ])
  expect(query(input, { where: "label:nova", fields: ["id"] }, memo).rows).toEqual([])
  // The row and the one field it sets are modified; its other fields inherit.
  expect(query(input, { where: "modified:true", fields: ["id"] }, memo).rows.map((row) => row.id)).toEqual([
    "item:defaults:/models:modeldefault:*",
    "item:defaults:/models:modelsetting:warming:*",
  ])
  expect(query(input, { where: "item:modelsetting label:Ping", fields: ["id"] }, memo).rows.map((row) => row.id)).toEqual([
    "item:defaults:/models:modelsetting:interval:*",
    "item:defaults:/models:modelsetting:interval:anthropic/claude",
  ])
  // The Every model row carries its own values, so the badge projection says
  // modified and the record projection returns the stored row.
  const badges = query(input, { where: "item:modeldefault label:Every", fields: ["id", "badges"] }, memo)
  expect(badges.rows.map((row) => row.badges)).toEqual(["modified"])
  const record = query(input, { where: "id:item:defaults:/models:modeldefault:*", fields: ["id", "record"] }, memo)
  expect(record.rows[0]?.record).toMatchObject({ type: "modelSettings", warming: "on" })
})

test("instructions.set, reset, delete and show cover a Defaults › Models row", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude", { variants: ["low", "high"], warming: { interval: "3.5 minutes" } })],
    classifications: { "": "general", claude: "general" },
  })
  await registerInstructionTools(ctx, createPlusApi(ctx, createState()))
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const show = need(tools, "instructions_show")
  const reset = need(tools, "instructions_reset")
  const del = need(tools, "instructions_delete")
  await runOk(set, { id: "item:defaults:/models:modeldefault:*", warming: "on", interval: "5m", prompt: "keep this chat warm" })
  const stored = await load(project)
  expect(stored.records.find((entry) => entry.type === "modelSettings")).toMatchObject({
    warming: "on",
    interval: "5m",
    prompt: "keep this chat warm",
  })
  const recordView = (await runOk(show, { id: "item:defaults:/models:modeldefault:*", view: "record" })) as { record: { interval?: string } }
  expect(recordView.record).toMatchObject({ interval: "5m" })
  const resolved = (await runOk(show, { id: "item:defaults:/models:modeldefault:*" })) as {
    summary: string
    interval: { value: number; from: string }
    effort?: unknown
  }
  expect(resolved.summary).toBe("warm 30m · every 5m")
  expect(resolved.interval).toEqual({ value: 5 * MINUTE, from: "model" })
  // The per-model row edits on its own key and resolves through it.
  await runOk(set, { id: "item:defaults:/models:modeldefault:anthropic/claude", interval: "4m", effort: "high" })
  const claude = (await runOk(show, { id: "item:defaults:/models:modeldefault:anthropic/claude" })) as {
    interval: { value: number; from: string }
    effort?: { value: string; from: string }
  }
  expect(claude.interval).toEqual({ value: 4 * MINUTE, from: "model" })
  expect(claude.effort).toEqual({ value: "high", from: "model" })
  // Bad values refuse; state off writes warming off.
  expect((await runFail(set, { id: "item:defaults:/models:modeldefault:*", interval: "soon" })).message).toContain("not an interval")
  await runOk(set, { id: "item:defaults:/models:modeldefault:*", state: "off" })
  expect((await load(project)).records.find((entry) => entry.type === "modelSettings" && entry.providerID === undefined)).toMatchObject({
    warming: "off",
    interval: "5m",
  })
  // reset clears every field of the Every model row and removes it.
  await runOk(reset, { id: "item:defaults:/models:modeldefault:*" })
  expect((await load(project)).records.some((entry) => entry.type === "modelSettings" && entry.providerID === undefined)).toBe(false)
  await runOk(set, { id: "item:defaults:/models:modeldefault:anthropic/claude", warming: "45m" })
  await runOk(del, { id: "item:defaults:/models:modeldefault:anthropic/claude", confirm: true })
  expect((await load(project)).records.some((entry) => entry.type === "modelSettings")).toBe(false)
  // An agent model row takes the interval and prompt through the same tool,
  // planting the project row the way a warming-only set does.
  await runOk(set, { id: "item:project:build:model:anthropic/claude", interval: "3m30s", prompt: "ping" })
  expect((await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build")).toMatchObject({
    interval: "3m30s",
    prompt: "ping",
  })
  const badModel = await runFail(set, { id: "item:project:build:model:anthropic/claude", interval: "soon" })
  expect(badModel.message).toContain("not an interval")
})

test("a warming time is a whole number of pings, rounded up and capped under 24h", () => {
  expect(roundWarming(30 * MINUTE, 4 * MINUTE)).toBe(32 * MINUTE)
  expect(roundWarming(32 * MINUTE, 4 * MINUTE)).toBe(32 * MINUTE)
  expect(roundWarming(30 * MINUTE, 3.5 * MINUTE)).toBe(31.5 * MINUTE)
  // Rounding up past 24h would store a time that no longer parses: round down there.
  expect(roundWarming(24 * 60 * MINUTE, 7 * MINUTE)).toBe(205 * 7 * MINUTE)
  // Resolution rounds where the time and the interval come from different rows.
  const view = effectiveWarming({ model: record({ warming: "30m" }), every: record({ interval: "4m" }) })
  expect(view.duration).toEqual({ value: 32 * MINUTE, from: "model" })
  expect(modelDefaultValue(modelDefaultView({ record: record({ warming: "on" }) }))).toBe("warm 32m · every 4m")
  // Saving rounds a row's own time against the interval it resolves to.
  const rows = [record({ interval: "4m" }), record({ providerID: "a", modelID: "b", warming: "30m" })]
  expect(roundedWarmingFor(rows, { providerID: "a", modelID: "b" })).toBe("32m")
  expect(roundedWarmingFor(rows, { providerID: "a", modelID: "b" }, { on: true, interval: 3.5 * MINUTE })).toBe("32m")
  expect(roundedWarmingFor([record({ providerID: "a", modelID: "b", warming: "30m" })], { providerID: "a", modelID: "b" }, { on: true, interval: 3.5 * MINUTE })).toBe("31m30s")
  // Control: a whole time, "on" and "off" stay as typed.
  expect(roundedWarmingFor([record({ warming: "32m", interval: "4m" })], {})).toBeUndefined()
  expect(roundedWarmingFor([record({ warming: "on", interval: "7m" })], {})).toBeUndefined()
  expect(roundedWarmingFor([record({ warming: "off" })], {})).toBeUndefined()
})

test("modelSettings.set saves a warming time rounded up to whole pings", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude", { warming: { interval: "3.5 minutes" } })],
    classifications: { "": "general", claude: "general" },
  })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const set = (input: Parameters<(typeof handlers)["modelSettings.set"]>[0]) =>
    Effect.runPromise(handlers["modelSettings.set"](input, thrownContext()))
  // A model row's time rounds against opencode.json's interval for it (3m30s).
  expect((await set({ providerID: "anthropic", modelID: "claude", warming: "30m" })).record).toMatchObject({ warming: "31m30s" })
  expect((await set({ warming: "30m", interval: "4m" })).record).toMatchObject({ warming: "32m", interval: "4m" })
  // A later interval re-rounds the row's own time.
  expect((await set({ interval: "5m" })).record).toMatchObject({ warming: "35m", interval: "5m" })
  // Control: a whole time is stored as typed.
  expect((await set({ providerID: "anthropic", modelID: "claude", warming: "35m", interval: "5m" })).record).toMatchObject({ warming: "35m" })
})

test("a Defaults › Models row opens into one field row per field", async () => {
  const key = { providerID: "bedrock", modelID: "anthropic.claude-v2:0" }
  expect(modelSettingItemId(key, "interval")).toBe("modelsetting:interval:bedrock/anthropic.claude-v2:0")
  expect(parseModelSettingItemId("modelsetting:interval:bedrock/anthropic.claude-v2:0")).toEqual({ key, field: "interval" })
  expect(parseModelSettingItemId("modelsetting:warming:*")).toEqual({ key: {}, field: "warming" })
  expect(parseModelSettingItemId("modelsetting:colour:*")).toBeUndefined()
  expect(parseModelSettingItemId("modeldefault:*")).toBeUndefined()
  expect(isModelSettingRowId(modelSettingRowId(key, "prompt"))).toBe(true)
  expect(isModelDefaultRowId(modelSettingRowId(key, "prompt"))).toBe(false)
  expect(modelSettingParentRowId(modelSettingRowId(key, "prompt"))).toBe(modelDefaultRowId(key))

  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude", { variants: ["low", "high"] })],
    classifications: { "": "general", claude: "general" },
  })
  const api = createPlusApi(ctx, createState())
  await api.setModelSettings({ warming: "30m", interval: "4m" })
  const rows = expandedTree(memoInputOf((await api.snapshot()).value))
  const find = (id: string) => rows.find((row) => row.id === id)
  // The Defaults row has no Model field: Effort, the Warming group and the
  // Compaction group.
  expect(find("item:defaults:/models:modeldefault:*")?.label).toBe("Every model")
  expect(find("item:defaults:/models:modelsetting:effort:*")?.depth).toBe(3)
  expect(find("group:defaults:/models:modeldefault:*:warming")?.label).toBe("Warming")
  expect(find("group:defaults:/models:modeldefault:*:compaction")?.label).toBe("Compaction")
  const warmingField = (field: string) => find(`item:defaults:/models:modelsetting:${field}:*`)
  expect([warmingField("warming")?.depth, warmingField("warming")?.badges.value]).toEqual([4, "32m"])
  expect([warmingField("interval")?.depth, warmingField("interval")?.badges.value]).toEqual([4, "4m"])
  expect(warmingField("prompt")?.badges.value).toBe(`${BUILT_IN_WARMING.prompt.slice(0, 23)}… · built-in`)
  expect([warmingField("compactWarm")?.depth, warmingField("compactWarm")?.badges.value]).toEqual([4, "off · built-in"])
  expect(find("group:defaults:/models:modeldefault:*:cold")?.badges.value).toBe("none · a adds one")
  expect([warmingField("warming")?.actions, warmingField("interval")?.actions]).toEqual([
    { toggle: false, edit: true, reset: true, remove: false, split: false, pin: false },
    { toggle: false, edit: true, reset: true, remove: false, split: false, pin: false },
  ])
  expect(warmingField("warming")?.badges.modified).toBe(true)
  expect(warmingField("prompt")?.badges.modified).toBeUndefined()
  // The model row inherits every field and says where from.
  expect(find("group:defaults:/models:modeldefault:anthropic/claude:warming")?.badges.value).toBe("32m · every 4m")
  const view = modelDefaultView({ record: record({ warming: "on" }), every: record({ interval: "4m" }) })
  expect(modelSettingValue(view, "warming", record({ warming: "on" }))).toBe("on · 32m")
})

test("instructions tools set, reset and show one Defaults › Models field", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude")],
    classifications: { "": "general", claude: "general" },
  })
  await registerInstructionTools(ctx, createPlusApi(ctx, createState()))
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const show = need(tools, "instructions_show")
  const reset = need(tools, "instructions_reset")
  const del = need(tools, "instructions_delete")
  await runOk(set, { id: "item:defaults:/models:modelsetting:interval:*", text: "4m" })
  await runOk(set, { id: "item:defaults:/models:modelsetting:warming:*", text: "30m" })
  expect((await load(project)).records.find((entry) => entry.type === "modelSettings")).toMatchObject({ warming: "32m", interval: "4m" })
  const shown = (await runOk(show, { id: "item:defaults:/models:modelsetting:warming:*" })) as { field: string; value: unknown }
  expect(shown).toMatchObject({ field: "warming", value: { text: "32m", from: "model" } })
  expect((await runFail(set, { id: "item:defaults:/models:modelsetting:interval:*", state: "on" })).message).toContain("takes text")
  expect((await runFail(del, { id: "item:defaults:/models:modelsetting:interval:*", confirm: true })).message).toContain("reset clears it")
  // reset clears only that field.
  await runOk(reset, { id: "item:defaults:/models:modelsetting:interval:*" })
  const after = (await load(project)).records.find((entry) => entry.type === "modelSettings")
  expect(after).toMatchObject({ warming: "32m" })
  expect(after).not.toHaveProperty("interval")
})

test("an agent's model row opens into field rows and one field edits and resets through the tool", async () => {
  const project = await tempProject()
  const buildPath = path.join(project, ".opencode", "agent", "build.md")
  await fs.mkdir(path.dirname(buildPath), { recursive: true })
  await Bun.write(buildPath, "build body\n")
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude", { variants: ["low", "high"] })],
    classifications: { "": "general", claude: "general" },
  })
  const api = createPlusApi(ctx, createState())
  const rows = expandedTree(memoInputOf((await api.snapshot()).value))
  const at = rows.findIndex((row) => row.id === "item:project:build:model:anthropic/claude")
  expect(at).toBeGreaterThanOrEqual(0)
  const fields = rows.filter((row) => row.id.startsWith("item:project:build:modelfield:"))
  // Compaction holds the early token thresholds: the only place they are set.
  expect(fields.map((row) => row.label)).toEqual([
    "Model", "Effort", "Warming", "Ping every", "Keep-alive prompt",
    "Compact before cold", "Strategy", "Input token threshold", "Output token threshold", "Model", "Instructions",
    "Convert large image", "Shrink large image", "When image context is full",
  ])
  // The row is inherited (the agent's upstream model), so Model and Warming
  // name where they came from; none of the fields is local yet.
  expect(fields[0]?.badges.value).toBe("anthropic/claude · upstream")
  expect(fields[2]?.badges.value).toBe("off · built-in")
  expect(fields.filter((row) => row.address?.item !== "modelfield:compactWarm:anthropic/claude").every((row) => row.actions?.edit === true && row.actions?.reset === false)).toBe(true)
  const target = { providerID: "anthropic", modelID: "claude" }
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1]) => `item:project:build:${modelFieldItemId(target, field)}`

  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  // set on the Warming field plants a project record for the candidate and
  // writes only that field.
  await runOk(set, { id: fieldRow("warming"), text: "30m" })
  const stored = (await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build")
  expect(stored).toMatchObject({ providerID: "anthropic", modelID: "claude", warming: "30m" })
  // reset clears that field at this level again.
  await runOk(reset, { id: fieldRow("warming") })
  const after = (await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build")
  expect(after).not.toHaveProperty("warming")
  // An Images field takes its value in a person's words, refuses one it cannot hold, and resets the same way.
  await runOk(set, { id: fieldRow("imageShrink"), text: "2,576 px" })
  expect((await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build")).toMatchObject({ imageShrink: "2576" })
  expect((await runFail(set, { id: fieldRow("imagesFull"), text: "delete" })).message).toContain("When image context is full")
  await runOk(set, { id: fieldRow("imagesFull"), text: "error" })
  expect((await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build")).toMatchObject({ imagesFull: "error" })
  await runOk(reset, { id: fieldRow("imageShrink") })
  await runOk(reset, { id: fieldRow("imagesFull") })
  const cleared = (await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build")
  expect(cleared).not.toHaveProperty("imageShrink")
  expect(cleared).not.toHaveProperty("imagesFull")
  // The Model field resets the whole local candidate override: the inherited
  // candidate resumes and the unrelated keep-alive fields are preserved.
  // First plant a local candidate with warming, then reset its Model field.
  await runOk(set, { id: fieldRow("warming"), text: "30m" })
  await runOk(set, { id: fieldRow("model"), text: "anthropic/claude#high" })
  expect((await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build" && entry.removed !== true)).toMatchObject({
    providerID: "anthropic",
    modelID: "claude",
    variant: "high",
    warming: "30m",
  })
  const resetModel = (await runOk(reset, { id: `item:project:build:${modelFieldItemId({ providerID: "anthropic", modelID: "claude", variant: "high" }, "model")}` })) as { status: string }
  expect(resetModel.status).toContain("anthropic/claude")
  const restored = (await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build" && entry.removed !== true)
  // The inherited upstream candidate is back (no variant), its unrelated
  // warming preserved, and no tombstone is left behind.
  expect(restored).toMatchObject({ providerID: "anthropic", modelID: "claude", warming: "30m" })
  expect(restored).not.toHaveProperty("variant")
  expect((await load(project)).records.filter((entry) => entry.type === "model" && entry.removed === true)).toHaveLength(0)
  // Editing Effort changes that one row's candidate in place: the old
  // candidate is hidden at this level (not left beside the new one) and the
  // row's warming and active state carry over.
  await runOk(set, { id: fieldRow("effort"), text: "high" })
  const highRows = expandedTree(memoInputOf((await api.snapshot()).value))
  expect(highRows.some((row) => row.id === "item:project:build:model:anthropic/claude@high")).toBe(true)
  expect(highRows.some((row) => row.id === "item:project:build:model:anthropic/claude")).toBe(false)
  expect((await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build" && entry.removed !== true)).toMatchObject({
    providerID: "anthropic",
    modelID: "claude",
    variant: "high",
    warming: "30m",
    active: true,
  })
  // r on Effort clears the variant on that same row; warming stays.
  const highEffort = `item:project:build:${modelFieldItemId({ providerID: "anthropic", modelID: "claude", variant: "high" }, "effort")}`
  await runOk(reset, { id: highEffort })
  const plain = (await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build" && entry.removed !== true)
  expect(plain).not.toHaveProperty("variant")
  expect(plain).toMatchObject({ warming: "30m" })
  // Compaction › Input token threshold writes the agent's model row; r inherits again.
  await runOk(set, { id: fieldRow("compactionInput"), text: "120000" })
  expect((await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build" && entry.removed !== true)).toMatchObject({
    compactionInput: "120000",
    warming: "30m",
  })
  await runOk(reset, { id: fieldRow("compactionInput") })
  expect((await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build" && entry.removed !== true)).not.toHaveProperty("compactionInput")
})

// T7 issue #6: every field edits and resets individually at the real tool
// boundary, and a reset clears only its own field. Model reset restores the
// inherited candidate with the row's unrelated fields preserved; Effort
// reset drops the variant; the warming fields clear and inherit again.
test("every model field edits and resets individually and resets preserve unrelated fields", async () => {
  const project = await tempProject()
  const buildPath = path.join(project, ".opencode", "agent", "build.md")
  await fs.mkdir(path.dirname(buildPath), { recursive: true })
  await Bun.write(buildPath, "build body\n")
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude", { variants: ["low", "high"] })],
    classifications: { "": "general", claude: "general" },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const target = { providerID: "anthropic", modelID: "claude" }
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t = target) => `item:project:build:${modelFieldItemId(t, field)}`
  const local = async () => (await load(project)).records.find((entry) => entry.type === "model" && entry.agent === "build" && entry.removed !== true)

  // Each warming field edits and resets on its own, preserving the others.
  await runOk(set, { id: fieldRow("warming"), text: "30m" })
  await runOk(set, { id: fieldRow("interval"), text: "4m" })
  await runOk(set, { id: fieldRow("prompt"), text: "keep alive" })
  expect(await local()).toMatchObject({ warming: "30m", interval: "4m", prompt: "keep alive" })
  await runOk(reset, { id: fieldRow("interval") })
  expect(await local()).toMatchObject({ warming: "30m", prompt: "keep alive" })
  expect(await local()).not.toHaveProperty("interval")
  await runOk(reset, { id: fieldRow("prompt") })
  expect(await local()).toMatchObject({ warming: "30m" })
  expect(await local()).not.toHaveProperty("prompt")

  // Effort edits and resets its variant on the same row; warming stays.
  await runOk(set, { id: fieldRow("effort"), text: "high" })
  const high = { providerID: "anthropic", modelID: "claude", variant: "high" }
  expect(await local()).toMatchObject({ variant: "high", warming: "30m" })
  await runOk(reset, { id: fieldRow("effort", high) })
  expect(await local()).not.toHaveProperty("variant")
  expect(await local()).toMatchObject({ warming: "30m" })

  // Model reset restores the inherited upstream candidate and preserves the
  // unrelated warming; no tombstone is left behind.
  await runOk(set, { id: fieldRow("model"), text: "anthropic/claude#high" })
  expect(await local()).toMatchObject({ variant: "high", warming: "30m" })
  await runOk(reset, { id: fieldRow("model", high) })
  const restored = await local()
  expect(restored).toMatchObject({ providerID: "anthropic", modelID: "claude", warming: "30m" })
  expect(restored).not.toHaveProperty("variant")
  expect((await load(project)).records.filter((entry) => entry.type === "model" && entry.removed === true)).toHaveLength(0)

  // The last reset clears the warming field so it reads inherited again. The
  // restored candidate stays local (the Model field still has an override);
  // warming, interval and prompt read inherited.
  await runOk(reset, { id: fieldRow("warming") })
  expect(await local()).not.toHaveProperty("warming")
  const rows = expandedTree(memoInputOf((await api.snapshot()).value))
  const fields = rows.filter((row) => row.id.startsWith("item:project:build:modelfield:"))
  const byLabel = new Map(fields.map((row) => [row.label, row]))
  expect(byLabel.get("Warming")?.actions?.reset).toBe(false)
  expect(byLabel.get("Ping every")?.actions?.reset).toBe(false)
  expect(byLabel.get("Keep-alive prompt")?.actions?.reset).toBe(false)
  expect(byLabel.get("Warming")?.badges.value).toBe("off · built-in")
  // A repeated Model FIELD reset is a no-op and must refuse with no write:
  // only the model ROW's r clears activation, never a FIELD reset. The local
  // bare candidate stays (its Model field already matches the original).
  const revBeforeRepeat = (await load(project)).projectRevision
  const recordsBeforeRepeat = (await load(project)).records
  const err = await runFail(reset, { id: fieldRow("model") })
  expect(err.message).toContain("has no override to reset")
  expect((await load(project)).projectRevision).toBe(revBeforeRepeat)
  expect((await load(project)).records).toEqual(recordsBeforeRepeat)
  expect(await local()).toMatchObject({ providerID: "anthropic", modelID: "claude" })
})
// T7 issue #6: reset restores the candidate a *Global* record inherited at
// Project replaced, preserving the row's own warming.
test("Model reset at Project restores the inherited Global candidate", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude"), modelWith("openai", "gpt-5")],
    classifications: { "": "general", claude: "general", "gpt-5": "general" },
  })
  const api = createPlusApi(ctx, createState())
  // A Global active record for a different model is what the Project chain
  // resolves; the agent's upstream model stays anthropic/claude.
  const globalActive: ModelRecord = {
    type: "model",
    level: "global",
    agent: "build",
    providerID: "openai",
    modelID: "gpt-5",
    warming: "45m",
    active: true,
    updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, { expectedProjectRevision: stored.projectRevision, expectedGlobalRevision: stored.globalRevision, records: [...stored.records, globalActive] })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const inherited = { providerID: "openai", modelID: "gpt-5" }
  const edited = { providerID: "anthropic", modelID: "claude" }
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string }) => `item:project:build:${modelFieldItemId(t, field)}`
  // Edit Project's Model field to the other model and give it warming.
  await runOk(set, { id: fieldRow("model", inherited), text: "anthropic/claude" })
  await runOk(set, { id: fieldRow("warming", edited), text: "10m" })
  expect((await load(project)).records.find(
    (entry) => entry.type === "model" && entry.level === "project" && entry.agent === "build" && entry.removed !== true,
  )).toMatchObject({ providerID: "anthropic", modelID: "claude", warming: "10m" })
  // Reset the Model field: the inherited Global candidate returns at Project
  // with the row's unrelated warming preserved; Global is untouched.
  await runOk(reset, { id: fieldRow("model", edited) })
  const project2 = (await load(project)).records.find(
    (entry) => entry.type === "model" && entry.level === "project" && entry.agent === "build" && entry.removed !== true,
  )
  expect(project2).toMatchObject({ providerID: "openai", modelID: "gpt-5", warming: "10m" })
  expect(project2).not.toHaveProperty("variant")
  const globalStill = (await load(project)).records.find(
    (entry) => entry.type === "model" && entry.level === "global" && entry.agent === "build" && entry.removed !== true,
  )
  expect(globalStill).toMatchObject({ providerID: "openai", modelID: "gpt-5", warming: "45m", active: true })
})

test("Model reset of inherited inactive candidate restores that candidate and leaves upstream active candidate active", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude"),
      modelWith("openai", "gpt-5", { variants: ["high", "low"] }),
      modelWith("google", "gemini", { variants: ["high", "low"] }),
    ],
    classifications: { "": "general", claude: "general", "gpt-5": "general", gemini: "general" },
  })
  const api = createPlusApi(ctx, createState())
  // Global has active candidate A (anthropic/claude) and inactive candidate B (openai/gpt-5@high).
  const globalActive: ModelRecord = {
    type: "model",
    level: "global",
    agent: "build",
    providerID: "anthropic",
    modelID: "claude",
    active: true,
    updated: UPDATED,
  }
  const globalInactive: ModelRecord = {
    type: "model",
    level: "global",
    agent: "build",
    providerID: "openai",
    modelID: "gpt-5",
    variant: "high",
    updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, globalActive, globalInactive],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const candidateB = { providerID: "openai", modelID: "gpt-5", variant: "high" }
  const candidateC = { providerID: "google", modelID: "gemini", variant: "high" }
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string; variant?: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`

  // Edit Candidate B's Model field to C (google/gemini).
  await runOk(set, { id: fieldRow("model", candidateB), text: "google/gemini" })

  // Verify Project level has exactly one visible edited row for C, plus tombstone for B.
  const recordsAfterEdit = (await load(project)).records
  const projectRecords = recordsAfterEdit.filter((r): r is ModelRecord => r.type === "model" && r.level === "project" && r.agent === "build")
  const visibleC = projectRecords.find((r) => r.removed !== true)
  expect(visibleC).toMatchObject({
    providerID: "google",
    modelID: "gemini",
    variant: "high",
    originalCandidate: { providerID: "openai", modelID: "gpt-5", variant: "high", source: "global" },
  })
  expect(visibleC?.active).toBeUndefined()
  const tombstoneB = projectRecords.find((r) => r.removed === true)
  expect(tombstoneB).toMatchObject({ providerID: "openai", modelID: "gpt-5", variant: "high", removed: true })

  // Verify Global candidate A is still active in the snapshot!
  const snap1 = memoInputOf((await api.snapshot()).value)
  const rows1 = expandedTree(snap1)
  const modelRows1 = rows1.filter((r) => r.id.startsWith("item:project:build:model:") && r.address?.item.startsWith("model:") === true)
  expect(modelRows1.map((r) => r.label)).toEqual(["anthropic/claude", "google/gemini@high"])
  const activeRow1 = modelRows1.find((r) => r.badges.active === true)
  expect(activeRow1?.label).toBe("anthropic/claude")

  // Reset the Model field on C: must restore B (openai/gpt-5@high), NOT upstream active A!
  await runOk(reset, { id: fieldRow("model", candidateC) })

  // Verify B is restored, tombstone for B is gone, C is gone.
  const recordsAfterReset = (await load(project)).records
  const projectRecordsAfterReset = recordsAfterReset.filter((r): r is ModelRecord => r.type === "model" && r.level === "project" && r.agent === "build")
  expect(projectRecordsAfterReset).toHaveLength(0)

  // Verify tree rows: B is back, and A remains active!
  const snap2 = memoInputOf((await api.snapshot()).value)
  const rows2 = expandedTree(snap2)
  const modelRows2 = rows2.filter((r) => r.id.startsWith("item:project:build:model:") && r.address?.item.startsWith("model:") === true)
  expect(modelRows2.map((r) => r.label)).toEqual(["anthropic/claude", "openai/gpt-5@high"])
  const activeRow2 = modelRows2.find((r) => r.badges.active === true)
  expect(activeRow2?.label).toBe("anthropic/claude")

  // Attempt repeat reset on B's Model field: must refuse with no revision write!
  const revBeforeRepeat = (await load(project)).projectRevision
  const err = await runFail(reset, { id: fieldRow("model", candidateB) })
  expect(err.message).toContain("has no override to reset")
  const revAfterRepeat = (await load(project)).projectRevision
  expect(revAfterRepeat).toBe(revBeforeRepeat)
})

test("Effort reset restores original inherited variant from low to high instead of no-variant", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude"),
      modelWith("openai", "gpt-5", { variants: ["high", "low"] }),
    ],
    classifications: { "": "general", claude: "general", "gpt-5": "general" },
  })
  const api = createPlusApi(ctx, createState())
  // Global has active candidate A and inactive candidate B@high.
  const globalActive: ModelRecord = {
    type: "model",
    level: "global",
    agent: "build",
    providerID: "anthropic",
    modelID: "claude",
    active: true,
    updated: UPDATED,
  }
  const globalInactive: ModelRecord = {
    type: "model",
    level: "global",
    agent: "build",
    providerID: "openai",
    modelID: "gpt-5",
    variant: "high",
    updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, globalActive, globalInactive],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string; variant?: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`

  // Edit Effort on B@high to low.
  await runOk(set, { id: fieldRow("effort", { providerID: "openai", modelID: "gpt-5", variant: "high" }), text: "low" })

  const editedRecord = (await load(project)).records.find(
    (r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true,
  )
  expect(editedRecord).toMatchObject({
    providerID: "openai",
    modelID: "gpt-5",
    variant: "low",
    originalCandidate: { providerID: "openai", modelID: "gpt-5", variant: "high", source: "global" },
  })

  // Reset Effort on B@low: must restore "high", NOT no-variant!
  await runOk(reset, { id: fieldRow("effort", { providerID: "openai", modelID: "gpt-5", variant: "low" }) })

  // Verify tree shows B@high restored
  const snap = memoInputOf((await api.snapshot()).value)
  const rows = expandedTree(snap)
  const effortRow = rows.find((r) => r.id === fieldRow("effort", { providerID: "openai", modelID: "gpt-5", variant: "high" }))
  expect(effortRow?.badges.value).toBe("high · global")
  expect(effortRow?.actions?.reset).toBe(false)

  // Repeat reset on Effort: must refuse with no revision write!
  const revBeforeRepeat = (await load(project)).projectRevision
  const err = await runFail(reset, { id: fieldRow("effort", { providerID: "openai", modelID: "gpt-5", variant: "high" }) })
  expect(err.message).toContain("has no override to reset")
  const revAfterRepeat = (await load(project)).projectRevision
  expect(revAfterRepeat).toBe(revBeforeRepeat)
})

test("Independent Model and Effort edits support independent reset, warming preservation, and repeated edits B->C->D", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude", { variants: ["high", "low"] }),
      modelWith("openai", "gpt-5", { variants: ["high", "low"] }),
      modelWith("google", "gemini", { variants: ["high", "low"] }),
    ],
    classifications: { "": "general", claude: "general", "gpt-5": "general", gemini: "general" },
  })
  const api = createPlusApi(ctx, createState())
  // Global has inactive candidate B@high.
  const globalB: ModelRecord = {
    type: "model",
    level: "global",
    agent: "build",
    providerID: "openai",
    modelID: "gpt-5",
    variant: "high",
    updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, globalB],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string; variant?: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`

  // Edit B@high: Model to C (anthropic/claude), Effort to low, warming to 25m, active to true.
  await runOk(set, { id: fieldRow("model", { providerID: "openai", modelID: "gpt-5", variant: "high" }), text: "anthropic/claude" })
  await runOk(set, { id: fieldRow("effort", { providerID: "anthropic", modelID: "claude", variant: "high" }), text: "low" })
  await runOk(set, { id: fieldRow("warming", { providerID: "anthropic", modelID: "claude", variant: "low" }), text: "25m" })
  await runOk(set, { id: `item:project:build:model:anthropic/claude@low`, active: true })

  const cLow = (await load(project)).records.find(
    (r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true,
  )
  expect(cLow).toMatchObject({
    providerID: "anthropic",
    modelID: "claude",
    variant: "low",
    warming: "25m",
    active: true,
    originalCandidate: { providerID: "openai", modelID: "gpt-5", variant: "high", source: "global" },
  })

  // Part 3A: Reset Model restores B + compatible local low, preserving warming and active intent.
  await runOk(reset, { id: fieldRow("model", { providerID: "anthropic", modelID: "claude", variant: "low" }) })
  const bLow = (await load(project)).records.find(
    (r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true,
  )
  expect(bLow).toMatchObject({
    providerID: "openai",
    modelID: "gpt-5",
    variant: "low",
    warming: "25m",
    active: true,
  })

  // Repeat reset on Model: refuses with no writes.
  const revBeforeRepeatModel = (await load(project)).projectRevision
  const errModel = await runFail(reset, { id: fieldRow("model", { providerID: "openai", modelID: "gpt-5", variant: "low" }) })
  expect(errModel.message).toContain("has no override to reset")
  expect((await load(project)).projectRevision).toBe(revBeforeRepeatModel)

  // Reset Effort on B@low: restores original high variant, preserving warming.
  await runOk(reset, { id: fieldRow("effort", { providerID: "openai", modelID: "gpt-5", variant: "low" }) })
  const bHigh = (await load(project)).records.find(
    (r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true,
  )
  expect(bHigh).toMatchObject({
    providerID: "openai",
    modelID: "gpt-5",
    variant: "high",
    warming: "25m",
    active: true,
  })

  // Repeat reset on Effort: refuses with no writes.
  const revBeforeRepeatEffort = (await load(project)).projectRevision
  const errEffort = await runFail(reset, { id: fieldRow("effort", { providerID: "openai", modelID: "gpt-5", variant: "high" }) })
  expect(errEffort.message).toContain("has no override to reset")
  expect((await load(project)).projectRevision).toBe(revBeforeRepeatEffort)

  // Part 3B: Reset Effort first: keeps Model C and restores Effort high.
  await runOk(set, { id: fieldRow("model", { providerID: "openai", modelID: "gpt-5", variant: "high" }), text: "anthropic/claude" })
  await runOk(set, { id: fieldRow("effort", { providerID: "anthropic", modelID: "claude", variant: "high" }), text: "low" })
  await runOk(reset, { id: fieldRow("effort", { providerID: "anthropic", modelID: "claude", variant: "low" }) })
  const cHigh = (await load(project)).records.find(
    (r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true,
  )
  expect(cHigh).toMatchObject({
    providerID: "anthropic",
    modelID: "claude",
    variant: "high",
  })
  const revBeforeRepeatEffortFirst = (await load(project)).projectRevision
  const errEffortFirst = await runFail(reset, { id: fieldRow("effort", { providerID: "anthropic", modelID: "claude", variant: "high" }) })
  expect(errEffortFirst.message).toContain("has no override to reset")
  expect((await load(project)).projectRevision).toBe(revBeforeRepeatEffortFirst)

  // Reset Model: restores Model B@high!
  await runOk(reset, { id: fieldRow("model", { providerID: "anthropic", modelID: "claude", variant: "high" }) })
  const bRestored = (await load(project)).records.find(
    (r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true,
  )
  expect(bRestored).toMatchObject({
    providerID: "openai",
    modelID: "gpt-5",
    variant: "high",
  })

  // Part 3C: Repeated edits B -> C -> D: reset restores B!
  await runOk(set, { id: fieldRow("model", { providerID: "openai", modelID: "gpt-5", variant: "high" }), text: "anthropic/claude" })
  await runOk(set, { id: fieldRow("model", { providerID: "anthropic", modelID: "claude", variant: "high" }), text: "google/gemini" })

  const dRecord = (await load(project)).records.find(
    (r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true,
  )
  expect(dRecord).toMatchObject({
    providerID: "google",
    modelID: "gemini",
    originalCandidate: { providerID: "openai", modelID: "gpt-5", variant: "high", source: "global" },
  })

  // Reset Model on D restores B!
  await runOk(reset, { id: fieldRow("model", { providerID: "google", modelID: "gemini", variant: "high" }) })
  const restoredFromD = (await load(project)).records.find(
    (r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true,
  )
  expect(restoredFromD).toMatchObject({
    providerID: "openai",
    modelID: "gpt-5",
    variant: "high",
  })
})

test("no-warming control: B@high->C->effort low->activate->reset Model->B@low active->repeat refuses->reset Effort->B@high", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude", { variants: ["high", "low"] }),
      modelWith("openai", "gpt-5", { variants: ["high", "low"] }),
    ],
    classifications: { "": "general", claude: "general", "gpt-5": "general" },
  })
  const api = createPlusApi(ctx, createState())
  // Global has inactive candidate B@high, no warming anywhere.
  const globalB: ModelRecord = {
    type: "model",
    level: "global",
    agent: "build",
    providerID: "openai",
    modelID: "gpt-5",
    variant: "high",
    updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, globalB],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string; variant?: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`
  const local = async () =>
    (await load(project)).records.find((r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true)

  // B@high -> Model C, Effort low, then activate C@low (no warming set).
  await runOk(set, { id: fieldRow("model", { providerID: "openai", modelID: "gpt-5", variant: "high" }), text: "anthropic/claude" })
  await runOk(set, { id: fieldRow("effort", { providerID: "anthropic", modelID: "claude", variant: "high" }), text: "low" })
  await runOk(set, { id: "item:project:build:model:anthropic/claude@low", active: true })
  const cLow = await local()
  expect(cLow).toMatchObject({ providerID: "anthropic", modelID: "claude", variant: "low", active: true })
  expect(cLow).not.toHaveProperty("warming")

  // Reset Model: B@low active (the locally-edited effort survives), no warming.
  const beforeReset = await load(project)
  await runOk(reset, { id: fieldRow("model", { providerID: "anthropic", modelID: "claude", variant: "low" }) })
  const bLow = await local()
  expect(bLow).toMatchObject({ providerID: "openai", modelID: "gpt-5", variant: "low", active: true })
  expect(bLow).not.toHaveProperty("warming")

  // Repeat reset refuses with identical records and revision.
  const recordsNow = (await load(project)).records
  const revNow = (await load(project)).projectRevision
  const refused = await runFail(reset, { id: fieldRow("model", { providerID: "openai", modelID: "gpt-5", variant: "low" }) })
  expect(refused.message).toContain("has no override to reset")
  expect((await load(project)).records).toEqual(recordsNow)
  expect((await load(project)).projectRevision).toBe(revNow)

  // Reset Effort: B@high, active kept.
  await runOk(reset, { id: fieldRow("effort", { providerID: "openai", modelID: "gpt-5", variant: "low" }) })
  const bHigh = await local()
  expect(bHigh).toMatchObject({ providerID: "openai", modelID: "gpt-5", variant: "high", active: true })
  expect(bHigh).not.toHaveProperty("warming")
  // The active model in the snapshot is B@high.
  const rows = expandedTree(memoInputOf((await api.snapshot()).value)).filter((r) => r.id.startsWith("item:project:build:model:") && r.address?.item.startsWith("model:") === true)
  expect(rows.find((r) => r.badges.active === true)?.label).toBe("openai/gpt-5@high")
  void beforeReset
})

test("Effort reset of an inherited-original row removes its tombstone and leaves no stale hidden row", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("cliproxyapi", "claude-opus-5-5"))],
    models: [modelWith("cliproxyapi", "claude-opus-5-5", { variants: ["high", "low", "xhigh"] })],
    classifications: { "": "general", "claude-opus-5-5": "general" },
  })
  const api = createPlusApi(ctx, createState())
  // Defaults carries xhigh for build, Global has active high.
  const defaultsRow: ModelRecord = {
    type: "model", level: "defaults", agent: "build",
    providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "xhigh", updated: UPDATED,
  }
  const globalActive: ModelRecord = {
    type: "model", level: "global", agent: "build",
    providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "high", active: true, updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, defaultsRow, globalActive],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string; variant?: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`
  const projectRecords = async () =>
    (await load(project)).records.filter((r): r is ModelRecord => r.type === "model" && r.level === "project" && r.agent === "build")

  // Edit Effort on the defaults-derived candidate xhigh to low.
  await runOk(set, { id: fieldRow("effort", { providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "xhigh" }), text: "low" })
  expect(await projectRecords()).toHaveLength(2) // low live + xhigh tombstone
  expect((await projectRecords()).find((r) => r.removed !== true)).toMatchObject({ variant: "low", originalCandidate: { variant: "xhigh", source: "defaults", editedFields: ["effort"] } })

  // Reset Effort on low: restores xhigh and must not leave the tombstone behind.
  await runOk(reset, { id: fieldRow("effort", { providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "low" }) })
  expect(await projectRecords()).toHaveLength(0)
  const shown = await runOk(need(tools, "instructions_show"), { id: fieldRow("effort", { providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "xhigh" }) }) as { value?: unknown }
  expect(shown).toMatchObject({ value: "xhigh · defaults" })
})

test("Effort reset over a pre-existing other-variant tombstone restores the original cleanly", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("cliproxyapi", "claude-opus-5-5"))],
    models: [modelWith("cliproxyapi", "claude-opus-5-5", { variants: ["high", "low", "xhigh"] })],
    classifications: { "": "general", "claude-opus-5-5": "general" },
  })
  const api = createPlusApi(ctx, createState())
  const defaultsRow: ModelRecord = {
    type: "model", level: "defaults", agent: "build",
    providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "xhigh", updated: UPDATED,
  }
  const globalActive: ModelRecord = {
    type: "model", level: "global", agent: "build",
    providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "high", active: true, updated: UPDATED,
  }
  // A pre-existing tombstone hiding the Global "high" candidate at Project.
  const highTombstone: ModelRecord = {
    type: "model", level: "project", agent: "build",
    providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "high", removed: true, updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, defaultsRow, globalActive, highTombstone],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string; variant?: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`
  const projectRecords = async () =>
    (await load(project)).records.filter((r): r is ModelRecord => r.type === "model" && r.level === "project" && r.agent === "build")

  await runOk(set, { id: fieldRow("effort", { providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "xhigh" }), text: "low" })
  expect(await projectRecords()).toHaveLength(3) // low live + xhigh tombstone + pre-existing high tombstone

  await runOk(reset, { id: fieldRow("effort", { providerID: "cliproxyapi", modelID: "claude-opus-5-5", variant: "low" }) })
  const after = await projectRecords()
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ variant: "high", removed: true })
})

test("Model reset restores a local-only original that never existed above", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude"),
      modelWith("openai", "gpt-5", { variants: ["high", "low"] }),
      modelWith("google", "gemini", { variants: ["high", "low"] }),
    ],
    classifications: { "": "general", claude: "general", "gpt-5": "general", gemini: "general" },
  })
  const api = createPlusApi(ctx, createState())
  // Global has active candidate A (anthropic/claude). Candidate B (openai/gpt-5@high)
  // exists only as a local Project row, so it is *not* in the chain above.
  const globalActive: ModelRecord = {
    type: "model",
    level: "global",
    agent: "build",
    providerID: "anthropic",
    modelID: "claude",
    active: true,
    updated: UPDATED,
  }
  const localB: ModelRecord = {
    type: "model",
    level: "project",
    agent: "build",
    providerID: "openai",
    modelID: "gpt-5",
    variant: "high",
    updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, globalActive, localB],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const candidateB = { providerID: "openai", modelID: "gpt-5", variant: "high" }
  const candidateC = { providerID: "google", modelID: "gemini", variant: "high" }
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string; variant?: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`
  const projectLocal = async () =>
    (await load(project)).records.find((r) => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true)

  // Edit B's Model field to C. B is captured as the original even though it
  // never existed above, and B's tombstone hides it at this level.
  await runOk(set, { id: fieldRow("model", candidateB), text: "google/gemini" })
  expect(await projectLocal()).toMatchObject({
    providerID: "google",
    modelID: "gemini",
    variant: "high",
    originalCandidate: { providerID: "openai", modelID: "gpt-5", variant: "high", source: "project" },
  })

  // Reset restores the local-only B, not the active A above.
  await runOk(reset, { id: fieldRow("model", candidateC) })
  expect(await projectLocal()).toMatchObject({ providerID: "openai", modelID: "gpt-5", variant: "high" })
  expect(await projectLocal()).not.toHaveProperty("originalCandidate")
  const modelRows = expandedTree(memoInputOf((await api.snapshot()).value)).filter((r) => r.id.startsWith("item:project:build:model:") && r.address?.item.startsWith("model:") === true)
  expect(modelRows.map((r) => r.label)).toEqual(["anthropic/claude", "openai/gpt-5@high"])
  expect(modelRows.find((r) => r.badges.active === true)?.label).toBe("anthropic/claude")
})

test("inherited inactive B beside active A: edit Model and Warming, reset both, repeat Model FIELD refuses no-write", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude", { variants: ["high", "low"] }),
      modelWith("openai", "gpt-5", { variants: ["high", "low"] }),
      modelWith("google", "gemini", { variants: ["high", "low"] }),
    ],
    classifications: { "": "general", claude: "general", "gpt-5": "general", gemini: "general" },
  })
  const api = createPlusApi(ctx, createState())
  // Global: active A (anthropic/claude) and inactive B (openai/gpt-5).
  const globalActive: ModelRecord = {
    type: "model", level: "global", agent: "build",
    providerID: "anthropic", modelID: "claude", active: true, updated: UPDATED,
  }
  const globalInactiveB: ModelRecord = {
    type: "model", level: "global", agent: "build",
    providerID: "openai", modelID: "gpt-5", updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, globalActive, globalInactiveB],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string; variant?: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`
  const projectRecords = async () =>
    (await load(project)).records.filter((r): r is ModelRecord => r.type === "model" && r.level === "project" && r.agent === "build")

  // Edit B's Model field to C and give C warming.
  await runOk(set, { id: fieldRow("model", { providerID: "openai", modelID: "gpt-5" }), text: "google/gemini" })
  await runOk(set, { id: fieldRow("warming", { providerID: "google", modelID: "gemini" }), text: "45m" })
  expect((await projectRecords()).find((r) => r.removed !== true)).toMatchObject({
    providerID: "google", modelID: "gemini", warming: "45m",
    originalCandidate: { providerID: "openai", modelID: "gpt-5", source: "global", editedFields: ["model"] },
  })

  // Reset Model: restores the inherited B (unrelated warming preserved).
  await runOk(reset, { id: fieldRow("model", { providerID: "google", modelID: "gemini" }) })
  expect((await projectRecords()).find((r) => r.removed !== true)).toMatchObject({ providerID: "openai", modelID: "gpt-5", warming: "45m" })

  // Reset the surviving Warming field: the row is now a bare local record.
  await runOk(reset, { id: fieldRow("warming", { providerID: "openai", modelID: "gpt-5" }) })
  const bare = (await projectRecords()).find((r) => r.removed !== true)
  expect(bare).toMatchObject({ providerID: "openai", modelID: "gpt-5" })
  expect(bare).not.toHaveProperty("warming")

  // A repeated Model FIELD reset must refuse with byte-identical records and
  // no revision change: only the model ROW clears activation.
  const before = await load(project)
  const refused = await runFail(reset, { id: fieldRow("model", { providerID: "openai", modelID: "gpt-5" }) })
  expect(refused.message).toContain("has no override to reset")
  const after = await load(project)
  expect(after.projectRevision).toBe(before.projectRevision)
  expect(after.records).toEqual(before.records)
  // A is still the active model.
  const modelRows = expandedTree(memoInputOf((await api.snapshot()).value)).filter((r) => r.id.startsWith("item:project:build:model:") && r.address?.item.startsWith("model:") === true)
  expect(modelRows.find((r) => r.badges.active === true)?.label).toBe("anthropic/claude")
})

test("local-only inactive B@high -> Effort low -> resetEffort restores B@high with unrelated active A intact", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude"),
      modelWith("openai", "gpt-5", { variants: ["high", "low"] }),
    ],
    classifications: { "": "general", claude: "general", "gpt-5": "general" },
  })
  const api = createPlusApi(ctx, createState())
  // Global active A (anthropic/claude). Candidate B (openai/gpt-5@high) exists
  // only as a local Project row, so it is *not* in the chain above.
  const globalActive: ModelRecord = {
    type: "model", level: "global", agent: "build",
    providerID: "anthropic", modelID: "claude", active: true, updated: UPDATED,
  }
  const localB: ModelRecord = {
    type: "model", level: "project", agent: "build",
    providerID: "openai", modelID: "gpt-5", variant: "high", updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, globalActive, localB],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reset = need(tools, "instructions_reset")
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string; variant?: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`
  const projectLive = async () =>
    (await load(project)).records.find((r): r is ModelRecord => r.type === "model" && r.level === "project" && r.agent === "build" && r.removed !== true)

  // Edit B@high's Effort to low: B@local is captured as the original (source
  // this level) and a tombstone hides B@high.
  await runOk(set, { id: fieldRow("effort", { providerID: "openai", modelID: "gpt-5", variant: "high" }), text: "low" })
  expect(await projectLive()).toMatchObject({
    providerID: "openai", modelID: "gpt-5", variant: "low",
    originalCandidate: { providerID: "openai", modelID: "gpt-5", variant: "high", source: "project", editedFields: ["effort"] },
  })

  // Reset Effort: the local-only B@high must come back, not disappear.
  await runOk(reset, { id: fieldRow("effort", { providerID: "openai", modelID: "gpt-5", variant: "low" }) })
  const restored = await projectLive()
  expect(restored).toMatchObject({ providerID: "openai", modelID: "gpt-5", variant: "high" })
  expect(restored).not.toHaveProperty("originalCandidate")
  // Unrelated active A is intact and still the effective model.
  const globalStill = (await load(project)).records.find(
    (r): r is ModelRecord => r.type === "model" && r.level === "global" && r.agent === "build",
  )
  expect(globalStill).toMatchObject({ providerID: "anthropic", modelID: "claude", active: true })
  const modelRows = expandedTree(memoInputOf((await api.snapshot()).value)).filter((r) => r.id.startsWith("item:project:build:model:") && r.address?.item.startsWith("model:") === true)
  expect(modelRows.map((r) => r.label)).toEqual(["anthropic/claude", "openai/gpt-5@high"])
  expect(modelRows.find((r) => r.badges.active === true)?.label).toBe("anthropic/claude")
})

test("Model reset refuses honestly for a legacy row with no original metadata", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [modelWith("anthropic", "claude"), modelWith("openai", "gpt-5")],
    classifications: { "": "general", claude: "general", "gpt-5": "general" },
  })
  const api = createPlusApi(ctx, createState())
  // A legacy local row written before originalCandidate existed: it has no
  // originalCandidate, so what it replaced cannot be known.
  const legacy: ModelRecord = {
    type: "model",
    level: "project",
    agent: "build",
    providerID: "anthropic",
    modelID: "claude",
    updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, { expectedProjectRevision: stored.projectRevision, expectedGlobalRevision: stored.globalRevision, records: [...stored.records, legacy] })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const reset = need(tools, "instructions_reset")
  const before = await load(project)
  const refused = await runFail(reset, { id: "item:project:build:modelfield:model:anthropic/claude" })
  expect(refused.message).toContain("no recorded original candidate")
  // No write happened.
  expect(await load(project)).toEqual(before)
})

test("Inherited row edit maintains one visible row, tombstone old candidate, and re-add restores old candidate", async () => {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "build body", modelRef("anthropic", "claude"))],
    models: [
      modelWith("anthropic", "claude"),
      modelWith("openai", "gpt-5"),
    ],
    classifications: { "": "general", claude: "general", "gpt-5": "general" },
  })
  const api = createPlusApi(ctx, createState())
  // Global has inactive candidate B.
  const globalB: ModelRecord = {
    type: "model",
    level: "global",
    agent: "build",
    providerID: "openai",
    modelID: "gpt-5",
    updated: UPDATED,
  }
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, globalB],
  })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const create = need(tools, "instructions_create")
  const fieldRow = (field: Parameters<typeof modelFieldItemId>[1], t: { providerID: string; modelID: string }) =>
    `item:project:build:${modelFieldItemId(t, field)}`

  // Edit B (openai/gpt-5) to C (anthropic/claude).
  await runOk(set, { id: fieldRow("model", { providerID: "openai", modelID: "gpt-5" }), text: "anthropic/claude" })

  // Exactly one visible row for anthropic/claude; openai/gpt-5 is tombstoned.
  const snap1 = memoInputOf((await api.snapshot()).value)
  const rows1 = expandedTree(snap1)
  const modelRows1 = rows1.filter((r) => r.id.startsWith("item:project:build:model:") && r.address?.item.startsWith("model:") === true)
  expect(modelRows1.map((r) => r.label)).toEqual(["anthropic/claude"])

  // Re-add openai/gpt-5: clears tombstone, both rows are visible.
  await runOk(create, { kind: "model", level: "project", agent: "build", providerID: "openai", modelID: "gpt-5" })

  const snap2 = memoInputOf((await api.snapshot()).value)
  const rows2 = expandedTree(snap2)
  const modelRows2 = rows2.filter((r) => r.id.startsWith("item:project:build:model:") && r.address?.item.startsWith("model:") === true)
  expect(modelRows2.map((r) => r.label)).toEqual(["anthropic/claude", "openai/gpt-5"])
})


// ---------------------------------------------------------------------------

async function readTools(ctx: Context): Promise<Map<string, Tool.Info & { readonly id: string }>> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
        yield* ctx.tool.transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
        })
        const list = yield* Deferred.await(deferred)
        return new Map(list.map((tool) => [tool.id, tool]))
      }),
    ),
  )
}

async function runOk(tool: Tool.Info & { readonly id: string }, input: unknown): Promise<unknown> {
  const outcome = await Effect.runPromise(
    tool.execute(input, toolContext()).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (!outcome.ok) throw new Error(`expected tool success, got error: ${outcome.error.message}`)
  return (outcome.result as { output: unknown }).output
}

async function runFail(tool: Tool.Info & { readonly id: string }, input: unknown): Promise<Tool.Error> {
  const outcome = await Effect.runPromise(
    tool.execute(input, toolContext()).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (outcome.ok) throw new Error(`expected tool failure, got success: ${JSON.stringify(outcome.result)}`)
  return outcome.error
}

function need(tools: Map<string, Tool.Info & { readonly id: string }>, id: string): Tool.Info & { readonly id: string } {
  const tool = tools.get(id)
  if (tool === undefined) throw new Error(`missing tool ${id}`)
  return tool
}

function toolContext(agent = "build"): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_model_settings"),
    agent: AgentSchema.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_model_settings"),
    id: Tool.CallID.make("call_model_settings"),
    progress: () => Effect.void,
  }
}
