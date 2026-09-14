import { RGBA, TextAttributes } from "@opentui/core"
import { expect, test } from "bun:test"
import { fingerprint, type AgentSource, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { tree } from "../src/instructions/tree.js"
import {
  displayLevel,
  excludedAttributes,
  excludedRanges,
  isExcludedOffset,
  parentItemTitle,
  provenanceLine,
  resolvedText,
  sectionExcluded,
  sectionRows,
} from "../src/tui/instructions/detail-pane.js"
import { badgeColor, badgeLabels, hasVisibleChildren, isExpandableRow, isReviewLabel, rowMarker } from "../src/tui/instructions/tree-pane.js"
import type { Snapshot } from "../src/rpc.js"

const UPDATED = "2026-09-14T00:00:00.000Z"
const ROLE_TEXT = "# Purpose\n\na\n\n# Usage\n\nb\n"

function agents(): AgentSource[] {
  return [
    { id: "Implementer", scope: "project", base: "gpt" },
    { id: "Helper", scope: "global", base: "claude" },
  ]
}

function items(): Item[] {
  const role: Item = {
    id: "system:role",
    kind: "system",
    group: "none",
    title: "Role",
    text: ROLE_TEXT,
    enabled: true,
    fingerprint: fingerprint(ROLE_TEXT),
  }
  const bash: Item = {
    id: "tool:bash",
    kind: "tool",
    group: "native",
    title: "bash",
    text: "run commands",
    enabled: true,
    fingerprint: fingerprint("run commands"),
  }
  const gpt: Item = {
    id: "base:gpt",
    kind: "base",
    group: "none",
    title: "gpt.txt",
    text: "gpt base",
    enabled: true,
    fingerprint: fingerprint("gpt base"),
  }
  return [role, bash, gpt]
}

function record(overrides?: Partial<CustomizationRecord> & { type?: "customization" }): CustomizationRecord {
  const text = "default text"
  return {
    type: "customization",
    level: "project",
    agent: "Implementer",
    item: "tool:bash",
    section: null,
    basedOn: fingerprint(text),
    updated: UPDATED,
    ...overrides,
  }
}

function expandAll(): ReturnType<typeof tree> {
  return tree({ items: items(), records: [], agents: agents(), expanded: new Set(allIds({ items: items(), records: [], agents: agents() })) })
}

function allIds(input: { items: Item[]; records: CustomizationRecord[]; agents: AgentSource[] }): string[] {
  const expanded = new Set<string>()
  let previous = -1
  let nodes = tree({ ...input, expanded })
  while (previous !== expanded.size) {
    previous = expanded.size
    nodes = tree({ ...input, expanded })
    for (const node of nodes) expanded.add(node.id)
  }
  return [...expanded]
}

function snapshot(records: Snapshot["records"]): Snapshot {
  return {
    revision: 1,
    globalRevision: 1,
    agents: [
      { id: "Implementer", scope: "project", base: "gpt", fileBacked: true },
      { id: "Helper", scope: "global", base: "claude", fileBacked: true },
    ],
    items: items().map((item) => ({
      id: item.id,
      kind: item.kind,
      group: item.group,
      title: item.title,
      text: item.text,
      enabled: item.enabled,
      fingerprint: item.fingerprint,
    })),
    records,
    servers: [],
    protectedAgents: [],
  }
}

function yellowOnly(label: string): boolean {
  return isReviewLabel(label)
}

test("roots render with depth, badges, and collapsed review roll-up", () => {
  const nodes = tree({ items: items(), records: [], agents: agents(), expanded: new Set() })
  expect(nodes.map((node) => node.id)).toEqual(["root:project", "root:global", "root:defaults"])
  expect(nodes.map((node) => node.depth)).toEqual([0, 0, 0])
  // Roots render only the roots while collapsed; the new Agents group and the
  // shared Defaults groups appear once their root expands.
  const children = tree({ items: items(), records: [], agents: agents(), expanded: new Set(["root:project", "root:defaults"]) })
  expect(children.find((node) => node.id === "group:project:agents")?.depth).toBe(1)
  expect(children.find((node) => node.id === "group:defaults:agents")?.label).toBe("Agents")
  expect(children.find((node) => node.id === "group:defaults::tools")?.depth).toBe(1)
  // Roots are structural: no addressable state badge.
  expect(badgeLabels(nodes[0])).toEqual([])
  // Collapsed roots still report logical children as expandable.
  expect(hasVisibleChildren(nodes, 0)).toBe(false)
  expect(isExpandableRow(nodes[0], false, new Set())).toBe(true)
  expect(rowMarker(nodes[0], false, new Set())).toBe("+")
})

test("review rolls up to collapsed ancestors as a count", () => {
  const upstream: Item = {
    id: "tool:bash",
    kind: "tool",
    group: "native",
    title: "bash",
    text: "v2",
    enabled: true,
    fingerprint: fingerprint("v2"),
  }
  const records = [record({ item: "tool:bash", text: "mine", basedOn: fingerprint("v1"), basedOnText: "v1" })]
  const input = { items: [upstream, ...items().filter((item) => item.id !== "tool:bash")], records, agents: agents() }
  const collapsed = tree({ ...input, expanded: new Set() })
  // Review rolls up through the collapsed chain: root and its Agents group.
  const root = collapsed.find((node) => node.id === "root:project")
  expect(root?.badges.review).toBe(true)
  expect(root?.badges.reviewCount).toBe(1)
  expect(badgeLabels(root!)).toContain("1 to review")
  expect(yellowOnly("1 to review")).toBe(true)
  expect(yellowOnly("review")).toBe(true)
  const chain = tree({ ...input, expanded: new Set(["root:project", "group:project:agents"]) })
  expect(chain.find((node) => node.id === "group:project:agents")?.badges.review).toBe(true)
  const full = tree({ ...input, expanded: new Set(allIds(input)) })
  const item = full.find((node) => node.id === "item:project:Implementer:tool:bash")
  expect(item?.badges.review).toBe(true)
  expect(badgeLabels(item!)).toContain("review")
})

test("full subtree rows carry indentation order, markers, and addressable badges", () => {
  const nodes = expandAll()
  const agentsGroup = nodes.find((node) => node.id === "group:project:agents")
  expect(agentsGroup?.depth).toBe(1)
  expect(agentsGroup?.label).toBe("Agents")
  const agent = nodes.find((node) => node.id === "agent:project:Implementer")
  expect(agent?.depth).toBe(2)
  // Agent children shifted one deeper: category groups sit at depth 3.
  const tools = nodes.find((node) => node.id === "group:project:Implementer:tools")
  expect(tools?.depth).toBe(3)
  // Item rows carry the addressable state badge plus modified/active/review.
  const role = nodes.find((node) => node.id === "item:project:Implementer:system:role")
  expect(badgeLabels(role!)).toContain("on")
  const gpt = nodes.find((node) => node.id === "item:project:Implementer:base:gpt")
  expect(badgeLabels(gpt!)).toContain("active")
  const modified = tree({
    items: items(),
    records: [record({ item: "tool:bash", text: "mine" })],
    agents: agents(),
    expanded: new Set(["root:project", "group:project:agents", "agent:project:Implementer", "group:project:Implementer:tools", "group:project:Implementer:tools:native"]),
  })
  const bash = modified.find((node) => node.id === "item:project:Implementer:tool:bash")
  expect(badgeLabels(bash!)).toEqual(expect.arrayContaining(["on", "modified"]))
  // Sections are leaves with no expandable marker even with visible siblings.
  const section = nodes.find((node) => node.id === "section:project:Implementer:system:role:purpose")
  expect(section?.kind).toBe("section")
  expect(isExpandableRow(section!, true, new Set())).toBe(false)
  expect(rowMarker(section!, true, new Set())).toBe(" ")
})

test("sections list include and exclude with visible representation", () => {
  const snap = snapshot([
    {
      type: "customization",
      level: "project",
      agent: "Implementer",
      item: "system:role",
      section: "usage",
      state: "off",
      basedOn: fingerprint("# Usage\n\nb\n"),
      updated: UPDATED,
    },
  ])
  const full = expandAll()
  const role = full.find((node) => node.id === "item:project:Implementer:system:role")
  expect(role).toBeDefined()
  const rows = sectionRows(role!, snap)
  expect(rows.map((row) => row.id)).toEqual(["purpose", "usage"])
  expect(rows.find((row) => row.id === "usage")?.excluded).toBe(true)
  expect(rows.find((row) => row.id === "purpose")?.excluded).toBe(false)
  // Excluded section text renders struck through with a visible label.
  expect(excludedAttributes(true)).toBe(TextAttributes.STRIKETHROUGH)
  expect(excludedAttributes(false)).toBeUndefined()
  const usage = full.find((node) => node.id === "section:project:Implementer:system:role:usage")
  expect(sectionExcluded(usage!, snap)).toBe(true)
  expect(parentItemTitle(usage!, snap)).toBe("Role")
  const purpose = full.find((node) => node.id === "section:project:Implementer:system:role:purpose")
  expect(sectionExcluded(purpose!, snap)).toBe(false)
})

test("provenance wording and resolved text through resolve", () => {
  const snap = snapshot([])
  const full = expandAll()
  const role = full.find((node) => node.id === "item:project:Implementer:system:role")
  expect(provenanceLine(role!, snap)).toBe("inherited from: upstream")
  expect(resolvedText(role!, snap)).toBe(ROLE_TEXT)
  const overridden = snapshot([
    {
      type: "customization",
      level: "project",
      agent: "Implementer",
      item: "system:role",
      section: null,
      text: "mine",
      basedOn: fingerprint(ROLE_TEXT),
      basedOnText: ROLE_TEXT,
      updated: UPDATED,
    },
  ])
  expect(provenanceLine(role!, overridden)).toBe("overridden here: Project")
  expect(resolvedText(role!, overridden)).toBe("mine")
  const shared = snapshot([
    {
      type: "customization",
      level: "defaults",
      agent: null,
      item: "system:role",
      section: null,
      text: "shared",
      basedOn: fingerprint(ROLE_TEXT),
      updated: UPDATED,
    },
  ])
  expect(provenanceLine(role!, shared)).toBe("inherited from: Defaults")
  expect(displayLevel("global")).toBe("Global")
})

test("review badge owns yellow and nothing else borrows it", () => {
  const yellow = RGBA.fromHex("#ffff00")
  const gray = RGBA.fromHex("#888888")
  const context = {
    theme: {
      text: { feedback: { warning: { default: yellow } }, subdued: gray },
    },
  } as unknown as Parameters<typeof badgeColor>[0]
  expect(badgeColor(context, "review")).toBe(yellow)
  expect(badgeColor(context, "1 to review")).toBe(yellow)
  for (const label of ["on", "off", "modified", "active"]) {
    expect(badgeColor(context, label)).toBe(gray)
  }
})

test("whole-item detail strikes the excluded section range", () => {
  const snap = snapshot([    {
      type: "customization",
      level: "project",
      agent: "Implementer",
      item: "system:role",
      section: "usage",
      state: "off",
      basedOn: fingerprint("# Usage\n\nb\n"),
      updated: UPDATED,
    },
  ])
  const full = expandAll()
  const role = full.find((node) => node.id === "item:project:Implementer:system:role")
  expect(role).toBeDefined()
  const ranges = excludedRanges(role!, snap)
  expect(ranges).toHaveLength(1)
  const text = resolvedText(role!, snap)
  const usageStart = text.indexOf("# Usage")
  expect(usageStart).toBeGreaterThanOrEqual(0)
  expect(ranges[0]).toEqual({ start: usageStart, end: text.length })
  // Inside the usage body is excluded; inside purpose is not.
  expect(isExcludedOffset(ranges, usageStart + 2)).toBe(true)
  expect(isExcludedOffset(ranges, 1)).toBe(false)
  expect(excludedAttributes(true)).toBe(TextAttributes.STRIKETHROUGH)
})
