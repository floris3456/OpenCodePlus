// DESIGN §2 in the tree: Presets → Agents → OpenCode / Plus / User and
// Teams → Plus / User, Defaults entries, row owners, add affordances and the
// "from …" badge every inheriting row carries.
import { expect, test } from "bun:test"
import {
  fingerprint,
  type AgentSource,
  type CustomizationRecord,
  type EntryRecord,
  type Item,
  type LinkRecord,
  type PresetRecord,
} from "../src/instructions/model.js"
import { fromLabel, reviewLabel } from "../src/instructions/from-label.js"
import { findRow } from "../src/instructions/ops.js"
import { nativePresetIds, plusAgentPresets, plusTeamPresets, presetLabels, presetListing } from "../src/instructions/presets.js"
import { query } from "../src/instructions/query.js"
import { expandedTree, tree, type MemoInput, type TreeNode } from "../src/instructions/tree.js"

const UPDATED = "2026-09-25T00:00:00.000Z"

function item(id: string, text: string, overrides: Partial<Item> = {}): Item {
  return { id, kind: "tool", group: "native", title: id.slice(id.indexOf(":") + 1), text, enabled: true, fingerprint: fingerprint(text), ...overrides }
}

function role(agent: string, text: string): Item {
  return item("system:role", text, { kind: "system", group: "none", title: "Role", agents: [agent] })
}

function record(level: CustomizationRecord["level"], agent: string | null, itemId: string, state: "on" | "off"): CustomizationRecord {
  return { type: "customization", level, agent, item: itemId, section: null, state, basedOn: "", updated: UPDATED }
}

const agents: AgentSource[] = [
  { id: "build", scope: "defaults", origin: "native" },
  { id: "alice", scope: "project", origin: "user" },
  { id: "bob", scope: "project", origin: "user" },
  { id: "opus-orchestrator", scope: "project", origin: "user" },
]

const entries: EntryRecord[] = [
  { type: "entry", level: "defaults", catalogue: "agents", name: "*orchestrator*", updated: UPDATED },
  { type: "entry", level: "defaults", catalogue: "agents", name: "Opus-%", updated: UPDATED },
  { type: "entry", level: "defaults", catalogue: "agents", name: "reviewer", updated: UPDATED },
  { type: "entry", level: "defaults", catalogue: "teams", team: "crew*", name: "*impl*", updated: UPDATED },
  { type: "entry", level: "defaults", catalogue: "teams", team: "*", name: "scout", updated: UPDATED },
]

const presets: PresetRecord[] = [
  { type: "preset", level: "preset", kind: "agent", id: "mine", fields: { mode: "primary" }, updated: UPDATED },
  { type: "preset", level: "preset", kind: "team", id: "crew", updated: UPDATED },
  { type: "preset", level: "preset", kind: "agent", team: "crew", id: "lead", updated: UPDATED },
]

const links: LinkRecord[] = [
  { type: "link", level: "project", agent: "alice", preset: { kind: "agent", id: "orchestrator" }, updated: UPDATED },
  { type: "link", level: "preset", agent: "mine", preset: { kind: "agent", id: "planner" }, updated: UPDATED },
  { type: "link", level: "defaults", agent: "reviewer", preset: { kind: "agent", id: "reviewer" }, updated: UPDATED },
]

function input(overrides: Partial<MemoInput> = {}): MemoInput {
  return {
    items: [
      item("tool:shell", "run commands"),
      item("tool:question", "ask the human"),
      item("tool:read", "read files"),
      role("build", "build prompt"),
      role("alice", ""),
      role("bob", ""),
      role("opus-orchestrator", ""),
    ],
    records: [
      // What the `*orchestrator*` entry sets, and what Defaults sets for everyone.
      record("defaults", "*orchestrator*", "tool:question", "on"),
      record("defaults", null, "tool:read", "on"),
    ],
    agents,
    teams: [],
    links,
    entries,
    presets,
    ...overrides,
  }
}

function all(): TreeNode[] {
  return expandedTree(input())
}

function row(nodes: readonly TreeNode[], id: string): TreeNode {
  const found = nodes.find((node) => node.id === id)
  if (found === undefined) throw new Error(`missing row ${id}`)
  return found
}

function childIds(nodes: readonly TreeNode[], id: string): string[] {
  const index = nodes.findIndex((node) => node.id === id)
  const parent = nodes[index]
  if (parent === undefined) throw new Error(`missing row ${id}`)
  const out: string[] = []
  for (const node of nodes.slice(index + 1)) {
    if (node.depth <= parent.depth) break
    if (node.depth === parent.depth + 1) out.push(node.id)
  }
  return out
}

