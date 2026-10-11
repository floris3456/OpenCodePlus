import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Definition, type Plus } from "../../rpc.js"
import {
  COMPARES,
  cacheRequests,
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
  sessionDrill,
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
  const latest = Math.max(report.feed[0]?.started ?? 0, report.requests?.at(-1)?.at ?? 0)
  return report.totals.running > 0 || report.now - latest < LIVE_FOR_MS ? REFRESH_MS : IDLE_REFRESH_MS
}

export interface MonitorViewProps {
  readonly context: Plugin.Context
  /** The chat the session scope follows; absent outside a chat. */
  readonly sessionID: () => string | undefined
  /** Visible and focused: only then does it poll and own its keys. */
  readonly active: () => boolean
  readonly full: boolean
  /** Open a full-page chat monitor with a temporary session selection. */
  readonly initialSession?: boolean
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
  const initialSessionID = props.initialSession ? props.sessionID() : undefined
  const [drills, setDrills] = createSignal<readonly Drill[]>(
    initialSessionID === undefined
      ? []
      : [{
          settings: { ...store.settings(), scope: "session", sessionIDs: [initialSessionID] },
          sessionID: initialSessionID,
        }],
  )
  const [helpOpen, setHelpOpen] = createSignal(false)

  // Drill-downs are temporary and do not rewrite stored settings.
  const settings = () => drills().at(-1)?.settings ?? (
    props.initialSession && (store.settings().scope === "session" || store.settings().scope === "tree")
      ? { ...store.settings(), scope: "project" as const, sessionIDs: undefined }
      : store.settings()
  )
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
  const [requestPage, setRequestPage] = createSignal<Plus.MonitorQueryInput["requestPage"]>()
  const [pages, setPages] = createSignal<Plus.MonitorQueryInput["pages"]>()
  const [collection, setCollection] = createSignal<Plus.MonitorPageSection>()
  const [fullText, setFullText] = createSignal(false)
  const pageTarget = () =>
    collection() ??
    (activeDrill()?.requestID
      ? "detail.segments"
      : tab() === "sessions"
        ? "sessions"
        : tab() === "overview"
          ? "agents"
          : undefined)
  const metadata = () => {
    const target = pageTarget()
    return target ? (report()?.pages?.[target] ?? report()?.facets.pages?.[target]) : undefined
  }
  const pageScope = createMemo(() =>
    JSON.stringify([
      tab(),
      sessionID(),
      settings().scope,
      settings().sessionIDs,
      settings().team,
      settings().window,
      settings().agent,
      settings().model,
      settings().tool,
      settings().errors,
      settings().missesOnly,
    ]),
  )
  createEffect(() => {
    pageScope()
    setRequestPage(undefined)
    setPages(undefined)
    setCollection(undefined)
    setFullText(false)
  })
  createEffect(() => {
    activeDrill()?.requestID
    setPages(undefined)
    setCollection(undefined)
  })
  const scrolls: Partial<Record<TabName, ScrollBoxRenderable>> = {}

  const [rows, setRows] = createStore<{
    groups: readonly Plus.MonitorGroup[]
    feed: readonly Plus.MonitorCall[]
  }>({ groups: [], feed: [] })

