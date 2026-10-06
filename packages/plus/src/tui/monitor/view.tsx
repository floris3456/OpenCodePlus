import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
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
  filterReport,
  formatClock,
  formatTokens,
  GROUPS,
  queryOf,
  SCOPES,
  scopeWords,
  SORTS,
  TABS,
  totalsLine,
  totalsLines,
  windowLabels,
  WINDOWS,
  type Drill,
  type MonitorSettings,
  type TabName,
} from "./format.js"
import { MonitorHelp } from "./help.js"
import { openSessionPicker } from "./session-picker.js"
import { CacheTab } from "./tabs/cache.js"
import { OverviewTab } from "./tabs/overview.js"
import { SessionsTab } from "./tabs/sessions.js"
import { StepsTab } from "./tabs/steps.js"
import { groupMountLog, resetGroupMountLog, stopGroupMountLog, ToolsTab } from "./tabs/tools.js"

export { groupMountLog, resetGroupMountLog, stopGroupMountLog }
export const TOOLS_BODY_ROWS = 10
const COMPOSER_GROUP_ROWS = TOOLS_BODY_ROWS - 3
const COMPOSER_GROUP_FETCH = COMPOSER_GROUP_ROWS + 4

const REFRESH_MS = 1_000
const IDLE_REFRESH_MS = 5_000
const LIVE_FOR_MS = 60_000

