import { expect, test } from "bun:test"
import { fingerprint, type AgentSource, type Item } from "../src/instructions/model.js"
import { memoBuildCounter, resetMemoBuildCounter } from "../src/instructions/resolve-memo.js"
import { tree, type TeamInput } from "../src/instructions/tree.js"
import { removalPlan, teamPlan, toggle } from "../src/instructions/ops.js"
import type { Snapshot } from "../src/rpc.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"
import { moveTo, selectedRow } from "./instructions-nav.js"

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
