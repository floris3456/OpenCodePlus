import { expect, test } from "bun:test"
import { fingerprint, resolve, type CustomizationRecord, type Item, type SplitRecord } from "../src/instructions/model.js"
import { addSection, planSectionMove } from "../src/instructions/ops.js"
import { advanceMove, startMove } from "../src/tui/instructions/move.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"

const updated = "2026-01-01T00:00:00.000Z"
const text = "# Seat\n\n## Role\nR.\n\n## Routing\nOld routing.\n\n## Merges\nM.\n\n# Tail\n\nT.\n"
const item: Item = { id: "system:role", kind: "system", group: "none", title: "Role", text, enabled: true, fingerprint: fingerprint(text), agents: ["alpha"] }
const scopes = { global: new Set(["alpha"]), defaults: new Set(["alpha"]) }

test("section move previews records without mutating its input and refuses nesting", () => {
  const input = memo()
  const node = expandedTree(input).find((entry) => entry.id === row(input, "seat/role"))!
  const started = startMove(node, { folders: [], orders: [] })
  if ("refusal" in started) throw new Error(started.refusal)
  const before = JSON.stringify(input)
  const advanced = advanceMove(input, started.state, "down")
  if ("refusal" in advanced) throw new Error(advanced.refusal)
  expect(advanced.state.rowId).toBe(node.id)
  expect(advanced.state.section).toBeDefined()
  expect(JSON.stringify(input)).toBe(before)
  expect(advanceMove(input, started.state, "in")).toHaveProperty("refusal")
  expect(advanceMove(input, started.state, "out")).toHaveProperty("refusal")
})

test("repeated heading titles refuse atomically instead of changing occurrence identities", () => {
  const source = { ...item, text: "## Same\nfirst\n## Same\nsecond\n" }
  const input = memo([], source)
  const nodes = expandedTree(input).filter((node) => node.address?.section !== null && node.address?.level === "project")
  const before = JSON.stringify(input)
  expect(planSectionMove(input, nodes[1]!.id, { before: nodes[0]!.id }, updated)).toHaveProperty("refusal")
  expect(JSON.stringify(input)).toBe(before)
})

test("whole-item heading add does not bury the sibling in the previous section override", () => {
  const source = { ...item, text: "## First\nfirst\n## Last\nlast\n" }
  const local = { ...record("project", "last", "## Last\nedited last\n"), pin: true }
  const input = memo([local], source)
  const node = expandedTree(input).find((node) => node.address?.item === source.id && node.address.section === null && node.address.level === "project")!
  const result = addSection(input, node.id, "New", "new body")
  if ("refusal" in result) throw new Error(result.refusal)
  const last = resolve({ upstream: source, records: result.records, splits: result.splits, scopes, address: { level: "project", agent: "alpha", item: source.id, section: "last" } })
  expect(last.text).toContain("edited last")
  expect(last.text).not.toContain("New")
  expect(assembled(source, result.records, result.splits)).toContain("## New")
  expect(result.records.find((record) => record.section === "last")).toMatchObject({ pin: true, text: undefined })
})

test("nested manual edits move with stable boundaries; hidden boundary refuses", () => {
  const source = { ...item, text: "parent\naaa\nbbb\ntail\n" }
  const split: SplitRecord = { type: "split", level: "global", agent: "alpha", item: item.id, boundaries: [
    { id: "p", name: "Parent", start: 0, depth: 0 },
    { id: "a", name: "A", start: 7, depth: 1 },
    { id: "b", name: "B", start: 11, depth: 1 },
    { id: "t", name: "Tail", start: 15, depth: 0 },
  ], updated }
  const input = memo([split, record("project", "a", "long edited a\n")], source)
  const result = move(input, "b", "a")
  expect(assembled(source, result.records, result.splits)).toBe("parent\n\nbbb\nlong edited a\n\ntail")
  expect(row(memo([...result.records, ...result.splits], source), "a")).toBe(row(input, "a"))
  const hidden = memo([split, record("project", "p", "replacement parent\n")], source)
  const before = JSON.stringify(hidden)
  expect(planSectionMove(hidden, row(hidden, "b"), { before: row(hidden, "a") }, updated)).toHaveProperty("refusal")
  expect(JSON.stringify(hidden)).toBe(before)
})

function record(level: "project" | "global", section: string, body: string): CustomizationRecord {
  return { type: "customization", level, agent: "alpha", item: item.id, section, text: body, basedOn: item.fingerprint, updated }
}

function memo(records: MemoInput["records"] = [], source = item): MemoInput {
  return { items: [source], records, agents: [{ id: "alpha", scope: "project" }, { id: "alpha", scope: "global" }], teams: [], links: [{ type: "link", level: "project", agent: "alpha", preset: { kind: "agent", id: "build" }, updated }] }
}

function row(input: MemoInput, section: string, level = "project") {
  const node = expandedTree(input).find((node) => node.address?.section === section && node.address.level === level && node.address.agent === "alpha")
  if (!node) throw new Error(`Missing ${level} ${section}`)
  return node.id
}

function move(input: MemoInput, section: string, anchor: string, level = "project") {
  const result = planSectionMove(input, row(input, section, level), { before: row(input, anchor, level) }, updated)
  if ("refusal" in result) throw new Error(result.refusal)
  return result
}

function assembled(source: Item, records: CustomizationRecord[], splits: SplitRecord[] = []) {
  return resolve({ upstream: source, records, splits, scopes, address: { level: "project", agent: "alpha", item: source.id, section: null } }).assembled
}

