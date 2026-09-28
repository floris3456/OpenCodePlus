// Bulk row expansion (docs/instructions-workspace-followup.md §6): E toggles
// every expandable visible row of the hovered pane (else the focused pane)
// except the active row; ctrl+E includes it; any collapsed row expands all,
// otherwise all collapse; lowercase e stays the editor.
import { expect, test } from "bun:test"
import { fingerprint } from "../src/instructions/model.js"
import type { Snapshot } from "../src/rpc.js"
import { dispatch, footer, moveTo, reach, selectedRow, sleep } from "./instructions-nav.js"
import { createSnapshot, renderInstructionsRoute, type TestFixture } from "./tui.js"

const build = { id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const }

function tool(id: string, title: string, text: string) {
  return { id, kind: "tool" as const, group: "native" as const, title, text, enabled: true, fingerprint: fingerprint(text) }
}

function snapshot(): Snapshot {
  return createSnapshot({
    agents: [build],
    items: [tool("tool:bash", "bash", "run\n"), tool("tool:read", "read", "read\n")],
    teams: [{ level: "project", team: "crew", enabled: false, agents: ["CrewMate"] }],
  })
}

/** The expansion marker a row renders (the marker directly names the row). */
function rowState(frame: string, label: string): "expanded" | "collapsed" | "hidden" {
  const pattern = new RegExp(`[▸▾] (?:[●○] )?${label}(?=\\s|$)`)
  for (const [index, line] of frame.split("\n").entries()) {
    if (index < 2) continue
    if (pattern.test(line)) return line.includes(`▾ ${label}`) || line.includes(`▾ ● ${label}`) ? "expanded" : "collapsed"
  }
  return "hidden"
}

/** A hover point inside a pane's row carrying this label. */
function pointOf(fixture: TestFixture, pane: "nav" | "list", label: string): { readonly x: number; readonly y: number } {
  const lines = fixture.captureCharFrame().split("\n")
  const from = pane === "nav" ? 0 : 30
  const to = pane === "nav" ? 30 : 90
  const y = lines.findIndex((line, index) => index > 1 && line.slice(from, to).includes(label))
  if (y === -1) throw new Error(`no ${pane} row "${label}"`)
  return { x: lines[y]!.indexOf(label, from) + 1, y }
}

async function hover(fixture: TestFixture, pane: "nav" | "list", label: string): Promise<void> {
  const point = pointOf(fixture, pane, label)
  await fixture.mockMouse.moveTo(point.x, point.y)
  await fixture.flush()
}

test("E expands every other row and leaves the active one; ctrl+E includes it", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(rowState(fixture.captureCharFrame(), "bash")).toBe("collapsed")
  expect(rowState(fixture.captureCharFrame(), "read")).toBe("collapsed")
  expect(dispatch(fixture, "shift+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "read") === "expanded")
  const expandedOthers = fixture.captureCharFrame()
  // bash is the active row: excluded from both the decision and the change.
  expect(rowState(expandedOthers, "bash")).toBe("collapsed")
  expect(selectedRow(expandedOthers)).toContain("▸")
  expect(dispatch(fixture, "ctrl+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "bash") === "expanded")
  expect(rowState(fixture.captureCharFrame(), "read")).toBe("expanded")
})

test("a second ctrl+E collapses everything when all eligible rows are expanded", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(dispatch(fixture, "ctrl+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "bash") === "expanded")
  expect(dispatch(fixture, "ctrl+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "read") === "hidden" && frame.includes("▸ OpenCode"))
  expect(rowState(fixture.captureCharFrame(), "OpenCodePlus")).toBe("collapsed")
})

test("E on the focused sidebar collapses and re-expands its rows", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  expect(rowState(fixture.captureCharFrame(), "Agents")).toBe("expanded")
  expect(rowState(fixture.captureCharFrame(), "Teams")).toBe("expanded")
  // No hover: the focused pane is the sidebar, whose rows are all expanded.
  expect(dispatch(fixture, "shift+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "Agents") === "collapsed" && rowState(frame, "OpenCode") === "hidden")
  expect(rowState(fixture.captureCharFrame(), "Teams")).toBe("collapsed")
  // The bulk direction reads visible rows: Agents and Teams come back first,
  // then OpenCode (it is only visible again once Agents is open).
  expect(dispatch(fixture, "ctrl+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "Agents") === "expanded" && rowState(frame, "Teams") === "expanded")
  expect(rowState(fixture.captureCharFrame(), "OpenCode")).toBe("collapsed")
  expect(dispatch(fixture, "ctrl+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "OpenCode") === "expanded")
})

test("the hovered pane wins over the keyboard focus", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  // Collapse Teams in the sidebar, then give the list the keyboard focus.
  expect(dispatch(fixture, "tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("tab list"))
  await moveTo(fixture, "Teams")
  expect(dispatch(fixture, "left")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "Teams") === "collapsed")
  expect(dispatch(fixture, "tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("tab sidebar"))
  // Hovering Agents targets the sidebar, not the focused list: the collapsed
  // Teams expands back and the list's collapsed rows stay collapsed.
  await hover(fixture, "nav", "Agents")
  expect(dispatch(fixture, "shift+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "Teams") === "expanded")
  const frame = fixture.captureCharFrame()
  expect(rowState(frame, "bash")).toBe("collapsed")
  expect(rowState(frame, "read")).toBe("collapsed")
  expect(rowState(frame, "Agents")).toBe("expanded")
})

test("a hovered list row wins while the sidebar has the keyboard focus", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(dispatch(fixture, "tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("tab list"))
  // Hovering a list row retargets E: bash expands, read (active) stays closed,
  // and the sidebar is untouched.
  await hover(fixture, "list", "read")
  expect(dispatch(fixture, "shift+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "bash") === "expanded")
  const frame = fixture.captureCharFrame()
  expect(rowState(frame, "read")).toBe("collapsed")
  expect(rowState(frame, "Agents")).toBe("expanded")
  expect(rowState(frame, "OpenCode")).toBe("expanded")
})

test("lowercase e still opens the editor and expands nothing", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(dispatch(fixture, "e")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
  expect(dispatch(fixture, "escape")).toBe(true)
  await fixture.waitForFrame((frame) => !frame.includes("ctrl+s save"))
  const frame = fixture.captureCharFrame()
  expect(rowState(frame, "bash")).toBe("collapsed")
  expect(rowState(frame, "read")).toBe("collapsed")
})

test("bulk expansion works on the narrow list page", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 80, height: 40 })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(dispatch(fixture, "shift+e")).toBe(true)
  await fixture.waitForFrame((frame) => rowState(frame, "read") === "expanded")
  expect(selectedRow(fixture.captureCharFrame())).toContain("▸")
})

test("E with nothing eligible is a silent no-op", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [createSnapshot()], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  const before = fixture.captureCharFrame()
  expect(dispatch(fixture, "shift+e")).toBe(true)
  expect(dispatch(fixture, "ctrl+e")).toBe(true)
  await sleep(50)
  expect(fixture.captureCharFrame()).toBe(before)
})