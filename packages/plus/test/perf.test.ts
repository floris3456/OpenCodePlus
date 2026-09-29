import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { controlItems } from "../src/instructions/agent-controls.js"
import { fingerprint, type AgentSource, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { memoBuildCounter, resetMemoBuildCounter } from "../src/instructions/resolve-memo.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { buildTreeMemo, expandedTree, tree, type TeamInput, type TreeNode } from "../src/instructions/tree.js"
import { removalPlan, teamPlan, toggle } from "../src/instructions/ops.js"
import type { Snapshot } from "../src/rpc.js"
import { createInstructionsState, type InstructionsState } from "../src/tui/instructions/state.js"
import { LEVELS, parentsOf, toolCountOf, type ToolCount } from "../src/tui/instructions/workspace.js"
import { createSnapshot, renderInstructionsRoute, renderPlusFixture } from "./tui.js"
import { breadcrumb, dispatch, moveTo, selectedRow, sleep } from "./instructions-nav.js"

function makeSyntheticInput() {
  const agents: AgentSource[] = []
  for (let i = 0; i < 25; i++) {
    agents.push({
      id: `agent-${i}`,
      scope: "project",
      base: "gpt",
      origin: "user",
    })
  }

  const items: Item[] = []
  for (let i = 0; i < 250; i++) {
    const kind = i % 5 === 0 ? "tool" : i % 5 === 1 ? "skill" : i % 5 === 2 ? "base" : i % 5 === 3 ? "system" : "mcp"
    const group = i % 3 === 0 ? "native" : i % 3 === 1 ? "plus" : "project"
    items.push({
      id: `${kind}:item-${i}`,
      kind: kind as Item["kind"],
      group: group as Item["group"],
      title: `Item ${i}`,
      text: `Text for item ${i}`,
      enabled: true,
      fingerprint: fingerprint(`Text for item ${i}`),
    })
  }

  const teams: TeamInput[] = []
  for (let i = 0; i < 7; i++) {
    teams.push({
      level: "project",
      team: `team-${i}`,
      enabled: true,
      agents: [`agent-${i * 2}`, `agent-${i * 2 + 1}`],
    })
  }

  return {
    items,
    records: [],
    agents,
    teams,
  }
}

test("synthetic dataset: removalPlan, teamPlan, toggle and tree() each complete under 50 ms", () => {
  const input = makeSyntheticInput()

  const t0 = performance.now()
  const removal = removalPlan(input, "team:project:team-0:agent-0")
  const durRemoval = performance.now() - t0
  expect(removal).toBeDefined()
  expect(durRemoval).toBeLessThan(50)

  const t1 = performance.now()
  const team = teamPlan(input, "team:project:team-0")
  const durTeam = performance.now() - t1
  expect(team).toBeDefined()
  expect(durTeam).toBeLessThan(50)

  const t2 = performance.now()
  const tog = toggle(input, "item:project:agent-0:tool:item-0")
  const durToggle = performance.now() - t2
  expect(tog).toBeDefined()
  expect(durToggle).toBeLessThan(50)

  const t3 = performance.now()
  const nodes = tree(input)
  const durTree = performance.now() - t3
  expect(nodes.length).toBeGreaterThan(0)
  expect(durTree).toBeLessThan(50)
})

test("initial state load builds exactly one resolution memo for the snapshot", async () => {
  const input = makeSyntheticInput()
  const snapshot = createSnapshot({
    revision: 1,
    globalRevision: 1,
    agents: input.agents.map((a) => ({ ...a, fileBacked: true })),
    items: input.items,
    records: input.records,
    teams: input.teams,
  })

  resetMemoBuildCounter()
  expect(memoBuildCounter.count).toBe(0)

  await using fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
  })

  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  expect(memoBuildCounter.count).toBe(1)
})

