import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fingerprint, type AgentSource, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { globalTeamsPath, projectTeamsPath } from "../src/instructions/paths.js"
import { policyMembersOf, teamPolicyItems } from "../src/instructions/team-policy-rows.js"
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
    { id: "Implementer", scope: "project", base: "gpt", origin: "user" },
    { id: "Helper", scope: "global", base: "claude", origin: "user" },
    { id: "Template", scope: "defaults", base: "gpt", origin: "user" },
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
  expect(childrenOf(nodes, "group:project:agents").map((node) => node.id)).toEqual([
    "group:project:agents:native",
    "group:project:agents:plus",
    "group:project:agents:user",
  ])
  expect(childrenOf(nodes, "group:project:agents:native").map((node) => node.id)).toEqual([
    "group:project:agents:native:special",
  ])
  expect(childrenOf(nodes, "group:project:agents:user").map((node) => node.id)).toEqual(["agent:project:Implementer"])
  const agent = nodes.find((node) => node.id === "agent:project:Implementer")
  expect(agent?.kind).toBe("agent")
  expect(agent?.depth).toBe(3)
  expect(childrenOf(nodes, "agent:project:Implementer").map((node) => node.label)).toEqual([
    "Models",
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
    ["project", "Implementer", 3],
    ["global", "Helper", 3],
    ["defaults", "Template", 3],
  ] as const) {
    const id = `agent:${level}:${agent}`
    expect(nodes.find((node) => node.id === id)?.depth).toBe(depth)
    expect(childrenOf(nodes, id).map((node) => node.label)).toEqual(["Models", "Tools", "Base", "Skills", "System"])
  }
})

test("Defaults holds two catalogues, each owning its six shared inventories in order", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  expect(childrenOf(nodes, "root:defaults").map((node) => node.id)).toEqual([
    "group:defaults:agents",
    "group:defaults:teams",
  ])
  expect(childrenOf(nodes, "group:defaults:agents").map((node) => node.id)).toEqual([
    "group:defaults:agents:native",
    "group:defaults:agents:plus",
    "group:defaults:agents:user",
    "group:defaults::models",
    "group:defaults::tools",
    "group:defaults::base",
    "group:defaults::skills",
    "group:defaults::system",
    "group:defaults::mcp",
  ])
  expect(childrenOf(nodes, "group:defaults:teams").map((node) => node.id)).toEqual([
    "group:defaults:/teams:models",
    "group:defaults:/teams:tools",
    "group:defaults:/teams:base",
    "group:defaults:/teams:skills",
    "group:defaults:/teams:system",
    "group:defaults:/teams:mcp",
  ])
  expect(childrenOf(nodes, "group:defaults:agents:user").map((node) => node.id)).toEqual(["agent:defaults:Template"])
  const shared = nodes.find((node) => node.id === "item:defaults::mcp:sample")
  expect(shared?.address).toEqual({ level: "defaults", agent: null, item: "mcp:sample", section: null })
  const teamShared = nodes.find((node) => node.id === "item:defaults:/teams:mcp:sample")
  expect(teamShared?.address).toEqual({
    level: "defaults",
    agent: null,
    item: "mcp:sample",
    section: null,
    catalogue: "teams",
  })
})

test("Project and Global hold Agents and Teams groups", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  expect(childrenOf(nodes, "root:project").map((node) => node.id)).toEqual(["group:project:agents", "group:project:teams"])
  expect(childrenOf(nodes, "group:project:agents").map((node) => node.id)).toEqual([
    "group:project:agents:native",
    "group:project:agents:plus",
    "group:project:agents:user",
  ])
  expect(childrenOf(nodes, "group:project:agents:user").map((node) => node.id)).toEqual(["agent:project:Implementer"])
  expect(childrenOf(nodes, "root:global").map((node) => node.id)).toEqual(["group:global:agents", "group:global:teams"])
  expect(childrenOf(nodes, "group:global:agents").map((node) => node.id)).toEqual([
    "group:global:agents:native",
    "group:global:agents:plus",
    "group:global:agents:user",
  ])
  expect(childrenOf(nodes, "group:global:agents:user").map((node) => node.id)).toEqual(["agent:global:Helper"])
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
  // No Defaults teams here, so the group holds only its own inventory.
  expect(childrenOf(nodes, "group:defaults:teams").filter((node) => node.kind === "team")).toEqual([])
  // Teams sort by name inside their group, ahead of the inventory groups.
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
  // Project and global teams are deletable through team.delete; the built-in
  // Defaults teams below stay non-deletable.
  expect(enabled?.actions).toEqual({ toggle: true, edit: false, reset: false, remove: true, split: false, pin: false })
  expect(enabled?.address).toBeUndefined()
  expect(enabled?.badges.state).toBe("on")
  const disabled = nodes.find((node) => node.id === "team:global:crew")
  expect(disabled?.kind).toBe("team")
  expect(disabled?.depth).toBe(2)
  expect(disabled?.actions?.toggle).toBe(true)
  expect(disabled?.actions?.remove).toBe(true)
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
    "team:project:crew:special",
  ])
  for (const id of ["team:project:crew:alpha", "team:project:crew:nested/beta"]) {
    const member = nodes.find((node) => node.id === id)
    expect(member?.kind).toBe("team")
    expect(member?.depth).toBe(3)
    expect(member?.address).toBeUndefined()
    expect(member?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: true, split: false, pin: false })
    expect(member?.badges.state).toBeUndefined()
  }
})

