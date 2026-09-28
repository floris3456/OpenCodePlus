// Navigation helpers for the workspace Instructions screen
// (docs/instructions-redesign.md): level tabs, a sidebar of owners, category
// tabs and a list. Tests reach a row the way a user does: the live filter
// with its id, then enter ("go to"), which opens the owner, the category and
// the rows above it and leaves the cursor on the row.
import { CURSOR } from "../src/tui/instructions/row.js"
import type { TestFixture } from "./tui.js"

export function dispatch(fixture: TestFixture, key: string): boolean {
  for (const command of fixture.commands()) {
    if (typeof command.bind === "string" && command.bind.split(",").includes(key)) {
      void command.run()
      return true
    }
  }
  return false
}

export function binds(fixture: TestFixture): string[] {
  return fixture.commands().map((command) => command.bind as string)
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The focused pane's cursor row: the text after the cursor `▌` up to that
 * pane's right divider (the sidebar divider for a nav row, the inspector
 * divider for a list row). In narrow mode there is no divider and the whole
 * rest of the line is returned.
 */
export function selectedRow(frame: string): string {
  const line = frame.split("\n").find((entry) => entry.includes(CURSOR)) ?? ""
  const rest = line.slice(line.indexOf(CURSOR) + 1)
  return rest.split("│")[0] ?? ""
}

/** The breadcrumb line under the level tabs. */
export function breadcrumb(frame: string): string {
  return frame.split("\n")[1] ?? ""
}

/** The footer: the last non-empty line. */
export function footer(frame: string): string {
  return frame.split("\n").filter((line) => line.trim().length > 0).at(-1) ?? ""
}

const LEVEL_LABELS: Record<string, string> = { project: "Project", global: "Global", defaults: "Defaults", preset: "Presets" }

export function levelOf(id: string): string {
  return id.split(":")[1] ?? "project"
}

/** Switch the level tab with < and > until the breadcrumb starts with it. */
export async function gotoLevel(fixture: TestFixture, level: string): Promise<void> {
  const label = LEVEL_LABELS[level] ?? level
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  for (let step = 0; step < 4; step++) {
    if (breadcrumb(fixture.captureCharFrame()).trimStart().startsWith(label)) return
    const before = breadcrumb(fixture.captureCharFrame())
    dispatch(fixture, ">")
    await fixture.waitForFrame((frame) => breadcrumb(frame) !== before)
  }
  if (!breadcrumb(fixture.captureCharFrame()).trimStart().startsWith(label)) throw new Error(`never reached level ${label}`)
}

/** Esc out of the list and any open filter, back to the sidebar. */
export async function toSidebar(fixture: TestFixture): Promise<void> {
  for (let step = 0; step < 3; step++) {
    const hint = footer(fixture.captureCharFrame())
    if (hint.includes("esc close")) return
    dispatch(fixture, "escape")
    await sleep(30)
  }
}

/**
 * Put the cursor on the row with this tree id: filter by `id:<id>` at the
 * row's level, then go to it. `label` (default: the id's last segment) is what
 * the selected row must show afterwards.
 */
export async function reach(fixture: TestFixture, id: string, label?: string): Promise<void> {
  await gotoLevel(fixture, levelOf(id))
  await toSidebar(fixture)
  if (!dispatch(fixture, "/")) throw new Error("no filter key")
  // The input takes focus once it is on screen; typing earlier is lost.
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  const query = `id:${id}`
  await fixture.typeText(query)
  // A long query scrolls inside the input: its end is what shows.
  await fixture.waitForFrame((frame) => frame.includes(query.slice(-24)))
  // Let the debounced filter (150 ms) apply the whole query.
  await sleep(250)
  const want = label ?? id.split(":").at(-1) ?? id
  // Results replace the category list once the debounced filter applies.
  await fixture.waitForFrame((frame) => frame.includes("esc clear filter") && selectedRow(frame).includes(want))
  dispatch(fixture, "return")
  await fixture.waitForFrame((frame) => !frame.includes("esc clear filter") && selectedRow(frame).includes(want))
}

/**
 * Put the cursor inside a category's own list (a `group:…:settings|tools|…`
 * node): filter by the category id, then go to it. Unlike `reach`, the cursor
 * lands on the category's first row — or on the category itself when its list
 * is empty — so the label is checked on the breadcrumb, which names the
 * category either way.
 */
export async function reachCategory(fixture: TestFixture, id: string, label?: string): Promise<void> {
  await gotoLevel(fixture, levelOf(id))
  await toSidebar(fixture)
  if (!dispatch(fixture, "/")) throw new Error("no filter key")
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  const query = `id:${id}`
  await fixture.typeText(query)
  await fixture.waitForFrame((frame) => frame.includes(query.slice(-24)))
  await sleep(250)
  const want = label ?? id.split(":").at(-1) ?? id
  await fixture.waitForFrame((frame) => frame.includes("esc clear filter") && selectedRow(frame).includes(want))
  dispatch(fixture, "return")
  await fixture.waitForFrame((frame) => !frame.includes("esc clear filter") && breadcrumb(frame).includes(want))
}

/** Move the cursor down in the focused pane until the selected row shows `label`. */
export async function moveTo(fixture: TestFixture, label: string): Promise<void> {
  for (let step = 0; step < 80; step++) {
    const before = fixture.captureCharFrame()
    if (selectedRow(before).includes(label)) return
    dispatch(fixture, "down")
    await fixture.waitForFrame((frame) => selectedRow(frame) !== selectedRow(before))
  }
  throw new Error(`never reached row "${label}"`)
}

/** Open the selected row (▸ → ▾) when it is closed. */
export async function expand(fixture: TestFixture): Promise<void> {
  const row = selectedRow(fixture.captureCharFrame())
  if (!/^\s*▸/.test(row)) return
  dispatch(fixture, "right")
  await fixture.waitForFrame((frame) => /^\s*▾/.test(selectedRow(frame)))
}

/** Select a category tab of the shown owner by its label. */
export async function category(fixture: TestFixture, label: string): Promise<void> {
  if (footer(fixture.captureCharFrame()).includes("tab list")) {
    dispatch(fixture, "tab")
    await fixture.waitForFrame((frame) => footer(frame).includes("tab sidebar"))
  }
  const labels = ["Settings", "Models", "Compaction", "Tools", "Base", "Skills", "System", "MCP"]
  for (let step = 0; step < labels.length; step++) {
    if (breadcrumb(fixture.captureCharFrame()).includes(`› ${label}`)) return
    const before = breadcrumb(fixture.captureCharFrame())
    dispatch(fixture, "]")
    await fixture.waitForFrame((frame) => breadcrumb(frame) !== before)
  }
  throw new Error(`no category ${label}`)
}
