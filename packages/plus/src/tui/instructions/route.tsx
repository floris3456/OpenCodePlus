import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { createPaneResize, type Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import type { Resolution } from "../../instructions/model.js"
import { isValueRow, limitOf } from "../../instructions/permission-catalog.js"
import { manual } from "../../instructions/sections.js"
import { controlKind, type TreeNode } from "../../instructions/tree.js"
import { isEditable } from "./detail-pane.js"
import { DiffPane } from "./diff-pane.js"
import { createInstructionsDialogs, isLinkable } from "./dialogs.js"
import { EditorPane } from "./editor-pane.js"
import { HELP_WIDE, HelpDialog } from "./help.js"
import { Inspector } from "./inspector.js"
import {
  clampInspector,
  clampOwners,
  defaultInspector,
  DIVIDERS,
  OWNERS_DEFAULT,
  PANELS_STORAGE_KEY,
  panelWidths,
} from "./panels.js"
import { KeyHints, RowLine } from "./row.js"
import { Splitter } from "./splitter.js"
import { createInstructionsState } from "./state.js"
import { ancestry, canExpand, isLevelId, LEVELS, reviewTargets, toolCounts, toolHint, workspaceOf, type LevelId, type Row, type ToolCount } from "./workspace.js"

// Wide: sidebar | list | inspector. Narrow: the sidebar and the owner are two
// pages, the inspector sits under the list (docs/instructions-redesign.md).
export const WIDE_THRESHOLD = 110

type Focus = "nav" | "list"
type Mode = "browse" | "edit" | "diff" | "split"

interface View {
  level: LevelId
  owner: Partial<Record<LevelId, string>>
  navSelected: Partial<Record<LevelId, string>>
  category: Record<string, string>
  listSelected: Record<string, string>
  navCollapsed: string[]
  listOpen: string[]
  listCollapsed: string[]
  focus: Focus
}

function isExpandable(node: TreeNode): boolean {
  return canExpand(node) && node.kind !== "section"
}

function canToggle(node: TreeNode | undefined): boolean {
  // Team rows carry no address by design (a synthetic address would corrupt
  // the mutate path), so toggleability reads from their toggle action alone.
  if (node?.kind === "team" || node?.enabledRow !== undefined) return node?.actions?.toggle === true
  return node?.address !== undefined && node?.actions?.toggle === true
}

// Agent rows under the Agents groups (never team member rows, which are kind
// "team") can be made the current agent with ctrl+space. Space toggles their
// Enabled item; older snapshots with no controls retain space-to-select.
export function selectableAgentId(node: TreeNode | undefined): string | undefined {
  if (node?.kind !== "agent") return undefined
  // Presets (`agent:preset:…`) and Defaults entries are not agents.
  if (node.owner?.entry !== undefined) return undefined
  const match = node.id.match(/^agent:(project|global|defaults):(.+)$/)
  return match?.[2]
}

function canReset(node: TreeNode | undefined): boolean {
  return (node?.address !== undefined || node?.enabledRow !== undefined) && node?.actions?.reset === true
}

function canPin(node: TreeNode | undefined): boolean {
  return node?.address !== undefined && node?.actions?.pin === true
}

function isReview(node: TreeNode | undefined): boolean {
  return node?.badges.review === true
}

export function extractAgentId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  if (!("agent" in data)) return undefined
  const value = data.agent
  if (typeof value === "string" && value.length > 0) return value
  return undefined
}

export const INITIAL_AGENT_RETRY_MS = 5000


// The footer keeps the first hints that fit, in priority order, and always
// its last two (? help, esc): everything else is in the help dialog.
export function fitHints(hints: readonly (readonly [string, string])[], width: number): (readonly [string, string])[] {
  const size = (hint: readonly [string, string]) => hint[0].length + hint[1].length + 4
  const tail = hints.slice(-2)
  let room = width - tail.reduce((total, hint) => total + size(hint), 0)
  const head: (readonly [string, string])[] = []
  for (const hint of hints.slice(0, -2)) {
    if (size(hint) > room) continue
    head.push(hint)
    room -= size(hint)
  }
  return [...head, ...tail]
}

function controlHelp(item: string | undefined): string {
  if (item === "setting:steps") return "Positive whole number; empty means unlimited"
  if (item === "setting:color") return "#RRGGBB; empty clears the color"
  if (item === "compaction:model") return "provider/model#variant; empty inherits"
  return "Empty clears it"
}

export interface InstructionsRouteProps {
  readonly context: Plugin.Context
  readonly onClose: () => void
  readonly data?: unknown
  readonly initialAgentTimeoutMs?: number
}

