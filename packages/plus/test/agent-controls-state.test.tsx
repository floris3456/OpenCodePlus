import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createInstructionsState, type InstructionsState } from "../src/tui/instructions/state.js"
import { controlRecord, controlSnapshot } from "./agent-controls-fixture.js"
import { renderPlusFixture } from "./tui.js"
import { fingerprint } from "../src/instructions/model.js"

test("TUI inspection includes shipped markers and reset persists rowlink removal", async () => {
  const text = "# Notes\n<!-- requires: setting:hidden -->\nRead this.\n"
  const item = { id: "system:notes", kind: "system" as const, group: "none" as const, title: "Notes", text, enabled: true, fingerprint: fingerprint(text) }
  let state: InstructionsState | undefined
  await using fixture = await renderPlusFixture({
    snapshots: [controlSnapshot([], { items: [item], records: [{
      type: "rowlink", level: "project", agent: "build", item: "system:notes", section: null,
      target: "system:notes", targetSection: null, link: "shownAlways", updated: "2026-01-01T00:00:00.000Z",
    // Off, unlike the on build inherits, so the row holds an edit to reset.
    }, { type: "customization", level: "project", agent: "build", item: "system:notes", section: null,
      state: "off", basedOn: item.fingerprint, updated: "2026-01-01T00:00:00.000Z",
    }] }), controlSnapshot([], { items: [item], records: [] })],
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })
  await fixture.flush()
  if (state?.snapshot() === undefined) throw new Error(`State did not load: ${state?.status()}`)
  const current = state
  current.setFilter("id:item:project:build:system:notes")
  const node = current.nodes().find((entry) => entry.id === "item:project:build:system:notes")
  if (node === undefined) throw new Error("Missing Notes row")
  expect(current.linksFor(node)).toEqual([])
  expect(await current.reset(node)).toBe(true)
  expect(fixture.fake.mutateInputs[0].records.filter((record) => record.type === "rowlink")).toEqual([])
  expect(current.linksFor(node).map((entry) => [entry.item, entry.shipped])).toEqual([["setting:hidden", true]])
})

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
