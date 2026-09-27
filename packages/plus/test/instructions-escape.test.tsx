import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import { reach } from "./instructions-nav.js"
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
  /** How many times the route opened a dialog through ui.dialog.show (help). */
  readonly dialogs: () => number
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
  let shown = 0
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
        const dialog = context.ui.dialog as unknown as { show: (render: unknown) => void }
        dialog.show = () => {
          shown += 1
        }
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
    dialogs: () => shown,
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

function toolItem(overrides?: Record<string, unknown>) {
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

// Defaults → Every agent → MCP → sample, reached through the live filter.
async function gotoMcpItem(fx: EscapeFixture): Promise<void> {
  await reach(fx.fixture, "item:defaults::mcp:sample", "sample")
}

// Defaults → Every agent → Tools → bash. Tools rows genuinely support
// splitting (MCP rows do not), so splitter tests drive from here.
async function gotoToolItem(fx: EscapeFixture, label = "bash"): Promise<void> {
  await reach(fx.fixture, "item:defaults::tool:bash", label)
}

function closer(): { readonly count: () => number; readonly onClose: () => void } {
  let closed = 0
  return {
    count: () => closed,
    onClose: () => {
      closed += 1
    },
  }
}

test("escape in the sidebar closes the route", async () => {
  const closed = closer()
  const fx = await renderRoute({ snapshots: [createSnapshot()], width: 120, height: 40, onClose: closed.onClose })
  try {
    await fx.fixture.waitForFrame((frame) => frame.includes("esc close"))
    expect(escapeTitles(fx)).toEqual(["Close"])
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed.count()).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("escape steps back one pane: list, then sidebar, then the route", async () => {
  const closed = closer()
  const fx = await renderRoute({ snapshots: [createSnapshot({ items: [mcpItem()] })], width: 120, height: 40, onClose: closed.onClose })
  try {
    await gotoMcpItem(fx)
    expect(escapeTitles(fx)).toEqual(["Back to the sidebar"])
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("esc close"))
    expect(closed.count()).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed.count()).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("help opens a dialog and adds no escape of its own to the route", async () => {
  const closed = closer()
  const fx = await renderRoute({ snapshots: [createSnapshot()], width: 120, height: 40, onClose: closed.onClose })
  try {
    await fx.fixture.waitForFrame((frame) => frame.includes("esc close"))
    expect(send(fx, "?")).toBe(true)
    expect(fx.dialogs()).toBe(1)
    // The dialog host owns the dialog's escape; the route keeps one.
    expect(escapeTitles(fx)).toEqual(["Close"])
    expect(closed.count()).toBe(0)
  } finally {
    fx.fixture.destroy()
  }
})

test("editing unwinds one level per press: editor, list, sidebar, route", async () => {
  const closed = closer()
  const fx = await renderRoute({ snapshots: [createSnapshot({ items: [mcpItem()] })], width: 120, height: 40, onClose: closed.onClose })
  try {
    await gotoMcpItem(fx)
    expect(send(fx, "return")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    // The editor's escape is the newest at the same priority, so it wins.
    const winner = winningEscape(fx)
    const newest = newestEscapeLayer(fx)
    if (winner === undefined) throw new Error("expected a winning escape")
    expect(winner.priority).toBe(newest.priority)
    expect(winner.order).toBe(newest.order)
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => !frame.includes("ctrl+s save") && frame.includes("esc sidebar"))
    expect(closed.count()).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("esc close"))
    expect(closed.count()).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed.count()).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("escape on a changed draft asks before discarding it", async () => {
  const closed = closer()
  const fx = await renderRoute({
    snapshots: [createSnapshot({ items: [mcpItem()] })],
    width: 120,
    height: 40,
    onClose: closed.onClose,
    dialogs: { confirms: [false, true] },
  })
  try {
    await gotoMcpItem(fx)
    expect(send(fx, "return")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    fx.fixture.renderer.currentFocusedEditor?.setText("changed")
    await fx.fixture.waitForFrame((frame) => frame.includes("discard…"))
    // Keep editing: the draft stays.
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(fx.fixture.fake.dialogConfirms.length).toBe(1)
    expect(fx.fixture.captureCharFrame()).toContain("ctrl+s save")
    // Discard: back to the list, nothing saved.
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => !frame.includes("ctrl+s save"))
    expect(fx.fixture.fake.dialogConfirms.length).toBe(2)
    expect(fx.fixture.fake.mutateInputs).toEqual([])
    expect(closed.count()).toBe(0)
  } finally {
    fx.fixture.destroy()
  }
})

test("diff editing unwinds one level per press: edit, diff, list, sidebar, route", async () => {
  const closed = closer()
  const fx = await renderRoute({ snapshots: [reviewSnapshot()], width: 120, height: 40, onClose: closed.onClose })
  try {
    await gotoMcpItem(fx)
    expect(send(fx, "return")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fx, "e")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    // Priority tie between the route's diff escape and the editor escape: the
    // newest registration wins, so the first press cancels the edit.
    const winner = winningEscape(fx)
    const newest = newestEscapeLayer(fx)
    if (winner === undefined) throw new Error("expected a winning escape")
    expect(winner.priority).toBe(newest.priority)
    expect(winner.order).toBe(newest.order)
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("Upstream change") && !frame.includes("ctrl+s save"))
    expect(closed.count()).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("esc sidebar") && !frame.includes("Upstream change"))
    expect(closed.count()).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("esc close"))
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed.count()).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("split naming unwinds one level per press: naming, split, list, sidebar, route", async () => {
  const text = "Purpose tells when.\n\nQuoting details here.\n"
  const closed = closer()
  const fx = await renderRoute({ snapshots: [createSnapshot({ items: [toolItem({ text })] })], width: 120, height: 40, onClose: closed.onClose })
  try {
    await gotoToolItem(fx)
    expect(send(fx, "s")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("split into sections"))
    expect(send(fx, "b")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("Name section"))
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("split into sections") && !frame.includes("Name section"))
    expect(closed.count()).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("esc sidebar") && !frame.includes("split into sections"))
    expect(closed.count()).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("esc close"))
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed.count()).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})

test("narrow editing unwinds one level per press: editor, list page, sidebar page, route", async () => {
  const closed = closer()
  const fx = await renderRoute({ snapshots: [createSnapshot({ items: [mcpItem()] })], width: 80, height: 40, onClose: closed.onClose })
  try {
    await gotoMcpItem(fx)
    // Narrow: the list is a page of its own (no sidebar beside it).
    expect(fx.fixture.captureCharFrame()).not.toContain("▾ Agents")
    expect(send(fx, "e")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => !frame.includes("ctrl+s save") && frame.includes("esc sidebar"))
    expect(closed.count()).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await fx.fixture.waitForFrame((frame) => frame.includes("▾ Agents") && frame.includes("esc close"))
    expect(closed.count()).toBe(0)
    expect(send(fx, "escape")).toBe(true)
    await sleep(50)
    expect(closed.count()).toBe(1)
  } finally {
    fx.fixture.destroy()
  }
})
