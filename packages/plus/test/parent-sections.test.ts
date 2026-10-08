import { expect, test } from "bun:test"
import {
  fingerprint,
  resolve,
  type CustomizationRecord,
  type Item,
  type Scopes,
  type SplitRecord,
} from "../src/instructions/model.js"
import { addSection, saveText } from "../src/instructions/ops.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
// Two top-level headings: a lone one would wrap the document as "Introduction".
const SEAT = "# Seat\n\n## Role\nR.\n\n## Routing\nOld routing.\n\n## Merges\nM.\n\n# Tail\n\nT.\n"
const SEAT_HEADINGS = ["# Seat", "## Role", "## Routing", "## Merges", "# Tail"]

const item: Item = {
  id: "system:role",
  kind: "system",
  group: "none",
  title: "Role",
  text: SEAT,
  enabled: true,
  fingerprint: fingerprint(SEAT),
  agents: ["alpha"],
}

const scopes: Scopes = { global: new Set(["alpha"]), defaults: new Set(["alpha"]) }

function rec(level: "project" | "global" | "defaults", section: string, text: string): CustomizationRecord {
  return {
    type: "customization",
    level,
    agent: level === "defaults" ? null : "alpha",
    item: "system:role",
    section,
    text,
    basedOn: fingerprint(SEAT),
    updated: UPDATED,
  }
}

function assembled(records: readonly CustomizationRecord[], splits: readonly SplitRecord[] = []): string {
  return resolve({
    upstream: item,
    records: [...records],
    splits: [...splits],
    scopes,
    address: { level: "project", agent: "alpha", item: "system:role", section: null },
  }).assembled
}

function headings(text: string): string[] {
  return text.split("\n").filter((line) => /^#{1,6} /.test(line))
}

function input(records: readonly CustomizationRecord[], splits: readonly SplitRecord[] = []): MemoInput {
  return {
    items: [item],
    records: [...records, ...splits],
    agents: [
      { id: "alpha", scope: "project" },
      { id: "alpha", scope: "global" },
    ],
    links: [
      { type: "link", level: "project", agent: "alpha", preset: { kind: "agent", id: "build" }, updated: UPDATED },
    ],
    teams: [],
  }
}

function rowId(memo: MemoInput, id: string): string {
  const node = expandedTree(memo).find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`no row ${id}`)
  return node.id
}

const PARENT_GLOBAL = "# Seat\n\n## Role\nR2.\n\n## Routing\nOld routing.\n\n## Merges\nM.\n"

test("a parent's full-span customization sends each heading once, with the child's edit", () => {
  const text = assembled([
    rec("global", "seat", PARENT_GLOBAL),
    rec("global", "seat/routing", "## Routing\nNew routing.\n"),
  ])
  expect(headings(text)).toEqual(SEAT_HEADINGS)
  expect(text).toContain("R2.")
  expect(text).toContain("New routing.")
  expect(text).not.toContain("Old routing.")
})

test("a child at a more specific level than the parent's copy wins", () => {
  const text = assembled([
    rec("global", "seat", PARENT_GLOBAL),
    rec("project", "seat/routing", "## Routing\nProject routing.\n"),
  ])
  expect(headings(text)).toEqual(SEAT_HEADINGS)
  expect(text).toContain("Project routing.")
  expect(text).not.toContain("Old routing.")
})

test("a child at a less specific level loses to the parent's copy, and a write to it says so", () => {
  const records = [
    rec("global", "seat", PARENT_GLOBAL),
    rec("defaults", "seat/routing", "## Routing\nDefaults routing.\n"),
  ]
  const text = assembled(records)
  expect(headings(text)).toEqual(SEAT_HEADINGS)
  expect(text).toContain("Old routing.")
  expect(text).not.toContain("Defaults routing.")
  const row = rowId(input(records), "section:defaults::system:role:seat/routing")
  const result = saveText(input(records), row, "## Routing\nEdited defaults routing.\n")
  if ("refusal" in result) throw new Error(result.refusal)
  expect(result.notice).toBe(
    'Saved, but "Seat" (section:global:alpha:system:role:seat) at Global replaces this text; edit or reset that row for this change to take effect.',
  )
  expect(result.status).toBe(result.notice ?? "")
})

test("a child whose heading the parent's text no longer has is not sent, and a write to it says so", () => {
  const parentWithoutMerges = "# Seat\n\n## Role\nR.\n\n## Routing\nOld routing.\n"
  const records = [rec("global", "seat", parentWithoutMerges)]
  const text = assembled(records)
  expect(text).not.toContain("## Merges")
  expect(text).not.toContain("M.")
  const row = rowId(input(records), "section:defaults::system:role:seat/merges")
  const result = saveText(input(records), row, "## Merges\nEdited merges.\n")
  if ("refusal" in result) throw new Error(result.refusal)
  expect(result.notice).toBe(
    'Saved, but "Seat" (section:global:alpha:system:role:seat) at Global replaces this text; edit or reset that row for this change to take effect.',
  )
})

