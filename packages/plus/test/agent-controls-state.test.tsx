import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createInstructionsState, type InstructionsState } from "../src/tui/instructions/state.js"
import { controlRecord, controlSnapshot } from "./agent-controls-fixture.js"
import { renderPlusFixture } from "./tui.js"

test("state toggles team members and member presets through their Enabled item rather than team enablement", async () => {
  let state: InstructionsState | undefined
  await using fixture = await renderPlusFixture({
    snapshots: [controlSnapshot([], {
      teams: [{ level: "project", team: "crew", enabled: true, agents: ["build"] }],
    })],
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })
  await fixture.waitForFrame(() => state?.snapshot() !== undefined)
  if (state === undefined) throw new Error("State did not mount")
  const current = state
  for (const id of ["team:project:crew:build", "team:preset:basic:planner"]) {
    current.setFilter(`id:${id}`)
    const node = current.nodes().find((node) => node.id === id)
    if (node === undefined) throw new Error(`Missing ${id}`)
    expect(node.enabledRow).toBeDefined()
    expect(await current.toggle(node)).toBe(true)
  }
  expect(fixture.fake.mutateInputs[0].records).toContainEqual(expect.objectContaining({
    level: "project", agent: "build", item: "setting:enabled", state: "off",
  }))
  expect(fixture.fake.mutateInputs[0].records[0]).not.toHaveProperty("team")
  expect(fixture.fake.mutateInputs[1].records).toContainEqual(expect.objectContaining({
    level: "preset", agent: "planner", item: "setting:enabled", team: { level: "preset", team: "basic" },
  }))
})
