import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fingerprint, type AgentSource, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { globalTeamsPath, projectTeamsPath } from "../src/instructions/paths.js"
import { expandedTree, tree, type TreeInput, type TreeNode } from "../src/instructions/tree.js"
import { createHandlers, createState } from "../src/index.js"
import { enable } from "../src/project.js"
import { fullContext } from "./harness.js"

const teamRoots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(teamRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

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

function makeRecord(overrides?: Partial<CustomizationRecord> & { type?: "customization" }): CustomizationRecord {
  return {
    type: "customization",
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
  expect(nodes.find((node) => node.id === "root:project")?.label).toBe("Project")
  expect(nodes.find((node) => node.id === "root:global")?.label).toBe("Global")
  expect(nodes.find((node) => node.id === "root:defaults")?.label).toBe("Defaults")
  const agentGroup = nodes.find((node) => node.id === "group:project:agents")
  expect(agentGroup?.kind).toBe("group")
  expect(agentGroup?.label).toBe("Agents")
  expect(agentGroup?.depth).toBe(1)
  const agent = nodes.find((node) => node.id === "agent:project:Implementer")
  expect(agent?.kind).toBe("agent")
  expect(agent?.depth).toBe(2)
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
    ["project", "Implementer", 2],
    ["global", "Helper", 2],
    ["defaults", "Template", 2],
  ] as const) {
    const id = `agent:${level}:${agent}`
    expect(nodes.find((node) => node.id === id)?.depth).toBe(depth)
    expect(childrenOf(nodes, id).map((node) => node.label)).toEqual(["Tools", "Base", "Skills", "System"])
  }
})

test("Defaults holds Agents, Teams, plus the five shared inventories in order", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  expect(childrenOf(nodes, "root:defaults").map((node) => node.id)).toEqual([
    "group:defaults:agents",
    "group:defaults:teams",
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

test("Project and Global hold Agents and Teams groups", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  expect(childrenOf(nodes, "root:project").map((node) => node.id)).toEqual(["group:project:agents", "group:project:teams"])
  expect(childrenOf(nodes, "group:project:agents").map((node) => node.id)).toEqual(["agent:project:Implementer"])
  expect(childrenOf(nodes, "root:global").map((node) => node.id)).toEqual(["group:global:agents", "group:global:teams"])
  expect(childrenOf(nodes, "group:global:agents").map((node) => node.id)).toEqual(["agent:global:Helper"])
})

test("Teams group sits beside Agents at all three levels", () => {
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: [
      { level: "project", team: "crew", enabled: true, agents: ["alpha", "nested/beta"] },
      { level: "project", team: "side", enabled: false, agents: [] },
      { level: "global", team: "crew", enabled: false, agents: ["gamma"] },
    ],
  })
  const projectGroup = nodes.find((node) => node.id === "group:project:teams")
  expect(projectGroup?.kind).toBe("group")
  expect(projectGroup?.label).toBe("Teams")
  expect(projectGroup?.depth).toBe(1)
  const globalGroup = nodes.find((node) => node.id === "group:global:teams")
  expect(globalGroup?.kind).toBe("group")
  expect(globalGroup?.label).toBe("Teams")
  expect(globalGroup?.depth).toBe(1)
  const defaultsGroup = nodes.find((node) => node.id === "group:defaults:teams")
  expect(defaultsGroup?.kind).toBe("group")
  expect(defaultsGroup?.label).toBe("Teams")
  expect(defaultsGroup?.depth).toBe(1)
  expect(defaultsGroup?.add).toBe("team")
  expect(childrenOf(nodes, "root:project").map((node) => node.id)).toEqual(["group:project:agents", "group:project:teams"])
  expect(childrenOf(nodes, "root:global").map((node) => node.id)).toEqual(["group:global:agents", "group:global:teams"])
  expect(childrenOf(nodes, "root:defaults").slice(0, 2).map((node) => node.id)).toEqual([
    "group:defaults:agents",
    "group:defaults:teams",
  ])
  expect(childrenOf(nodes, "group:defaults:teams")).toEqual([])
  // Teams sort by name inside their group.
  expect(childrenOf(nodes, "group:project:teams").map((node) => node.id)).toEqual(["team:project:crew", "team:project:side"])
})

