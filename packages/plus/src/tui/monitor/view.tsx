import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
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
  knownTab,
  noticeSettings,
  queryOf,
  SCOPES,
  scopeWords,
  SORTS,
  TABS,
  textMatches,
  totalsLine,
  totalsLines,
  windowLabels,
  WINDOWS,
  type Drill,
  type MonitorSettings,
  type TabName,
} from "./format.js"
import { MonitorHelp } from "./help.js"
import { CacheTab } from "./tabs/cache.js"
import { PromptTab, type PromptController } from "./tabs/prompt.js"
import { SessionsTab } from "./tabs/sessions.js"
import { TeamTab } from "./tabs/team.js"
import { groupMountLog, resetGroupMountLog, stopGroupMountLog, ToolsTab } from "./tabs/tools.js"
import type { ActiveTeamInfo } from "../active-team.js"

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
  readonly onToggleFullscreen?: () => void
  readonly width?: number
  readonly focus?: () => void
  /** The active team; the Team tab is shown only while there is one. */
  readonly team?: () => ActiveTeamInfo | undefined
  /** A cache notice to open: its session alone, on the Cache tab, its request selected. */
  readonly target?: () => MonitorTarget | undefined
  /** The view took the target; the caller clears it so it is applied once. */
  readonly onTarget?: () => void
}

