import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createRoot, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import { Definition, type TeamLevel, type TeamListEntry } from "../rpc.js"

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

    const disposeComposerTab = context.ui.composer?.tab({
      id: "team",
      label: "Team",
      hints: () => {
        const shortcut = context.keymap.shortcuts("composer.team.select")?.[0] ?? "return"
        return [{ label: "select", shortcut }]
      },
      render: (input) => (
        <TeamMonitorTab
          sessionID={input.sessionID}
          active={input.active}
          close={input.close}
          activeTeam={activeTeam}
          context={context}
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

function sessionAgent(s: SessionItem): string | undefined {
  if (s.agent) return s.agent
  const title = (s as any).title as string | undefined
  const match = title?.match(/@(\w+) subagent/)
  return match ? match[1] : undefined
}

export interface TeamMonitorTabProps {
  sessionID: string
  active: () => boolean
  close: () => void
  activeTeam: () => ActiveTeamInfo | undefined
  context: Plugin.Context
}

export interface TeamMemberRow {
  id: string
  mode: string
  model: string
  status: "running" | "idle" | "none"
  sessionID?: string
  current: boolean
}

export function TeamMonitorTab(props: TeamMonitorTabProps) {
  const [store, setStore] = createStore({ selected: 0 })

  const hostAgents = createMemo(() => {
    return props.context.data.location.agent.list(props.context.location) ??
      props.context.data.location.agent.list() ??
      []
  })

  const currentSession = createMemo(() => props.context.data.session.get(props.sessionID))

  const rootSessionID = createMemo(() => {
    const current = currentSession()
    return current ? props.context.data.session.root(current.id) : props.sessionID
  })

  const familySessions = createMemo(() => {
    const root = rootSessionID()
    const all = props.context.data.session.list()
    const byID = new Map(all.map((s) => [s.id, s]))
    function findRoot(s: SessionItem): string {
      if (!s.parentID) return s.id
      const parent = byID.get(s.parentID)
      return parent ? findRoot(parent) : s.id
    }
    return all.filter((s) => findRoot(s) === root || s.id === root)
  })

  const currentAgentID = createMemo(() => {
    const fromAgents = props.context.ui.agents.current?.()
    if (fromAgents) return fromAgents
    return currentSession()?.agent
  })

  const members = createMemo<TeamMemberRow[]>(() => {
    const team = props.activeTeam()
    if (!team) return []

    const agents = hostAgents()
    const sessions = familySessions()
    const currentId = currentAgentID()

    return team.members.map((memberId) => {
      const agent = agents.find((a) => a.id === memberId)
      const mode = agent?.mode ?? "primary"
      const model = agent?.model?.id ?? "default"

      const matchingSessions = sessions.filter((s) => sessionAgent(s) === memberId)
      let status: "running" | "idle" | "none" = "none"
      let sessionID: string | undefined = undefined

      if (matchingSessions.length > 0) {
        const running = matchingSessions.find((s) => props.context.data.session.status(s.id) === "running")
        if (running) {
          status = "running"
          sessionID = running.id
        } else {
          status = "idle"
          sessionID = matchingSessions[matchingSessions.length - 1].id
        }
      }

      return {
        id: memberId,
        mode,
        model,
        status,
        sessionID,
        current: memberId === currentId,
      }
    })
  })

  createEffect(() => {
    if (!props.active()) return
    const list = members()
    if (list.length === 0) return
    if (store.selected >= list.length) {
      setStore("selected", Math.max(0, list.length - 1))
    }
  })

  function selectMember(member: TeamMemberRow) {
    if (member.sessionID) {
      props.context.ui.router.navigate({ type: "session", sessionID: member.sessionID })
      props.close()
    } else {
      props.context.ui.agents.set?.(member.id)
      props.close()
    }
  }

  props.context.keymap.layer(() => ({
    mode: "composer",
    enabled: () => props.active(),
    priority: 1,
    commands: [
      {
        id: "composer.team.up",
        title: "Previous team member",
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
        title: "Next team member",
        group: "Composer",
        run() {
          const list = members()
          if (list.length === 0) return
          setStore("selected", (prev) => (prev + 1) % list.length)
        },
      },
      {
        id: "composer.team.select",
        title: "Select team member",
        group: "Composer",
        run() {
          const list = members()
          const member = list[store.selected]
          if (member) selectMember(member)
        },
      },
    ],
  }))

  return (
    <Show
      when={props.activeTeam()}
      fallback={
        <box paddingLeft={1}>
          <text fg={props.context.theme.text.subdued}>No active team — select one with ctrl+x a</text>
        </box>
      }
    >
      <Show
        when={members().length > 0}
        fallback={
          <box paddingLeft={1}>
            <text fg={props.context.theme.text.subdued}>No team members</text>
          </box>
        }
      >
        <scrollbox scrollbarOptions={{ visible: false }} maxHeight={5}>
          <For each={members()}>
            {(member, index) => {
              const isSelected = createMemo(() => index() === store.selected)
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    isSelected()
                      ? props.context.theme.background.action.primary.focused
                      : member.current
                        ? props.context.theme.background.action.primary.selected
                        : props.context.theme.background.action.primary.default
                  }
                  onMouseMove={() => setStore("selected", index())}
                  onMouseUp={() => {
                    setStore("selected", index())
                    selectMember(member)
                  }}
                >
                  <box flexGrow={1} minWidth={0} flexDirection="row">
                    <text
                      fg={
                        isSelected()
                          ? props.context.theme.text.action.primary.focused
                          : member.current
                            ? props.context.theme.text.action.primary.selected
                            : props.context.theme.text.action.primary.default
                      }
                      attributes={isSelected() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {member.id} — {member.mode} — {member.model}
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
                    {member.status}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>
    </Show>
  )
}