test("team rows carry toggle actions and read enabled state as on/off", () => {
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: [
      { level: "project", team: "crew", enabled: true, agents: ["alpha", "nested/beta"] },
      { level: "global", team: "crew", enabled: false, agents: ["gamma"] },
    ],
  })
  const enabled = nodes.find((node) => node.id === "team:project:crew")
  expect(enabled?.kind).toBe("team")
  expect(enabled?.label).toBe("crew")
  expect(enabled?.depth).toBe(2)
  expect(enabled?.actions).toEqual({ toggle: true, edit: false, reset: false, remove: false, split: false, pin: false })
  expect(enabled?.address).toBeUndefined()
  expect(enabled?.badges.state).toBe("on")
  const disabled = nodes.find((node) => node.id === "team:global:crew")
  expect(disabled?.kind).toBe("team")
  expect(disabled?.depth).toBe(2)
  expect(disabled?.actions?.toggle).toBe(true)
  expect(disabled?.badges.state).toBe("off")
  // Same team name at different levels stays two distinct rows.
  expect(enabled?.id).not.toBe(disabled?.id)
})

test("member rows are informational: no address, no actions, depth 3", () => {
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: [{ level: "project", team: "crew", enabled: true, agents: ["alpha", "nested/beta"] }],
  })
  expect(childrenOf(nodes, "team:project:crew").map((node) => node.id)).toEqual([
    "team:project:crew:alpha",
    "team:project:crew:nested/beta",
  ])
  for (const id of ["team:project:crew:alpha", "team:project:crew:nested/beta"]) {
    const member = nodes.find((node) => node.id === id)
    expect(member?.kind).toBe("team")
    expect(member?.depth).toBe(3)
    expect(member?.address).toBeUndefined()
    expect(member?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: false, split: false, pin: false })
    expect(member?.badges.state).toBeUndefined()
  }
})

test("a level with no teams renders an empty Teams group with the add affordance", () => {
  // Empty levels still show the group so the feature stays discoverable and
  // creatable: the group carries add:"team" with no team rows underneath.
  for (const input of [
    { items: items(), records: [], agents: agents() },
    { items: items(), records: [], agents: agents(), teams: [] },
    {
      items: items(),
      records: [],
      agents: agents(),
      teams: [{ level: "global" as const, team: "crew", enabled: true, agents: ["gamma"] }],
    },
  ]) {
    const nodes = expandAll(input)
    const projectGroup = nodes.find((node) => node.id === "group:project:teams")
    expect(projectGroup?.kind).toBe("group")
    expect(projectGroup?.label).toBe("Teams")
    expect(projectGroup?.depth).toBe(1)
    expect(projectGroup?.add).toBe("team")
    expect(childrenOf(nodes, "group:project:teams")).toEqual([])
    expect(childrenOf(nodes, "root:project").map((node) => node.id)).toEqual(["group:project:agents", "group:project:teams"])
  }
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: [{ level: "global", team: "crew", enabled: true, agents: ["gamma"] }],
  })
  expect(nodes.some((node) => node.id === "group:global:teams")).toBe(true)
  expect(nodes.find((node) => node.id === "group:global:teams")?.add).toBe("team")
  expect(childrenOf(nodes, "group:global:teams").map((node) => node.id)).toEqual(["team:global:crew"])
})

test("Defaults lists built-in team rows with toggles and member rows", () => {
  const empty = expandAll({ items: items(), records: [], agents: agents(), teams: [] })
  const emptyGroup = empty.find((node) => node.id === "group:defaults:teams")
  expect(emptyGroup?.kind).toBe("group")
  expect(emptyGroup?.label).toBe("Teams")
  expect(emptyGroup?.depth).toBe(1)
  expect(emptyGroup?.add).toBe("team")
  expect(childrenOf(empty, "group:defaults:teams")).toEqual([])
  expect(childrenOf(empty, "root:defaults").map((node) => node.id)).toContain("group:defaults:teams")
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: [
      { level: "project", team: "crew", enabled: true, agents: ["alpha"] },
      { level: "global", team: "side", enabled: false, agents: [] },
      { level: "defaults", team: "ship", enabled: true, agents: ["mate", "nested/solo"] },
      { level: "defaults", team: "other", enabled: false, agents: [] },
    ],
  })
  const group = nodes.find((node) => node.id === "group:defaults:teams")
  expect(group?.kind).toBe("group")
  expect(group?.label).toBe("Teams")
  expect(group?.depth).toBe(1)
  expect(group?.add).toBe("team")
  expect(childrenOf(nodes, "group:defaults:teams").map((node) => node.id)).toEqual([
    "team:defaults:other",
    "team:defaults:ship",
  ])
  const enabled = nodes.find((node) => node.id === "team:defaults:ship")
  expect(enabled?.kind).toBe("team")
  expect(enabled?.depth).toBe(2)
  expect(enabled?.actions).toEqual({ toggle: true, edit: false, reset: false, remove: false, split: false, pin: false })
  expect(enabled?.badges.state).toBe("on")
  const disabled = nodes.find((node) => node.id === "team:defaults:other")
  expect(disabled?.badges.state).toBe("off")
  expect(childrenOf(nodes, "team:defaults:ship").map((node) => node.id)).toEqual([
    "team:defaults:ship:mate",
    "team:defaults:ship:nested/solo",
  ])
  for (const id of ["team:defaults:ship:mate", "team:defaults:ship:nested/solo"]) {
    const member = nodes.find((node) => node.id === id)
    expect(member?.kind).toBe("team")
    expect(member?.depth).toBe(3)
    expect(member?.address).toBeUndefined()
    expect(member?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: false, split: false, pin: false })
  }
})

