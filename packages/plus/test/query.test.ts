import { expect, test } from "bun:test"
import { controlItems } from "../src/instructions/agent-controls.js"
import { Schema } from "effect"
import {
  fingerprint,
  type AgentSource,
  type CustomizationRecord,
  type Item,
  type LinkRecord,
  type SplitRecord,
} from "../src/instructions/model.js"
import { buildMemo, type TeamInput } from "../src/instructions/resolve-memo.js"
import { findCollapse, matchedTree, query } from "../src/instructions/query.js"
import { itemOf } from "../src/instructions/snapshot.js"
import { policyMembersOf, teamPolicyItems } from "../src/instructions/team-policy-rows.js"
import { buildTreeMemo, expandedTree, type TreeNode } from "../src/instructions/tree.js"
import { parentsOf } from "../src/tui/instructions/workspace.js"
import { Plus } from "../src/rpc.js"
import { badgeLabels } from "../src/tui/instructions/tree-pane.js"

const OLD = "2026-01-01T00:00:00.000Z"

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
    basedOn: fingerprint("run commands"),
    updated: OLD,
    ...overrides,
  }
}

function agents(): AgentSource[] {
  return [
    { id: "Implementer", scope: "project", base: "gpt", path: "/agents/Implementer.md", origin: "user" },
    { id: "CrewMate", scope: "project", base: "gpt", origin: "user" },
    { id: "Helper", scope: "global", base: "claude", origin: "user" },
    { id: "Template", scope: "defaults", base: "gpt", origin: "user" },
  ]
}

function teams(): TeamInput[] {
  return [
    { level: "project", team: "crew", enabled: true, agents: ["CrewMate"] },
    { level: "global", team: "ops", enabled: false, agents: [] },
  ]
}

function items(): Item[] {
  const text = (value: string, overrides?: Partial<Item>): Item => makeItem({ text: value, ...overrides })
  return [
    ...controlItems(),
    text("run commands", { id: "tool:bash", kind: "tool", group: "native", title: "bash", order: 1 }),
    text("v2 upstream", { id: "tool:plus-one", kind: "tool", group: "plus", title: "plus-one" }),
    text("odd-name", { id: "tool:odd-name", kind: "tool", group: "mcp", server: "sample", title: "odd-name" }),
    text("# Alpha\n\na\n\n# Beta\n\nb\n", { id: "tool:coder", kind: "tool", group: "native", title: "coder", codemode: true }),
    text("", { id: "tool:empty", kind: "tool", group: "native", title: "empty" }),
    text("gpt base", { id: "base:gpt", kind: "base", group: "none", title: "gpt.txt" }),
    text("claude base", { id: "base:claude", kind: "base", group: "none", title: "claude.txt" }),
    text("custom base", { id: "base:custom", kind: "base", group: "none", title: "Custom.txt", userBase: true }),
    // Skills are listed under the skill tool, which core always registers.
    text("load a skill", { id: "tool:skill", kind: "tool", group: "native", title: "skill", order: 2 }),
    text("native skill", { id: "skill:native-one", kind: "skill", group: "native", title: "native-one" }),
    text("project skill", { id: "skill:proj-one", kind: "skill", group: "project", title: "proj-one" }),
    text("review body", { id: "skill:review", kind: "skill", group: "plus", title: "Code Review" }),
    text("# Purpose\n\na\n\n# Usage\n\nb\n", { id: "system:role", kind: "system", group: "none", title: "Role" }),
    text("guide text", { id: "system:guide", kind: "system", group: "project", title: "guide" }),
    text("sample-config", { id: "mcp:sample", kind: "mcp", group: "none", title: "sample" }),
    text("extra-config", { id: "mcp:extra", kind: "mcp", group: "none", title: "extra" }),
  ]
}

function records(): (CustomizationRecord | SplitRecord)[] {
  const fresh = new Date().toISOString()
  return [
    makeRecord({ item: "tool:bash", text: "custom bash", basedOnText: "run commands" }),
    makeRecord({ item: "tool:plus-one", text: "mine", basedOn: fingerprint("v1"), basedOnText: "v1" }),
    makeRecord({ level: "defaults", agent: null, item: "tool:plus-one", text: "shared", basedOn: fingerprint("v2 upstream"), basedOnText: "v2 upstream" }),
    makeRecord({ item: "skill:native-one", state: "off" }),
    makeRecord({ level: "global", agent: "Helper", item: "skill:native-one", text: "helper edit", basedOn: fingerprint("native skill"), basedOnText: "native skill" }),
    makeRecord({ item: "system:guide", text: "my guide", basedOn: fingerprint("guide text"), basedOnText: "guide text", acknowledged: fingerprint("guide text") }),
    makeRecord({ item: "system:role", section: "usage", state: "off" }),
    makeRecord({ item: "system:role", state: "off" }),
    makeRecord({ item: "base:gpt", state: "off" }),
    makeRecord({ item: "base:custom", text: "custom base", basedOn: fingerprint("older"), basedOnText: "older" }),
    makeRecord({ item: "tool:coder", text: "hacked", basedOn: fingerprint("# Alpha\n\na\n\n# Beta\n\nb\n") }),
    makeRecord({ level: "defaults", agent: null, item: "mcp:sample", text: "mine-config", basedOn: fingerprint("sample-config") }),
    makeRecord({ level: "defaults", agent: null, item: "mcp:extra", state: "off" }),
    makeRecord({ item: "mcp:sample", state: "off" }),
    makeRecord({ level: "defaults", agent: "Template", item: "base:gpt", text: "tweak", basedOn: fingerprint("gpt base"), basedOnText: "gpt base", updated: fresh }),
    makeRecord({ item: "tool:gone", text: "stale", basedOn: fingerprint("gone") }),
    makeRecord({ item: "tool:bash", section: "nosuch", text: "stale section", basedOn: fingerprint("x") }),
    makeRecord({ agent: "Ghost", item: "tool:bash", state: "off" }),
    { type: "split", level: "project", agent: "Implementer", item: "system:guide", boundaries: [{ id: "a", name: "A", start: 0 }], updated: OLD },
  ]
}

// DESIGN §3.3: a user agent's shared rows fall back to off unless a preset
// sets them. The fixture agents stand for agents created from the Native
// `build` preset (linked where each is addressed), so the rows the filters
// are about keep their native state unless a record changes them.
function linksFor(fixture: readonly AgentSource[]): LinkRecord[] {
  return fixture.map((agent) => ({
    type: "link",
    level: agent.scope,
    agent: agent.id,
    preset: { kind: "agent", id: "build" },
    updated: OLD,
  }))
}

function input(overrides?: { items?: Item[]; records?: (CustomizationRecord | SplitRecord)[]; agents?: AgentSource[]; teams?: TeamInput[] }) {
  const fixture = overrides?.agents ?? agents()
  return {
    items: overrides?.items ?? items(),
    records: overrides?.records ?? records(),
    agents: fixture,
    teams: overrides?.teams ?? teams(),
    links: linksFor(fixture),
  }
}

function ids(where: string, opts?: { teams?: TeamInput[] }): string[] {
  return query(input(opts === undefined ? undefined : { teams: opts.teams }), { where }).rows.map((row) => row.id)
}

const bash = "item:project:Implementer:tool:bash"
const sharedPlus = "item:defaults::tool:plus-one"

