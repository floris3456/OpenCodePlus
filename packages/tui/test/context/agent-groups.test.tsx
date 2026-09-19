import { expect, test } from "bun:test"
import { agent, model, renderLocal } from "../fixture/local"
import { DialogAgent } from "../../src/component/dialog-agent"

test("agent groups: cycling excludes group members when inactive, cycles group members when active, clears on ungrouped set", async () => {
  const agents = [
    agent("build"),
    agent("plan"),
    agent("scout"),
    agent("astra-planner"),
    agent("astra-reviewer"),
    { ...agent("sub-worker"), mode: "subagent" as const },
    { ...agent("hidden-agent"), hidden: true },
  ]
  await using setup = await renderLocal({
    agents,
    models: [model("first")],
  })

  // Register provider with one group of two agents among five primaries
  setup.local.agent.groups(() => [
    {
      id: "team:opencodeplus",
      label: "Team: opencodeplus",
      agents: ["astra-planner", "astra-reviewer", "sub-worker", "hidden-agent"],
    },
  ])

  // Without active group: list() excludes the group's agents (and subagent/hidden)
  const initial = setup.local.agent.list().map((a) => a.id)
  expect(initial).toEqual(["build", "plan", "scout"])
  expect(setup.local.agent.activeGroup.current()).toBeUndefined()

  // set(member) activates the group
  setup.local.agent.set("astra-planner")
  expect(setup.local.agent.activeGroup.current()).toBe("team:opencodeplus")
  expect(setup.local.agent.current()?.id).toBe("astra-planner")

  // list() in active group contains only group's primaries (hidden/subagent excluded)
  const groupList = setup.local.agent.list().map((a) => a.id)
  expect(groupList).toEqual(["astra-planner", "astra-reviewer"])

  // move(1) wraps inside the two
  setup.local.agent.move(1)
  expect(setup.local.agent.current()?.id).toBe("astra-reviewer")
  setup.local.agent.move(1)
  expect(setup.local.agent.current()?.id).toBe("astra-planner")

  // set(ungrouped) clears active group
  setup.local.agent.set("build")
  expect(setup.local.agent.activeGroup.current()).toBeUndefined()
  expect(setup.local.agent.current()?.id).toBe("build")
  const clearedList = setup.local.agent.list().map((a) => a.id)
  expect(clearedList).toEqual(["build", "plan", "scout"])

  // move(1) cycles through normal agents
  setup.local.agent.move(1)
  expect(setup.local.agent.current()?.id).toBe("plan")
  setup.local.agent.move(1)
  expect(setup.local.agent.current()?.id).toBe("scout")
  setup.local.agent.move(1)
  expect(setup.local.agent.current()?.id).toBe("build")
})

test("hidden and subagent members cannot be set and are never in the ring", async () => {
  const agents = [
    agent("build"),
    agent("plan"),
    agent("astra-planner"),
    { ...agent("sub-worker"), mode: "subagent" as const },
    { ...agent("hidden-agent"), hidden: true },
  ]
  await using setup = await renderLocal({
    agents,
    models: [model("first")],
  })

  setup.local.agent.groups(() => [
    {
      id: "team:opencodeplus",
      label: "Team: opencodeplus",
      agents: ["astra-planner", "sub-worker", "hidden-agent"],
    },
  ])

  // Cannot set subagent or hidden agent
  setup.local.agent.set("sub-worker")
  expect(setup.local.agent.current()?.id).toBe("build")
  setup.local.agent.set("hidden-agent")
  expect(setup.local.agent.current()?.id).toBe("build")

  // Activating the group shows only astra-planner
  setup.local.agent.set("astra-planner")
  expect(setup.local.agent.list().map((a) => a.id)).toEqual(["astra-planner"])
})

test("DialogAgent renders categories: Agents first, then groups in provider order", async () => {
  const agents = [
    agent("build"),
    agent("plan"),
    agent("astra-planner"),
    agent("astra-reviewer"),
  ]
  await using setup = await renderLocal({
    agents,
    models: [model("first")],
  })

  setup.local.agent.groups(() => [
    {
      id: "team:opencodeplus",
      label: "Team: opencodeplus-team (project)",
      agents: ["astra-planner", "astra-reviewer"],
    },
  ])

  setup.dialog.replace(() => <DialogAgent />)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Select agent")
  expect(frame).toContain("Agents")
  expect(frame).toContain("Team: opencodeplus-team (project)")
  expect(frame).toContain("build")
  expect(frame).toContain("astra-planner")
})