test("a team created from the Defaults Teams group is stored at project or global, never defaults", async () => {
  // The Defaults Teams group is a creation entry point: `a` there opens the
  // existing addTeam flow, which prompts for a project/global scope, so the
  // new team lands under one of the two real teams roots. The registry is
  // empty here so the test never couples to the shipped roster.
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-tree-defaults-team-create-"))
  teamRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = {
    error: (type: string, message: string, data?: unknown): never => {
      throw { type, message, data }
    },
  }
  const before = expandAll({ items: items(), records: [], agents: agents(), teams: [] })
  const defaultsGroup = before.find((node) => node.id === "group:defaults:teams")
  expect(defaultsGroup?.add).toBe("team")
  expect(childrenOf(before, "group:defaults:teams")).toEqual([])
  const created = await Effect.runPromise(handlers["team.create"]({ level: "project", team: "fresh" }, throwing))
  expect(created).toEqual({ level: "project", team: "fresh", enabled: false })
  expect(created.level).not.toBe("defaults")
  const stat = await fs.stat(path.join(projectTeamsPath(project), "fresh"))
  expect(stat.isDirectory()).toBe(true)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
  expect(snapshot.teams).toEqual([{ level: "project", team: "fresh", enabled: false, agents: [] }])
  // No defaults teams directory is created on disk: the global teams root
  // gains nothing, and the new team never surfaces under Defaults.
  const globalEntries = await fs.readdir(globalTeamsPath()).catch(() => [])
  expect(globalEntries).not.toContain("fresh")
  const after = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: (snapshot.teams ?? []).map((team) => ({
      level: team.level,
      team: team.team,
      enabled: team.enabled,
      agents: team.agents,
    })),
  })
  expect(childrenOf(after, "group:defaults:teams")).toEqual([])
  expect(childrenOf(after, "group:project:teams").map((node) => node.id)).toEqual(["team:project:fresh"])
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
  expect(sections.map((node) => node.depth)).toEqual([5, 5])
  expect(sections.every((node) => node.badges.state === "on")).toBe(true)
  expect(sections.every((node) => node.actions?.toggle === true && node.actions?.split === false)).toBe(true)
})

test("whole Role/persona and whole base rows refuse toggle but read unsupported", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  const role = nodes.find((node) => node.id === "item:project:Implementer:system:role")
  expect(role?.actions?.toggle).toBe(false)
  expect(role?.actions?.edit).toBe(true)
  expect(role?.actions?.split).toBe(true)
  expect(role?.badges.unsupported).toBe(true)
  const base = nodes.find((node) => node.id === "item:project:Implementer:base:gpt")
  expect(base?.actions?.toggle).toBe(false)
  expect(base?.actions?.edit).toBe(true)
  expect(base?.actions?.split).toBe(true)
  expect(base?.badges.unsupported).toBe(true)
  // Their sections stay toggleable: section exclusions still assemble.
  const sections = nodes.filter((node) => node.id.startsWith("section:project:Implementer:system:role:"))
  expect(sections.length).toBe(2)
  expect(sections.every((node) => node.actions?.toggle === true && node.actions?.edit === true)).toBe(true)
  expect(sections.every((node) => node.badges.unsupported === undefined)).toBe(true)
})

