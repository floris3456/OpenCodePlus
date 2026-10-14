import type { Plugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { Definition, type Plus } from "../../rpc.js"
import { formatClock, formatTokens } from "./format.js"

/** The cache screen deliberately has no history analysis or persisted filters. */
export function CacheScreen(props: {
  context: Plugin.Context
  sessionID: () => string | undefined
  active: () => boolean
  onClose: () => void
  width?: number
  focus?: () => void
  onToggleFullscreen?: () => void
}) {
  const rpc = props.context.client.rpc(Definition)
  const dimensions = useTerminalDimensions()
  const theme = () => props.context.theme
  const narrow = () => (props.width ?? dimensions().width) < 85
  const [session, setSession] = createSignal(props.sessionID())
  const [report, setReport] = createSignal<Plus.MonitorReport>()
  const [error, setError] = createSignal<string>()
  const [misses, setMisses] = createSignal(false)
  const [selected, setSelected] = createSignal(0)
  const [detail, setDetail] = createSignal<string>()
  const [page, setPage] = createSignal<Plus.MonitorQueryInput["requestPage"]>()
  const state = { generation: 0, busy: false }
  const scroll: { detail?: ScrollBoxRenderable } = {}
  const location = () => {
    const current = props.context.location ?? props.context.data.location.default()
    return current ? { directory: current.directory, workspace: current.workspaceID } : undefined
  }
  const load = () => {
    const generation = ++state.generation
    state.busy = true
    void rpc["monitor.cache"]({ scope: session() ? "session" : "all", sessionID: session(), view: "cache",
      missesOnly: misses(), id: detail(), requestPage: page() }, { location: location() }).then((value) => {
      if (generation !== state.generation) return
      setReport(value)
      setError(undefined)
      setSelected((index) => Math.min(index, Math.max(0, (value.requests?.length ?? 0) - 1)))
    }, (cause: unknown) => {
      if (generation === state.generation) setError(cause instanceof Error ? cause.message : "Cache report request failed")
    }).finally(() => { if (generation === state.generation) state.busy = false })
  }
  createEffect(() => {
    const id = props.sessionID()
    untrack(() => { setSession(id); setPage(undefined); setDetail(undefined); setSelected(0) })
  })
  createEffect(() => {
    const active = props.active()
    session(); misses(); detail(); page()
    if (active) untrack(load)
  })
  onMount(() => {
    props.focus?.()
    const timer = setInterval(() => { if (props.active() && !state.busy) load() }, 2000)
    onCleanup(() => { clearInterval(timer); state.generation++ })
  })
  const choose = async (offset = 0) => {
    const value = await rpc["monitor.cache"]({ scope: "all", view: "sessions", pages: { sessions: { cursor: { offset, revision: "cache-sessions-v1" } } } }, { location: location() })
    const picked = await props.context.ui.dialog.select<string>({ title: "Cache monitor — session", options: [
      { title: "All sessions", value: "\0all" },
      ...(props.sessionID() ? [{ title: "This chat", value: props.sessionID()! }] : []),
      ...[...new Map([
        ...(value.sessions ?? []).map((row) => [row.sessionID, { title: row.title ?? row.sessionID, value: row.sessionID }] as const),
        ...(props.context.data.session.list() ?? []).map((row) => [row.id, { title: row.title ?? row.id, value: row.id }] as const),
      ]).values()],
      ...(value.pages?.sessions?.previous ? [{ title: "Previous sessions", value: "\0previous" }] : []),
      ...(value.pages?.sessions?.next ? [{ title: "More sessions", value: "\0next" }] : []),
    ] })
    props.context.ui.dialog.clear()
    if (picked === "\0next" || picked === "\0previous") {
      const cursor = picked === "\0next" ? value.pages?.sessions?.next : value.pages?.sessions?.previous
      if (cursor) await choose(cursor.offset)
      return
    }
    if (picked === undefined) return
    setSession(picked === "\0all" ? undefined : picked)
    setPage(undefined); setDetail(undefined); setSelected(0)
  }
  const rows = () => (report()?.requests ?? []).toReversed()
  const visibleCount = () => Math.max(1, dimensions().height - 9)
  const start = () => Math.max(0, selected() - visibleCount() + 1)
  props.context.keymap.layer(() => ({ enabled: props.active, priority: 1, commands: [
    { bind: "escape", title: "Close cache monitor", group: "Monitor", run: () => detail() ? setDetail(undefined) : props.onClose() },
    { bind: "s", title: "Choose session", group: "Monitor", run: () => { void choose().catch((cause: unknown) => setError(String(cause))) } },
    { bind: "m", title: "Misses and cold starts", group: "Monitor", run: () => { setMisses((value) => !value); setPage(undefined); setDetail(undefined); setSelected(0) } },
    { bind: "l", title: "Latest requests", group: "Monitor", run: () => { setPage(undefined); setDetail(undefined); setSelected(0) } },
    { bind: "up", title: "Previous request / scroll evidence", group: "Monitor", run: () => {
      if (detail()) { scroll.detail?.scrollTo(Math.max(0, scroll.detail.scrollTop - 1)); return }
      setSelected((value) => Math.max(0, value - 1))
    } },
    { bind: "down", title: "Next request / scroll evidence", group: "Monitor", run: () => {
      if (detail()) { scroll.detail?.scrollTo(scroll.detail.scrollTop + 1); return }
      setSelected((value) => Math.max(0, Math.min(rows().length - 1, value + 1)))
    } },
    { bind: "enter", title: "Request evidence", group: "Monitor", run: () => setDetail(rows()[selected()]?.id) },
    { bind: "f", title: "Toggle fullscreen", group: "Monitor", run: () => props.onToggleFullscreen?.() },
    ...(["older", "newer"] as const).map((direction) => ({ bind: direction === "older" ? "[" : "]", title: `${direction} requests`, group: "Monitor", run: () => {
      const cursor = report()?.requestPage?.[direction]
      if (cursor) { setPage({ direction, cursor }); setSelected(0); setDetail(undefined) }
    } })),
  ] }))
  const label = () => session() ? props.context.data.session.get(session()!)?.title ?? report()?.sessions?.find((row) => row.sessionID === session())?.title ?? session() : "All sessions"
  const color = (row: Plus.MonitorRequest) => row.verdict === "miss" ? theme().text.feedback.error.base
    : row.verdict === "partial" ? theme().text.feedback.warning.base
    : row.verdict === "hit" ? theme().text.feedback.success.base : theme().text.muted
  return <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1} paddingRight={1}>
    <text flexShrink={0} fg={theme().text.base}>Cache · {label()}</text>
    <Show when={error()}>{(value) => <text fg={theme().text.feedback.error.base}>{value()}</text>}</Show>
    <text flexShrink={0} fg={theme().text.muted}>{report()?.totals.requests ?? 0} requests · {report()?.totals.misses ?? 0} misses/partials · {formatTokens(report()?.totals.missTokens ?? 0)} lost reuse · {report()?.totals.coldRequests ?? 0} cold</text>
    <Show when={report()?.cachePending}><text fg={theme().text.feedback.info.base}>{report()?.cachePending} older requests still being analyzed</text></Show>
    <Show when={report()?.detail && detail()} fallback={
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <box flexDirection="row">
          <text width={9} fg={theme().text.muted}>Time</text>
          <text width={narrow() ? 8 : 11} fg={theme().text.muted}>Kind</text>
          <text width={9} fg={theme().text.muted}>Verdict</text>
          <text width={8} fg={theme().text.muted}>Read</text>
          <text width={8} fg={theme().text.muted}>Lost</text>
          <text flexGrow={1} fg={theme().text.muted}>What changed</text>
        </box>
        <Show when={rows().length} fallback={<text fg={theme().text.muted}>{report() ? "No completed cache results yet. Historical results are prepared in the background." : "Loading cache results…"}</text>}>
          <For each={rows().slice(start(), start() + visibleCount())}>{(row, index) =>
            <box flexDirection="row" backgroundColor={selected() === start() + index() ? theme().background.action.primary.focused : theme().background.action.primary.base}>
              <text width={9} fg={theme().text.base}>{formatClock(row.at)}</text>
              <text width={narrow() ? 8 : 11} fg={theme().text.muted}>{row.kind === "compaction" ? narrow() ? "[comp]" : "[compact]" : row.kind}</text>
              <text width={9} fg={color(row)}>{row.verdict}</text>
              <text width={8} fg={theme().text.base}>{row.measurement?.read === undefined ? "?" : formatTokens(row.measurement.read)}</text>
              <text width={8} fg={color(row)}>{formatTokens(row.missTokens ?? 0)}</text>
              <text flexGrow={1} wrapMode="none" fg={theme().text.base}>{row.causeText}</text>
            </box>
          }</For>
        </Show>
      </box>
    }>
      <scrollbox ref={(value: ScrollBoxRenderable) => { scroll.detail = value }} flexGrow={1} minHeight={0}><For each={report()?.detail?.lines}>{(line) => <text fg={theme().text.base}>{line}</text>}</For></scrollbox>
    </Show>
    <text flexShrink={0} fg={theme().text.muted}>s sessions · m {misses() ? "show all" : "misses/cold"} · ↑↓ select · Enter evidence · [ ] page · Esc back</text>
  </box>
}
