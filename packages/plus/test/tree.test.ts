import { expect, test } from "bun:test"
import { fingerprint, type AgentSource, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { tree, type TreeInput, type TreeNode } from "../src/instructions/tree.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function makeItem(overrides?: Partial<Item>): Item {
  const text = overrides?.text ?? "default text"
  return {
    id: "tool:bash",
    kind: "tool",
    group: "native",
    title: "bash",
    text,
    enabled: true,
    fingerprint: fingerprint(text),
    ...overrides,
  }
}

function makeRecord(overrides?: Partial<CustomizationRecord>): CustomizationRecord {
  return {
    level: "project",
    agent: "Implementer",
    item: "tool:bash",
    section: null,
    basedOn: fingerprint("default text"),
    updated: UPDATED,
    ...overrides,
  }
}

function agents(): AgentSource[] {
  return [
    { id: "Implementer", scope: "project", base: "gpt" },
    { id: "Helper", scope: "global", base: "claude" },
    { id: "Template", scope: "defaults", base: "gpt" },
  ]
}

function items(): Item[] {
  return [
    makeItem({ id: "tool:bash", kind: "tool", group: "native", title: "bash", order: 2 }),
    makeItem({ id: "tool:aaa", kind: "tool", group: "native", title: "aaa", order: 1 }),
    makeItem({ id: "tool:plus-one", kind: "tool", group: "plus", title: "plus-one" }),
    makeItem({ id: "tool:odd-name", kind: "tool", group: "mcp", server: "sample", title: "odd-name" }),
    makeItem({ id: "base:gpt", kind: "base", group: "none", title: "gpt.txt", text: "gpt base" }),
    makeItem({ id: "base:claude", kind: "base", group: "none", title: "claude.txt", text: "claude base" }),
    makeItem({ id: "skill:native-one", kind: "skill", group: "native", title: "native-one" }),
    makeItem({ id: "skill:plus-one", kind: "skill", group: "plus", title: "plus-one" }),
    makeItem({ id: "skill:mcp-one", kind: "skill", group: "mcp", server: "sample", title: "mcp-one" }),
    makeItem({ id: "skill:proj-one", kind: "skill", group: "project", title: "proj-one" }),
    makeItem({
      id: "system:role",
      kind: "system",
      group: "none",
      title: "Role",
      text: "# Purpose\n\na\n\n# Usage\n\nb\n",
    }),
    makeItem({ id: "system:guide", kind: "system", group: "project", title: "guide" }),
    makeItem({ id: "mcp:sample", kind: "mcp", group: "none", title: "sample" }),
  ]
}

function expandAll(input: Omit<TreeInput, "expanded">): TreeNode[] {
  const expanded = new Set<string>()
  let previous = -1
  let nodes: TreeNode[] = []
  while (previous !== expanded.size) {
    previous = expanded.size
    nodes = tree({ ...input, expanded })
    for (const node of nodes) expanded.add(node.id)
  }
  return nodes
}

function childrenOf(nodes: readonly TreeNode[], id: string): TreeNode[] {
  const index = nodes.findIndex((node) => node.id === id)
  if (index === -1) return []
  const depth = nodes[index].depth
  const out: TreeNode[] = []
  for (const node of nodes.slice(index + 1)) {
    if (node.depth <= depth) break
    if (node.depth === depth + 1) out.push(node)
  }
  return out
}

test("Implementer subtree shape under the project root", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  const agent = nodes.find((node) => node.id === "agent:project:Implementer")
  expect(agent?.kind).toBe("agent")
  expect(agent?.depth).toBe(1)
  expect(childrenOf(nodes, "agent:project:Implementer").map((node) => node.label)).toEqual([
    "Tools",
    "Base",
    "Skills",
    "System",
  ])
  expect(childrenOf(nodes, "group:project:Implementer:tools").map((node) => node.label)).toEqual([
    "Native",
    "OpenCodePlus",
    "MCP",
  ])
  expect(childrenOf(nodes, "group:project:Implementer:tools:native").map((node) => node.label)).toEqual(["aaa", "bash"])
  expect(childrenOf(nodes, "group:project:Implementer:tools:mcp").map((node) => node.label)).toEqual(["sample"])
  expect(childrenOf(nodes, "group:project:Implementer:tools:mcp:sample").map((node) => node.label)).toEqual(["odd-name"])
  expect(childrenOf(nodes, "group:project:Implementer:skills").map((node) => node.label)).toEqual([
    "Native",
    "OpenCodePlus",
    "MCP",
    "Project",
  ])
  expect(childrenOf(nodes, "group:project:Implementer:system").map((node) => node.label)[0]).toBe("Role/persona")
})

