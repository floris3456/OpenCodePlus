// Shared pieces of the Instructions route tests (route*.test.tsx).
import { expect, test } from "bun:test"
import { fingerprint } from "../src/instructions/model.js"
import { load, save } from "../src/instructions/store.js"
import type { PresetRef, Snapshot } from "../src/rpc.js"
import { createSnapshot } from "./tui.js"
import type { TestFixture } from "./tui.js"
import { category, dispatch, expand, footer, gotoLevel, levelOf, moveTo, reach, selectedRow, sleep, toSidebar } from "./instructions-nav.js"

// reach() as a user does it (filter by id, enter goes to the row), with two
// differences: `id:` matches by prefix (team:project:crew also matches its
// members), so the negated `<id>:` prefix keeps exactly the row itself; and
// the Presets level's full tree can take longer to filter than
// waitForFrame's 20 passes.
export async function goto(fixture: TestFixture, id: string, label: string): Promise<void> {
  await gotoLevel(fixture, levelOf(id))
  await toSidebar(fixture)
  if (!dispatch(fixture, "/")) throw new Error("no filter key")
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  const query = `id:${id} !id:${id}:`
  await fixture.typeText(query)
  await until(fixture, (frame) => frame.includes(query.slice(-24)))
  // Let the debounced filter (150 ms) apply the whole query.
  await sleep(250)
  await until(fixture, (frame) => footer(frame).includes("esc clear filter") && selectedRow(frame).includes(label))
  dispatch(fixture, "return")
  await until(fixture, (frame) => !footer(frame).includes("esc clear filter") && selectedRow(frame).includes(label))
}

// Open the selected item row and the Description group its sections may
// hang under, until the section row `label` shows in the list.
export async function showSection(fixture: TestFixture, label: string): Promise<void> {
  await expand(fixture)
  await sleep(50)
  if (!listPane(fixture.captureCharFrame()).includes(label) && /▸.*Description/.test(listPane(fixture.captureCharFrame()))) {
    await moveTo(fixture, "Description")
    await expand(fixture)
  }
  await fixture.waitForFrame((frame) => listPane(frame).includes(label))
}