  const top = () => (props.full ? Math.max(5, Math.floor((dimensions().height - 12) * 0.55)) : COMPOSER_GROUP_FETCH)
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
    const query = queryOf(
      { ...settings(), tab: tab() },
      {
        sessionID: sessionID(),
        now: Date.now(),
        marks: report()?.marks ?? [],
        top: top(),
        feed: feed(),
        id: activeDrill()?.requestID,
      },
    )
    void plus["monitor.query"](
      { ...query, requestPage: requestPage(), pages: pages(), fullText: fullText() },
      { location: location() },
    )
      .then(
        (next) => {
          if (generation !== flight.generation) return
          // Compute maxIdx from the FILTERED view so the selection always points
          // at an actually-visible row; the text filter drops rows independently
          // of the server query and must not leave the selector past the end.
          const filtered = filterReport(next, settings().filterText)
          const maxIdx = Math.max(
            0,
            (!props.full || tab() === "tools"
              ? filtered.groups.length
              : tab() === "cache"
                ? (filtered.requests?.length ?? 0)
                : tab() === "sessions"
                  ? (filtered.sessions?.length ?? 0)
                  : (filtered.requests?.length ?? 0)) - 1,
          )
          // The Cache tab shows newest first, so a new request arrives at the
          // top and shifts every row down. Remember the selected request's id
          // so the selection follows the same request instead of its old row.
          const previousID =
            props.full && (tab() === "cache" || tab() === "steps" || tab() === "sessions")
              ? tab() === "sessions"
                ? shown()?.sessions?.[selected()]?.sessionID
                : (tab() === "cache" ? cacheRequests(shown(), settings().missesOnly) : (shown()?.requests ?? []))[
                    selected()
                  ]?.id
              : undefined
          setReport(next)
          setFailure(undefined)
          setSelected((index) => {
            if (previousID !== undefined) {
              const at =
                tab() === "sessions"
                  ? (filtered.sessions ?? []).findIndex((r) => r.sessionID === previousID)
                  : (tab() === "cache"
                      ? cacheRequests(filtered, settings().missesOnly)
                      : (filtered.requests ?? [])
                    ).findIndex((request) => request.id === previousID)
              if (at !== -1) return at
            }
            return Math.min(index, maxIdx)
          })
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
    requestPage()
    pages()
    fullText()
    flight.generation++
    if (props.active()) untrack(refresh)
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
    const target = dimension === "agent" ? "facets.agents" : dimension === "tool" ? "facets.tools" : "facets.models"
    const query = {
      ...queryOf(settings(), {
        sessionID: sessionID(),
        now: Date.now(),
        marks: report()?.marks ?? [],
        top: 0,
        feed: 0,
      }),
      until: Date.now(),
    }
    let current = report()
    while (true) {
      const facets = current?.facets
      const values = dimension === "agent" ? facets?.agents : dimension === "tool" ? facets?.tools : facets?.models
      const page = facets?.pages?.[target]
      const choice = await props.context.ui.dialog.select<string>({
        title: `Show one ${dimension}`,
        placeholder: `Filter by ${dimension} (search this page)`,
        current: settings()[dimension] ?? "",
        options: [
          { title: `Every ${dimension}`, value: "" },
          ...(values ?? [])
            .filter((value) => value !== settings()[dimension])
            .map((value) => ({ title: value, value })),
          ...(page?.previous ? [{ title: "Previous page", value: "\0previous" }] : []),
          ...(page?.next ? [{ title: "Next page", value: "\0next" }] : []),
        ],
      })
      props.context.ui.dialog.clear()
      if (choice === undefined) return
      if (choice === "\0next" || choice === "\0previous") {
        const cursor = choice === "\0next" ? page?.next : page?.previous
        if (!cursor) return
        current = await plus["monitor.query"]({ ...query, pages: { [target]: { cursor } } }, { location: location() })
        continue
      }
      const next = { ...settings() }
      if ((choice || undefined) === next[dimension]) return
      change(choice === "" ? withoutKey(next, dimension) : { ...next, [dimension]: choice })
      return
    }
  }

  const pickTeam = async () => {
    let current = report()
    while (true) {
      const page = current?.pages?.teams
      const choice = await props.context.ui.dialog.select<string>({
        title: "Choose team",
        placeholder: "Select team to scope (search this page)…",
        options: [
          { title: "No team filter", value: "" },
          ...(current?.teams ?? [])
            .filter((t) => t !== settings().team)
            .map((t) => ({ title: t, value: t })),
          ...(page?.previous ? [{ title: "Previous page", value: "\0previous" }] : []),
          ...(page?.next ? [{ title: "Next page", value: "\0next" }] : []),
        ],
      })
      props.context.ui.dialog.clear()
      if (choice === undefined) return
      if (choice === "\0next" || choice === "\0previous") {
        const cursor = choice === "\0next" ? page?.next : page?.previous
        if (!cursor) return
        current = await plus["monitor.query"](
          { scope: "all", view: "sessions", pages: { teams: { cursor } }, fullText: true },
          { location: location() },
        )
        continue
      }
      if (choice === settings().team && settings().scope === "team") return
      change(
        choice === ""
          ? { ...settings(), scope: "project", team: undefined }
          : { ...settings(), scope: "team", team: choice },
      )
      return
    }
  }

  // The picker always lists every session in the project, grouped by team
  // tree, no matter which tab opened it or what the page is scoped to.
  const openPicker = () => {
    void plus["monitor.query"]({ scope: "all", view: "sessions" }, { location: location() }).then(
      (all) =>
        openSessionPicker(
          props.context,
          all.sessions,
          (picked) => {
            addSession(picked)
          },
          {
            page: all.pages?.sessions,
            selected: settings().scope === "session"
              ? settings().sessionIDs ?? (sessionID() ? [sessionID()!] : [])
              : [],
            load: async (cursor) => {
              const next = await plus["monitor.query"](
                { scope: "all", view: "sessions", pages: { sessions: { cursor } }, fullText: true },
                { location: location() },
              )
              return { sessions: next.sessions ?? [], page: next.pages?.sessions }
            },
          },
        ),
      (error: unknown) =>
        props.context.ui.toast.show({
          variant: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
    )
  }

  const addSession = (id: string, scope: "session" | "tree" = "session") => {
    const next = sessionDrill(settings(), id, sessionID(), scope)
    if (next === undefined) return
    setSelected(0)
    setDrills((stack) => [...stack, next])
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
      title: "Filter this report page by text (page-local)",
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
      const next = drillInto(settings(), group, sessionID())
      if (next === undefined) return
      setSelected(0)
      setDrills((stack) => [...stack, { ...next, kind: "tools" }])
      return
    }
    if (current === "cache") {
      const req = cacheRequests(shown(), settings().missesOnly)[selected()]
      if (req === undefined || activeDrill()?.requestID === req.id) return
      setDrills((stack) => [...stack, { kind: "cache", settings: settings(), requestID: req.id }])
      return
    }
    if (current === "steps") {
      const requests = shown()?.requests ?? []
      const req = requests[selected()]
      if (req === undefined || activeDrill()?.requestID === req.id) return
      setDrills((stack) => [...stack, { kind: "steps", settings: settings(), requestID: req.id }])
      return
    }
    if (current === "sessions") {
      const s = shown()?.sessions?.[selected()]
      if (s === undefined) return
      // Scope to the session as a temporary drill: the stored preference and
      // the original filters stay untouched, so Backspace restores exactly.
      addSession(s.sessionID)
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
        bind: "p",
        title: "Choose report collection to page",
        group: "Monitor",
        run: () => {
          const names = Object.keys(report()?.pages ?? {}).filter((name) =>
            activeDrill()?.requestID
              ? name.startsWith("detail.")
              : tab() === "sessions"
                ? name === "sessions"
                : tab() === "overview"
                  ? ["agents", "context", "unstable"].includes(name)
                  : false,
          )
          void props.context.ui.dialog
            .select<Plus.MonitorPageSection | "requests">({
              title: "Page report collection (text search is page-local)",
              options: [
                ...(tab() === "cache" || tab() === "steps" ? [{ title: "requests", value: "requests" as const }] : []),
                ...names.map((name) => ({
                  title: `${name}: ${(report()?.pages?.[name] ?? report()?.facets.pages?.[name])?.total ?? 0} rows`,
                  value: name as Plus.MonitorPageSection,
                })),
              ],
            })
            .then((picked) => {
              props.context.ui.dialog.clear()
              if (picked === undefined) return
              setCollection(picked === "requests" ? undefined : picked)
            })
        },
      },
      {
        bind: "v",
        title: "Toggle unabridged selected-page text",
        group: "Monitor",
        run: () => setFullText((value) => !value),
      },
      ...(["older", "newer"] as const).map((direction) => ({
        bind: direction === "older" ? "[" : "]",
        title: `${direction} request page`,
        group: "Monitor",
        run: () => {
          const target = pageTarget()
          if (target) {
            const cursor = direction === "older" ? metadata()?.previous : metadata()?.next
            if (!cursor) return
            setSelected(0)
            setPages((current) => ({ ...current, [target]: { cursor } }))
            return
          }
          if ((tab() !== "cache" && tab() !== "steps") || activeDrill()?.requestID) return
          const cursor = report()?.requestPage?.[direction]
          if (!cursor) return
          setSelected(0)
          setRequestPage({ cursor, direction })
        },
      })),
      {
        bind: "l",
        title: "Reset selected page",
        group: "Monitor",
        run: () => {
          if (pageTarget()) {
            const target = pageTarget()!
            setSelected(0)
            setPages((current) => ({ ...current, [target]: undefined }))
            return
          }
          if (tab() !== "cache" && tab() !== "steps") return
          setSelected(0)
          setRequestPage(undefined)
        },
      },
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
      { bind: "return", title: "Filter by row / open detail", group: "Monitor", run: drill },
      { bind: "backspace", title: "Back", group: "Monitor", run: back },
      { bind: "escape", title: "Close monitor", group: "Monitor", run: () => props.onClose() },
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
        title: "Add session filter",
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
              addSession(s.rootID, "tree")
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
    const ids = settings().sessionIDs
    if ((effective === "session" || effective === "tree") && ids !== undefined && ids.length > 1) {
      return `${ids.length} ${effective === "tree" ? "session trees" : "sessions"} (${ids.map((id) => id.slice(0, 10)).join(", ")})`
    }
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
          ? "[↑↓] · [⏎] filter · [g] group · [o] sort · [a/f/F] filter · [x] fail · [c] [m] [?]"
          : "[↑↓] select · [⏎] filter · [g] group · [o] sort · [a/f/F] filter · [x] fail · [c] compare · [m] mark · [?] help"
      case "sessions":
        return narrow
          ? "[↑↓] · [⏎] session · [space] tree · [s] scope · [t] window · [?] help · [esc]"
          : "[↑↓] select · [⏎] add session · [space] add tree · [S] add session · [s] scope · [?] help · [esc] close"
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
        ...(drills().length > 0 ? [`filters ${drills().length} (⌫ undo)`] : []),
      ].join(" · ")

    return (
      <box flexDirection="column" height={TOOLS_BODY_ROWS} paddingLeft={1} paddingRight={1} minWidth={0}>
        <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={0}>
          {composerFilters()}
        </text>
        <Show when={failure()}>
          {(message) => <text fg={theme().text.feedback.error.base}>{`tools unavailable: ${message()}`}</text>}
        </Show>
        <Show
          when={report()}
          fallback={<text fg={theme().text.muted}>{failure() === undefined ? "Loading…" : ""}</text>}
        >
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
        <text fg={theme().text.muted}> [s] step · [S] add session · [T] team</text>
      </box>

      {/* When Line */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          When:{" "}
        </text>
        <text fg={theme().text.action.primary.focused} attributes={TextAttributes.BOLD}>
          {windowLabelText()}
        </text>
        <text fg={theme().text.muted}> [t] step window</text>
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
      <Show when={metadata()}>
        {(page) => (
          <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={0}>
            {`${page().reset ? "[changed: reset] " : ""}${pageTarget()} ${page().total === 0 ? 0 : page().offset + 1}-${page().offset + page().returned}/${page().total} · text:page-local · [/] page · p select · l first`}
          </text>
        )}
      </Show>
      <Show when={(report()?.presentation?.truncated.length ?? 0) > 0 || fullText()}>
        <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={0}>
          {fullText()
            ? "Unabridged selected-page text · v preview"
            : "Text preview truncated · v unabridged selected-page facts"}
        </text>
      </Show>
      <Show when={(tab() === "cache" || tab() === "steps") && report()?.requestPage}>
        {(page) => (
          <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={0}>
            {`${page().returned}/${page().total} requests · [${page().older ? "[" : "—"}] older · [${page().newer ? "]" : "—"}] newer · [l] latest · text: page-local`}
          </text>
        )}
      </Show>
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
          <text fg={theme().text.muted}>{`filters ${drills().length} (⌫ undo)`}</text>
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
      <Show when={!helpOpen()} fallback={<MonitorHelp context={props.context} onClose={() => setHelpOpen(false)} />}>
        <Show
          when={report()}
          fallback={<text fg={theme().text.muted}>{failure() === undefined ? "Loading monitor data…" : ""}</text>}
        >
          {(_current) => (
            <box flexDirection="column" flexGrow={1} minWidth={0}>
              <Show when={tab() === "overview"}>
                <scrollbox flexGrow={1} minWidth={0}>
                  <OverviewTab context={props.context} report={shown()} full={true} collection={collection()} />
                </scrollbox>
              </Show>
              <Show when={tab() === "cache"}>
                <CacheTab
                  context={props.context}
                  report={shown()}
                  selectedIndex={selected()}
                  onSelect={setSelected}
                  detailID={activeDrill()?.requestID}
                  collection={pageTarget()}
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
                  onScopeSession={(sid) => addSession(sid)}
                  onScopeTree={(sid) =>
                    addSession(shown()?.sessions?.find((s) => s.sessionID === sid)?.rootID ?? sid, "tree")
                  }
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
                  collection={pageTarget()}
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