test("kind filters by row kind", () => {
  expect(ids("kind:item")).toContain(bash)
  expect(ids("kind:item").some((id) => id.startsWith("group:"))).toBe(false)
  // Project, Global, Defaults and Presets (DESIGN §2).
  expect(ids("kind:root")).toEqual(["root:project", "root:global", "root:defaults", "root:preset"])
  expect(ids("kind:team !level:preset", { teams: [] })).toHaveLength(0)
  // The Plus team preset and its member presets are team rows.
  expect(ids("kind:team level:preset", { teams: [] })).toContain("team:preset:basic")
  expect(ids("kind:team level:preset", { teams: [] })).toContain("team:preset:basic:planner")
})

test("item filters by upstream item kind", () => {
  expect(ids("item:tool")).toContain(bash)
  expect(ids("item:base")).not.toContain(bash)
  expect(ids("item:base")).toContain("item:project:Implementer:base:gpt")
  expect(ids("item:mcp")).toContain("item:defaults::mcp:sample")
  expect(ids("item:mcp")).not.toContain(bash)
})

test("group filters by upstream item group", () => {
  expect(ids("group:native")).toContain(bash)
  expect(ids("group:project")).toContain("item:project:Implementer:skill:proj-one")
  expect(ids("group:project")).not.toContain(bash)
})

test("server matches the mcp server", () => {
  expect(ids("server:sample")).toContain("item:project:Implementer:tool:odd-name")
  expect(ids("server:sample")).toContain("item:defaults::mcp:sample")
  expect(ids("server:sample")).not.toContain(bash)
  expect(ids("server:nope")).toHaveLength(0)
})

test("server:search returns mcp:search row and its tool rows", () => {
  const searchInput = {
    agents: agents(),
    teams: teams(),
    items: [
      makeItem({ id: "mcp:search", kind: "mcp", group: "none", title: "search" }),
      makeItem({ id: "tool:web_exa_code_search", kind: "tool", group: "mcp", server: "search", title: "exa_code_search" }),
      makeItem({ id: "tool:web_tavily_search", kind: "tool", group: "mcp", server: "search", title: "tavily_search" }),
      makeItem({ id: "tool:bash", kind: "tool", group: "native", title: "bash" }),
      makeItem({ id: "mcp:other", kind: "mcp", group: "none", title: "other" }),
    ],
    records: [],
  }
  const result = query(searchInput, { where: "server:search" })
  const resultIds = result.rows.map((r) => r.id)
  expect(resultIds).toContain("item:defaults::mcp:search")
  expect(resultIds).toContain("item:project:Implementer:tool:web_exa_code_search")
  expect(resultIds).toContain("item:project:Implementer:tool:web_tavily_search")
  expect(resultIds).not.toContain("item:defaults::mcp:other")
  expect(resultIds.some((id) => id.includes("tool:bash"))).toBe(false)
})

test("level scopes rows to their level", () => {
  expect(ids("level:project")).toContain(bash)
  expect(ids("level:project")).not.toContain(sharedPlus)
  expect(ids("level:defaults")).toContain(sharedPlus)
  expect(ids("level:defaults")).not.toContain(bash)
})

test("agent matches the row owner and _ the shared rows", () => {
  expect(ids("agent:Implementer")).toContain(bash)
  expect(ids("agent:Implementer")).not.toContain("item:global:Helper:tool:bash")
  expect(ids("agent:_")).toContain(sharedPlus)
  expect(ids("agent:_")).not.toContain(bash)
})

test("agent is the exact name ignoring case, * a pattern, _ the shared rows", () => {
  expect(ids("agent:impl")).not.toContain(bash)
  expect(ids("agent:IMPLEMENTER")).toContain(bash)
  expect(ids("agent:impl*")).toContain(bash)
  expect(ids("agent:%MENT%")).toContain(bash)
  expect(ids("agent:impl*")).not.toContain("item:global:Helper:tool:bash")
  expect(ids("agent:_")).toContain(sharedPlus)
  expect(ids("agent:_")).not.toContain(bash)
  const withUnderscore = input({ agents: [...agents(), { id: "my_agent", scope: "project", base: "gpt" }] })
  const underscoreItem = "item:project:my_agent:tool:bash"
  const underscoreAgent = "agent:project:my_agent"
  const sharedIds = query(withUnderscore, { where: "agent:_" }).rows.map((row) => row.id)
  expect(sharedIds).toContain(sharedPlus)
  expect(sharedIds).not.toContain(underscoreItem)
  expect(sharedIds).not.toContain(underscoreAgent)
  const subIds = query(withUnderscore, { where: "agent:my_*" }).rows.map((row) => row.id)
  expect(subIds).toContain(underscoreItem)
  expect(subIds).toContain(underscoreAgent)
  expect(subIds).not.toContain(sharedPlus)
})

test("sections projection survives structural filtering", () => {
  const whole = ["item:project:Implementer:tool:bash:description"]
  expect(query(input(), { where: "kind:item", fields: ["id", "sections"] }).rows.find((row) => row.id === bash)?.sections).toEqual(whole)
  expect(query(input(), { where: "can:split", fields: ["id", "sections"] }).rows.find((row) => row.id === bash)?.sections).toEqual(whole)
})

test("state reads the resolved on/off badge", () => {
  expect(ids("state:off")).toContain("item:project:Implementer:skill:native-one")
  expect(ids("state:off")).not.toContain(bash)
  expect(ids("state:on")).toContain(bash)
})

test("modified is text-only", () => {
  expect(ids("modified:true")).toContain(bash)
  expect(ids("modified:true")).not.toContain("item:project:Implementer:skill:native-one")
  expect(ids("modified:false")).toContain("item:project:Implementer:skill:native-one")
})

test("review matches the tree review badge", () => {
  expect(ids("review:true")).toContain("item:project:Implementer:tool:plus-one")
  expect(ids("review:true")).not.toContain(bash)
  expect(ids("review:false")).toContain(bash)
})

test("source names the winning level", () => {
  expect(ids("source:project")).toContain(bash)
  // The fixture agents are linked to Native `build`, whose shipped content is
  // now the winning level of every row it answers (DESIGN §3.4); a row no
  // node answers (Helper's own prompt: `build`'s role is not in this
  // inventory) still reads upstream.
  expect(ids("source:preset")).toContain("item:project:Implementer:tool:odd-name")
  expect(ids("source:upstream")).toContain("item:global:Helper:system:role")
  expect(ids("source:upstream")).not.toContain(bash)
})

test("overridden means a text record at exactly this address", () => {
  expect(ids("overridden:true")).toContain(bash)
  expect(ids("overridden:true")).not.toContain("item:project:Implementer:skill:native-one")
  expect(ids("overridden:false")).toContain("item:project:Implementer:skill:native-one")
})

test("active marks the agent's live base template", () => {
  expect(ids("active:true")).toContain("item:project:Implementer:base:gpt")
  expect(ids("active:true")).not.toContain("item:project:Implementer:base:claude")
})

test("inactive marks user base templates only", () => {
  expect(ids("inactive:true")).toContain("item:project:Implementer:base:custom")
  expect(ids("inactive:true")).not.toContain("item:project:Implementer:base:gpt")
  expect(ids("inactive:false")).toContain("item:project:Implementer:base:gpt")
})

test("unsupported flags only unexcludable rows, never Code Mode tools", () => {
  expect(ids("unsupported:true")).not.toContain("item:project:Implementer:tool:coder")
  expect(ids("unsupported:true")).toContain("item:project:Implementer:system:role")
  expect(ids("unsupported:false")).toContain(bash)
  expect(ids("unsupported:false")).toContain("item:project:Implementer:tool:coder")
})