test("expanding a Code Mode tool yields editable children like a normal tool", () => {
  const all = [
    ...items(),
    makeItem({ id: "tool:coder", kind: "tool", group: "native", title: "coder", text: "# A\n\na\n", codemode: true, namespace: "fs" }),
  ]
  const input = { items: all, records: [], agents: agents() }
  const expanded = new Set<string>()
  let previous = -1
  let nodes: TreeNode[] = []
  while (previous !== expanded.size) {
    previous = expanded.size
    nodes = tree({ ...input, expanded })
    for (const node of nodes) expanded.add(node.id)
  }
  const children = childrenOf(nodes, "item:project:Implementer:tool:coder")
  expect(children.length).toBeGreaterThan(0)
  for (const child of children) {
    expect(child.kind).toBe("section")
    expect(child.actions?.toggle).toBe(true)
    expect(child.actions?.edit).toBe(true)
    expect(child.badges.unsupported).toBeUndefined()
  }
  const normal = childrenOf(nodes, "item:project:Implementer:tool:bash")
  expect(normal.length).toBeGreaterThan(0)
  for (const child of normal) {
    expect(child.actions?.toggle).toBe(true)
    expect(child.actions?.edit).toBe(true)
    expect(child.badges.unsupported).toBeUndefined()
  }
})

