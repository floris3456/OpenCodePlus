// Compaction per model (plus-1.1.18 plan, section 2): the compaction fields on
// agent model rows and Defaults › Models rows, their validation, storage and
// field-by-field resolution.
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setModelSettings, type ModelRecord, type Scopes } from "../src/instructions/model.js"
import {
  COLD_SWITCH_MOVED,
  compactionFieldsOf,
  compactionFromWords,
  effectiveCompaction,
  resolveModelCompactionFields,
  setModelCompaction,
  setModelSettingsRecord,
  type ModelSettingsRecord,
} from "../src/instructions/model-settings.js"
import { canonical, load, save, stable, type StoredRecord } from "../src/instructions/store.js"
import { globalRecordsPath, projectRecordsPath } from "../src/instructions/paths.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const scopes: Scopes = { global: new Set(["alpha"]), defaults: new Set(["alpha"]) }
const claude = { providerID: "anthropic", modelID: "claude" }

const modelRow = (overrides: Partial<ModelRecord>): ModelRecord => ({
  type: "model",
  level: "project",
  agent: "alpha",
  ...claude,
  updated: UPDATED,
  ...overrides,
})

const settings = (overrides: Partial<ModelSettingsRecord>): ModelSettingsRecord => ({
  type: "modelSettings",
  level: "defaults",
  updated: UPDATED,
  ...overrides,
})

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function isolated(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-compaction-fields-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return path.join(root, "project")
}

test("compaction fields validate into canonical stored values", () => {
  expect(
    compactionFieldsOf({
      compactWarm: " ON ",
      coldModels: "cliproxyapi/gemini-3.8-flash#high, deepseek/v4-flash",
      compactionStrategy: "Local",
      compactionModel: " openai/gpt-5#low ",
      compactionInstructions: "Summarize briefly.",
      compactionInput: " 0120000 ",
      compactionOutput: "OFF",
    }),
  ).toEqual({
    fields: {
      compactWarm: "on",
      coldModels: ["cliproxyapi/gemini-3.8-flash#high", "deepseek/v4-flash"],
      compactionStrategy: "local",
      compactionModel: "openai/gpt-5#low",
      compactionInstructions: "Summarize briefly.",
      compactionInput: "120000",
      compactionOutput: "off",
    },
  })
  // "" clears every field but the instructions, where it is an empty prompt; null always clears.
  expect(
    compactionFieldsOf({ compactWarm: "", coldModels: "", compactionStrategy: "", compactionModel: "", compactionInstructions: "" }),
  ).toEqual({ fields: { compactWarm: null, coldModels: null, compactionStrategy: null, compactionModel: null, compactionInstructions: "" } })
  expect(compactionFieldsOf({ compactionInstructions: null, coldCompact: null })).toEqual({
    fields: { compactionInstructions: null, coldCompact: null },
  })
  // A list is taken as is; an explicit empty list is this level's own "no models".
  expect(compactionFieldsOf({ coldModels: ["a/b", "c/d#x"] })).toEqual({ fields: { coldModels: ["a/b", "c/d#x"] } })
  expect(compactionFieldsOf({ coldModels: [] })).toEqual({ fields: { coldModels: [] } })
  expect(compactionFieldsOf({})).toEqual({ fields: {} })
  expect(compactionFieldsOf({ compactionInput: "", compactionOutput: null })).toEqual({ fields: { compactionInput: null, compactionOutput: null } })
})

test("bad compaction values refuse with the field named", () => {
  const error = (result: ReturnType<typeof compactionFieldsOf>) => ("error" in result ? result.error : undefined)
  expect(error(compactionFieldsOf({ compactWarm: "yes" }))).toContain("Compact before cold must be on or off")
  // The per-model cold switch is retired: setting it names the global Settings row.
  for (const value of ["on", "off", "maybe"])
    expect(error(compactionFieldsOf({ coldCompact: value }))).toBe(COLD_SWITCH_MOVED)
  expect(COLD_SWITCH_MOVED).toContain("Settings › OpenCodePlus › Compact cold chats first")
  expect(error(compactionFieldsOf({ compactionStrategy: "native" }))).toContain("auto, local or remote")
  expect(error(compactionFieldsOf({ compactionModel: "gpt-5" }))).toContain("provider/model")
  expect(error(compactionFieldsOf({ coldModels: "a/b, nope" }))).toContain('"nope"')
  expect(error(compactionFieldsOf({ coldModels: ["a/b", "a/b"] }))).toContain("listed twice")
  expect(error(compactionFieldsOf({ coldModels: "a/b#" }))).toContain("provider/model")
  for (const value of ["0", "-1", "1.5", "1e5", "20k", "90%", "Infinity", "9007199254740992"])
    for (const field of ["compactionInput", "compactionOutput"])
      expect(error(compactionFieldsOf({ [field]: value }))).toContain("positive whole token count")
})

