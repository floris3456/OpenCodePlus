import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { Definition, type Plus } from "../../../rpc.js"
import { formatClock, formatTokens, textMatches } from "../format.js"
import { createRowStore, createRowWindow } from "../window.js"

const POLL_MS = 1_000
const CACHED_REQUESTS = 24

/** The keys the view routes to this tab while it is shown. */
export interface PromptController {
  readonly move: (delta: number) => void
  readonly edge: (end: "first" | "last") => void
  readonly open: () => void
  /** Closes the row content; false when no content was open. */
  readonly back: () => boolean
  readonly step: (direction: "older" | "newer") => void
  readonly latest: () => void
  readonly toggleChanged: () => void
  readonly toggleRaw: () => void
}

export interface PromptTabProps {
  readonly context: Plugin.Context
  /** The session whose sent bodies are shown; absent: the latest of any session. */
  readonly sessionID: () => string | undefined
  /** Open this request instead of following the latest (from the Cache tab). */
  readonly target: () => string | undefined
  readonly active: () => boolean
  readonly filterText: () => string | undefined
  readonly width?: number
  readonly location: () => { directory: string; workspace?: string } | undefined
  readonly onController: (controller: PromptController) => void
}

/**
 * One row per item sent to the provider: request options, system blocks, tool
 * definitions and every message part. Rows of a sent request never change, so
 * each request is fetched once and every key after that is local.
 */
