// The compaction field rows under an agent model row (Compaction group plus
// Compact before cold) edit through setModelFieldRow / resetModelFieldRow.
// Before the fix, modelFieldEdit fell through to `prompt`, so setting any of
// these overwrote the keep-alive prompt. These tests exercise the production
// write path and the C1 validators, and pin the fields that must not move:
// prompt (canary), candidate identity/variant and the active flag.
import { expect, test } from "bun:test"
import { modelFieldItemId } from "../src/instructions/model-settings.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"
import type { ModelRecord } from "../src/instructions/model.js"
import { modelFieldEdit, resetModelFieldRow, setModelFieldRow } from "../src/instructions/ops.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

type Overrides = Partial<{
  level: "project" | "global"
  agent: string
  providerID: string
  modelID: string
  variant: string
  active: true
  prompt: string
  compactWarm: string
  compactionStrategy: string
  compactionModel: string
  compactionInstructions: string
}>

const model = (overrides: Overrides = {}): ModelRecord => ({
  type: "model" as const,
  level: overrides.level ?? ("project" as const),
  agent: overrides.agent ?? "alpha",
  providerID: overrides.providerID ?? "acme",
  modelID: overrides.modelID ?? "nova",
  ...(overrides.variant === undefined ? {} : { variant: overrides.variant }),
  ...(overrides.active === undefined ? {} : { active: overrides.active }),
  ...(overrides.prompt === undefined ? {} : { prompt: overrides.prompt }),
  ...(overrides.compactWarm === undefined ? {} : { compactWarm: overrides.compactWarm }),
  ...(overrides.compactionStrategy === undefined ? {} : { compactionStrategy: overrides.compactionStrategy }),
  ...(overrides.compactionModel === undefined ? {} : { compactionModel: overrides.compactionModel }),
  ...(overrides.compactionInstructions === undefined ? {} : { compactionInstructions: overrides.compactionInstructions }),
  updated: UPDATED,
})

const input = (records: ModelRecord[]): MemoInput => ({
  items: [],
  records,
  agents: [
    { id: "alpha", scope: "project" },
    { id: "alpha", scope: "global" },
  ],
})

const fieldRow = (name: string, target: { providerID: string; modelID: string; variant?: string } = { providerID: "acme", modelID: "nova" }) =>
  `item:project:alpha:${modelFieldItemId(target, name as Parameters<typeof modelFieldItemId>[1])}`

const live = (records: MemoInput["records"]): ModelRecord | undefined =>
  records.find((record): record is ModelRecord => record.type === "model" && record.level === "project" && record.agent === "alpha" && record.removed !== true)

test("setting compactionStrategy writes only that field and keeps the keep-alive prompt canary", () => {
  const base = input([model({ prompt: "CANARY keep-alive", active: true, variant: "high" })])
  // The row id really comes from the built tree, so the test follows production ids.
  const rowId = expandedTree(base).find((row) => row.label === "Strategy")?.id
  if (rowId === undefined) throw new Error("no Strategy row in tree")
  const result = setModelFieldRow(base, rowId, "local")
  if ("refusal" in result) throw new Error(result.refusal)
  const written = live(result.models)
  expect(written?.compactionStrategy).toBe("local")
  expect(written?.prompt).toBe("CANARY keep-alive")
  expect(written?.active).toBe(true)
  expect(written?.variant).toBe("high")
  expect(written?.modelID).toBe("nova")
})

test("setting compactionModel and compactWarm keeps the prompt; invalid values refuse with no write", () => {
  const base = input([model({ prompt: "CANARY" })])
  const setModel = setModelFieldRow(base, fieldRow("compactionModel"), "cheap/small#low")
  if ("refusal" in setModel) throw new Error(setModel.refusal)
  expect(live(setModel.models)?.compactionModel).toBe("cheap/small#low")
  expect(live(setModel.models)?.prompt).toBe("CANARY")

  const after = input(setModel.models)
  const setSwitch = setModelFieldRow(after, fieldRow("compactWarm"), "off")
  if ("refusal" in setSwitch) throw new Error(setSwitch.refusal)
  expect(live(setSwitch.models)?.compactWarm).toBe("off")
  expect(live(setSwitch.models)?.prompt).toBe("CANARY")

  const bad = setModelFieldRow(after, fieldRow("compactionStrategy"), "quick")
  if (!("refusal" in bad)) throw new Error("expected invalid-strategy refusal")
  expect(bad.refusal).toContain("auto, local or remote")
  expect("models" in bad).toBe(false)
  expect(after.records).toEqual(setModel.models)
})

