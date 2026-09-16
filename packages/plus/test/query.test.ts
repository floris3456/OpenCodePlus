import { expect, test } from "bun:test"
import {
  fingerprint,
  type AgentSource,
  type CustomizationRecord,
  type Item,
  type SplitRecord,
} from "../src/instructions/model.js"
import { buildMemo, type TeamInput } from "../src/instructions/resolve-memo.js"
import { query } from "../src/instructions/query.js"
import { expandedTree } from "../src/instructions/tree.js"
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
    { id: "Implementer", scope: "project", base: "gpt", path: "/agents/Implementer.md" },
    { id: "CrewMate", scope: "project", base: "gpt" },
    { id: "Helper", scope: "global", base: "claude" },
    { id: "Template", scope: "defaults", base: "gpt" },
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
    text("run commands", { id: "tool:bash", kind: "tool", group: "native", title: "bash", order: 1 }),
    text("v2 upstream", { id: "tool:plus-one", kind: "tool", group: "plus", title: "plus-one" }),
    text("odd-name", { id: "tool:odd-name", kind: "tool", group: "mcp", server: "sample", title: "odd-name" }),
    text("# Alpha\n\na\n\n# Beta\n\nb\n", { id: "tool:coder", kind: "tool", group: "native", title: "coder", codemode: true }),
    text("", { id: "tool:empty", kind: "tool", group: "native", title: "empty" }),
    text("gpt base", { id: "base:gpt", kind: "base", group: "none", title: "gpt.txt" }),
    text("claude base", { id: "base:claude", kind: "base", group: "none", title: "claude.txt" }),
    text("custom base", { id: "base:custom", kind: "base", group: "none", title: "Custom.txt", userBase: true }),
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

