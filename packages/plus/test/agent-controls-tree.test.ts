import { expect, test } from "bun:test"
import { reset, saveText, toggle } from "../src/instructions/ops.js"
import { query } from "../src/instructions/query.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { buildMemo, expandedTree, type TreeNode } from "../src/instructions/tree.js"
import { controlDetail, provenanceLine, resolvedText, sectionRows } from "../src/tui/instructions/detail-pane.js"
import { isExpandableRow } from "../src/tui/instructions/tree-pane.js"
import { controlItems, controlRecord, controlSnapshot } from "./agent-controls-fixture.js"

function row(nodes: readonly TreeNode[], id: string): TreeNode {
  const node = nodes.find((node) => node.id === id)
  if (node === undefined) throw new Error(`Missing row ${id}`)
  return node
}

test("all agent, member, preset and Defaults owners expose discovered Settings and Compaction with stable ids", () => {
  const snapshot = controlSnapshot([], {
    teams: [{ level: "project", team: "crew", enabled: true, agents: ["build"] }],
    entries: [
      { type: "entry", level: "defaults", catalogue: "agents", name: "*worker*", updated: "2026-09-26" },
      { type: "entry", level: "defaults", catalogue: "teams", team: "crew*", name: "*member*", updated: "2026-09-26" },
    ],
  })
  const nodes = expandedTree(memoInputOf(snapshot))
  for (const owner of [
    "project:build", "global:build", "defaults:build",
    "project:crew/:build", "defaults:*worker*", "defaults:crew*/:*member*",
    "preset:build", "preset:orchestrator", "preset:starter/:planner",
    "defaults:", "defaults:/teams",
  ]) {
    expect(row(nodes, `group:${owner}:settings`).label).toBe("Settings")
    expect(row(nodes, `group:${owner}:compaction`).label).toBe("Compaction")
    for (const item of controlItems()) {
      const control = row(nodes, `item:${owner}:${item.id}`)
      expect(control.label).toBe(item.title[0].toUpperCase() + item.title.slice(1))
      expect(control.address?.item).toBe(item.id)
      expect(isExpandableRow(control, false, new Set())).toBe(false)
      expect(nodes.some((node) => node.id.startsWith(`section:${owner}:${item.id}:`))).toBe(false)
    }
  }
  expect(row(nodes, "agent:project:build").enabledRow).toBe("item:project:build:setting:enabled")
  expect(row(nodes, "team:project:crew:build").enabledRow).toBe("item:project:crew/:build:setting:enabled")
  expect(row(nodes, "item:project:crew/:build:setting:mode").address).toEqual({
    level: "project", agent: "build", item: "setting:mode", section: null,
    memberOf: { level: "project", team: "crew" }, catalogue: "teams",
  })
  expect(row(nodes, "item:defaults:crew*/:*member*:compaction:model").address?.team).toEqual({ level: "defaults", team: "crew*" })
})

test("controls come from Items; missing shared defaults use the backend helper instead of an agent baseline", () => {
  const snapshot = controlSnapshot([], {
    agents: [{ id: "worker", scope: "project", base: "gpt", origin: "user", fileBacked: true }],
    items: controlItems().filter((item) => item.id !== "setting:color"),
  })
  const nodes = expandedTree(memoInputOf(snapshot))
  expect(nodes.some((node) => node.id === "item:project:worker:setting:color")).toBe(false)
  const scoped = expandedTree(memoInputOf(controlSnapshot([], { items: snapshot.items.map((item) => ({ ...item, agents: ["build"], text: item.id === "setting:description" ? "Private build description" : item.text })) })))
  expect(row(scoped, "item:defaults::setting:description").badges.value).toBe("Not set")
  expect(row(scoped, "item:project:build:setting:description").badges.value).toBe("Private build description")
  expect(row(scoped, "item:project:build:setting:description").label).toBe("Description")
})

