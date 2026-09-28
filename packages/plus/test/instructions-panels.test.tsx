// Resizable wide-layout panels (docs/instructions-workspace-followup.md §5):
// fixed Owners and Inspector widths around a flexible middle list, mouse
// dividers with double-click reset, durable client-local persistence, and the
// W / alt+W keyboard resize mode.
import { MouseButton, RGBA } from "@opentui/core"
import { expect, test } from "bun:test"
import { fingerprint } from "../src/instructions/model.js"
import type { Snapshot } from "../src/rpc.js"
import {
  clampInspector,
  clampOwners,
  defaultInspector,
  DIVIDERS,
  INSPECTOR_MIN,
  MIN_LIST,
  OWNERS_DEFAULT,
  OWNERS_MIN,
  PANELS_STORAGE_KEY,
  panelWidths,
} from "../src/tui/instructions/panels.js"
import { breadcrumb, dispatch, footer, reach, selectedRow, sleep } from "./instructions-nav.js"
import { createSnapshot, createTestTheme, renderInstructionsRoute, type TestFixture } from "./tui.js"

const build = { id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const }

function tool(id: string, title: string, text: string) {
  return { id, kind: "tool" as const, group: "native" as const, title, text, enabled: true, fingerprint: fingerprint(text) }
}

function snapshot(): Snapshot {
  return createSnapshot({
    agents: [build],
    items: [tool("tool:bash", "bash", "run\n"), tool("tool:read", "read", "read\n")],
  })
}

/** The background colour of every column in one rendered row. */
function rowColors(fixture: TestFixture, y: number): RGBA[] {
  return fixture.captureSpans().lines[y]!.spans.flatMap((span) => Array.from({ length: span.width }, () => span.bg))
}

function columnsWith(fixture: TestFixture, y: number, color: RGBA): number[] {
  const ints = color.toInts().join()
  return rowColors(fixture, y).flatMap((bg, x) => (bg.toInts().join() === ints ? [x] : []))
}

/** The x of the two divider columns at this row: each owns its line glyph. */
function dividerColumns(fixture: TestFixture, y = 3): number[] {
  const line = fixture.captureCharFrame().split("\n")[y] ?? ""
  return [...line].flatMap((char, x) => (char === "│" ? [x] : []))
}

/** The divider columns whose background carries this highlight. */
function highlightedDividers(fixture: TestFixture, color: RGBA, y = 3): number[] {
  const dividers = new Set(dividerColumns(fixture, y))
  const ints = color.toInts().join()
  return rowColors(fixture, y).flatMap((bg, x) => (dividers.has(x) && bg.toInts().join() === ints ? [x] : []))
}

function panels(fixture: TestFixture): unknown {
  return fixture.storeValue(PANELS_STORAGE_KEY)
}

async function open(width = 130, height = 45): Promise<TestFixture> {
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width, height })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  return fixture
}