test("the fields round-trip through the store, and a store without them is unchanged", async () => {
  const project = await isolated()
  const plain: StoredRecord[] = [
    modelRow({ active: true, warming: "30m" }),
    settings({ providerID: "anthropic", modelID: "claude", warming: "1h" }),
  ]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: plain })
  const plainProject = await Bun.file(projectRecordsPath(project)).text()
  const plainGlobal = await Bun.file(globalRecordsPath()).text()
  // No new key appears in a store that never set one.
  expect(plainProject).not.toContain("compact")
  expect(plainGlobal).not.toContain("compact")

  const withFields: StoredRecord[] = [
    modelRow({ active: true, warming: "30m", compactWarm: "on", coldCompact: "on", coldModels: ["a/b", "c/d#x"], compactionStrategy: "local", compactionInput: "120000", compactionOutput: "off" }),
    settings({
      providerID: "anthropic",
      modelID: "claude",
      warming: "1h",
      coldModels: [],
      compactionModel: "a/b",
      compactionInstructions: "",
      compactionInput: "off",
      compactionOutput: "30000",
    }),
  ]
  const loaded = await load(project)
  await save(project, { expectedProjectRevision: loaded.projectRevision, expectedGlobalRevision: loaded.globalRevision, records: withFields })
  const reloaded = await load(project)
  expect(canonical(reloaded.records).map(stable)).toEqual(canonical(withFields).map(stable))
  const row = reloaded.records.find((record): record is ModelRecord => record.type === "model")
  expect(row?.coldModels).toEqual(["a/b", "c/d#x"])
  const defaults = reloaded.records.find((record): record is ModelSettingsRecord => record.type === "modelSettings")
  expect(defaults?.coldModels).toEqual([])
  expect(defaults?.compactionInstructions).toBe("")

  // Saving the plain records again writes the plain bytes back.
  const again = await load(project)
  await save(project, { expectedProjectRevision: again.projectRevision, expectedGlobalRevision: again.globalRevision, records: plain })
  expect((await Bun.file(projectRecordsPath(project)).text()).split("\n").slice(1)).toEqual(plainProject.split("\n").slice(1))
  expect((await Bun.file(globalRecordsPath()).text()).split("\n").slice(1)).toEqual(plainGlobal.split("\n").slice(1))
})

test("model rows resolve each compaction field down the agent's chain", () => {
  const models = [
    modelRow({ level: "global", compactWarm: "on", coldModels: ["g/one", "g/two"], compactionStrategy: "remote" }),
    modelRow({ level: "project", compactionStrategy: "local", coldCompact: "on" }),
    modelRow({ level: "defaults", compactionModel: "d/model", coldModels: ["d/one"] }),
  ]
  const input = { models, scopes, level: "project" as const, agent: "alpha" }
  expect(resolveModelCompactionFields(input, claude)).toEqual({
    compactWarm: { value: "on", level: "global" },
    coldCompact: { value: "on", level: "project" },
    // The list inherits as a whole: Global's wins over Defaults'.
    coldModels: { value: ["g/one", "g/two"], level: "global" },
    compactionStrategy: { value: "local", level: "project" },
    compactionModel: { value: "d/model", level: "defaults" },
  })
  // Another model, or an agent whose chain holds none of these rows, resolves nothing.
  expect(resolveModelCompactionFields(input, { providerID: "openai", modelID: "gpt" })).toEqual({})
  expect(resolveModelCompactionFields({ ...input, agent: "beta" }, claude)).toEqual({})
  // A variant falls back to the variant-less row; its own row wins when it sets the field.
  const variant = [...models, modelRow({ level: "project", variant: "high", compactionStrategy: "auto" })]
  expect(resolveModelCompactionFields({ ...input, models: variant }, { ...claude, variant: "high" }).compactionStrategy).toEqual({
    value: "auto",
    level: "project",
  })
  expect(resolveModelCompactionFields({ ...input, models: variant }, { ...claude, variant: "high" }).compactWarm).toEqual({
    value: "on",
    level: "global",
  })
  // A Project tombstone hides the candidate, and with it every inherited field.
  const hidden = [...models.filter((record) => record.level !== "project"), modelRow({ level: "project", removed: true })]
  expect(resolveModelCompactionFields({ ...input, models: hidden }, claude)).toEqual({})
})