test("setting Compact cold chats first writes coldFirst alone; empty clears and a bad value refuses", () => {
  const base = input([model({ prompt: "CANARY", active: true, compactWarm: "on" })])
  const rowId = expandedTree(base).find((row) => row.label === "Compact cold chats first")?.id
  expect(rowId).toBe(fieldRow("coldFirst"))
  const set = setModelFieldRow(base, fieldRow("coldFirst"), " OFF ")
  if ("refusal" in set) throw new Error(set.refusal)
  expect(live(set.models)).toMatchObject({ coldFirst: "off", compactWarm: "on", prompt: "CANARY", active: true, modelID: "nova" })

  const after = input(set.models)
  const cleared = setModelFieldRow(after, fieldRow("coldFirst"), "")
  if ("refusal" in cleared) throw new Error(cleared.refusal)
  expect(live(cleared.models)).not.toHaveProperty("coldFirst")
  expect(live(cleared.models)).toMatchObject({ compactWarm: "on", prompt: "CANARY" })

  const bad = setModelFieldRow(after, fieldRow("coldFirst"), "sometimes")
  if (!("refusal" in bad)) throw new Error("expected an on/off refusal")
  expect(bad.refusal).toBe(`Compact cold chats first must be on or off, got "sometimes"`)
  expect(after.records).toEqual(set.models)

  const edit = modelFieldEdit("coldFirst", { providerID: "acme", modelID: "nova" }, "on")
  if (!("compaction" in edit)) throw new Error("expected a compaction edit")
  expect(edit.compaction).toEqual({ coldFirst: "on" })
})

test("reset on Compact cold chats first clears this level so the Global value shows again", () => {
  const base = input([{ ...model({ level: "global" }), coldFirst: "off" }, { ...model({ prompt: "CANARY" }), coldFirst: "on" }])
  expect(expandedTree(base).find((row) => row.id === fieldRow("coldFirst"))?.badges.value).toBe("on")
  const reset = resetModelFieldRow(base, fieldRow("coldFirst"))
  if ("refusal" in reset) throw new Error(reset.refusal)
  expect(live(reset.models)).not.toHaveProperty("coldFirst")
  expect(live(reset.models)?.prompt).toBe("CANARY")
  expect(reset.models.find((record) => record.level === "global" && record.agent === "alpha")?.coldFirst).toBe("off")
  expect(expandedTree(input(reset.models)).find((row) => row.id === fieldRow("coldFirst"))?.badges.value).toBe("off · global")
})

test("empty compaction instructions is an explicit empty prompt; reset then inherits", () => {
  const base = input([model({ prompt: "CANARY" })])
  const written = setModelFieldRow(base, fieldRow("compactionInstructions"), "")
  if ("refusal" in written) throw new Error(written.refusal)
  expect(live(written.models)?.compactionInstructions).toBe("")
  expect(live(written.models)?.prompt).toBe("CANARY")

  const after = input(written.models)
  const reset = resetModelFieldRow(after, fieldRow("compactionInstructions"))
  if ("refusal" in reset) throw new Error(reset.refusal)
  expect(live(reset.models)?.compactionInstructions).toBeUndefined()
  expect(live(reset.models)?.prompt).toBe("CANARY")
})

test("reset clears the local override so the inherited value wins again, keeping the prompt", () => {
  const base = input([
    model({ level: "global", compactionStrategy: "remote" }),
    model({ compactionStrategy: "local", prompt: "CANARY" }),
  ])
  const reset = resetModelFieldRow(base, fieldRow("compactionStrategy"))
  if ("refusal" in reset) throw new Error(reset.refusal)
  expect(live(reset.models)?.compactionStrategy).toBeUndefined()
  expect(live(reset.models)?.prompt).toBe("CANARY")
  // The Global row is untouched.
  const global = reset.models.find((record) => record.level === "global" && record.agent === "alpha")
  expect(global?.compactionStrategy).toBe("remote")
})

test("reset refuses when this level sets no such override, with no write", () => {
  const base = input([model({ prompt: "CANARY" })])
  const before = JSON.stringify(base.records)
  const reset = resetModelFieldRow(base, fieldRow("compactionModel"))
  if (!("refusal" in reset)) throw new Error("expected a no-override refusal")
  expect(reset.refusal).toBe(`"Model" has no override to reset`)
  expect("models" in reset).toBe(false)
  expect(JSON.stringify(base.records)).toBe(before)
})

test("modelFieldEdit no longer falls through to prompt for compaction fields", () => {
  const target = { providerID: "acme", modelID: "nova" }
  const edit = modelFieldEdit("compactionStrategy", target, "local")
  expect("error" in edit).toBe(false)
  expect("fields" in edit).toBe(false)
  if (!("compaction" in edit)) throw new Error("expected a compaction edit")
  expect(edit.compaction.compactionStrategy).toBe("local")
  // The real text fields still work.
  const prompt = modelFieldEdit("prompt", target, "hello")
  expect("error" in prompt).toBe(false)
  if (!("fields" in prompt)) throw new Error("expected a fields edit")
  expect(prompt.fields.prompt).toBe("hello")
})