test("identical subtree under each of the three roots", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  for (const [level, agent, depth] of [
    ["project", "Implementer", 1],
    ["global", "Helper", 1],
    ["defaults", "Template", 2],
  ] as const) {
    const id = `agent:${level}:${agent}`
    expect(nodes.find((node) => node.id === id)?.depth).toBe(depth)
    expect(childrenOf(nodes, id).map((node) => node.label)).toEqual(["Tools", "Base", "Skills", "System"])
  }
})

test("Defaults holds Agents plus the five shared inventories in order", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  expect(childrenOf(nodes, "root:defaults").map((node) => node.id)).toEqual([
    "group:defaults:agents",
    "group:defaults::tools",
    "group:defaults::base",
    "group:defaults::skills",
    "group:defaults::system",
    "group:defaults::mcp",
  ])
  expect(childrenOf(nodes, "group:defaults:agents").map((node) => node.id)).toEqual(["agent:defaults:Template"])
  const shared = nodes.find((node) => node.id === "item:defaults::mcp:sample")
  expect(shared?.address).toEqual({ level: "defaults", agent: null, item: "mcp:sample", section: null })
})

test("MCP tools group by item.server, never the tool name", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  const group = nodes.find((node) => node.id === "group:project:Implementer:tools:mcp:sample")
  expect(group?.label).toBe("sample")
  const item = nodes.find((node) => node.id === "item:project:Implementer:tool:odd-name")
  expect(item).toBeDefined()
  expect(nodes.some((node) => node.id === "group:project:Implementer:tools:mcp:odd-name")).toBe(false)
})

test("Role/persona is first under System", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  const labels = childrenOf(nodes, "group:project:Implementer:system").map((node) => node.label)
  expect(labels[0]).toBe("Role/persona")
  expect(labels).toContain("guide")
})

test("active badge marks exactly one base template per agent", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  const active = nodes.filter(
    (node) => node.id.startsWith("item:project:Implementer:base:") && node.badges.active === true,
  )
  expect(active.map((node) => node.id)).toEqual(["item:project:Implementer:base:gpt"])
  const helper = nodes.filter(
    (node) => node.id.startsWith("item:global:Helper:base:") && node.badges.active === true,
  )
  expect(helper.map((node) => node.id)).toEqual(["item:global:Helper:base:claude"])
})

test("section rows carry section addresses, stable ids, and nested depths", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  const sections = nodes.filter((node) => node.id.startsWith("section:project:Implementer:system:role:"))
  expect(sections.map((node) => node.id)).toEqual([
    "section:project:Implementer:system:role:purpose",
    "section:project:Implementer:system:role:usage",
  ])
  expect(sections.map((node) => node.address)).toEqual([
    { level: "project", agent: "Implementer", item: "system:role", section: "purpose" },
    { level: "project", agent: "Implementer", item: "system:role", section: "usage" },
  ])
  expect(sections.map((node) => node.depth)).toEqual([4, 4])
  expect(sections.every((node) => node.badges.state === "on")).toBe(true)
  expect(sections.every((node) => node.actions?.toggle === true && node.actions?.split === false)).toBe(true)
})

test("review rolls up to Native, Tools, Implementer, and Project agents while collapsed", () => {
  const upstream = makeItem({ id: "tool:bash", kind: "tool", group: "native", title: "bash", text: "v2" })
  const rest = items().filter((item) => item.id !== "tool:bash" && item.id !== "tool:aaa")
  const records = [
    makeRecord({ item: "tool:bash", text: "mine", basedOn: fingerprint("v1"), basedOnText: "v1" }),
  ]
  const input = { items: [upstream, ...rest], records, agents: agents() }
  const collapsed = tree({ ...input, expanded: new Set() })
  const root = collapsed.find((node) => node.id === "root:project")
  expect(root?.badges.review).toBe(true)
  expect(root?.badges.reviewCount).toBe(1)
  const agentOnly = tree({ ...input, expanded: new Set(["root:project"]) })
  const agentNode = agentOnly.find((node) => node.id === "agent:project:Implementer")
  expect(agentNode?.badges.review).toBe(true)
  expect(agentNode?.badges.reviewCount).toBe(1)
  const full = expandAll(input)
  for (const id of [
    "root:project",
    "agent:project:Implementer",
    "group:project:Implementer:tools",
    "group:project:Implementer:tools:native",
    "item:project:Implementer:tool:bash",
  ]) {
    const node = full.find((node) => node.id === id)
    expect(node?.badges.review).toBe(true)
    expect(node?.badges.reviewCount).toBe(id === "item:project:Implementer:tool:bash" ? 0 : 1)
  }
})