test("codemode follows the upstream item", () => {
  expect(ids("codemode:true")).toContain("item:project:Implementer:tool:coder")
  expect(ids("codemode:false")).toContain(bash)
})

test("can reads the row actions including pin", () => {
  expect(ids("can:toggle")).toContain(bash)
  expect(ids("can:toggle")).not.toContain("item:project:Implementer:system:role")
  expect(ids("can:toggle")).toContain("item:project:Implementer:tool:coder")
  expect(ids("can:reset")).toContain(bash)
  expect(ids("can:reset")).not.toContain("item:project:Implementer:tool:odd-name")
  expect(ids("can:split")).toContain(bash)
  expect(ids("can:split")).not.toContain("item:defaults::mcp:sample")
  expect(ids("can:split")).toContain("item:project:Implementer:setting:description")
  expect(ids("can:remove")).toContain("item:project:Implementer:skill:proj-one")
  expect(ids("can:remove")).not.toContain(bash)
  expect(ids("can:edit")).toContain(bash)
  expect(ids("can:edit")).toContain("item:project:Implementer:tool:coder")
  expect(ids("can:pin")).toContain("item:project:Implementer:tool:coder")
  expect(ids("can:pin")).not.toContain(bash)
  expect(ids("can:pin")).not.toContain("item:project:Implementer:system:role")
})

test("has covers records, splits, sections, and text", () => {
  expect(ids("has:record")).toContain(bash)
  expect(ids("has:record")).not.toContain("item:project:Implementer:tool:odd-name")
  expect(ids("has:split")).toContain("item:project:Implementer:system:guide")
  expect(ids("has:split")).not.toContain(bash)
  expect(ids("has:sections")).toContain(bash)
  expect(ids("has:sections")).not.toContain("group:project:agents")
  expect(ids("has:text")).toContain(bash)
  expect(ids("has:text")).not.toContain("item:project:Implementer:tool:empty")
})

test("id is a prefix match on the row id", () => {
  expect(query(input(), { where: `id:${bash}` }).rows.map((row) => row.id)).toEqual([bash, `${bash}:description`])
  expect(ids("id:zzz")).toHaveLength(0)
})

test("label is a substring match", () => {
  expect(ids("label:bash")).toContain(bash)
  expect(ids("label:zzz")).toHaveLength(0)
})

test("updated compares against durations and dates", () => {
  expect(ids("updated:>7d")).toContain(bash)
  expect(ids("updated:<7d")).not.toContain(bash)
  expect(ids("updated:<7d")).toContain("item:defaults:Template:base:gpt")
  expect(ids("updated:>=2026-01-01")).toContain(bash)
  expect(ids("updated:<2026-01-01")).not.toContain(bash)
})

test("team matches team rows, members, and team agents", () => {
  const found = ids("team:crew")
  expect(found).toContain("team:project:crew")
  expect(found).toContain("team:project:crew:CrewMate")
  expect(found).toContain("team:project:crew:special")
  expect(found).toContain("agent:project:CrewMate")
  for (const group of ["models", "tools", "base", "system"]) {
    expect(found).toContain(`group:project:crew/:CrewMate:${group}`)
  }
  expect(new Set(found).size).toBe(found.length)
  expect(found).not.toContain("team:global:ops")
  expect(ids("team:ops")).toContain("team:global:ops")
  expect(ids("team:nope")).toHaveLength(0)
})

test("team and agent query filters match team special rows and children", () => {
  const customAgents: AgentSource[] = [
    ...agents(),
    { id: "title", scope: "defaults", origin: "special" },
  ]
  const customRecords = [
    ...records(),
    {
      type: "customization" as const,
      level: "project" as const,
      agent: "title",
      team: { level: "project" as const, team: "crew" },
      item: "tool:bash",
      section: null,
      state: "off" as const,
      basedOn: "fp-bash",
      updated: OLD,
    },
  ]
  const customInput = {
    items: items(),
    records: customRecords,
    agents: customAgents,
    teams: teams(),
  }
  const qTeam = query(customInput, { where: "team:crew" }).rows.map((r) => r.id)
  expect(qTeam).toContain("team:project:crew:special")
  expect(qTeam).toContain("team:project:crew:special:title")
  expect(qTeam).toContain("group:project:crew/:special:title:tools")
  expect(qTeam).toContain("item:project:crew/:special:title:tool:bash")

  const qAgent = query(customInput, { where: "agent:title" }).rows.map((r) => r.id)
  expect(qAgent).toContain("team:project:crew:special:title")
  expect(qAgent).toContain("group:project:crew/:special:title:tools")
  expect(qAgent).toContain("item:project:crew/:special:title:tool:bash")
})

test("acked reads the record acknowledgement", () => {
  expect(ids("acked:true")).toContain("item:project:Implementer:system:guide")
  expect(ids("acked:true")).not.toContain(bash)
  expect(ids("acked:false")).toContain(bash)
})

test("excluded follows section state, own or inherited", () => {
  expect(ids("excluded:true")).toContain("section:project:Implementer:system:role:usage")
  // The whole role is off too, so the untouched purpose section is excluded
  // by inheritance rather than by its own state.
  expect(ids("excluded:true")).toContain("section:project:Implementer:system:role:purpose")
  expect(ids("excluded:true")).not.toContain("section:project:Implementer:system:guide:a")
  expect(ids("excluded:false")).toContain("section:project:Implementer:system:guide:a")
  expect(ids("excluded:false")).not.toContain("section:project:Implementer:system:role:usage")
})

test("identical pins a byte-identical override", () => {
  // An agent's copy of the text it inherits is no edit at all (inherited.ts);
  // a preset's copy is kept, since agents linked to it read it too.
  expect(ids("identical:true")).not.toContain("item:project:Implementer:base:custom")
  const preset = makeRecord({ level: "preset", agent: "build", item: "base:custom", text: "custom base", basedOn: fingerprint("custom base") })
  const found = query(input({ records: [...records(), preset] }), { where: "identical:true", withoutAliases: true }).rows.map((row) => row.id)
  expect(found).toEqual(["item:preset:build:base:custom"])
  expect(ids("identical:true")).not.toContain(bash)
  expect(ids("identical:false")).toContain(bash)
})

test("dead pins records that can never apply, never Code Mode text", () => {
  expect(ids("dead:true")).not.toContain("item:project:Implementer:tool:coder")
  expect(ids("dead:false")).toContain("item:project:Implementer:tool:coder")
  expect(ids("dead:true")).toContain("item:defaults::mcp:sample")
  // An agent's own Role/persona falls back to on, so switching it off is an
  // edit, and one that never applies (the role text stays live).
  const ownRole = input({ items: items().map((item) => (item.id === "system:role" ? { ...item, ownedBy: "Implementer" } : item)) })
  expect(query(ownRole, { where: "dead:true", withoutAliases: true }).rows.map((row) => row.id)).toContain("item:project:Implementer:system:role")
  expect(ids("dead:true")).not.toContain(bash)
  expect(ids("dead:true")).not.toContain("section:project:Implementer:system:role:usage")
  expect(ids("dead:false")).toContain(bash)
  // A state-only toggle on an MCP row applies (the server enablement is
  // file-owned, the text is not), so it is not dead.
  expect(ids("dead:false")).toContain("item:defaults::mcp:extra")
})

