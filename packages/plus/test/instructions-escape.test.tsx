import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import type { Snapshot } from "../src/rpc.js"
import {
  createSnapshot,
  renderPlusFixture,
  type DialogScript,
  type TestFixture,
  type TestKeymapCommand,
  type TestKeymapLayer,
} from "./tui.js"

type LayerCallback = () => TestKeymapLayer

interface LayerSnapshot {
  readonly priority: number
  readonly order: number
  readonly commands: readonly TestKeymapCommand[]
}

interface EscapeFixture {
  readonly fixture: TestFixture
  readonly layers: () => readonly LayerSnapshot[]
}

// Renders the real route while capturing every registered keymap layer
// callback in registration order. Calling a callback re-evaluates the real
// layer factory, so `layers()` observes the actual registered priority and
// commands — the same values the engine would sort.
async function renderRoute(options: {
  readonly snapshots: readonly Snapshot[]
  readonly width?: number
  readonly height?: number
  readonly data?: unknown
  readonly dialogs?: DialogScript
  readonly onClose?: () => void
}): Promise<EscapeFixture> {
  const callbacks: LayerCallback[] = []
  let wrapped = false
  const onClose = options.onClose ?? (() => {})
  const fixture = await renderPlusFixture({
    snapshots: options.snapshots,
    width: options.width,
    height: options.height,
    routeData: options.data,
    dialogs: options.dialogs,
    render: (context) => {
      if (!wrapped) {
        wrapped = true
        const keymap = context.keymap as unknown as { layer: (fn: LayerCallback) => void }
        const original = keymap.layer
        keymap.layer = (fn: LayerCallback) => {
          callbacks.push(fn)
          original(fn)
        }
      }
      return createComponent(InstructionsRoute, { context, onClose, data: options.data })
    },
  })
  return {
    fixture,
    layers: () =>
      callbacks.map((fn, order) => {
        const layer = fn()
        return { priority: layer.priority ?? 0, order, commands: layer.commands ?? [] }
      }),
  }
}

function isEscape(command: TestKeymapCommand): boolean {
  return typeof command.bind === "string" && command.bind.split(",").includes("escape")
}

// Engine-derived escape dispatch: exactly one binding per press — highest
// layer priority first, then newest registration. This mirrors
// getSortedLayers (priority desc, order desc) plus first-handled-wins in
// @opentui/keymap, whose default priority is 0
// (`priority: layer.priority ?? 0`). No command title participates: the
// winner is derived purely from observed registration data.
function winningEscape(
  fx: EscapeFixture,
): { priority: number; order: number; command: TestKeymapCommand } | undefined {
  let best: { priority: number; order: number; command: TestKeymapCommand } | undefined
  for (const layer of fx.layers()) {
    for (const command of layer.commands) {
      if (!isEscape(command)) continue
      if (
        best === undefined ||
        layer.priority > best.priority ||
        (layer.priority === best.priority && layer.order > best.order)
      ) {
        best = { priority: layer.priority, order: layer.order, command }
      }
    }
  }
  return best
}

function newestEscapeLayer(fx: EscapeFixture): { priority: number; order: number } {
  let best: { priority: number; order: number } | undefined
  for (const layer of fx.layers()) {
    if (!layer.commands.some(isEscape)) continue
    if (best === undefined || layer.order > best.order) best = { priority: layer.priority, order: layer.order }
  }
  if (best === undefined) throw new Error("expected at least one escape-exposing layer")
  return best
}

function sendEscape(fx: EscapeFixture): boolean {
  const winner = winningEscape(fx)
  if (!winner) return false
  void winner.command.run()
  return true
}

function send(fx: EscapeFixture, key: string): boolean {
  if (key === "escape") return sendEscape(fx)
  for (const cmd of fx.fixture.commands()) {
    if (typeof cmd.bind === "string" && cmd.bind.split(",").includes(key)) {
      void cmd.run()
      return true
    }
  }
  return false
}