function input(overrides?: { items?: Item[]; records?: (CustomizationRecord | SplitRecord)[]; agents?: AgentSource[]; teams?: TeamInput[] }) {
  return {
    items: overrides?.items ?? items(),
    records: overrides?.records ?? records(),
    agents: overrides?.agents ?? agents(),
    teams: overrides?.teams ?? teams(),
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
  expect(ids("kind:root")).toHaveLength(3)
  expect(ids("kind:team", { teams: [] })).toHaveLength(0)
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
  expect(ids("server:sample")).not.toContain(bash)
  expect(ids("server:nope")).toHaveLength(0)
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

test("agent is a case-insensitive substring match with exact _ sentinel", () => {
  expect(ids("agent:impl")).toContain(bash)
  expect(ids("agent:IMPL")).toContain(bash)
  expect(ids("agent:IMPLEMENTER")).toContain(bash)
  expect(ids("agent:impl")).not.toContain("item:global:Helper:tool:bash")
  expect(ids("agent:_")).toContain(sharedPlus)
  expect(ids("agent:_")).not.toContain(bash)
  const withUnderscore = input({ agents: [...agents(), { id: "my_agent", scope: "project", base: "gpt" }] })
  const underscoreItem = "item:project:my_agent:tool:bash"
  const underscoreAgent = "agent:project:my_agent"
  const sharedIds = query(withUnderscore, { where: "agent:_" }).rows.map((row) => row.id)
  expect(sharedIds).toContain(sharedPlus)
  expect(sharedIds).not.toContain(underscoreItem)
  expect(sharedIds).not.toContain(underscoreAgent)
  const subIds = query(withUnderscore, { where: "agent:my_" }).rows.map((row) => row.id)
  expect(subIds).toContain(underscoreItem)
  expect(subIds).toContain(underscoreAgent)
  expect(subIds).not.toContain(sharedPlus)
})

test("sections projection survives structural filtering", () => {
  const whole = ["section:project:Implementer:tool:bash:whole"]
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
  expect(ids("source:upstream")).toContain("item:project:Implementer:tool:odd-name")
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
  expect(query(input(), { where: `id:${bash}` }).rows.map((row) => row.id)).toEqual([bash])
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
  expect(found).toContain("agent:project:CrewMate")
  expect(found).not.toContain("team:global:ops")
  expect(ids("team:ops")).toContain("team:global:ops")
  expect(ids("team:nope")).toHaveLength(0)
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
  expect(ids("identical:true")).toContain("item:project:Implementer:base:custom")
  expect(ids("identical:true")).not.toContain(bash)
  expect(ids("identical:false")).toContain(bash)
})

test("dead pins records that can never apply, never Code Mode text", () => {
  expect(ids("dead:true")).not.toContain("item:project:Implementer:tool:coder")
  expect(ids("dead:false")).toContain("item:project:Implementer:tool:coder")
  expect(ids("dead:true")).toContain("item:defaults::mcp:sample")
  expect(ids("dead:true")).toContain("item:project:Implementer:system:role")
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
    const expected = tree
      .filter((node) => node.label.toLowerCase().includes(lowered) || node.id.toLowerCase().includes(lowered))
      .map((node) => node.id)
      .sort()
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
  expect(ids("kind:item label:bash").sort()).toEqual(
    [
      "item:project:Implementer:tool:bash",
      "item:project:CrewMate:tool:bash",
      "item:global:Helper:tool:bash",
      "item:defaults:Template:tool:bash",
      "item:defaults::tool:bash",
    ].sort(),
  )
})

test("sort directive, explicit sort, and ordering", () => {
  expect(query(input(), { where: "kind:root sort:label" }).rows.map((row) => row.id)).toEqual([
    "root:defaults",
    "root:global",
    "root:project",
  ])
  expect(query(input(), { where: "kind:root sort:label", sort: "-label" }).rows.map((row) => row.id)).toEqual([
    "root:project",
    "root:global",
    "root:defaults",
  ])
  const byTokens = query(input(), { where: "kind:item level:project agent:Implementer", sort: "tokens" }).rows
  const counts = byTokens.map((row) => row.tokens ?? 0)
  expect([...counts].sort((a, b) => a - b)).toEqual(counts)
  const byUpdated = query(input(), { where: "has:record sort:updated" }).rows
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
  expect(reviewed?.badges).toBe("on modified review")
  const full = query(input(), {
    where: `id:${bash}`,
    fields: ["id", "label", "text", "upstream", "record", "path", "updated", "sections"],
  }).rows[0]
  expect(full).toMatchObject({ id: bash, label: "bash", text: "custom bash", upstream: "run commands", updated: OLD })
  expect(full?.record).toMatchObject({ text: "custom bash" })
  expect(full?.sections).toEqual(["section:project:Implementer:tool:bash:whole"])
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
  for (const node of tree) {
    const rows = query(input(), { where: `id:${node.id}`, fields: ["id", "badges", "source"] }).rows
    const found = rows.find((row) => row.id === node.id)
    expect(found).toBeDefined()
    expect(found?.badges).toBe(badgeLabels(node).join(" "))
    expect(found?.source).toBe(node.badges.source)
  }
})

test("unknown keys and malformed comparisons throw naming the term", () => {
  expect(() => query(input(), { where: "foo:bar" })).toThrow('unknown filter key in "foo:bar"')
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
  const itemCount = tree.filter((node) => node.kind === "item").length
  const sectionCount = tree.filter((node) => node.kind === "section").length
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
  const itemCount = tree.filter((node) => node.kind === "item").length
  const sectionCount = tree.filter((node) => node.kind === "section").length
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
  const teamsMissed = query(noTeams, { where: "kind:team" }, noTeamsMemo)
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
  const bashSections = query(snap, { where: "id:section:project:Implementer:tool:bash:", fields: ["id"] }).rows.map((row) => row.id).sort()
  expect(bashSections).toEqual(["section:project:Implementer:tool:bash:whole"])
  const coderSections = query(snap, { where: "id:section:project:Implementer:tool:coder:", fields: ["id"] }).rows.map((row) => row.id).sort()
  expect(coderSections).toEqual(["section:project:Implementer:tool:coder:alpha", "section:project:Implementer:tool:coder:beta"].sort())
  const editable = query(snap, { where: "can:edit", fields: ["id"] }).rows.map((row) => row.id)
  expect(editable).toContain("section:project:Implementer:tool:bash:whole")
  expect(editable).toContain("section:project:Implementer:tool:coder:alpha")
  expect(editable).toContain("section:project:Implementer:tool:coder:beta")
  const [bashRow] = query(snap, { where: "id:item:project:Implementer:tool:bash", fields: ["id", "sections"] }).rows
  expect(bashRow?.sections).toEqual(["section:project:Implementer:tool:bash:whole"])
  const [coderRow] = query(snap, { where: "id:item:project:Implementer:tool:coder", fields: ["id", "sections"] }).rows
  expect(coderRow?.sections?.slice().sort()).toEqual(["section:project:Implementer:tool:coder:alpha", "section:project:Implementer:tool:coder:beta"].sort())
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
        provenance: [],
      }),
    ],
    records: [],
  })
}

test("perm rows hang directly off the tool with item:perm and tool filters and no group", () => {
  const snap = permSnap()
  const tree = expandedTree(snap)
  expect(tree.some((node) => node.label === "Permissions")).toBe(false)
  expect(tree.some((node) => node.id.includes(":perms"))).toBe(false)
  const toolRow = tree.find((node) => node.id === "item:project:Implementer:tool:shell")
  if (!toolRow) throw new Error("missing shell tool row")
  const index = tree.findIndex((node) => node.id === toolRow.id)
  const depth = tree[index]?.depth ?? 0
  const direct: string[] = []
  for (const node of tree.slice(index + 1)) {
    if (node.depth <= depth) break
    if (node.depth === depth + 1) direct.push(node.id)
  }
  expect(direct).toContain("item:project:Implementer:perm:shell:git-push")
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
