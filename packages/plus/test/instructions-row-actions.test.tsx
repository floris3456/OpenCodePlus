// Copy, cut, paste and duplicate on the Instructions screen: the footer names
// them where they apply (with the selected count), and ctrl+d either asks for
// the copy's name or says why the row cannot be duplicated.
import { expect, test } from "bun:test"
import { fingerprint } from "../src/instructions/model.js"
import type { Plus } from "../src/rpc.js"
import { dispatch, footer, reach, selectedRow } from "./instructions-nav.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"

const build = { id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const }

function item(id: string, title: string, extra: Partial<Plus.SnapshotItem> = {}): Plus.SnapshotItem {
  return { id, kind: "tool", group: "native", title, text: `${title} text`, enabled: true, fingerprint: fingerprint(`${title} text`), ...extra }
}

const snapshot = createSnapshot({
  agents: [build],
  items: [item("tool:read", "read"), item("tool:write", "write"), item("system:mine", "Mine", { kind: "system", group: "none", userSystem: true })],
})

test("the footer names copy and cut on a tool row, and their count once rows are selected; no duplicate for a row that exists once", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 150, height: 40 })
  await reach(fixture, "item:project:build:tool:read", "read")
  await fixture.waitForFrame((frame) => footer(frame).includes("ctrl+c copy"))
  expect(footer(fixture.captureCharFrame())).toContain("ctrl+x cut")
  expect(footer(fixture.captureCharFrame())).not.toContain("ctrl+d")
  expect(dispatch(fixture, "x")).toBe(true)
  expect(dispatch(fixture, "down")).toBe(true)
  await fixture.waitForFrame((frame) => selectedRow(frame).includes("write"))
  expect(dispatch(fixture, "x")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("ctrl+c copy 2") && footer(frame).includes("ctrl+x cut 2"))
  expect(dispatch(fixture, "ctrl+d")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes('None of the 2 rows can be duplicated: "read" exists once for each agent'))
})

test("ctrl+d on a user System row asks for the copy's name, offering \"<name> copy\", and duplicates it", async () => {
  const runs: unknown[] = []
  await using fixture = await renderInstructionsRoute({
    snapshots: [snapshot], width: 150, height: 40,
    dialogs: { prompts: ["Team rules"] },
    rpc: { "instructions.run": async (input: never) => { runs.push(input); return { status: 'Duplicated "Mine" as "Team rules"', rows: ["item:project:build:system:mine"] } } },
  })
  await reach(fixture, "item:project:build:system:mine", "Mine")
  await fixture.waitForFrame((frame) => footer(frame).includes("ctrl+d duplicate"))
  expect(dispatch(fixture, "ctrl+d")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes('Duplicated "Mine" as "Team rules"'))
  expect(fixture.fake.promptInputs.at(-1)).toMatchObject({ title: "Duplicate Mine", value: "Mine copy" })
  expect(runs).toEqual([expect.objectContaining({ op: "clipboard", input: { action: "duplicate", ids: ["item:project:build:system:mine"], name: "Team rules" } })])
})