test("panels.ts pins the defaults, the clamps and the effective widths", () => {
  expect(OWNERS_DEFAULT).toBe(30)
  expect(OWNERS_MIN).toBe(24)
  expect(INSPECTOR_MIN).toBe(24)
  expect(MIN_LIST).toBe(30)
  // The default inspector is two fifths of the space right of Owners.
  expect(defaultInspector(110, 30)).toBe(32)
  expect(defaultInspector(130, 30)).toBe(40)
  // Minimums hold even when the pair cannot fit.
  expect(clampOwners(10, 130, 40)).toBe(OWNERS_MIN)
  expect(clampInspector(10, 130, 30)).toBe(INSPECTOR_MIN)
  // Dragging right stops when the list would leave its minimum: two dividers.
  expect(clampOwners(999, 110, 32)).toBe(110 - 32 - MIN_LIST - DIVIDERS)
  expect(clampInspector(999, 110, 30)).toBe(110 - 30 - MIN_LIST - DIVIDERS)
  expect(clampOwners(999, 110, 999)).toBe(OWNERS_MIN)
  expect(clampInspector(999, 110, 999)).toBe(INSPECTOR_MIN)
  // Defaults preserve the current look; the list is what remains.
  expect(panelWidths(110, {})).toEqual({ owners: 30, inspector: 32, list: 46 })
  expect(panelWidths(130, {})).toEqual({ owners: 30, inspector: 40, list: 58 })
  // Saved preferences reappear on a wide terminal ...
  expect(panelWidths(200, { owners: 41, inspector: 40 })).toEqual({ owners: 41, inspector: 40, list: 117 })
  // ... and re-clamp when it shrinks, keeping the list usable.
  expect(panelWidths(110, { owners: 41, inspector: 40 })).toEqual({ owners: 41, inspector: 37, list: 30 })
  const saturated = panelWidths(110, { owners: 999, inspector: 999 })
  expect(saturated.list).toBe(MIN_LIST)
  expect(saturated.owners + saturated.inspector + saturated.list + DIVIDERS).toBe(110)
})

test("the wide layout renders both divider hit targets between fixed panes", async () => {
  await using fixture = await open()
  const theme = createTestTheme()
  expect(dividerColumns(fixture)).toEqual([30, 89])
  // The focused selected sidebar row spans exactly the Owners width.
  expect(columnsWith(fixture, 4, theme.background.action.primary.focused)).toEqual(Array.from({ length: 30 }, (_, x) => x))
  // Hovering a divider raises it and leaving idles it again.
  await fixture.mockMouse.moveTo(30, 3)
  await fixture.flush()
  expect(highlightedDividers(fixture, theme.background.raised.high)).toEqual([30])
  expect(dividerColumns(fixture)).toEqual([30, 89])
  await fixture.mockMouse.moveTo(1, 1)
  await fixture.flush()
  expect(highlightedDividers(fixture, theme.background.raised.high)).toEqual([])
  // Clicking a row still selects it with the dividers in place.
  const frame = fixture.captureCharFrame().split("\n")
  const teams = frame.findIndex((line, y) => y > 1 && line.slice(0, 30).includes("Teams"))
  await fixture.mockMouse.click(frame[teams]!.indexOf("Teams") + 1, teams)
  await fixture.waitForFrame((entry) => selectedRow(entry).includes("Teams"))
  expect(footer(fixture.captureCharFrame())).toContain("tab list")
})

test("a mouse drag moves each divider and the list absorbs the same delta", async () => {
  await using fixture = await open()
  await fixture.mockMouse.drag(30, 3, 40, 3)
  await fixture.flush()
  // Owners 30 → 41 (fromMouse is x + 1): the divider moves, the inspector
  // stays put and the middle list loses exactly the 11 columns.
  expect(dividerColumns(fixture)).toEqual([41, 89])
  expect(panels(fixture)).toEqual({ owners: 41, inspector: 40 })
  expect(columnsWith(fixture, 4, createTestTheme().background.action.primary.focused).at(-1)).toBe(40)
  // Inspector 40 → 30: dragging its divider left to x=99.
  await fixture.mockMouse.drag(89, 3, 99, 3)
  await fixture.flush()
  expect(dividerColumns(fixture)).toEqual([41, 99])
  expect(panels(fixture)).toEqual({ owners: 41, inspector: 30 })
})

test("only the left button starts a resize", async () => {
  await using fixture = await open()
  await fixture.mockMouse.drag(30, 3, 60, 3, MouseButton.RIGHT)
  await fixture.flush()
  await fixture.mockMouse.drag(30, 3, 60, 3, MouseButton.MIDDLE)
  await fixture.flush()
  expect(dividerColumns(fixture)).toEqual([30, 89])
  expect(panels(fixture)).toBeUndefined()
  // Control: the same drag with the left button resizes.
  await fixture.mockMouse.drag(30, 3, 40, 3)
  await fixture.flush()
  expect(dividerColumns(fixture)).toEqual([41, 89])
})

