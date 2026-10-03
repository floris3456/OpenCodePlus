// Help (docs/instructions-workspace-followup.md §7): the dialog is centered,
// its columns are balanced by estimated rendered height, and the workspace
// renders unfocused behind any open dialog without losing its place.
import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { fingerprint } from "../src/instructions/model.js"
import { HELP, HELP_COLUMN_WIDTH, helpColumns, helpHeight, HelpDialog, type HelpGroup } from "../src/tui/instructions/help.js"
import { CURSOR } from "../src/tui/instructions/row.js"
import { dispatch, sleep } from "./instructions-nav.js"
import { createSnapshot, createTestTheme, renderInstructionsRoute, renderPlusFixture } from "./tui.js"

test("the balanced splitter keeps every group and minimises the taller column", () => {
  const columns = helpColumns(HELP, HELP_COLUMN_WIDTH)
  expect(columns).toHaveLength(2)
  expect(columns.flatMap((column) => column.map((group) => group[0]))).toEqual(HELP.map((group) => group[0]))
  const height = (groups: readonly HelpGroup[]) => groups.reduce((total, group) => total + helpHeight(group, HELP_COLUMN_WIDTH), 0)
  const cuts = Array.from({ length: HELP.length - 1 }, (_, index) => index + 1)
  const best = Math.min(...cuts.map((cut) => Math.max(height(HELP.slice(0, cut)), height(HELP.slice(cut)))))
  expect(Math.max(height(columns[0]!), height(columns[1]!))).toBe(best)
  // A single group stays one column.
  expect(helpColumns([HELP[0]!], HELP_COLUMN_WIDTH)).toEqual([[HELP[0]]])
})

test("? asks for a centered help dialog: xlarge wide, large below", async () => {
  await using wide = await renderInstructionsRoute({ snapshots: [createSnapshot()], width: 130, height: 45 })
  await wide.waitForFrame((frame) => frame.includes("esc close"))
  expect(dispatch(wide, "?")).toBe(true)
  expect(wide.dialogSets).toEqual([{ size: "xlarge", centered: true }])
  await using narrow = await renderInstructionsRoute({ snapshots: [createSnapshot()], width: 100, height: 40 })
  await narrow.waitForFrame((frame) => frame.includes("esc close"))
  expect(dispatch(narrow, "?")).toBe(true)
  expect(narrow.dialogSets).toEqual([{ size: "large", centered: true }])
})

test("wide help has two equally starting columns and every group title", async () => {
  await using fixture = await renderPlusFixture({
    snapshots: [],
    width: 130,
    height: 45,
    render: (context) => createComponent(HelpDialog, { context }),
  })
  await fixture.flush()
  const frame = fixture.captureCharFrame()
  for (const group of HELP) expect(frame).toContain(group[0])
  const lines = frame.split("\n")
  const start = (title: string) => {
    const line = lines.find((entry) => entry.includes(title))
    if (line === undefined) throw new Error(`no help group "${title}"`)
    return line.indexOf(title)
  }
  // The left column's groups align, the right column's groups align, and the
  // right column starts further right (two columns).
  expect(start("Change")).toBe(start("Move"))
  const right = ["Create and link", "Review (a row marked !)", "Colours and marks", "Filter"].map(start)
  expect(new Set(right).size).toBe(1)
  expect(right[0]).toBeGreaterThan(start("Move"))
  // The level keys, bulk expansion and the panel resize mode are documented.
  expect(frame).toContain("shift+tab")
  expect(frame).toContain("shift+[ ] { }")
  expect(frame).toContain("shift+1–4")
  expect(frame).toContain("ctrl+E")
  expect(frame).toContain("W / alt+W")
  expect(frame).toContain("resize the panels")
})

test("narrow help is one column with wrapped labels", async () => {
  await using fixture = await renderPlusFixture({
    snapshots: [],
    width: 100,
    height: 40,
    render: (context) => createComponent(HelpDialog, { context }),
  })
  await fixture.flush()
  const frame = fixture.captureCharFrame()
  const lines = frame.split("\n")
  const start = (title: string) => {
    const line = lines.find((entry) => entry.includes(title))
    if (line === undefined) throw new Error(`no help group "${title}"`)
    return line.indexOf(title)
  }
  expect(frame).toContain("Move")
  expect(frame).toContain("Change")
  expect(start("Change")).toBe(start("Move"))
  expect(frame).toContain("shift+[ ] { }")
  // The wrapped label is indented under the key column, not under the key.
  const wrapped = lines.find((line) => line.includes("previous / next level (terminal")) ?? ""
  expect(wrapped.indexOf("previous")).toBeGreaterThanOrEqual(18)
})

test("a modal dialog dims the workspace and closing restores it exactly", async () => {
  const text = "run\n"
  await using fixture = await renderInstructionsRoute({
    snapshots: [
      createSnapshot({
        agents: [{ id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const }],
        items: [
          { id: "tool:bash", kind: "tool" as const, group: "native" as const, title: "bash", text, enabled: true, fingerprint: fingerprint(text) },
        ],
      }),
    ],
    width: 130,
    height: 45,
  })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  // The deferred tool counts settle a tick after the first frame.
  await sleep(50)
  const theme = createTestTheme()
  const before = fixture.captureCharFrame()
  const rowIndex = before.split("\n").findIndex((line) => line.includes(CURSOR))
  expect(rowIndex).toBeGreaterThanOrEqual(0)
  const rowSpan = () => fixture.captureSpans().lines[rowIndex]?.spans.find((span) => span.text.includes("build"))
  // Focused while the workspace owns input.
  expect(rowSpan()?.bg.equals(theme.background.action.primary.focused)).toBe(true)
  fixture.setKeymapMode("modal")
  await fixture.waitForFrame((frame) => !frame.includes(CURSOR))
  const modal = fixture.captureCharFrame()
  expect(modal).not.toContain(CURSOR)
  expect(rowSpan()?.bg.equals(theme.background.raised.high)).toBe(true)
  expect(
    fixture.captureSpans().lines.flatMap((line) => line.spans).some((span) => span.bg.equals(theme.background.action.primary.focused)),
  ).toBe(false)
  // Closing restores the exact frame: cursor, breadcrumb, footer, expansions.
  fixture.setKeymapMode("normal")
  await fixture.waitForFrame((frame) => frame.includes(CURSOR))
  expect(fixture.captureCharFrame()).toBe(before)
  expect(rowSpan()?.bg.equals(theme.background.action.primary.focused)).toBe(true)
})
test("help names the model edit on enter and no warming key", () => {
  const entries = HELP.flatMap((group) => group[1])
  // `w` is "shown when" now, never the retired warming key.
  expect(entries.filter(([key]) => key === "w").map(([, label]) => label)).toEqual([
    "shown when: send a system row or section only while chosen rows are on",
  ])
  expect(entries.some(([, label]) => label.includes("cache warming"))).toBe(false)
  const enter = entries.find(([key]) => key === "enter")
  expect(enter?.[1]).toContain("edit a model")
})