test("team rows and member rows carry add agent", () => {
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: [{ level: "project", team: "crew", enabled: true, agents: ["alpha"] }],
  })
  expect(nodes.find((node) => node.id === "team:project:crew")?.add).toBe("agent")
  expect(nodes.find((node) => node.id === "team:project:crew:alpha")?.add).toBe("agent")
})

test("team member rows expand to full agent subtrees with team-prefixed groups", () => {
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: [{ level: "project", team: "crew", enabled: false, agents: ["CrewMate"] }],
  })
  const member = nodes.find((node) => node.id === "team:project:crew:CrewMate")
  expect(member?.kind).toBe("team")
  expect(member?.depth).toBe(3)
  expect(member?.address).toBeUndefined()
  expect(member?.add).toBe("agent")
  expect(member?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: true, split: false, pin: false })
  expect(childrenOf(nodes, "team:project:crew:CrewMate").map((node) => node.id)).toEqual([
    "group:project:crew/:CrewMate:models",
    "group:project:crew/:CrewMate:tools",
    "group:project:crew/:CrewMate:base",
    "group:project:crew/:CrewMate:skills",
    "group:project:crew/:CrewMate:system",
  ])
  // Member rows carry the member's own `<team>/:<member>` owner path so the
  // Teams-catalogue row and the stand-alone Agents-catalogue row stay two
  // distinct ids for two distinct resolutions of the same records.
  const implementerTools = nodes
    .filter((node) => node.id.startsWith("item:project:Implementer:tool:"))
    .map((node) => node.id.replace("item:project:Implementer:", "item:project:crew/:CrewMate:"))
    .sort()
  expect(implementerTools.length).toBeGreaterThan(0)
  for (const id of implementerTools) {
    expect(nodes.some((node) => node.id === id)).toBe(true)
  }
  const base = nodes.find((node) => node.id === "item:project:crew/:CrewMate:base:claude")
  expect(base).toBeDefined()
  expect(base?.address?.agent).toBe("CrewMate")
  expect(base?.address?.catalogue).toBe("teams")
})

test("a team member's rules are rows under a Policy group, and team tools never reach the Agents catalogue", () => {
  const member = "gemini-implementer"
  const policy = teamPolicyItems(policyMembersOf([member]))
  const teamTool = makeItem({
    id: "tool:team_delegate",
    kind: "tool",
    group: "plus",
    title: "delegate",
    namespace: "team",
    codemode: false,
  })
  const nodes = expandAll({
    items: [...items(), teamTool, ...policy],
    records: [],
    agents: [...agents(), { id: member, scope: "project", origin: "plus" }],
    teams: [{ level: "project", team: "crew", enabled: true, agents: [member] }],
  })
  const group = nodes.find((node) => node.id === `group:project:crew/:${member}:tools:policy`)
  expect(group?.kind).toBe("group")
  expect(group?.label).toBe("Policy")
  const rows = childrenOf(nodes, `group:project:crew/:${member}:tools:policy`)
  expect(rows.map((node) => node.id)).toContain(`item:project:crew/:${member}:perm:shell:team-role`)
  expect(rows.map((node) => node.id)).toContain(`item:project:crew/:${member}:perm:team_supersede:role-ceiling`)
  const shell = rows.find((node) => node.id === `item:project:crew/:${member}:perm:shell:team-role`)
  expect(shell?.badges.state).toBe("off")
  expect(shell?.actions?.toggle).toBe(true)
  expect(shell?.address).toEqual({ level: "project", agent: member, item: "perm:shell:team-role", section: null, catalogue: "teams" })
  // Policy rows live in one group per owner, never duplicated under the tool
  // they govern. The member's stand-alone Agents-catalogue row reads the same
  // records, so it carries its own single copy.
  expect(nodes.filter((node) => node.id === `item:project:crew/:${member}:perm:shell:team-role`)).toHaveLength(1)
  expect(nodes.filter((node) => node.id === `item:project:${member}:perm:shell:team-role`)).toHaveLength(1)
  expect(childrenOf(nodes, `item:project:crew/:${member}:tool:bash`).map((node) => node.id)).not.toContain(
    `item:project:crew/:${member}:perm:shell:team-role`,
  )
  // The Agents catalogue lists no team tool, for the member or for anyone else.
  expect(nodes.some((node) => node.id === `item:project:${member}:tool:team_delegate`)).toBe(false)
  expect(nodes.some((node) => node.id === "item:project:Implementer:tool:team_delegate")).toBe(false)
  expect(nodes.some((node) => node.id === "item:defaults::tool:team_delegate")).toBe(false)
  expect(nodes.some((node) => node.id === `item:project:crew/:${member}:tool:team_delegate`)).toBe(true)
})

