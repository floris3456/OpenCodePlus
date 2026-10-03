import { expect, test } from "bun:test"
import { fingerprint, type AgentSource, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { buildTreeMemo, tree, type TeamInput } from "../src/instructions/tree.js"
import { reviewTargets, toolCountOf, toolWords, workspaceOf, type WorkspaceInput } from "../src/tui/instructions/workspace.js"

const agents: AgentSource[] = [
  { id: "build", scope: "defaults", origin: "native", base: "gpt" },
  { id: "Implementer", scope: "project", origin: "user", base: "gpt" },
]

function item(id: string, kind: Item["kind"], title: string, text: string, group: Item["group"] = "native"): Item {
  return { id, kind, group, title, text, enabled: true, fingerprint: fingerprint(text) }
}

const items: Item[] = [
  item("tool:bash", "tool", "bash", "run commands"),
  item("tool:read", "tool", "read", "read files"),
  item("base:gpt", "base", "gpt.txt", "gpt base\n", "none"),
]

const teams: TeamInput[] = [{ level: "project", team: "crew", enabled: true, agents: ["helper"] }]

function rowsOf(records: CustomizationRecord[] = [], source: readonly Item[] = items) {
  let calls = 0
  return {
    calls: () => calls,
    rows: (open: ReadonlySet<string>) => {
      calls += 1
      return tree({ items: source, records, agents, teams, expanded: open })
    },
  }
}

function input(rows: WorkspaceInput["rows"], overrides: Partial<WorkspaceInput> = {}): WorkspaceInput {
  return { rows, level: "project", navCollapsed: new Set(), listOpen: new Set(), listCollapsed: new Set(), ...overrides }
}

test("the sidebar lists catalogues, origins, owners and teams with their members, never categories", () => {
  const source = rowsOf()
  const ws = workspaceOf(input(source.rows))
  const nav = ws.nav.map((row) => `${"  ".repeat(row.depth)}${row.role} ${row.label}`)
  expect(nav).toContain("catalogue Agents")
  expect(nav).toContain("    owner build")
  expect(nav).toContain("    owner Implementer")
  expect(nav).toContain("catalogue Teams")
  expect(nav).toContain("  container crew")
  expect(nav).toContain("    owner helper")
  expect(ws.nav.some((row) => /:(settings|tools|base)$/.test(row.node.id))).toBe(false)
  // The first owner shows by default, with its categories as tabs.
  expect(ws.owner?.key).toBe("agent:project:build")
  // No Skills tab: skills live under Tools › skill › Permissions › Skills.
  expect(ws.categories.map((node) => node.label)).toEqual(["Settings", "Models", "Compaction", "Tools", "Base", "System"])
  expect(ws.category?.label).toBe("Settings")
})

test("the list is the category's own subtree, its origin subgroups open by default", () => {
  const source = rowsOf()
  const ws = workspaceOf(input(source.rows, { owner: "agent:project:Implementer", category: "group:project:Implementer:tools" }))
  expect(ws.list.map((row) => `${row.depth} ${row.label}${row.expandable ? (row.expanded ? " -" : " +") : ""}`)).toEqual([
    "0 OpenCode -",
    "1 bash +",
    "1 read +",
    "0 OpenCodePlus -",
    "0 MCP -",
  ])
  // Opening an item shows its sections below it.
  const opened = workspaceOf(input(source.rows, {
    owner: "agent:project:Implementer",
    category: "group:project:Implementer:tools",
    listOpen: new Set(["item:project:Implementer:tool:bash"]),
  }))
  expect(opened.list.find((row) => row.label === "bash")?.expanded).toBe(true)
  expect(opened.list.some((row) => row.node.kind === "section" && row.depth === 2)).toBe(true)
})

test("a collapsed subgroup stays collapsed and a collapsed sidebar group hides its owners", () => {
  const source = rowsOf()
  const ws = workspaceOf(input(source.rows, {
    owner: "agent:project:Implementer",
    category: "group:project:Implementer:tools",
    listCollapsed: new Set(["group:project:Implementer:tools:native"]),
    navCollapsed: new Set(["group:project:agents:native"]),
  }))
  expect(ws.list.map((row) => row.label)).toEqual(["OpenCode", "OpenCodePlus", "MCP"])
  expect(ws.nav.some((row) => row.label === "build")).toBe(false)
  expect(ws.nav.find((row) => row.node.id === "group:project:agents:native")?.expanded).toBe(false)
})

test("Defaults shows the catalogue's own settings as an Every agent owner", () => {
  const source = rowsOf()
  const ws = workspaceOf(input(source.rows, { level: "defaults", owner: "group:defaults:agents#every", category: "group:defaults::tools" }))
  const every = ws.nav.find((row) => row.role === "every" && row.label === "Every agent")
  expect(every?.node.id).toBe("group:defaults:agents")
  expect(ws.owner?.key).toBe("group:defaults:agents#every")
  expect(ws.categories.map((node) => node.id)).toContain("group:defaults::tools")
  expect(ws.list.some((row) => row.node.id === "item:defaults::tool:bash")).toBe(true)
  expect(ws.nav.find((row) => row.label === "Every member")?.node.id).toBe("group:defaults:teams")
})

test("a steady view builds the tree once; structure is remembered between calls", () => {
  const source = rowsOf()
  const known = new Set<string>()
  workspaceOf(input(source.rows, { owner: "agent:project:Implementer" }), known)
  const first = source.calls()
  expect(first).toBeGreaterThan(1)
  workspaceOf(input(source.rows, { owner: "agent:project:Implementer" }), known)
  expect(source.calls() - first).toBe(1)
})

test("parents give every emitted row its parent for breadcrumbs and dialogs", () => {
  const source = rowsOf()
  const ws = workspaceOf(input(source.rows, { owner: "agent:project:Implementer", category: "group:project:Implementer:models" }))
  expect(ws.parents.get("group:project:Implementer:models")?.id).toBe("agent:project:Implementer")
  expect(ws.parents.get("agent:project:Implementer")?.id).toBe("group:project:agents:user")
})

test("review targets name the owner, category and rows to open for every row under review", () => {
  const above = fingerprint("old bash text")
  const records: CustomizationRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "Implementer",
      item: "tool:bash",
      section: null,
      text: "my bash text",
      basedOn: above,
      basedOnText: "old bash text",
      updated: "2026-09-27T00:00:00.000Z",
    },
  ]
  const source = rowsOf(records)
  const targets = reviewTargets(source.rows, "project")
  expect(targets).toEqual([
    {
      owner: "agent:project:Implementer",
      category: "group:project:Implementer:tools",
      row: "item:project:Implementer:tool:bash",
      open: ["group:project:Implementer:tools:native"],
    },
  ])
  expect(reviewTargets(source.rows, "global")).toEqual([])
})

