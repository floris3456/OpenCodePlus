import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createRoot, createSignal, Show } from "solid-js"
import { Definition, type TeamLevel, type TeamListEntry } from "../rpc.js"

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
      refreshTeams()
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

    function dispose() {
      disposed = true
      unsubscribe()
      unregisterGroups()
      disposeSlot()
      disposeRoot()
    }

    return {
      activeTeam,
      refreshTeams,
      dispose,
    }
  })
}