test("Presets keeps OpenCode agent presets with stable ids and has no OpenCode team category", () => {
  const roots = tree({ ...input(), expanded: new Set() })
  expect(roots.map((node) => [node.id, node.label])).toEqual([
    ["root:project", "Project"],
    ["root:global", "Global"],
    ["root:defaults", "Defaults"],
    ["root:preset", "Presets"],
  ])
  const nodes = all()
  expect(childIds(nodes, "root:preset")).toEqual(["group:preset:agents", "group:preset:teams"])
  expect(childIds(nodes, "group:preset:agents")).toEqual([
    "group:preset:agents:native",
    "group:preset:agents:plus",
    "group:preset:agents:user",
  ])
  expect(childIds(nodes, "group:preset:teams")).toEqual(["group:preset:teams:plus", "group:preset:teams:user"])
  expect(row(nodes, "group:preset:agents:native").label).toBe("OpenCode")
  expect(childIds(nodes, "group:preset:agents:native")).toEqual(nativePresetIds.map((id) => `agent:preset:${id}`))
  expect(childIds(nodes, "group:preset:agents:plus")).toEqual(plusAgentPresets.map((preset) => `agent:preset:${preset.id}`))
  expect(childIds(nodes, "group:preset:agents:user")).toEqual(["agent:preset:mine"])
  // OpenCode ships no teams, including when every category is expanded.
  expect(nodes.some((node) => node.id === "group:preset:teams:native")).toBe(false)
  expect(nodes.some((node) => node.label === "Native")).toBe(false)
  expect(childIds(nodes, "group:preset:teams:plus")).toEqual(plusTeamPresets.map((team) => `team:preset:${team.id}`))
  expect(childIds(nodes, "group:preset:teams:user")).toEqual(["team:preset:crew"])
  // Agent presets show their label; every preset row has the five groups.
  expect(row(nodes, "agent:preset:orchestrator").label).toBe("Orchestrator")
  expect(row(nodes, "agent:preset:build").label).toBe("Build")
  expect(childIds(nodes, "agent:preset:orchestrator")).toEqual([
    "group:preset:orchestrator:models",
    "group:preset:orchestrator:tools",
    "group:preset:orchestrator:base",
    "group:preset:orchestrator:skills",
    "group:preset:orchestrator:system",
  ])
})

test("Plus team presets list their member presets with the five groups and team-scoped rows", () => {
  const nodes = all()
  const starter = plusTeamPresets.find((team) => team.id === "starter")
  expect(childIds(nodes, "team:preset:starter")).toEqual((starter?.members ?? []).map((member) => `team:preset:starter:${member.id}`))
  expect(childIds(nodes, "team:preset:starter:planner")).toEqual([
    "group:preset:starter/:planner:models",
    "group:preset:starter/:planner:tools",
    "group:preset:starter/:planner:base",
    "group:preset:starter/:planner:skills",
    "group:preset:starter/:planner:system",
  ])
  const shell = row(nodes, "item:preset:starter/:planner:tool:shell")
  expect(shell.address).toEqual({
    level: "preset",
    agent: "planner",
    item: "tool:shell",
    section: null,
    team: { level: "preset", team: "starter" },
    catalogue: "teams",
  })
  const member = row(nodes, "team:preset:starter:planner")
  expect(member.owner).toEqual({
    level: "preset",
    agent: "planner",
    team: { level: "preset", team: "starter" },
    preset: { ref: { kind: "member", team: "starter", id: "planner" }, origin: "plus" },
    link: { kind: "agent", id: "planner" },
  })
  expect(member.actions?.remove).toBe(false)
  expect(member.add).toBeUndefined()
  expect(row(nodes, "team:preset:starter").actions?.remove).toBe(false)
  expect(row(nodes, "team:preset:starter").add).toBeUndefined()
  // The member preset and the agent preset of the same id are different nodes:
  // the member's own role body wins over the Plus planner's role text.
  const texts = query(input(), {
    where: "id:item:preset:starter/:planner:system:role,item:preset:planner:system:role",
    fields: ["id", "text"],
  }).rows
  const memberRole = texts.find((entry) => entry.id === "item:preset:starter/:planner:system:role")?.text
  const agentRole = texts.find((entry) => entry.id === "item:preset:planner:system:role")?.text
  expect(memberRole).toBe(starter?.members.find((entry) => entry.id === "planner")?.role)
  expect(agentRole).toBe(plusAgentPresets.find((preset) => preset.id === "planner")?.role)
})