test("compact before cold and the cold-cache list resolve row, this model, Every model, built-in", () => {
  expect(effectiveCompaction({})).toEqual({
    compactionInput: { value: undefined, from: "built-in" },
    compactionOutput: { value: undefined, from: "built-in" },
    compactWarm: { value: false, from: "built-in" },
    coldModels: { value: [], from: "built-in" },
    strategy: { value: "auto", from: "built-in" },
    model: { value: undefined, from: "built-in" },
    instructions: { value: undefined, from: "built-in" },
  })
  const every = settings({ compactWarm: "on", coldCompact: "on", coldModels: ["e/one"] })
  const model = settings({ providerID: "anthropic", modelID: "claude", coldModels: ["m/one", "m/two"] })
  const resolved = effectiveCompaction({ every, model })
  expect(resolved.compactWarm).toEqual({ value: true, from: "every" })
  expect(resolved.coldModels).toEqual({ value: ["m/one", "m/two"], from: "model" })
  const row = effectiveCompaction({
    row: { compactWarm: { value: "off", level: "global" }, coldModels: { value: [], level: "project" } },
    every,
    model,
  })
  expect(row.compactWarm).toEqual({ value: false, from: "global" })
  // An own empty list wins over the lists below it.
  expect(row.coldModels).toEqual({ value: [], from: "project" })
  // A stored value that no longer parses sets nothing: the level below decides.
  expect(effectiveCompaction({ model: settings({ compactWarm: "maybe" }), every }).compactWarm).toEqual({ value: true, from: "every" })
})

test("strategy, model and instructions add the agent-wide, every-agent and config layers", () => {
  const layers = {
    row: { compactionStrategy: { value: "local", level: "project" as const } },
    agent: { strategy: "remote", model: "agent/model", instructions: "agent text" },
    model: settings({ providerID: "anthropic", modelID: "claude", compactionStrategy: "auto", compactionModel: "model/model" }),
    every: settings({ compactionStrategy: "remote", compactionModel: "every/model", compactionInstructions: "every text" }),
    agents: { strategy: "local", model: "agents/model", instructions: "agents text" },
    config: { strategy: "remote", model: "config/model", instructions: "config text" },
  }
  const all = effectiveCompaction(layers)
  expect(all.strategy).toEqual({ value: "local", from: "project" })
  // The old agent-wide rows still apply over every model setting.
  expect(all.model).toEqual({ value: "agent/model", from: "agent" })
  expect(all.instructions).toEqual({ value: "agent text", from: "agent" })
  const noAgent = effectiveCompaction({ ...layers, row: {}, agent: { model: "" } })
  expect(noAgent.strategy).toEqual({ value: "auto", from: "model" })
  // An agent-wide model of "" inherits.
  expect(noAgent.model).toEqual({ value: "model/model", from: "model" })
  expect(noAgent.instructions).toEqual({ value: "every text", from: "every" })
  const shared = effectiveCompaction({ agents: layers.agents, config: layers.config })
  expect(shared.strategy).toEqual({ value: "local", from: "agents" })
  expect(effectiveCompaction({ config: layers.config }).model).toEqual({ value: "config/model", from: "config" })
  // An empty prompt is a value, not "inherit".
  expect(effectiveCompaction({ model: settings({ compactionInstructions: "" }), config: layers.config }).instructions).toEqual({
    value: "",
    from: "model",
  })
  expect(compactionFromWords("agent")).toContain("agent-wide")
  expect(compactionFromWords("agents")).toContain("every agent")
  expect(compactionFromWords("every")).toBe("Defaults › Models › Every model")
})