export function PromptTab(props: PromptTabProps) {
  const theme = () => props.context.theme
  const rpc = props.context.client.rpc(Definition)
  const dimensions = useTerminalDimensions()
  const width = () => props.width ?? dimensions().width
  const cache = new Map<string, Plus.MonitorPrompt>()
  const details = new Map<string, NonNullable<Plus.MonitorPrompt["detail"]>>()
  const [current, setCurrent] = createSignal<Plus.MonitorPrompt>()
  const [follow, setFollow] = createSignal(true)
  const [selected, setSelected] = createSignal(0)
  const [changedOnly, setChangedOnly] = createSignal(false)
  const [detail, setDetail] = createSignal<NonNullable<Plus.MonitorPrompt["detail"]>>()
  const [raw, setRaw] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [loaded, setLoaded] = createSignal(false)
  const flight = { generation: 0, busy: false }
  const scroll: { list?: ScrollBoxRenderable; detail?: ScrollBoxRenderable } = {}

  const remember = (value: Plus.MonitorPrompt) => {
    if (!value.requestID || !value.rows) return
    cache.delete(value.requestID)
    cache.set(value.requestID, value)
    if (cache.size > CACHED_REQUESTS) cache.delete(cache.keys().next().value!)
  }

  const rows = createMemo(() => {
    const all = current()?.rows ?? []
    const filter = props.filterText()
    return all
      .map((row, index) => ({ ...row, index }))
      .filter((row) => (!changedOnly() || (row.change !== "same" && row.change !== "first")) &&
        textMatches(filter, [row.summary, row.kind, row.path]))
  })

  /** Show a request, keeping the selection on the same item when it still exists. */
  const show = (value: Plus.MonitorPrompt, keep: boolean) => {
    const path = keep ? rows()[selected()]?.path : undefined
    setCurrent(value)
    setDetail(undefined)
    setError(undefined)
    setLoaded(true)
    const at = path === undefined ? -1 : rows().findIndex((row) => row.path === path)
    setSelected(at >= 0 ? at : Math.max(0, rows().length - 1))
  }

  const fetch = (input: Plus.MonitorPromptInput, keep: boolean) => {
    const generation = ++flight.generation
    flight.busy = true
    return rpc["monitor.prompt"](input, { location: props.location() }).then(
      (value) => {
        if (generation !== flight.generation) return
        if (value.unchanged) return
        remember(value)
        if (!value.requestID) {
          setCurrent(undefined)
          setLoaded(true)
          return
        }
        show(value, keep)
      },
      (cause: unknown) => {
        if (generation === flight.generation) setError(cause instanceof Error ? cause.message : String(cause))
      },
    ).finally(() => {
      if (generation === flight.generation) flight.busy = false
    })
  }

  const open = (requestID: string) => {
    const known = cache.get(requestID)
    if (known) {
      flight.generation++
      show(known, false)
      return
    }
    void fetch({ requestID }, false)
  }

  // A session or target change starts over; the Cache tab's target pins one request.
  createEffect(on([props.sessionID, props.target], ([, target]) => {
    setDetail(undefined)
    if (target) {
      setFollow(false)
      untrack(() => open(target))
      return
    }
    setFollow(true)
    setLoaded(false)
    setCurrent(undefined)
    void untrack(() => fetch({ ...(props.sessionID() ? { sessionID: props.sessionID()! } : {}) }, false))
  }))

  createEffect(() => {
    if (!props.active() || !follow()) return
    const timer = setInterval(() => {
      if (flight.busy) return
      const known = current()?.requestID
      void fetch({ ...(props.sessionID() ? { sessionID: props.sessionID()! } : {}), ...(known ? { known } : {}) }, true)
    }, POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const window = createRowWindow({ context: props.context, items: rows, selectedIndex: selected })
  const mounted = createRowStore(() => window, "path")

  // Keep the selection in view. A list shown moments ago has no height until
  // its first frame, so following waits for that frame.
  const [laidOut, setLaidOut] = createSignal(0)
  createEffect(() => {
    laidOut()
    const count = rows().length
    const index = selected()
    const list = scroll.list
    if (detail() || count === 0) return
    if (!list || list.isDestroyed || list.viewport.height === 0) {
      const retry = () => {
        props.context.renderer.off("frame", retry)
        setLaidOut((value) => value + 1)
      }
      props.context.renderer.on("frame", retry)
      return
    }
    if (index >= list.scrollTop + list.viewport.height) list.scrollTo(index - list.viewport.height + 1)
    if (index < list.scrollTop) list.scrollTo(index)
  })

  const openRow = () => {
    const value = current()
    const row = rows()[selected()]
    if (!value?.requestID || !row) return
    const key = `${value.requestID}:${row.index}`
    const known = details.get(key)
    if (known) {
      setDetail(known)
      return
    }
    void rpc["monitor.prompt"]({ requestID: value.requestID, row: row.index }, { location: props.location() }).then((answer) => {
      if (!answer.detail) return
      details.set(key, answer.detail)
      if (details.size > 64) details.delete(details.keys().next().value!)
      if (current()?.requestID === value.requestID) setDetail(answer.detail)
    }, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const page = () => Math.max(1, (scroll.detail?.viewport.height ?? scroll.list?.viewport.height ?? 10) - 1)

  props.onController({
    move: (delta) => {
      if (detail()) {
        const view = scroll.detail
        if (view) view.scrollTo(Math.max(0, view.scrollTop + (Math.abs(delta) > 1 ? Math.sign(delta) * page() : delta)))
        return
      }
      const step = Math.abs(delta) > 1 ? Math.sign(delta) * page() : delta
      setSelected((index) => Math.max(0, Math.min(rows().length - 1, index + step)))
    },
    edge: (end) => {
      if (detail()) {
        scroll.detail?.scrollTo(end === "first" ? 0 : scroll.detail.scrollHeight)
        return
      }
      setSelected(end === "first" ? 0 : Math.max(0, rows().length - 1))
    },
    open: openRow,
    back: () => {
      if (!detail()) return false
      setDetail(undefined)
      return true
    },
    step: (direction) => {
      const value = current()
      const next = direction === "older" ? value?.older : value?.newer
      if (!next) return
      setFollow(false)
      open(next)
    },
    latest: () => {
      setFollow(true)
      void fetch({ ...(props.sessionID() ? { sessionID: props.sessionID()! } : {}) }, false)
    },
    toggleChanged: () => {
      setChangedOnly((value) => !value)
      setSelected((index) => Math.min(index, Math.max(0, rows().length - 1)))
    },
    toggleRaw: () => setRaw((value) => !value),
  })

  const narrow = () => width() < 90
  const changeMark = (change: Plus.MonitorPromptRow["change"]) =>
    change === "new" ? "+" : change === "changed" ? "~" : change === "marker" ? "*" : " "
  const changeColor = (change: Plus.MonitorPromptRow["change"]) =>
    change === "new" ? theme().text.feedback.success.base
      : change === "changed" ? theme().text.feedback.warning.base
      : change === "marker" ? theme().text.feedback.info.base : theme().text.muted
  const counts = createMemo(() => {
    const all = current()?.rows ?? []
    return { added: all.filter((row) => row.change === "new").length, changed: all.filter((row) => row.change === "changed").length }
  })
  const header = () => {
    const value = current()
    if (!value?.requestID) return ""
    return [
      `request ${(value.position ?? 0) + 1}/${value.count ?? 1}`,
      formatClock(value.at ?? 0),
      value.kind,
      ...(narrow() ? [] : [value.model]),
      value.verdict,
      `${formatTokens(value.bytes ?? 0)} chars`,
      `${value.rows?.length ?? 0} items`,
      ...(counts().added ? [`${counts().added} new`] : []),
      ...(counts().changed ? [`${counts().changed} changed`] : []),
    ].filter(Boolean).join(" · ")
  }

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme().text.base} wrapMode="none" flexGrow={1} minWidth={0}>{header()}</text>
        <text fg={follow() ? theme().text.feedback.success.base : theme().text.muted} flexShrink={0}>
          {follow() ? " live" : " [l] latest"}
        </text>
      </box>
      <Show when={error()}>{(message) => <text fg={theme().text.feedback.error.base}>{message()}</text>}</Show>
      <Show
        when={detail()}
        fallback={
          <Show
            when={rows().length > 0}
            fallback={
              <box paddingLeft={1} paddingTop={1}>
                <text fg={theme().text.muted}>
                  {!loaded()
                    ? "Loading sent prompt…"
                    : current()?.requestID
                      ? "No items match this filter."
                      : "No sent request recorded for this scope yet. Bodies are kept from release 1.3.11 on."}
                </text>
              </box>
            }
          >
            <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
              <text fg={theme().text.muted} width={5} attributes={TextAttributes.BOLD}>#</text>
              <text fg={theme().text.muted} width={2} attributes={TextAttributes.BOLD}> </text>
              <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Kind</text>
              <Show when={!narrow()}>
                <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>Chars</text>
              </Show>
              <text fg={theme().text.muted} flexGrow={1} attributes={TextAttributes.BOLD}>Summary</text>
            </box>
            <scrollbox
              flexGrow={1}
              minHeight={0}
              ref={(next: ScrollBoxRenderable) => {
                scroll.list = next
                window.ref(next)
              }}
            >
              <Show when={window.start > 0}>
                <box height={window.start} flexShrink={0} />
              </Show>
              <For each={mounted.items}>
                {(row, index) => {
                  const at = () => window.start + index()
                  const isSelected = () => at() === selected() && props.active()
                  const fg = () => (isSelected() ? theme().text.action.primary.focused : theme().text.base)
                  return (
                    <box
                      flexDirection="row"
                      flexShrink={0}
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={isSelected() ? theme().background.action.primary.focused : theme().background.action.primary.base}
                      onMouseUp={() => setSelected(at())}
                    >
                      <text fg={theme().text.muted} width={5}>{String(row.index + 1)}</text>
                      <text fg={changeColor(row.change)} width={2}>{`${changeMark(row.change)}${row.marker ? "◆" : " "}`}</text>
                      <text fg={fg()} width={10} wrapMode="none" truncate>{row.kind}</text>
                      <Show when={!narrow()}>
                        <text fg={theme().text.muted} width={8}>{formatTokens(row.chars)}</text>
                      </Show>
                      {/* Clipped at the edge: a summary reads from its start. */}
                      <text fg={fg()} flexGrow={1} minWidth={0} wrapMode="none">{row.summary}</text>
                    </box>
                  )
                }}
              </For>
              <Show when={window.end < window.total}>
                <box height={window.total - window.end} flexShrink={0} />
              </Show>
            </scrollbox>
          </Show>
        }
      >
        {(content) => (
          <box flexDirection="column" flexGrow={1} minHeight={0}>
            <text fg={theme().text.muted} flexShrink={0} paddingLeft={1} wrapMode="none" truncate>
              {`${content().path} · ${raw() ? "exact JSON" : "readable"} · v ${raw() ? "readable" : "exact JSON"} · ⌫ back`}
            </text>
            <scrollbox flexGrow={1} minHeight={0} paddingLeft={1} ref={(next: ScrollBoxRenderable) => (scroll.detail = next)}>
              <text fg={theme().text.base}>{raw() ? content().json : content().text}</text>
            </scrollbox>
          </box>
        )}
      </Show>
    </box>
  )
}