test("shadowed pins an override a more specific level wins", () => {
  expect(ids("shadowed:true")).toContain(sharedPlus)
  expect(ids("shadowed:true")).not.toContain("item:project:Implementer:tool:plus-one")
  expect(ids("shadowed:false")).toContain("item:project:Implementer:tool:plus-one")
  expect(ids("shadowed:false")).toContain(bash)
})

test("type and name say what a row is and what it is called", () => {
  expect(ids("type:tool agent:Implementer name:bash level:project")).toEqual([bash])
  // agent is the name ignoring case, so the Basic team preset's implementer seat matches too.
  expect(ids("type:tool agent:Implementer name:bash")).toEqual([bash, "item:preset:basic/:implementer:tool:bash"])
  expect(ids("type:skill agent:Implementer").every((id) => id.includes(":skill:"))).toBe(true)
  expect(ids("type:base agent:Implementer")).toContain("item:project:Implementer:base:gpt")
  expect(ids("type:system agent:Implementer")).toContain("item:project:Implementer:system:role")
  expect(ids("type:section agent:Implementer name:usage")).toEqual(["section:project:Implementer:system:role:usage"])
  expect(ids("type:mcp")).toContain("item:defaults::mcp:sample")
  expect(ids("type:team")).toContain("team:project:crew")
  expect(ids("type:member")).toContain("team:project:crew:CrewMate")
  expect(ids("type:preset")).toContain("team:preset:basic")
  expect(ids("type:preset")).toContain("agent:preset:build")
  // A label with a space is quoted; * stands for any text; case does not matter.
  expect(ids('name:"code review" agent:Implementer level:project')).toEqual(["item:project:Implementer:skill:review"])
  expect(ids("name:CODE* agent:Implementer type:tool level:project")).toEqual(["item:project:Implementer:tool:coder"])
  // The older keys take a type value too.
  expect(ids("kind:member")).toEqual(ids("type:member"))
})

test("agent reaches a team member's row and the groups under an agent", () => {
  expect(ids("type:member agent:CrewMate")).toEqual(["team:project:crew:CrewMate"])
  expect(ids("type:group agent:Implementer level:project").length).toBeGreaterThan(0)
  expect(ids("type:group agent:Implementer level:project").every((id) => id.startsWith("group:project:Implementer:"))).toBe(true)
  // A team preset's member seat owns the groups under it.
  expect(ids("type:group agent:Implementer level:preset").every((id) => id.startsWith("group:preset:basic/:implementer:"))).toBe(true)
})

test("tool takes in the tool's own rows: the tool, its parameters and rules", () => {
  const withRule = input({
    items: [...items(), makeItem({ id: "perm:bash:git-push", kind: "perm", group: "native", title: "git push", permTool: "bash", text: "" })],
  })
  const found = query(withRule, { where: "tool:bash agent:Implementer" }).rows.map((row) => row.id)
  expect(found).toContain(bash)
  expect(found).toContain("item:project:Implementer:perm:bash:git-push")
  expect(query(withRule, { where: "type:rule name:git-push agent:Implementer level:project" }).rows.map((row) => row.id)).toEqual(["item:project:Implementer:perm:bash:git-push"])
})

test("in lists the rows under a row", () => {
  expect(ids("in:item:project:Implementer:system:role")).toEqual(["section:project:Implementer:system:role:purpose", "section:project:Implementer:system:role:usage"])
  expect(ids("in:item:project:Implementer:system:role name:usage")).toEqual(["section:project:Implementer:system:role:usage"])
})

test("is names the rows holding an edit", () => {
  // review: the row's own review, not the groups and agents that count it.
  expect(ids("is:review")).toContain("item:project:Implementer:tool:plus-one")
  expect(ids("is:review").some((id) => id.startsWith("group:") || id.startsWith("root:") || id.startsWith("agent:"))).toBe(false)
  // changed: an edit stored on the row.
  expect(ids("is:changed")).toContain(bash)
  expect(ids("is:changed")).toContain("item:project:Implementer:skill:native-one")
  expect(ids("is:changed")).not.toContain("item:project:CrewMate:tool:bash")
  // overruled: an agent's own text or on/off a more specific level sets too; a
  // shared edit one agent overrides still applies to the others.
  const shadowedState = input({
    records: [
      makeRecord({ level: "global", agent: "Helper", item: "tool:bash", state: "off" }),
      makeRecord({ level: "project", agent: "Helper", item: "tool:bash", state: "on" }),
    ],
  })
  expect(query(shadowedState, { where: "is:overruled", withoutAliases: true }).rows.map((row) => row.id)).toEqual(["item:global:Helper:tool:bash"])
  expect(ids("is:overruled")).not.toContain(sharedPlus)
  expect(() => ids("is:hidden")).toThrow("overruled")
  expect(ids("is:orphaned").sort()).toEqual(ids("orphan:true").sort())
})

test("findCollapse turns off each part a question asks past", () => {
  const all = { sections: true, descriptions: true, presets: true, levels: true, copies: true }
  expect(findCollapse("")).toEqual(all)
  expect(findCollapse('type:"tool" state:"off"')).toEqual(all)
  expect(findCollapse('type:"section"')).toEqual({ ...all, sections: false })
  expect(findCollapse('name:"usage"')).toEqual({ ...all, sections: false })
  expect(findCollapse('level:"preset"')).toEqual({ ...all, presets: false, levels: false })
  expect(findCollapse('agent:"alpha"')).toEqual({ ...all, copies: false })
  expect(findCollapse("!agent:alpha")).toEqual(all)
  expect(findCollapse('is:"changed"')).toEqual({ ...all, presets: false, levels: false, copies: false })
  // held-back asks what the agent gets: one row per thing, sections included.
  expect(findCollapse('is:"held-back"')).toEqual({ ...all, sections: false })
  expect(findCollapse("is:held-back,changed")).toEqual({ ...all, sections: false, presets: false, levels: false, copies: false })
  expect(findCollapse('in:"item:project:a:tool:x"')).toEqual({ ...all, sections: false, presets: false, levels: false, copies: false })
  expect(findCollapse("id:item:project:")).toEqual({ sections: false, descriptions: false, presets: false, levels: false, copies: false })
})

test("find's collapse answers each thing once", () => {
  const find = (where: string) => query(input(), { where, collapse: findCollapse(where) }).rows
  // Each skill once: copies with the same value fold into one row that counts the rest.
  const skills = find("type:skill")
  expect(new Set(skills.map((row) => row.id)).size).toBe(skills.length)
  expect(skills.some((row) => (row.copies ?? 0) > 0)).toBe(true)
  expect(skills.some((row) => row.id.includes(":preset:"))).toBe(false)
  // Implementer's own edit is its own row.
  expect(find("type:tool name:bash").map((row) => row.id)).toContain(bash)
  // Sections only when asked; the item carries a text match.
  expect(find("agent:Implementer text:b").some((row) => row.id.startsWith("section:"))).toBe(false)
  expect(find("agent:Implementer type:section").some((row) => row.id.startsWith("section:"))).toBe(true)
})