test("review rolls up to Native, Tools, Implementer, Agents, and Project while collapsed", () => {
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
  const agentOnly = tree({ ...input, expanded: new Set(["root:project", "group:project:agents"]) })
  const agentNode = agentOnly.find((node) => node.id === "agent:project:Implementer")
  expect(agentNode?.badges.review).toBe(true)
  expect(agentNode?.badges.reviewCount).toBe(1)
  const full = expandAll(input)
  for (const id of [
    "root:project",
    "group:project:agents",
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
  expect(adds.get("root:project")).toBeUndefined()
  expect(adds.get("root:global")).toBeUndefined()
  expect(adds.get("root:defaults")).toBeUndefined()
  expect(adds.get("group:project:agents")).toBe("agent")
  expect(adds.get("group:global:agents")).toBe("agent")
  expect(adds.get("group:defaults:agents")).toBe("agent")
  expect(adds.get("group:project:teams")).toBe("team")
  expect(adds.get("group:global:teams")).toBe("team")
  expect(adds.get("group:defaults:teams")).toBe("team")
  expect(nodes.some((node) => node.id === "group:defaults:teams")).toBe(true)
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
  expect(roots.map((node) => node.id)).toEqual([
    "root:project",
    "group:project:agents",
    "group:project:teams",
    "root:global",
    "root:defaults",
  ])
  const agentsGroup = tree({ ...input, expanded: new Set(["root:project", "group:project:agents"]) })
  expect(agentsGroup.map((node) => node.id)).toEqual([
    "root:project",
    "group:project:agents",
    "agent:project:Implementer",
    "group:project:teams",
    "root:global",
    "root:defaults",
  ])
  const agent = tree({
    ...input,
    expanded: new Set(["root:project", "group:project:agents", "agent:project:Implementer"]),
  })
  expect(agent.map((node) => node.id)).toEqual([
    "root:project",
    "group:project:agents",
    "agent:project:Implementer",
    "group:project:Implementer:tools",
    "group:project:Implementer:base",
    "group:project:Implementer:skills",
    "group:project:Implementer:system",
    "group:project:teams",
    "root:global",
    "root:defaults",
  ])
  const defaults = tree({ ...input, expanded: new Set(["root:defaults"]) })
  expect(defaults.map((node) => node.id)).toEqual([
    "root:project",
    "root:global",
    "root:defaults",
    "group:defaults:agents",
    "group:defaults:teams",
    "group:defaults::tools",
    "group:defaults::base",
    "group:defaults::skills",
    "group:defaults::system",
    "group:defaults::mcp",
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
  expect(bash?.actions).toEqual({ toggle: true, edit: true, reset: true, remove: false, split: true, pin: false })
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
    pin: false,
  })
})

test("base template rows: user templates offer delete and read inactive, host active does not", () => {
  const all = [
    ...items(),
    makeItem({ id: "base:custom", kind: "base", group: "none", title: "Custom.txt", text: "custom", userBase: true }),
  ]
  const nodes = expandAll({ items: all, records: [], agents: agents() })
  const user = nodes.find((node) => node.id === "item:project:Implementer:base:custom")
  expect(user?.actions?.remove).toBe(true)
  expect(user?.badges.inactive).toBe(true)
  expect(user?.badges.active).toBeUndefined()
  const builtin = nodes.find((node) => node.id === "item:project:Implementer:base:gpt")
  expect(builtin?.actions?.remove).toBe(false)
  // The Implementer agent's host answer is gpt, so the builtin row is active
  // and never inactive.
  expect(builtin?.badges.active).toBe(true)
  expect(builtin?.badges.inactive).toBeUndefined()
})

test("instruction rows are removable only when project-owned", () => {
  const owned = makeItem({ id: "system:AGENTS.md", kind: "system", group: "project", title: "AGENTS.md" })
  const ambient = makeItem({ id: "system:../AGENTS.md", kind: "system", group: "none", title: "../AGENTS.md" })
  const ancestor = makeItem({ id: "system:../../AGENTS.md", kind: "system", group: "none", title: "../../AGENTS.md" })
  const nodes = expandAll({ items: [owned, ambient, ancestor], records: [], agents: agents() })
  expect(nodes.find((node) => node.id === "item:defaults::system:AGENTS.md")?.actions?.remove).toBe(true)
  expect(nodes.find((node) => node.id === "item:defaults::system:../AGENTS.md")?.actions?.remove).toBe(false)
  expect(nodes.find((node) => node.id === "item:defaults::system:../../AGENTS.md")?.actions?.remove).toBe(false)
})

test("builtin-id user base shadows stay deletable and never read inactive", () => {
  // Legacy shadow predating the creation refusal: the host entry is dropped
  // by resolveBaseTemplates, so only the user copy is listed.
  const withoutHost = items().filter((item) => item.id !== "base:gpt")
  const all = [
    ...withoutHost,
    makeItem({ id: "base:gpt", kind: "base", group: "none", title: "gpt.txt", text: "user gpt shadow", userBase: true }),
  ]
  const nodes = expandAll({ items: all, records: [], agents: agents() })
  const shadow = nodes.find((node) => node.id === "item:project:Implementer:base:gpt")
  // Deletable cleanup: removing it restores the host template.
  expect(shadow?.actions?.remove).toBe(true)
  // The Implementer agent's host answer is gpt and this row CAN be that
  // answer, so it must read active — never inactive.
  expect(shadow?.badges.active).toBe(true)
  expect(shadow?.badges.inactive).toBeUndefined()
})

test("Code Mode tool rows offer toggle/edit/split/pin/add and read live, never unsupported", () => {
  const all = [
    ...items(),
    makeItem({ id: "tool:coder", kind: "tool", group: "native", title: "coder", codemode: true, namespace: "fs" }),
  ]
  const nodes = expandAll({ items: all, records: [], agents: agents() })
  const coder = nodes.find((node) => node.id === "item:project:Implementer:tool:coder")
  expect(coder?.actions).toEqual({ toggle: true, edit: true, reset: false, remove: false, split: true, pin: true })
  expect(coder?.add).toBe("section")
  expect(coder?.badges.unsupported).toBeUndefined()
  const bash = nodes.find((node) => node.id === "item:project:Implementer:tool:bash")
  expect(bash?.actions).toEqual({ toggle: true, edit: true, reset: false, remove: false, split: true, pin: false })
  expect(bash?.add).toBe("section")
  expect(bash?.badges.unsupported).toBeUndefined()
})

function codemodeAll(): Item[] {
  return [
    ...items(),
    makeItem({ id: "tool:execute", kind: "tool", group: "native", title: "execute", codemode: false, execute: true }),
    makeItem({ id: "tool:write", kind: "tool", group: "native", title: "write", text: "# A\n\na\n", codemode: true, namespace: "fs" }),
    makeItem({ id: "tool:read", kind: "tool", group: "native", title: "read", codemode: true, namespace: "fs", pinned: true }),
    makeItem({ id: "tool:lonely", kind: "tool", group: "native", title: "lonely", codemode: true }),
    makeItem({ id: "tool:plus-code", kind: "tool", group: "plus", title: "plus-code", codemode: true, namespace: "plusns" }),
    makeItem({ id: "tool:mcp-code", kind: "tool", group: "mcp", server: "sample", title: "mcp-code", codemode: true }),
  ]
}

test("Code Mode groups nest origin › Code Mode › namespace with exact ids", () => {
  const nodes = expandAll({ items: codemodeAll(), records: [], agents: agents() })
  const native = "group:project:Implementer:tools:native"
  expect(childrenOf(nodes, native).map((node) => node.label)).toEqual(["aaa", "bash", "execute", "Code Mode"])
  const code = `${native}:codemode`
  expect(nodes.find((node) => node.id === code)?.label).toBe("Code Mode")
  expect(nodes.find((node) => node.id === code)?.depth).toBe(5)
  // Namespace-less tools hang directly off the Code Mode group, ahead of the
  // sorted namespace groups.
  expect(childrenOf(nodes, code).map((node) => node.label)).toEqual(["lonely", "fs"])
  expect(childrenOf(nodes, `${code}:fs`).map((node) => node.label)).toEqual(["read", "write"])
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:read")?.depth).toBe(7)
  const plus = "group:project:Implementer:tools:plus"
  expect(childrenOf(nodes, plus).map((node) => node.label)).toEqual(["plus-one", "Code Mode"])
  expect(childrenOf(nodes, `${plus}:codemode`).map((node) => node.label)).toEqual(["plusns"])
  expect(childrenOf(nodes, `${plus}:codemode:plusns`).map((node) => node.label)).toEqual(["plus-code"])
  // MCP servers skip the namespace level: the server's Code Mode group holds
  // the tool rows directly.
  const server = "group:project:Implementer:tools:mcp:sample"
  expect(childrenOf(nodes, server).map((node) => node.label)).toEqual(["odd-name", "Code Mode"])
  expect(childrenOf(nodes, `${server}:codemode`).map((node) => node.label)).toEqual(["mcp-code"])
  expect(nodes.filter((node) => node.id.startsWith(`${server}:codemode:`))).toEqual([])
})

test("Code Mode groups repeat under the global and defaults roots", () => {
  const nodes = expandAll({ items: codemodeAll(), records: [], agents: agents() })
  expect(childrenOf(nodes, "group:global:Helper:tools:mcp:sample:codemode").map((node) => node.label)).toEqual([
    "mcp-code",
  ])
  expect(childrenOf(nodes, "group:defaults::tools:native:codemode").map((node) => node.label)).toEqual(["lonely", "fs"])
  expect(childrenOf(nodes, "group:defaults::tools:native:codemode:fs").map((node) => node.label)).toEqual([
    "read",
    "write",
  ])
  expect(nodes.find((node) => node.id === "group:defaults::tools:native:codemode:fs:read")).toBeUndefined()
  expect(nodes.find((node) => node.id === "item:defaults::tool:read")?.depth).toBe(5)
  // expandedTree agrees with the expanded walk on every Code Mode group id.
  const flat = expandedTree({ items: codemodeAll(), records: [], agents: agents() })
  for (const id of [
    "group:project:Implementer:tools:native:codemode",
    "group:project:Implementer:tools:native:codemode:fs",
    "group:project:Implementer:tools:plus:codemode",
    "group:project:Implementer:tools:plus:codemode:plusns",
    "group:project:Implementer:tools:mcp:sample:codemode",
    "group:global:Helper:tools:mcp:sample:codemode",
    "group:defaults::tools:native:codemode",
    "group:defaults::tools:native:codemode:fs",
  ]) {
    expect(flat.some((node) => node.id === id)).toBe(true)
  }
})

test("empty Code Mode and namespace groups are absent", () => {
  const plain = expandAll({ items: items(), records: [], agents: agents() })
  expect(plain.some((node) => node.id.includes(":codemode"))).toBe(false)
  const nativeOnly = [
    ...items(),
    makeItem({ id: "tool:write", kind: "tool", group: "native", title: "write", codemode: true, namespace: "fs" }),
  ]
  const nodes = expandAll({ items: nativeOnly, records: [], agents: agents() })
  expect(nodes.some((node) => node.id === "group:project:Implementer:tools:native:codemode")).toBe(true)
  expect(nodes.some((node) => node.id === "group:project:Implementer:tools:plus:codemode")).toBe(false)
  expect(nodes.some((node) => node.id === "group:project:Implementer:tools:mcp:sample:codemode")).toBe(false)
})

test("actions matrix: Code Mode row vs native tool row vs execute row vs Code Mode section", () => {
  const records = [makeRecord({ item: "tool:read" })]
  const input = { items: codemodeAll(), records, agents: agents() }
  const nodes = expandAll(input)
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:read")?.actions).toEqual({
    toggle: true,
    edit: true,
    reset: true,
    remove: false,
    split: true,
    pin: true,
  })
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:read")?.add).toBe("section")
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:bash")?.actions).toEqual({
    toggle: true,
    edit: true,
    reset: false,
    remove: false,
    split: true,
    pin: false,
  })
  const execute = nodes.find((node) => node.id === "item:project:Implementer:tool:execute")
  expect(execute?.actions).toEqual({ toggle: true, edit: false, reset: false, remove: false, split: false, pin: false })
  expect(execute?.add).toBeUndefined()
  expect(execute?.badges.unsupported).toBeUndefined()
  const section = nodes.find((node) => node.id === "section:project:Implementer:tool:write:a")
  expect(section?.actions).toEqual({ toggle: true, edit: true, reset: false, remove: false, split: false, pin: false })
  expect(section?.badges.unsupported).toBeUndefined()
  // The host-owned execute row is toggle-only with no descendants: every
  // execute item row stays childless while ordinary rows keep sections.
  const executeRows = nodes.filter((node) => node.kind === "item" && node.address?.item === "tool:execute")
  expect(executeRows.length).toBeGreaterThan(0)
  for (const row of executeRows) {
    expect(childrenOf(nodes, row.id)).toEqual([])
  }
  expect(nodes.some((node) => node.kind === "section" && node.address?.item === "tool:execute")).toBe(false)
  const flat = expandedTree(input)
  expect(flat.filter((node) => node.kind === "item" && node.address?.item === "tool:execute").length).toBe(
    executeRows.length,
  )
  expect(flat.some((node) => node.kind === "section" && node.address?.item === "tool:execute")).toBe(false)
  // Ordinary rows keep their sections alongside the childless execute row.
  expect(childrenOf(nodes, "item:project:Implementer:tool:bash").length).toBeGreaterThan(0)
})