function escapeTitles(fx: EscapeFixture): (string | undefined)[] {
  return fx.fixture.commands().filter(isEscape).map((cmd) => cmd.title)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function moveDown(fx: EscapeFixture, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    send(fx, "down")
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

async function gotoSampleRow(fx: EscapeFixture): Promise<void> {
  await fx.fixture.waitForFrame((frame) => frame.includes("Instructions"))
  await moveDown(fx, 8)
  send(fx, "right")
  await sleep(50)
  await moveDown(fx, 1)
  await fx.fixture.waitForFrame((frame) => frame.includes("sample"))
}

test("escape on a plain tree closes the route", async () => {
  let closed = 0
  const fx = await renderRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await fx.fixture.waitForFrame((frame) => frame.includes("Instructions"))
    expect(escapeTitles(fx)).toEqual(["Back"])
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("help takes one escape, a second escape closes the route", async () => {
  let closed = 0
  const fx = await renderRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await fx.fixture.waitForFrame((frame) => frame.includes("Instructions"))
    expect(send(fx, "?")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("space toggle include/exclude"))
    expect(escapeTitles(fx)).toEqual(["Close help"])
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame(
      (frame) => frame.includes("arrows move") && !frame.includes("space toggle include/exclude"),
    )
    expect(closed).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("help over detail editing unwinds help first, then editing, then the route", async () => {
  let closed = 0
  const fx = await renderRoute({
    snapshots: [createSnapshot({ items: [mcpItem()] })],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await gotoSampleRow(fx)
    expect(send(fx, "return")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    // "?" stays reachable while editing, so help can float above the editor.
    expect(send(fx, "?")).toBe(true)
    await fx.fixture.waitForFrame(
      (frame) => frame.includes("space toggle include/exclude") && frame.includes("ctrl+s save"),
    )
    // Both layers stack an escape. Derived engine property: the winner comes
    // from an older layer at strictly higher priority than the newest
    // escape-exposing layer — help outranks the editor by priority, not age.
    const winner = winningEscape(fx)
    const newest = newestEscapeLayer(fx)
    if (winner === undefined) throw new Error("expected a winning escape")
    expect(winner.priority).toBeGreaterThan(newest.priority)
    expect(winner.order).toBeLessThan(newest.order)
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame(
      (frame) => !frame.includes("space toggle include/exclude") && frame.includes("ctrl+s save"),
    )
    expect(closed).toBe(0)
    // Second press cancels editing without closing the route.
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => !frame.includes("ctrl+s save"))
    expect(closed).toBe(0)
    // Third press closes the route from the plain wide tree.
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("diff editing unwinds one level per press: edit, then mode, then route", async () => {
  let closed = 0
  const fx = await renderRoute({
    snapshots: [reviewSnapshot()],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await gotoSampleRow(fx)
    await fx.fixture.waitForFrame((frame) => frame.includes("review"))
    expect(send(fx, "return")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("Original upstream"))
    expect(send(fx, "e")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    // Priority tie between the mode escape and the editor escape: the newest
    // registration wins, so the first press cancels the edit, not the mode.
    const winner = winningEscape(fx)
    const newest = newestEscapeLayer(fx)
    if (winner === undefined) throw new Error("expected a winning escape")
    expect(winner.priority).toBe(newest.priority)
    expect(winner.order).toBe(newest.order)
    // First press cancels the edit but stays in diff mode.
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame(
      (frame) => frame.includes("Original upstream") && !frame.includes("ctrl+s save"),
    )
    expect(closed).toBe(0)
    // Second press leaves diff mode without closing the route.
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame(
      (frame) => frame.includes("arrows move") && !frame.includes("Original upstream"),
    )
    expect(closed).toBe(0)
    // Third press closes the route from the plain tree.
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("split naming unwinds one level per press: naming, then mode, then route", async () => {
  const text = "Purpose tells when.\n\nQuoting details here.\n"
  let closed = 0
  const fx = await renderRoute({
    snapshots: [createSnapshot({ items: [mcpItem({ text })] })],
    width: 120,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await gotoSampleRow(fx)
    expect(send(fx, "s")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("split into sections"))
    expect(send(fx, "b")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("Name section"))
    // First press cancels naming but stays in split mode.
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame(
      (frame) => frame.includes("split into sections") && !frame.includes("Name section"),
    )
    expect(closed).toBe(0)
    // Second press leaves split mode without closing the route.
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame(
      (frame) => frame.includes("arrows move") && !frame.includes("split into sections"),
    )
    expect(closed).toBe(0)
    // Third press closes the route from the plain tree.
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("narrow detail editing unwinds one level per press: editing, detail, route", async () => {
  let closed = 0
  const fx = await renderRoute({
    snapshots: [createSnapshot({ items: [mcpItem()] })],
    width: 80,
    height: 40,
    onClose: () => {
      closed += 1
    },
  })
  try {
    await gotoSampleRow(fx)
    expect(send(fx, "right")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("back to tree"))
    expect(send(fx, "e")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    // First press cancels editing but keeps the narrow detail visible.
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame(
      (frame) => frame.includes("back to tree") && !frame.includes("ctrl+s save"),
    )
    expect(closed).toBe(0)
    // Second press hides the detail without closing the route.
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame(
      (frame) => frame.includes("arrows move") && !frame.includes("back to tree"),
    )
    expect(closed).toBe(0)
    // Third press closes the route from the plain tree.
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})
