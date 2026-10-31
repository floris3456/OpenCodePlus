import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createInstructionsState, type InstructionsState } from "../src/tui/instructions/state.js"
import { bashItem, projectAgent, toolItem } from "./route-helpers.js"
import { createSnapshot, renderPlusFixture, type TestFixture } from "./tui.js"

// d-08 (instructions-itest 2026-10-30): Space on one agent's Tools group wrote
// that agent's rows and, in the same save, deleted another agent's records
// that equal what they inherit (a copy's 1,810 records went to 489). A TUI
// write names only the rows its op changed.
const updated = "2026-10-30T00:00:00.000Z"
// bb's record says what bb inherits anyway: a user agent's tools are off by default.
const inherited = { type: "customization" as const, level: "project" as const, agent: "bb", item: "tool:bash", section: null, state: "off" as const, basedOn: "fp-bash", updated }

async function mounted(records: readonly (typeof inherited)[]) {
  let state: InstructionsState | undefined
  const fixture = await renderPlusFixture({
    snapshots: [createSnapshot({
      agents: [projectAgent("aa"), projectAgent("bb")],
      items: [bashItem(), toolItem({ id: "tool:grep", title: "grep", fingerprint: "fp-grep" })],
      records: [...records],
    })],
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })
  await fixture.waitForFrame(() => state?.snapshot() !== undefined)
  if (state === undefined) throw new Error("State did not mount")
  return { fixture, state }
}

function sentDelta(fixture: TestFixture) {
  const sent = fixture.fake.mutateInputs[0]
  if (sent === undefined || !("changes" in sent)) throw new Error("No delta write")
  return sent
}

function row(state: InstructionsState, id: string) {
  state.setFilter(`id:${id}`)
  const node = state.nodes().find((entry) => entry.id === id)
  if (node === undefined) throw new Error(`Missing ${id}`)
  return node
}

test("toggling one agent's tool leaves another agent's records equal to what they inherit", async () => {
  const { fixture, state } = await mounted([inherited])
  await using _ = fixture
  expect(await state.toggle(row(state, "item:project:aa:tool:bash"))).toBe(true)
  const sent = sentDelta(fixture)
  expect(sent.changes.remove).toEqual([])
  expect(sent.changes.upsert.map((record) => [record.type === "customization" ? record.agent : undefined, record.type === "customization" ? record.item : undefined])).toEqual([["aa", "tool:bash"]])
  expect(fixture.fake.mutateInputs[0]!.records).toContainEqual(expect.objectContaining({ agent: "bb", item: "tool:bash", state: "off" }))
})

test("a group toggle writes only that agent's rows", async () => {
  const { fixture, state } = await mounted([inherited])
  await using _ = fixture
  expect(await state.toggle(row(state, "group:project:aa:tools:native"))).toBe(true)
  const sent = sentDelta(fixture)
  expect(sent.changes.remove).toEqual([])
  expect(sent.changes.upsert.every((record) => record.type === "customization" && record.agent === "aa")).toBe(true)
  expect(sent.changes.upsert.length).toBeGreaterThan(0)
})