test("tool counts read each owner's switched-on tools and split out Code Mode", () => {
  // A plain tool, a Code Mode tool (reached only through `execute`) and a
  // pinned Code Mode tool (its own direct row): all scoped to build alone.
  const tools: Item[] = [
    { ...item("tool:bash", "tool", "bash", "run commands"), agents: ["build"] },
    { ...item("tool:coder", "tool", "coder", "code mode tool"), agents: ["build"], codemode: true },
    { ...item("tool:writer", "tool", "writer", "pinned code mode tool"), agents: ["build"], codemode: true, pinned: true },
  ]
  const memo = buildTreeMemo({ items: tools, records: [], agents, teams })
  const codemode = (id: string) => tools.some((entry) => entry.id === id && entry.codemode === true)
  const build = toolCountOf(memo, "agent:project:build", codemode)
  expect(build).toEqual({ on: 3, codemode: 1, total: 3 })
  expect(toolWords(build!)).toBe("3 tools on (2 direct, 1 through Code Mode)")
  // An agent the tool rows do not name reads zero, not a missing entry.
  const implementer = toolCountOf(memo, "agent:project:Implementer", codemode)
  expect(implementer).toEqual({ on: 0, codemode: 0, total: 0 })
  expect(toolWords(implementer!)).toBe("no tools on")
})

test("tool counts key the shared Defaults inventories by their Every agent row", () => {
  const tools: Item[] = [
    item("tool:bash", "tool", "bash", "run commands"),
    { ...item("tool:coder", "tool", "coder", "code mode tool"), codemode: true },
  ]
  // Shared inventory rows fall back to off, so the on counts come from the
  // Defaults records each catalogue reads.
  const records: CustomizationRecord[] = tools.flatMap((entry) => [
    {
      type: "customization",
      level: "defaults",
      agent: null,
      item: entry.id,
      section: null,
      state: "on",
      basedOn: entry.fingerprint,
      updated: "2026-09-27T00:00:00.000Z",
    },
    {
      type: "customization",
      level: "defaults",
      agent: null,
      catalogue: "teams",
      item: entry.id,
      section: null,
      state: "on",
      basedOn: entry.fingerprint,
      updated: "2026-09-27T00:00:00.000Z",
    },
  ])
  const memo = buildTreeMemo({ items: tools, records, agents, teams })
  const codemode = (id: string) => tools.some((entry) => entry.id === id && entry.codemode === true)
  expect(toolCountOf(memo, "group:defaults:agents#every", codemode)).toEqual({ on: 2, codemode: 1, total: 2 })
  expect(toolCountOf(memo, "group:defaults:teams#every", codemode)).toEqual({ on: 2, codemode: 1, total: 2 })
})
