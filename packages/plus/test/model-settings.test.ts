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
  parseModelDefaultItemId,
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

test("modelDefaultKeys unions stored rows, agent models and host warming, sorted and deduped", () => {
  const keys = modelDefaultKeys({
    modelSettings: [record({ providerID: "zeta", modelID: "one" }), record({})],
    models: [modelRow({}), modelRow({ providerID: "zeta", modelID: "one", variant: "high" })],
    agents: [{ model: { providerID: "beta", modelID: "two" } }, { model: { providerID: "anthropic", modelID: "claude" } }],
    hostModels: [host({ warming: { on: true, interval: MINUTE } }), host({ providerID: "gamma", modelID: "unused" })],
  })
  expect(keys).toEqual([
    { providerID: "anthropic", modelID: "claude" },
    { providerID: "beta", modelID: "two" },
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
  // Without an own row the summary names the sources.
  expect(modelDefaultValue(modelDefaultView({ every, host: config }))).toBe("warm 1h30m · every 25m · every model · opencode.json")
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
  const rows = expandedTree(memoInputOf(snapshot)).filter((row) => row.id.startsWith("item:defaults:/models:modeldefault:"))
  expect(rows.map((row) => row.label)).toEqual(["Every model", "anthropic/claude", "openai/gpt-6-astra"])
  // The Every model row shows its own values; the others inherit them, so the
  // summary names the source.
  expect(rows[0]?.badges.value).toBe("warm 30m · every 5m")
  // Claude keeps its own config duration while inheriting the rest.
  expect(rows[1]?.badges.value).toBe("warm 30m · every 5m · every model · opencode.json")
  expect(rows[2]?.badges.value).toBe("warm 30m · every 5m · every model")
  expect(rows[0]?.actions).toMatchObject({ toggle: false, edit: true, reset: true, remove: true })
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
  expect(query(input, { where: "modified:true", fields: ["id"] }, memo).rows.map((row) => row.id)).toEqual([
    "item:defaults:/models:modeldefault:*",
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
