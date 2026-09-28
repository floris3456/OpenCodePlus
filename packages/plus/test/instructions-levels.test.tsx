// Level navigation (docs/instructions-workspace-followup.md §3.1, §4):
// shift+tab and the terminal aliases of shift+arrows / shift+brackets /
// shift+digits switch levels; < > and the mouse tabs keep working; the place
// (owner, category, row) and the expansions survive a level switch where the
// destination has the node; Presets keep their own selection.
import { expect, test } from "bun:test"
import { fingerprint } from "../src/instructions/model.js"
import type { Snapshot } from "../src/rpc.js"
import { breadcrumb, dispatch, footer, gotoLevel, moveTo, reach, selectedRow } from "./instructions-nav.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"

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

const LEVEL_ORDER = ["Project", "Global", "Defaults", "Presets"]

test("shift+tab moves to the next level and wraps; tab still switches pane", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  expect(breadcrumb(fixture.captureCharFrame()).trimStart().startsWith("Project")).toBe(true)
  for (const label of LEVEL_ORDER.slice(1).concat("Project")) {
    expect(dispatch(fixture, "shift+tab")).toBe(true)
    await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith(label))
  }
  // tab is untouched: it still toggles the pane, and shift+tab does not.
  expect(footer(fixture.captureCharFrame())).toContain("tab list")
  expect(dispatch(fixture, "tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("tab sidebar"))
  expect(dispatch(fixture, "shift+tab")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Global"))
  expect(footer(fixture.captureCharFrame())).toContain("tab sidebar")
})

test("every previous/next alias switches the level", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  for (const key of ["shift+left", "shift+[", "{", "shift+{"]) {
    await gotoLevel(fixture, "global")
    expect(dispatch(fixture, key)).toBe(true)
    await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Project"))
  }
  for (const key of ["shift+right", "shift+]", "}", "shift+}"]) {
    await gotoLevel(fixture, "global")
    expect(dispatch(fixture, key)).toBe(true)
    await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Defaults"))
  }
})

test("shift+1..4 and their shifted glyphs jump straight to a level", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  const aliases: readonly (readonly [string, string])[] = [
    ["shift+1", "Project"],
    ["!", "Project"],
    ["shift+!", "Project"],
    ["shift+2", "Global"],
    ["@", "Global"],
    ["shift+@", "Global"],
    ["shift+3", "Defaults"],
    ["#", "Defaults"],
    ["shift+#", "Defaults"],
    ["shift+4", "Presets"],
    ["$", "Presets"],
    ["shift+$", "Presets"],
  ]
  for (const [key, label] of aliases) {
    await gotoLevel(fixture, "global")
    expect(dispatch(fixture, key)).toBe(true)
    await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith(label))
  }
})

test("< and > still switch levels both ways", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  expect(dispatch(fixture, ">")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Global"))
  expect(dispatch(fixture, "<")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Project"))
})

test("the owner, category, row and expansions survive a level switch", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(dispatch(fixture, "right")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("Description") && selectedRow(frame).includes("bash"))
  // Collapse the Teams catalogue in the sidebar too (the selected owner build
// stays visible, so the list keeps its place).
  expect(dispatch(fixture, "tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("tab list"))
  expect(dispatch(fixture, "home")).toBe(true)
  await fixture.waitForFrame((frame) => selectedRow(frame).includes("Agents"))
  await moveTo(fixture, "Teams")
  expect(dispatch(fixture, "left")).toBe(true)
  await fixture.waitForFrame((frame) => sidebar(frame).includes("▸ Teams"))
  expect(dispatch(fixture, "tab")).toBe(true)
  await fixture.waitForFrame((frame) => footer(frame).includes("tab sidebar"))
  // One level over: same owner, category, row and expansions (bash open,
  // Teams collapsed); the same back at Project.
  expect(dispatch(fixture, ">")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Global"))
  const global = fixture.captureCharFrame()
  expect(breadcrumb(global)).toContain("Global › Agents › OpenCode › build › Tools › OpenCode › bash")
  expect(global).toContain("Description")
  expect(selectedRow(global)).toContain("bash")
  expect(sidebar(global)).toContain("▸ Teams")
  expect(dispatch(fixture, "<")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Project"))
  expect(fixture.captureCharFrame()).toContain("Description")
  expect(sidebar(fixture.captureCharFrame())).toContain("▸ Teams")
})

test("Presets keep their deliberate separate selection on a level switch", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(dispatch(fixture, "shift+4")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Presets"))
  const view = fixture.memoryValue("opencode.plus.instructions.view") as {
    readonly view?: { readonly owner?: Record<string, string | undefined> }
  }
  // The owner and row stayed at Project; nothing was mapped onto Presets.
  expect(view.view?.owner?.project).toBe("agent:project:build")
  expect(view.view?.owner?.preset).toBeUndefined()
})

test("a mouse click on a level tab still switches the level", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  const line = fixture.captureCharFrame().split("\n")[0] ?? ""
  const column = line.indexOf("Global")
  expect(column).toBeGreaterThanOrEqual(0)
  await fixture.mockMouse.click(column + 1, 0)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Global"))
})

test("level keys work at narrow width", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 80, height: 40 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  expect(dispatch(fixture, "shift+tab")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Global"))
  expect(dispatch(fixture, "shift+left")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Project"))
  expect(dispatch(fixture, "shift+3")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Defaults"))
  expect(dispatch(fixture, ">")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Presets"))
  expect(dispatch(fixture, "!")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Project"))
})

test("level keys are absent while the filter or an editor owns input", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [snapshot()], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  expect(dispatch(fixture, "/")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("esc clear filter"))
  expect(dispatch(fixture, "shift+tab")).toBe(false)
  expect(dispatch(fixture, "shift+1")).toBe(false)
  expect(dispatch(fixture, "shift+e")).toBe(false)
  expect(dispatch(fixture, "escape")).toBe(true)
  await fixture.waitForFrame((frame) => !frame.includes("esc clear filter"))
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(dispatch(fixture, "e")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
  expect(dispatch(fixture, "shift+tab")).toBe(false)
  expect(dispatch(fixture, "ctrl+e")).toBe(false)
})

/** The sidebar's own columns (the list and inspector start further right). */
function sidebar(frame: string): string {
  return frame
    .split("\n")
    .map((line) => line.slice(0, 30))
    .join("\n")
}