test("orphan synthesizes rows for stale records only when asked", () => {
  const found = ids("orphan:true").sort()
  expect(found).toEqual(
    [
      "item:project:Ghost:tool:bash",
      "item:project:Implementer:tool:gone",
      "section:project:Implementer:tool:bash:nosuch",
    ].sort(),
  )
  const labels = query(input(), { where: "orphan:true", fields: ["id", "label"] }).rows.map((row) => row.label).sort()
  expect(labels).toEqual(["nosuch", "tool:bash", "tool:gone"].sort())
  expect(ids("orphan:false").some((id) => id.includes("tool:gone") || id.includes("nosuch") || id.includes("Ghost"))).toBe(false)
  expect(ids("kind:item").some((id) => id.includes("tool:gone"))).toBe(false)
  expect(ids("orphan:true kind:item").sort()).toEqual(["item:project:Ghost:tool:bash", "item:project:Implementer:tool:gone"].sort())
  expect(ids("orphan:true agent:Ghost")).toEqual(["item:project:Ghost:tool:bash"])
})

test("tokens counts ceil(length/4) of the resolved text", () => {
  expect(ids("tokens:3")).toContain(bash)
  expect(ids("tokens:>100000")).toHaveLength(0)
  expect(ids("tokens:>0")).toContain(bash)
})

test("namespace filters by the tool namespace", () => {
  const namespaced = input({
    items: [
      makeItem({ id: "tool:ns-one", kind: "tool", group: "native", title: "ns-one", text: "one", namespace: "alpha" }),
      makeItem({ id: "tool:plain", kind: "tool", group: "native", title: "plain", text: "plain" }),
    ],
    records: [],
  })
  const found = query(namespaced, { where: "namespace:alpha" }).rows.map((row) => row.id)
  expect(found.some((id) => id.endsWith("tool:ns-one"))).toBe(true)
  expect(found.some((id) => id.endsWith("tool:plain"))).toBe(false)
  expect(query(namespaced, { where: "namespace:missing" }).rows).toHaveLength(0)
  expect(query(namespaced, { where: "namespace:ALPHA" }).rows.map((row) => row.id).some((id) => id.endsWith("tool:ns-one"))).toBe(
    true,
  )
})

test("pinned follows the resolved pin, never sections", () => {
  const snap = input({
    items: [
      makeItem({ id: "tool:pinned-tool", kind: "tool", group: "native", title: "pinned-tool", text: "desc", codemode: true, pinned: true }),
      makeItem({ id: "tool:plain-tool", kind: "tool", group: "native", title: "plain-tool", text: "desc", codemode: true }),
      makeItem({ id: "tool:unpinned-tool", kind: "tool", group: "native", title: "unpinned-tool", text: "desc", codemode: true }),
    ],
    records: [makeRecord({ item: "tool:plain-tool", pin: true })],
  })
  const pinned = query(snap, { where: "pinned:true" }).rows.map((row) => row.id)
  expect(pinned.some((id) => id.endsWith("tool:pinned-tool"))).toBe(true)
  expect(pinned.some((id) => id.endsWith("tool:plain-tool"))).toBe(true)
  expect(pinned.some((id) => id.endsWith("tool:unpinned-tool"))).toBe(false)
  expect(pinned.some((id) => id.includes("tool:plain-tool:") && id.startsWith("section:"))).toBe(false)
  const unpinned = query(snap, { where: "pinned:false" }).rows.map((row) => row.id)
  expect(unpinned.some((id) => id.endsWith("tool:unpinned-tool"))).toBe(true)
  expect(unpinned.some((id) => id.endsWith("tool:pinned-tool"))).toBe(false)
})

test("execute flags the synthetic host-owned row", () => {
  const snap = input({
    items: [
      makeItem({ id: "tool:execute", kind: "tool", group: "native", title: "execute", text: "host entry", codemode: false, execute: true }),
      makeItem({ id: "tool:bash", kind: "tool", group: "native", title: "bash", text: "run" }),
    ],
    records: [],
  })
  const flagged = query(snap, { where: "execute:true" }).rows.map((row) => row.id)
  expect(flagged.some((id) => id.endsWith("tool:execute"))).toBe(true)
  expect(flagged.some((id) => id.endsWith("tool:bash"))).toBe(false)
  expect(query(snap, { where: "execute:false" }).rows.map((row) => row.id).some((id) => id.endsWith("tool:bash"))).toBe(true)
})

test("tokens on Code Mode rows count only the first line truncated at 120", () => {
  const longFirst = `${"x".repeat(200)}\nsecond line that never reaches the catalog`
  const snap = input({
    items: [
      makeItem({ id: "tool:long", kind: "tool", group: "native", title: "long", text: longFirst, codemode: true }),
      makeItem({ id: "tool:plain-long", kind: "tool", group: "native", title: "plain-long", text: longFirst }),
    ],
    records: [],
  })
  const coder = query(snap, { where: "id:item:project:Implementer:tool:long", fields: ["id", "tokens"] }).rows[0]
  expect(coder?.tokens).toBe(Math.ceil(120 / 4))
  const plain = query(snap, { where: "id:item:project:Implementer:tool:plain-long", fields: ["id", "tokens"] }).rows[0]
  expect(plain?.tokens).toBe(Math.ceil(longFirst.length / 4))
  const twoLine = "first\nsecond line much longer than first"
  const snap2 = input({
    items: [makeItem({ id: "tool:two", kind: "tool", group: "native", title: "two", text: twoLine, codemode: true })],
    records: [],
  })
  const two = query(snap2, { where: "id:item:project:Implementer:tool:two", fields: ["id", "tokens"] }).rows[0]
  expect(two?.tokens).toBe(Math.ceil("first".length / 4))
})

test("delta counts changed lines, zero without an override", () => {
  expect(ids("delta:2")).toContain(bash)
  expect(ids("delta:>2")).not.toContain(bash)
  expect(ids("delta:0")).toContain("item:project:Implementer:tool:odd-name")
  expect(ids("delta:0")).not.toContain(bash)
})

test("overriders counts agents on Defaults shared rows", () => {
  expect(ids("overriders:2")).toContain("item:defaults::skill:native-one")
  expect(ids("overriders:>0")).not.toContain("item:project:Implementer:skill:native-one")
  expect(ids("overriders:0")).toContain(bash)
})

test("text and upstream search resolved and upstream bodies", () => {
  expect(ids("text:CUSTOM")).toContain(bash)
  expect(ids("text:zzz")).toHaveLength(0)
  expect(ids('upstream:"run commands"')).toContain(bash)
  expect(ids("upstream:zzz")).toHaveLength(0)
})

test("quoted values honor backslash escapes", () => {
  const quoted = input({
    items: [...items(), makeItem({ id: "tool:quoted", kind: "tool", group: "native", title: "quoted", text: 'say "hi" now' })],
  })
  const found = query(quoted, { where: 'text:"say \\"hi\\" now"' }).rows.map((row) => row.id)
  expect(found.some((id) => id.endsWith("tool:quoted"))).toBe(true)
  expect(query(quoted, { where: 'text:"say \\"hi\\" now" kind:item' }).rows.map((row) => row.id).some((id) => id.endsWith("tool:quoted"))).toBe(true)
})

test("bare words match label or id exactly like the TUI filter", () => {
  const tree = expandedTree(input())
  for (const word of ["bash", "Implementer", "zz-no-match"]) {
    const lowered = word.toLowerCase()
    const expected = [
      ...new Set(
        tree
          .filter((node) => node.label.toLowerCase().includes(lowered) || node.id.toLowerCase().includes(lowered))
          .map((node) => node.id),
      ),
    ].sort()
    const actual = query(input(), { where: word }).rows.map((row) => row.id).sort()
    expect(actual).toEqual(expected)
  }
})