test("registered team member yields its Role/persona under System", () => {
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: [...agents(), { id: "CrewMate", scope: "project", base: "gpt" }],
    teams: [{ level: "project", team: "crew", enabled: false, agents: ["CrewMate"] }],
  })
  const role = nodes.find((node) => node.id === "item:project:crew/:CrewMate:system:role")
  expect(role).toBeDefined()
  expect(role?.address).toEqual({
    level: "project",
    agent: "CrewMate",
    item: "system:role",
    section: null,
    catalogue: "teams",
  })
  // The stand-alone row addresses the same record through the Agents chain.
  expect(nodes.find((node) => node.id === "item:project:CrewMate:system:role")?.address).toEqual({
    level: "project",
    agent: "CrewMate",
    item: "system:role",
    section: null,
  })
  const systemGroup = nodes.find((node) => node.id === "group:project:crew/:CrewMate:system")
  expect(systemGroup).toBeDefined()
  expect(
    childrenOf(nodes, "group:project:crew/:CrewMate:system").some((node) => node.id === "item:project:crew/:CrewMate:system:role"),
  ).toBe(true)
})

test("team Special group row and special agent subtrees across all three levels", () => {
  for (const level of ["project", "global", "defaults"] as const) {
    const nodes = expandAll({
      items: items(),
      records: [],
      agents: [
        ...agents(),
        { id: "general", scope: "defaults", origin: "special" },
        { id: "explore", scope: "defaults", origin: "special" },
        { id: "compaction", scope: "defaults", origin: "special" },
        { id: "title", scope: "defaults", origin: "special" },
        { id: "summary", scope: "defaults", origin: "special" },
      ],
      teams: [{ level, team: "crew", enabled: true, agents: ["alpha"] }],
    })
    const specialGroup = nodes.find((node) => node.id === `team:${level}:crew:special`)
    expect(specialGroup).toBeDefined()
    expect(specialGroup?.kind).toBe("group")
    expect(specialGroup?.label).toBe("Special")
    expect(specialGroup?.depth).toBe(3)
    expect(specialGroup?.add).toBeUndefined()
    expect(specialGroup?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: false, split: false, pin: false })

    const specialKids = childrenOf(nodes, `team:${level}:crew:special`)
    expect(specialKids.length).toBe(5)
    const expectedIds = ["general", "explore", "compaction", "title", "summary"]
    expect(specialKids.map((k) => k.label)).toEqual(expectedIds)

    for (const id of expectedIds) {
      const agentRow = nodes.find((node) => node.id === `team:${level}:crew:special:${id}`)
      expect(agentRow).toBeDefined()
      expect(agentRow?.kind).toBe("team")
      expect(agentRow?.label).toBe(id)
      expect(agentRow?.depth).toBe(4)
      expect(agentRow?.add).toBeUndefined()
      expect(agentRow?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: false, split: false, pin: false })

      const agentKids = childrenOf(nodes, `team:${level}:crew:special:${id}`)
      expect(agentKids.map((k) => k.id)).toEqual([
        `group:${level}:crew/:special:${id}:models`,
        `group:${level}:crew/:special:${id}:tools`,
        `group:${level}:crew/:special:${id}:base`,
        `group:${level}:crew/:special:${id}:skills`,
        `group:${level}:crew/:special:${id}:system`,
      ])
      for (const group of agentKids) {
        expect(group.kind).toBe("group")
        expect(group.depth).toBe(5)
      }
    }
  }
})

test("a fixture member named special cannot be constructed", () => {
  expect(() =>
    expandAll({
      items: items(),
      records: [],
      agents: agents(),
      teams: [{ level: "project", team: "crew", enabled: true, agents: ["special"] }],
    }),
  ).toThrow('member id "special" is reserved')
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
  // Only Defaults owns shared inventory: project and global catalogues hold
  // just their populations.
  expect(nodes.some((node) => node.id.startsWith("group:global:/teams:"))).toBe(false)
})

