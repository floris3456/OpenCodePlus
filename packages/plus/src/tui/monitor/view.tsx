import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Definition, type Plus } from "../../rpc.js"
import {
  COMPARES,
  compareLabel,
  cycle,
  defaultSettings,
  drillInto,
  formatClock,
  formatDelta,
  formatMs,
  formatTokens,
  GROUPS,
  pad,
  queryOf,
  SCOPES,
  scopeWords,
  SORTS,
  toolLine,
  totalsLine,
  WINDOWS,
  type Drill,
  type MonitorSettings,
} from "./format.js"

// The monitor view: totals, the top groups and the latest calls for the
// chosen scope, window and filters, refreshed every second while visible.
// The Tools tab shows it in a taller composer body; the /tools command's
// full-screen route shows it across the terminal.

/**
 * The Tools tab's composer body is taller than the native tabs' five rows so
 * the group table has room to breathe. The host reserves exactly this many
 * rows for the tab (registered as its body height), and the view lays out the
 * same number whatever the report state, so selecting the tab resizes in one
 * step and stays put.
 */
export const TOOLS_BODY_ROWS = 10

/** The group rows that fit under the filters, the totals and the column header. */
const COMPOSER_GROUP_ROWS = TOOLS_BODY_ROWS - 3

/**
 * A few more group rows are fetched than the body shows, so scrolling can
 * reveal rows past the fold the way it did at the native height.
 */
const COMPOSER_GROUP_FETCH = COMPOSER_GROUP_ROWS + 4

/**
 * Test observability for the group rows (not read in production): one entry
 * per group row `<For>` mounts, with the key it was mounted for. Recording
 * starts with resetGroupMountLog().
 */
export const groupMountLog: { enabled: boolean; keys: string[] } = { enabled: false, keys: [] }
export function resetGroupMountLog(): void {
  groupMountLog.enabled = true
  groupMountLog.keys.length = 0
}
export function stopGroupMountLog(): void {
  groupMountLog.enabled = false
}

// Every second while something runs or ran in the last minute; every five
// seconds when the ledger is quiet, so an open monitor costs next to nothing.
const REFRESH_MS = 1_000
const IDLE_REFRESH_MS = 5_000
const LIVE_FOR_MS = 60_000

export function refreshInterval(report: Plus.MonitorReport | undefined): number {
  if (report === undefined) return REFRESH_MS
  const latest = report.feed[0]?.started ?? 0
  return report.totals.running > 0 || report.now - latest < LIVE_FOR_MS ? REFRESH_MS : IDLE_REFRESH_MS
}

export interface MonitorViewProps {
  readonly context: Plugin.Context
  /** The chat the session scope follows; absent outside a chat. */
  readonly sessionID: () => string | undefined
  /** Visible and focused: only then does it poll and own its keys. */
  readonly active: () => boolean
  readonly full: boolean
  /** The keymap mode its keys belong to ("composer" inside the composer). */
  readonly mode?: string
  readonly onClose: () => void
  readonly onOpenFull?: () => void
}

export function createMonitorSettings(context: Plugin.Context) {
  const [stored, update] = context.storage.store<{ settings: MonitorSettings }>("monitor", {
    initial: { settings: defaultSettings },
  })
  return {
    settings: (): MonitorSettings => ({ ...defaultSettings, ...stored.settings }),
    set: (next: MonitorSettings) =>
      void update((draft) => {
        draft.settings = next
      }),
  }
}

