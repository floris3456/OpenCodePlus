import { afterEach, expect, test } from "bun:test"
import type { DialogSelectOptions } from "@opencode/plugin/tui/context"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import { memoBuildCounter, resetMemoBuildCounter } from "../src/instructions/resolve-memo.js"
import { createSnapshot, renderInstructionsRoute, renderPlusFixture } from "./tui.js"
import { category, dispatch, expand, footer, moveTo, sleep, toSidebar } from "./instructions-nav.js"

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
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot, linked], dialogs: { selects: ["either", 0, undefined, 0, "shownWhenOff"] }, width: 110, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await toSidebar(fixture)
    await moveTo(fixture, "Implementer")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Models")
    // Both rows sit in the acme › Other group.
    await moveTo(fixture, "Other")
    await expand(fixture)
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
    // Cancelling the type picker changes nothing. Editing an incoming link
    // retains its named primary and saves without a second picker.
    resetMemoBuildCounter()
    dispatch(fixture, "shift+l")
    await sleep(100)
    expect(fixture.fake.mutateInputs).toHaveLength(1)
    expect(memoBuildCounter.count).toBe(0)
    dispatch(fixture, "shift+l")
    for (let i = 0; i < 80 && fixture.fake.mutateInputs.length < 2; i++) await sleep(50)
    expect(fixture.fake.mutateInputs).toHaveLength(2)
    const edit = fixture.fake.mutateInputs[1]!
    expect("changes" in edit && edit.changes.upsert).toHaveLength(1)
    expect("changes" in edit && edit.changes.upsert[0]).toMatchObject({ type: "rowlink", item: "model:acme/first", target: "model:acme/second", link: "shownWhenOff" })
    expect(fixture.fake.selectInputs.some((input) => input.title.includes("mask"))).toBe(false)
  } finally { fixture.destroy() }
})

test("Escape from an editor also cancels the pending primary without writing", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({
      agents: [{ id: "Implementer", scope: "project", fileBacked: true, origin: "user" }],
      items: [{ id: "tool:reader", kind: "tool", group: "native", title: "reader", text: "Read files", enabled: true, fingerprint: "fp-reader" }],
    })], width: 110, height: 40,
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await toSidebar(fixture)
    await moveTo(fixture, "Implementer")
    dispatch(fixture, "right")
    await category(fixture, "Tools")
    await moveTo(fixture, "reader")
    dispatch(fixture, "shift+l")
    await fixture.waitForFrame((frame) => footer(frame).includes("cancel link"))
    expect(dispatch(fixture, "e")).toBe(true)
    await fixture.flush()
    dispatch(fixture, "escape")
    await fixture.waitForFrame((frame) => frame.includes("Row link cancelled"))
    expect(footer(fixture.captureCharFrame())).not.toContain("finish link")
    expect(fixture.fake.mutateInputs).toHaveLength(0)
    dispatch(fixture, "shift+l")
    await fixture.waitForFrame((frame) => footer(frame).includes("finish link"))
    dispatch(fixture, "escape")
    await fixture.waitForFrame((frame) => frame.includes("Row link cancelled"))
    expect(fixture.fake.dialogSelects).toHaveLength(0)
  } finally { fixture.destroy() }
})

test("link list Space toggles immediately and d removes only the local directed pair", async () => {
  const snapshot = createSnapshot({
    agents: [{ id: "Implementer", scope: "project", fileBacked: true, origin: "user" }],
    records: [
      { type: "model", level: "project", agent: "Implementer", providerID: "acme", modelID: "first", active: true, updated: "2026-01-01" },
      { type: "model", level: "project", agent: "Implementer", providerID: "acme", modelID: "second", updated: "2026-01-01" },
      { type: "rowlink", level: "project", agent: "Implementer", item: "model:acme/first", section: null, target: "model:acme/second", targetSection: null, link: "shownWhenOff", updated: "2026-01-01" },
    ],
  })
  let title = ""
  let options: readonly string[] = []
  let trigger: (bind: string) => void = () => { throw new Error("No dialog open") }
  let clear = () => {}
  const fixture = await renderPlusFixture({
    snapshots: [snapshot], width: 110, height: 40,
    render: (context, cache) => <InstructionsRoute context={{
      ...context,
      ui: { ...context.ui, dialog: {
        ...context.ui.dialog,
        clear: () => clear(),
        select<Value>(input: DialogSelectOptions<Value>) {
          title = input.title
          options = input.options.map((option) => option.title)
          return new Promise<Value | undefined>((resolve) => {
            clear = () => resolve(undefined)
            trigger = (bind) => {
              const action = input.actions?.find((action) => action.bind === bind)
              expect(action).toBeDefined()
              if (action?.selection === "none") action.onTrigger()
              else action?.onTrigger(input.options[0]!.value)
            }
          })
        },
      } },
    }} cache={cache} onClose={() => {}} />,
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await toSidebar(fixture)
    await moveTo(fixture, "Implementer")
    dispatch(fixture, "right")
    await category(fixture, "Models")
    await moveTo(fixture, "Other")
    await expand(fixture)
    await moveTo(fixture, "second")
    dispatch(fixture, "shift+l")
    await fixture.flush()
    expect(title).toContain("Row links")
    expect(options[0]).toContain("incoming")
    trigger("space")
    await fixture.flush()
    expect(options[0]).toContain("disabled")
    await fixture.waitForFrame((frame) => frame.includes("Disabled link"))
    expect(fixture.fake.mutateInputs).toHaveLength(1)
    const disabled = fixture.fake.mutateInputs[0]!
    expect("changes" in disabled && disabled.changes.upsert[0]).toMatchObject({
      item: "model:acme/first", target: "model:acme/second", enabled: false,
    })
    trigger("space")
    await fixture.flush()
    expect(options[0]).toContain("enabled")
    await fixture.waitForFrame((frame) => frame.includes("Linked"))
    trigger("d")
    await fixture.flush()
    expect(options).toEqual(["Link another row"])
    await fixture.waitForFrame((frame) => frame.includes("Deleted link"))
    const removed = fixture.fake.mutateInputs.at(-1)!
    expect("changes" in removed && removed.changes.upsert).toHaveLength(0)
    expect("changes" in removed && removed.changes.remove).toHaveLength(1)
    expect("changes" in removed && removed.changes.remove[0]).toMatchObject({
      type: "rowlink", item: "model:acme/first", target: "model:acme/second", level: "project", agent: "Implementer",
    })
    clear()
  } finally { fixture.destroy() }
})