test("negation, OR, quotes, and combined terms", () => {
  expect(ids("!kind:item")).not.toContain(bash)
  expect(ids("!kind:item")).toContain("root:project")
  expect(ids("kind:item,section")).toContain(bash)
  expect(ids("kind:item,section")).toContain("section:project:Implementer:system:role:purpose")
  expect(ids("kind:item,section")).not.toContain("root:project")
  expect(ids('label:"Code Review"')).toContain("item:project:Implementer:skill:review")
  // Two catalogues means two shared rows and, for a team member, one row per
  // catalogue: the stand-alone id and the `<team>/:<member>` id. Presets carry
  // their own rows (presets-tree.test.ts), so they are left out here.
  expect(ids("kind:item label:bash !level:preset").sort()).toEqual(
    [
      "item:project:Implementer:tool:bash",
      "item:project:CrewMate:tool:bash",
      "item:project:crew/:CrewMate:tool:bash",
      "item:global:Helper:tool:bash",
      "item:defaults:Template:tool:bash",
      "item:defaults::tool:bash",
      "item:defaults:/teams:tool:bash",
    ].sort(),
  )
  expect(ids("kind:item label:bash catalogue:teams !level:preset").sort()).toEqual(
    ["item:project:crew/:CrewMate:tool:bash", "item:defaults:/teams:tool:bash"].sort(),
  )
})

test("sort directive, explicit sort, and ordering", () => {
  expect(query(input(), { where: "kind:root sort:label" }).rows.map((row) => row.id)).toEqual([
    "root:defaults",
    "root:global",
    "root:preset",
    "root:project",
  ])
  expect(query(input(), { where: "kind:root sort:label", sort: "-label" }).rows.map((row) => row.id)).toEqual([
    "root:project",
    "root:preset",
    "root:global",
    "root:defaults",
  ])
  const byTokens = query(input(), { where: "kind:item level:project agent:Implementer", sort: "tokens" }).rows
  const counts = byTokens.map((row) => row.tokens ?? 0)
  expect([...counts].sort((a, b) => a - b)).toEqual(counts)
  const byUpdated = query(input(), { where: "kind:item has:record sort:updated" }).rows
  expect(byUpdated[byUpdated.length - 1]?.id).toBe("item:defaults:Template:base:gpt")
  expect(query(input(), { where: "has:record sort:-updated" }).rows[0]?.id).toBe("item:defaults:Template:base:gpt")
})

test("limit, offset, and total", () => {
  const all = query(input(), { where: "kind:item" })
  expect(all.rows.length).toBeGreaterThan(3)
  const limited = query(input(), { where: "kind:item", limit: 2 })
  expect(limited.rows).toHaveLength(2)
  expect(limited.total).toBe(all.total)
  expect(limited.rows).toEqual(all.rows.slice(0, 2))
  const offset = query(input(), { where: "kind:item", offset: 1, limit: 2 })
  expect(offset.rows).toEqual(all.rows.slice(1, 3))
  expect(offset.total).toBe(all.total)
})

test("projection defaults and opt-in fields", () => {
  const [row] = query(input(), { where: `id:${bash}` }).rows
  expect(Object.keys(row ?? {}).sort()).toEqual(["badges", "id", "source", "tokens"].sort())
  expect(row).toMatchObject({ id: bash, badges: "on modified", source: "project", tokens: 3 })
  const [reviewed] = query(input(), { where: "id:item:project:Implementer:tool:plus-one" }).rows
  expect(reviewed?.badges).toBe("on modified to review")
  const full = query(input(), {
    where: `id:${bash}`,
    fields: ["id", "label", "text", "upstream", "record", "path", "updated", "sections"],
  }).rows[0]
  expect(full).toMatchObject({ id: bash, label: "bash", text: "custom bash", upstream: "run commands", updated: OLD })
  expect(full?.record).toMatchObject({ text: "custom bash" })
  expect(full?.sections).toEqual(["item:project:Implementer:tool:bash:description"])
  expect(full).not.toHaveProperty("path")
  expect(full).not.toHaveProperty("tokens")
  const [agent] = query(input(), { where: "id:agent:project:Implementer", fields: ["id", "label", "path", "text", "record"] }).rows
  expect(agent).toMatchObject({ id: "agent:project:Implementer", label: "Implementer", path: "/agents/Implementer.md" })
  expect(agent).not.toHaveProperty("text")
  expect(agent).not.toHaveProperty("record")
  for (const candidate of query(input(), { where: "kind:item", fields: ["id", "badges", "source", "tokens", "text", "upstream", "record", "label", "path", "updated", "sections"] }).rows) {
    for (const value of Object.values(candidate)) expect(value).not.toBeUndefined()
    expect(candidate).not.toHaveProperty("path")
  }
})

test("query badges match the tree badges for every row", () => {
  const tree = expandedTree(input())
  const rows = new Map(query(input(), { fields: ["id", "badges", "source"] }).rows.map((row) => [row.id, row]))
  for (const node of tree) {
    const found = rows.get(node.id)
    expect(found).toBeDefined()
    expect(found?.badges).toBe(badgeLabels(node).join(" "))
    expect(found?.source).toBe(node.badges.source)
  }
})

test("unknown keys and malformed comparisons throw naming the term", () => {
  expect(() => query(input(), { where: "foo:bar" })).toThrow('unknown filter key "foo" in "foo:bar"; keys: agent, team, level, type, name, in, state, is, text')
  // The keys agents reached for name what says it instead.
  expect(() => query(input(), { where: "member:Planner" })).toThrow("a team member is an agent: use agent:<member>, with team:<team>")
  expect(() => query(input(), { where: "preset:build-seat" })).toThrow("use type:preset name:<preset>")
  expect(() => query(input(), { where: "system:role" })).toThrow("use type:system name:<name>")
  expect(() => query(input(), { where: "item:system:role" })).toThrow("item takes a type; for one row use type:system name:role")
  expect(() => query(input(), { where: "item:perm:team_delegate" })).toThrow("use type:rule name:team_delegate")
  expect(() => query(input(), { where: "type:banana" })).toThrow('bad type value in "type:banana"')
  expect(() => query(input(), { where: "tokens:>x" })).toThrow('bad numeric comparison in "tokens:>x"')
  expect(() => query(input(), { where: "kind:banana" })).toThrow('bad kind value in "kind:banana"')
  expect(() => query(input(), { where: "sort:nope" })).toThrow('bad sort key in "sort:nope"')
  expect(() => query(input(), { where: "updated:>soon" })).toThrow('bad time comparison in "updated:>soon"')
})

test("memo shares one resolve cache with no double resolves", () => {
  const snapshot = input()
  const memo = buildMemo(snapshot)
  expect(memo.whole.size).toBe(0)
  expect(memo.section.size).toBe(0)
  const tree = expandedTree(snapshot)
  // Defaults › Models rows carry no text records: they resolve through
  // modelDefaultView, never through resolve(), so the whole-memo invariant
  // counts the resolvable item rows only.
  const itemCount = new Set(
    tree.filter((node) => node.kind === "item" && node.address?.item.startsWith("modeldefault:") !== true && node.address?.item.startsWith("modelsetting:") !== true).map((node) => node.id),
  ).size
  const sectionCount = new Set(tree.filter((node) => node.kind === "section" && node.address?.section !== null).map((node) => node.id)).size
  query(snapshot, { where: "text:e tokens:>0 upstream:e" }, memo)
  expect(memo.whole.size).toBe(itemCount)
  expect(memo.section.size).toBe(sectionCount)
  query(snapshot, { where: "text:e tokens:>0 upstream:e" }, memo)
  expect(memo.whole.size).toBe(itemCount)
  expect(memo.section.size).toBe(sectionCount)
})

