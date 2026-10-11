import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createRoot, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Definition, type TeamLevel, type TeamListEntry, type TeamRunEntry } from "../rpc.js"
import { SessionRunEvents } from "../teams/session-events.js"

export interface ActiveTeamInfo {
  readonly team: string
  readonly name: string
  readonly level: TeamLevel
  readonly members: readonly string[]
}

export function createActiveTeam(
  context: Plugin.Context,
  options: { readonly openMonitor?: (sessionID: string) => void } = {},
) {
  const plus = context.client.rpc(Definition)

  return createRoot((disposeRoot) => {
    const [teams, setTeams] = createSignal<readonly TeamListEntry[]>([])
    let disposed = false
    let generation = 0

    function targetLocation() {
      const current = context.location
      if (current !== undefined) return { directory: current.directory, workspace: current.workspaceID }
      const fallback = context.data.location.default()
      if (fallback === undefined) return undefined
      return { directory: fallback.directory, workspace: fallback.workspaceID }
    }

    function refreshTeams() {
      const requestGen = ++generation
      const location = targetLocation()
      void plus["team.list"](undefined, { location }).then(
        (output) => {
          if (disposed || requestGen !== generation) return
          setTeams(output.teams)
        },
        () => {
          if (disposed || requestGen !== generation) return
          setTeams([])
        },
      )
    }

    createEffect(() => {
      targetLocation()
      refreshTeams()
    })

    const unsubscribe = plus.events.on("teams.changed", () => {
      if (disposed) return
      const syncPromise = context.data.location.agent?.sync?.(context.location)
      if (syncPromise && typeof syncPromise.then === "function") {
        void syncPromise.then(
          () => {
            if (!disposed) refreshTeams()
          },
          () => {
            if (!disposed) refreshTeams()
          },
        )
      } else {
        refreshTeams()
      }
    })

    // T4: an Instructions model activation changes a host agent's model, but
    // the host's agent.updated refresh does not reach this TUI's core agent
    // list, so the composer keeps a stale remembered model. Re-sync the agent
    // list on every Instructions store change; the local model context then
    // drops the stale picks and follows the new configured model.
    const unsubscribeInstructions = plus.events.on("instructions.changed", () => {
      if (disposed) return
      context.data.location.agent?.invalidate?.(context.location)
      void context.data.location.agent?.sync?.(context.location)
    })

    const [storage, setStorage] = context.storage.store<{
      activeTeamByProject: Record<string, string | undefined>
    }>("active-team", {
      initial: { activeTeamByProject: {} },
    })

    const projectKey = () => context.location?.directory ?? "default"

    const groupId = (team: { level: string; team: string }) => `team:${team.level}:${team.team}`
    const groupLabel = (team: { level: string; team: string }) => `Team: ${team.team} (${team.level})`

    const unregisterGroups = context.ui.agents.groups(() => {
      const allTeams = teams()
      const hostAgents = context.data.location.agent.list(context.location) ?? context.data.location.agent.list() ?? []
      const hostAgentIds = new Set(hostAgents.map((a) => a.id))

      return allTeams
        .filter((t) => t.enabled)
        .map((t) => ({
          id: groupId(t),
          label: groupLabel(t),
          agents: t.members.filter((m) => hostAgentIds.has(m.id)).map((m) => m.id),
        }))
    })

    const currentActiveGroupId = () => context.ui.agents.activeGroup.current()

    const activeTeamEntry = createMemo(() => {
      const currentId = currentActiveGroupId()
      if (!currentId) return undefined
      return teams().find((t) => t.enabled && groupId(t) === currentId)
    })

    const activeTeam = createMemo<ActiveTeamInfo | undefined>(() => {
      const entry = activeTeamEntry()
      if (!entry) return undefined
      return {
        team: entry.team,
        name: entry.team,
        level: entry.level,
        members: entry.members.map((m) => m.id),
      }
    })

    let hydrated = false
    createEffect(() => {
      const list = teams()
      if (hydrated || list.length === 0) return
      hydrated = true
      const saved = storage.activeTeamByProject[projectKey()]
      if (saved) {
        const matching = list.find((t) => t.enabled && groupId(t) === saved)
        if (matching) {
          context.ui.agents.activeGroup.set(saved)
        } else {
          setStorage((draft) => {
            draft.activeTeamByProject[projectKey()] = undefined
          })
        }
      }
    })

    createEffect(() => {
      const active = activeTeam()
      const key = projectKey()
      if (active) {
        const id = groupId(active)
        if (storage.activeTeamByProject[key] !== id) {
          setStorage((draft) => {
            draft.activeTeamByProject[key] = id
          })
        }
      } else {
        if (storage.activeTeamByProject[key] !== undefined) {
          setStorage((draft) => {
            draft.activeTeamByProject[key] = undefined
          })
        }
      }
    })

    // The server keeps exactly one team enabled (team.setEnabled disables
    // the others), so enabling a team in /instructions is the same gesture
    // as picking one of its members in Select agent or team: the enabled
    // team becomes the active ring. Only a CHANGE in which team is enabled
    // activates it, so a user who picked a normal agent while a team stays
    // enabled is not pulled back into the team on every refresh.
    let previousEnabledId: string | undefined = undefined
    let enabledSeen = false
    createEffect(() => {
      const list = teams()
      const enabled = list.find((t) => t.enabled)
      const enabledId = enabled ? groupId(enabled) : undefined
      if (!enabledSeen) {
        enabledSeen = list.length > 0
        previousEnabledId = enabledId
        return
      }
      if (enabledId === previousEnabledId) return
      previousEnabledId = enabledId
      if (enabledId === undefined) return
      if (currentActiveGroupId() === enabledId) return
      const members = enabled?.members.map((m) => m.id) ?? []
      const hostAgents = context.data.location.agent.list(context.location) ?? context.data.location.agent.list() ?? []
      // Selecting the first installed member makes the footer and the ring
      // agree immediately; when the host has not listed the members yet the
      // group alone is set and current() falls back to the ring's first entry.
      const first = members.find((id) => hostAgents.some((a) => a.id === id))
      context.ui.agents.activeGroup.set(enabledId)
      // An open chat keeps its agent; only the home screen follows the new ring.
      if (first !== undefined && context.ui.router.current().type !== "session") context.ui.agents.set?.(first)
    })

    let previousActiveTeamName: string | undefined = undefined
    createEffect(() => {
      const currentActive = activeTeam()
      const currentGroupId = currentActiveGroupId()
      const list = teams()

      if (currentGroupId && currentGroupId.startsWith("team:") && !currentActive && list.length > 0) {
        const teamName = previousActiveTeamName ?? currentGroupId.split(":")[2] ?? "Team"
        context.ui.agents.activeGroup.set(undefined)
        context.ui.toast.show({
          variant: "info",
          message: `Team ${teamName} disabled; back to Agents`,
        })
        setStorage((draft) => {
          draft.activeTeamByProject[projectKey()] = undefined
        })
      }
      previousActiveTeamName = currentActive?.name
    })

    const disposeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render() {
        return (
          <Show when={activeTeam()}>
            {(team) => <text fg={context.theme.text.muted}>{` · team ${team().name}`}</text>}
          </Show>
        )
      },
    })

    const [showInactiveSignal, setShowInactiveSignal] = createSignal(false)
    const [treeViewSignal, setTreeViewSignal] = createSignal(true)

    const [selection, setSelection] = createStore<Record<string, number>>({})
    const disposePanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "plus.team"}>
          <TeamMonitorTab
            sessionID={panel.sessionID}
            active={() => panel.focused}
            close={panel.close}
            toggleFullscreen={panel.toggleFullscreen}
            focus={panel.focus}
            selected={() => selection[panel.sessionID] ?? 0}
            onSelect={(index) => setSelection(panel.sessionID, index)}
            activeTeam={activeTeam}
            context={context}
            showInactive={showInactiveSignal}
            setShowInactive={setShowInactiveSignal}
            treeView={treeViewSignal}
            setTreeView={setTreeViewSignal}
            {...(options.openMonitor === undefined ? {} : { onOpenMonitor: options.openMonitor })}
          />
        </Show>
      ),
    })

    function dispose() {
      disposed = true
      unsubscribe()
      unsubscribeInstructions()
      unregisterGroups()
      disposeSlot()
      disposePanel()
      disposeRoot()
    }

    return {
      activeTeam,
      refreshTeams,
      dispose,
    }
  })
}

