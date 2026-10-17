// The monitor list tabs render only the rows around the scrollbox viewport,
// with a margin above and below and spacer boxes carrying the rest of the
// scroll height. OpenTUI culls drawing outside the viewport but still
// instantiates every child, so rendering a whole thousand-row list creates one
// native TextBuffer per cell; windowing keeps the instantiated row count
// bounded however long the list is.
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

/** Rows kept mounted above and below the viewport so a step lands on live rows. */
export const LIST_WINDOW_MARGIN = 12

// Before the first frame the scrollbox reports no viewport; this is a safe
// stand-in that the frame sync replaces with the real height.
const DEFAULT_VIEWPORT = 24

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
 *
 * The window always covers the viewport, so wheel and page scrolling mount the
 * rows the user is looking at even while the selection stays put. When the
 * keyboard moves the selection outside the mounted window, the window also
 * follows the selection (centred) so the selected row exists before the list
 * scrolls it into view. Its length always stays `viewport + 2 * margin`.
 *
 * With `key`, only a selection on another row counts as a step: when a poll
 * adds rows above, the selection keeps its row at a new index and the window
 * stays with the viewport.
 */
export function createRowWindow<T>(options: {
  readonly context: Plugin.Context
  readonly items: () => readonly T[]
  readonly selectedIndex: () => number
  readonly key?: (item: T) => string
}): RowWindow<T> {
  let scroll: ScrollBoxRenderable | undefined
  // The selection that the last window was built for: a change means the
  // keyboard moved, not the viewport, and the window must follow it.
  let lastSelected: number | string = options.selectedIndex()
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
    // view() wakes the memo when the viewport moved, but it lags a frame behind
    // a scroll made since; when the rows change in between (older rows loaded
    // after a key step), the scrollbox's own position is the one to cover.
    const synced = view()
    const live = scroll !== undefined && !scroll.isDestroyed && scroll.viewport.height > 0 ? scroll : undefined
    const size = Math.max(1, live?.viewport.height ?? synced.height)
    const span = size + LIST_WINDOW_MARGIN * 2
    const selected = Math.max(0, Math.min(total - 1, options.selectedIndex()))
    const top = live?.scrollTop ?? synced.top
    const identity = options.key ? options.key(items[selected]!) : selected
    const moved = identity !== lastSelected
    lastSelected = identity
    const near = selected >= top - LIST_WINDOW_MARGIN && selected < top + size + LIST_WINDOW_MARGIN
    // While the viewport holds the selection, follow the viewport. When the
    // selection moved outside it, centre the selection instead — this is a key
    // step, and the list scrolls to it on the next pass.
    const anchor = near || !moved ? top - LIST_WINDOW_MARGIN : selected - Math.floor(size / 2)
    const start = Math.max(0, Math.min(anchor, Math.max(0, total - span)))
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
 * stable key field into a store, so an unchanged row keeps its component
 * instead of being torn down and rebuilt every refresh, and a same-id row's
 * changed fields update in place.
 */
export function createRowStore<T extends object>(window: () => RowWindow<T>, key: keyof T & string) {
  const [rows, setRows] = createStore<{ items: readonly T[] }>({ items: [] })
  createEffect(() => setRows("items", reconcile(window().rows, { key })))
  return rows
}
