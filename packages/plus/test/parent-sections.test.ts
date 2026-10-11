import { expect, test } from "bun:test"
import {
  fingerprint,
  resolve,
  type Address,
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

test("live Parent add, Child edit and Parent save retain the outside Sibling", () => {
  const text = "# Parent\n\nPARENT_CANARY\n\n## Child\n\nCHILD_CANARY\n\n# Sibling\n\nSIBLING_CANARY\n"
  const upstream = { ...item, text, fingerprint: fingerprint(text) }
  const fixture = (records: readonly CustomizationRecord[]): MemoInput => ({ ...input(records), items: [upstream] })
  const added = addSection(fixture([]), "section:global:alpha:system:role:parent", "Added", "ADDED_CANARY")
  if ("refusal" in added) throw new Error(added.refusal)
  const edited = saveText(fixture(added.records), "section:global:alpha:system:role:parent/child", "## Child\n\nCHILD_CANARY\n\nCHILD_EDIT_CANARY\n")
  if ("refusal" in edited) throw new Error(edited.refusal)
  const parent = resolve({ upstream, records: edited.records, splits: [], scopes, address: { level: "global", agent: "alpha", item: item.id, section: "parent" } }).text
  const saved = saveText(fixture(edited.records), "section:global:alpha:system:role:parent", parent + "PARENT_EDIT_CANARY")
  if ("refusal" in saved) throw new Error(saved.refusal)
  const full = resolve({ upstream, records: saved.records, splits: [], scopes, address: { level: "global", agent: "alpha", item: item.id, section: null } }).fullText!
  expect(headings(full)).toEqual(["# Parent", "## Child", "## Added", "# Sibling"])
  for (const canary of ["PARENT_CANARY", "CHILD_CANARY", "CHILD_EDIT_CANARY", "ADDED_CANARY", "PARENT_EDIT_CANARY", "SIBLING_CANARY"]) expect(full.split(canary)).toHaveLength(2)
  expect(expandedTree(fixture(saved.records)).filter((row) => row.kind === "section" && row.address?.level === "global" && row.address.item === "system:role").map((row) => row.label)).toEqual(["Description", "Parent", "Child", "Added", "Sibling"])
})

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

// The a36 live defect: Role with `## Parent` + `### Child` + `## Other`. `a` on
// Parent added `### Added` as Child's sibling, but the old add wrote the sibling
// into Child's own override, so Child's editor contained Added. B39: the write
// is Parent's effective full span, the child editor stays its own slice.
const DOC = "## Parent\nP.\n\n### Child\nC.\n\n## Other\nO.\n"
const docItem: Item = {
  id: "system:doc",
  kind: "system",
  group: "none",
  title: "Doc",
  text: DOC,
  enabled: true,
  fingerprint: fingerprint(DOC),
  agents: ["alpha"],
}

const docScopes: Scopes = { global: new Set(["alpha"]), defaults: new Set(["alpha"]) }

function docRec(level: "project" | "global" | "defaults", section: string, text: string): CustomizationRecord {
  return {
    type: "customization",
    level,
    agent: level === "defaults" ? null : "alpha",
    item: "system:doc",
    section,
    text,
    basedOn: fingerprint(DOC),
    updated: UPDATED,
  }
}

function docInput(records: readonly CustomizationRecord[], splits: readonly SplitRecord[] = []): MemoInput {
  return {
    items: [
      docItem,
      { id: "tool:plain", kind: "tool", group: "native", title: "plain", text: "plain body", enabled: true, fingerprint: fingerprint("plain body") },
      { id: "mcp:docs", kind: "mcp", group: "none", title: "docs", text: "server config", enabled: true, fingerprint: fingerprint("server config") },
    ],
    records: [...records, ...splits],
    agents: [
      { id: "alpha", scope: "project" },
      { id: "alpha", scope: "global" },
    ],
    links: [{ type: "link", level: "project", agent: "alpha", preset: { kind: "agent", id: "build" }, updated: UPDATED }],
    teams: [],
  }
}

function docRow(memo: MemoInput, section: string | null, item = "system:doc", level: Address["level"] = "project"): string {
  const node = expandedTree(memo).find(
    (candidate) =>
      candidate.address?.item === item &&
      candidate.address?.section === section &&
      candidate.address?.level === level &&
      candidate.address?.team === undefined,
  )
  if (node === undefined) throw new Error(`no ${level} ${item} row (section ${section})`)
  return node.id
}

function docAssembled(records: readonly CustomizationRecord[], splits: readonly SplitRecord[] = []): string {
  return resolve({
    upstream: docItem,
    records: [...records],
    splits: [...splits],
    scopes: docScopes,
    address: { level: "project", agent: "alpha", item: "system:doc", section: null },
  }).assembled
}

function docSection(records: readonly CustomizationRecord[], splits: readonly SplitRecord[], id: string): string {
  return resolve({
    upstream: docItem,
    records: [...records],
    splits: [...splits],
    scopes: docScopes,
    address: { level: "project", agent: "alpha", item: "system:doc", section: id },
  }).text
}

test("adding under Parent writes Parent's full span: Child's editor excludes the sibling, the item has each heading once", () => {
  const memo = docInput([])
  const added = addSection(memo, docRow(memo, "parent"), "Added", "Added text.")
  if ("refusal" in added) throw new Error(added.refusal)

  // One record, on Parent's address, holding Parent's span plus the new child.
  const own = added.records.filter((record) => record.item === "system:doc")
  expect(own).toHaveLength(1)
  expect(own[0].section).toBe("parent")

  const childEditor = docSection(added.records, added.splits, "parent/child")
  expect(childEditor).toContain("C.")
  expect(childEditor).not.toContain("Added")

  const parentEditor = docSection(added.records, added.splits, "parent")
  expect(parentEditor).toContain("### Child")
  expect(parentEditor).toContain("### Added")

  const whole = docAssembled(added.records, added.splits)
  expect(headings(whole)).toEqual(["## Parent", "### Child", "### Added", "## Other"])
  expect(whole.match(/### Added/g)).toHaveLength(1)
  expect(whole).toContain("Added text.")
})

test("a parent add folds a consumed same-level child edit once, and a parent save keeps the children on reload", () => {
  const memo = docInput([docRec("project", "parent/child", "### Child\nEdited child.\n")])
  const added = addSection(memo, docRow(memo, "parent"), "Added", "Added text.")
  if ("refusal" in added) throw new Error(added.refusal)

  // The child's edited text survives inside Parent's span; the consumed
  // same-level child record is gone, so an older record cannot undo the add.
  const parentRecord = added.records.find((record) => record.item === "system:doc" && record.section === "parent")
  expect(parentRecord?.text).toContain("Edited child.")
  expect(added.records.some((record) => record.section === "parent/child" && record.text !== undefined)).toBe(false)
  const whole = docAssembled(added.records, added.splits)
  expect(headings(whole)).toEqual(["## Parent", "### Child", "### Added", "## Other"])
  expect(whole.match(/Child/g)).toHaveLength(1)
  expect(whole).toContain("Edited child.")

  // A parent edit then reload keeps both children exactly once.
  const reload = docInput(added.records, added.splits)
  const saved = saveText(reload, docRow(reload, "parent"), "## Parent\nP2.\n\n### Child\nC2.\n\n### Added\nA2.\n")
  if ("refusal" in saved) throw new Error(saved.refusal)
  const after = docAssembled(saved.records, saved.splits)
  expect(headings(after)).toEqual(["## Parent", "### Child", "### Added", "## Other"])
  expect(after).toContain("P2.")
  expect(after).toContain("C2.")
  expect(after).toContain("A2.")
  expect(after).toContain("O.")
})

test("a more-specific child override stays effective after a less-specific parent add", () => {
  const records = [
    docRec("global", "parent", "## Parent\nGlobal parent.\n\n### Child\nGlobal child.\n"),
    docRec("project", "parent/child", "### Child\nProject child.\n"),
  ]
  const memo = docInput(records)
  const added = addSection(memo, docRow(memo, "parent", "system:doc", "global"), "Added", "Added text.")
  if ("refusal" in added) throw new Error(added.refusal)

  // The Project child is more specific than the Global parent, so it stays a
  // record and keeps winning inside the parent's span.
  expect(added.records.some((record) => record.level === "project" && record.section === "parent/child" && record.text === "### Child\nProject child.\n")).toBe(true)
  const whole = docAssembled(added.records, added.splits)
  expect(headings(whole)).toEqual(["## Parent", "### Child", "### Added", "## Other"])
  expect(whole).toContain("Project child.")
  expect(whole).not.toContain("Global child.")
  expect(whole.match(/Child/g)).toHaveLength(1)
})

test("an invalid or protected add refuses and writes nothing", () => {
  const memo = docInput([])
  const missing = addSection(memo, "section:project:alpha:system:doc:missing", "X", "x")
  if (!("refusal" in missing)) throw new Error("expected missing-section refusal")
  expect("records" in missing).toBe(false)
  const unsupported = addSection(memo, docRow(memo, null, "mcp:docs", "defaults"), "X", "x")
  if (!("refusal" in unsupported)) throw new Error("expected unsupported refusal")
  expect(unsupported.refusal).toBe(`"docs" does not support sections`)
  expect("records" in unsupported).toBe(false)
})
