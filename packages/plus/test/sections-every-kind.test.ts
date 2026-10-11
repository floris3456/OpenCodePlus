// B7 (I1b): every text row takes sections through the same section path as
// tools and system rows. This file covers the item-row kinds that are now
// sectioned: MCP tool descriptions (group "mcp"), tool parameter descriptions
// and the agent/member description control. The MCP server row is not
// sectioned (B38): its text is configuration with no per-request consumer.
//
// The keep-alive prompt and the C1 per-model compaction instructions are
// values on model records, not item rows, and the tree resolves them without
// any resolve()/assemble path; sectioning them would need a parallel assembly
// and a parallel write path (see the run report). The legacy agent-wide
// `compaction:instructions` control row is still resolved for inheritance but
// is no longer listed (I2a removed the Compaction tab), so it has no row to
// section either.
import { expect, test } from "bun:test"
import { fingerprint, resolve, resolveSplit, type CustomizationRecord, type Item, type SplitRecord } from "../src/instructions/model.js"
import { controlItems } from "../src/instructions/agent-controls.js"
import { addSection, saveSplit } from "../src/instructions/ops.js"
import { expandedTree } from "../src/instructions/tree.js"
import type { MemoInput, TreeNode } from "../src/instructions/tree.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const HEADED = "# Purpose\n\nRun the thing.\n\n# Usage\n\nPass a flag.\n"

function item(id: string, kind: Item["kind"], text: string, overrides: Partial<Item> = {}): Item {
  return {
    id,
    kind,
    group: "none",
    title: id.slice(id.indexOf(":") + 1),
    text,
    enabled: true,
    fingerprint: fingerprint(text),
    ...overrides,
  }
}

const MCP_TOOL = item("tool:search_docs", "tool", HEADED, { group: "mcp", server: "docs", codemode: false })
const PARAM = item("param:search_docs:query", "param", HEADED, { group: "mcp", server: "docs", paramTool: "search_docs", paramType: "string" })
const MCP_SERVER = item("mcp:docs", "mcp", HEADED)
const CONTROLS = controlItems("alpha", { description: HEADED, compaction: { system: HEADED, strategy: "auto" } })

function input(overrides: Partial<MemoInput> = {}): MemoInput {
  return {
    items: [MCP_TOOL, PARAM, MCP_SERVER, ...CONTROLS],
    records: [],
    agents: [{ id: "alpha", scope: "project", origin: "user" }],
    teams: [],
    ...overrides,
  }
}

function nodeById(nodes: readonly TreeNode[], id: string): TreeNode {
  const node = nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`no row ${id}`)
  return node
}