// A generated snapshot shaped like the live workspace: ~1.1k items, ~780
// permission rows, 20 agents, presets and links. It is never live data; the
// size is the point, so the view paths run at the scale the live screen sees.
function makeLargeSnapshot(revision = 1): Snapshot {
  const stamp = "2026-09-01T00:00:00.000Z"
  const toolText = (i: number) => `Bulk tool ${i}\n\n# Alpha\n\na\n\n# Beta\n\nb`
  const items: Item[] = [...controlItems()]
  for (let i = 0; i < 90; i++)
    items.push({
      id: `tool:bulk-${i}`,
      kind: "tool",
      group: i % 3 === 0 ? "native" : i % 3 === 1 ? "plus" : "project",
      title: `bulk-${i}`,
      text: toolText(i),
      enabled: true,
      fingerprint: fingerprint(toolText(i)),
      order: i,
      ...(i % 4 === 0 ? { codemode: true } : {}),
    })
  for (let i = 0; i < 787; i++) {
    const tool = `bulk-${i % 90}`
    const text = `Rule ${i}\npattern-${i} *`
    items.push({
      id: `perm:${tool}:rule-${i}`,
      kind: "perm",
      group: "none",
      title: `Rule ${i}`,
      text,
      enabled: i % 2 === 0,
      fingerprint: fingerprint(text),
      order: 200 + i,
      permTool: tool,
      ruleId: `rule-${i}`,
      patterns: [`pattern-${i} *`],
      keywords: i % 10 === 0 ? [`keyword-${i}`] : [],
      provenance: [],
      category: "rules",
      permKind: "input",
      field: "command",
      fallback: true,
    })
  }
  for (let i = 0; i < 140; i++) {
    const text = `Bulk setting ${i}`
    items.push({ id: `setting:bulk-${i}`, kind: "setting", group: "none", title: `Bulk setting ${i}`, text, enabled: true, fingerprint: fingerprint(text) })
  }
  for (let i = 0; i < 65; i++) {
    const text = `Bulk compaction ${i}`
    items.push({ id: `compaction:bulk-${i}`, kind: "compaction", group: "none", title: `Bulk compaction ${i}`, text, enabled: true, fingerprint: fingerprint(text) })
  }
  for (let i = 0; i < 7; i++) {
    const text = `Bulk base ${i}`
    items.push({ id: `base:bulk-${i}`, kind: "base", group: "none", title: `Bulk base ${i}`, text, enabled: true, fingerprint: fingerprint(text) })
  }
  for (let i = 0; i < 5; i++) {
    const text = `Bulk skill ${i}`
    items.push({ id: `skill:bulk-${i}`, kind: "skill", group: "project", title: `Bulk skill ${i}`, text, enabled: true, fingerprint: fingerprint(text) })
  }
  for (let i = 0; i < 22; i++) {
    const text = `Bulk system ${i}`
    items.push({ id: `system:bulk-${i}`, kind: "system", group: "none", title: `Bulk system ${i}`, text, enabled: true, fingerprint: fingerprint(text) })
  }
  for (let i = 0; i < 12; i++) {
    const text = `Bulk model ${i}`
    items.push({ id: `model:bulk/model-${i}`, kind: "model", group: "none", title: `bulk/model-${i}`, text, enabled: true, fingerprint: fingerprint(text) })
  }
  items.push({
    id: "mcp:bulk-server",
    kind: "mcp",
    group: "none",
    title: "bulk-server",
    text: '{"type":"local"}',
    enabled: true,
    fingerprint: fingerprint('{"type":"local"}'),
  })

  const agents: AgentSource[] = []
  for (let i = 0; i < 15; i++) agents.push({ id: `bulk-default-${i}`, scope: "defaults", base: "gpt", origin: i % 3 === 0 ? "native" : "user" })
  for (let i = 0; i < 3; i++) agents.push({ id: `bulk-project-${i}`, scope: "project", base: "gpt", origin: "user", path: `/agents/bulk-project-${i}.md` })
  for (let i = 0; i < 2; i++) agents.push({ id: `bulk-global-${i}`, scope: "global", base: "gpt", origin: "plus" })

  const teams = [
    { level: "project" as const, team: "bulk-team", enabled: true, agents: ["bulk-project-0", "bulk-project-1"] },
    { level: "defaults" as const, team: "starter", enabled: true, agents: ["bulk-default-0"] },
  ]

  const presets = ["bulk-preset-0", "bulk-preset-1", "bulk-preset-2"].map((id) => ({
    type: "preset" as const,
    level: "preset" as const,
    kind: "agent" as const,
    id,
    updated: stamp,
  }))
  const links = ["bulk-preset-0", "bulk-preset-1", "bulk-preset-2"].map((id, i) => ({
    type: "link" as const,
    level: "project" as const,
    agent: `bulk-project-${i}`,
    preset: { kind: "agent" as const, id },
    updated: stamp,
  }))

  const records: CustomizationRecord[] = []
  for (let i = 0; i < 5; i++)
    records.push({
      type: "customization",
      level: "project",
      agent: "bulk-project-0",
      item: `tool:bulk-${i}`,
      section: null,
      text: `Edited tool ${i}`,
      basedOn: fingerprint(toolText(i)),
      basedOnText: "Older tool text",
      updated: stamp,
    })
  for (let i = 5; i < 20; i++)
    records.push({
      type: "customization",
      level: "project",
      agent: "bulk-project-1",
      item: `tool:bulk-${i}`,
      section: null,
      state: i % 2 === 0 ? "off" : "on",
      basedOn: fingerprint(toolText(i)),
      updated: stamp,
    })

  return createSnapshot({
    revision,
    globalRevision: revision,
    items,
    records,
    agents: agents.map((agent) => ({ ...agent, fileBacked: true })),
    teams: teams.map((team) => ({ ...team, agents: [...team.agents] })),
    links,
    presets,
  })
}