test("control availability does not resolve hidden subtrees for structural query misses", () => {
  const input = memoInputOf(controlSnapshot([controlRecord("compaction:strategy", { text: "remote" })]))
  const memo = buildMemo(input)
  expect(query(input, { where: "agent:nobody" }, memo).rows).toEqual([])
  expect(memo.whole.size).toBe(0)
  expect(memo.section.size).toBe(0)
})

test("team control baselines resolve by controlTeam in tree and details instead of borrowing another team's values", () => {
  const snapshot = controlSnapshot([], {
    agents: [{ id: "worker", scope: "project", origin: "user", fileBacked: true }],
    teams: [
      { level: "project", team: "crew", enabled: true, agents: ["worker"] },
      { level: "project", team: "other", enabled: true, agents: ["worker"] },
    ],
    items: [
      ...controlItems("worker", { description: "Other team", compaction: { strategy: "remote" } }).map((item) => ({ ...item, controlTeam: { level: "project" as const, team: "other" } })),
      ...controlItems("worker", { description: "Crew member", mode: "subagent", hidden: true }).map((item) => ({ ...item, controlTeam: { level: "project" as const, team: "crew" } })),
      ...controlItems("worker", { description: "Standalone" }),
      ...controlItems(),
    ],
  })
  const nodes = expandedTree(memoInputOf(snapshot))
  for (const [owner, text] of [["worker", "Standalone"], ["crew/:worker", "Crew member"], ["other/:worker", "Other team"]]) {
    const node = row(nodes, `item:project:${owner}:setting:description`)
    expect(node.badges.value).toBe(text)
    expect(resolvedText(node, snapshot)).toBe(text)
  }
  expect(row(nodes, "team:project:crew:worker").badges).toMatchObject({ state: "on", hidden: true, mode: "subagent" })
  expect(row(nodes, "item:project:crew/:worker:compaction:model").badges.disabled).toBeUndefined()
  expect(row(nodes, "item:project:other/:worker:compaction:model").badges.disabled).toContain("Remote")
})

test("tree and detail show actual text provenance; reset reveals inherited mode without crossing catalogue defaults", () => {
  const snapshot = controlSnapshot([
    controlRecord("setting:mode", { level: "global", text: "subagent" }),
    controlRecord("setting:mode", { text: "all", basedOnText: "subagent", basedOn: controlItems()[1].fingerprint }),
    controlRecord("compaction:model", { level: "defaults", agent: null, text: "acme/agent" }),
    controlRecord("compaction:model", { level: "defaults", agent: null, catalogue: "teams", text: "acme/team" }),
  ], { teams: [{ level: "project", team: "crew", enabled: true, agents: ["build"] }] })
  const input = memoInputOf(snapshot)
  const nodes = expandedTree(input)
  const mode = row(nodes, "item:project:build:setting:mode")
  expect(mode.badges.value).toBe("All")
  expect(provenanceLine(mode, snapshot)).toBe("value: set here (Project)")
  const dropped = reset(input, mode.id)
  if ("refusal" in dropped) throw new Error(dropped.refusal)
  const inherited = row(expandedTree({ ...input, records: dropped.records }), mode.id)
  expect(inherited.badges.value).toBe("Subagent")
  expect(inherited.badges.fromLabel).toBe("from global")
  expect(row(nodes, "item:project:build:compaction:model").badges.value).toBe("acme/agent")
  expect(row(nodes, "item:project:crew/:build:compaction:model").badges.value).toBe("acme/team")
})

test("agent enabled and hidden resolve separately and off agents keep their editable controls", () => {
  const snapshot = controlSnapshot([
    controlRecord("setting:enabled", { state: "off" }),
    controlRecord("setting:hidden", { state: "on" }),
  ])
  const nodes = expandedTree(memoInputOf(snapshot))
  const agent = row(nodes, "agent:project:build")
  expect(agent.address).toBeUndefined()
  expect(agent.badges).toMatchObject({ state: "off", hidden: true, mode: "primary" })
  expect(agent.actions?.toggle).toBe(true)
  expect(controlDetail(agent, snapshot).join(" ")).toContain("Hidden: omitted from the picker")
  expect(row(nodes, "item:project:build:setting:description").actions?.edit).toBe(true)
  const enabled = toggle(memoInputOf(snapshot), agent.enabledRow!)
  if ("refusal" in enabled) throw new Error(enabled.refusal)
  expect(enabled.records.find((record) => record.item === "setting:enabled")?.state).toBe("on")
  expect(enabled.records.find((record) => record.item === "setting:hidden")?.state).toBe("on")
})