test("User presets are removable, take new presets and members, and say what they are linked to", () => {
  const nodes = all()
  expect(row(nodes, "group:preset:agents:user").add).toBe("preset")
  expect(row(nodes, "group:preset:teams:user").add).toBe("team-preset")
  expect(row(nodes, "group:preset:agents:native").add).toBeUndefined()
  expect(row(nodes, "group:preset:teams:plus").add).toBeUndefined()
  const mine = row(nodes, "agent:preset:mine")
  expect(mine.actions?.remove).toBe(true)
  expect(mine.owner).toEqual({
    level: "preset",
    agent: "mine",
    preset: { ref: { kind: "agent", id: "mine" }, origin: "user" },
    link: { kind: "agent", id: "planner" },
  })
  expect(row(nodes, "agent:preset:orchestrator").actions?.remove).toBe(false)
  const crew = row(nodes, "team:preset:crew")
  expect(crew.add).toBe("agent")
  expect(crew.actions?.remove).toBe(true)
  expect(childIds(nodes, "team:preset:crew")).toEqual(["team:preset:crew:lead"])
  expect(row(nodes, "team:preset:crew:lead").actions?.remove).toBe(true)
  // Presets get the Role/persona row every agent has.
  expect(row(nodes, "item:preset:mine:system:role").label).toBe("Role/persona")
  // A preset's row is found by descending straight to it.
  expect(findRow(input(), "item:preset:orchestrator:tool:shell")?.address).toEqual({
    level: "preset",
    agent: "orchestrator",
    item: "tool:shell",
    section: null,
  })
  expect(findRow(input(), "item:preset:crew/:lead:tool:shell")?.address?.team).toEqual({ level: "preset", team: "crew" })
})

test("Defaults lists Agents entries under Agents → User and Teams entries per team pattern, wildcards included", () => {
  const nodes = all()
  // Exact names first, then more literal characters.
  expect(childIds(nodes, "group:defaults:agents:user")).toEqual([
    "agent:defaults:reviewer",
    "agent:defaults:*orchestrator*",
    "agent:defaults:Opus-%",
  ])
  const pattern = row(nodes, "agent:defaults:*orchestrator*")
  expect(pattern.label).toBe("*orchestrator*")
  expect(pattern.actions?.remove).toBe(true)
  expect(pattern.owner).toEqual({ level: "defaults", agent: "*orchestrator*", entry: { catalogue: "agents", name: "*orchestrator*" } })
  expect(row(nodes, "agent:defaults:reviewer").owner?.link).toEqual({ kind: "agent", id: "reviewer" })
  expect(row(nodes, "item:defaults:*orchestrator*:tool:question").address).toEqual({
    level: "defaults",
    agent: "*orchestrator*",
    item: "tool:question",
    section: null,
  })
  // The native agent's own Defaults row is not an entry.
  expect(row(nodes, "agent:defaults:build").owner).toBeUndefined()
  expect(row(nodes, "agent:defaults:build").actions?.remove).toBe(false)

  const teamRows = childIds(nodes, "group:defaults:teams").filter((id) => id.startsWith("team:"))
  expect(teamRows).toEqual(["team:defaults:crew*", "team:defaults:*"])
  const crew = row(nodes, "team:defaults:crew*")
  expect(crew.add).toBe("agent")
  expect(crew.actions?.remove).toBe(true)
  expect(crew.owner?.entry).toEqual({ catalogue: "teams", team: "crew*" })
  expect(childIds(nodes, "team:defaults:crew*")).toEqual(["team:defaults:crew*:*impl*"])
  const impl = row(nodes, "team:defaults:crew*:*impl*")
  expect(impl.owner).toEqual({
    level: "defaults",
    agent: "*impl*",
    team: { level: "defaults", team: "crew*" },
    entry: { catalogue: "teams", team: "crew*", name: "*impl*" },
  })
  expect(row(nodes, "item:defaults:crew*/:*impl*:tool:shell").address).toEqual({
    level: "defaults",
    agent: "*impl*",
    item: "tool:shell",
    section: null,
    team: { level: "defaults", team: "crew*" },
    catalogue: "teams",
  })
})

test("add affordances: Defaults Agents and its User group add entries, Defaults Teams adds a team entry", () => {
  const nodes = all()
  expect(row(nodes, "group:defaults:agents").add).toBe("agent")
  expect(row(nodes, "group:defaults:agents:user").add).toBe("agent")
  expect(row(nodes, "group:defaults:teams").add).toBe("team")
  expect(row(nodes, "team:defaults:*").add).toBe("agent")
})