function wholeText(source: MemoInput, id: string): string {
  const found = source.items.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no item ${id}`)
  return resolve({
    upstream: found,
    records: (source.records ?? []).filter((r): r is CustomizationRecord => r.type === "customization"),
    splits: (source.records ?? []).filter((r): r is SplitRecord => r.type === "split"),
    scopes: { global: new Set(["alpha"]), defaults: new Set(), native: new Set(["alpha"]) },
    address: { level: "project", agent: "alpha", item: id, section: null },
  }).assembled
}

// ---------------------------------------------------------------------------
// Tree: section rows under every new kind, with add: "section".
// ---------------------------------------------------------------------------

test("MCP server row takes no sections: no add offer and split is refused", () => {
  const source = input()
  const nodes = expandedTree(source)
  const row = nodeById(nodes, "item:defaults::mcp:docs")
  expect(row.add).toBeUndefined()
  expect(row.actions?.split).toBe(false)
  const split = saveSplit(source, row.id, [{ id: "a", name: "A", start: 0 }])
  if (!("refusal" in split)) throw new Error("expected refusal")
  expect(split.refusal).toBe(`"docs" cannot be split`)
})

test("MCP tool description takes sections through the tool path", () => {
  const nodes = expandedTree(input())
  const row = nodeById(nodes, "item:project:alpha:tool:search_docs")
  expect(row.add).toBe("section")
  expect(row.actions?.split).toBe(true)
  const description = nodeById(nodes, "item:project:alpha:tool:search_docs:description")
  expect(description.kind).toBe("section")
  expect(description.actions?.edit).toBe(true)
  expect(nodes.some((node) => node.id.includes("tool:search_docs:purpose"))).toBe(true)
})

test("tool parameter description takes sections and offers add", () => {
  const nodes = expandedTree(input())
  const row = nodeById(nodes, "item:project:alpha:param:search_docs:query")
  expect(row.kind).toBe("item")
  expect(row.add).toBe("section")
  expect(row.actions?.split).toBe(true)
  expect(nodes.filter((node) => node.id.startsWith(row.id.replace(/^item:/, "section:") + ":")).map((section) => section.label)).toEqual(["Purpose", "Usage"])
})

test("the agent description control takes sections while scalar controls do not", () => {
  const nodes = expandedTree(input())
  const description = nodeById(nodes, "item:project:alpha:setting:description")
  expect(description.add).toBe("section")
  expect(description.actions?.split).toBe(true)
  expect(nodes.some((node) => node.id === "section:project:alpha:setting:description:purpose")).toBe(true)

  const mode = nodeById(nodes, "item:project:alpha:setting:mode")
  expect(mode.add).toBeUndefined()
  expect(mode.actions?.split).toBe(false)
})

// ---------------------------------------------------------------------------
// Ops: split with add on the item and on a section, B31 placement.
// ---------------------------------------------------------------------------

test("split then add on a parameter item writes a manual split and a section record", () => {
  const source = input()
  const row = nodeById(expandedTree(source), "item:project:alpha:param:search_docs:query")
  const split = saveSplit(source, row.id, [
    { id: "purpose", name: "Purpose", start: 0 },
    { id: "usage", name: "Usage", start: HEADED.indexOf("# Usage") },
  ])
  if ("refusal" in split) throw new Error(`expected split success ${split.refusal}`)
  const withSplit = input({ records: split.splits })
  const sectionRow = nodeById(expandedTree(withSplit), "section:project:alpha:param:search_docs:query:usage")
  const added = addSection(withSplit, sectionRow.id, "Flags", "Pass --verbose.")
  if ("refusal" in added) throw new Error(`expected add success ${added.refusal}`)
  const splitRecord = added.splits.find((entry) => entry.item === PARAM.id)
  if (!splitRecord) throw new Error("expected split record")
  const boundary = splitRecord.boundaries.find((entry) => entry.name === "Flags")
  expect(boundary).toBeDefined()
  // B31: a child boundary sits right after its parent's last descendant, at
  // depth + 1, and the new text lives only in the new section's record.
  expect(boundary?.depth).toBe(1)
  const record = added.records.find((entry) => entry.item === PARAM.id && entry.section === boundary!.id)
  if (!record) throw new Error("expected section record")
  expect(record.text).toBe("Pass --verbose.")
})

test("add on an MCP server row is refused and writes no section record", () => {
  const source = input()
  const row = nodeById(expandedTree(source), "item:defaults::mcp:docs")
  const added = addSection(source, row.id, "Endpoints", "List endpoints.")
  if (!("refusal" in added)) throw new Error("expected refusal")
  expect(added.refusal).toBe(`"docs" does not support sections`)
})

test("add on a multi-heading agent description preserves the original siblings", () => {
  const source = input()
  const row = nodeById(expandedTree(source), "item:project:alpha:setting:description")
  const added = addSection(source, row.id, "Details", "More detail.")
  if ("refusal" in added) throw new Error(`expected add success ${added.refusal}`)
  expect(added.splits.some((entry) => entry.item === "setting:description")).toBe(false)
  const text = wholeText({ ...source, records: added.records }, "setting:description")
  expect(text).toBe(`${HEADED}\n# Details\n\nMore detail.`)
  const sections = expandedTree({ ...source, records: added.records }).filter((node) => node.address?.agent === "alpha" && node.address.level === "project" && node.address.item === "setting:description" && node.address.section !== null)
  expect(sections.map((node) => node.label)).toEqual(["Purpose", "Usage", "Details"])
  expect(new Set(sections.map((node) => node.depth)).size).toBe(1)
})

test("add on a tool's whole-text Description appends a sibling heading", () => {
  const source = input()
  const added = addSection(source, "item:project:alpha:tool:search_docs:description", "Details", "More detail.")
  if ("refusal" in added) throw new Error(added.refusal)
  expect(wholeText({ ...source, records: added.records }, MCP_TOOL.id)).toBe(`${HEADED}\n# Details\n\nMore detail.`)
})

// ---------------------------------------------------------------------------
// Assembly: the consumer receives the assembled text.
// ---------------------------------------------------------------------------

test("a section switched off is absent from the assembled parameter text", () => {
  const source = input()
  const records: CustomizationRecord[] = [
    { type: "customization", level: "project", agent: "alpha", item: PARAM.id, section: "usage", state: "off", basedOn: fingerprint("x"), updated: UPDATED },
  ]
  const text = wholeText({ ...source, records }, PARAM.id)
  expect(text).toContain("Run the thing.")
  expect(text).not.toContain("Pass a flag.")
})

test("an edited description section reaches the assembled description the model reads", () => {
  const source = input()
  const records: CustomizationRecord[] = [
    { type: "customization", level: "project", agent: "alpha", item: "setting:description", section: "usage", text: "# Usage\n\nEdited usage.", basedOn: fingerprint("x"), updated: UPDATED },
  ]
  const text = wholeText({ ...source, records }, "setting:description")
  expect(text).toContain("Edited usage.")
  expect(text).toContain("Run the thing.")
})

// Sanity: the section path used above derives the expected ids for this text.
test("the shared split path derives the same section ids the tree shows", () => {
  const split = resolveSplit({
    text: HEADED,
    title: "Docs",
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
    address: { level: "project", agent: "alpha", item: MCP_SERVER.id, section: null },
  })
  expect(split.sections.map((section) => section.id)).toEqual(["purpose", "usage"])
})
