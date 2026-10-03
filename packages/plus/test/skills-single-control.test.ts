import { expect, test } from "bun:test"
import { apply, type ApplyInput } from "../src/instructions/apply.js"
import { discover } from "../src/instructions/discover.js"
import type { CustomizationRecord, Level, RuleRecord } from "../src/instructions/model.js"
import { setEnabled } from "../src/instructions/ops.js"
import { chainContext } from "../src/instructions/presets.js"
import { migrateSkillPermissions, type StoredRecord } from "../src/instructions/store.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"
import { agentHarness, agentInfo, context, skillHarness, skillInfo, toolHarness } from "./harness.js"
import { presetInput, resolvedStates } from "./teams/preset-table.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

// Skills have one switch per agent: the skill row itself, listed under the
// skill tool's Permissions › Skills category. There is no Skills category
// beside Tools and no per-skill "skill" permission row any more.

async function fixture() {
  const skills = skillHarness([skillInfo("notes", "Take notes."), skillInfo("lint", "Lint the code.")])
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const tools = toolHarness([{ id: "skill", description: "Load a skill", options: { codemode: false } }])
  const ctx = context({ agent: agents.domain, skill: skills.domain, tool: tools.domain })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  return { ctx, agents, discovered }
}

function memoInput(items: MemoInput["items"], records: readonly CustomizationRecord[]): MemoInput {
  return {
    items,
    records,
    agents: [
      { id: "alpha", scope: "project" },
      { id: "beta", scope: "project" },
    ],
    links: ["alpha", "beta"].map((agent) => ({ type: "link" as const, level: "project" as Level, agent, preset: { kind: "agent" as const, id: "build" }, updated: UPDATED })),
    teams: [],
  }
}

function applyInput(items: ApplyInput["items"], records: readonly CustomizationRecord[], agents: readonly string[]): ApplyInput {
  const sources = agents.map((id) => ({ id, scope: "project" as const, origin: "user" as const }))
  return {
    items,
    records,
    splits: [],
    agents: agents.map((id) => ({ id, level: "project" as Level })),
    scopes: chainContext({
      agents: sources,
      items,
      links: agents.map((agent) => ({ type: "link", level: "project", agent, preset: { kind: "agent", id: "build" }, updated: UPDATED })),
    }),
  }
}

test("the skill tool's Skills category is the only place skills are listed and switched", async () => {
  const { discovered } = await fixture()
  // No per-skill permission rows: the skill itself is the switch.
  expect(discovered.items.filter((item) => item.id.startsWith("perm:skill:") && !item.id.startsWith("perm:skill:approval")).map((item) => item.id)).toEqual([])
  const nodes = expandedTree(memoInput(discovered.items, []))
  expect(nodes.some((node) => /^group:project:alpha:skills/.test(node.id))).toBe(false)
  const category = "group:project:alpha:tool:skill:permissions:skills"
  const listed = nodes.filter((node) => node.kind === "item" && node.address?.item.startsWith("skill:") && node.id.startsWith("item:project:alpha:"))
  expect(listed.map((node) => node.address?.item).toSorted()).toEqual(["skill:lint", "skill:notes"])
  // Every listed skill hangs under that category (through its origin group).
  const parentOf = new Map<string, string>()
  const stack: { id: string; depth: number }[] = []
  for (const node of nodes) {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= node.depth) stack.pop()
    if (stack.length > 0) parentOf.set(node.id, stack[stack.length - 1]!.id)
    stack.push({ id: node.id, depth: node.depth })
  }
  const ancestors = (id: string): string[] => {
    const out: string[] = []
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) out.push(at)
    return out
  }
  for (const node of listed) expect(ancestors(node.id)).toContain(category)
  expect(nodes.find((node) => node.id === category)?.add).toBe("skill")
})