test("Defaults lists built-in team rows with toggles and member rows", () => {
  const empty = expandAll({ items: items(), records: [], agents: agents(), teams: [] })
  const emptyGroup = empty.find((node) => node.id === "group:defaults:teams")
  expect(emptyGroup?.kind).toBe("group")
  expect(emptyGroup?.label).toBe("Teams")
  expect(emptyGroup?.depth).toBe(1)
  expect(emptyGroup?.add).toBe("team")
  expect(childrenOf(empty, "group:defaults:teams").filter((node) => node.kind === "team")).toEqual([])
  expect(childrenOf(empty, "root:defaults").map((node) => node.id)).toContain("group:defaults:teams")
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: [
      { level: "project", team: "crew", enabled: true, agents: ["alpha"] },
      { level: "global", team: "side", enabled: false, agents: [] },
      { level: "defaults", team: "ship", enabled: true, agents: ["mate", "nested/solo", "ovl"], overlay: ["ovl"] },
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
    "group:defaults:/teams:models",
    "group:defaults:/teams:tools",
    "group:defaults:/teams:base",
    "group:defaults:/teams:skills",
    "group:defaults:/teams:system",
    "group:defaults:/teams:mcp",
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
    "team:defaults:ship:ovl",
    "team:defaults:ship:special",
  ])
  for (const id of ["team:defaults:ship:mate", "team:defaults:ship:nested/solo"]) {
    const member = nodes.find((node) => node.id === id)
    expect(member?.kind).toBe("team")
    expect(member?.depth).toBe(3)
    expect(member?.address).toBeUndefined()
    expect(member?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: false, split: false, pin: false })
  }
  const ovlMember = nodes.find((node) => node.id === "team:defaults:ship:ovl")
  expect(ovlMember?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: true, split: false, pin: false })
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
  expect(childrenOf(before, "group:defaults:teams").filter((node) => node.kind === "team")).toEqual([])
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
  expect(childrenOf(after, "group:defaults:teams").filter((node) => node.kind === "team")).toEqual([])
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
  expect(sections.map((node) => node.depth)).toEqual([6, 6])
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
  const agentOnly = tree({ ...input, expanded: new Set(["root:project", "group:project:agents", "group:project:agents:user"]) })
  const agentNode = agentOnly.find((node) => node.id === "agent:project:Implementer")
  expect(agentNode?.badges.review).toBe(true)
  expect(agentNode?.badges.reviewCount).toBe(1)
  const full = expandAll(input)
  for (const id of [
    "root:project",
    "group:project:agents",
    "group:project:agents:user",
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
  const nodes = expandAll({
    items: items(),
    records: [],
    agents: agents(),
    teams: [{ level: "project", team: "crew", enabled: true, agents: ["alpha"] }],
  })
  const adds = new Map(nodes.filter((node) => node.add !== undefined).map((node) => [node.id, node.add]))
  expect(adds.get("root:project")).toBeUndefined()
  expect(adds.get("root:global")).toBeUndefined()
  expect(adds.get("root:defaults")).toBeUndefined()
  expect(adds.get("group:project:agents")).toBe("agent")
  expect(adds.get("group:global:agents")).toBe("agent")
  expect(adds.get("group:defaults:agents")).toBe("agent")
  expect(adds.get("group:project:agents:user")).toBe("agent")
  expect(adds.get("group:global:agents:user")).toBe("agent")
  expect(adds.get("group:defaults:agents:user")).toBe("agent")
  expect(adds.get("group:project:agents:native")).toBeUndefined()
  expect(adds.get("group:project:agents:native:special")).toBeUndefined()
  expect(adds.get("group:project:agents:plus")).toBeUndefined()
  expect(adds.get("group:global:agents:native")).toBeUndefined()
  expect(adds.get("group:global:agents:plus")).toBeUndefined()
  expect(adds.get("group:defaults:agents:native")).toBeUndefined()
  expect(adds.get("group:defaults:agents:plus")).toBeUndefined()
  expect(adds.get("group:project:teams")).toBe("team")
  expect(adds.get("group:global:teams")).toBe("team")
  expect(adds.get("group:defaults:teams")).toBe("team")
  expect(nodes.some((node) => node.id === "group:defaults:teams")).toBe(true)
  expect(adds.get("team:project:crew")).toBe("agent")
  expect(adds.get("team:project:crew:alpha")).toBe("agent")
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
    "group:project:agents:native",
    "group:project:agents:plus",
    "group:project:agents:user",
    "group:project:teams",
    "root:global",
    "root:defaults",
  ])
  const userGroup = tree({
    ...input,
    expanded: new Set(["root:project", "group:project:agents", "group:project:agents:user"]),
  })
  expect(userGroup.map((node) => node.id)).toEqual([
    "root:project",
    "group:project:agents",
    "group:project:agents:native",
    "group:project:agents:plus",
    "group:project:agents:user",
    "agent:project:Implementer",
    "group:project:teams",
    "root:global",
    "root:defaults",
  ])
  const agent = tree({
    ...input,
    expanded: new Set(["root:project", "group:project:agents", "group:project:agents:user", "agent:project:Implementer"]),
  })
  expect(agent.map((node) => node.id)).toEqual([
    "root:project",
    "group:project:agents",
    "group:project:agents:native",
    "group:project:agents:plus",
    "group:project:agents:user",
    "agent:project:Implementer",
    "group:project:Implementer:models",
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
  ])
  const agentsCatalogue = tree({ ...input, expanded: new Set(["root:defaults", "group:defaults:agents"]) })
  expect(agentsCatalogue.map((node) => node.id)).toEqual([
    "root:project",
    "root:global",
    "root:defaults",
    "group:defaults:agents",
    "group:defaults:agents:native",
    "group:defaults:agents:plus",
    "group:defaults:agents:user",
    "group:defaults::models",
    "group:defaults::tools",
    "group:defaults::base",
    "group:defaults::skills",
    "group:defaults::system",
    "group:defaults::mcp",
    "group:defaults:teams",
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

test("ancestor-backed agents suppress remove action while project-file agents allow it", () => {
  const agentList: AgentSource[] = [
    { id: "local", scope: "project", origin: "user", path: "/project/.opencode/agent/local.md" },
    { id: "anc", scope: "project", origin: "user", ancestor: true, path: "/parent/.opencode/agent/anc.md" },
  ]
  const nodes = expandAll({ items: items(), records: [], agents: agentList })
  const ancRow = nodes.find((node) => node.id === "agent:project:anc")
  expect(ancRow?.actions?.remove).toBe(false)
  const localRow = nodes.find((node) => node.id === "agent:project:local")
  expect(localRow?.actions?.remove).toBe(true)
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
  // Native non-Code-Mode tools host both sections and rules, so `a` offers a
  // Section / Permission rule choice instead of a direct section add.
  expect(bash?.add).toBeUndefined()
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
  expect(nodes.find((node) => node.id === code)?.depth).toBe(6)
  // Namespace-less tools hang directly off the Code Mode group, ahead of the
  // sorted namespace groups.
  expect(childrenOf(nodes, code).map((node) => node.label)).toEqual(["lonely", "fs"])
  expect(childrenOf(nodes, `${code}:fs`).map((node) => node.label)).toEqual(["read", "write"])
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:read")?.depth).toBe(8)
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
  expect(nodes.find((node) => node.id === "item:defaults::tool:read")?.depth).toBe(6)
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

test("Models group is first under every agent with toggle/remove-only rows", () => {
  const nodes = expandAll({ items: items(), records: [], agents: agents() })
  for (const id of ["agent:project:Implementer", "agent:global:Helper", "agent:defaults:Template"]) {
    const labels = childrenOf(nodes, id).map((node) => node.label)
    expect(labels[0]).toBe("Models")
  }
  const group = nodes.find((node) => node.id === "group:project:Implementer:models")
  expect(group?.label).toBe("Models")
  expect(group?.add).toBe("model")
  expect(nodes.find((node) => node.id === "group:defaults::models")?.add).toBe("model")
})

test("model union shows chain candidates with source badges and one active winner", () => {
  const modelAgents = [
    { id: "alpha", scope: "project" as const, model: { providerID: "acme", modelID: "nova-1" } },
    { id: "alpha", scope: "global" as const, model: { providerID: "acme", modelID: "nova-1" } },
  ]
  const records = [
    { type: "model" as const, level: "project" as const, agent: "alpha", providerID: "acme", modelID: "nova-2", updated: UPDATED },
    { type: "model" as const, level: "global" as const, agent: "alpha", providerID: "acme", modelID: "nova-3", active: true as const, updated: UPDATED },
    { type: "model" as const, level: "defaults" as const, agent: null, providerID: "acme", modelID: "nova-4", updated: UPDATED },
  ]
  const nodes = expandAll({ items: [], records, agents: modelAgents })
  const projectRows = nodes.filter((node) => node.id.startsWith("item:project:alpha:model:"))
  expect(projectRows.map((node) => node.id).sort()).toEqual([
    "item:project:alpha:model:acme/nova-1",
    "item:project:alpha:model:acme/nova-2",
    "item:project:alpha:model:acme/nova-3",
    "item:project:alpha:model:acme/nova-4",
  ])
  const byId = new Map(projectRows.map((node) => [node.id, node]))
  expect(byId.get("item:project:alpha:model:acme/nova-2")?.badges.source).toBe("project")
  expect(byId.get("item:project:alpha:model:acme/nova-3")?.badges.source).toBe("global")
  expect(byId.get("item:project:alpha:model:acme/nova-4")?.badges.source).toBe("defaults")
  expect(byId.get("item:project:alpha:model:acme/nova-1")?.badges.source).toBe("upstream")
  const actives = projectRows.filter((node) => node.badges.active === true)
  expect(actives.map((node) => node.id)).toEqual(["item:project:alpha:model:acme/nova-3"])
  for (const row of projectRows) {
    expect(row.actions).toMatchObject({ toggle: true, edit: false, split: false, pin: false })
  }
  expect(byId.get("item:project:alpha:model:acme/nova-2")?.actions?.remove).toBe(true)
  expect(byId.get("item:project:alpha:model:acme/nova-3")?.actions?.reset).toBe(false)
  const globalRows = nodes.filter((node) => node.id.startsWith("item:global:alpha:model:"))
  expect(globalRows.some((node) => node.id === "item:global:alpha:model:acme/nova-2")).toBe(false)
  expect(globalRows.map((node) => node.id).sort()).toEqual([
    "item:global:alpha:model:acme/nova-1",
    "item:global:alpha:model:acme/nova-3",
    "item:global:alpha:model:acme/nova-4",
  ])
})

test("native tool rows list perm rows directly after sections with editable rule rows", () => {
  const shellText = "shell tool"
  const all = [
    makeItem({ id: "tool:shell", kind: "tool", group: "native", title: "shell", text: shellText }),
    makeItem({
      id: "perm:shell:git-push",
      kind: "perm",
      group: "none",
      title: "Git push",
      text: "Git push\ngit push *",
      permTool: "shell",
      ruleId: "git-push",
      patterns: ["git push *"],
      keywords: ["git push"],
      provenance: ["tool:shell"],
    }),
    makeItem({
      id: "perm:shell:custom",
      kind: "perm",
      group: "none",
      title: "Custom",
      text: "Custom\ncustom *",
      permTool: "shell",
      ruleId: "custom",
      patterns: ["custom *"],
      keywords: ["custom"],
      provenance: [],
      custom: true,
    }),
  ]
  const nodes = expandAll({ items: all, records: [], agents: agents() })
  const toolRow = nodes.find((node) => node.id === "item:project:Implementer:tool:shell")
  if (!toolRow) throw new Error("expected shell tool row")
  // No intermediate Permissions group: perm rows hang directly off the tool.
  expect(nodes.some((node) => node.id === "group:project:Implementer:tool:shell:perms")).toBe(false)
  expect(nodes.some((node) => node.label === "Permissions")).toBe(false)
  // The tool row hosts both sections and rules, so `a` offers the choice
  // instead of a direct section add.
  expect(toolRow.add).toBeUndefined()
  const kids = childrenOf(nodes, toolRow.id)
  expect(kids.map((node) => node.id).sort()).toEqual(
    ["item:project:Implementer:perm:shell:custom", "item:project:Implementer:perm:shell:git-push"].sort().concat(kids.filter((node) => node.kind === "section").map((node) => node.id)).sort(),
  )
  // Perm rows come after section rows, ordered among themselves by title.
  const permKids = kids.filter((node) => node.address?.item.startsWith("perm:"))
  expect(permKids.map((node) => node.id).sort()).toEqual(
    ["item:project:Implementer:perm:shell:custom", "item:project:Implementer:perm:shell:git-push"].sort(),
  )
  const sectionCount = kids.length - permKids.length
  for (const perm of permKids) expect(kids.indexOf(perm)).toBeGreaterThanOrEqual(sectionCount)
  const curated = nodes.find((node) => node.id === "item:project:Implementer:perm:shell:git-push")
  expect(curated?.actions).toEqual({ toggle: true, edit: true, reset: false, remove: false, split: false, pin: false })
  expect(curated?.badges.state).toBe("on")
  const custom = nodes.find((node) => node.id === "item:project:Implementer:perm:shell:custom")
  expect(custom?.actions?.remove).toBe(true)
  expect(custom?.actions?.edit).toBe(true)
  expect(custom?.actions?.pin).toBe(false)
})

test("agents split into Native, Special, Plus and User origin subgroups", () => {
  const originAgents: AgentSource[] = [
    { id: "build", scope: "project", origin: "native" },
    { id: "explore", scope: "project", origin: "special" },
    { id: "teammate", scope: "project", origin: "plus" },
    { id: "mine", scope: "project", origin: "user" },
  ]
  const nodes = expandAll({ items: [], records: [], agents: originAgents })
  expect(childrenOf(nodes, "group:project:agents").map((node) => node.id)).toEqual([
    "group:project:agents:native",
    "group:project:agents:plus",
    "group:project:agents:user",
  ])
  expect(nodes.find((node) => node.id === "group:project:agents:native")?.depth).toBe(2)
  expect(nodes.find((node) => node.id === "group:project:agents:native:special")?.depth).toBe(3)
  expect(nodes.find((node) => node.id === "group:project:agents:plus")?.depth).toBe(2)
  expect(nodes.find((node) => node.id === "group:project:agents:user")?.depth).toBe(2)
  expect(childrenOf(nodes, "group:project:agents:native").map((node) => node.id)).toEqual([
    "agent:project:build",
    "group:project:agents:native:special",
  ])
  expect(childrenOf(nodes, "group:project:agents:native:special").map((node) => node.id)).toEqual(["agent:project:explore"])
  expect(childrenOf(nodes, "group:project:agents:plus").map((node) => node.id)).toEqual(["agent:project:teammate"])
  expect(childrenOf(nodes, "group:project:agents:user").map((node) => node.id)).toEqual(["agent:project:mine"])
  expect(nodes.find((node) => node.id === "agent:project:build")?.depth).toBe(3)
  expect(nodes.find((node) => node.id === "agent:project:explore")?.depth).toBe(4)
  expect(nodes.find((node) => node.id === "agent:project:teammate")?.depth).toBe(3)
  expect(nodes.find((node) => node.id === "agent:project:mine")?.depth).toBe(3)
  // Agent rows keep the origin-free id.
  expect(nodes.some((node) => node.id === "agent:project:build")).toBe(true)
  // Empty levels still emit all four subgroup ids.
  const empty = expandAll({ items: [], records: [], agents: [] })
  for (const id of [
    "group:project:agents:native",
    "group:project:agents:native:special",
    "group:project:agents:plus",
    "group:project:agents:user",
  ]) {
    expect(empty.some((node) => node.id === id)).toBe(true)
  }
})

test("native and special built-ins appear under every root and cannot be removed", () => {
  const builtins: AgentSource[] = [
    { id: "build", scope: "defaults", origin: "native" },
    { id: "plan", scope: "defaults", origin: "native" },
    { id: "general", scope: "defaults", origin: "special" },
    { id: "explore", scope: "defaults", origin: "special" },
    { id: "compaction", scope: "defaults", origin: "special" },
    { id: "title", scope: "defaults", origin: "special" },
    { id: "summary", scope: "defaults", origin: "special" },
  ]
  const nodes = expandAll({ items: [], records: [], agents: builtins })

  for (const level of ["project", "global", "defaults"] as const) {
    expect(childrenOf(nodes, `group:${level}:agents:native`).map((node) => node.id)).toEqual([
      `agent:${level}:build`,
      `agent:${level}:plan`,
      `group:${level}:agents:native:special`,
    ])
    expect(childrenOf(nodes, `group:${level}:agents:native:special`).map((node) => node.id)).toEqual([
      `agent:${level}:general`,
      `agent:${level}:explore`,
      `agent:${level}:compaction`,
      `agent:${level}:title`,
      `agent:${level}:summary`,
    ])
    expect(nodes.find((node) => node.id === `agent:${level}:build`)?.actions?.remove).toBe(false)
    expect(nodes.find((node) => node.id === `agent:${level}:plan`)?.actions?.remove).toBe(false)
    expect(nodes.find((node) => node.id === `agent:${level}:general`)?.actions?.remove).toBe(false)
    expect(nodes.find((node) => node.id === `agent:${level}:explore`)?.actions?.remove).toBe(false)
    expect(nodes.find((node) => node.id === `agent:${level}:compaction`)?.actions?.remove).toBe(false)
    expect(nodes.find((node) => node.id === `agent:${level}:title`)?.actions?.remove).toBe(false)
    expect(nodes.find((node) => node.id === `agent:${level}:summary`)?.actions?.remove).toBe(false)
  }
})

test("project-level file-backed build override replaces native projection at project level while preserving others", () => {
  const builtins: AgentSource[] = [
    { id: "build", scope: "defaults", origin: "native" },
    { id: "plan", scope: "defaults", origin: "native" },
    { id: "general", scope: "defaults", origin: "special" },
    { id: "explore", scope: "defaults", origin: "special" },
    { id: "compaction", scope: "defaults", origin: "special" },
    { id: "title", scope: "defaults", origin: "special" },
    { id: "summary", scope: "defaults", origin: "special" },
  ]
  const agents: AgentSource[] = [
    ...builtins,
    { id: "build", scope: "project", path: "/project/.opencode/agent/build.md", origin: "user" },
  ]
  const nodes = expandAll({ items: [], records: [], agents })

  const projectBuildNodes = nodes.filter((node) => node.id === "agent:project:build")
  expect(projectBuildNodes.length).toBe(1)
  const projectBuild = projectBuildNodes[0]

  expect(childrenOf(nodes, "group:project:agents:user").map((node) => node.id)).toContain("agent:project:build")
  expect(projectBuild.actions?.remove).toBe(true)

  const projectNativeChildren = childrenOf(nodes, "group:project:agents:native").map((node) => node.id)
  expect(projectNativeChildren).toContain("agent:project:plan")
  expect(projectNativeChildren).not.toContain("agent:project:build")

  expect(childrenOf(nodes, "group:project:agents:native:special").map((node) => node.id)).toEqual([
    "agent:project:general",
    "agent:project:explore",
    "agent:project:compaction",
    "agent:project:title",
    "agent:project:summary",
  ])

  expect(childrenOf(nodes, "group:global:agents:native").map((node) => node.id)).toContain("agent:global:build")
  expect(childrenOf(nodes, "group:defaults:agents:native").map((node) => node.id)).toContain("agent:defaults:build")
})

test("project-level file-backed explore override replaces special projection at project level while preserving others", () => {
  const builtins: AgentSource[] = [
    { id: "build", scope: "defaults", origin: "native" },
    { id: "plan", scope: "defaults", origin: "native" },
    { id: "general", scope: "defaults", origin: "special" },
    { id: "explore", scope: "defaults", origin: "special" },
    { id: "compaction", scope: "defaults", origin: "special" },
    { id: "title", scope: "defaults", origin: "special" },
    { id: "summary", scope: "defaults", origin: "special" },
  ]
  const agents: AgentSource[] = [
    ...builtins,
    { id: "explore", scope: "project", path: "/project/.opencode/agent/explore.md", origin: "user" },
  ]
  const nodes = expandAll({ items: [], records: [], agents })

  const projectExploreNodes = nodes.filter((node) => node.id === "agent:project:explore")
  expect(projectExploreNodes.length).toBe(1)
  const projectExplore = projectExploreNodes[0]

  expect(childrenOf(nodes, "group:project:agents:user").map((node) => node.id)).toContain("agent:project:explore")
  expect(projectExplore.actions?.remove).toBe(true)

  const projectNativeChildren = childrenOf(nodes, "group:project:agents:native").map((node) => node.id)
  expect(projectNativeChildren).toContain("agent:project:build")
  expect(projectNativeChildren).toContain("agent:project:plan")

  const projectSpecialChildren = childrenOf(nodes, "group:project:agents:native:special").map((node) => node.id)
  expect(projectSpecialChildren).not.toContain("agent:project:explore")
  expect(projectSpecialChildren).toEqual([
    "agent:project:general",
    "agent:project:compaction",
    "agent:project:title",
    "agent:project:summary",
  ])

  expect(childrenOf(nodes, "group:global:agents:native:special").map((node) => node.id)).toContain("agent:global:explore")
  expect(childrenOf(nodes, "group:defaults:agents:native:special").map((node) => node.id)).toContain("agent:defaults:explore")
})

test("empty rule sets emit no perm rows but the tool still offers the add choice", () => {
  const nodes = expandAll({
    items: [makeItem({ id: "tool:shell", kind: "tool", group: "native", title: "shell", text: "shell tool" })],
    records: [],
    agents: agents(),
  })
  const toolRow = nodes.find((node) => node.id === "item:project:Implementer:tool:shell")
  if (!toolRow) throw new Error("expected shell tool row")
  expect(toolRow.add).toBeUndefined()
  expect(childrenOf(nodes, toolRow.id).some((node) => node.address?.item.startsWith("perm:"))).toBe(false)
  expect(nodes.some((node) => node.label === "Permissions")).toBe(false)
})

test("perm rows order most-mentioned first, not title order", () => {
  const shellText = "shell tool"
  const all = [
    makeItem({ id: "tool:shell", kind: "tool", group: "native", title: "shell", text: shellText }),
    makeItem({
      id: "perm:shell:aaa-generic",
      kind: "perm",
      group: "none",
      title: "Aaa generic",
      text: "Aaa generic\naaa *",
      order: 1,
      permTool: "shell",
      ruleId: "aaa-generic",
      patterns: ["aaa *"],
      keywords: ["aaa"],
      provenance: [],
    }),
    makeItem({
      id: "perm:shell:zzz-mentioned",
      kind: "perm",
      group: "none",
      title: "Zzz mentioned",
      text: "Zzz mentioned\nzzz *",
      order: 0,
      permTool: "shell",
      ruleId: "zzz-mentioned",
      patterns: ["zzz *"],
      keywords: ["zzz"],
      provenance: ["tool:shell", "skill:notes", "base:general"],
    }),
  ]
  const nodes = expandAll({ items: all, records: [], agents: agents() })
  const toolRow = nodes.find((node) => node.id === "item:project:Implementer:tool:shell")
  if (!toolRow) throw new Error("expected shell tool row")
  const rows = childrenOf(nodes, toolRow.id).filter((node) => node.address?.item.startsWith("perm:"))
  expect(rows.map((node) => node.label)).toEqual(["Zzz mentioned", "Aaa generic"])
})

test("nested agent id and team member group ids never collide", async () => {
  // A project agent literally named `crew/alpha` and a project team `crew`
  // with member `alpha` would both produce `group:project:crew/alpha:models`
  // under the old bare-`/` scheme. The `/:` marker keeps them distinct.
  const nodes = expandAll({
    items: items(),
    // One shared candidate per catalogue, the shape the store migration
    // produces: the stand-alone agent reads the Agents copy and the team
    // member reads the Teams copy.
    records: [
      { type: "model" as const, level: "defaults" as const, agent: null, providerID: "acme", modelID: "shared", updated: UPDATED },
      {
        type: "model" as const,
        level: "defaults" as const,
        agent: null,
        catalogue: "teams" as const,
        providerID: "acme",
        modelID: "shared",
        updated: UPDATED,
      },
    ],
    agents: [{ id: "crew/alpha", scope: "project", origin: "user" }],
    teams: [{ level: "project", team: "crew", enabled: true, agents: ["alpha"] }],
  })
  const agentModels = "group:project:crew/alpha:models"
  const teamModels = "group:project:crew/:alpha:models"
  expect(agentModels).not.toBe(teamModels)
  expect(nodes.some((node) => node.id === agentModels)).toBe(true)
  expect(nodes.some((node) => node.id === teamModels)).toBe(true)
  const agentKids = childrenOf(nodes, agentModels)
  const teamKids = childrenOf(nodes, teamModels)
  expect(agentKids.length).toBeGreaterThan(0)
  expect(teamKids.length).toBeGreaterThan(0)
  for (const kid of agentKids) expect(kid.address?.agent).toBe("crew/alpha")
  for (const kid of teamKids) expect(kid.address?.agent).toBe("alpha")
})
