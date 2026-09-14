import { expect, test } from "bun:test"
import type { Snapshot } from "../src/rpc.js"
import { createSnapshot, renderInstructionsRoute, type TestFixture } from "./tui.js"

function send(fixture: TestFixture, key: string): boolean {
  if (key === "escape") return sendEscape(fixture)
  for (const cmd of fixture.commands()) {
    if (typeof cmd.bind === "string" && cmd.bind.split(",").includes(key)) {
      void cmd.run()
      return true
    }
  }
  return false
}

// Real-engine escape dispatch for the Instructions route. @opentui/keymap runs
// exactly one binding per press: highest layer priority first, then newest
// registration (getSortedLayers in @opentui/keymap sorts priority desc, order
// desc; dispatchFromRootAtIndex stops at the first handled binding because no
// Plus binding sets fallthrough). Every Plus layer is default priority except
// the route help layer (route.tsx `priority: 1`, mirroring the dialog escape
// precedent in packages/tui/src/ui/dialog-prompt.tsx), so a "Close help"
// escape always wins while help is open; otherwise the first escape in
// commands() order (newest layer first, matching the test fixture's
// reverse-registration flattening) wins.
function sendEscape(fixture: TestFixture): boolean {
  const escapes = fixture
    .commands()
    .filter((cmd) => typeof cmd.bind === "string" && cmd.bind.split(",").includes("escape"))
  const winner = escapes.find((cmd) => cmd.title === "Close help") ?? escapes[0]
  if (!winner) return false
  void winner.run()
  return true
}

function escapeTitles(fixture: TestFixture): (string | undefined)[] {
  return fixture
    .commands()
    .filter((cmd) => typeof cmd.bind === "string" && cmd.bind.split(",").includes("escape"))
    .map((cmd) => cmd.title)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function moveDown(fixture: TestFixture, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    send(fixture, "down")
    await sleep(20)
  }
}

function mcpItem(overrides?: Record<string, unknown>) {
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

function reviewSnapshot(): Snapshot {
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

async function gotoSampleRow(fixture: TestFixture): Promise<void> {
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  await moveDown(fixture, 8)
  send(fixture, "right")
  await sleep(50)
  await moveDown(fixture, 1)
  await fixture.waitForFrame((frame) => frame.includes("sample"))
}

test("escape on a plain tree closes the route", async () => {
  let closed = 0
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    expect(escapeTitles(fixture)).toEqual(["Back"])
    expect(send(fixture, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("help takes one escape, a second escape closes the route", async () => {
  let closed = 0
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    expect(send(fixture, "?")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("space toggle include/exclude"))
    expect(escapeTitles(fixture)).toEqual(["Close help"])
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame(
      (frame) => frame.includes("arrows move") && !frame.includes("space toggle include/exclude"),
    )
    expect(closed).toBe(0)
    expect(send(fixture, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("help over detail editing unwinds help first, then editing, then the route", async () => {
  let closed = 0
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ items: [mcpItem()] })],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await gotoSampleRow(fixture)
    expect(send(fixture, "return")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    // "?" stays reachable while editing, so help can float above the editor.
    expect(send(fixture, "?")).toBe(true)
    await fixture.waitForFrame(
      (frame) => frame.includes("space toggle include/exclude") && frame.includes("ctrl+s save"),
    )
    // Both layers stack an escape; the help layer must win the first press.
    expect(escapeTitles(fixture).sort()).toEqual(["Cancel editing", "Close help"])
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame(
      (frame) => !frame.includes("space toggle include/exclude") && frame.includes("ctrl+s save"),
    )
    expect(closed).toBe(0)
    // Second press cancels editing without closing the route.
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame((frame) => !frame.includes("ctrl+s save"))
    expect(closed).toBe(0)
    // Third press closes the route from the plain wide tree.
    expect(send(fixture, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("diff editing unwinds one level per press: edit, then mode, then route", async () => {
  let closed = 0
  const fixture = await renderInstructionsRoute({
    snapshots: [reviewSnapshot()],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await gotoSampleRow(fixture)
    await fixture.waitForFrame((frame) => frame.includes("review"))
    expect(send(fixture, "return")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Original upstream"))
    expect(send(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(escapeTitles(fixture).sort()).toEqual(["Back to tree", "Cancel editing"])
    // First press cancels the edit but stays in diff mode.
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame(
      (frame) => frame.includes("Original upstream") && !frame.includes("ctrl+s save"),
    )
    expect(closed).toBe(0)
    // Second press leaves diff mode without closing the route.
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame(
      (frame) => frame.includes("arrows move") && !frame.includes("Original upstream"),
    )
    expect(closed).toBe(0)
    // Third press closes the route from the plain tree.
    expect(send(fixture, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("split naming unwinds one level per press: naming, then mode, then route", async () => {
  const text = "Purpose tells when.\n\nQuoting details here.\n"
  let closed = 0
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ items: [mcpItem({ text })] })],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await gotoSampleRow(fixture)
    expect(send(fixture, "s")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("split into sections"))
    expect(send(fixture, "b")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Name section"))
    expect(escapeTitles(fixture).sort()).toEqual(["Back to tree", "Cancel naming"])
    // First press cancels naming but stays in split mode.
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame(
      (frame) => frame.includes("split into sections") && !frame.includes("Name section"),
    )
    expect(closed).toBe(0)
    // Second press leaves split mode without closing the route.
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame(
      (frame) => frame.includes("arrows move") && !frame.includes("split into sections"),
    )
    expect(closed).toBe(0)
    // Third press closes the route from the plain tree.
    expect(send(fixture, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("narrow detail editing unwinds one level per press: editing, detail, route", async () => {
  let closed = 0
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ items: [mcpItem()] })],
    width: 80,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await gotoSampleRow(fixture)
    expect(send(fixture, "right")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("back to tree"))
    expect(send(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(escapeTitles(fixture).sort()).toEqual(["Back to tree", "Cancel editing"])
    // First press cancels editing but keeps the narrow detail visible.
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame(
      (frame) => frame.includes("back to tree") && !frame.includes("ctrl+s save"),
    )
    expect(closed).toBe(0)
    // Second press hides the detail without closing the route.
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame(
      (frame) => frame.includes("arrows move") && !frame.includes("back to tree"),
    )
    expect(closed).toBe(0)
    // Third press closes the route from the plain tree.
    expect(send(fixture, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fixture.destroy()
  }
})

