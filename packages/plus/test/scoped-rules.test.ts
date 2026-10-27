import { expect, test } from "bun:test"
import { permissionTableOf, sessionPlans } from "../src/instructions/apply.js"
import { fingerprint, type Item, type RuleRecord } from "../src/instructions/model.js"
import { buildTreeMemo, findLazy } from "../src/instructions/tree.js"
import { captureRows, pasteRows } from "../src/instructions/clipboard.js"
import { ownRule, ruleAt } from "../src/instructions/rules.js"

const tool: Item = { id: "tool:read", kind: "tool", title: "read", group: "native", text: "Read", enabled: true, fingerprint: fingerprint("Read") }
const item: Item = { id: "perm:read:private", kind: "perm", title: "private", group: "native", text: "", enabled: true, fingerprint: fingerprint(""), custom: true, permTool: "read", ruleId: "private", patterns: [], keywords: [] }
const shared: RuleRecord = { type: "rule", level: "defaults", agent: null, tool: "read", id: "private", label: "Shared files", patterns: ["shared/*"], keywords: ["shared"], message: "Shared refusal", updated: "2026-10-11" }

test("shared project definitions retain their Defaults inventory address and catalogue isolation", () => {
  const rules: RuleRecord[] = [shared, { ...shared, level: "global", label: "Global" }, { ...shared, level: "project", label: "Project" }, { ...shared, catalogue: "teams", label: "Teams" }]
  const scopes = { global: new Set<string>(), defaults: new Set<string>() }
  const address = { level: "defaults" as const, agent: null, item: item.id, section: null }
  expect(ownRule(rules, address)?.label).toBe("Project")
  expect(ruleAt(rules, scopes, { ...address, level: "project", agent: "alpha" })?.label).toBe("Project")
  expect(ruleAt(rules, scopes, { ...address, catalogue: "teams" })?.label).toBe("Teams")
})

test("team definitions resolve independently from agent and other team definitions", () => {
  const rules: RuleRecord[] = [shared, { ...shared, level: "project", agent: "alpha", label: "Agent" }, { ...shared, level: "project", agent: "alpha", team: { level: "project", team: "crew" }, label: "Crew" }]
  const scopes = { global: new Set<string>(), defaults: new Set<string>() }
  const address = { level: "project" as const, agent: "alpha", item: item.id, section: null }
  expect(ruleAt(rules, scopes, address)?.label).toBe("Agent")
  expect(ruleAt(rules, scopes, { ...address, team: { level: "project", team: "crew" } })?.label).toBe("Crew")
  expect(ruleAt(rules, scopes, { ...address, team: { level: "project", team: "other" } })?.label).toBe("Agent")
})

test("owner definitions govern tree labels, enforcement, refusal text and scrub independently", () => {
  const rules = [shared, { ...shared, level: "project" as const, agent: "alpha", label: "Alpha files", patterns: ["alpha/*"], keywords: ["alpha"], message: "Alpha refusal" }]
  const records = ["alpha", "beta"].map((agent) => ({ type: "customization" as const, level: "project" as const, agent, item: item.id, section: null, state: "off" as const, basedOn: item.fingerprint, updated: "2026-10-11" }))
  const input = { items: [tool, item], rules, records, splits: [], agents: [{ id: "alpha", level: "project" as const }, { id: "beta", level: "project" as const }], scopes: { global: new Set<string>(), defaults: new Set<string>() } }
  const table = permissionTableOf(input)
  expect(table.ruleRows("alpha", "read")[0]?.item.patterns).toEqual(["alpha/*"])
  expect(table.ruleRows("beta", "read")[0]?.item.patterns).toEqual(["shared/*"])
  const plans = sessionPlans(input, table)
  // Each refusal names the owner's own row and where its state came from.
  expect(plans.permDenies).toEqual(expect.arrayContaining([
    expect.objectContaining({
      agent: "alpha",
      resource: "alpha/*",
      message: 'Alpha refusal (denied by item:project:alpha:perm:read:private "Alpha files": off, set at project level)',
    }),
    expect.objectContaining({
      agent: "beta",
      resource: "shared/*",
      message: 'Shared refusal (denied by item:project:beta:perm:read:private "Shared files": off, set at project level)',
    }),
  ]))
  expect(plans.permDenies.some((rule) => rule.agent === "beta" && rule.resource === "alpha/*")).toBe(false)
  expect(plans.scrubByAgent).toEqual([["alpha", ["alpha"]], ["beta", ["shared"]]])
  const memo = buildTreeMemo({ items: input.items, records: [...records, ...rules], agents: input.agents.map((agent) => ({ id: agent.id, scope: agent.level, origin: "user" as const })) })
  expect(findLazy(memo, "item:project:alpha:perm:read:private")?.label).toBe("Alpha files")
  expect(findLazy(memo, "item:project:beta:perm:read:private")?.label).toBe("Shared files")
})

test("an owner-only rule is absent for other owners", () => {
  const memo = buildTreeMemo({ items: [tool, item], records: [{ ...shared, level: "project", agent: "alpha" }], agents: ["alpha", "beta"].map((id) => ({ id, scope: "project" as const, origin: "user" as const })) })
  expect(findLazy(memo, "item:project:alpha:perm:read:private")).toBeDefined()
  expect(findLazy(memo, "item:project:beta:perm:read:private")).toBeUndefined()
})

test("copying a tool carries an independent owner rule definition", () => {
  const input = { items: [tool, item], records: [{ ...shared, level: "project" as const, agent: "alpha" }], agents: ["alpha", "beta"].map((id) => ({ id, scope: "project" as const, origin: "user" as const })) }
  const copy = captureRows(input, ["item:project:alpha:tool:read"], "copy")
  if ("refusal" in copy) throw new Error(copy.refusal)
  const pasted = pasteRows(input, copy, "group:project:beta:tools")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  expect(pasted.memo.records.filter((record) => record.type === "rule")).toHaveLength(2)
  const changed = { ...pasted.memo, records: pasted.memo.records.map((record) => record.type === "rule" && record.agent === "alpha" ? { ...record, label: "Changed source", patterns: ["different/*"] } : record) }
  const memo = buildTreeMemo(changed)
  expect(findLazy(memo, "item:project:alpha:perm:read:private")?.label).toBe("Changed source")
  expect(findLazy(memo, "item:project:beta:perm:read:private")?.label).toBe("Shared files")
})
