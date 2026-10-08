// The writes behind the model rows' compaction fields (plus-1.1.18 §2, I2a):
// Space on a switch, Strategy cycling, the cold-cache list's a/d/m, and the
// old agent-wide rows staying untouched.
import { expect, test } from "bun:test"
import {
  addColdModelRow,
  moveColdModelRow,
  removeColdModelRow,
  setModelCompactionRow,
  toggleModelCompactionSwitch,
} from "../src/instructions/ops.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

const model = (overrides: Partial<{ level: "project" | "global"; agent: string; providerID: string; modelID: string; coldCompact: string; coldModels: readonly string[]; compactionStrategy: string }> = {}) => ({
  type: "model" as const,
  level: overrides.level ?? ("project" as const),
  agent: overrides.agent ?? "alpha",
  providerID: overrides.providerID ?? "acme",
  modelID: overrides.modelID ?? "nova",
  ...(overrides.coldCompact === undefined ? {} : { coldCompact: overrides.coldCompact }),
  ...(overrides.coldModels === undefined ? {} : { coldModels: [...overrides.coldModels] }),
  ...(overrides.compactionStrategy === undefined ? {} : { compactionStrategy: overrides.compactionStrategy }),
  updated: UPDATED,
})

const input = (records: MemoInput["records"]): MemoInput => ({
  items: [],
  records,
  agents: [
    { id: "alpha", scope: "project" },
    { id: "alpha", scope: "global" },
  ],
})

const modelRow = "item:project:alpha:model:acme/nova"
const field = (name: string) => `item:project:alpha:modelfield:${name}:acme/nova`

test("Space on Compact before cold writes compactWarm at the row's level", () => {
  const base = input([model({ coldCompact: "on", coldModels: ["a/one"] })])
  const on = toggleModelCompactionSwitch(base, field("compactWarm"))
  if ("refusal" in on) throw new Error(on.refusal)
  expect(on.models.find((entry) => entry.agent === "alpha" && entry.level === "project")?.compactWarm).toBe("on")
  const off = toggleModelCompactionSwitch({ ...base, records: on.models }, field("compactWarm"))
  if ("refusal" in off) throw new Error(off.refusal)
  expect(off.models.find((entry) => entry.agent === "alpha")?.compactWarm).toBe("off")
})

test("Space on the cold-cache group inverts coldCompact and keeps the list", () => {
  const base = input([model({ coldCompact: "off", coldModels: ["a/one"] })])
  const group = "group:project:alpha:modelgroup:acme/nova:cold"
  const on = toggleModelCompactionSwitch(base, group)
  if ("refusal" in on) throw new Error(on.refusal)
  const written = on.models.find((entry) => entry.agent === "alpha")!
  expect(written.coldCompact).toBe("on")
  expect(written.coldModels).toEqual(["a/one"])
})

test("Strategy cycles and writes compactionStrategy at the row's level", () => {
  const base = input([model({ compactionStrategy: "auto" })])
  const local = setModelCompactionRow(base, field("compactionStrategy"), { compactionStrategy: "local" })
  if ("refusal" in local) throw new Error(local.refusal)
  expect(local.models.find((entry) => entry.agent === "alpha")?.compactionStrategy).toBe("local")
})

test("the cold-cache list's a/d/m write coldModels in try order", () => {
  const base = input([model({ coldCompact: "on", coldModels: ["a/one", "b/two"] })])
  const cold = "group:project:alpha:modelgroup:acme/nova:cold"
  const added = addColdModelRow(base, cold, "c/three")
  if ("refusal" in added) throw new Error(added.refusal)
  expect(added.models.find((entry) => entry.agent === "alpha")?.coldModels).toEqual(["a/one", "b/two", "c/three"])

  const row = (index: number) => `item:project:alpha:coldmodel:acme/nova:cold:${index}`
  const other = { ...base, records: added.models }
  const removed = removeColdModelRow(other, row(1))
  if ("refusal" in removed) throw new Error(removed.refusal)
  expect(removed.models.find((entry) => entry.agent === "alpha")?.coldModels).toEqual(["a/one", "c/three"])

  const moved = moveColdModelRow(base, row(1), -1)
  if ("refusal" in moved) throw new Error(moved.refusal)
  expect(moved.models.find((entry) => entry.agent === "alpha")?.coldModels).toEqual(["b/two", "a/one"])
})

test("a on an inherited list copies it to this level and appends; r drops this level's list", () => {
  const base = input([model({ level: "global", coldCompact: "on", coldModels: ["g/one", "g/two"] })])
  const cold = "group:project:alpha:modelgroup:acme/nova:cold"
  const copied = addColdModelRow(base, cold, "p/new")
  if ("refusal" in copied) throw new Error(copied.refusal)
  const project = copied.models.find((entry) => entry.agent === "alpha" && entry.level === "project")
  expect(project?.coldModels).toEqual(["g/one", "g/two", "p/new"])
  // The Global row keeps its own list.
  expect(copied.models.find((entry) => entry.level === "global" && entry.agent === "alpha")?.coldModels).toEqual(["g/one", "g/two"])
})

test("an agent-wide compaction field is not rewritten by a model-row write", () => {
  const control = {
    type: "customization" as const,
    level: "project" as const,
    agent: "alpha",
    item: "compaction:strategy",
    section: null,
    text: "remote",
    basedOn: "fp",
    updated: UPDATED,
  }
  const base = input([control, model({ coldCompact: "on" })])
  const set = setModelCompactionRow(base, field("compactionModel"), { compactionModel: "cheap/model" })
  if ("refusal" in set) throw new Error(set.refusal)
  expect(set.models.find((entry) => entry.agent === "alpha")?.compactionModel).toBe("cheap/model")
  // The agent-wide row is untouched: it stays in the records and its text is unchanged.
  expect(base.records.find((record) => record.type === "customization")).toEqual(control)
})

test("clearing coldModels at this level drops the list so the level below wins again", () => {
  const base = input([model({ level: "global", coldCompact: "on", coldModels: ["g/one", "g/two"] })])
  const cold = "group:project:alpha:modelgroup:acme/nova:cold"
  const copied = addColdModelRow(base, cold, "p/new")
  if ("refusal" in copied) throw new Error(copied.refusal)
  const project = { ...base, records: copied.models }
  const dropped = setModelCompactionRow(project, cold, { coldModels: null })
  if ("refusal" in dropped) throw new Error(dropped.refusal)
  // No Project list survives; the Global list applies again.
  expect(dropped.models.some((entry) => entry.level === "project" && entry.agent === "alpha" && entry.coldModels !== undefined)).toBe(false)
  const rows = expandedTree({ ...project, records: dropped.models })
  expect(rows.find((row) => row.id === "group:project:alpha:modelgroup:acme/nova:cold")?.badges.value).toBe("on · g/one → g/two")
})

test("Compact before cold shows off · built-in when nothing sets it", () => {
  const rows = expandedTree(input([model()]))
  const compactWarm = rows.find((row) => row.id === "item:project:alpha:modelfield:compactWarm:acme/nova")
  expect(compactWarm?.badges.value).toBe("off · built-in")
})