test("rows say where their state comes from: preset, default entry, Defaults, OpenCode, off", () => {
  const nodes = all()
  const badge = (id: string) => row(nodes, id).badges.fromLabel
  // alice is linked to Plus orchestrator, which switches `question` off and ships `shell` on.
  expect(badge("item:project:alice:tool:question")).toBe("from preset Orchestrator")
  expect(row(nodes, "item:project:alice:tool:question").badges.state).toBe("off")
  expect(row(nodes, "item:project:alice:tool:question").badges.from).toEqual({ kind: "preset", id: "orchestrator", shipped: true })
  // opus-orchestrator is unlinked; the `*orchestrator*` entry turns `question` on.
  expect(badge("item:project:opus-orchestrator:tool:question")).toBe("from default *orchestrator*")
  expect(row(nodes, "item:project:opus-orchestrator:tool:question").badges.state).toBe("on")
  // bob matches nothing: shared rows fall back to off, except what Defaults sets for everyone.
  expect(badge("item:project:bob:tool:shell")).toBe("off by default")
  expect(row(nodes, "item:project:bob:tool:shell").badges.state).toBe("off")
  expect(badge("item:project:bob:tool:read")).toBe("from Defaults (every agent)")
  // The displayed origin changes, but its API discriminator stays compatible.
  expect(badge("item:defaults:build:tool:shell")).toBe("OpenCode")
  expect(row(nodes, "item:defaults:build:tool:shell").badges.from).toEqual({ kind: "native" })
  // A member preset reads through its shipped link to its agent preset.
  expect(badge("item:preset:starter/:planner:tool:shell")).toBe("from preset Planner")
  // A value set on the row itself.
  const own = expandedTree(input({ records: [record("project", "bob", "tool:shell", "on")] }))
  expect(own.find((node) => node.id === "item:project:bob:tool:shell")?.badges.fromLabel).toBe("set here")
  // `list` projects it.
  expect(query(input(), { where: "id:item:project:bob:tool:shell", fields: ["id", "from"] }).rows).toEqual([
    { id: "item:project:bob:tool:shell", from: "off by default" },
  ])
})

test("fromLabel and reviewLabel wording", () => {
  const labels = presetLabels(presetListing())
  expect(fromLabel({ kind: "preset", id: "orchestrator", shipped: false }, { labels })).toBe("from preset Orchestrator")
  expect(fromLabel({ kind: "preset", id: "editor", team: "review", shipped: true }, { labels })).toBe("from preset review › editor")
  expect(fromLabel({ kind: "preset", id: "mine", shipped: false })).toBe("from preset mine")
  expect(fromLabel({ kind: "default", name: "*orch*" })).toBe("from default *orch*")
  expect(fromLabel({ kind: "default", name: "*impl*", team: "crew*" })).toBe("from default crew* › *impl*")
  expect(fromLabel({ kind: "defaults-everyone" })).toBe("from Defaults (every agent)")
  expect(fromLabel({ kind: "native" })).toBe("OpenCode")
  expect(fromLabel({ kind: "upstream" })).toBe("upstream")
  expect(fromLabel({ kind: "off" })).toBe("off by default")
  expect(fromLabel({ kind: "level", level: "global" })).toBe("from global")
  expect(fromLabel({ kind: "level", level: "project" }, { level: "project" })).toBe("set here")
  expect(reviewLabel(["text"])).toBe("to review")
  expect(reviewLabel(["state"])).toBe("to review (state)")
  expect(reviewLabel(["text", "pin"])).toBe("to review (text, pin)")
})

test("a state set against a value above that later changed reads to review (state) on the row", () => {
  // bob's own `shell` on was set while Defaults for everyone had it off; now Defaults says on.
  const own: CustomizationRecord = { ...record("project", "bob", "tool:shell", "on"), basedOnState: "off" }
  const nodes = expandedTree(input({ records: [own, record("defaults", null, "tool:shell", "on")] }))
  const shell = nodes.find((node) => node.id === "item:project:bob:tool:shell")
  expect(shell?.badges.review).toBe(true)
  expect(shell?.badges.reviewOf).toEqual(["state"])
  expect(query(input({ records: [own, record("defaults", null, "tool:shell", "on")] }), { where: "id:item:project:bob:tool:shell", fields: ["id", "badges"] }).rows[0]?.badges).toBe(
    "on to review (state)",
  )
})

test("query finds preset rows by level and keeps them out of other roots' walks", () => {
  const rows = query(input(), { where: "level:preset kind:agent", fields: ["id"] }).rows.map((entry) => entry.id)
  expect(rows).toContain("agent:preset:orchestrator")
  expect(rows).toContain("agent:preset:mine")
  expect(rows.every((id) => id.startsWith("agent:preset:"))).toBe(true)
  const teams = query(input(), { where: "level:preset kind:team team:starter", fields: ["id"] }).rows.map((entry) => entry.id)
  expect(teams).toContain("team:preset:starter")
  expect(teams).toContain("team:preset:starter:planner")
  expect(query(input(), { where: "catalogue:teams id:group:preset:starter/", fields: ["id"] }).total).toBeGreaterThan(0)
})