test("a drag past the edge clamps so the list keeps its minimum", async () => {
  await using fixture = await open()
  await fixture.mockMouse.drag(30, 3, 129, 3)
  await fixture.flush()
  // Owners stops at width - inspector(40) - MIN_LIST - dividers = 58.
  expect(dividerColumns(fixture)).toEqual([58, 89])
  expect(panels(fixture)).toEqual({ owners: 58, inspector: 40 })
  await using inspector = await open()
  await inspector.mockMouse.drag(89, 3, 0, 3)
  await inspector.flush()
  // The inspector stops at width - owners(30) - MIN_LIST - dividers = 68.
  expect(dividerColumns(inspector)).toEqual([30, 61])
  expect(panels(inspector)).toEqual({ owners: 30, inspector: 68 })
})

test("double-clicking a divider resets that panel to its default", async () => {
  await using fixture = await open()
  await fixture.mockMouse.drag(30, 3, 40, 3)
  await fixture.flush()
  await fixture.mockMouse.doubleClick(41, 3)
  await fixture.flush()
  expect(dividerColumns(fixture)).toEqual([30, 89])
  expect(panels(fixture)).toEqual({ owners: OWNERS_DEFAULT, inspector: 40 })
  await fixture.mockMouse.drag(89, 3, 99, 3)
  await fixture.flush()
  expect(dividerColumns(fixture)).toEqual([30, 99])
  await fixture.mockMouse.doubleClick(99, 3)
  await fixture.flush()
  // The inspector's reset is the 2/5 default for the current Owners width.
  expect(dividerColumns(fixture)).toEqual([30, 89])
  expect(panels(fixture)).toEqual({ owners: 30, inspector: defaultInspector(130, 30) })
})

test("widths persist across a route remount and come from storage.store, not memory", async () => {
  const cells = new Map<string, unknown>()
  {
    await using first = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45, storage: cells })
    await first.waitForFrame((frame) => frame.includes("esc close"))
    await first.mockMouse.drag(30, 3, 40, 3)
    await first.flush()
    await first.mockMouse.drag(89, 3, 99, 3)
    await first.flush()
    expect(first.storeValue(PANELS_STORAGE_KEY)).toEqual({ owners: 41, inspector: 30 })
    // The durable key never goes through storage.memory.
    expect(first.memoryValue(PANELS_STORAGE_KEY)).toBeUndefined()
    expect(first.memoryKeys()).not.toContain(PANELS_STORAGE_KEY)
  }
  await using restarted = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45, storage: cells })
  await restarted.waitForFrame((frame) => frame.includes("esc close"))
  expect(dividerColumns(restarted)).toEqual([41, 99])
  // A narrower terminal re-clamps the saved pair without overwriting it.
  restarted.resize(110, 40)
  await restarted.waitForFrame((frame) => frame.includes("esc close"))
  // The saved inspector 30 still fits; the list absorbs the missing columns.
  expect(dividerColumns(restarted)).toEqual([41, 79])
  expect(restarted.storeValue(PANELS_STORAGE_KEY)).toEqual({ owners: 41, inspector: 30 })
})