test("a burst of instructions.changed events coalesces to one trailing reload", async () => {
  const first = createSnapshot({ revision: 1, globalRevision: 1 })
  const second = createSnapshot({ revision: 2, globalRevision: 2 })
  let state: InstructionsState | undefined
  await using fixture = await renderPlusFixture({
    snapshots: [first, second],
    width: 120,
    height: 40,
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })
  await fixture.waitForFrame(() => state?.snapshot() !== undefined)
  expect(fixture.fake.snapshotCalls).toBe(1)
  expect(state?.snapshot()?.revision).toBe(1)

  // Five events in the same tick: one load starts and the rest queue exactly
  // one trailing load, so the burst costs two snapshot reads, not five.
  await Promise.all([0, 1, 2, 3, 4].map(() => fixture.emitChanged()))
  await fixture.waitForFrame(() => state?.snapshot()?.revision === 2)
  await sleep(50)
  expect(fixture.fake.snapshotCalls).toBe(3)
})

// The old level-wide sweep, kept as the test oracle: materialise the whole
// tree, then for every owner's `:tools` group count the tool rows under it.
function sweepCounts(
  nodes: readonly TreeNode[],
  level: "project" | "global" | "defaults" | "preset",
  codemode: (item: string) => boolean,
): Map<string, ToolCount> {
  const root = LEVELS.find((entry) => entry.id === level)?.root ?? "root:project"
  const start = nodes.findIndex((node) => node.id === root)
  if (start === -1) return new Map()
  const parents = parentsOf(nodes)
  const counts = new Map<string, ToolCount>()
  for (let at = start; at < nodes.length; at++) {
    const node = nodes[at]!
    if (node.depth === 0 && at !== start) break
    if (node.kind !== "group" || !node.id.endsWith(":tools")) continue
    const owner = parents.get(node.id)
    if (owner === undefined) continue
    const key = owner.kind === "group" ? `${owner.id}#every` : owner.id
    const below: TreeNode[] = []
    for (let index = at + 1; index < nodes.length && nodes[index]!.depth > node.depth; index++) below.push(nodes[index]!)
    const rows = below.filter((row) => row.kind === "item" && row.address?.section === null && row.address.item.startsWith("tool:"))
    const on = rows.filter((row) => row.badges.state === "on")
    counts.set(key, {
      on: on.length,
      codemode: on.filter((row) => codemode(row.address!.item) && row.badges.pinned !== true).length,
      total: rows.length,
    })
  }
  return counts
}

test("on-demand tool counts match the old level-wide sweep for every owner", () => {
  const input = memoInputOf(makeLargeSnapshot())
  const memo = buildTreeMemo(input)
  const nodes = expandedTree(input)
  const codes = new Set(input.items.filter((item) => item.codemode === true).map((item) => item.id))
  const codemode = (item: string) => codes.has(item)
  for (const level of ["project", "global", "defaults", "preset"] as const) {
    const expected = sweepCounts(nodes, level, codemode)
    expect(expected.size).toBeGreaterThan(0)
    for (const [key, count] of expected) expect(toolCountOf(memo, key, codemode)).toEqual(count)
  }
}, 600_000)