test("linked preset values and inherited Remote strategy resolve through the existing chain", () => {
  const snapshot = controlSnapshot([
    controlRecord("setting:mode", { level: "preset", agent: "mine", text: "all" }),
    controlRecord("compaction:strategy", { level: "preset", agent: "mine", text: "remote" }),
    controlRecord("compaction:model", { level: "preset", agent: "mine", text: "acme/preset" }),
  ], {
    presets: [{ type: "preset", level: "preset", kind: "agent", id: "mine", updated: "2026-09-26" }],
    links: [{ type: "link", level: "project", agent: "build", preset: { kind: "agent", id: "mine" }, updated: "2026-09-26" }],
  })
  const nodes = expandedTree(memoInputOf(snapshot))
  expect(row(nodes, "item:project:build:setting:mode").badges).toMatchObject({ value: "All", fromLabel: "from preset mine" })
  const model = row(nodes, "item:project:build:compaction:model")
  expect(model.badges.value).toBe("acme/preset")
  expect(model.badges.disabled).toContain("Remote")
  expect(provenanceLine(model, snapshot)).toBe("value: from preset mine")
  expect(row(nodes, "item:global:build:compaction:model").badges.disabled).toBeUndefined()
})

test("member-preset controls reset their team-scoped override without changing the agent preset", () => {
  const preset = controlRecord("setting:description", { level: "preset", agent: "planner", text: "Agent preset description" })
  const input = memoInputOf(controlSnapshot([
    preset,
    controlRecord("setting:description", { level: "preset", agent: "planner", team: { level: "preset", team: "starter" }, text: "Member description" }),
  ]))
  const nodes = expandedTree(input)
  const member = row(nodes, "team:preset:starter:planner")
  const control = row(nodes, "item:preset:starter/:planner:setting:description")
  expect(member.actions?.reset).toBe(false)
  expect(control.actions?.reset).toBe(true)
  const result = reset(input, control.id)
  if ("refusal" in result) throw new Error(result.refusal)
  expect(result.records).toEqual([preset])
})

test("Remote disables local model/instructions actions without hiding values or their provenance; Local restores them", () => {
  const snapshot = controlSnapshot([
    controlRecord("compaction:strategy", { text: "remote" }),
    controlRecord("compaction:model", { text: "acme/small" }),
    controlRecord("compaction:instructions", { text: "Keep decisions.\nKeep tests." }),
  ])
  const input = memoInputOf(snapshot)
  const nodes = expandedTree(input)
  for (const id of ["compaction:model", "compaction:instructions"]) {
    const control = row(nodes, `item:project:build:${id}`)
    expect(control.badges.disabled).toContain("retained")
    expect(control.actions).toMatchObject({ edit: false, reset: false, toggle: false, split: false, remove: false })
    expect(sectionRows(control, snapshot)).toEqual([])
    expect(saveText(input, control.id, "discarded")).toHaveProperty("refusal")
    expect(reset(input, control.id)).toHaveProperty("refusal")
  }
  expect(row(nodes, "item:project:build:compaction:model").badges.value).toBe("acme/small")
  const local = saveText(input, "item:project:build:compaction:strategy", "local")
  if ("refusal" in local) throw new Error(local.refusal)
  const restored = row(expandedTree({ ...input, records: local.records }), "item:project:build:compaction:model")
  expect(restored.badges.disabled).toBeUndefined()
  expect(restored.badges.value).toBe("acme/small")
  expect(restored.actions).toMatchObject({ edit: true, reset: true })
})