test("token thresholds inherit per field across scopes, variants and Defaults; off masks and reset restores", () => {
  const models = [
    modelRow({ level: "defaults", compactionInput: "90000", compactionOutput: "40000" }),
    modelRow({ level: "global", compactionInput: "80000" }),
    modelRow({ compactionOutput: "30000" }),
    modelRow({ variant: "high", compactionInput: "off" }),
  ]
  const every = settings({ compactionInput: "120000", compactionOutput: "60000" })
  const specific = settings({ ...claude, compactionInput: "100000" })
  const resolve = (records: ModelRecord[], target = claude) => effectiveCompaction({
    row: resolveModelCompactionFields({ models: records, scopes, level: "project", agent: "alpha" }, target),
    model: specific,
    every,
  })
  expect(resolve(models)).toMatchObject({ compactionInput: { value: 80000, from: "global" }, compactionOutput: { value: 30000, from: "project" } })
  const variant = { ...claude, variant: "high" }
  expect(resolve(models, variant).compactionInput).toEqual({ value: 0, from: "project" })
  const reset = setModelCompaction(models, { level: "project", agent: "alpha" }, variant, { compactionInput: null }, UPDATED)
  expect(resolve(reset, variant).compactionInput).toEqual({ value: 80000, from: "global" })
  expect(resolve([])).toMatchObject({ compactionInput: { value: 100000, from: "model" }, compactionOutput: { value: 60000, from: "every" } })
  expect(effectiveCompaction({ every }).compactionInput).toEqual({ value: 120000, from: "every" })
})

test("Defaults › Models saves keep the compaction fields they do not name", () => {
  const key = { providerID: "anthropic", modelID: "claude" }
  const created = setModelSettingsRecord([], key, { coldCompact: "on", coldModels: ["a/b", "c/d"] }, UPDATED)
  expect(created).toEqual([settings({ ...key, coldCompact: "on", coldModels: ["a/b", "c/d"] })])
  // Setting a warming field keeps the compaction fields.
  const warmed = setModelSettingsRecord(created, key, { warming: "30m" }, "2026-02-01T00:00:00.000Z")
  expect(warmed[0]).toMatchObject({ warming: "30m", coldCompact: "on", coldModels: ["a/b", "c/d"] })
  // The same list again changes nothing; another order is a change.
  expect(setModelSettingsRecord(warmed, key, { coldModels: ["a/b", "c/d"] }, UPDATED)).toEqual(warmed)
  expect(setModelSettingsRecord(warmed, key, { coldModels: ["c/d", "a/b"] }, UPDATED)[0]?.coldModels).toEqual(["c/d", "a/b"])
  // Clearing every field removes the row.
  expect(setModelSettingsRecord(warmed, key, { warming: null, coldCompact: null, coldModels: null }, UPDATED)).toEqual([])
})

test("model rows set and clear compaction fields without touching the rest", () => {
  const address = { level: "project" as const, agent: "alpha" }
  const row = modelRow({ active: true, warming: "45m", interval: "4m" })
  const set = setModelCompaction([row], address, claude, { compactWarm: "on", coldModels: ["a/b"] }, "2026-02-01T00:00:00.000Z")
  expect(set).toEqual([{ ...row, compactWarm: "on", coldModels: ["a/b"], updated: "2026-02-01T00:00:00.000Z" }])
  const cleared = setModelCompaction(set, address, claude, { compactWarm: null }, UPDATED)
  expect(cleared[0]).toMatchObject({ active: true, warming: "45m", interval: "4m", coldModels: ["a/b"] })
  expect("compactWarm" in (cleared[0] ?? {})).toBe(false)
  // Clearing what nothing sets returns the same list.
  expect(setModelCompaction([row], address, claude, { compactWarm: null }, UPDATED)).toEqual([row])
  // An inherited model gets an inactive candidate row at this level.
  const planted = setModelCompaction([modelRow({ level: "global" })], address, claude, { coldCompact: "on" }, UPDATED)
  expect(planted).toHaveLength(2)
  expect(planted[1]).toMatchObject({ level: "project", agent: "alpha", coldCompact: "on" })
  expect(planted[1]?.active).toBeUndefined()
  // A warming save on the row keeps its compaction fields.
  expect(setModelSettings(set, address, claude, { prompt: "ping" }, UPDATED)[0]).toMatchObject({ compactWarm: "on", coldModels: ["a/b"] })
})
