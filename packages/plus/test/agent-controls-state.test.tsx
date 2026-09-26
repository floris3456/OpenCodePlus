import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createInstructionsState, type InstructionsState } from "../src/tui/instructions/state.js"
import { controlColor } from "../src/tui/instructions/tree-pane.js"
import { controlRecord, controlSnapshot } from "./agent-controls-fixture.js"
import { renderPlusFixture } from "./tui.js"

test("state rechecks Remote after a snapshot update, blocking stale editor/reset/review writes and retaining local values", async () => {
  const saved = [
    controlRecord("compaction:model", { text: "acme/small" }),
    controlRecord("compaction:instructions", { text: "Keep decisions." }),
  ]
  let state: InstructionsState | undefined
  await using fixture = await renderPlusFixture({
    snapshots: [
      controlSnapshot(saved),
      controlSnapshot([...saved, controlRecord("compaction:strategy", { text: "remote" })], { revision: 2 }),
      controlSnapshot(saved, { revision: 3 }),
    ],
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })
  await fixture.waitForFrame(() => state?.snapshot() !== undefined)
  if (state === undefined) throw new Error("State did not mount")
  const current = state
  current.setFilter("id:item:project:build:compaction:model")
  const stale = current.nodes().find((node) => node.address?.item === "compaction:model")
  if (stale === undefined) throw new Error("Missing model control")
  expect(stale.actions?.edit).toBe(true)
  await current.refresh()
  const remote = current.nodes().find((node) => node.id === stale.id)
  if (remote === undefined) throw new Error("Missing remote model control")
  expect(controlColor(fixture.context, remote)).toBe(fixture.context.theme.text.formfield.disabled)
  expect(await current.saveText(stale, "discarded")).toBe(false)
  expect(await current.reset(stale)).toBe(false)
  expect(await current.resolveEdit(stale, "discarded")).toBe(false)
  expect(await current.resolveKeep(stale)).toBe(false)
  expect(await current.resolveTake(stale)).toBe(false)
  expect(current.status()).toContain("retained")
  expect(fixture.fake.mutateInputs).toEqual([])
  expect(fixture.fake.dialogConfirms).toEqual([])
  expect(current.resolvedText(remote)).toBe("acme/small")
  await current.refresh()
  expect(await current.saveText(stale, "acme/new")).toBe(true)
  expect(fixture.fake.mutateInputs[0].records).toContainEqual(expect.objectContaining({ item: "compaction:model", text: "acme/new" }))
  expect(fixture.fake.mutateInputs[0].records).toContainEqual(saved[1])
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
  for (const id of ["team:project:crew:build", "team:preset:starter:planner"]) {
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
    level: "preset", agent: "planner", item: "setting:enabled", team: { level: "preset", team: "starter" },
  }))
})