export function refreshInterval(report: Plus.MonitorReport | undefined): number {
  if (report === undefined) return REFRESH_MS
  // Take the newest timestamp available anywhere: the newest tool feed entry,
  // the last (newest) request, or the newest ping. `requests` is oldest-first,
  // so its newest row is the last one. Reading only the first request would
  // treat a live ping or a fresh request as idle whenever an older feed exists.
  const latest = Math.max(
    report.feed[0]?.started ?? 0,
    report.requests?.at(-1)?.at ?? 0,
  )
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

export function createMonitorSettings(
  context: Plugin.Context,
  defaultScope: Plus.MonitorScope = "session",
  storageKey = "monitor",
) {
  const initial = { ...defaultSettings, scope: defaultScope }
  const [stored, update] = context.storage.store<{ settings: MonitorSettings }>(storageKey, {
    initial: { settings: initial },
  })
  const [local, setLocal] = createSignal<MonitorSettings>({
    ...defaultSettings,
    ...stored.settings,
    scope: stored.settings?.scope ?? defaultScope,
  })
  createEffect(() => {
    const s = stored.settings
    if (s !== undefined) {
      setLocal({
        ...defaultSettings,
        ...s,
        scope: s.scope ?? defaultScope,
      })
    }
  })
  return {
    settings: (): MonitorSettings => local(),
    set: (next: MonitorSettings) => {
      setLocal(next)
      void update((draft) => {
        draft.settings = next
      })
    },
  }
}

export function MonitorView(props: MonitorViewProps) {
  const theme = () => props.context.theme
  const plus = props.context.client.rpc(Definition)
  const dimensions = useTerminalDimensions()
  const defaultScope = props.full ? "session" : "tree"
  const store = createMonitorSettings(props.context, defaultScope, props.full ? "monitor" : "monitor-composer")
  const [drills, setDrills] = createSignal<readonly Drill[]>([])
  const [helpOpen, setHelpOpen] = createSignal(false)

  // Drill-downs are temporary and do not rewrite stored settings.
  const settings = () => drills().at(-1)?.settings ?? store.settings()
  const activeDrill = () => drills().at(-1)

  // The compact composer body always renders Tools, whatever tab the shared
  // full-page settings happen to hold.
  const tab = () => (props.full ? settings().tab : "tools")

  const sessionID = () => {
    const drilled = drills().findLast((drill) => drill.sessionID !== undefined)
    return drilled?.sessionID ?? props.sessionID()
  }

  const [report, setReport] = createSignal<Plus.MonitorReport | undefined>()
  const [failure, setFailure] = createSignal<string | undefined>()
  const [selected, setSelected] = createSignal(0)
  const scrolls: Partial<Record<TabName, ScrollBoxRenderable>> = {}

  const [rows, setRows] = createStore<{
    groups: readonly Plus.MonitorGroup[]
    feed: readonly Plus.MonitorCall[]
  }>({ groups: [], feed: [] })

  const top = () =>
    props.full ? Math.max(5, Math.floor((dimensions().height - 12) * 0.55)) : COMPOSER_GROUP_FETCH
  const feed = () => (props.full ? Math.max(3, dimensions().height - 12 - top()) : 0)

  const location = () => {
    const current = props.context.location
    if (current !== undefined) return { directory: current.directory, workspace: current.workspaceID }
    const fallback = props.context.data.location.default()
    return fallback === undefined ? undefined : { directory: fallback.directory, workspace: fallback.workspaceID }
  }

  const flight = { busy: false, again: false, generation: 0 }
  const refresh = () => {
    if (flight.busy) {
      flight.again = true
      return
    }
    flight.busy = true
    const generation = ++flight.generation
    const query = queryOf({ ...settings(), tab: tab() }, {
      sessionID: sessionID(),
      now: Date.now(),
      marks: report()?.marks ?? [],
      top: top(),
      feed: feed(),
      id: activeDrill()?.requestID,
    })
    void plus["monitor.query"](query, { location: location() })
      .then(
        (next) => {
          if (generation !== flight.generation) return
          // Compute maxIdx from the FILTERED view so the selection always points
          // at an actually-visible row; the text filter drops rows independently
          // of the server query and must not leave the selector past the end.
          const shown = filterReport(next, settings().filterText)
          const maxIdx = Math.max(
            0,
            (!props.full || tab() === "tools"
              ? shown.groups.length
              : tab() === "cache"
                ? (shown.requests?.length ?? 0)
                : tab() === "sessions"
                  ? (shown.sessions?.length ?? 0)
                  : (shown.requests?.length ?? 0)) - 1,
          )
          setReport(next)
          setFailure(undefined)
          setSelected((index) => Math.min(index, maxIdx))
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
    settings()
    sessionID()
    top()
    feed()
    activeDrill()
    if (props.active()) refresh()
  })

  const pace = createMemo(() => refreshInterval(report()))
  createEffect(() => {
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

  const setTab = (next: TabName) => {
    if (!props.full) return
    setSelected(0)
    change({ ...settings(), tab: next })
  }

  // Every rendered table follows the text filter; totals stay the real query.
  const shown = createMemo(() => {
    const current = report()
    return current === undefined ? undefined : filterReport(current, settings().filterText)
  })

  const groups = createMemo((): readonly Plus.MonitorGroup[] => {
    const current = shown()
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
  createEffect(() => setRows("feed", reconcile(shown()?.feed ?? [], { key: "callID" })))

  // Scroll the selected row into view, but only when the selection (or tab)
  // moved — a poll returns a fresh report every second and must not yank a
  // user who scrolled the list away from the selection.
  let lastFollowed: { tab: TabName; index: number } | undefined
  createEffect(() => {
    const current = tab()
    const count =
      current === "tools"
        ? rows.groups.length
        : current === "cache" || current === "steps"
          ? (shown()?.requests?.length ?? 0)
          : current === "sessions"
            ? (shown()?.sessions?.length ?? 0)
            : 0
    const index = Math.min(selected(), Math.max(0, count - 1))
    if (count === 0) {
      lastFollowed = undefined
      return
    }
    if (lastFollowed?.tab === current && lastFollowed.index === index) return
    lastFollowed = { tab: current, index }
    const scroll = scrolls[current]
    if (scroll === undefined) return
    if (index >= scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(index - scroll.viewport.height + 1)
    if (index < scroll.scrollTop) scroll.scrollTo(index)
  })

  const pickFilter = async (dimension: "agent" | "tool" | "model") => {
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

  const pickTeam = async () => {
    const teams = report()?.teams ?? []
    const choice = await props.context.ui.dialog.select<string>({
      title: "Choose team",
      placeholder: "Select team to scope…",
      options: [
        { title: "No team filter", value: "" },
        ...teams.map((t) => ({ title: t, value: t })),
      ],
    })
    props.context.ui.dialog.clear()
    if (choice === undefined) return
    if (choice === "") {
      change({ ...settings(), scope: "project", team: undefined })
    } else {
      change({ ...settings(), scope: "team", team: choice })
    }
  }

  // The picker always lists every session in the project, grouped by team
  // tree, no matter which tab opened it or what the page is scoped to.
  const openPicker = () => {
    void plus["monitor.query"]({ scope: "all", view: "sessions" }, { location: location() }).then(
      (all) =>
        openSessionPicker(props.context, all.sessions, (picked) => {
          // The picked session is a temporary drill; the stored scope stays.
          setSelected(0)
          setDrills((stack) => [...stack, { settings: { ...settings(), scope: "session" }, sessionID: picked }])
        }),
      (error: unknown) =>
        props.context.ui.toast.show({
          variant: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
    )
  }

  const mark = async () => {
    const label = await props.context.ui.dialog.prompt({
      title: "Mark this moment",
      description: "Compare before and after it with c (compare: mark).",
      placeholder: "e.g. before prompt change",
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

  const filterTextPrompt = async () => {
    const text = await props.context.ui.dialog.prompt({
      title: "Filter by text",
      placeholder: "e.g. read, shell, error…",
    })
    props.context.ui.dialog.clear()
    if (text !== undefined) {
      change({ ...settings(), filterText: text.trim() === "" ? undefined : text.trim() })
    }
  }

  const drill = () => {
    const current = tab()
    if (current === "tools") {
      const group = groups()[selected()]
      if (group === undefined) return
      const next = drillInto(settings(), group)
      if (next === undefined) return
      setSelected(0)
      setDrills((stack) => [...stack, { ...next, kind: "tools" }])
      return
    }
    if (current === "cache") {
      const requests = shown()?.requests ?? []
      const req = requests[selected()]
      if (req === undefined) return
      setDrills((stack) => [...stack, { kind: "cache", settings: settings(), requestID: req.id }])
      return
    }
    if (current === "steps") {
      const requests = shown()?.requests ?? []
      const req = requests[selected()]
      if (req === undefined) return
      setDrills((stack) => [...stack, { kind: "steps", settings: settings(), requestID: req.id }])
      return
    }
    if (current === "sessions") {
      const s = shown()?.sessions?.[selected()]
      if (s === undefined) return
      // Scope to the session as a temporary drill: the stored preference and
      // the original filters stay untouched, so Esc restores exactly.
      setSelected(0)
      setDrills((stack) => [...stack, { settings: { ...settings(), scope: "session" }, sessionID: s.sessionID }])
      return
    }
  }

  const back = () => {
    if (helpOpen()) {
      setHelpOpen(false)
      return
    }
    if (drills().length > 0) {
      setSelected(0)
      setDrills((stack) => stack.slice(0, -1))
      return
    }
    props.onClose()
  }

  props.context.keymap.layer(() => ({
    ...(props.mode === undefined ? {} : { mode: props.mode }),
    enabled: () => props.active(),
    priority: 1,
    commands: [
      {
        bind: "up,k",
        title: "Previous row",
        group: "Monitor",
        run: () => {
          if (selected() === 0 && !props.full) return props.onClose()
          setSelected((index) => Math.max(0, index - 1))
        },
      },
      {
        bind: "down,j",
        title: "Next row",
        group: "Monitor",
        run: () => {
          const maxIdx = Math.max(
            0,
            (!props.full || tab() === "tools"
              ? groups().length
              : tab() === "cache"
                ? (shown()?.requests?.length ?? 0)
                : tab() === "sessions"
                  ? (shown()?.sessions?.length ?? 0)
                  : (shown()?.requests?.length ?? 0)) - 1,
          )
          setSelected((index) => Math.min(maxIdx, index + 1))
        },
      },
      { bind: "return", title: "Drill into row", group: "Monitor", run: drill },
      { bind: "backspace", title: "Back", group: "Monitor", run: back },
      { bind: "escape", title: "Back or close", group: "Monitor", run: back },
      {
        bind: "1",
        title: "Overview tab",
        group: "Monitor",
        run: () => setTab("overview"),
      },
      {
        bind: "2",
        title: "Cache tab",
        group: "Monitor",
        run: () => setTab("cache"),
      },
      {
        bind: "3",
        title: "Tools tab",
        group: "Monitor",
        run: () => setTab("tools"),
      },
      {
        bind: "4",
        title: "Sessions tab",
        group: "Monitor",
        run: () => setTab("sessions"),
      },
      {
        bind: "5",
        title: "Steps tab",
        group: "Monitor",
        run: () => setTab("steps"),
      },
      {
        bind: "tab",
        title: "Next tab",
        group: "Monitor",
        run: () => setTab(cycle(TABS, settings().tab, 1)),
      },
      {
        bind: "shift+tab",
        title: "Previous tab",
        group: "Monitor",
        run: () => setTab(cycle(TABS, settings().tab, -1)),
      },
      {
        bind: "s",
        title: "Scope",
        group: "Monitor",
        run: () => change({ ...settings(), scope: cycle(SCOPES, settings().scope) }),
      },
      {
        bind: "shift+s",
        title: "Session picker",
        group: "Monitor",
        run: () => openPicker(),
      },
      {
        bind: "shift+t",
        title: "Team picker",
        group: "Monitor",
        run: () => void pickTeam(),
      },
      {
        bind: "t",
        title: "Time window",
        group: "Monitor",
        run: () => change({ ...settings(), window: cycle(WINDOWS, settings().window) }),
      },
      {
        bind: "g",
        title: "Group by",
        group: "Monitor",
        run: () => change({ ...settings(), group: cycle(GROUPS, settings().group) }),
      },
      {
        bind: "o",
        title: "Order by",
        group: "Monitor",
        run: () => change({ ...settings(), sort: cycle(SORTS, settings().sort) }),
      },
      {
        bind: "c",
        title: "Compare",
        group: "Monitor",
        run: () => change({ ...settings(), compare: cycle(COMPARES, settings().compare) }),
      },
      {
        bind: "x",
        title: "Toggle filter",
        group: "Monitor",
        run: () => {
          if (tab() === "cache") {
            change({ ...settings(), missesOnly: !settings().missesOnly })
          } else {
            change({ ...settings(), errors: !settings().errors })
          }
        },
      },
      {
        bind: "space",
        title: "Scope to session tree",
        group: "Monitor",
        run: () => {
          if (tab() === "sessions") {
            const s = shown()?.sessions?.[selected()]
            if (s !== undefined) {
              // Temporary tree drill: the stored scope/filters never change.
              setSelected(0)
              setDrills((stack) => [...stack, { settings: { ...settings(), scope: "tree" }, sessionID: s.sessionID }])
            }
          }
        },
      },
      { bind: "a", title: "Filter by agent", group: "Monitor", run: () => void pickFilter("agent") },
      { bind: "f", title: "Filter by tool", group: "Monitor", run: () => void pickFilter("tool") },
      { bind: "shift+f", title: "Filter by model", group: "Monitor", run: () => void pickFilter("model") },
      { bind: "slash,/", title: "Filter by text", group: "Monitor", run: () => void filterTextPrompt() },
      { bind: "m", title: "Mark moment", group: "Monitor", run: () => void mark() },
      {
        bind: "question,?",
        title: "Help",
        group: "Monitor",
        run: () => setHelpOpen((prev) => !prev),
      },
      ...(props.onOpenFull === undefined
        ? []
        : [{ bind: "shift+m,M", title: "Open full monitor", group: "Monitor", run: () => props.onOpenFull?.() }]),
    ],
  }))

  const activeFiltersLine = () => {
    const parts = [
      ...(settings().agent !== undefined ? [`agent ${settings().agent}`] : []),
      ...(settings().tool !== undefined ? [`tool ${settings().tool}`] : []),
      ...(settings().model !== undefined ? [`model ${settings().model}`] : []),
      ...(settings().filterText !== undefined ? [`filter “${settings().filterText}”`] : []),
      ...(settings().errors ? ["failed only"] : []),
      ...(settings().missesOnly ? ["misses only"] : []),
      `order ${settings().sort}`,
      ...(compareLabel(settings(), report()?.marks ?? []) === undefined
        ? []
        : [`compare ${compareLabel(settings(), report()?.marks ?? [])}`]),
    ]
    return parts.join(" · ")
  }

  const scopeLabel = () => {
    const s = settings().scope
    // A session or tree scope with no chat open reads the project, so say so.
    const effective = (s === "session" || s === "tree") && sessionID() === undefined ? "project" : s
    const name = scopeWords[effective] ?? effective
    if (effective === "session" && sessionID() !== undefined) {
      return `${name} (${sessionID()!.slice(0, 10)})`
    }
    if (effective === "team" && settings().team !== undefined) {
      return `${name}: ${settings().team}`
    }
    return name
  }

  const windowLabelText = () => windowLabels[settings().window] ?? settings().window

  const hintBarText = (width: number) => {
    // The hint bar is always one line and must stay readable at 80 columns,
    // so narrow terminals get shorter labels instead of a truncated line.
    const narrow = width < 100
    switch (settings().tab) {
      case "overview":
        return narrow
          ? "[1-5] tabs · [s] scope · [t] window · [S] [T] · [?] help · [esc]"
          : "[1-5] tabs · [s] scope · [t] window · [S] session · [T] team · [?] help · [esc] close"
      case "cache":
        return narrow
          ? "[↑↓] select · [⏎] detail · [x] misses · [s] scope · [t] window · [?] help · [esc]"
          : "[↑↓] select · [⏎] detail · [x] misses only · [s] scope · [t] window · [?] help · [esc] close"
      case "tools":
        return narrow
          ? "[↑↓] · [⏎] drill · [g] group · [o] sort · [a/f/F] filter · [x] fail · [c] [m] [?]"
          : "[↑↓] select · [⏎] drill · [g] group · [o] sort · [a/f/F] filter · [x] fail · [c] compare · [m] mark · [?] help"
      case "sessions":
        return narrow
          ? "[↑↓] · [⏎] session · [space] tree · [s] scope · [t] window · [?] help · [esc]"
          : "[↑↓] select · [⏎] scope session · [space] scope tree · [s] scope · [t] window · [?] help · [esc] close"
      case "steps":
        return narrow
          ? "[↑↓] · [⏎] calls & diff · [s] scope · [t] window · [?] help · [esc]"
          : "[↑↓] select · [⏎] step calls & diff · [s] scope · [t] window · [?] help · [esc] close"
    }
  }

  // Composer compact mode renders just the Tools tab
  if (!props.full) {
    const composerFilters = () =>
      [
        `scope ${settings().scope === "session" && sessionID() === undefined ? "project" : settings().scope}`,
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

    return (
      <box
        flexDirection="column"
        height={TOOLS_BODY_ROWS}
        paddingLeft={1}
        paddingRight={1}
        minWidth={0}
      >
        <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={0}>
          {composerFilters()}
        </text>
        <Show when={failure()}>
          {(message) => <text fg={theme().text.feedback.error.base}>{`tools unavailable: ${message()}`}</text>}
        </Show>
        <Show when={report()} fallback={<text fg={theme().text.muted}>{failure() === undefined ? "Loading…" : ""}</text>}>
          {(current) => (
            <box flexDirection="column" flexShrink={0}>
              <text fg={theme().text.base} wrapMode="none" truncate>
                {totalsLine(current().totals, dimensions().width)}
              </text>
              <ToolsTab
                context={props.context}
                report={report()}
                settings={settings()}
                selectedIndex={selected()}
                onSelect={setSelected}
                full={false}
                active={props.active()}
                groups={rows.groups}
                feed={rows.feed}
                onScrollRef={(ref) => (scrolls.tools = ref)}
              />
            </box>
          )}
        </Show>
      </box>
    )
  }

  // Full-screen Monitor page
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingLeft={1}
      paddingRight={1}
      minWidth={0}
      backgroundColor={theme().background.base}
    >
      {/* Title */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexGrow={1}>
          Monitor
        </text>
        <text fg={theme().text.muted}>tokens, cache and tools</text>
      </box>

      {/* Scope Line */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          Scope:{" "}
        </text>
        <text fg={theme().text.action.primary.focused} attributes={TextAttributes.BOLD}>
          {scopeLabel()}
        </text>
        <text fg={theme().text.muted}>   [s] step · [S] session · [T] team</text>
      </box>

      {/* When Line */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          When:{" "}
        </text>
        <text fg={theme().text.action.primary.focused} attributes={TextAttributes.BOLD}>
          {windowLabelText()}
        </text>
        <text fg={theme().text.muted}>   [t] step window</text>
      </box>

      {/* Active filters / compare / order line */}
      <Show when={activeFiltersLine()}>
        {(text) => (
          <box flexDirection="row" flexShrink={0}>
            <text fg={theme().text.muted} wrapMode="none" truncate>
              {text()}
            </text>
          </box>
        )}
      </Show>

      {/* Totals: every metric, labelled, wrapped at this width */}
      <Show when={report()}>
        {(current) => (
          <box flexDirection="column" flexShrink={0} marginTop={0}>
            <For each={totalsLines(current().totals, dimensions().width)}>
              {(line) => (
                <text fg={theme().text.base} wrapMode="none" truncate>
                  {line}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>

      {/* Tab bar */}
      <box flexDirection="row" flexShrink={0} marginTop={1} marginBottom={1}>
        <For each={TABS}>
          {(tab, index) => {
            const isActive = () => settings().tab === tab
            const label = `[${index() + 1} ${tab.charAt(0).toUpperCase() + tab.slice(1)}]`
            return (
              <box
                backgroundColor={isActive() ? theme().background.action.primary.focused : undefined}
                marginRight={1}
                onMouseUp={() => setTab(tab)}
              >
                <text
                  fg={isActive() ? theme().text.action.primary.focused : theme().text.muted}
                  attributes={isActive() ? TextAttributes.BOLD : undefined}
                >
                  {label}
                </text>
              </box>
            )
          }}
        </For>
        <box flexGrow={1} />
        <Show when={drills().length > 0}>
          <text fg={theme().text.feedback.info.base}>
            {`drilled ${drills().length} (⌫ back)`}
          </text>
        </Show>
      </box>

      {/* Failure message */}
      <Show when={failure()}>
        {(message) => (
          <text fg={theme().text.feedback.error.base} flexShrink={0}>
            {`monitor unavailable: ${message()}`}
          </text>
        )}
      </Show>

      {/* Tab Contents or Help */}
      <Show
        when={!helpOpen()}
        fallback={<MonitorHelp context={props.context} onClose={() => setHelpOpen(false)} />}
      >
        <Show
          when={report()}
          fallback={<text fg={theme().text.muted}>{failure() === undefined ? "Loading monitor data…" : ""}</text>}
        >
          {(_current) => (
            <box flexDirection="column" flexGrow={1} minWidth={0}>
              <Show when={tab() === "overview"}>
                <scrollbox flexGrow={1} minWidth={0}>
                  <OverviewTab context={props.context} report={shown()} full={true} />
                </scrollbox>
              </Show>
              <Show when={tab() === "cache"}>
                <CacheTab
                  context={props.context}
                  report={shown()}
                  selectedIndex={selected()}
                  onSelect={setSelected}
                  detailID={activeDrill()?.requestID}
                  missesOnly={settings().missesOnly}
                  active={props.active()}
                  onScrollRef={(ref) => (scrolls.cache = ref)}
                />
              </Show>
              <Show when={tab() === "tools"}>
                <ToolsTab
                  context={props.context}
                  report={shown()}
                  settings={settings()}
                  selectedIndex={selected()}
                  onSelect={setSelected}
                  full={true}
                  active={props.active()}
                  groups={rows.groups}
                  feed={rows.feed}
                  onScrollRef={(ref) => (scrolls.tools = ref)}
                />
              </Show>
              <Show when={tab() === "sessions"}>
                <SessionsTab
                  context={props.context}
                  report={shown()}
                  selectedIndex={selected()}
                  onSelect={setSelected}
                  onScopeSession={(sid) => {
                    setSelected(0)
                    setDrills((stack) => [...stack, { settings: { ...settings(), scope: "session" }, sessionID: sid }])
                  }}
                  onScopeTree={(sid) => {
                    setSelected(0)
                    setDrills((stack) => [...stack, { settings: { ...settings(), scope: "tree" }, sessionID: sid }])
                  }}
                  active={props.active()}
                  onScrollRef={(ref) => (scrolls.sessions = ref)}
                />
              </Show>
              <Show when={tab() === "steps"}>
                <StepsTab
                  context={props.context}
                  report={shown()}
                  selectedIndex={selected()}
                  onSelect={setSelected}
                  detailID={activeDrill()?.requestID}
                  active={props.active()}
                  onScrollRef={(ref) => (scrolls.steps = ref)}
                />
              </Show>
            </box>
          )}
        </Show>
      </Show>

      {/* Always-visible Hint Bar */}
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text fg={theme().text.muted} wrapMode="none" truncate flexGrow={1}>
          {hintBarText(dimensions().width)}
        </text>
      </box>
    </box>
  )
}

function withoutKey(settings: MonitorSettings, key: "agent" | "tool" | "model"): MonitorSettings {
  return Object.fromEntries(Object.entries(settings).filter(([name]) => name !== key)) as unknown as MonitorSettings
}