test("large generated fixture: one memo build per snapshot across open, ↓, level switch, n and filter", async () => {
  const snapshot = makeLargeSnapshot()
  resetMemoBuildCounter()
  const openedAt = performance.now()
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 180, height: 50 })
  await fixture.waitForFrame((frame) => frame.includes("Instructions") && frame.includes("▌"))
  expect(performance.now() - openedAt).toBeLessThan(3000)
  expect(memoBuildCounter.count).toBe(1)

  // Sidebar movement: keys re-render the workspace and inspector from the same
  // memo.
  for (let i = 0; i < 3; i++) {
    const before = fixture.captureCharFrame()
    const at = performance.now()
    dispatch(fixture, "down")
    await fixture.waitForFrame((frame) => selectedRow(frame) !== selectedRow(before))
    expect(performance.now() - at).toBeLessThan(1000)
  }
  expect(memoBuildCounter.count).toBe(1)

  // Opening a row materialises its subtree, still from the same memo.
  const beforeOpen = fixture.captureCharFrame()
  dispatch(fixture, "right")
  await fixture.waitForFrame((frame) => frame !== beforeOpen)
  expect(memoBuildCounter.count).toBe(1)

  // Level switch: the new level walks the same memo.
  const beforeLevel = fixture.captureCharFrame()
  dispatch(fixture, ">")
  await fixture.waitForFrame((frame) => breadcrumb(frame) !== breadcrumb(beforeLevel))
  expect(memoBuildCounter.count).toBe(1)

  // n (next review) walks the level's review targets from the same memo.
  dispatch(fixture, "n")
  await fixture.flush()
  await sleep(50)
  expect(memoBuildCounter.count).toBe(1)

  // Filter: the match walk and the materialised matches share the memo. The
  // term is an id prefix so the result stays a handful of rows: every rendered
  // list row owns native OpenTUI text handles, and a deliberately wide match
  // set would measure the renderer's handle ceiling, not this walk.
  dispatch(fixture, "/")
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  await fixture.typeText("id:agent:global:bulk-global-1")
  await sleep(250)
  await fixture.waitForFrame((frame) => frame.includes("esc clear filter") && selectedRow(frame).includes("bulk-global-1"))
  expect(memoBuildCounter.count).toBe(1)
}, 600_000)

test("realistic lab dataset benchmark: Enter -> tree rows and d -> confirm dialog on Cobra/testttt", async () => {
  // Realistic dataset matching lab project: 7 teams, 20 agents, 229 items
  const agents: AgentSource[] = []
  for (let i = 0; i < 20; i++) {
    agents.push({
      id: i === 0 ? "testttt" : `agent-${i}`,
      scope: "project",
      base: "gpt",
      origin: "user",
    })
  }

  const items: Item[] = []
  for (let i = 0; i < 229; i++) {
    const kind = i % 5 === 0 ? "tool" : i % 5 === 1 ? "skill" : i % 5 === 2 ? "base" : i % 5 === 3 ? "system" : "mcp"
    const group = i % 3 === 0 ? "native" : i % 3 === 1 ? "plus" : "project"
    items.push({
      id: `${kind}:item-${i}`,
      kind: kind as Item["kind"],
      group: group as Item["group"],
      title: `Item ${i}`,
      text: `Text for item ${i}`,
      enabled: true,
      fingerprint: fingerprint(`Text for item ${i}`),
    })
  }

  const teams: TeamInput[] = [
    { level: "project", team: "Cobra", enabled: false, agents: ["testttt"] },
    { level: "project", team: "bruh test", enabled: false, agents: [] },
    { level: "project", team: "opencodeplus-team", enabled: true, agents: ["astra-planner", "testttt"] },
    { level: "global", team: "global-team", enabled: true, agents: ["agent-1"] },
    { level: "defaults", team: "starter", enabled: true, agents: ["agent-2"] },
    { level: "defaults", team: "review", enabled: true, agents: ["agent-3"] },
    { level: "defaults", team: "opencodeplus-team", enabled: true, agents: ["agent-4"] },
  ]

  const realisticInput = { items, records: [], agents, teams }

  // 1. Time Enter -> tree rows
  const tEnter0 = performance.now()
  const initialNodes = tree(realisticInput)
  const tEnterDuration = performance.now() - tEnter0
  expect(tEnterDuration).toBeLessThan(150)
  expect(initialNodes.length).toBeGreaterThan(0)

  // 2. Measure d -> Delete dialog 3 times on Cobra / testttt
  const timings: number[] = []
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now()
    const plan = removalPlan(realisticInput, "team:project:Cobra:testttt")
    const elapsed = performance.now() - t0
    timings.push(elapsed)
    expect("kind" in plan).toBe(true)
    if ("kind" in plan) {
      expect(plan.kind).toBe("team.removeAgent")
    }
    expect(elapsed).toBeLessThan(60)
  }

  const snapshot: Snapshot = {
    ...createSnapshot({
      revision: 1,
      globalRevision: 1,
      agents: agents.map((a) => ({ ...a, fileBacked: true })),
      items,
      records: [],
    }),
    teams: teams.map((t) => ({ ...t, agents: [...t.agents] })),
  }

  await using fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { confirms: [undefined] },
  })

  await fixture.waitForFrame((frame) => frame.includes("Instructions"))

  // The sidebar lists teams open with their members: walk down to the member.
  await moveTo(fixture, "Cobra")
  await moveTo(fixture, "testttt")

  const settledBeforeD = fixture.captureCharFrame()
  expect(selectedRow(settledBeforeD)).toContain("testttt")
})