test("saving a parent drops the same-level child records inside its span and keeps the more specific ones", () => {
  const records = [
    rec("global", "seat", PARENT_GLOBAL),
    rec("global", "seat/routing", "## Routing\nGlobal child.\n"),
    rec("project", "seat/routing", "## Routing\nProject child.\n"),
  ]
  const row = rowId(input(records), "section:global:alpha:system:role:seat")
  const parentText = "# Seat\n\n## Role\nR.\n\n## Routing\nParent routing.\n\n## Merges\nM.\n"
  const result = saveText(input(records), row, parentText)
  if ("refusal" in result) throw new Error(result.refusal)
  expect(
    result.records.some(
      (record) => record.level === "global" && record.section === "seat/routing" && record.text !== undefined,
    ),
  ).toBe(false)
  expect(
    result.records.some(
      (record) =>
        record.level === "project" &&
        record.section === "seat/routing" &&
        record.text === "## Routing\nProject child.\n",
    ),
  ).toBe(true)
  expect(result.notice).toBeUndefined()
  const editor = resolve({
    upstream: item,
    records: [...result.records],
    splits: [],
    scopes,
    address: { level: "project", agent: "alpha", item: "system:role", section: "seat" },
  }).text
  expect(editor).toContain("Project child.")
  expect(editor).not.toContain("Parent routing.")
})

const MANUAL: SplitRecord = {
  type: "split",
  level: "defaults",
  agent: null,
  item: "system:role",
  boundaries: [
    { id: "seat", name: "Seat", start: 0, depth: 0 },
    { id: "routing", name: "Routing", start: SEAT.indexOf("## Routing"), depth: 1 },
    { id: "merges", name: "Merges", start: SEAT.indexOf("## Merges"), depth: 1 },
  ],
  updated: UPDATED,
}

test("a manual split's overridden parent replaces its span, and a child write under it says so", () => {
  const records = [rec("global", "seat", "# Seat\n\nReplaced seat text.\n")]
  const text = assembled(records, [MANUAL])
  expect(text).toContain("Replaced seat text.")
  expect(text).not.toContain("Old routing.")
  const row = rowId(input(records, [MANUAL]), "section:project:alpha:system:role:routing")
  const result = saveText(input(records, [MANUAL]), row, "Project routing.")
  if ("refusal" in result) throw new Error(result.refusal)
  expect(result.notice).toBe(
    'Saved, but "Seat" (section:global:alpha:system:role:seat) at Global replaces this text; edit or reset that row for this change to take effect.',
  )
})

test("adding a section under a manual section without a parent customization shows the new child", () => {
  const memo = input([], [MANUAL])
  const result = addSection(memo, "section:project:alpha:system:role:seat", "Extra", "Added child text.")
  if ("refusal" in result) throw new Error(result.refusal)
  expect(assembled(result.records, result.splits)).toContain("Added child text.")
})

test("no ancestor customization gives no notice, and a write to the parent itself never gives one", () => {
  const child = saveText(
    input([]),
    rowId(input([]), "section:project:alpha:system:role:seat/routing"),
    "## Routing\nMine.\n",
  )
  if ("refusal" in child) throw new Error(child.refusal)
  expect(child.notice).toBeUndefined()
  const stateOnly: CustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "system:role",
    section: "seat",
    state: "on",
    basedOn: fingerprint(SEAT),
    updated: UPDATED,
  }
  const parent = saveText(
    input([stateOnly]),
    rowId(input([stateOnly]), "section:project:alpha:system:role:seat"),
    PARENT_GLOBAL,
  )
  if ("refusal" in parent) throw new Error(parent.refusal)
  expect(parent.notice).toBeUndefined()
})

test("a Defaults write for one agent is checked from that agent's Project view", () => {
  const records = [rec("project", "seat", PARENT_GLOBAL)]
  const memo = { ...input(records), agents: [...input(records).agents, { id: "alpha", scope: "defaults" as const }] }
  const row = rowId(memo, "section:defaults:alpha:system:role:seat/routing")
  const result = saveText(memo, row, "## Routing\nDefaults for alpha.\n")
  if ("refusal" in result) throw new Error(result.refusal)
  expect(result.notice).toBe(
    'Saved, but "Seat" (section:project:alpha:system:role:seat) at Project replaces this text; edit or reset that row for this change to take effect.',
  )
})

test("saving a whole heading item with an edited child keeps that edit at its level, each heading once", () => {
  const records = [rec("project", "seat/routing", "## Routing\nOld project child.\n")]
  const whole = "# Seat\n\n## Role\nR.\n\n## Routing\nWhole routing.\n\n## Merges\nM.\n\n# Tail\n\nT.\n"
  const result = saveText(input(records), rowId(input(records), "item:project:alpha:system:role"), whole)
  if ("refusal" in result) throw new Error(result.refusal)
  expect(result.records.some((record) => record.level === "project" && record.section === "seat/routing" && record.text?.includes("Whole routing."))).toBe(true)
  const text = resolve({
    upstream: item,
    records: [...result.records],
    splits: [],
    scopes,
    address: { level: "project", agent: "alpha", item: "system:role", section: null },
  }).assembled
  expect(headings(text)).toEqual(SEAT_HEADINGS)
  expect(text).toContain("Whole routing.")
  expect(text).not.toContain("Old project child.")
})