test("badge-backed queries resolve each address at most once through the shared memo", () => {
  const snapshot = input()
  const memo = buildMemo(snapshot)
  const tree = expandedTree(snapshot)
  const itemCount = new Set(
    tree.filter((node) => node.kind === "item" && node.address?.item.startsWith("modeldefault:") !== true && node.address?.item.startsWith("modelsetting:") !== true).map((node) => node.id),
  ).size
  const sectionCount = new Set(tree.filter((node) => node.kind === "section" && node.address?.section !== null).map((node) => node.id)).size
  const found = query(snapshot, { where: "review:true" }, memo)
  expect(found.total).toBeGreaterThan(0)
  expect(memo.whole.size).toBe(itemCount)
  expect(memo.section.size).toBe(sectionCount)
  query(snapshot, { where: "review:true" }, memo)
  expect(memo.whole.size).toBe(itemCount)
  expect(memo.section.size).toBe(sectionCount)
})

test("structural misses resolve nothing", () => {
  const noTeams = input({ teams: [] })
  const noTeamsMemo = buildMemo(noTeams)
  // Team presets are team rows too; this miss is about the levels' teams.
  const teamsMissed = query(noTeams, { where: "kind:team !level:preset" }, noTeamsMemo)
  expect(teamsMissed.rows).toHaveLength(0)
  expect(noTeamsMemo.whole.size).toBe(0)
  expect(noTeamsMemo.section.size).toBe(0)
  const snapshot = input()
  const agentMemo = buildMemo(snapshot)
  const agentMissed = query(snapshot, { where: "agent:nobody" }, agentMemo)
  expect(agentMissed.rows).toHaveLength(0)
  expect(agentMemo.whole.size).toBe(0)
  expect(agentMemo.section.size).toBe(0)
  const noAgents = input({ agents: [] })
  const noAgentsMemo = buildMemo(noAgents)
  const levelMissed = query(noAgents, { where: "level:global kind:item" }, noAgentsMemo)
  expect(levelMissed.rows).toHaveLength(0)
  expect(noAgentsMemo.whole.size).toBe(0)
  expect(noAgentsMemo.section.size).toBe(0)
})

function executeSectionsSnap() {
  return input({
    items: [
      makeItem({ id: "tool:execute", kind: "tool", group: "native", title: "execute", text: "host entry", codemode: false, execute: true }),
      makeItem({ id: "tool:bash", kind: "tool", group: "native", title: "bash", text: "run" }),
      makeItem({ id: "tool:coder", kind: "tool", group: "native", title: "coder", text: "# Alpha\n\na\n\n# Beta\n\nb\n", codemode: true }),
    ],
    records: [],
  })
}

test("execute rows expose no sections in query", () => {
  const snap = executeSectionsSnap()
  expect(query(snap, { where: "execute:true kind:section", fields: ["id"] }).rows).toHaveLength(0)
  const [row] = query(snap, { where: "id:item:project:Implementer:tool:execute", fields: ["id", "sections"] }).rows
  expect(row?.id).toBe("item:project:Implementer:tool:execute")
  expect(row?.sections).toEqual([])
})

test("ordinary tool sections still enumerate with real counts", () => {
  const snap = executeSectionsSnap()
  const bashSections = query(snap, { where: "kind:section id:item:project:Implementer:tool:bash:", fields: ["id"] }).rows.map((row) => row.id).sort()
  expect(bashSections).toEqual(["item:project:Implementer:tool:bash:description"])
  const coderSections = query(snap, { where: "id:section:project:Implementer:tool:coder:", fields: ["id"] }).rows.map((row) => row.id).sort()
  expect(coderSections).toEqual(["section:project:Implementer:tool:coder:alpha", "section:project:Implementer:tool:coder:beta"].sort())
  const editable = query(snap, { where: "can:edit", fields: ["id"] }).rows.map((row) => row.id)
  expect(editable).toContain("item:project:Implementer:tool:bash:description")
  expect(editable).toContain("section:project:Implementer:tool:coder:alpha")
  expect(editable).toContain("section:project:Implementer:tool:coder:beta")
  const [bashRow] = query(snap, { where: "id:item:project:Implementer:tool:bash", fields: ["id", "sections"] }).rows
  expect(bashRow?.sections).toEqual(["item:project:Implementer:tool:bash:description"])
  const [coderRow] = query(snap, { where: "id:item:project:Implementer:tool:coder", fields: ["id", "sections"] }).rows
  expect(coderRow?.sections?.slice().sort()).toEqual(["item:project:Implementer:tool:coder:description", "section:project:Implementer:tool:coder:alpha", "section:project:Implementer:tool:coder:beta"].sort())
})

test("Description is a text row, never a structural group", () => {
  const snap = executeSectionsSnap()
  const memo = buildMemo(snap)
  const groups = query(snap, { where: "kind:group", fields: ["id"], limit: 1000 }, memo).rows.map((row) => row.id)
  expect(memo.whole.size).toBe(0)
  expect(memo.section.size).toBe(0)
  expect(groups).not.toContain("group:project:Implementer:tool:coder:description")
  expect(groups).not.toContain("group:project:Implementer:tool:bash:description")
  const descriptions = query(snap, { where: "kind:section label:Description", fields: ["id"], limit: 1000 }).rows.map((row) => row.id)
  expect(descriptions).toContain("item:project:Implementer:tool:coder:description")
  expect(descriptions).toContain("item:project:Implementer:tool:bash:description")
})

function permSnap() {
  return input({
    items: [
      makeItem({ id: "tool:shell", kind: "tool", group: "native", title: "shell", text: "shell tool" }),
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
      }),
    ],
    records: [],
  })
}

test("zero-parameter permission rows list directly and item:perm and tool filters find them", () => {
  const snap = permSnap()
  const tree = expandedTree(snap)
  const toolRow = tree.find((node) => node.id === "item:project:Implementer:tool:shell")
  if (!toolRow) throw new Error("missing shell tool row")
  const index = tree.findIndex((node) => node.id === toolRow.id)
  const depth = toolRow.depth
  const below: { id: string; label: string; depth: number }[] = []
  for (const node of tree.slice(index + 1)) {
    if (node.depth <= depth) break
    below.push({ id: node.id, label: node.label, depth: node.depth - depth })
  }
  // No parameter schema in this fixture: the rule sits directly under the tool.
  expect(below).toEqual([
    { id: "item:project:Implementer:tool:shell:description", label: "Description", depth: 1 },
    { id: "item:project:Implementer:perm:shell:git-push", label: "Git push", depth: 1 },
  ])
  const groups = query(snap, { where: "id:group:project:Implementer:tool:shell:permissions", fields: ["id"] }).rows.map((row) => row.id)
  expect(groups).toEqual([])
  const byItem = query(snap, { where: "item:perm", fields: ["id"] }).rows.map((row) => row.id)
  expect(byItem).toContain("item:project:Implementer:perm:shell:git-push")
  const byTool = query(snap, { where: "item:perm tool:shell", fields: ["id"] }).rows.map((row) => row.id)
  expect(byTool).toContain("item:project:Implementer:perm:shell:git-push")
  const otherTool = query(snap, { where: "item:perm tool:edit", fields: ["id"] }).rows
  expect(otherTool).toHaveLength(0)
  const editable = query(snap, { where: "can:edit", fields: ["id"] }).rows.map((row) => row.id)
  expect(editable).toContain("item:project:Implementer:perm:shell:git-push")
})