test("badges: pinned follows the resolution, unsupported leaves Code Mode rows", () => {
  const records = [makeRecord({ item: "tool:write", pin: true })]
  const nodes = expandAll({ items: codemodeAll(), records, agents: agents() })
  // Registry-default pin and user pin override both read on the row.
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:read")?.badges.pinned).toBe(true)
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:write")?.badges.pinned).toBe(true)
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:lonely")?.badges.pinned).toBeUndefined()
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:bash")?.badges.pinned).toBeUndefined()
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:execute")?.badges.pinned).toBeUndefined()
  for (const id of [
    "item:project:Implementer:tool:read",
    "item:project:Implementer:tool:write",
    "item:project:Implementer:tool:lonely",
    "item:project:Implementer:tool:plus-code",
    "item:project:Implementer:tool:mcp-code",
    "item:project:Implementer:tool:execute",
  ]) {
    expect(nodes.find((node) => node.id === id)?.badges.unsupported).toBeUndefined()
  }
  // Whole Role/persona and whole base rows keep their treatment.
  expect(nodes.find((node) => node.id === "item:project:Implementer:system:role")?.badges.unsupported).toBe(true)
  expect(nodes.find((node) => node.id === "item:project:Implementer:system:role")?.badges.unexcludable).toBe(true)
  expect(nodes.find((node) => node.id === "item:project:Implementer:base:gpt")?.badges.unsupported).toBe(true)
  expect(nodes.find((node) => node.id === "item:project:Implementer:base:gpt")?.badges.unexcludable).toBe(true)
})

test("review rolls up through Code Mode groups like any other row", () => {
  const upstream = makeItem({
    id: "tool:write",
    kind: "tool",
    group: "native",
    title: "write",
    text: "v2",
    codemode: true,
    namespace: "fs",
  })
  const rest = codemodeAll().filter((item) => item.id !== "tool:write" && item.id !== "tool:read" && item.id !== "tool:lonely")
  const records = [makeRecord({ item: "tool:write", text: "mine", basedOn: fingerprint("v1"), basedOnText: "v1" })]
  const input = { items: [upstream, ...rest], records, agents: agents() }
  const collapsed = tree({ ...input, expanded: new Set() })
  expect(collapsed.find((node) => node.id === "root:project")?.badges.review).toBe(true)
  const full = expandAll(input)
  for (const id of [
    "group:project:Implementer:tools",
    "group:project:Implementer:tools:native",
    "group:project:Implementer:tools:native:codemode",
    "group:project:Implementer:tools:native:codemode:fs",
  ]) {
    expect(full.find((node) => node.id === id)?.badges.review).toBe(true)
  }
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