export interface MonitorTarget {
  readonly sessionID: string
  readonly requestID: string
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
    tab: knownTab(stored.settings?.tab),
  })
  createEffect(() => {
    const s = stored.settings
    if (s !== undefined) {
      setLocal({
        ...defaultSettings,
        ...s,
        scope: s.scope ?? defaultScope,
        tab: knownTab(s.tab),
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
  onMount(() => props.focus?.())
  const theme = () => props.context.theme
  const plus = props.context.client.rpc(Definition)
  const dimensions = useTerminalDimensions()
  const width = () => props.width ?? dimensions().width
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
  // full-page settings happen to hold. A stored Team tab with no active team
  // opens on Cache.
  const teamOn = () => props.team?.() !== undefined
  const tabs = (): readonly TabName[] => (teamOn() ? TABS : TABS.filter((name) => name !== "team"))
  const tab = (): TabName => {
    if (!props.full) return "tools"
    const stored = settings().tab
    return stored === "team" && !teamOn() ? "cache" : stored
  }

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
  const pageTarget = () => collection() ?? (activeDrill()?.requestID ? "detail.segments" : undefined)
  const [promptTarget, setPromptTarget] = createSignal<string>()
  const prompt: { controller?: PromptController } = {}
  // Prompt shows one session's sent bodies: the selected one, else the latest of any.
  const promptSession = () => {
    const current = settings()
    if (current.scope !== "session" && current.scope !== "tree") return undefined
    return current.sessionIDs?.at(-1) ?? sessionID()
  }
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

  const currentQuery = () =>
    queryOf(
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

  // The latest Cache page grows into one list: older requests load a page at a
  // time ahead of the scroll position (loadOlder). Once a page has loaded,
  // every row a poll returns is kept as well, so rows that slide off the
  // newest page stay in the list. Paging with [ ] or another scope starts over.
  const older = {
    rows: new Map<string, Plus.MonitorRequest>(),
    cursor: undefined as NonNullable<Plus.MonitorReport["requestPage"]>["older"],
    busy: false,
    scope: 0,
  }
  createEffect(() => {
    pageScope()
    requestPage()
    older.rows = new Map()
    older.cursor = undefined
    older.busy = false
    older.scope++
  })
  const withOlder = (next: Plus.MonitorReport, since: Plus.MonitorQueryInput["since"]) => {
    if (older.rows.size === 0 || next.requests === undefined || next.requestPage === undefined) return next
    for (const request of next.requests) older.rows.set(request.id, request)
    // A moving window (last hour, …) drops what fell out of it.
    if (typeof since === "number")
      older.rows.forEach((request, id) => {
        if (request.at < since) older.rows.delete(id)
      })
    const requests = [...older.rows.values()].toSorted((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    return {
      ...next,
      requests,
      requestPage: {
        total: next.requestPage.total,
        returned: requests.length,
        limit: next.requestPage.limit,
        complete: older.cursor === undefined,
        ...(older.cursor === undefined ? {} : { older: older.cursor }),
      },
    }
  }
  // Rows of the scope not loaded yet, in the latest view; a text filter can't
  // tell how many of them it would keep.
  const pending = () => {
    const page = report()?.requestPage
    if (page?.older === undefined || requestPage() !== undefined || settings().filterText) return 0
    return Math.max(0, page.total - page.returned)
  }
  // A page of 100, or up to the server's 500 to reach a viewport dragged further.
  const loadOlder = (rows: number) => {
    const current = report()
    const cursor = current?.requestPage?.older
    if (older.busy || current === undefined || cursor === undefined) return
    if (tab() !== "cache" || requestPage() !== undefined || activeDrill()?.requestID) return
    older.busy = true
    const scope = older.scope
    const query = currentQuery()
    const limit = Math.min(500, Math.ceil(Math.max(rows, 100) / 100) * 100)
    void plus["monitor.query"](
      { ...query, requestPage: { cursor, direction: "older", limit }, fullText: fullText() },
      { location: location() },
    )
      .then(
        (page) => {
          if (scope !== older.scope) return
          // Free before the rows land: they can ask for the next page at once.
          older.busy = false
          for (const request of [...(page.requests ?? []), ...(report()?.requests ?? [])]) older.rows.set(request.id, request)
          older.cursor = page.requestPage?.older
          setReport(withOlder(report()!, query.since))
        },
        (error: unknown) => {
          if (scope === older.scope) older.busy = false
          setFailure(error instanceof Error ? error.message : String(error))
        },
      )
  }

  const flight = { busy: false, again: false, generation: 0 }
  const refresh = () => {
    if (flight.busy) {
      flight.again = true
      return
    }
    flight.busy = true
    const generation = ++flight.generation
    const query = currentQuery()
    void plus["monitor.query"](
      { ...query, requestPage: requestPage(), pages: pages(), fullText: fullText() },
      { location: location() },
    )
      .then(
        (raw) => {
          if (generation !== flight.generation) return
          const next = withOlder(raw, query.since)
          // Compute maxIdx from the FILTERED view so the selection always points
          // at an actually-visible row; the text filter drops rows independently
          // of the server query and must not leave the selector past the end.
          const filtered = filterReport(next, settings().filterText)
          const maxIdx = Math.max(0, rowCount(filtered) - 1)
          // The Cache tab shows newest first, so a new request arrives at the
          // top and shifts every row down. Remember the selected request's id
          // so the selection follows the same request instead of its old row.
          const previousID =
            props.full && tab() === "cache" ? cacheRequests(shown(), settings().missesOnly)[selected()]?.id : undefined
          // One update: the rows and the selection that keeps its row change
          // together, so no effect sees the new rows under the old index.
          batch(() => {
            setReport(next)
            setFailure(undefined)
            // The Sessions checklist keeps its own selection when it reloads.
            if (tab() === "sessions") return
            setSelected((index) => {
              if (previousID !== undefined) {
                const at = cacheRequests(filtered, settings().missesOnly).findIndex((request) => request.id === previousID)
                if (at !== -1) return at
              }
              return Math.min(index, maxIdx)
            })
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

  /** Rows the selection runs over on the current tab. */
  function rowCount(report: Plus.MonitorReport | undefined) {
    if (!props.full || tab() === "tools") return report?.groups.length ?? 0
    if (tab() === "cache") return cacheRequests(report, settings().missesOnly).length
    if (tab() === "sessions") return sessionRows().length
    return 0
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
    if (!props.full || !tabs().includes(next)) return
    // Opening Prompt by its key follows the latest request; P pins one afterwards.
    setPromptTarget(undefined)
    setSelected(0)
    change({ ...settings(), tab: next })
  }

  // Every rendered table follows the text filter; totals stay the real query.
  const shown = createMemo(() => {
    const current = report()
    return current === undefined ? undefined : filterReport(current, settings().filterText)
  })

  // The Sessions checklist: every session as trees, the active ones unless S
  // shows the rest, this chat's tree first and open. The checked sessions are
  // what every other tab reports on; checking changes only this monitor's
  // temporary filter, never the stored settings.
  const [allSessions, setAllSessions] = createSignal(false)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(
    new Set(props.sessionID() === undefined ? [] : [props.sessionID()!]),
  )
  const [treeOffset, setTreeOffset] = createSignal(0)
  const [checklist, setChecklist] = createSignal<Plus.MonitorSessionList>()
  const rowsOf = (list: Plus.MonitorSessionList | undefined): readonly Plus.MonitorSessionRow[] => {
    if (list === undefined) return []
    const chat = props.sessionID()
    const title = chat === undefined ? undefined : props.context.data.session.get(chat)?.title
    // A chat without a finished request is not in the monitor yet; it still heads the list.
    const rows: readonly Plus.MonitorSessionRow[] =
      chat !== undefined && list.offset === 0 && !list.sessions.some((row) => row.sessionID === chat)
        ? [
            {
              sessionID: chat, rootID: chat, depth: 0, ...(title ? { title } : {}), lastActive: 0, requests: 0, steps: 0,
              input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, misses: 0, active: true, descendants: 0,
            },
            ...list.sessions,
          ]
        : list.sessions
    const filter = settings().filterText
    return rows.filter((row) => textMatches(filter, [row.sessionID, row.title, row.agent, row.role, row.team, row.state, row.runID]))
  }
  const sessionRows = createMemo(() => rowsOf(checklist()))
  const rootOf = (id: string) => sessionRows().find((row) => row.sessionID === id)?.rootID ?? id
  const isExpanded = (root: string) => [...expanded()].some((id) => rootOf(id) === root)
  /** The sessions the other tabs report on; undefined when the scope is not a session selection. */
  const checkedIDs = (): readonly string[] | undefined => {
    const current = settings()
    if (current.scope !== "session" && current.scope !== "tree") return undefined
    const ids = current.sessionIDs ?? (sessionID() === undefined ? [] : [sessionID()!])
    if (current.scope === "session") return ids
    const roots = new Set(ids.map(rootOf))
    return sessionRows().filter((row) => roots.has(row.rootID)).map((row) => row.sessionID)
  }
  const isChecked = (row: Plus.MonitorSessionRow) => checkedIDs()?.includes(row.sessionID) ?? false
  const check = (ids: readonly string[], on: boolean) => {
    const base = checkedIDs() ?? []
    const next = on ? [...base, ...ids.filter((id) => !base.includes(id))] : base.filter((id) => !ids.includes(id))
    const drill: Drill = {
      settings: { ...settings(), scope: "session", sessionIDs: next },
      ...(next.length === 0 ? {} : { sessionID: next.at(-1)! }),
    }
    setDrills((stack) => (stack.length === 0 ? [drill] : [...stack.slice(0, -1), { ...stack.at(-1)!, ...drill }]))
  }
  const checklistShown = () => props.full && tab() === "sessions" && props.active()
  // A load for changed inputs supersedes the answers still out. A poll never
  // does: while one is out it waits for it and asks once more, so an answer
  // slower than the poll interval is still shown.
  const checklistFlight = { generation: 0, out: 0, again: false }
  const pollChecklist = () => {
    if (checklistFlight.out > 0) {
      checklistFlight.again = true
      return
    }
    void loadChecklist()
  }
  const loadChecklist = (expand: readonly string[] = []) => {
    const generation = ++checklistFlight.generation
    checklistFlight.out++
    const query = currentQuery()
    const chat = props.sessionID()
    return plus["monitor.sessions"](
      {
        ...(allSessions() ? { all: true } : {}),
        expanded: [...expanded(), ...expand],
        ...(chat === undefined ? {} : { first: chat }),
        ...(query.since === undefined ? {} : { since: query.since }),
        ...(query.until === undefined ? {} : { until: query.until }),
        page: { offset: treeOffset() },
      },
      { location: location() },
    ).then(
      (list) => {
        if (generation !== checklistFlight.generation) return undefined
        // The selection stays on its session when rows above it come or go.
        const keep = sessionRows()[selected()]?.sessionID
        const at = keep === undefined ? -1 : rowsOf(list).findIndex((row) => row.sessionID === keep)
        batch(() => {
          setChecklist(list)
          if (at !== -1) setSelected(at)
        })
        return list
      },
      (error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
        return undefined
      },
    ).finally(() => {
      checklistFlight.out--
      if (checklistFlight.out > 0 || !checklistFlight.again) return
      checklistFlight.again = false
      if (checklistShown()) void loadChecklist()
    })
  }
  createEffect(() => {
    if (!checklistShown()) return
    allSessions()
    expanded()
    treeOffset()
    settings().window
    props.sessionID()
    untrack(() => void loadChecklist())
  })
  createEffect(() => {
    if (!checklistShown()) return
    const timer = setInterval(pollChecklist, pace())
    onCleanup(() => clearInterval(timer))
  })
  /** Space: check or uncheck a whole tree, opening it first so every session in it is known. */
  const checkTree = async (row: Plus.MonitorSessionRow) => {
    const root = row.rootID
    const known = sessionRows().filter((entry) => entry.rootID === root)
    const head = known.find((entry) => entry.sessionID === root)
    const whole = head === undefined || (head.descendants ?? 0) <= known.length - 1
    setExpanded((set) => new Set([...set, root]))
    const list = whole ? checklist() : await loadChecklist([root])
    const ids = rowsOf(list).filter((entry) => entry.rootID === root).map((entry) => entry.sessionID)
    if (ids.length === 0) return
    const checked = checkedIDs() ?? []
    check(ids, !ids.every((id) => checked.includes(id)))
  }
  const closeTree = (row: Plus.MonitorSessionRow) => {
    const root = row.rootID
    setExpanded((set) => new Set([...set].filter((id) => id !== root && rootOf(id) !== root)))
    const at = sessionRows().findIndex((entry) => entry.sessionID === root)
    if (at !== -1) setSelected(at)
  }
  props.context.keymap.layer(() => ({
    ...(props.mode === undefined ? {} : { mode: props.mode }),
    enabled: () => props.active() && props.full && tab() === "sessions" && !helpOpen(),
    priority: 2,
    commands: [
      {
        bind: "right",
        title: "Open tree",
        group: "Monitor",
        run: () => {
          const row = sessionRows()[selected()]
          if (row !== undefined) setExpanded((set) => new Set([...set, row.rootID]))
        },
      },
      {
        bind: "left",
        title: "Close tree",
        group: "Monitor",
        run: () => {
          const row = sessionRows()[selected()]
          if (row !== undefined) closeTree(row)
        },
      },
    ],
  }))

  // A cache notice opens on its session alone with its request selected and
  // marked; older pages load until the request is in the list.
  const [highlight, setHighlight] = createSignal<string>()
  const [seeking, setSeeking] = createSignal<string>()
  createEffect(() => {
    const goal = props.target?.()
    if (goal === undefined || !props.full) return
    untrack(() => {
      props.onTarget?.()
      batch(() => {
        setHelpOpen(false)
        setPromptTarget(undefined)
        setRequestPage(undefined)
        setReport(undefined)
        setSelected(0)
        setDrills([{ settings: noticeSettings(store.settings(), goal.sessionID), sessionID: goal.sessionID }])
        setHighlight(goal.requestID)
        setSeeking(goal.requestID)
      })
      props.focus?.()
    })
  })
  createEffect(() => {
    const id = seeking()
    const current = shown()
    if (id === undefined || current === undefined || tab() !== "cache") return
    const index = cacheRequests(current, settings().missesOnly).findIndex((request) => request.id === id)
    if (index !== -1) {
      setSelected(index)
      setSeeking(undefined)
      return
    }
    if (current.requestPage?.older !== undefined) untrack(() => loadOlder(100))
    else setSeeking(undefined)
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

  // Scroll the selected row into view, but only when the selection moved to
  // another row (or tab) — a poll returns a fresh report every second and must
  // not yank a user who scrolled the list away from the selection. When a poll
  // adds rows above, the selection keeps its row at a new index; a list
  // scrolled down moves by as many rows, so the rows on screen stay put.
  let lastFollowed: { tab: TabName; row: string | undefined; index: number } | undefined
  const [laidOut, setLaidOut] = createSignal(0)
  createEffect(() => {
    laidOut()
    const current = tab()
    const count = current === "tools" ? rows.groups.length : rowCount(shown())
    const index = Math.min(selected(), Math.max(0, count - 1))
    if (count === 0) {
      lastFollowed = undefined
      return
    }
    const row =
      current === "tools"
        ? rows.groups[index]?.key
        : current === "sessions"
          ? sessionRows()[index]?.sessionID
          : cacheRequests(shown(), settings().missesOnly)[index]?.id
    if (lastFollowed?.tab === current && lastFollowed.index === index) return
    const scroll = scrolls[current]
    if (scroll === undefined) return
    // A list shown moments ago has no height until its first frame; follow then.
    if (scroll.viewport.height === 0) {
      const retry = () => {
        props.context.renderer.off("frame", retry)
        setLaidOut((value) => value + 1)
      }
      props.context.renderer.on("frame", retry)
      return
    }
    const shift = lastFollowed?.tab === current && row !== undefined && lastFollowed.row === row
    const previous = lastFollowed?.index ?? index
    lastFollowed = { tab: current, row, index }
    if (shift) {
      if (scroll.scrollTop > 0) scroll.scrollTo(scroll.scrollTop + index - previous)
      return
    }
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

  // Both pickers open at once from the last loaded session list (plus the
  // host's live chats, which may not have a completed request yet); every
  // opening refreshes the list in the background for the next one.
  type SessionList = { sessions: readonly Plus.MonitorSessionRow[]; page?: Plus.MonitorPage }
  const [knownSessions, setKnownSessions] = createSignal<SessionList>()
  const loadSessions = (cursor?: NonNullable<Plus.MonitorPage["next"]>): Promise<SessionList> =>
    plus["monitor.cache"](
      { scope: "all", view: "sessions", ...(cursor ? { pages: { sessions: { cursor } } } : {}) },
      { location: location() },
    ).then((value) => ({ sessions: withHostSessions(value.sessions ?? [], cursor === undefined), ...(value.pages?.sessions ? { page: value.pages.sessions } : {}) }))
  const refreshSessions = () => loadSessions().then(setKnownSessions, () => undefined)
  const currentSessions = async () => {
    const known = knownSessions()
    void refreshSessions()
    if (known) return known
    const loaded = await loadSessions()
    setKnownSessions(loaded)
    return loaded
  }
  onMount(() => {
    if (props.full) void refreshSessions()
  })
  const withHostSessions = (rows: readonly Plus.MonitorSessionRow[], first: boolean) => {
    if (!first) return rows
    const listed = new Set(rows.map((row) => row.sessionID))
    const live = (props.context.data.session.list() ?? [])
      .filter((row) => !listed.has(row.id))
      .map((row): Plus.MonitorSessionRow => ({
        sessionID: row.id, rootID: row.id, depth: 0, ...(row.title ? { title: row.title } : {}),
        lastActive: 0, requests: 0, steps: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, misses: 0,
      }))
    return [...live, ...rows]
  }
  const sessionTitle = (id: string, rows: readonly Plus.MonitorSessionRow[]) =>
    props.context.data.session.get(id)?.title ?? rows.find((row) => row.sessionID === id)?.title ?? id
  const sessionLabel = (row: Plus.MonitorSessionRow) =>
    [
      `${row.depth > 0 ? "└─ " : ""}${row.title ?? row.role ?? row.agent ?? row.sessionID.slice(0, 12)}`,
      ...(row.lastActive ? [formatClock(row.lastActive)] : []),
      ...(row.steps ? [`${row.steps} steps`, `${formatTokens(row.input + row.cacheRead)} in`] : []),
    ].join(" · ")

  /** `s`: one picker for what the monitor reads — this chat, its tree, the project, everything, or any session. */
  const chooseScope = async () => {
    const chat = props.sessionID()
    let list = await currentSessions()
    while (true) {
      const rows = list.sessions
      const picked = await props.context.ui.dialog.select<string>({
        title: "Monitor scope",
        placeholder: "Search sessions…",
        options: [
          ...(chat
            ? [
                { title: `This chat · ${sessionTitle(chat, rows)}`, value: `session\0${chat}` },
                { title: "This chat with its subagents", value: `tree\0${chat}` },
              ]
            : []),
          { title: "This project", value: "project\0" },
          { title: "All sessions", value: "all\0" },
          ...rows.filter((row) => row.sessionID !== chat).map((row) => ({ title: sessionLabel(row), value: `session\0${row.sessionID}` })),
          ...(list.page?.previous ? [{ title: "Previous sessions", value: "previous\0" }] : []),
          ...(list.page?.next ? [{ title: "More sessions", value: "next\0" }] : []),
        ],
      })
      props.context.ui.dialog.clear()
      if (picked === undefined) return
      const [kind, id] = picked.split("\0") as [string, string]
      if (kind === "next" || kind === "previous") {
        const cursor = kind === "next" ? list.page?.next : list.page?.previous
        if (!cursor) return
        list = await loadSessions(cursor)
        continue
      }
      const scope = kind as Plus.MonitorScope
      const next: MonitorSettings = id ? { ...settings(), scope, sessionIDs: [id] } : { ...settings(), scope, sessionIDs: undefined }
      if (next.scope === settings().scope && JSON.stringify(next.sessionIDs) === JSON.stringify(settings().sessionIDs)) return
      setSelected(0)
      setDrills((stack) => [...stack, { settings: next, ...(id ? { sessionID: id } : {}) }])
      return
    }
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
    if (current === "prompt") {
      prompt.controller?.open()
      return
    }
    if (current === "sessions") {
      const row = sessionRows()[selected()]
      if (row !== undefined) check([row.sessionID], !isChecked(row))
      return
    }
  }

  const back = () => {
    if (helpOpen()) {
      setHelpOpen(false)
      return
    }
    if (tab() === "prompt" && prompt.controller?.back()) return
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
            activeDrill()?.requestID ? name.startsWith("detail.") : tab() === "sessions" && name === "sessions",
          )
          void props.context.ui.dialog
            .select<Plus.MonitorPageSection | "requests">({
              title: "Page report collection (text search is page-local)",
              options: [
                ...(tab() === "cache" ? [{ title: "requests", value: "requests" as const }] : []),
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
        title: "Toggle unabridged text / exact JSON",
        group: "Monitor",
        run: () => {
          if (tab() === "prompt") return prompt.controller?.toggleRaw()
          setFullText((value) => !value)
        },
      },
      ...(["older", "newer"] as const).map((direction) => ({
        bind: direction === "older" ? "[" : "]",
        title: `${direction} request page`,
        group: "Monitor",
        run: () => {
          if (tab() === "prompt") return prompt.controller?.step(direction)
          if (tab() === "sessions") {
            const list = checklist()
            if (list === undefined) return
            const offset = direction === "older" ? list.offset - list.limit : list.offset + list.limit
            if (offset < 0 || offset >= list.roots) return
            setSelected(0)
            setTreeOffset(offset)
            return
          }
          const target = pageTarget()
          if (target) {
            const cursor = direction === "older" ? metadata()?.previous : metadata()?.next
            if (!cursor) return
            setSelected(0)
            setPages((current) => ({ ...current, [target]: { cursor } }))
            return
          }
          if (tab() !== "cache" || activeDrill()?.requestID) return
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
          if (tab() === "prompt") return prompt.controller?.latest()
          if (tab() === "sessions") {
            setSelected(0)
            setTreeOffset(0)
            return
          }
          if (pageTarget()) {
            const target = pageTarget()!
            setSelected(0)
            setPages((current) => ({ ...current, [target]: undefined }))
            return
          }
          if (tab() !== "cache") return
          setSelected(0)
          setRequestPage(undefined)
          scrolls.cache?.scrollTo(0)
        },
      },
      {
        bind: "up,k",
        title: "Previous row",
        group: "Monitor",
        run: () => {
          if (tab() === "prompt" && props.full) return prompt.controller?.move(-1)
          if (selected() === 0 && !props.full) return props.onClose()
          setSelected((index) => Math.max(0, index - 1))
        },
      },
      {
        bind: "down,j",
        title: "Next row",
        group: "Monitor",
        run: () => {
          if (tab() === "prompt" && props.full) return prompt.controller?.move(1)
          setSelected((index) => Math.min(Math.max(0, rowCount(shown()) - 1), index + 1))
        },
      },
      {
        bind: "pageup",
        title: "Previous page of rows",
        group: "Monitor",
        run: () => {
          if (tab() === "prompt") return prompt.controller?.move(-2)
          setSelected((index) => Math.max(0, index - Math.max(1, dimensions().height - 14)))
        },
      },
      {
        bind: "pagedown",
        title: "Next page of rows",
        group: "Monitor",
        run: () => {
          if (tab() === "prompt") return prompt.controller?.move(2)
          setSelected((index) => Math.min(Math.max(0, rowCount(shown()) - 1), index + Math.max(1, dimensions().height - 14)))
        },
      },
      {
        bind: "home",
        title: "First row",
        group: "Monitor",
        run: () => (tab() === "prompt" ? prompt.controller?.edge("first") : setSelected(0)),
      },
      {
        bind: "end",
        title: "Last row",
        group: "Monitor",
        run: () => (tab() === "prompt" ? prompt.controller?.edge("last") : setSelected(Math.max(0, rowCount(shown()) - 1))),
      },
      { bind: "return", title: "Filter by row / open detail", group: "Monitor", run: drill },
      { bind: "backspace", title: "Back", group: "Monitor", run: back },
      {
        bind: "escape",
        title: "Close monitor",
        group: "Monitor",
        run: () => {
          if (tab() === "prompt" && prompt.controller?.back()) return
          props.onClose()
        },
      },
      {
        bind: "shift+p",
        title: "This request's prompt",
        group: "Monitor",
        run: () => {
          if (tab() !== "cache") return
          const id = activeDrill()?.requestID ?? cacheRequests(shown(), settings().missesOnly)[selected()]?.id
          if (!id) return
          setTab("prompt")
          setPromptTarget(id)
        },
      },
      ...TABS.map((name, index) => ({
        bind: String(index + 1),
        title: `${name.charAt(0).toUpperCase()}${name.slice(1)} tab`,
        group: "Monitor",
        run: () => setTab(name),
      })),
      {
        bind: "tab",
        title: "Next tab",
        group: "Monitor",
        run: () => setTab(cycle(tabs(), tab(), 1)),
      },
      {
        bind: "shift+tab",
        title: "Previous tab",
        group: "Monitor",
        run: () => setTab(cycle(tabs(), tab(), -1)),
      },
      {
        bind: "s",
        title: "Choose scope or session",
        group: "Monitor",
        run: () => {
          // The compact composer body has no room for a picker; it steps the scope.
          if (!props.full) return change({ ...settings(), scope: cycle(SCOPES, settings().scope) })
          void chooseScope().catch((error: unknown) =>
            props.context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) }),
          )
        },
      },
      {
        bind: "shift+s",
        title: "Show inactive sessions",
        group: "Monitor",
        run: () => {
          // The compact composer body has no Sessions tab.
          if (!props.full) return
          setTreeOffset(0)
          if (tab() !== "sessions") {
            setAllSessions(true)
            setTab("sessions")
            return
          }
          setSelected(0)
          setAllSessions((value) => !value)
        },
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
          if (tab() === "prompt") return prompt.controller?.toggleChanged()
          if (tab() === "cache") return change({ ...settings(), missesOnly: !settings().missesOnly })
          change({ ...settings(), errors: !settings().errors })
        },
      },
      {
        bind: "space",
        title: "Check session tree",
        group: "Monitor",
        run: () => {
          const row = tab() === "sessions" ? sessionRows()[selected()] : undefined
          if (row !== undefined) void checkTree(row)
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
      ...(props.onToggleFullscreen === undefined
        ? []
        : [{ bind: "shift+m,M", title: "Toggle Monitor fullscreen", group: "Monitor", run: props.onToggleFullscreen }]),
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
    if (effective === "session" && ids?.length === 0) return "No session checked (Sessions tab)"
    if ((effective === "session" || effective === "tree") && ids !== undefined && ids.length > 1) {
      return `${ids.length} ${effective === "tree" ? "session trees" : "sessions"} (${ids.map((id) => id.slice(0, 10)).join(", ")})`
    }
    if ((effective === "session" || effective === "tree") && sessionID() !== undefined) {
      const id = ids?.[0] ?? sessionID()!
      const title = props.context.data.session.get(id)?.title ?? knownSessions()?.sessions.find((row) => row.sessionID === id)?.title
      return `${name}: ${title ?? id.slice(0, 10)}`
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
    switch (tab()) {
      case "cache":
        return narrow
          ? "[↑↓] · [⏎] detail · [P] prompt · [x] misses · [s] scope · [?] help · [esc]"
          : "[↑↓] select · [⏎] detail · [P] prompt · [x] misses only · [s] scope · [t] window · [?] help · [esc] close"
      case "prompt":
        return narrow
          ? "[↑↓] · [⏎] content · [ ] request · [l] live · [x] changed · [/] · [esc]"
          : "[↑↓] select · [⏎] content · [v] exact JSON · [ ] older/newer · [l] live · [x] changed only · [/] filter · [s] session"
      case "tools":
        return narrow
          ? "[↑↓] · [⏎] filter · [g] group · [o] sort · [a/f/F] filter · [x] fail · [c] [m] [?]"
          : "[↑↓] select · [⏎] filter · [g] group · [o] sort · [a/f/F] filter · [x] fail · [c] compare · [m] mark · [?] help"
      case "sessions":
        return narrow
          ? "[↑↓] · [⏎] check · [space] tree · [→←] open · [S] inactive · [?] · [esc]"
          : "[↑↓] select · [⏎] check session · [space] check tree · [→/←] open/close tree · [S] show inactive · [?] help · [esc] close"
      case "team":
        return narrow
          ? "[↑↓] · [⏎] open · [ctrl+a/t] inactive/tree · [ctrl+d] stop · [e] checks"
          : "[↑↓] select · [⏎] open run · [ctrl+a] active/inactive · [ctrl+t] tree/all · [ctrl+d] stop/resume · [e] edit checks · [esc] close"
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
                {totalsLine(current().totals, width())}
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
      minHeight={0}
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
        <text fg={theme().text.muted}>{teamOn() ? "cache, prompt, tools, sessions and team" : "cache, prompt, tools and sessions"}</text>
      </box>

      {/* Scope Line */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
          Scope:{" "}
        </text>
        <text fg={theme().text.action.primary.focused} attributes={TextAttributes.BOLD} minWidth={0} wrapMode="none" truncate>
          {scopeLabel()}
        </text>
        <Show when={width() >= 80}>
          <text fg={theme().text.muted}> [s] choose · [S] all sessions · [T] team</text>
        </Show>
      </box>

      {/* When Line */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
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
      <Show when={tab() !== "prompt" && ((report()?.presentation?.truncated.length ?? 0) > 0 || fullText())}>
        <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={0}>
          {fullText()
            ? "Unabridged selected-page text · v preview"
            : "Text preview truncated · v unabridged selected-page facts"}
        </text>
      </Show>
      <Show when={tab() === "cache" && report()?.requestPage}>
        {(page) => (
          <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={0}>
            {`${page().returned}/${page().total} requests${(report()?.cachePending ?? 0) > 0 ? ` · ${report()?.cachePending} not analyzed yet` : ""} · [${page().older ? "[" : "—"}] older · [${page().newer ? "]" : "—"}] newer · [l] latest · text: page-local`}
          </text>
        )}
      </Show>
      <Show when={report()}>
        {(current) => (
          <box flexDirection="column" flexShrink={0} marginTop={0}>
            <For each={totalsLines(current().totals, Math.max(1, width() - 2))}>
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
        <For each={tabs()}>
          {(name, index) => {
            const isActive = () => tab() === name
            const label = () => width() < 60
              ? `[${index() + 1} ${name.slice(0, 3)}]`
              : `[${index() + 1} ${name.charAt(0).toUpperCase() + name.slice(1)}]`
            return (
              <box
                backgroundColor={isActive() ? theme().background.action.primary.focused : undefined}
                marginRight={1}
                onMouseUp={() => setTab(name)}
              >
                <text
                  fg={isActive() ? theme().text.action.primary.focused : theme().text.muted}
                  attributes={isActive() ? TextAttributes.BOLD : undefined}
                >
                  {label()}
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
            <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
              <Show when={tab() === "prompt"}>
                <PromptTab
                  context={props.context}
                  sessionID={promptSession}
                  target={promptTarget}
                  active={() => props.active() && tab() === "prompt" && !helpOpen()}
                  filterText={() => settings().filterText}
                  width={width()}
                  location={location}
                  onController={(controller) => (prompt.controller = controller)}
                />
              </Show>
              <Show when={tab() === "cache"}>
                <CacheTab
                  width={width()}
                  context={props.context}
                  report={shown()}
                  selectedIndex={selected()}
                  onSelect={setSelected}
                  detailID={activeDrill()?.requestID}
                  highlightID={highlight()}
                  collection={pageTarget()}
                  missesOnly={settings().missesOnly}
                  active={props.active()}
                  onScrollRef={(ref) => (scrolls.cache = ref)}
                  pending={pending()}
                  onNearEnd={loadOlder}
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
                  width={width()}
                  context={props.context}
                  rows={sessionRows()}
                  list={checklist()}
                  all={allSessions()}
                  checked={isChecked}
                  expanded={isExpanded}
                  selectedIndex={selected()}
                  onSelect={setSelected}
                  active={props.active()}
                  onScrollRef={(ref) => (scrolls.sessions = ref)}
                />
              </Show>
              <Show when={tab() === "team"}>
                <TeamTab
                  context={props.context}
                  sessionID={sessionID}
                  active={() => props.active() && tab() === "team" && !helpOpen()}
                  close={props.onClose}
                  location={location}
                />
              </Show>
            </box>
          )}
        </Show>
      </Show>

      {/* Always-visible Hint Bar */}
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text fg={theme().text.muted} wrapMode="none" truncate flexGrow={1}>
          {hintBarText(width())}
        </text>
      </box>
      <Show when={props.onToggleFullscreen}>
        <text fg={theme().text.muted} flexShrink={0}>M fullscreen · esc close</text>
      </Show>
    </box>
  )
}

function withoutKey(settings: MonitorSettings, key: "agent" | "tool" | "model"): MonitorSettings {
  return Object.fromEntries(Object.entries(settings).filter(([name]) => name !== key)) as unknown as MonitorSettings
}