test("add affordances land on exactly the listed groups", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  const adds = new Map(nodes.filter((node) => node.add !== undefined).map((node) => [node.id, node.add]))
  expect(adds.get("root:project")).toBe("agent")
  expect(adds.get("root:global")).toBe("agent")
  expect(adds.get("root:defaults")).toBeUndefined()
  expect(adds.get("group:defaults:agents")).toBe("agent")
  expect(adds.get("group:project:Implementer:base")).toBe("base")
  expect(adds.get("group:defaults::base")).toBe("base")
  expect(adds.get("group:project:Implementer:skills:project")).toBe("skill")
  expect(adds.get("group:project:Implementer:system")).toBe("instruction")
  expect(adds.get("group:defaults::system")).toBe("instruction")
  expect(adds.get("group:defaults::mcp")).toBe("mcp")
  expect(adds.get("group:project:Implementer:tools")).toBeUndefined()
  expect(adds.get("group:project:Implementer:skills")).toBeUndefined()
  expect(adds.get("group:project:Implementer:tools:native")).toBeUndefined()
})

test("expansion emits only expanded children", () => {
  const input = { items: items(), records: [], agents: agents() }
  expect(tree({ ...input, expanded: new Set() }).map((node) => node.id)).toEqual([
    "root:project",
    "root:global",
    "root:defaults",
  ])
  const roots = tree({ ...input, expanded: new Set(["root:project"]) })
  expect(roots.map((node) => node.id)).toEqual(["root:project", "agent:project:Implementer", "root:global", "root:defaults"])
  const agent = tree({ ...input, expanded: new Set(["root:project", "agent:project:Implementer"]) })
  expect(agent.map((node) => node.id)).toEqual([
    "root:project",
    "agent:project:Implementer",
    "group:project:Implementer:tools",
    "group:project:Implementer:base",
    "group:project:Implementer:skills",
    "group:project:Implementer:system",
    "root:global",
    "root:defaults",
  ])
})

test("items sort by order then title and respect applies", () => {
  const scoped = makeItem({ id: "tool:scoped", kind: "tool", group: "native", title: "scoped", agents: ["Other"] })
  const nodes = expandAll({ items: [...items(), scoped], records: [], agents: agents() })
  expect(childrenOf(nodes, "group:project:Implementer:tools:native").map((node) => node.label)).toEqual(["aaa", "bash"])
  expect(nodes.some((node) => node.id === "item:project:Implementer:tool:scoped")).toBe(false)
})

test("actions: toggle/edit/split on items, reset only with an override, remove on owned rows", () => {
  const records = [
    makeRecord({ item: "tool:bash" }),
    makeRecord({ level: "defaults", agent: null, item: "mcp:sample", basedOn: fingerprint("default text") }),
  ]
  const nodes = expandAll({ items: items(), records, agents: agents() })
  const bash = nodes.find((node) => node.id === "item:project:Implementer:tool:bash")
  expect(bash?.actions).toEqual({ toggle: true, edit: true, reset: true, remove: false, split: true })
  const plus = nodes.find((node) => node.id === "item:project:Implementer:tool:plus-one")
  expect(plus?.actions?.reset).toBe(false)
  expect(nodes.find((node) => node.id === "item:defaults::mcp:sample")?.actions?.remove).toBe(true)
  expect(nodes.find((node) => node.id === "item:project:Implementer:skill:proj-one")?.actions?.remove).toBe(true)
  expect(nodes.find((node) => node.id === "agent:project:Implementer")?.actions?.remove).toBe(true)
  expect(nodes.find((node) => node.id === "group:project:Implementer:tools")?.actions).toEqual({
    toggle: false,
    edit: false,
    reset: false,
    remove: false,
    split: false,
  })
})

test("badges carry state, modified, and source from resolution", () => {
  const records = [makeRecord({ item: "tool:bash", text: "mine", state: "off" })]
  const nodes = expandAll({ items: items(), records, agents: agents() })
  const bash = nodes.find((node) => node.id === "item:project:Implementer:tool:bash")
  expect(bash?.badges.state).toBe("off")
  expect(bash?.badges.modified).toBe(true)
  expect(bash?.badges.source).toBe("project")
  const plus = nodes.find((node) => node.id === "item:project:Implementer:tool:plus-one")
  expect(plus?.badges.state).toBe("on")
  expect(plus?.badges.modified).toBe(false)
  expect(plus?.badges.source).toBe("upstream")
})
