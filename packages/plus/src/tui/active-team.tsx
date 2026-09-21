import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createRoot, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import { Definition, type TeamLevel, type TeamListEntry, type TeamRunEntry } from "../rpc.js"

type SessionItem = ReturnType<Plugin.Context["data"]["session"]["list"]>[number]

export interface ActiveTeamInfo {
  readonly team: string
  readonly name: string
  readonly level: TeamLevel
  readonly members: readonly string[]
}

export function createActiveTeam(context: Plugin.Context) {
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
      if (first !== undefined) context.ui.agents.set?.(first)
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
            {(team) => <text fg={context.theme.text.subdued}>{` · team ${team().name}`}</text>}
          </Show>
        )
      },
    })

    const [showInactiveSignal, setShowInactiveSignal] = createSignal(false)

    const disposeComposerTab = context.ui.composer?.tab({
      id: "team",
      label: "Team",
      hints: () => [
        { label: "move", shortcut: "↑↓" },
        { label: "attach", shortcut: "⏎" },
        { label: showInactiveSignal() ? "inactive" : "active", shortcut: "ctrl+a" },
        { label: "stop|resume", shortcut: "ctrl+d" },
      ],
      render: (input) => (
        <TeamMonitorTab
          sessionID={input.sessionID}
          active={input.active}
          close={input.close}
          activeTeam={activeTeam}
          context={context}
          showInactive={showInactiveSignal}
          setShowInactive={setShowInactiveSignal}
        />
      ),
    }) ?? (() => {})

    function dispose() {
      disposed = true
      unsubscribe()
      unregisterGroups()
      disposeSlot()
      disposeComposerTab()
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
  activeTeam?: () => ActiveTeamInfo | undefined
  context: Plugin.Context
  showInactive?: () => boolean
  setShowInactive?: (val: boolean | ((prev: boolean) => boolean)) => void
}

export function TeamMonitorTab(props: TeamMonitorTabProps) {
  const plus = props.context.client.rpc(Definition)
  const [store, setStore] = createStore({ selected: 0 })
  const [internalShowInactive, setInternalShowInactive] = createSignal(false)
  const showInactive = () => (props.showInactive ? props.showInactive() : internalShowInactive())
  const setShowInactive = (val: boolean | ((prev: boolean) => boolean)) => {
    if (props.setShowInactive) props.setShowInactive(val)
    else setInternalShowInactive(val)
  }

  const [runs, setRuns] = createSignal<readonly TeamRunEntry[]>([])
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
    void plus["team.runs.list"]({ all: showInactive() }, { location }).then(
      (output) => {
        if (disposed) return
        setRuns(output.runs)
      },
      () => {
        if (disposed) return
        setRuns([])
      },
    )
  }

  createEffect(() => {
    targetLocation()
    showInactive()
    refreshRuns()
  })

  const unsubscribeTeams = plus.events.on("teams.changed", () => {
    if (!disposed) refreshRuns()
  })

  const unsubscribeSession = props.context.data.listen((event) => {
    if (!disposed && event.details.type.startsWith("session.")) {
      refreshRuns()
    }
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
    unsubscribeTeams()
    unsubscribeSession()
  })

  const ACTIVE_STATES = new Set(["working", "idle", "starting", "blocked_input", "stopping"])
  const INACTIVE_STATES = new Set(["stopped", "dead", "superseded", "reaped"])

  const visibleRuns = createMemo(() => {
    const list = runs()
    const allowed = showInactive() ? INACTIVE_STATES : ACTIVE_STATES
    return list.filter((r) => allowed.has(r.state))
  })

  createEffect(() => {
    if (!props.active()) return
    const list = visibleRuns()
    if (list.length === 0) {
      if (store.selected !== 0) setStore("selected", 0)
      return
    }
    if (store.selected >= list.length) {
      setStore("selected", Math.max(0, list.length - 1))
    }
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
    mode: "composer",
    enabled: () => props.active(),
    priority: 1,
    commands: [
      {
        id: "composer.team.up",
        title: "Previous run",
        group: "Composer",
        run() {
          if (store.selected === 0) {
            props.close()
            return
          }
          setStore("selected", (prev) => prev - 1)
        },
      },
      {
        id: "composer.team.down",
        title: "Next run",
        group: "Composer",
        run() {
          const list = visibleRuns()
          if (list.length === 0) return
          setStore("selected", (prev) => (prev + 1) % list.length)
        },
      },
      {
        id: "composer.team.select",
        title: "Attach run",
        group: "Composer",
        run() {
          const list = visibleRuns()
          const run = list[store.selected]
          if (run) attachRun(run)
        },
      },
      {
        id: "composer.team.toggle_activity",
        title: "Toggle inactive runs",
        group: "Composer",
        bind: "ctrl+a",
        run() {
          setStore("selected", 0)
          setShowInactive((prev) => !prev)
          refreshRuns()
        },
      },
      {
        id: "composer.team.action",
        title: "Stop or resume run",
        group: "Composer",
        bind: "ctrl+d",
        run() {
          const list = visibleRuns()
          const run = list[store.selected]
          if (run) void handleAction(run)
        },
      },
    ],
  }))

  return (
    <Show
      when={visibleRuns().length > 0}
      fallback={
        <box paddingLeft={1}>
          <text fg={props.context.theme.text.subdued}>
            {showInactive() ? "No inactive runs" : "No active runs"}
          </text>
        </box>
      }
    >
      <scrollbox scrollbarOptions={{ visible: false }} maxHeight={5}>
        <For each={visibleRuns()}>
          {(run, index) => {
            const isSelected = createMemo(() => index() === store.selected)
            const isCurrent = createMemo(() => run.sessionID === props.sessionID)
            return (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  isSelected()
                    ? props.context.theme.background.action.primary.focused
                    : isCurrent()
                      ? props.context.theme.background.action.primary.selected
                      : props.context.theme.background.action.primary.default
                }
                onMouseMove={() => setStore("selected", index())}
                onMouseUp={() => {
                  setStore("selected", index())
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
                          : props.context.theme.text.action.primary.default
                    }
                    attributes={isSelected() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {run.id} — {run.role} — {run.state}{run.task ? ` — ${run.task}` : ""}
                  </text>
                </box>
                <text
                  fg={
                    isSelected()
                      ? props.context.theme.text.action.primary.focused
                      : props.context.theme.text.subdued
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
  )
}
