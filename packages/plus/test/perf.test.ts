import { expect, test } from "bun:test"
import { fingerprint, type AgentSource, type Item } from "../src/instructions/model.js"
import { expandedTreeCounter, resetExpandedTreeCounter, tree, type TeamInput } from "../src/instructions/tree.js"
import { removalPlan, teamPlan, toggle } from "../src/instructions/ops.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"

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

test("expandedTree is not invoked on initial state load without a filter", async () => {
  const input = makeSyntheticInput()
  const snapshot = createSnapshot({
    revision: 1,
    globalRevision: 1,
    agents: input.agents.map((a) => ({ ...a, fileBacked: true })),
    items: input.items,
    records: input.records,
    teams: input.teams,
  })

  resetExpandedTreeCounter()
  expect(expandedTreeCounter.count).toBe(0)

  await using fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
  })

  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  expect(expandedTreeCounter.count).toBe(0)
})