export function MonitorView(props: MonitorViewProps) {
  const theme = () => props.context.theme
  const plus = props.context.client.rpc(Definition)
  const dimensions = useTerminalDimensions()
  const store = createMonitorSettings(props.context)
  const [drills, setDrills] = createSignal<readonly Drill[]>([])
  // A drill-down narrows this view only; the stored settings stay the user's.
  const settings = () => drills().at(-1)?.settings ?? store.settings()
  const sessionID = () => {
    const drilled = drills().findLast((drill) => drill.sessionID !== undefined)
    return drilled?.sessionID ?? props.sessionID()
  }
  const [report, setReport] = createSignal<Plus.MonitorReport | undefined>()
  const [failure, setFailure] = createSignal<string | undefined>()
  const [selected, setSelected] = createSignal(0)
  // Rows live in a store reconciled by identity, so a poll that returns the
  // same groups or calls updates the values in place instead of rebuilding
  // every row component.
  const [rows, setRows] = createStore<{
    groups: readonly Plus.MonitorGroup[]
    feed: readonly Plus.MonitorCall[]
  }>({ groups: [], feed: [] })
  let scroll: ScrollBoxRenderable | undefined
  const top = () =>
    props.full ? Math.max(5, Math.floor((dimensions().height - 12) * 0.55)) : COMPOSER_GROUP_FETCH
  const feed = () => (props.full ? Math.max(3, dimensions().height - 12 - top()) : 0)

  const location = () => {
    const current = props.context.location
    if (current !== undefined) return { directory: current.directory, workspace: current.workspaceID }
    const fallback = props.context.data.location.default()
    return fallback === undefined ? undefined : { directory: fallback.directory, workspace: fallback.workspaceID }
  }

  // One request at a time; a change while one is in flight asks again after it.
  const flight = { busy: false, again: false, generation: 0 }
  const refresh = () => {
    if (flight.busy) {
      flight.again = true
      return
    }
    flight.busy = true
    const generation = ++flight.generation
    const query = queryOf(settings(), {
      sessionID: sessionID(),
      now: Date.now(),
      marks: report()?.marks ?? [],
      top: top(),
      feed: feed(),
    })
    void plus["monitor.query"](query, { location: location() })
      .then(
        (next) => {
          if (generation !== flight.generation) return
          setReport(next)
          setFailure(undefined)
          setSelected((index) => Math.min(index, Math.max(0, next.groups.length - 1)))
        },
        (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        flight.busy = false
        if (!flight.again) return
        flight.again = false
        refresh()
      })
  }

  createEffect(() => {
    // Re-query whenever what the query depends on changes.
    settings()
    sessionID()
    top()
    feed()
    if (props.active()) refresh()
  })
  const pace = createMemo(() => refreshInterval(report()))
  createEffect(() => {
    // Poll while visible, at the pace the last answer calls for.
    if (!props.active()) return
    const timer = setInterval(refresh, pace())
    onCleanup(() => clearInterval(timer))
  })

  const change = (next: MonitorSettings) => {
    setSelected(0)
    if (drills().length > 0) {
      setDrills((stack) => [...stack.slice(0, -1), { ...stack.at(-1), settings: next }])
      return
    }
    store.set(next)
  }

  // When comparing, a group only the other window has still gets a row (its
  // numbers here are zero), so what disappeared after a change stays visible.
  const groups = createMemo((): readonly Plus.MonitorGroup[] => {
    const current = report()
    if (current === undefined) return []
    const seen = new Set(current.groups.map((group) => group.key))
    const gone = (current.compare?.groups ?? [])
      .filter((group) => !seen.has(group.key))
      .map((group) => ({
        ...group,
        calls: 0,
        inner: 0,
        errors: 0,
        running: 0,
        callTokens: 0,
        resultTokens: 0,
        carried: 0,
        estimated: 0,
        avgMs: 0,
      }))
    return [...current.groups, ...gone]
  })

  createEffect(() => setRows("groups", reconcile(groups(), { key: "key" })))
  // Calls are keyed by their provider call id (unique within the session that
  // produced them), so a poll updates the feed rows in place.
  createEffect(() => setRows("feed", reconcile(report()?.feed ?? [], { key: "callID" })))

  // The composer keeps the table inside the fixed body; scroll the group rows
  // so the selected one stays visible as Up and Down move it. The reactive
  // reads come first so the scrollbox mounting later re-runs the effect.
  createEffect(() => {
    const index = Math.min(selected(), Math.max(0, rows.groups.length - 1))
    if (props.full || scroll === undefined) return
    if (index >= scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(index - scroll.viewport.height + 1)
    if (index < scroll.scrollTop) scroll.scrollTo(index)
  })

  const pick = async (dimension: "agent" | "tool" | "model") => {
    const facets = report()?.facets
    const values = dimension === "agent" ? facets?.agents : dimension === "tool" ? facets?.tools : facets?.models
    const choice = await props.context.ui.dialog.select<string>({
      title: `Show one ${dimension}`,
      placeholder: `Filter by ${dimension}`,
      current: settings()[dimension] ?? "",
      options: [
        { title: `Every ${dimension}`, value: "" },
        ...(values ?? []).map((value) => ({ title: value, value })),
      ],
    })
    props.context.ui.dialog.clear()
    if (choice === undefined) return
    const next = { ...settings() }
    change(choice === "" ? withoutKey(next, dimension) : { ...next, [dimension]: choice })
  }

  const mark = async () => {
    const label = await props.context.ui.dialog.prompt({
      title: "Mark this moment",
      description: "Compare before and after it with c (compare: mark).",
      placeholder: "e.g. before the prompt change",
    })
    props.context.ui.dialog.clear()
    if (label === undefined) return
    await plus["monitor.mark"]({ label }, { location: location() }).then(
      (created) => {
        props.context.ui.toast.show({
          variant: "success",
          message: `Marked “${created.label}” at ${formatClock(created.at)}`,
        })
        refresh()
      },
      (error: unknown) =>
        props.context.ui.toast.show({
          variant: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
    )
  }

  const drill = () => {
    const group = groups()[selected()]
    if (group === undefined) return
    const next = drillInto(settings(), group)
    if (next === undefined) return
    setSelected(0)
    setDrills((stack) => [...stack, next])
  }

  const back = () => {
    if (drills().length === 0) return props.onClose()
    setSelected(0)
    setDrills((stack) => stack.slice(0, -1))
  }

  props.context.keymap.layer(() => ({
    ...(props.mode === undefined ? {} : { mode: props.mode }),
    enabled: () => props.active(),
    priority: 1,
    commands: [
      {
        bind: "up,k",
        title: "Previous row",
        group: "Tools",
        run: () => {
          if (selected() === 0 && !props.full) return props.onClose()
          setSelected((index) => Math.max(0, index - 1))
        },
      },
      {
        bind: "down,j",
        title: "Next row",
        group: "Tools",
        run: () => setSelected((index) => Math.min(Math.max(0, groups().length - 1), index + 1)),
      },
      { bind: "return", title: "Drill into the row", group: "Tools", run: drill },
      { bind: "backspace", title: "Back out of a drill-down", group: "Tools", run: back },
      ...(props.full ? [{ bind: "escape", title: "Back", group: "Tools", run: back }] : []),
      {
        bind: "g",
        title: "Group by",
        group: "Tools",
        run: () => change({ ...settings(), group: cycle(GROUPS, settings().group) }),
      },
      {
        bind: "s",
        title: "Scope",
        group: "Tools",
        run: () => change({ ...settings(), scope: cycle(SCOPES, settings().scope) }),
      },
      {
        bind: "t",
        title: "Time window",
        group: "Tools",
        run: () => change({ ...settings(), window: cycle(WINDOWS, settings().window) }),
      },
      {
        bind: "o",
        title: "Order by",
        group: "Tools",
        run: () => change({ ...settings(), sort: cycle(SORTS, settings().sort) }),
      },
      {
        bind: "c",
        title: "Compare",
        group: "Tools",
        run: () => change({ ...settings(), compare: cycle(COMPARES, settings().compare) }),
      },
      {
        bind: "x",
        title: "Failed calls only",
        group: "Tools",
        run: () => change({ ...settings(), errors: !settings().errors }),
      },
      { bind: "a", title: "Filter by agent", group: "Tools", run: () => void pick("agent") },
      { bind: "f", title: "Filter by tool", group: "Tools", run: () => void pick("tool") },
      { bind: "shift+f", title: "Filter by model", group: "Tools", run: () => void pick("model") },
      { bind: "m", title: "Mark this moment", group: "Tools", run: () => void mark() },
      ...(props.onOpenFull === undefined
        ? []
        : [{ bind: "shift+m", title: "Open the full tools view", group: "Tools", run: () => props.onOpenFull?.() }]),
    ],
  }))

  const compared = createMemo(() => new Map((report()?.compare?.groups ?? []).map((group) => [group.key, group])))
  const comparing = () => report()?.compare !== undefined
  // Columns: the key grows to whatever width the container gives (the
  // composer is narrower than the terminal); the numbers keep fixed widths.
  const groupCells = (group: Plus.MonitorGroup | undefined): Cell[] => {
    const before = group === undefined ? undefined : compared().get(group.key)
    return [
      { text: group?.label ?? settings().group, grow: true },
      {
        text:
          group === undefined
            ? "calls"
            : `${group.calls}${group.inner > 0 ? `+${group.inner}` : ""}${group.running > 0 ? "*" : ""}`,
        width: 7,
      },
      { text: group === undefined ? "fail" : group.errors > 0 ? String(group.errors) : "·", width: 5 },
      { text: group === undefined ? "call" : formatTokens(group.callTokens), width: 7 },
      {
        text:
          group === undefined
            ? "result"
            : `${group.estimated > 0 && group.estimated === group.calls ? "~" : ""}${formatTokens(group.resultTokens)}`,
        width: 8,
      },
      { text: group === undefined ? "carried" : formatTokens(group.carried), width: 8 },
      { text: group === undefined ? "avg" : formatMs(group.avgMs), width: 7 },
      ...(comparing()
        ? [
            { text: group === undefined ? "Δcalls" : formatDelta(group.calls, before?.calls ?? 0), width: 8 },
            {
              text: group === undefined ? "Δresult" : formatDelta(group.resultTokens, before?.resultTokens ?? 0),
              width: 8,
            },
          ]
        : []),
    ]
  }
  const feedCells = (entry: Plus.MonitorCall): Cell[] => [
    { text: formatClock(entry.started), width: 9, align: "left" },
    { text: entry.agent ?? "?", width: 17, align: "left" },
    { text: entry.tool, width: 17, align: "left" },
    { text: entry.target ?? "", grow: true },
    { text: entry.status === "running" ? "" : formatTokens(entry.callTokens), width: 7 },
    {
      text: entry.status === "running" ? "" : `${entry.measured ? "" : "~"}${formatTokens(entry.resultTokens)}`,
      width: 8,
    },
    { text: entry.ended === undefined ? "" : formatMs(entry.ended - entry.started), width: 7 },
    { text: entry.status === "running" ? "…" : entry.status === "error" ? "✗" : "", width: 2, align: "left" },
  ]
  const filters = () =>
    [
      `scope ${scopeWords[settings().scope === "session" && sessionID() === undefined ? "project" : settings().scope]}`,
      `window ${settings().window}`,
      ...(settings().agent === undefined ? [] : [`agent ${settings().agent}`]),
      ...(settings().tool === undefined ? [] : [`tool ${settings().tool}`]),
      ...(settings().model === undefined ? [] : [`model ${settings().model}`]),
      ...(settings().errors ? ["failed only"] : []),
      `order ${settings().sort}`,
      ...(compareLabel(settings(), report()?.marks ?? []) === undefined
        ? []
        : [`compare ${compareLabel(settings(), report()?.marks ?? [])}`]),
      ...(drills().length > 0 ? [`drilled ${drills().length} (⌫ back)`] : []),
    ].join(" · ")

  const GroupRows = () => (
    <For each={rows.groups}>
      {(group, index) => {
        if (groupMountLog.enabled) groupMountLog.keys.push(group.key)
        return (
          <Cells
            cells={groupCells(group)}
            background={
              index() === selected() && props.active()
                ? theme().background.action.primary.focused
                : theme().background.action.primary.base
            }
            fg={
              index() === selected() && props.active()
                ? theme().text.action.primary.focused
                : group.errors > 0 && group.errors === group.calls
                  ? theme().text.feedback.error.base
                  : theme().text.base
            }
            onSelect={() => setSelected(index())}
          />
        )
      }}
    </For>
  )

  return (
    <box
      flexDirection="column"
      flexGrow={props.full ? 1 : 0}
      height={props.full ? undefined : TOOLS_BODY_ROWS}
      paddingLeft={1}
      paddingRight={1}
      minWidth={0}
    >
      <Show when={props.full}>
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexGrow={1}>
            Tools
          </text>
          <text fg={theme().text.muted}>tools and tokens, live</text>
        </box>
      </Show>
      <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={0}>
        {filters()}
      </text>
      <Show when={failure()}>
        {(message) => <text fg={theme().text.feedback.error.base}>{`tools unavailable: ${message()}`}</text>}
      </Show>
      <Show when={report()} fallback={<text fg={theme().text.muted}>{failure() === undefined ? "Loading…" : ""}</text>}>
        {(current) => (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme().text.base} wrapMode="none" truncate>
              {totalsLine(current().totals)}
            </text>
            <Show when={props.full}>
              <text fg={theme().text.base} wrapMode="none" truncate>
                {`${toolLine(current().totals)}${current().compare === undefined ? "" : `   (before: ${current().compare?.totals.calls} calls, result ${formatTokens(current().compare?.totals.resultTokens ?? 0)})`}`}
              </text>
            </Show>
            <Show
              when={groups().length > 0}
              fallback={
                <text
                  fg={theme().text.muted}
                >{`No tool calls ${settings().scope === "session" ? "in this chat" : "here"} yet${settings().window === "all" ? "" : ` in the last ${settings().window}`}.`}</text>
              }
            >
              <Cells cells={groupCells(undefined)} fg={theme().text.muted} bold />
              <Show
                when={props.full}
                fallback={
                  <scrollbox
                    height={COMPOSER_GROUP_ROWS}
                    scrollbarOptions={{ visible: false }}
                    ref={(next: ScrollBoxRenderable) => (scroll = next)}
                  >
                    <GroupRows />
                  </scrollbox>
                }
              >
                <GroupRows />
              </Show>
            </Show>
            <Show when={props.full && rows.feed.length > 0}>
              <text fg={theme().text.muted} wrapMode="none" attributes={TextAttributes.BOLD}>
                {"latest calls"}
              </text>
              <For each={rows.feed}>
                {(entry) => (
                  <Cells
                    cells={feedCells(entry)}
                    fg={
                      entry.status === "error"
                        ? theme().text.feedback.error.base
                        : entry.status === "running"
                          ? theme().text.feedback.info.base
                          : theme().text.muted
                    }
                  />
                )}
              </For>
            </Show>
          </box>
        )}
      </Show>
      <Show when={props.full}>
        <box flexGrow={1} />
        <text fg={theme().text.muted} wrapMode="word" flexShrink={0}>
          {
            "call = output spent writing the call · result = what it added to the next prompt (~ estimated) · carried = result re-read by later steps until compaction · +n = Code Mode calls inside execute · * running"
          }
        </text>
        <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={0}>
          {
            "↑↓ row · ⏎ drill in · ⌫/esc back · g group · s scope · t window · o order · a agent · f tool · F model · x failed · c compare · m mark"
          }
        </text>
      </Show>
    </box>
  )
}

interface Cell {
  readonly text: string
  /** Fixed width; absent for the one column that takes the remaining width. */
  readonly width?: number
  readonly grow?: boolean
  readonly align?: "left" | "right"
}

function Cells(props: {
  readonly cells: readonly Cell[]
  readonly fg: RGBA
  readonly background?: RGBA
  readonly bold?: boolean
  readonly onSelect?: () => void
}) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      minWidth={0}
      {...(props.background === undefined ? {} : { backgroundColor: props.background })}
      onMouseUp={() => props.onSelect?.()}
    >
      <For each={props.cells}>
        {(cell) =>
          cell.grow === true ? (
            <text
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              paddingRight={1}
              wrapMode="none"
              truncate
              fg={props.fg}
              attributes={props.bold ? TextAttributes.BOLD : undefined}
            >
              {cell.text}
            </text>
          ) : (
            <text
              flexShrink={0}
              width={cell.width}
              wrapMode="none"
              fg={props.fg}
              attributes={props.bold ? TextAttributes.BOLD : undefined}
            >
              {`${pad(cell.text, (cell.width ?? 1) - 1, cell.align ?? "right")} `}
            </text>
          )
        }
      </For>
    </box>
  )
}

function withoutKey(settings: MonitorSettings, key: "agent" | "tool" | "model"): MonitorSettings {
  return Object.fromEntries(Object.entries(settings).filter(([name]) => name !== key)) as unknown as MonitorSettings
}