// Type into the live filter of the current level and let it apply.
export async function filter(fixture: TestFixture, text: string): Promise<void> {
  await toSidebar(fixture)
  expect(dispatch(fixture, "/")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  await fixture.typeText(text)
  await fixture.waitForFrame((frame) => frame.includes(`/ ${text}`))
  await sleep(250)
}

// The filter lands on its first leaf match (often a section below the item
// the words name): walk up to the first result, then down to `label`.
export async function moveToResult(fixture: TestFixture, label: string): Promise<void> {
  for (let step = 0; step < 40; step++) {
    const before = selectedRow(fixture.captureCharFrame())
    dispatch(fixture, "up")
    // Long enough for the move to render: a stale frame would stop the
    // walk early or leave moveTo comparing against an old row.
    await sleep(80)
    if (selectedRow(fixture.captureCharFrame()) === before) break
  }
  await moveTo(fixture, label)
}

// waitForFrame gives up after 20 render passes; a create flow's refresh
// through the real handlers can take longer before its row shows.
export async function until(fixture: TestFixture, predicate: (frame: string) => boolean, timeout = 4000): Promise<string> {
  for (let waited = 0; waited < timeout; waited += 50) {
    const frame = fixture.captureCharFrame()
    if (predicate(frame)) return frame
    await sleep(50)
  }
  return fixture.waitForFrame(predicate)
}

export const SIDEBAR = 30

// The cursor row of the sidebar alone: on a wide frame the same line also
// carries the list (the owner's name, its category tabs).
export function sidebarRow(frame: string): string {
  return selectedRow(frame).slice(0, SIDEBAR - 1)
}

// moveTo for the sidebar: Down until the sidebar's cursor row shows `label`.
export async function navTo(fixture: TestFixture, label: string): Promise<void> {
  for (let step = 0; step < 80; step++) {
    const before = fixture.captureCharFrame()
    if (sidebarRow(before).includes(label)) return
    dispatch(fixture, "down")
    await fixture.waitForFrame((frame) => sidebarRow(frame) !== sidebarRow(before))
  }
  throw new Error(`never reached sidebar row "${label}"`)
}

// The list column of a wide frame: between the two divider pipes.
export function listPane(frame: string): string {
  return frame
    .split("\n")
    .slice(2)
    .map((line) => {
      const owners = line.indexOf("│")
      if (owners === -1) return line.slice(SIDEBAR)
      const inspector = line.indexOf("│", owners + 1)
      return inspector === -1 ? line.slice(owners + 1) : line.slice(owners + 1, inspector)
    })
    .join("\n")
}

// The inspector's text without whitespace, so a fact reads the same however
// the pane wraps it; compare with flat(text).
export function inspector(frame: string): string {
  return flat(
    frame
      .split("\n")
      .slice(2)
      .flatMap((line) => {
        const owners = line.indexOf("│", SIDEBAR)
        if (owners === -1) return []
        const at = line.indexOf("│", owners + 1)
        return at === -1 ? [] : [line.slice(at + 1)]
      })
      .join(""),
  )
}

export function flat(text: string): string {
  return text.replace(/\s+/g, "")
}

export function mcpItem(overrides?: Record<string, unknown>) {
  return {
    id: "mcp:sample",
    kind: "mcp" as const,
    group: "none" as const,
    title: "sample",
    text: "sample-config",
    enabled: true,
    fingerprint: "fp-sample",
    ...overrides,
  }
}

export function toolItem(overrides?: Record<string, unknown>) {
  return {
    id: "tool:bash",
    kind: "tool" as const,
    group: "native" as const,
    title: "bash",
    text: "run commands",
    enabled: true,
    fingerprint: "fp-bash",
    ...overrides,
  }
}

export function projectAgent(id: string, origin: "native" | "special" | "plus" | "user" = "user") {
  return { id, scope: "project" as const, fileBacked: true, origin }
}

export function reviewSnapshot(): Snapshot {
  return createSnapshot({
    items: [mcpItem({ text: "new-upstream" })],
    records: [
      {
        type: "customization" as const,
        level: "defaults" as const,
        agent: null,
        item: "mcp:sample",
        section: null,
        text: "mine",
        basedOn: "fp-old",
        basedOnText: "old-upstream",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
}

// Defaults › Every agent › MCP › the server's item.
export async function gotoMcpItem(fixture: TestFixture): Promise<void> {
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  await goto(fixture, "item:defaults::mcp:sample", "sample")
}

// A clean merge: mine appended a line, upstream changed another line with a
// gap between them, so the Take result applies both.
export function mergeSnapshot(): Snapshot {
  return createSnapshot({
    items: [
      mcpItem({
        text: "one\ntwo upstream\nthree\nfour\n",
        fingerprint: fingerprint("one\ntwo upstream\nthree\nfour\n"),
      }),
    ],
    records: [
      {
        type: "customization" as const,
        level: "defaults" as const,
        agent: null,
        item: "mcp:sample",
        section: null,
        text: "one\ntwo\nthree\nfour\ncustom tail\n",
        basedOn: "fp-old",
        basedOnText: "one\ntwo\nthree\nfour\n",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
}

// A fast-forward: mine equals the original, so the merge is exactly the new
// upstream and t can only drop the override.
export function fastForwardSnapshot(): Snapshot {
  return createSnapshot({
    items: [mcpItem({ text: "one\ntwo upstream\n", fingerprint: fingerprint("one\ntwo upstream\n") })],
    records: [
      {
        type: "customization" as const,
        level: "defaults" as const,
        agent: null,
        item: "mcp:sample",
        section: null,
        text: "one\ntwo\n",
        basedOn: "fp-old",
        basedOnText: "one\ntwo\n",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
}

// DESIGN §3.3: a user agent's shared rows fall back to off unless a preset
// sets them. Implementer stands for an agent created from the Native `build`
// preset, so its Code Mode row keeps its native "on".
export function codemodeSnapshot(): Snapshot {
  return createSnapshot({
    agents: [projectAgent("Implementer")],
    links: [{ type: "link", level: "project", agent: "Implementer", preset: { kind: "agent", id: "build" }, updated: "2026-09-14T00:00:00.000Z" }],
    items: [
      {
        id: "tool:coder",
        kind: "tool" as const,
        group: "native" as const,
        title: "coder",
        text: "# Alpha\n\na\n\n# Beta\n\nb\n",
        enabled: true,
        fingerprint: "fp-coder",
        codemode: true,
      },
    ],
  })
}

// DESIGN §3.3: a user agent's shared rows fall back to off unless a preset
// sets them. alpha (no agent file, so addressed at Defaults) stands for an
// agent created from the Native `build` preset, so publishing installs nothing
// for rows the test does not touch.
export async function linkAlphaToBuild(project: string): Promise<void> {
  const loaded = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: [
      ...loaded.records,
      { type: "link", level: "defaults", agent: "alpha", preset: { kind: "agent", id: "build" }, updated: "2026-01-01T00:00:00.000Z" },
    ],
  })
  if (!saved.ok) throw new Error("link save was stale")
}

export const PRESET_UPDATED = "2026-09-25T00:00:00.000Z"

export function linkTo(agent: string, preset: PresetRef, level: "project" | "global" = "project") {
  return { type: "link" as const, level, agent, preset, updated: PRESET_UPDATED }
}

export const basicOrchestrator: PresetRef = { kind: "member", team: "basic", id: "orchestrator" }
export const basicPlanner: PresetRef = { kind: "member", team: "basic", id: "planner" }

export function bashItem() {
  return toolItem({ id: "tool:bash", title: "bash" })
}

export function reviewedBash(overrides?: Record<string, unknown>) {
  return {
    type: "customization" as const,
    level: "project" as const,
    agent: "alice",
    item: "tool:bash",
    section: null,
    state: "off" as const,
    basedOnState: "off" as const,
    basedOn: "",
    updated: PRESET_UPDATED,
    ...overrides,
  }
}

export async function gotoBash(fixture: TestFixture): Promise<void> {
  await goto(fixture, "item:project:alice:tool:bash", "bash")
}
