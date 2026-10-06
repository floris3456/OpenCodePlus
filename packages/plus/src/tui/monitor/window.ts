// The monitor list tabs render only the rows around the scrollbox viewport,
// with a margin above and below and spacer boxes carrying the rest of the
// scroll height. OpenTUI culls drawing outside the viewport but still
// instantiates every child, so rendering a whole thousand-row list creates one
// native TextBuffer per cell and can exhaust the renderer; the window keeps the
// instantiated row count bounded however long the list is.
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

/** Rows kept mounted above and below the viewport so a step lands on live rows. */
export const LIST_WINDOW_MARGIN = 12

// Before the first frame the scrollbox reports no viewport; this is a safe
// stand-in that the frame sync replaces with the real height.
const DEFAULT_VIEWPORT = 24

/**
 * Test observability for the row window (not read in production): one entry per
 * row the list's <For> instantiates. Recording starts with resetRowWindowLog();
 * production never enables it.
 */
export const rowWindowLog: { enabled: boolean; keys: string[] } = { enabled: false, keys: [] }
export function resetRowWindowLog(): void {
  rowWindowLog.enabled = true
  rowWindowLog.keys.length = 0
}
export function stopRowWindowLog(): void {
  rowWindowLog.enabled = false
}

export interface RowWindow<T> {
  /** The rows to instantiate, in list order. */
  readonly rows: readonly T[]
  /** The index of the first rendered row in the full list (its spacer height). */
  readonly start: number
  /** The index one past the last rendered row. */
  readonly end: number
  readonly total: number
  readonly ref: (scroll: ScrollBoxRenderable) => void
}

/**
 * Window the rows a list instantiates to the scrollbox viewport plus a margin.
 * When the cursor is inside the window the viewport anchors it, so wheel and
 * page scrolling show those rows; when the cursor has moved outside — the
 * viewport has not caught up yet — the window centres on the cursor. Either way
 * its length stays `viewport + 2 * margin`.
 */
export function createRowWindow<T>(options: {
  readonly context: Plugin.Context
  readonly items: () => readonly T[]
  readonly selectedIndex: () => number
}): RowWindow<T> {
  let scroll: ScrollBoxRenderable | undefined
  const [view, setView] = createSignal({ top: 0, height: DEFAULT_VIEWPORT })

  const sync = () => {
    if (scroll === undefined || scroll.isDestroyed) return
    const height = Math.max(1, scroll.viewport.height)
    const top = scroll.scrollTop
    setView((current) => (current.top === top && current.height === height ? current : { top, height }))
  }
  options.context.renderer.on("frame", sync)
  onCleanup(() => options.context.renderer.off("frame", sync))

  const frame = createMemo((): { rows: readonly T[]; start: number; end: number; total: number } => {
    const items = options.items()
    const total = items.length
    if (total === 0) return { rows: [], start: 0, end: 0, total: 0 }
    const size = Math.max(1, view().height)
    const span = size + LIST_WINDOW_MARGIN * 2
    const selected = Math.max(0, Math.min(total - 1, options.selectedIndex()))
    const top = view().top
    const near = selected >= top - LIST_WINDOW_MARGIN && selected < top + size + LIST_WINDOW_MARGIN
    // Anchor on the viewport while it holds the cursor; otherwise centre the
    // cursor so a key step pulls the window along before scrolling catches up.
    const anchor = near ? top - LIST_WINDOW_MARGIN : selected - Math.floor(size / 2)
    const start = Math.max(0, Math.min(anchor, total - span))
    const end = Math.min(total, start + span)
    return { rows: items.slice(start, end), start, end, total }
  })

  return {
    get rows() {
      return frame().rows
    },
    get start() {
      return frame().start
    },
    get end() {
      return frame().end
    },
    get total() {
      return frame().total
    },
    ref: (next: ScrollBoxRenderable) => {
      scroll = next
      sync()
    },
  }
}

/**
 * Keep the mounted rows' identity across polls: reconcile the window by a
 * stable key field into a store, so an unchanged row keeps its component (and
 * its native TextBuffers) instead of being torn down and rebuilt every refresh.
 */
export function createRowStore<T extends object>(window: () => RowWindow<T>, key: keyof T & string) {
  const [rows, setRows] = createStore<{ items: readonly T[] }>({ items: [] })
  createEffect(() => setRows("items", reconcile(window().rows, { key })))
  return rows
}