export function InstructionsRoute(props: InstructionsRouteProps) {
  const theme = () => props.context.theme
  const state = createInstructionsState(props.context)
  const dimensions = useTerminalDimensions()
  const wide = () => dimensions().width >= WIDE_THRESHOLD
  // The dialog host pushes "modal" for the whole dialog stack (help, prompts):
  // the workspace keeps its state but renders unfocused behind the backdrop.
  const modal = () => props.context.keymap.mode.current() === "modal"

  // Panel widths are client-local and durable (storage.store, not memory), so a
  // dragged or W-resized layout survives reopening the screen and a TUI
  // restart. The saved values are preferences: panels.ts clamps them to the
  // terminal every render, and narrow mode ignores them entirely.
  const [panels, savePanels] = props.context.storage.store<{ owners?: number; inspector?: number }>(PANELS_STORAGE_KEY, { initial: {} })
  const savePanelLayout = (mutation: (draft: { owners?: number; inspector?: number }) => void) => {
    void savePanels(mutation).catch((error) => console.error("Failed to persist instructions panel widths", error))
  }
  // The resting pair for the current terminal, from the stored preferences
  // alone: the drag clamps read the peer's resting size from here, so the two
  // resize instances never call each other's live size in a cycle.
  const panelBase = () => panelWidths(dimensions().width, { owners: panels.owners, inspector: panels.inspector })
  const ownersResize = createPaneResize({
    value: () => panels.owners ?? OWNERS_DEFAULT,
    defaultValue: () => OWNERS_DEFAULT,
    clamp: (size) => clampOwners(size, dimensions().width, panelBase().inspector),
    fromMouse: (event) => event.x + 1,
    contains: (event, size) => event.x >= size - 1 && event.x <= size,
    // A mouse commit persists the pair: the peer keeps the width it had during
    // the drag, so the list absorbs exactly the dragged delta.
    onCommit: (size) =>
      savePanelLayout((draft) => {
        draft.owners = size
        draft.inspector = inspectorResize.size()
      }),
  })
  const inspectorResize = createPaneResize({
    value: () => panels.inspector ?? defaultInspector(dimensions().width, panelBase().owners),
    defaultValue: () => defaultInspector(dimensions().width, panelBase().owners),
    clamp: (size) => clampInspector(size, dimensions().width, ownersResize.size()),
    fromMouse: (event) => dimensions().width - event.x - 1,
    contains: (event, size) => event.x >= dimensions().width - size - 1 && event.x <= dimensions().width - size,
    onCommit: (size) =>
      savePanelLayout((draft) => {
        draft.inspector = size
        draft.owners = ownersResize.size()
      }),
  })

  // W / alt+W keyboard resize mode: a draft pair seeded from the effective
  // widths and committed to storage on exit (Enter, Escape or the toggle key).
  // Browse commands do not run while it is active; a terminal that becomes
  // narrow auto-saves and leaves.
  const [resizing, setResizing] = createSignal<"owners" | "inspector">()
  const [resizeDraft, setResizeDraft] = createSignal<{ owners: number; inspector: number }>()
  const resizeWidths = () => {
    const draft = resizeDraft()
    return draft === undefined ? undefined : panelWidths(dimensions().width, draft)
  }
  const ownersWidth = () => {
    const draft = resizeWidths()
    return resizing() === undefined || draft === undefined ? ownersResize.size() : draft.owners
  }
  const inspectorWidth = () => {
    const draft = resizeWidths()
    return resizing() === undefined || draft === undefined ? inspectorResize.size() : draft.inspector
  }

  function startResize() {
    if (!wide() || resizing() !== undefined) return
    batch(() => {
      setResizeDraft({ owners: ownersResize.size(), inspector: inspectorResize.size() })
      setResizing("owners")
    })
  }

  // Left / [ move the selected divider one column left, Right / ] one right.
  // The keys move the divider, not the panel: Owners grows with its divider,
  // while the Inspector's divider is the panel's left edge, so the Inspector
  // grows when the divider moves left (the width delta is reversed there).
  function moveDivider(direction: -1 | 1) {
    const selected = resizing()
    const draft = resizeWidths()
    if (selected === undefined || draft === undefined) return
    setResizeDraft(
      selected === "owners"
        ? { owners: clampOwners(draft.owners + direction, dimensions().width, draft.inspector), inspector: draft.inspector }
        : { owners: draft.owners, inspector: clampInspector(draft.inspector - direction, dimensions().width, draft.owners) },
    )
  }

  function cycleResize() {
    setResizing((current) => (current === "owners" ? "inspector" : "owners"))
  }

  function commitResize() {
    const draft = resizeDraft()
    if (resizing() === undefined || draft === undefined) return
    // Persist the draft as adjusted, not a re-clamp at a possibly narrower
    // terminal: the preferences survive and re-clamp when wide again.
    savePanelLayout((next) => {
      next.owners = draft.owners
      next.inspector = draft.inspector
    })
    batch(() => {
      setResizing(undefined)
      setResizeDraft(undefined)
    })
  }

  createEffect(() => {
    if (resizing() === undefined) return
    if (wide()) return
    commitResize()
  })

  // The view survives closing and reopening the screen for the TUI session.
  const [saved, save] = props.context.storage.memory<{ view?: View }>("opencode.plus.instructions.view", { initial: {} })
  const initial = saved.view
  const [level, setLevel] = createSignal<LevelId>(initial?.level ?? "project")
  const [owners, setOwners] = createSignal<Partial<Record<LevelId, string>>>({ ...initial?.owner })
  const [navSelected, setNavSelected] = createSignal<Partial<Record<LevelId, string>>>({ ...initial?.navSelected })
  const [categories, setCategories] = createSignal<Record<string, string>>({ ...initial?.category })
  const [listSelected, setListSelected] = createSignal<Record<string, string>>({ ...initial?.listSelected })
  const [navCollapsed, setNavCollapsed] = createSignal<ReadonlySet<string>>(new Set(initial?.navCollapsed))
  const [listOpen, setListOpen] = createSignal<ReadonlySet<string>>(new Set(initial?.listOpen))
  const [listCollapsed, setListCollapsed] = createSignal<ReadonlySet<string>>(new Set(initial?.listCollapsed))
  // The row under the mouse: E / ctrl+E target its pane and exclude it as the
  // active row; without a hover they use the focused pane and its selection.
  const [hovered, setHovered] = createSignal<{ readonly pane: Focus; readonly key: string }>()
  const [focus, setFocus] = createSignal<Focus>(initial?.focus ?? "nav")
  const [mode, setMode] = createSignal<Mode>("browse")
  const [target, setTarget] = createSignal<TreeNode | undefined>(undefined)
  const [filtering, setFiltering] = createSignal(false)
  const [filterText, setFilterText] = createSignal("")
  const [filterSelected, setFilterSelected] = createSignal<string | undefined>(undefined)
  let filterTimer: ReturnType<typeof setTimeout> | undefined
  let navScroll: ScrollBoxRenderable | undefined
  let listScroll: ScrollBoxRenderable | undefined
  let inspectorScroll: ScrollBoxRenderable | undefined

  createEffect(() => {
    const view: View = {
      level: level(),
      owner: owners(),
      navSelected: navSelected(),
      category: categories(),
      listSelected: listSelected(),
      navCollapsed: [...navCollapsed()],
      listOpen: [...listOpen()],
      listCollapsed: [...listCollapsed()],
      focus: focus(),
    }
    save((draft) => {
      draft.view = view
    })
  })

  const known = new Map<LevelId, Set<string>>()
  const workspace = createMemo(() => {
    const current = level()
    const owner = owners()[current]
    const cache = known.get(current) ?? new Set<string>()
    known.set(current, cache)
    return workspaceOf(
      {
        rows: state.treeWith,
        level: current,
        navCollapsed: navCollapsed(),
        ...(owner === undefined ? {} : { owner }),
        ...(owner === undefined || categories()[owner] === undefined ? {} : { category: categories()[owner] }),
        listOpen: listOpen(),
        listCollapsed: listCollapsed(),
      },
      cache,
    )
  })

  // Tools switched on per owner. It walks every owner's Tools group, so it is
  // computed once per snapshot and level, after the screen has drawn.
  const [tools, setTools] = createSignal<{ readonly key: string; readonly counts: ReadonlyMap<string, ToolCount> }>()
  createEffect(() => {
    const snapshot = state.snapshot()
    const current = level()
    if (snapshot === undefined) return
    const key = `${snapshot.revision}/${snapshot.globalRevision}/${current}`
    if (tools()?.key === key) return
    const codemode = new Set(snapshot.items.filter((item) => item.codemode === true).map((item) => item.id))
    const timer = setTimeout(() => {
      if (state.snapshot() !== snapshot || level() !== current) return
      setTools({ key, counts: toolCounts(state.treeWith, current, (item) => codemode.has(item)) })
    }, 0)
    onCleanup(() => clearTimeout(timer))
  })
  const toolCount = (key: string | undefined): ToolCount | undefined => {
    const snapshot = state.snapshot()
    if (key === undefined || snapshot === undefined) return undefined
    const current = tools()
    if (current?.key !== `${snapshot.revision}/${snapshot.globalRevision}/${level()}`) return undefined
    return current.counts.get(key)
  }

  const dialogs = createInstructionsDialogs(props.context, state, {
    parentOf: (node) => workspace().parents.get(node.id),
  })

  onCleanup(() => {
    clearRetryTimer()
    if (filterTimer !== undefined) clearTimeout(filterTimer)
    state.dispose()
    dialogs.dispose()
  })

  // Filter results: the level's matching rows with their ancestors, from the
  // same query engine the tools use.
  const filterRows = createMemo<Row[]>(() => {
    if (!filtering() || state.filter().trim().length === 0) return []
    const nodes = state.nodes()
    const root = LEVELS.find((entry) => entry.id === level())?.root
    const start = nodes.findIndex((node) => node.id === root)
    if (start === -1) return []
    const rows: Row[] = []
    for (let at = start + 1; at < nodes.length; at++) {
      const node = nodes[at]!
      if (node.depth === 0) break
      rows.push({
        key: node.id,
        node,
        label: node.label,
        depth: node.depth - 1,
        role: node.kind === "group" ? "group" : "item",
        expandable: false,
        expanded: false,
        context: !state.matched().has(node.id),
      })
    }
    return rows
  })

  const navRow = createMemo(() => {
    const rows = workspace().nav
    const key = navSelected()[level()] ?? workspace().owner?.key
    return rows.find((row) => row.key === key) ?? rows[0]
  })

  const listKey = () => `${workspace().owner?.key ?? ""}|${workspace().category?.id ?? ""}`
  const listRows = (): readonly Row[] => (filtering() && state.filter().trim().length > 0 ? filterRows() : workspace().list)
  const listRow = createMemo(() => {
    const rows = listRows()
    const filtered = filtering() && state.filter().trim().length > 0
    const key = filtered ? filterSelected() : listSelected()[listKey()]
    // A filter lands on its first match, not on the ancestors shown with it.
    return rows.find((row) => row.key === key) ?? (filtered ? rows.find((row) => state.matched().has(row.key)) : undefined) ?? rows[0]
  })

  const currentRow = (): Row | undefined => (focus() === "nav" ? navRow() : listRow())
  const current = (): TreeNode | undefined => currentRow()?.node ?? (focus() === "list" ? workspace().category : undefined)

  // ---- initial agent (after create) and the session's current agent ----

  const route = props.context.ui.router.current()
  const navigationData: unknown = props.data ?? (route.type === "plugin" ? route.data : undefined)
  const initialAgent = extractAgentId(navigationData)
  // Core's config watcher debounces reloads (~100 ms), so the first snapshot
  // after agent.create often lacks the new agent. Retry until it appears.
  let initialApplied = initialAgent === undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let preselected = initial !== undefined

  function clearRetryTimer() {
    if (retryTimer === undefined) return
    clearTimeout(retryTimer)
    retryTimer = undefined
  }

  if (initialAgent !== undefined)
    retryTimer = setTimeout(() => {
      if (initialApplied) return
      initialApplied = true
      clearRetryTimer()
      props.context.ui.toast.show({ variant: "warning", message: `Agent ${initialAgent} not visible yet` })
    }, props.initialAgentTimeoutMs ?? INITIAL_AGENT_RETRY_MS)

  // Every agent shows under every level; a created agent opens at its own
  // scope, the session's agent at Project (where edits usually belong).
  function showAgent(id: string, at?: LevelId): boolean {
    const entry = state.snapshot()?.agents.find((candidate) => candidate.id === id)
    if (entry === undefined || !isLevelId(entry.scope)) return false
    const scope = at ?? (entry.scope as LevelId)
    const key = `agent:${scope}:${id}`
    batch(() => {
      setLevel(scope)
      setOwners({ ...owners(), [scope]: key })
      setNavSelected({ ...navSelected(), [scope]: key })
      // Open the groups above it, as the old tree's selectAgent did.
      const origin = entry.origin ?? "user"
      const above = [`group:${scope}:agents`, `group:${scope}:agents:${origin === "special" ? "native" : origin}`, `group:${scope}:agents:native:special`]
      setNavCollapsed(new Set([...navCollapsed()].filter((row) => !above.includes(row))))
      setFocus("nav")
    })
    return true
  }

  createEffect(() => {
    if (state.snapshot() === undefined) return
    untrack(() => {
      if (!initialApplied && initialAgent !== undefined && showAgent(initialAgent)) {
        initialApplied = true
        preselected = true
        clearRetryTimer()
        return
      }
      if (preselected) return
      preselected = true
      const active = props.context.ui.agents.current?.()
      if (active !== undefined) showAgent(active, "project")
    })
  })

  // A create flow (dialogs) asks for its new row: switch to its level and
  // select it in the sidebar as soon as a snapshot carries it.
  let wantedReveal: string | undefined
  // Effects below write the view signals they would otherwise read: they
  // track only their trigger and run the rest untracked, or each write
  // would re-run them.
  createEffect(() => {
    const request = state.revealed()
    if (request === undefined) return
    untrack(() => {
      const root = request.expand.find((id) => id.startsWith("root:"))?.slice("root:".length) ?? request.row.split(":")[1]
      if (!isLevelId(root)) return
      wantedReveal = request.row
      batch(() => {
        setLevel(root)
        setNavCollapsed(new Set([...navCollapsed()].filter((id) => !request.expand.includes(id))))
      })
    })
  })
  createEffect(() => {
    const nav = workspace().nav
    const wanted = wantedReveal
    if (wanted === undefined) return
    const row = nav.find((entry) => entry.key === wanted)
    if (row === undefined) return
    wantedReveal = undefined
    untrack(() => {
      selectNav(row)
      setFocus("nav")
    })
  })

  // ---- selection and scrolling ----

  function follow(scroll: ScrollBoxRenderable | undefined, index: number) {
    if (scroll === undefined || index < 0) return
    const height = Math.max(1, scroll.viewport.height)
    if (index < scroll.scrollTop) scroll.scrollTop = index
    else if (index >= scroll.scrollTop + height) scroll.scrollTop = index - height + 1
  }

  createEffect(() => follow(navScroll, workspace().nav.findIndex((row) => row.key === navRow()?.key)))
  createEffect(() => follow(listScroll, listRows().findIndex((row) => row.key === listRow()?.key)))
  createEffect(() => {
    current()
    if (inspectorScroll !== undefined) inspectorScroll.scrollTop = 0
  })

  function selectNav(row: Row) {
    batch(() => {
      setNavSelected({ ...navSelected(), [level()]: row.key })
      // Moving onto an owner shows it; groups and teams keep the owner shown.
      if (row.role === "owner" || row.role === "every") setOwners({ ...owners(), [level()]: row.key })
    })
  }

  function selectList(row: Row) {
    if (filtering() && state.filter().trim().length > 0) {
      setFilterSelected(row.key)
      return
    }
    setListSelected({ ...listSelected(), [listKey()]: row.key })
  }

  function move(delta: number) {
    const rows = focus() === "nav" ? workspace().nav : listRows()
    if (rows.length === 0) return
    const at = rows.findIndex((row) => row.key === currentRow()?.key)
    const next = rows[Math.min(rows.length - 1, Math.max(0, (at === -1 ? 0 : at) + delta))]!
    if (focus() === "nav") selectNav(next)
    else selectList(next)
  }

  function page(): number {
    const scroll = focus() === "nav" ? navScroll : listScroll
    return Math.max(1, (scroll?.viewport.height ?? 10) - 1)
  }

  // < > keep what you look at: the same agent, category and row one level
  // over (build › Tools › shell at Project, then at Global), when it exists
  // there; otherwise that level's own last place. Expansion sets follow the
  // same anchored rewrite, so an equivalent row stays open too; ids the
  // destination lacks stay inert. Presets keep their own selection by design.
  function switchLevel(delta: number) {
    const index = LEVELS.findIndex((entry) => entry.id === level())
    showLevel(LEVELS[(index + delta + LEVELS.length) % LEVELS.length]!.id)
  }

  function showLevel(next: LevelId) {
    const from = level()
    if (next === from) return
    const across = (id: string | undefined) => (id === undefined ? undefined : id.replace(new RegExp(`^(\\w+):${from}:`), `$1:${next}:`))
    const remap = (ids: ReadonlySet<string>) => new Set([...ids].map((id) => across(id)!))
    const owner = workspace().owner
    const ownerThere = owner?.role === "owner" && owner.node.kind === "agent" ? across(owner.key) : undefined
    const category = across(workspace().category?.id)
    const row = across(listRow()?.key)
    batch(() => {
      setLevel(next)
      setNavCollapsed(remap(navCollapsed()))
      setListOpen(remap(listOpen()))
      setListCollapsed(remap(listCollapsed()))
      if (ownerThere === undefined || next === "preset") return
      setOwners({ ...owners(), [next]: ownerThere })
      if (focus() === "nav" || navSelected()[next] === undefined) setNavSelected({ ...navSelected(), [next]: ownerThere })
      if (category !== undefined) setCategories({ ...categories(), [ownerThere]: category })
      if (category !== undefined && row !== undefined) setListSelected({ ...listSelected(), [`${ownerThere}|${category}`]: row })
    })
  }

  function switchCategory(to: number | ((index: number, count: number) => number)) {
    const list = workspace().categories
    const owner = workspace().owner
    if (owner === undefined || list.length === 0) return
    const index = list.findIndex((node) => node.id === workspace().category?.id)
    const next = typeof to === "number" ? to : to(index, list.length)
    const category = list[(next + list.length) % list.length]
    if (category === undefined || (typeof to === "number" && to >= list.length)) return
    setCategories({ ...categories(), [owner.key]: category.id })
  }

  function toggleFocus() {
    if (focus() === "nav") {
      if (workspace().owner !== undefined) setFocus("list")
      return
    }
    setFocus("nav")
  }

  function setOpen(row: Row, open: boolean) {
    if (focus() === "nav") {
      const next = new Set(navCollapsed())
      if (open) next.delete(row.node.id)
      else next.add(row.node.id)
      setNavCollapsed(next)
      return
    }
    const opened = new Set(listOpen())
    const closed = new Set(listCollapsed())
    if (open) {
      opened.add(row.node.id)
      closed.delete(row.node.id)
    } else {
      opened.delete(row.node.id)
      closed.add(row.node.id)
    }
    batch(() => {
      setListOpen(opened)
      setListCollapsed(closed)
    })
  }

  function hoverRow(pane: Focus, key: string, hovering: boolean) {
    setHovered((current) => {
      if (hovering) return { pane, key }
      return current?.pane === pane && current.key === key ? undefined : current
    })
  }

  // E / ctrl+E: every expandable visible row of the hovered pane (falling back
  // to the focused pane and its selected row). A mixed pane converges — any
  // collapsed row means expand all, otherwise collapse all. The active row is
  // excluded for E and included for ctrl+E; nothing eligible is a silent no-op.
  function bulkExpand(includeActive: boolean) {
    const pane = hovered()?.pane ?? focus()
    const rows = pane === "nav" ? workspace().nav : listRows()
    const active = hovered()?.pane === pane ? hovered()?.key : pane === "nav" ? navRow()?.key : listRow()?.key
    const eligible = rows.filter((row) => row.expandable && (includeActive || row.key !== active))
    if (eligible.length === 0) return
    const expand = eligible.some((row) => !row.expanded)
    if (pane === "nav") {
      const collapsed = new Set(navCollapsed())
      for (const row of eligible) {
        if (expand) collapsed.delete(row.node.id)
        else collapsed.add(row.node.id)
      }
      setNavCollapsed(collapsed)
      return
    }
    const opened = new Set(listOpen())
    const closed = new Set(listCollapsed())
    for (const row of eligible) {
      if (expand) {
        opened.add(row.node.id)
        closed.delete(row.node.id)
      } else {
        opened.delete(row.node.id)
        closed.add(row.node.id)
      }
    }
    batch(() => {
      setListOpen(opened)
      setListCollapsed(closed)
    })
  }

  // → : open a closed row; on an owner in the sidebar, go into its list.
  function right() {
    const row = currentRow()
    if (row === undefined) {
      if (focus() === "nav") toggleFocus()
      return
    }
    if (focus() === "nav" && (row.role === "owner" || row.role === "every")) {
      selectNav(row)
      setFocus("list")
      return
    }
    if (filtering() && focus() === "list" && state.filter().trim().length > 0) {
      jumpTo(row.node)
      return
    }
    if (row.expandable && !row.expanded) setOpen(row, true)
  }

  // ← : close an open row, else go to its parent; the list's top level goes
  // back to the sidebar.
  function left() {
    const row = currentRow()
    if (row !== undefined && row.expandable && row.expanded) {
      setOpen(row, false)
      return
    }
    const rows = focus() === "nav" ? workspace().nav : listRows()
    const at = rows.findIndex((entry) => entry.key === row?.key)
    const parent = at === -1 ? undefined : rows.slice(0, at).findLast((entry) => entry.depth < (row?.depth ?? 0))
    if (parent !== undefined) {
      if (focus() === "nav") selectNav(parent)
      else selectList(parent)
      return
    }
    if (focus() === "list") setFocus("nav")
  }

  // ---- filter ----

  function openFilter() {
    batch(() => {
      setFiltering(true)
      setFocus("list")
    })
  }

  function applyFilter(text: string) {
    setFilterText(text)
    if (filterTimer !== undefined) clearTimeout(filterTimer)
    filterTimer = setTimeout(() => {
      filterTimer = undefined
      const trimmed = text.trim()
      state.setFilter(trimmed.length === 0 ? "" : /(^|\s)level:/.test(trimmed) ? trimmed : `level:${level()} ${trimmed}`)
      setFilterSelected(undefined)
    }, 150)
  }

  function closeFilter() {
    if (filterTimer !== undefined) clearTimeout(filterTimer)
    batch(() => {
      setFiltering(false)
      setFilterText("")
      setFilterSelected(undefined)
      state.setFilter("")
    })
  }

  // Leave the filter at a result: show its owner and category and open the
  // rows above it.
  function jumpTo(node: TreeNode) {
    const nodes = state.nodes()
    const index = nodes.findIndex((entry) => entry.id === node.id)
    const chain: TreeNode[] = []
    let depth = node.depth
    for (let at = index - 1; at >= 0 && depth > 0; at--) {
      const entry = nodes[at]!
      if (entry.depth >= depth) continue
      chain.unshift(entry)
      depth = entry.depth
    }
    closeFilter()
    revealChain([...chain, node])
  }

  function revealChain(chain: readonly TreeNode[], row?: string) {
    const ownerIndex = chain.findIndex((entry, at) => {
      const next = chain[at + 1]
      return next !== undefined && next.kind === "group" && /:(settings|models|compaction|tools|base|skills|system|mcp)$/.test(next.id)
        && (entry.kind === "agent" || entry.kind === "team" || (entry.kind === "group" && chain[at - 1]?.kind === "root"))
    })
    const node = chain[chain.length - 1]
    if (node === undefined) return
    if (ownerIndex === -1) {
      // A sidebar row (an owner, a team, a group): select it there.
      batch(() => {
        setNavCollapsed(new Set([...navCollapsed()].filter((id) => !chain.some((entry) => entry.id === id))))
        setNavSelected({ ...navSelected(), [level()]: node.id })
        if (node.kind === "agent" || node.kind === "team") setOwners({ ...owners(), [level()]: node.id })
        setFocus("nav")
      })
      return
    }
    const owner = chain[ownerIndex]!
    const category = chain[ownerIndex + 1]!
    const ownerKey = owner.kind === "group" ? `${owner.id}#every` : owner.id
    const inside = chain.slice(ownerIndex + 2, -1).map((entry) => entry.id)
    batch(() => {
      setNavCollapsed(new Set([...navCollapsed()].filter((id) => !chain.some((entry) => entry.id === id))))
      setOwners({ ...owners(), [level()]: ownerKey })
      setNavSelected({ ...navSelected(), [level()]: ownerKey })
      setCategories({ ...categories(), [ownerKey]: category.id })
      setListOpen(new Set([...listOpen(), ...inside]))
      setListCollapsed(new Set([...listCollapsed()].filter((id) => !inside.includes(id))))
      setListSelected({ ...listSelected(), [`${ownerKey}|${category.id}`]: row ?? node.id })
      setFocus("list")
    })
  }

  // ---- review navigation ----

  function nextReview(delta: 1 | -1) {
    const targets = reviewTargets(state.treeWith, level())
    if (targets.length === 0) {
      state.setStatus(`Nothing to review in ${LEVELS.find((entry) => entry.id === level())?.label}`)
      return
    }
    const here = targets.findIndex((entry) => entry.row === current()?.id)
    const ownerOrder = workspace().nav.map((row) => row.key)
    const ownerAt = ownerOrder.indexOf(workspace().owner?.key ?? "")
    const fallback = delta > 0
      ? targets.findIndex((entry) => ownerOrder.indexOf(entry.owner) >= ownerAt)
      : targets.findLastIndex((entry) => ownerOrder.indexOf(entry.owner) <= ownerAt)
    const index = here === -1 ? (fallback === -1 ? (delta > 0 ? 0 : targets.length - 1) : fallback) : (here + delta + targets.length) % targets.length
    const chosen = targets[index]!
    batch(() => {
      setOwners({ ...owners(), [level()]: chosen.owner })
      setNavSelected({ ...navSelected(), [level()]: chosen.owner })
      setCategories({ ...categories(), [chosen.owner]: chosen.category })
      setListOpen(new Set([...listOpen(), ...chosen.open]))
      setListCollapsed(new Set([...listCollapsed()].filter((id) => !chosen.open.includes(id))))
      setListSelected({ ...listSelected(), [`${chosen.owner}|${chosen.category}`]: chosen.row })
      setFocus("list")
    })
    state.setStatus(`Review ${index + 1} of ${targets.length}`)
  }

  // ---- actions (unchanged semantics from the tree screen) ----

  // Selection follows the picker: disabled, hidden, subagent-only and
  // maintenance agents stay editable but cannot become the current agent.
  function selectableAgent(node: TreeNode | undefined): string | undefined {
    const id = selectableAgentId(node)
    if (id === undefined) return undefined
    // Row badges describe the edited tier. Selection follows the current
    // location's host catalogue, where disabled agents are absent, just as the
    // core picker does; an unloaded catalogue offers no selection yet.
    const agent = props.context.data.location.agent.list(props.context.location)?.find((entry) => entry.id === id)
    if (agent === undefined || agent.hidden || agent.mode === "subagent") return undefined
    const entry = state.snapshot()?.agents.find((candidate) => candidate.id === id)
    if (entry?.origin === "special") return undefined
    return id
  }

  function toggle() {
    const node = current()
    if (!node) return
    if (canToggle(node)) {
      void state.toggle(node)
      return
    }
    selectAgent()
  }

  function selectAgent() {
    const id = selectableAgent(current())
    if (id !== undefined) props.context.ui.agents.set?.(id)
  }

  // a: the row's own add, else the category's (a model, a skill, a base …),
  // else the generic picker.
  function add() {
    const node = current()
    const category = workspace().category
    const tool = node?.kind === "item" && node.address?.item.startsWith("tool:") === true && node.actions?.split === true
    if (focus() === "list" && node !== undefined && node.add === undefined && !tool && category?.add !== undefined) {
      void dialogs.addFor(category)
      return
    }
    void dialogs.addFor(node)
  }

  function remove() {
    const node = current()
    if (node) void state.remove(node)
  }

  function resetRow() {
    const node = current()
    if (node) void state.reset(node)
  }

  function pin() {
    const node = current()
    if (node) void state.togglePin(node)
  }

  // The permission row a node addresses; undefined for every other node.
  function permItem(node: TreeNode) {
    const item = node.address?.item
    if (item === undefined || !item.startsWith("perm:") || node.address?.section !== null) return undefined
    return state.snapshot()?.items.find((entry) => entry.id === item)
  }

  function openMode(next: Mode, node: TreeNode) {
    batch(() => {
      setTarget(node)
      setMode(next)
    })
  }

  function back() {
    batch(() => {
      setMode("browse")
      setTarget(undefined)
    })
  }

  function edit() {
    const node = current()
    if (node === undefined || !isEditable(node)) return
    if (node.badges.disabled !== undefined) {
      state.setStatus(node.badges.disabled)
      return
    }
    openMode("edit", node)
  }

  // Rows whose text is prose (items, sections), where a diff says something.
  function comparable(node: TreeNode | undefined): boolean {
    const item = node?.address?.item
    return item !== undefined && controlKind(item) === undefined && !item.startsWith("perm:") && !item.startsWith("model:")
  }

  function compare() {
    const node = current()
    if (node === undefined || !comparable(node)) return
    if (state.threeWay(node) === undefined) {
      state.setStatus(`"${node.label}" has no text of its own at this level to compare`)
      return
    }
    openMode("diff", node)
  }

  function split() {
    const node = current()
    if (node?.actions?.split === true) openMode("split", node)
  }

  // Enter on a normal row opens the editor; on a review row the review: a
  // keep/take choice for a changed state, pin or active model (§3.6), the diff
  // for text (after the choice when both are under review); on a permission
  // row the rule editor; on a control the cycle or toggle.
  function enter() {
    const node = current()
    const row = currentRow()
    if (node === undefined) return
    if (focus() === "nav") {
      if (row !== undefined && (row.role === "owner" || row.role === "every")) right()
      else if (row?.expandable === true) setOpen(row, !row.expanded)
      return
    }
    if (filtering() && state.filter().trim().length > 0) {
      jumpTo(node)
      return
    }
    if (node.address === undefined) {
      if (row?.expandable === true) setOpen(row, !row.expanded)
      return
    }
    if (node.badges.disabled !== undefined) {
      state.setStatus(node.badges.disabled)
      return
    }
    const control = controlKind(node.address.item)
    if (control === "cycle") {
      void state.cycle(node)
      return
    }
    if (isReview(node)) {
      if (node.address.item.startsWith("model:")) {
        void reviewModel(node)
        return
      }
      const parts = node.badges.reviewOf ?? []
      if (parts.some((part) => part !== "text")) {
        void reviewState(node, parts.includes("text"))
        return
      }
      openMode("diff", node)
      return
    }
    if (control === "toggle") {
      void state.toggle(node)
      return
    }
    if (node.address.item.startsWith("perm:")) {
      const item = permItem(node)
      // A limit or bound is a number; a row with no patterns is a switch;
      // every other permission row opens the rule editor.
      if (item !== undefined && isValueRow(item)) {
        void editNumber(node)
        return
      }
      if (item !== undefined && (item.patterns ?? []).length === 0) {
        props.context.ui.toast.show({ variant: "info", message: `"${node.label}" is a switch: space turns it on or off` })
        return
      }
      void dialogs.editRule(node)
      return
    }
    if (isEditable(node) && control === "text" && node.address.item !== "compaction:instructions") {
      void editValue(node)
      return
    }
    if (isEditable(node)) {
      openMode("edit", node)
      return
    }
    if (row?.expandable === true) setOpen(row, !row.expanded)
  }

  // A one-line setting (Description, Color, Steps, Compaction model) edits in
  // a prompt; an empty answer clears it, as the controls document.
  async function editValue(node: TreeNode): Promise<void> {
    const raw = await props.context.ui.dialog.prompt({
      title: node.label,
      description: controlHelp(node.address?.item),
      value: state.resolvedText(node),
    })
    if (raw === undefined) return
    await state.saveText(node, raw.trim())
  }

  // State and pin: "Keep yours (off)" re-records the value above and keeps
  // yours; "Take from preset X (on)" drops yours so the row follows it again.
  // Text under review too opens the diff afterwards.
  async function reviewState(node: TreeNode, text: boolean): Promise<void> {
    const choice = state.reviewChoice(node)
    if (choice === undefined) {
      if (text) openMode("diff", node)
      return
    }
    const picked = await props.context.ui.dialog.select<"keep" | "take">({
      title: `Review "${node.label}"`,
      placeholder: `The ${choice.parts.join(" and ")} above changed since you set yours`,
      options: [
        { title: `Keep yours (${choice.mine})`, value: "keep", description: "Your setting stays; the change above is acknowledged" },
        { title: `Take ${choice.from} (${choice.above})`, value: "take", description: "Drop yours and follow it again" },
      ],
    })
    if (picked === undefined) return
    const resolved = picked === "keep" ? await state.resolveKeep(node, choice.parts) : await state.resolveTake(node, choice.parts)
    if (resolved && text) openMode("diff", node)
  }

  // Active model: keep acknowledges the model above and keeps yours active;
  // take clears your active model so the one above wins again.
  async function reviewModel(node: TreeNode): Promise<void> {
    const choice = state.modelReview(node)
    if (choice === undefined) return
    const picked = await props.context.ui.dialog.select<"keep" | "take">({
      title: `Review "${node.label}"`,
      placeholder: "The active model above changed since you chose yours",
      options: [
        { title: `Keep yours (${choice.mine})`, value: "keep", description: "Your model stays active; the change above is acknowledged" },
        {
          title: choice.above === undefined ? "Take the model above (none)" : `Take ${choice.from} (${choice.above})`,
          value: "take",
          description: "Clear your active model and follow it again",
        },
      ],
    })
    if (picked === undefined) return
    await state.resolveModel(node, picked)
  }

  // Enter on a limit or bound row: the number is the row's text. Off (space)
  // removes the cap; the number stays for when it is switched back on.
  async function editNumber(node: TreeNode): Promise<void> {
    const raw = await props.context.ui.dialog.prompt({
      title: node.label,
      description: "A number. Space switches the cap off and on.",
      value: state.resolvedText(node),
    })
    if (raw === undefined) return
    const value = limitOf(raw)
    if (value === undefined) {
      props.context.ui.toast.show({ variant: "error", message: `"${node.label}" takes a number` })
      return
    }
    await state.saveText(node, String(value))
  }

  async function resolveDiff(resolution: Resolution, edited?: string): Promise<void> {
    const node = target()
    if (!node) {
      back()
      return
    }
    const done = resolution === "keep"
      ? await state.resolveKeep(node)
      : resolution === "take"
        ? await state.resolveTake(node)
        : edited === undefined ? false : await state.resolveEdit(node, edited)
    if (done) back()
  }

  async function saveSplitBoundaries(boundaries: { id: string; name: string; start: number }[]): Promise<void> {
    const node = target()
    if (!node) {
      back()
      return
    }
    // Validate through the same manual() call the splitter previews with so
    // preview and save always agree.
    manual(state.resolvedText(node), boundaries)
    await state.saveSplit(node, boundaries)
    back()
  }

  function splitInitial(node: TreeNode): { id: string; name: string; start: number }[] | undefined {
    const preview = state.splitPreview(node)
    if (!preview || preview.kind !== "manual") return undefined
    return preview.sections.map((section) => ({ id: section.id, name: section.name, start: section.start }))
  }

  function openHelp() {
    props.context.ui.dialog.show(() => <HelpDialog context={props.context} />)
    // replace() resets centered, so the options must follow show().
    props.context.ui.dialog.set({ size: dimensions().width >= HELP_WIDE ? "xlarge" : "large", centered: true })
  }

  function escape() {
    if (filtering()) {
      closeFilter()
      return
    }
    if (focus() === "list") {
      setFocus("nav")
      return
    }
    props.onClose()
  }

  // ---- breadcrumbs ----

  function pathOf(node: TreeNode | undefined, label?: string): string {
    const levelLabel = LEVELS.find((entry) => entry.id === level())?.label ?? ""
    if (node === undefined) return levelLabel
    const chain = ancestry(workspace().parents, node).map((entry) => entry.label)
    return [levelLabel, ...chain, label ?? node.label].join(" › ")
  }

  function breadcrumb(): string {
    const row = currentRow()
    return pathOf(row?.node ?? current(), row?.label)
  }

  // ---- keys ----

  const inList = () => focus() === "list"

  function hints(): (readonly [string, string])[] {
    if (resizing() !== undefined) {
      const selected = resizing()!
      return [
        ["←/[", "move divider left"],
        ["→/]", "move divider right"],
        ["tab", "switch panel"],
        ["enter/esc", "save"],
        ["W", `${selected === "owners" ? "Owners" : "Inspector"} ${selected === "owners" ? ownersWidth() : inspectorWidth()} cols`],
      ]
    }
    if (state.snapshot() === undefined) return [["esc", "back"]]
    if (filtering()) return [["type", "to filter"], ["↑↓", "move"], ["enter", "go to"], ["ctrl+space", "toggle"], ["esc", "clear filter"]]
    const node = current()
    const row = currentRow()
    const hints: [string, string][] = [["↑↓", "move"]]
    if (focus() === "nav") {
      if (row?.role === "owner" || row?.role === "every") hints.push(["→", "open"])
      else if (row?.expandable === true) hints.push(["←→", row.expanded ? "close" : "open"])
    }
    if (inList()) {
      const perm = node === undefined ? undefined : permItem(node)
      const control = controlKind(node?.address?.item)
      if (node?.badges.disabled !== undefined) hints.push(["", "local settings unavailable in Remote"])
      else if (control === "cycle") hints.push(["enter", "cycle"])
      else if (isReview(node)) hints.push(["enter", "review"])
      else if (control === "toggle") hints.push(["enter", "toggle"])
      else if (perm !== undefined && isValueRow(perm)) hints.push(["enter", "edit number"])
      else if (perm !== undefined && (perm.patterns ?? []).length > 0) hints.push(["enter", "edit rule"])
      else if (isEditable(node)) hints.push(["enter", "edit"])
      if (row?.expandable === true) hints.push(["←→", row.expanded ? "close" : "open"])
    }
    if (canToggle(node)) hints.push(["space", node?.address?.item.startsWith("perm:") === true && (permItem(node!)?.patterns ?? []).length === 0 ? "switch" : "toggle"])
    else if (selectableAgent(node) !== undefined) hints.push(["space", "select"])
    if (canToggle(node) && selectableAgent(node) !== undefined) hints.push(["ctrl+space", "select"])
    if (inList() && comparable(node) && state.threeWay(node!) !== undefined) hints.push(["c", "compare"])
    if (canPin(node)) hints.push(["p", "pin"])
    hints.push(["a", "add"])
    if (isLinkable(node?.owner)) hints.push(["l", "link"])
    if (node?.actions?.remove === true) hints.push(["d", "delete"])
    if (canReset(node)) hints.push(["r", node?.enabledRow === undefined ? "reset" : "reset controls"])
    if (node?.actions?.split === true) hints.push(["s", "split"])
    if ((workspace().levels.find((entry) => entry.id === level())?.review ?? 0) > 0) hints.push(["n", "next review"])
    if (workspace().categories.length > 1) hints.push(["[ ]", "category"])
    hints.push(["tab", focus() === "nav" ? "list" : "sidebar"], ["/", "filter"], ["?", "help"])
    hints.push(["esc", focus() === "nav" ? "close" : "sidebar"])
    return hints
  }

  props.context.keymap.layer(() => {
    if (state.snapshot() === undefined) return { commands: [{ bind: "escape", title: "Back", group: "Instructions", run: () => props.onClose() }] }
    // Focus views own their keys; the diff and the splitter leave esc to us.
    if (mode() === "edit") return { commands: [] }
    if (mode() !== "browse") return { commands: [{ bind: "escape", title: "Back", group: "Instructions", run: back }] }
    if (resizing() !== undefined)
      return {
        commands: [
          { bind: "left,[", title: "Move the divider left", group: "Instructions", run: () => moveDivider(-1) },
          { bind: "right,]", title: "Move the divider right", group: "Instructions", run: () => moveDivider(1) },
          { bind: "tab,shift+tab", title: "Switch panel", group: "Instructions", run: cycleResize },
          { bind: "return", title: "Save panel widths", group: "Instructions", run: commitResize },
          { bind: "escape", title: "Save panel widths", group: "Instructions", run: commitResize },
          { bind: "shift+w,alt+w", title: "Save panel widths", group: "Instructions", run: commitResize },
        ],
      }
    if (filtering())
      return {
        commands: [
          { bind: "up", title: "Previous result", group: "Instructions", run: () => move(-1) },
          { bind: "down", title: "Next result", group: "Instructions", run: () => move(1) },
          { bind: "return", title: "Go to result", group: "Instructions", run: enter },
          { bind: "ctrl+space", title: "Toggle", group: "Instructions", run: toggle },
          { bind: "escape", title: "Clear filter", group: "Instructions", run: escape },
        ],
      }
    const node = current()
    return {
      commands: [
        { bind: "up", title: "Previous row", group: "Instructions", run: () => move(-1) },
        { bind: "down", title: "Next row", group: "Instructions", run: () => move(1) },
        { bind: "pageup", title: "Page up", group: "Instructions", run: () => move(-page()) },
        { bind: "pagedown", title: "Page down", group: "Instructions", run: () => move(page()) },
        { bind: "home", title: "First row", group: "Instructions", run: () => move(-100000) },
        { bind: "end", title: "Last row", group: "Instructions", run: () => move(100000) },
        { bind: "left", title: "Close or back", group: "Instructions", run: left },
        { bind: "right", title: "Open", group: "Instructions", run: right },
        { bind: "return", title: "Open or edit", group: "Instructions", run: enter },
        { bind: "tab", title: "Switch pane", group: "Instructions", run: toggleFocus },
        { bind: "shift+tab", title: "Next level", group: "Instructions", run: () => switchLevel(1) },
        { bind: "shift+left,shift+[,{,shift+{", title: "Previous level", group: "Instructions", run: () => switchLevel(-1) },
        { bind: "shift+right,shift+],},shift+}", title: "Next level", group: "Instructions", run: () => switchLevel(1) },
        { bind: "<", title: "Previous level", group: "Instructions", run: () => switchLevel(-1) },
        { bind: ">", title: "Next level", group: "Instructions", run: () => switchLevel(1) },
        { bind: "shift+1,!,shift+!", title: "Show Project", group: "Instructions", run: () => showLevel("project") },
        { bind: "shift+2,@,shift+@", title: "Show Global", group: "Instructions", run: () => showLevel("global") },
        { bind: "shift+3,#,shift+#", title: "Show Defaults", group: "Instructions", run: () => showLevel("defaults") },
        { bind: "shift+4,$,shift+$", title: "Show Presets", group: "Instructions", run: () => showLevel("preset") },
        { bind: "shift+e", title: "Expand all rows", group: "Instructions", run: () => bulkExpand(false) },
        { bind: "ctrl+e", title: "Expand all rows including this one", group: "Instructions", run: () => bulkExpand(true) },
        ...(wide() ? [{ bind: "shift+w,alt+w", title: "Resize panels", group: "Instructions", run: startResize }] : []),
        { bind: "[", title: "Previous category", group: "Instructions", run: () => switchCategory((index, count) => (index - 1 + count) % count) },
        { bind: "]", title: "Next category", group: "Instructions", run: () => switchCategory((index, count) => (index + 1) % count) },
        ...workspace().categories.map((category, index) => ({
          bind: String(index + 1),
          title: `Show ${category.label}`,
          group: "Instructions",
          run: () => switchCategory(index),
        })),
        ...(canToggle(node)
          ? [{ bind: "space", title: "Toggle", group: "Instructions", run: toggle }]
          : selectableAgent(node) !== undefined
            ? [{ bind: "space", title: "Select agent", group: "Instructions", run: toggle }]
            : []),
        ...(canToggle(node) && selectableAgent(node) !== undefined
          ? [{ bind: "ctrl+space", title: "Select agent", group: "Instructions", run: selectAgent }]
          : []),
        ...(inList() && isEditable(node) ? [{ bind: "e", title: "Edit text", group: "Instructions", run: edit }] : []),
        ...(inList() && comparable(node) ? [{ bind: "c", title: "Compare with upstream", group: "Instructions", run: compare }] : []),
        ...(canPin(node) ? [{ bind: "p", title: "Pin Code Mode tool", group: "Instructions", run: pin }] : []),
        { bind: "a", title: "Add", group: "Instructions", run: add },
        ...(isLinkable(node?.owner) ? [{ bind: "l", title: "Link to preset", group: "Instructions", run: () => void dialogs.relink(current()) }] : []),
        { bind: "d", title: "Delete", group: "Instructions", run: remove },
        ...(canReset(node) ? [{ bind: "r", title: "Reset override", group: "Instructions", run: resetRow }] : []),
        ...(node?.actions?.split === true ? [{ bind: "s", title: "Split", group: "Instructions", run: split }] : []),
        { bind: "n", title: "Next to review", group: "Instructions", run: () => nextReview(1) },
        { bind: "shift+n", title: "Previous to review", group: "Instructions", run: () => nextReview(-1) },
        { bind: "shift+up", title: "Scroll details up", group: "Instructions", run: () => inspectorScroll?.scrollBy(-3) },
        { bind: "shift+down", title: "Scroll details down", group: "Instructions", run: () => inspectorScroll?.scrollBy(3) },
        { bind: "/", title: "Filter", group: "Instructions", run: openFilter },
        { bind: "?", title: "Help", group: "Instructions", run: openHelp },
        { bind: "escape", title: focus() === "nav" ? "Close" : "Back to the sidebar", group: "Instructions", run: escape },
      ],
    }
  })

  // ---- view ----

  const Tabs = () => (
    <box flexDirection="row" flexShrink={0} height={1} paddingLeft={1} paddingRight={1} gap={2}>
      <text flexShrink={0} fg={theme().text.base} attributes={TextAttributes.BOLD}>
        Instructions
      </text>
      <For each={workspace().levels}>
        {(entry) => (
          <text flexShrink={0} wrapMode="none" onMouseUp={() => showLevel(entry.id)}>
            <span style={{ fg: entry.id === level() ? theme().text.action.secondary.hovered : theme().text.muted }}>
              {entry.id === level() ? <b><u>{entry.label}</u></b> : entry.label}
            </span>
            <Show when={entry.review > 0}>
              <span style={{ fg: theme().text.feedback.warning.base }}>{` !${entry.review}`}</span>
            </Show>
          </text>
        )}
      </For>
      <box flexGrow={1} />
      <Show when={state.loading()}>
        <text flexShrink={0} fg={theme().text.muted}>
          …
        </text>
      </Show>
      <text flexShrink={0} fg={theme().text.base} onMouseUp={openHelp}>
        ?<span style={{ fg: theme().text.muted }}> help</span>
      </text>
    </box>
  )

  const categoryColor = (index: number) => {
    const scale = theme().categorical[index % theme().categorical.length]
    return scale === undefined ? theme().text.base : scale[props.context.themeMode === "light" ? 800 : 200]
  }

  // The digits go first when the tabs would not fit on one line. The list's
  // real width: whatever the fixed Owners and Inspector (or the resize draft)
  // leave between their divider columns.
  const listWidth = () => (wide() ? Math.max(0, dimensions().width - ownersWidth() - inspectorWidth() - DIVIDERS) : dimensions().width - 2)
  const digits = () => workspace().categories.reduce((total, category) => total + category.label.length + 5, 0) <= listWidth()

  const CategoryTabs = () => (
    <box flexDirection="row" flexShrink={0} flexWrap="wrap" columnGap={digits() ? 1 : 2} overflow="hidden">
      <For each={workspace().categories}>
        {(category, index) => {
          const selected = () => category.id === workspace().category?.id
          const review = () => category.badges.reviewCount ?? 0
          return (
            <text flexShrink={0} wrapMode="none" onMouseUp={() => switchCategory(index())}>
              <span style={{ fg: theme().text.muted }}>{digits() ? `${index() + 1} ` : ""}</span>
              <span style={{ fg: selected() ? categoryColor(index()) : theme().text.muted }}>
                {selected() ? <b><u>{category.label}</u></b> : category.label}
              </span>
              <Show when={category.id.endsWith(":tools") ? toolCount(workspace().owner?.key) : undefined}>
                {(count) => <span style={{ fg: count().on === 0 ? theme().text.feedback.warning.base : theme().text.muted }}>{` ${count().on}`}</span>}
              </Show>
              <Show when={review() > 0}>
                <span style={{ fg: theme().text.feedback.warning.base }}>{` !${review()}`}</span>
              </Show>
            </text>
          )
        }}
      </For>
    </box>
  )

  const Sidebar = () => (
    <box flexDirection="column" minHeight={0} flexGrow={wide() ? 0 : 1} width={wide() ? ownersWidth() : "100%"} flexShrink={0} backgroundColor={theme().background.raised.base}>
      <Show when={workspace().nav.length > 0} fallback={<text fg={theme().text.muted} paddingLeft={1}>{state.loading() ? "Loading…" : "Nothing at this level"}</text>}>
        <scrollbox flexGrow={1} minHeight={0} ref={(next: ScrollBoxRenderable) => (navScroll = next)} verticalScrollbarOptions={{ visible: false }}>
          <For each={workspace().nav}>
            {(row) => (
              <RowLine
                context={props.context}
                row={row}
                sidebar
                {...(row.role === "owner" || row.role === "every" ? { tools: toolCount(row.key)?.on } : {})}
                selected={row.key === navRow()?.key}
                focused={focus() === "nav" && !modal()}
                onHoverChange={(hovering) => hoverRow("nav", row.key, hovering)}
                onSelect={() => {
                  selectNav(row)
                  setFocus("nav")
                }}
                onActivate={enter}
              />
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  )

  // Inside a preset its rows read "from preset <itself>": say nothing then.
  const selfPreset = () => {
    const owner = workspace().owner?.node
    return owner?.owner?.preset === undefined ? undefined : owner.badges.fromLabel
  }
  const ownerSource = (node: TreeNode) => {
    const from = node.badges.fromLabel
    if (from === undefined || from === "upstream" || from === "OpenCode" || from === "set here" || from === selfPreset()) return undefined
    return from
  }

  const List = () => (
    <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      <Show
        when={filtering()}
        fallback={
          <box flexDirection="column" flexShrink={0} paddingLeft={1}>
            <Show when={workspace().owner} fallback={<text fg={theme().text.muted}>Select an agent, member or preset</text>}>
              {(owner) => (
                <box flexDirection="column" flexShrink={0}>
                  <text flexShrink={0} wrapMode="none" truncate>
                    <span style={{ fg: theme().text.base }}>
                      <b>{owner().label}</b>
                    </span>
                    <span style={{ fg: theme().text.muted }}>{`  ${[owner().node.badges.mode, owner().node.badges.state, ownerSource(owner().node)].filter((part) => part !== undefined).join(" · ")}`}</span>
                  </text>
                  <Show when={toolCount(owner().key)}>
                    {(count) => (
                      <text
                        flexShrink={0}
                        wrapMode="none"
                        truncate
                        fg={count().on === 0 ? theme().text.feedback.warning.base : theme().text.muted}
                      >
                        {toolHint(count())}
                      </text>
                    )}
                  </Show>
                </box>
              )}
            </Show>
            <CategoryTabs />
          </box>
        }
      >
        <box flexDirection="row" flexShrink={0} paddingLeft={1} gap={1}>
          <text flexShrink={0} fg={theme().text.base}>
            /
          </text>
          <input
            flexGrow={1}
            value={filterText()}
            placeholder={`filter ${LEVELS.find((entry) => entry.id === level())?.label}: words or key:value`}
            placeholderColor={theme().text.muted}
            focusedBackgroundColor={theme().background.formfield.focused}
            focusedTextColor={theme().text.formfield.focused}
            cursorColor={theme().text.formfield.focused}
            onInput={applyFilter}
            ref={(next) => {
              setTimeout(() => {
                if (!next.isDestroyed) next.focus()
              }, 1)
            }}
          />
        </box>
      </Show>
      <box flexShrink={0} height={1} />
      <Show
        when={listRows().length > 0}
        fallback={
          <text paddingLeft={1} fg={theme().text.muted}>
            {filtering() ? (state.filter().trim().length === 0 ? "Type to filter" : "No matches") : workspace().category?.add === undefined ? "Nothing here" : "Nothing here yet · a adds one"}
          </text>
        }
      >
        <scrollbox flexGrow={1} minHeight={0} ref={(next: ScrollBoxRenderable) => (listScroll = next)} verticalScrollbarOptions={{ visible: false }}>
          <For each={listRows()}>
            {(row) => (
              <RowLine
                context={props.context}
                row={row}
                quiet={selfPreset()}
                selected={row.key === listRow()?.key}
                focused={focus() === "list" && !modal()}
                onHoverChange={(hovering) => hoverRow("list", row.key, hovering)}
                onSelect={() => {
                  selectList(row)
                  setFocus("list")
                }}
                onActivate={enter}
              />
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  )

  const Details = () => (
    <Inspector
      context={props.context}
      node={current}
      label={() => currentRow()?.label}
      snapshot={state.snapshot}
      path={breadcrumb}
      children={() => {
        const row = currentRow()
        const rows = focus() === "nav" ? workspace().nav : listRows()
        const at = rows.findIndex((entry) => entry.key === row?.key)
        if (row === undefined || at === -1) return focus() === "list" ? workspace().list.filter((entry) => entry.depth === 0) : []
        const out: Row[] = []
        for (let index = at + 1; index < rows.length && rows[index]!.depth > row.depth; index++) if (rows[index]!.depth === row.depth + 1) out.push(rows[index]!)
        return out
      }}
      ref={(next) => (inspectorScroll = next)}
      tools={() => {
        const row = currentRow()
        return row !== undefined && (row.role === "owner" || row.role === "every") ? toolCount(row.key) : undefined
      }}
    />
  )

  // One divider column per boundary: idle it shows the border line, hovered or
  // dragged the raised hover state, and while it is the keyboard-selected panel
  // the action highlight. Drag state lives on the wide Browse root so a drag
  // keeps resizing outside the handle.
  const Divider = (props: { readonly resize: ReturnType<typeof createPaneResize>; readonly active: boolean }) => (
    <box
      width={1}
      height="100%"
      flexShrink={0}
      border={["left"]}
      borderColor={theme().border.base}
      backgroundColor={
        props.active
          ? theme().background.action.primary.hovered
          : props.resize.hovered() || props.resize.resizing()
            ? theme().background.raised.high
            : undefined
      }
      onMouseOver={props.resize.onMouseOver}
      onMouseOut={props.resize.onMouseOut}
      onMouseDown={props.resize.onMouseDown}
    />
  )

  const Browse = () => (
    <box
      flexDirection="row"
      flexGrow={1}
      minHeight={0}
      onMouseDrag={(event) => {
        ownersResize.onMouseDrag(event)
        inspectorResize.onMouseDrag(event)
      }}
      onMouseDragEnd={(event) => {
        ownersResize.onMouseDragEnd(event)
        inspectorResize.onMouseDragEnd(event)
      }}
      onMouseUp={(event) => {
        ownersResize.onMouseUp(event)
        inspectorResize.onMouseUp(event)
      }}
    >
      <Show when={wide() || focus() === "nav"}>
        <Sidebar />
      </Show>
      <Show when={wide()}>
        <Divider resize={ownersResize} active={resizing() === "owners"} />
      </Show>
      <Show when={wide() || focus() === "list"}>
        <box flexDirection={wide() ? "row" : "column"} flexGrow={1} minWidth={0} minHeight={0}>
          <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} minHeight={0} overflow="hidden">
            <List />
          </box>
          <Show when={wide()}>
            <Divider resize={inspectorResize} active={resizing() === "inspector"} />
          </Show>
          <box
            flexDirection="column"
            flexGrow={0}
            flexShrink={0}
            overflow="hidden"
            {...(wide() ? { width: inspectorWidth() } : { height: Math.max(6, Math.floor(dimensions().height * 0.4)) })}
            minWidth={0}
            minHeight={0}
            border={wide() ? [] : ["top"]}
            borderColor={theme().border.base}
          >
            <Details />
          </box>
        </box>
      </Show>
    </box>
  )

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme().background.base}>
      <Show
        when={state.snapshot() !== undefined}
        fallback={
          <box flexGrow={1} minHeight={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
            <text fg={theme().text.feedback.info.base}>{state.status() || "No snapshot loaded"}</text>
          </box>
        }
      >
        <Tabs />
        <text flexShrink={0} paddingLeft={1} wrapMode="none" truncate fg={theme().text.muted}>
          {mode() === "browse" ? breadcrumb() : ""}
        </text>
        <Show when={mode() === "browse"}>
          <Browse />
        </Show>
        <Show when={mode() === "edit" ? target() : undefined}>
          {(node) => (
            <EditorPane
              context={props.context}
              title={node().label}
              path={pathOf(node())}
              initial={state.resolvedText(node())}
              active={() => mode() === "edit"}
              onSave={(text) => state.saveText(node(), text)}
              onClose={back}
            />
          )}
        </Show>
        <Show when={mode() === "diff" ? target() : undefined}>
          {(node) => (
            <Show when={state.threeWay(node())} fallback={<text paddingLeft={1} fg={theme().text.muted}>Nothing to compare · esc back</text>}>
              {(three) => (
                <DiffPane
                  context={props.context}
                  title={node().label}
                  path={pathOf(node())}
                  threeWay={three()}
                  active={() => mode() === "diff"}
                  review={node().badges.review === true}
                  onResolve={resolveDiff}
                />
              )}
            </Show>
          )}
        </Show>
        <Show when={mode() === "split" ? target() : undefined}>
          {(node) => (
            <Splitter
              context={props.context}
              title={node().label}
              text={state.resolvedText(node())}
              initial={splitInitial(node())}
              active={() => mode() === "split"}
              onSave={(boundaries) => saveSplitBoundaries(boundaries)}
              onCancel={back}
            />
          )}
        </Show>
      </Show>
      <Show when={state.status()}>
        {(line) => (
          <text flexShrink={0} paddingLeft={1} wrapMode="none" truncate fg={theme().text.feedback.info.base}>
            {line()}
          </text>
        )}
      </Show>
      <Show when={mode() === "browse"}>
        <KeyHints context={props.context} hints={fitHints(hints(), dimensions().width - 2)} />
      </Show>
    </box>
  )
}