export interface TeamMonitorTabProps {
  sessionID: string
  active: () => boolean
  close: () => void
  toggleFullscreen?: () => void
  focus?: () => void
  selected?: () => number
  onSelect?: (index: number) => void
  activeTeam?: () => ActiveTeamInfo | undefined
  context: Plugin.Context
  showInactive?: () => boolean
  setShowInactive?: (val: boolean | ((prev: boolean) => boolean)) => void
  treeView?: () => boolean
  setTreeView?: (val: boolean | ((prev: boolean) => boolean)) => void
  /** Opens the full Monitor page remembering how to return; defaults to a direct navigate. */
  onOpenMonitor?: (sessionID: string) => void
}

/**
 * Test observability for the run rows (not read in production): one entry per
 * row `<For>` mounts. Recording starts with resetRunMountLog().
 */
export const runMountLog: { enabled: boolean; ids: string[] } = { enabled: false, ids: [] }
export function resetRunMountLog(): void {
  runMountLog.enabled = true
  runMountLog.ids.length = 0
}
export function stopRunMountLog(): void {
  runMountLog.enabled = false
}

export function TeamMonitorTab(props: TeamMonitorTabProps) {
  onMount(() => props.focus?.())
  const plus = props.context.client.rpc(Definition)
  const [store, setStore] = createStore({ selected: 0, loaded: false, runs: [] as readonly TeamRunEntry[] })
  const renderer = useRenderer()
  let scroll: ScrollBoxRenderable | undefined
  let revealPending = true
  const selected = () => props.selected?.() ?? store.selected
  const select = (index: number) => {
    setStore("selected", index)
    props.onSelect?.(index)
    revealPending = true
  }
  const revealSelection = () => {
    if (!scroll || scroll.isDestroyed || scroll.viewport.height === 0) return
    const index = selected()
    if (index < scroll.scrollTop) scroll.scrollTo(index)
    if (index >= scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(index - scroll.viewport.height + 1)
  }
  const revealAfterLayout = () => {
    if (!revealPending || !scroll || scroll.viewport.height === 0) return
    revealPending = false
    revealSelection()
  }
  // Resizing can clamp scrollTop after onSizeChange. Follow once after layout,
  // rather than on every frame, so mouse scrolling remains independent.
  renderer.on("frame", revealAfterLayout)
  onCleanup(() => renderer.off("frame", revealAfterLayout))
  // Runs are keyed by id: a poll that returns the same runs updates them in
  // place instead of rebuilding every row component.
  const [internalShowInactive, setInternalShowInactive] = createSignal(false)
  const showInactive = () => (props.showInactive ? props.showInactive() : internalShowInactive())
  const setShowInactive = (val: boolean | ((prev: boolean) => boolean)) => {
    if (props.setShowInactive) props.setShowInactive(val)
    else setInternalShowInactive(val)
  }

  const [internalTreeView, setInternalTreeView] = createSignal(true)
  const treeView = () => (props.treeView ? props.treeView() : internalTreeView())
  const setTreeView = (val: boolean | ((prev: boolean) => boolean)) => {
    if (props.setTreeView) props.setTreeView(val)
    else setInternalTreeView(val)
  }

  let disposed = false

  function targetLocation() {
    const current = props.context.location
    if (current !== undefined) return { directory: current.directory, workspace: current.workspaceID }
    const fallback = props.context.data.location.default()
    if (fallback === undefined) return undefined
    return { directory: fallback.directory, workspace: fallback.workspaceID }
  }

  function refreshRuns() {
    if (disposed) return
    const location = targetLocation()
    void plus["team.runs.list"](
      { all: showInactive(), tree: treeView(), sessionID: props.sessionID },
      { location },
    ).then(
      (output) => {
        if (disposed) return
        setStore("runs", reconcile(output.runs, { key: "id" }))
        setStore("loaded", true)
      },
      () => {
        if (disposed) return
        setStore("runs", reconcile([], { key: "id" }))
      },
    )
  }

  // Only host session lifecycle events change a run's state (the same set the
  // team runtime consumes). Streaming *.delta events never do, and one turn
  // ending can arrive as several events: refresh once, at the end of a burst,
  // and never twice inside one 250 ms window.
  const RUN_REFRESH_MS = 250
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  function scheduleRefresh() {
    if (disposed || refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      refreshRuns()
    }, RUN_REFRESH_MS)
  }

  createEffect(() => {
    targetLocation()
    showInactive()
    treeView()
    props.sessionID
    refreshRuns()
  })

  const unsubscribeTeams = plus.events.on("teams.changed", () => {
    if (!disposed) refreshRuns()
  })

  const unsubscribeSession = props.context.data.listen((event) => {
    if (!disposed && SessionRunEvents.has(event.details.type)) scheduleRefresh()
  })

  createEffect(() => {
    if (!props.active()) return
    const interval = setInterval(() => {
      refreshRuns()
    }, 2000)
    onCleanup(() => clearInterval(interval))
  })

  onCleanup(() => {
    disposed = true
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    unsubscribeTeams()
    unsubscribeSession()
  })

  const ACTIVE_STATES = new Set(["working", "idle", "starting", "blocked_input", "stopping"])
  const INACTIVE_STATES = new Set(["stopped", "dead", "superseded", "reaped"])

  const visibleRuns = createMemo(() => {
    const list = store.runs
    const allowed = showInactive() ? INACTIVE_STATES : ACTIVE_STATES
    return list.filter((r) => allowed.has(r.state))
  })

  createEffect(() => {
    if (!props.active() || !store.loaded) return
    const list = visibleRuns()
    if (list.length === 0) {
      if (selected() !== 0) select(0)
      return
    }
    if (selected() >= list.length) {
      select(Math.max(0, list.length - 1))
    }
  })

  createEffect(() => {
    selected()
    revealPending = true
    revealSelection()
  })

  function attachRun(run: TeamRunEntry) {
    if (run.sessionID) {
      props.context.ui.router.navigate({ type: "session", sessionID: run.sessionID })
      props.close()
    }
  }

  async function handleAction(run: TeamRunEntry) {
    if (run.state === "idle") {
      const location = targetLocation()
      try {
        await plus["team.runs.stop"]({ run: run.id }, { location })
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : "Failed to stop run"
        props.context.ui.toast.show({
          variant: "warning",
          message,
        })
      }
      refreshRuns()
      return
    }
    if (run.state === "stopped" || run.state === "dead") {
      attachRun(run)
      return
    }
    if (run.state === "working") {
      props.context.ui.toast.show({
        variant: "warning",
        message: "Run must be interrupted first",
      })
      return
    }
  }

  props.context.keymap.layer(() => ({
    enabled: () => props.active(),
    priority: 1,
    commands: [
      {
        id: "composer.team.up",
        bind: "up",
        title: "Previous run",
        group: "Team",
        run() {
          if (selected() === 0) {
            props.close()
            return
          }
          select(selected() - 1)
        },
      },
      {
        id: "composer.team.down",
        bind: "down",
        title: "Next run",
        group: "Team",
        run() {
          const list = visibleRuns()
          if (list.length === 0) return
          select((selected() + 1) % list.length)
        },
      },
      {
        id: "composer.team.select",
        bind: "return",
        title: "Attach run",
        group: "Team",
        run() {
          const list = visibleRuns()
          const run = list[selected()]
          if (run) attachRun(run)
        },
      },
      {
        id: "composer.team.toggle_activity",
        title: "Toggle inactive runs",
        group: "Team",
        bind: "ctrl+a",
        run() {
          select(0)
          setShowInactive((prev) => !prev)
          refreshRuns()
        },
      },
      {
        id: "composer.team.toggle_tree",
        title: "Toggle tree view",
        group: "Team",
        bind: "ctrl+t",
        run() {
          select(0)
          setTreeView((prev) => !prev)
          refreshRuns()
        },
      },
      {
        id: "composer.team.action",
        title: "Stop or resume run",
        group: "Team",
        bind: "ctrl+d",
        run() {
          const list = visibleRuns()
          const run = list[selected()]
          if (run) void handleAction(run)
        },
      },
      {
        bind: "escape",
        title: "Close Team",
        group: "Team",
        run: props.close,
      },
      {
        bind: "f",
        title: "Toggle Team fullscreen",
        group: "Team",
        run: () => props.toggleFullscreen?.(),
      },
      {
        id: "composer.team.monitor",
        title: "Open Monitor",
        group: "Team",
        bind: "shift+m,M",
        run() {
          props.close()
          if (props.onOpenMonitor) {
            props.onOpenMonitor(props.sessionID)
            return
          }
          props.context.ui.dialog.clear()
          props.context.ui.router.navigate({
            type: "plugin",
            name: "monitor",
            data: { sessionID: props.sessionID },
          })
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} paddingLeft={1} paddingRight={1}>
      <text fg={props.context.theme.text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
        Team
      </text>
      <Show
        when={visibleRuns().length > 0}
        fallback={
          <box paddingLeft={1}>
            <text fg={props.context.theme.text.muted}>
              {treeView() && store.runs.length === 0
                ? "No team runs from this chat · ctrl+t shows all"
                : showInactive()
                  ? "No inactive runs"
                  : "No active runs"}
            </text>
          </box>
        }
      >
        <scrollbox
          ref={(value: ScrollBoxRenderable) => { scroll = value }}
          onSizeChange={() => { revealPending = true }}
          scrollbarOptions={{ visible: false }}
          flexGrow={1}
          minHeight={0}
        >
          <For each={visibleRuns()}>
            {(run, index) => {
              if (runMountLog.enabled) runMountLog.ids.push(run.id)
              const isSelected = createMemo(() => index() === selected())
              const isCurrent = createMemo(() => run.sessionID === props.sessionID)
              return (
                <box
                  height={1}
                  flexShrink={0}
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    isSelected()
                      ? props.context.theme.background.action.primary.focused
                      : isCurrent()
                        ? props.context.theme.background.action.primary.selected
                        : props.context.theme.background.action.primary.base
                  }
                  onMouseMove={() => select(index())}
                  onMouseUp={() => {
                    select(index())
                    attachRun(run)
                  }}
                >
                  <box flexGrow={1} minWidth={0} flexDirection="row">
                    <text
                      fg={
                        isSelected()
                          ? props.context.theme.text.action.primary.focused
                          : isCurrent()
                            ? props.context.theme.text.action.primary.selected
                            : props.context.theme.text.action.primary.base
                      }
                      attributes={isSelected() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {"  ".repeat(treeView() ? (run.depth ?? 0) : 0)}{run.id} — {run.role} — {run.state}{run.task ? ` — ${run.task}` : ""}
                    </text>
                  </box>
                  <text
                    fg={
                      isSelected()
                        ? props.context.theme.text.action.primary.focused
                        : props.context.theme.text.muted
                    }
                    wrapMode="none"
                  >
                    {run.state}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>
      <text fg={props.context.theme.text.muted} flexShrink={0}>
        {`↑↓ move · ⏎ attach · ctrl+a ${showInactive() ? "inactive" : "active"} · ctrl+t ${treeView() ? "tree" : "all"} · ctrl+d stop/resume · M monitor · f fullscreen · esc close`}
      </text>
    </box>
  )
}
