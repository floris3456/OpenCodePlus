import { afterEach, expect, test } from "bun:test"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"
import { category, dispatch, footer, moveTo, sleep, toSidebar } from "./instructions-nav.js"

const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
})

test("L picks a primary without writes, Esc cancels, L on another row writes only the link with TUI actor", async () => {
  const snapshot = createSnapshot({
    agents: [{ id: "Implementer", scope: "project", fileBacked: true, origin: "user" }],
    records: [
      { type: "model", level: "project", agent: "Implementer", providerID: "acme", modelID: "first", active: true, updated: "2026-01-01" },
      { type: "model", level: "project", agent: "Implementer", providerID: "acme", modelID: "second", updated: "2026-01-01" },
    ],
  })
  const linked = { ...snapshot, revision: snapshot.revision + 1, records: [...snapshot.records, { type: "rowlink" as const, level: "project" as const, agent: "Implementer", item: "model:acme/first", section: null, target: "model:acme/second", targetSection: null, link: "either" as const, updated: "2026-01-01" }] }
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot, linked], dialogs: { selects: ["either", true, 0, "shownWhenOff", undefined, 0, "oneway", false] }, width: 110, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await toSidebar(fixture)
    await moveTo(fixture, "Implementer")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Models")
    await moveTo(fixture, "first")
    expect(dispatch(fixture, "shift+l")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("finish link"))
    expect(fixture.fake.mutateInputs).toHaveLength(0)
    dispatch(fixture, "shift+l")
    await fixture.waitForFrame((frame) => frame.includes("different rows in the same owner"))
    expect(fixture.fake.mutateInputs).toHaveLength(0)
    expect(fixture.fake.dialogSelects).toHaveLength(0)
    dispatch(fixture, "escape")
    await fixture.waitForFrame((frame) => frame.includes("Row link cancelled"))
    expect(fixture.fake.mutateInputs).toHaveLength(0)
    dispatch(fixture, "shift+l")
    await fixture.waitForFrame((frame) => frame.includes("finish link"))
    await moveTo(fixture, "second")
    dispatch(fixture, "shift+l")
    for (let i = 0; i < 80 && fixture.fake.mutateInputs.length === 0; i++) await sleep(50)
    expect(fixture.fake.mutateInputs).toHaveLength(1)
    const input = fixture.fake.mutateInputs[0]!
    expect(input.actor).toEqual({ type: "tui" })
    expect("changes" in input && input.changes.upsert).toHaveLength(1)
    expect("changes" in input && input.changes.upsert[0]).toMatchObject({ type: "rowlink", item: "model:acme/first", target: "model:acme/second", link: "either" })
    expect("changes" in input && input.changes.remove).toHaveLength(0)
    await sleep(100)
    // Cancelling the final enabled/mask picker changes nothing, even after
    // choosing a type. Editing an incoming link retains its named primary.
    dispatch(fixture, "shift+l")
    await sleep(100)
    expect(fixture.fake.mutateInputs).toHaveLength(1)
    dispatch(fixture, "shift+l")
    for (let i = 0; i < 80 && fixture.fake.mutateInputs.length < 2; i++) await sleep(50)
    expect(fixture.fake.mutateInputs).toHaveLength(2)
    const mask = fixture.fake.mutateInputs[1]!
    expect("changes" in mask && mask.changes.upsert).toHaveLength(1)
    expect("changes" in mask && mask.changes.upsert[0]).toMatchObject({ type: "rowlink", item: "model:acme/first", target: "model:acme/second", link: "oneway", enabled: false })
  } finally { fixture.destroy() }
})