test("perm structural misses still resolve nothing", () => {
  const snap = permSnap()
  const memo = buildMemo(snap)
  const missed = query(snap, { where: "item:perm tool:nope" }, memo)
  expect(missed.rows).toHaveLength(0)
  expect(memo.whole.size).toBe(0)
  expect(memo.section.size).toBe(0)
})

// The wire boundary every consumer outside the server reads through: the
// server encodes each Item as a SnapshotItem, it travels as JSON, and itemOf
// rebuilds it. A field missing from either side is silently dropped here.
function acrossSnapshotBoundary(source: readonly Item[]): Item[] {
  const wire = source.map((item) => Schema.encodeSync(Plus.SnapshotItem)(item))
  return Schema.decodeUnknownSync(Schema.Array(Plus.SnapshotItem))(JSON.parse(JSON.stringify(wire))).map(itemOf)
}

test("run matches a live run's edit scope row after the snapshot boundary", () => {
  const member = "gemini-implementer"
  const run = { id: "w-0000000000000001", role: member, paths: ["packages/plus/**"] }
  const scoped = {
    items: [...items(), ...acrossSnapshotBoundary(teamPolicyItems(policyMembersOf([member]), [run]))],
    records: [],
    agents: [...agents(), { id: member, scope: "project" as const, origin: "plus" as const }],
    teams: [{ level: "project" as const, team: "crew", enabled: true, agents: [member] }],
  }
  const found = query(scoped, { where: `run:${run.id}` }).rows.map((row) => row.id)
  expect(found).toContain(`item:project:crew/:${member}:perm:edit:run:${run.id}`)
  expect(found.every((id) => id.endsWith(`perm:edit:run:${run.id}`))).toBe(true)
  expect(query(scoped, { where: "run:w-0000000000000002" }).rows).toHaveLength(0)
})

// The TUI filter's row set must agree with the old full-materialise approach:
// match on a fully expanded tree, then add each match's ancestor chain from
// the pre-order list. matchedTree does the same from the candidate walk
// without materialising unrelated rows.
function oldFilterRows(
  snapshot: ReturnType<typeof input>,
  where: string,
): { matched: Set<string>; rows: Set<string>; ordered: string[] } {
  const full = expandedTree(snapshot)
  const visible = (node: TreeNode) => node.kind !== "section" || node.actions?.toggle === true
  let matched: TreeNode[]
  try {
    const ids = new Set(query(snapshot, { where, fields: ["id"] }).rows.map((row) => row.id))
    matched = full.filter((node) => ids.has(node.id) && visible(node))
  } catch {
    const needle = where.trim().toLowerCase()
    matched = full.filter(
      (node) => visible(node) && (node.label.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle)),
    )
  }
  const parents = parentsOf(full)
  const rows = new Set<string>()
  for (const node of matched) {
    rows.add(node.id)
    let ancestor = parents.get(node.id)
    while (ancestor !== undefined) {
      rows.add(ancestor.id)
      ancestor = parents.get(ancestor.id)
    }
  }
  return { matched: new Set(matched.map((node) => node.id)), rows, ordered: full.filter((node) => rows.has(node.id)).map((node) => node.id) }
}

test("matchedTree matches, chains and pre-order steps agree with the full-materialise filter", () => {
  const snapshot = input()
  for (const where of [
    "level:project bash",
    "level:project Implementer",
    "level:global kind:item",
    "Implementer",
    "kind:section level:project",
    "has:sections level:project",
    "text:e tokens:>0 upstream:e",
  ]) {
    const expected = oldFilterRows(snapshot, where)
    const actual = matchedTree(snapshot, where)
    expect([...actual.matched].sort()).toEqual([...expected.matched].sort())
    expect([...actual.rows.map((node) => node.id)].sort()).toEqual([...expected.rows].sort())
    // The list renders in tree order, so the sequence is part of the contract.
    expect(actual.rows.map((node) => node.id)).toEqual(expected.ordered)
  }
})

test("matchedTree keeps the label/id fallback when the grammar rejects the filter", () => {
  const snapshot = input({
    items: [...items(), makeItem({ id: "tool:odd:name", kind: "tool", group: "native", title: "odd:name" })],
  })
  const where = "odd:name"
  expect(() => query(snapshot, { where })).toThrow()
  const expected = oldFilterRows(snapshot, where)
  const actual = matchedTree(snapshot, where)
  expect([...actual.matched].sort()).toEqual([...expected.matched].sort())
  expect([...actual.rows.map((node) => node.id)].sort()).toEqual([...expected.rows].sort())
  expect(actual.rows.map((node) => node.id)).toEqual(expected.ordered)
  expect(actual.matched.has("item:project:Implementer:tool:odd:name")).toBe(true)
})

test("matchedTree scopes a level: filter to its root and keeps the root as an ancestor", () => {
  const snapshot = input()
  const result = matchedTree(snapshot, "level:project bash")
  expect(result.rows.length).toBeGreaterThan(0)
  expect(result.rows.every((node) => node.id.includes(":project:") || node.id === "root:project")).toBe(true)
  const match = result.rows.find((node) => result.matched.has(node.id))
  expect(match).toBeDefined()
  expect(result.rows.some((node) => node.id === "root:project")).toBe(true)
})

// c-14: after an agent's own edit, a plain find folded that copy into the
// shared Defaults row, so the only line read "off by default" and the edit
// looked lost. A row holding its own edit keeps its own line.
test("an agent's own edit never folds into the shared Defaults row", () => {
  const updated = "2026-01-01T00:00:00.000Z"
  const shell = makeItem({ id: "tool:shell", kind: "tool", group: "native", title: "shell", text: "run commands" })
  const rule = makeItem({ id: "perm:shell:git-push", kind: "perm", group: "none", title: "Git push", permTool: "shell", text: "Git push\ngit push *" })
  const fixture = {
    items: [shell, rule],
    agents: [
      // alpha follows the native build preset, so it inherits this rule on;
      // beta inherits nothing and reads the shared row's off.
      { id: "alpha", scope: "project" as const, origin: "user" as const },
      { id: "beta", scope: "project" as const, origin: "user" as const },
    ],
    links: [{ type: "link" as const, level: "project" as const, agent: "alpha", preset: { kind: "agent" as const, id: "build" }, updated }],
    teams: [],
  }
  const shared: CustomizationRecord = { type: "customization", level: "defaults", agent: null, item: rule.id, section: null, state: "off", basedOn: "", updated }
  const where = 'name:"git-push"'
  const rows = (records: CustomizationRecord[]) =>
    query({ ...fixture, records }, { where, fields: ["id", "from"], collapse: findCollapse(where) }).rows
  // alpha's own off is an edit (it inherits on): its line stays and says
  // where the value came from. beta still folds into the shared Defaults row.
  const edited = rows([shared, { ...shared, level: "project", agent: "alpha" }])
  expect(edited).toContainEqual({ id: "item:project:alpha:perm:shell:git-push", from: "set here" })
  // The Agents catalogue's shared row no longer counts alpha among its copies.
  expect(edited.some((row) => row.id === "item:defaults::perm:shell:git-push")).toBe(true)
  // Without the edit the two agents' copies are the shared row's, folded.
  expect(rows([shared])).not.toContainEqual({ id: "item:project:alpha:perm:shell:git-push", from: "set here" })
})