test("heading move folds edited text, retains local fields, excludes disabled child, and reloads stable ids without duplicates", () => {
  const edited = { ...record("project", "seat/routing", "## Routing\nEdited routing.\n"), state: "off" as const, pin: true, requires: ["tool:bash"] }
  const input = memo([edited])
  const result = move(input, "seat/merges", "seat/role")
  expect(result.records.find((record) => record.section === "seat/routing")).toMatchObject({ state: "off", pin: true, requires: ["tool:bash"], text: undefined })
  const sent = assembled(item, result.records, result.splits)
  expect(sent.match(/^#+ .+$/gm)).toEqual(["# Seat", "## Merges", "## Role", "# Tail"])
  expect(sent).not.toContain("routing.")
  const full = resolve({ upstream: item, records: result.records, splits: result.splits, scopes, address: { level: "project", agent: "alpha", item: item.id, section: null } }).fullText!
  expect(full).toContain("Edited routing.")
  expect(full.match(/## Routing/g)).toHaveLength(1)
  const reloaded = memo([...result.records, ...result.splits])
  expect(row(reloaded, "seat/merges")).toBe(row(input, "seat/merges"))
  expect(move(reloaded, "seat/role", "seat/merges").status).toContain("Moved")
})

test("top heading move folds same-level text but retains more-specific child override", () => {
  const records = [record("global", "seat/routing", "## Routing\nGlobal routing.\n"), record("project", "seat/routing", "## Routing\nProject routing.\n")]
  const result = move(memo(records), "tail", "seat", "global")
  expect(result.records).toContainEqual(records[1])
  expect(result.records.some((record) => record.level === "global" && record.section === "seat/routing" && record.text !== undefined)).toBe(false)
  const sent = assembled(item, result.records)
  expect(sent.match(/^#+ .+$/gm)).toEqual(["# Tail", "# Seat", "## Role", "## Routing", "## Merges"])
  expect(sent).toContain("Project routing.")
  expect(sent).not.toContain("Global routing.")
})

test("manual move retains boundary ids and edited children through request assembly and reload", () => {
  const source = { ...item, text: "aaa\nbbb\nccc\n" }
  const split: SplitRecord = { type: "split", level: "global", agent: "alpha", item: item.id, boundaries: [{ id: "a", name: "A", start: 0 }, { id: "b", name: "B", start: 4 }, { id: "c", name: "C", start: 8 }], updated }
  const edit = record("project", "b", "edited B\n")
  const result = move(memo([split, edit], source), "c", "a")
  expect(assembled(source, result.records, result.splits)).toBe("ccc\naaa\nedited B")
  expect(result.splits.find((split) => split.level === "project")?.boundaries.map((boundary) => [boundary.id, boundary.start])).toEqual([["a", 4], ["b", 8], ["c", 0]])
  const reload = memo([...result.records, ...result.splits], source)
  expect(row(reload, "b")).toBe(row(memo([split, edit], source), "b"))
  expect(move(reload, "b", "c").status).toContain("Moved")
})

test("invalid, self, cross-parent and cross-owner requests refuse without changing inputs", () => {
  const input = memo()
  const id = row(input, "seat/role")
  const before = JSON.stringify(input)
  for (const target of [{}, { into: row(input, "seat") }, { before: id }, { before: "missing" }, { before: row(input, "tail") }, { before: row(input, "seat/merges", "global") }, { before: row(input, "seat/merges"), after: row(input, "seat/routing") }]) {
    expect(planSectionMove(input, id, target, updated)).toHaveProperty("refusal")
    expect(JSON.stringify(input)).toBe(before)
  }
})

test("manual move at Global retains more-specific edits and folds local text without losing fields", () => {
  const source = { ...item, text: "aaa\nbbb\nccc\n" }
  const split: SplitRecord = { type: "split", level: "global", agent: "alpha", item: item.id, boundaries: [{ id: "a", name: "A", start: 0 }, { id: "b", name: "B", start: 4 }, { id: "c", name: "C", start: 8 }], updated }
  const local = { ...record("global", "b", "long global edit\n"), pin: true, requires: ["tool:bash"] }
  const specific = record("project", "b", "project edit\n")
  const result = move(memo([split, local, specific], source), "c", "a", "global")
  expect(result.records).toContainEqual(specific)
  expect(result.records.find((record) => record.level === "global" && record.section === "b")).toMatchObject({ text: undefined, pin: true, requires: ["tool:bash"] })
  expect(assembled(source, result.records, result.splits)).toBe("ccc\naaa\nproject edit")
})

test("after movement handles final heading without a trailing source newline", () => {
  const source = { ...item, text: item.text.trimEnd() }
  const input = memo([], source)
  const result = planSectionMove(input, row(input, "seat"), { after: row(input, "tail") }, updated)
  if ("refusal" in result) throw new Error(result.refusal)
  expect(assembled(source, result.records).match(/^#+ .+$/gm)).toEqual(["# Tail", "# Seat", "## Role", "## Routing", "## Merges"])
})

test("cross-item movement refuses without records or split writes", () => {
  const input = { ...memo(), items: [item, { ...item, id: "system:other" }] }
  const anchor = expandedTree(input).find((node) => node.address?.item === "system:other" && node.address.section === "tail" && node.address.level === "project")!
  const before = JSON.stringify(input)
  expect(planSectionMove(input, row(input, "tail"), { before: anchor.id }, updated)).toHaveProperty("refusal")
  expect(JSON.stringify(input)).toBe(before)
})