test("W enters the resize mode, steps, cycles and Enter saves the pair", async () => {
  await using fixture = await open()
  const theme = createTestTheme()
  const crumb = breadcrumb(fixture.captureCharFrame())
  expect(dispatch(fixture, "shift+w")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 30 cols"))
  expect(footer(fixture.captureCharFrame())).toContain("enter/esc save")
  // The selected divider carries the action highlight, the other stays idle.
  expect(highlightedDividers(fixture, theme.background.action.primary.hovered)).toEqual([30])
  expect(highlightedDividers(fixture, theme.background.raised.high)).toEqual([])
  // Browse commands do not fire inside the mode.
  expect(dispatch(fixture, "down")).toBe(false)
  expect(dispatch(fixture, "shift+e")).toBe(false)
  expect(dispatch(fixture, "n")).toBe(false)
  expect(selectedRow(fixture.captureCharFrame())).toContain("build")
  // Left / [ narrow by one; Right / ] widen by one.
  expect(dispatch(fixture, "[")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 29 cols"))
  expect(highlightedDividers(fixture, theme.background.action.primary.hovered)).toEqual([29])
  expect(highlightedDividers(fixture, theme.background.raised.high)).toEqual([])
  expect(dispatch(fixture, "right")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 30 cols"))
  // Tab / Shift+Tab cycle to the Inspector, without changing the level.
  expect(dispatch(fixture, "tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Inspector 40 cols"))
  expect(highlightedDividers(fixture, theme.background.action.primary.hovered)).toEqual([89])
  expect(highlightedDividers(fixture, theme.background.raised.high)).toEqual([])
  expect(breadcrumb(fixture.captureCharFrame())).toBe(crumb)
  expect(dispatch(fixture, "shift+tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 30 cols"))
  expect(dispatch(fixture, "]")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 31 cols"))
  expect(dispatch(fixture, "return")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("esc close"))
  expect(panels(fixture)).toEqual({ owners: 31, inspector: 40 })
  expect(dividerColumns(fixture)).toEqual([31, 89])
  expect(selectedRow(fixture.captureCharFrame())).toContain("build")
  expect(breadcrumb(fixture.captureCharFrame())).toBe(crumb)
})

test("alt+W enters, Escape commits the draft, and alt+W toggles out", async () => {
  await using fixture = await open()
  expect(dispatch(fixture, "alt+w")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 30 cols"))
  expect(dispatch(fixture, "]")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 31 cols"))
  expect(dispatch(fixture, "escape")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("esc close"))
  expect(panels(fixture)).toEqual({ owners: 31, inspector: 40 })
  expect(dividerColumns(fixture)).toEqual([31, 89])
  // Re-enter on the Inspector and leave through the toggle key.
  expect(dispatch(fixture, "alt+w")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 31 cols"))
  expect(dispatch(fixture, "tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Inspector 40 cols"))
  expect(dispatch(fixture, "[")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Inspector 39 cols"))
  expect(dispatch(fixture, "shift+w")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("esc close"))
  expect(panels(fixture)).toEqual({ owners: 31, inspector: 39 })
  expect(dividerColumns(fixture)).toEqual([31, 90])
})

test("keyboard clamps stop at the list minimum", async () => {
  await using fixture = await open()
  expect(dispatch(fixture, "shift+w")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 30 cols"))
  for (let step = 0; step < 80; step++) dispatch(fixture, "]")
  await fixture.waitForFrame((frame) => footer(frame).includes(`W Owners ${130 - 40 - MIN_LIST - DIVIDERS} cols`))
  expect(dispatch(fixture, "return")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("esc close"))
  expect(panels(fixture)).toEqual({ owners: 58, inspector: 40 })
  expect(dividerColumns(fixture)).toEqual([58, 89])
  await using inspector = await open()
  expect(dispatch(inspector, "shift+w")).toBe(true)
  await inspector.waitForFrame((frame) => footer(frame).includes("W Owners 30 cols"))
  expect(dispatch(inspector, "tab")).toBe(true)
  await inspector.waitForFrame((frame) => footer(frame).includes("W Inspector 40 cols"))
  for (let step = 0; step < 80; step++) dispatch(inspector, "]")
  await inspector.waitForFrame((frame) => footer(frame).includes(`W Inspector ${130 - 30 - MIN_LIST - DIVIDERS} cols`))
  expect(dispatch(inspector, "return")).toBe(true)
  await inspector.waitForFrame((frame) => footer(frame).includes("esc close"))
  expect(panels(inspector)).toEqual({ owners: 30, inspector: 68 })
  expect(dividerColumns(inspector)).toEqual([30, 61])
})

test("narrow mode refuses the mode and has no dividers; narrowing while resizing auto-saves and exits", async () => {
  await using narrow = await open(100, 40)
  expect(dividerColumns(narrow)).toEqual([])
  expect(dispatch(narrow, "shift+w")).toBe(false)
  expect(dispatch(narrow, "alt+w")).toBe(false)
  expect(footer(narrow.captureCharFrame())).not.toContain("cols")
  await using fixture = await open()
  expect(dispatch(fixture, "shift+w")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 30 cols"))
  for (let step = 0; step < 4; step++) dispatch(fixture, "]")
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 34 cols"))
  fixture.resize(100, 40)
  await fixture.waitForFrame((frame) => footer(frame).includes("esc close"))
  expect(panels(fixture)).toEqual({ owners: 34, inspector: 40 })
  // The saved widths return when the terminal is wide again.
  fixture.resize(130, 45)
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  expect(dividerColumns(fixture)).toEqual([34, 89])
})

test("the category tab digits follow the real effective list width", async () => {
  await using fixture = await open(200, 45)
  // Defaults: Owners 30, Inspector 68, list 100 — the digits fit.
  expect(dividerColumns(fixture)).toEqual([30, 131])
  expect(fixture.captureCharFrame()).toContain("1 Settings")
  expect(dispatch(fixture, "shift+w")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 30 cols"))
  for (let step = 0; step < 100; step++) dispatch(fixture, "]")
  await fixture.waitForFrame((frame) => footer(frame).includes(`W Owners ${200 - 68 - MIN_LIST - DIVIDERS} cols`))
  expect(dispatch(fixture, "return")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("esc close"))
  // Owners 100 leaves the list exactly MIN_LIST: the digits drop.
  expect(dividerColumns(fixture)).toEqual([100, 131])
  const frame = fixture.captureCharFrame()
  expect(frame).toContain("Settings")
  expect(frame).not.toContain("1 Settings")
})

test("resize mode coexists with Tab/Shift+Tab levels and E / ctrl+E", async () => {
  await using fixture = await open()
  await reach(fixture, "item:project:build:tool:bash", "bash")
  // Browse: E excludes the active row, ctrl+E includes it.
  expect(fixture.captureCharFrame()).toContain("▸ ● bash")
  expect(dispatch(fixture, "shift+e")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("▾ ● read"))
  expect(fixture.captureCharFrame()).toContain("▸ ● bash")
  expect(dispatch(fixture, "ctrl+e")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("▾ ● bash"))
  // Tab switches the pane, Shift+Tab the level.
  expect(dispatch(fixture, "tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("tab list"))
  expect(dispatch(fixture, "shift+tab")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Global"))
  expect(dispatch(fixture, "shift+tab")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Defaults"))
  // Resize: Tab cycles panels, Shift+Tab is not a level key and E does nothing.
  expect(dispatch(fixture, "shift+w")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Owners 30 cols"))
  const level = breadcrumb(fixture.captureCharFrame())
  expect(dispatch(fixture, "shift+tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("W Inspector 40 cols"))
  expect(breadcrumb(fixture.captureCharFrame())).toBe(level)
  expect(dispatch(fixture, "shift+e")).toBe(false)
  expect(dispatch(fixture, "ctrl+e")).toBe(false)
  expect(dispatch(fixture, "escape")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("esc close"))
  // The browse meanings are back after the commit.
  expect(dispatch(fixture, "shift+tab")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Presets"))
})

test("a commit persists without toasts and the widths survive an idle render", async () => {
  await using fixture = await open()
  await fixture.mockMouse.drag(30, 3, 44, 3)
  await sleep(30)
  expect(dividerColumns(fixture)).toEqual([45, 89])
  expect(panels(fixture)).toEqual({ owners: 45, inspector: 40 })
  expect(fixture.fake.toasts).toEqual([])
})