test("switching a skill off there denies it for exactly that agent; on again lifts the deny", async () => {
  const { ctx, agents, discovered } = await fixture()
  const off = setEnabled(memoInput(discovered.items, []), "item:project:alpha:skill:notes", false)
  if ("refusal" in off) throw new Error(`refused: ${off.refusal}`)
  expect(off.records).toMatchObject([{ item: "skill:notes", agent: "alpha", state: "off" }])
  await apply(ctx, applyInput(discovered.items, off.records, ["alpha", "beta"]))
  expect(agents.state.get("alpha")?.permissions).toContainEqual({ action: "skill", resource: "notes", effect: "deny" })
  expect(agents.state.get("beta")?.permissions ?? []).not.toContainEqual({ action: "skill", resource: "notes", effect: "deny" })
  expect(agents.state.get("alpha")?.permissions ?? []).not.toContainEqual({ action: "skill", resource: "lint", effect: "deny" })

  const fresh = await fixture()
  const on = setEnabled(memoInput(fresh.discovered.items, off.records), "item:project:alpha:skill:notes", true)
  if ("refusal" in on) throw new Error(`refused: ${on.refusal}`)
  await apply(fresh.ctx, applyInput(fresh.discovered.items, on.records, ["alpha", "beta"]))
  expect(fresh.agents.state.get("alpha")?.permissions ?? []).not.toContainEqual({ action: "skill", resource: "notes", effect: "deny" })
})

test("a Basic member preset ships its skill switches on the skills themselves", () => {
  const input = presetInput()
  // The planner and the read-only workers do not get pilotty.
  expect(resolvedStates(input, "planner")["skill:pilotty"]).toBe("off")
  expect(resolvedStates(input, "build-seat")["skill:pilotty"]).toBe("on")
  expect(Object.keys(resolvedStates(input, "planner")).filter((id) => /^perm:skill:(?!approval)/.test(id))).toEqual([])
})

// ── migration ────────────────────────────────────────────────────────────

function record(item: string, overrides: Partial<CustomizationRecord> = {}): CustomizationRecord {
  return { type: "customization", level: "project", agent: "alpha", item, section: null, basedOn: "", updated: UPDATED, ...overrides }
}

test("a stored per-skill permission state moves onto the skill at the same address", () => {
  const records: StoredRecord[] = [
    record("perm:skill:notes", { state: "off" }),
    record("perm:skill:lint", { level: "global", agent: null, catalogue: "teams", state: "on" }),
    record("tool:shell", { state: "off" }),
  ]
  const migrated = migrateSkillPermissions(records)
  expect(migrated.migrated).toBe(true)
  expect(migrated.records).toEqual([
    record("tool:shell", { state: "off" }),
    record("skill:notes", { state: "off" }),
    record("skill:lint", { level: "global", agent: null, catalogue: "teams", state: "on" }),
  ])
  // Idempotent: nothing left to move.
  expect(migrateSkillPermissions(migrated.records)).toEqual({ records: migrated.records, migrated: false })
})

test("when the skill and its permission row disagree at one address, off wins; text on the skill is kept", () => {
  const migrated = migrateSkillPermissions([
    record("skill:notes", { state: "on", text: "my notes skill" }),
    record("perm:skill:notes", { state: "off" }),
    record("skill:lint", { state: "off" }),
    record("perm:skill:lint", { state: "on" }),
  ])
  expect(migrated.records).toEqual([record("skill:notes", { state: "off", text: "my notes skill" }), record("skill:lint", { state: "off" })])
})

test("the skill tool's own Approval row and user-created skill rules are real permissions and stay", () => {
  const rule: RuleRecord = { type: "rule", level: "project", agent: "alpha", tool: "skill", id: "no-deploy", label: "No deploy", patterns: ["deploy*"], keywords: [], updated: UPDATED }
  const records: StoredRecord[] = [rule, record("perm:skill:approval.every", { state: "on" }), record("perm:skill:no-deploy", { state: "off" })]
  expect(migrateSkillPermissions(records)).toEqual({ records, migrated: false })
})
