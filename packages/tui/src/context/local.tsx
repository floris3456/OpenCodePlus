import { createStore } from "solid-js/store"
import { dedupeWith } from "effect/Array"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { AgentInfo, LocationRef } from "@opencode/client"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import {
  createModelPreferenceRepository,
  cycleModelVariant,
  favoriteModels,
  modelPreferenceKey,
  normalizeModelVariant,
  recentModels,
  type ModelPreference,
  type ModelPreferenceModel,
} from "../model-preference"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { useData } from "./data"
import { usePermission } from "./permission"
import { useLocation } from "./location"
import { parse } from "../util/model"

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const data = useData()
    const toast = useToast()
    const theme = useTheme()
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const permission = usePermission()
    const location = useLocation()

    const models = () => data.location.model.list(location.ref)
    const providers = () => data.location.provider.list(location.ref)

    function isModelValid(model: ModelPreferenceModel) {
      return !!models()?.some((item) => item.providerID === model.providerID && item.id === model.modelID)
    }

    function getFirstValidModel(...modelFns: (() => (ModelPreferenceModel & { variant?: string }) | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (model && isModelValid(model)) return model
      }
    }

    function createAgent() {
      const availableAgents = createMemo(() =>
        (data.location.agent.list(location.ref) ?? []).filter((agent) => agent.mode !== "subagent" && !agent.hidden),
      )
      const visibleAgents = createMemo(() =>
        (data.location.agent.list(location.ref) ?? []).filter((agent) => !agent.hidden),
      )
      type AgentGroup = { readonly id: string; readonly label: string; readonly agents: readonly string[] }
      type AgentGroupsProvider = () => readonly AgentGroup[] | undefined

      const [providers, setProviders] = createSignal<AgentGroupsProvider[]>([])
      const [activeGroupId, setActiveGroupId] = createSignal<string | undefined>(undefined)

      const registeredGroups = createMemo(() => {
        const result: AgentGroup[] = []
        for (const provider of providers()) {
          const groups = provider()
          if (groups) {
            result.push(...groups)
          }
        }
        return result
      })

      const agents = createMemo(() => {
        const all = availableAgents()
        const currentGroup = activeGroupId()
        if (currentGroup !== undefined) {
          const group = registeredGroups().find((g) => g.id === currentGroup)
          if (group) {
            const byId = new Map(all.map((a) => [a.id, a]))
            return group.agents.map((id) => byId.get(id)).filter((a): a is AgentInfo => a !== undefined)
          }
        }
        const groupedIds = new Set(registeredGroups().flatMap((g) => g.agents))
        return all.filter((a) => !groupedIds.has(a.id))
      })

      function groups(): readonly AgentGroup[]
      function groups(provider: AgentGroupsProvider): () => void
      function groups(provider?: AgentGroupsProvider): readonly AgentGroup[] | (() => void) {
        if (provider === undefined) return registeredGroups()
        setProviders((prev) => [...prev, provider])
        return () => setProviders((prev) => prev.filter((p) => p !== provider))
      }

      const activeGroup = {
        current() {
          return activeGroupId()
        },
        set(id: string | undefined) {
          setActiveGroupId(id)
        },
      }

      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
        draftBySession: {} as Record<string, { agent?: string } | undefined>,
      })
      onCleanup(event.on("session.deleted", (evt) => setAgentStore("draftBySession", evt.data.sessionID, undefined)))
      onCleanup(
        event.on("session.agent.selected", (evt) => {
          // Keep an entry after acknowledgment: CLI defaults must not override a user's later choice.
          if (agentStore.draftBySession[evt.data.sessionID]?.agent === evt.data.agent)
            setAgentStore("draftBySession", evt.data.sessionID, { agent: undefined })
        }),
      )
      const colors = createMemo(() => {
        const step = 200
        return dedupeWith(
          theme.categorical.map((scale) => scale[step]),
          (first, second) => first.equals(second),
        )
      })
      return {
        list() {
          return agents()
        },
        all() {
          return availableAgents()
        },
        groups,
        activeGroup,
        current() {
          const draft = route.data.type === "session" ? agentStore.draftBySession[route.data.sessionID] : undefined
          const selected =
            route.data.type === "session"
              ? (draft?.agent ??
                (draft ? undefined : args.agent) ??
                data.session.get(route.data.sessionID)?.agent ??
                agentStore.current)
              : agentStore.current
          return (
            agents().find((agent) => agent.id === selected) ??
            availableAgents().find((agent) => agent.id === selected) ??
            agents().at(0)
          )
        },
        set(id: string) {
          const all = availableAgents()
          const exists = all.some((agent) => agent.id === id)
          if (!exists)
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${id}`,
              duration: 3000,
            })
          batch(() => {
            const allGroups = registeredGroups()
            const matchingGroups = allGroups.filter((g) => g.agents.includes(id))
            if (matchingGroups.length > 0) {
              const current = activeGroupId()
              if (!current || !matchingGroups.some((g) => g.id === current)) {
                setActiveGroupId(matchingGroups[0].id)
              }
            } else {
              setActiveGroupId(undefined)
            }

            const changed = this.current()?.id !== id
            if (changed) model.remember()
            setAgentStore("current", id)
            if (route.data.type === "session") setAgentStore("draftBySession", route.data.sessionID, { agent: id })
            // Retain both selections while agent and model commits arrive separately.
            const selected = changed && route.data.type === "session" ? model.current() : undefined
            if (selected) model.set(selected)
          })
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((agent) => agent.id === current.id) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            this.set(value.id)
          })
        },
        color(id: string) {
          const index = visibleAgents().findIndex((agent) => agent.id === id)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) return RGBA.fromHex(agent.color)
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      type ModelSelection = ModelPreferenceModel & { variant?: string }
      // One call per completed user pick (/models, the variant dialog, or the
      // cycle-variant keybind). Programmatic changes through set/variant.set do
      // not notify; only the UI emit sites do.
      type ModelPick = { agent: string; providerID: string; modelID: string; variant?: string; location: LocationRef | undefined }
      const pickListeners = new Set<(pick: ModelPick) => void>()
      const [preferences, setPreferences] = createStore<ModelPreference & { ready: boolean }>({
        ready: false,
        recent: [],
        favorite: [],
        variant: {},
      })
      const [selectionState, setSelectionState] = createStore<{
        newSessionModelByLocationAgent: Record<string, ModelSelection | undefined>
        selectionBySessionAgent: Record<string, Record<string, ModelSelection | undefined> | undefined>
      }>({
        newSessionModelByLocationAgent: {},
        selectionBySessionAgent: {},
      })

      const repository = createModelPreferenceRepository(path.join(paths.state, "model.json"))
      const pendingSelectionCommits = new Map<string, { agentID: string; selection: string }>()
      const selectionKey = (value: ModelSelection) =>
        `${modelPreferenceKey(value)}:${normalizeModelVariant(value.variant) ?? "default"}`

      function applyPreferences(value: ModelPreference) {
        batch(() => {
          setPreferences("recent", value.recent)
          setPreferences("favorite", value.favorite)
          setPreferences("variant", value.variant)
          setPreferences("ready", true)
        })
      }

      onCleanup(repository.subscribe(applyPreferences))

      const configuredModel = createMemo(() => {
        const entry = data.location.config
          .list(location.ref)
          ?.findLast((entry) => entry.type === "document" && entry.info.model !== undefined)
        const configured = entry?.type === "document" ? entry.info.model : undefined
        if (!configured) return
        return typeof configured === "string"
          ? { ...parse(configured), variant: undefined }
          : { providerID: configured.providerID, modelID: configured.model, variant: configured.variant }
      })

      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parse(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        const configured = configuredModel()
        if (configured && isModelValid(configured)) return configured

        for (const item of preferences.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const model = models()?.[0]
        if (!model) return undefined
        return {
          providerID: model.providerID,
          modelID: model.id,
        }
      })

      const newSessionModel = createMemo(() => {
        const a = agent.current()
        return getFirstValidModel(
          () => a && selectionState.newSessionModelByLocationAgent[locationAgentKey(a.id)],
          () => a?.model && { providerID: a.model.providerID, modelID: a.model.id },
          fallbackModel,
        )
      })

      const currentSelection = createMemo<ModelSelection | undefined>(() => {
        if (route.data.type === "session") return sessionSelection(route.data.sessionID)
        const model = newSessionModel()
        if (!model) return
        return preferredSelection(model)
      })

      const currentModel = createMemo(() => {
        const selection = currentSelection()
        if (!selection) return
        return { providerID: selection.providerID, modelID: selection.modelID }
      })

      function locationAgentKey(agentID: string) {
        const ref = location.ref ?? data.location.default()
        return `${JSON.stringify([ref.directory, ref.workspaceID])}:${agentID}`
      }

      function preferredSelection(model: ModelSelection): ModelSelection {
        const configured = agent.current()?.model
        const fallback = configuredModel()
        // A variant picked for this agent here wins. Otherwise the agent's own model brings its
        // variant: the server starts the chat on it (Plus applies the agent's active model to every
        // new chat), so taking the last variant used for that model anywhere would start the first
        // step on one effort and switch to the other while it runs.
        const variant = normalizeModelVariant(
          model.variant ??
            (configured?.providerID === model.providerID && configured.id === model.modelID
              ? (configured.variant ?? "default")
              : undefined) ??
            preferences.variant[modelPreferenceKey(model)] ??
            (fallback?.providerID === model.providerID && fallback.modelID === model.modelID
              ? fallback.variant
              : undefined),
        )
        const info = models()?.find((item) => item.providerID === model.providerID && item.id === model.modelID)
        return { ...model, variant: info?.variants.some((item) => item.id === variant) ? variant : undefined }
      }

      function durableSelection(sessionID: string): ModelSelection | undefined {
        const model = data.session.get(sessionID)?.model
        if (!model) return
        return {
          providerID: model.providerID,
          modelID: model.id,
          variant: normalizeModelVariant(model.variant),
        }
      }

      function historySelection(sessionID: string, agentID: string): ModelSelection | undefined {
        // The chat's own model memory per agent: its last assistant message
        // by that agent (B15). Used when the chat switches to another agent.
        const message = data.session.message
          .list(sessionID)
          .findLast((item) => item.type === "assistant" && item.agent === agentID)
        if (message?.type !== "assistant") return
        return {
          providerID: message.model.providerID,
          modelID: message.model.id,
          variant: normalizeModelVariant(message.model.variant),
        }
      }

      function sessionSelection(sessionID: string) {
        const current = agent.current()
        if (!current) return
        const session = data.session.get(sessionID)
        const selected =
          selectionState.selectionBySessionAgent[sessionID]?.[current.id] ??
          (!session?.agent || session.agent === current.id ? durableSelection(sessionID) : undefined) ??
          historySelection(sessionID, current.id)
        if (selected) {
          const info = models()?.find((item) => item.providerID === selected.providerID && item.id === selected.modelID)
          return {
            ...selected,
            variant:
              !info || info.variants.some((variant) => variant.id === selected.variant) ? selected.variant : undefined,
          }
        }
        const model = newSessionModel()
        return model && preferredSelection(model)
      }

      function setSessionSelection(sessionID: string, agentID: string, selection: ModelSelection | undefined) {
        setSelectionState("selectionBySessionAgent", sessionID, {
          ...selectionState.selectionBySessionAgent[sessionID],
          [agentID]: selection,
        })
      }

      function setSessionDraft(sessionID: string, selection: ModelSelection) {
        const current = agent.current()
        if (!current) return
        const durable = durableSelection(sessionID)
        const session = data.session.get(sessionID)
        setSessionSelection(
          sessionID,
          current.id,
          (!session?.agent || session.agent === current.id) &&
            durable &&
            selectionKey(durable) === selectionKey(selection)
            ? undefined
            : selection,
        )
      }

      function agentModelKey(model: { providerID: string; id: string; variant?: string } | undefined) {
        if (!model) return ""
        return `${model.providerID}/${model.id}${model.variant === undefined ? "" : `:${model.variant}`}`
      }

      // Existing chats keep their model when an agent's configured model
      // changes elsewhere (a pick, Ctrl+T, an Instructions activation,
      // another project); only the new-chat default for this location
      // follows the agent's model. `agent.updated` carries no payload, so
      // compare the re-listed agent's model keyed by location and agent.
      // Seeing an agent for the first time in a location is not a change.
      const configuredAgentModels = new Map<string, string>()
      createEffect(() => {
        const listed = data.location.agent.list(location.ref) ?? []
        const changed: string[] = []
        for (const item of listed) {
          const seen = locationAgentKey(item.id)
          const key = agentModelKey(item.model)
          if (configuredAgentModels.has(seen) && configuredAgentModels.get(seen) !== key) changed.push(item.id)
          configuredAgentModels.set(seen, key)
        }
        if (changed.length === 0) return
        batch(() => {
          for (const agentID of changed) {
            setSelectionState("newSessionModelByLocationAgent", locationAgentKey(agentID), undefined)
          }
        })
      })

      function selectModel(model: ModelPreferenceModel) {
        if (route.data.type === "session") {
          const sessionID = route.data.sessionID
          const current = sessionSelection(sessionID)
          setSessionDraft(
            sessionID,
            current?.providerID === model.providerID && current.modelID === model.modelID
              ? current
              : preferredSelection(model),
          )
          return true
        }
        const current = agent.current()
        if (!current) return false
        // The store merges objects: name the variant so a variant picked for the previous model goes.
        setSelectionState("newSessionModelByLocationAgent", locationAgentKey(current.id), {
          providerID: model.providerID,
          modelID: model.modelID,
          variant: undefined,
        })
        return true
      }

      function reconcileSessionSelection(sessionID: string) {
        const expected = pendingSelectionCommits.get(sessionID)
        const durable = durableSelection(sessionID)
        if (!expected || !durable || data.session.get(sessionID)?.agent !== expected.agentID) return
        if (selectionKey(durable) !== expected.selection) return
        pendingSelectionCommits.delete(sessionID)
        // Inactive agents keep their remembered choices after another agent commits.
        if (
          route.data.type !== "session" ||
          route.data.sessionID !== sessionID ||
          agent.current()?.id !== expected.agentID
        )
          return
        const draft = selectionState.selectionBySessionAgent[sessionID]?.[expected.agentID]
        if (draft && selectionKey(draft) === expected.selection)
          setSessionSelection(sessionID, expected.agentID, undefined)
      }

      onCleanup(event.on("session.model.selected", (evt) => reconcileSessionSelection(evt.data.sessionID)))
      onCleanup(event.on("session.agent.selected", (evt) => reconcileSessionSelection(evt.data.sessionID)))

      onCleanup(
        event.on("session.deleted", (evt) => {
          pendingSelectionCommits.delete(evt.data.sessionID)
          setSelectionState("selectionBySessionAgent", evt.data.sessionID, undefined)
        }),
      )

      return {
        current: currentModel,
        selection: currentSelection,
        onPick(listener: (pick: ModelPick) => void) {
          pickListeners.add(listener)
          return () => pickListeners.delete(listener)
        },
        // Notify every onPick listener of one completed user pick. The UI emit
        // sites call this after the selection has been applied; it reads the
        // resulting selection so the payload always matches what the prompt
        // ends up with. No-op when nothing is selected.
        pick() {
          const selection = currentSelection()
          if (!selection) return
          const current = agent.current()
          if (!current) return
          const pick: ModelPick = {
            agent: current.id,
            providerID: selection.providerID,
            modelID: selection.modelID,
            ...(selection.variant === undefined ? {} : { variant: selection.variant }),
            location: location.ref,
          }
          for (const listener of pickListeners) listener(pick)
        },
        remember() {
          const current = agent.current()
          const selection = currentSelection()
          if (route.data.type !== "session" || !current || !selection) return
          setSessionSelection(route.data.sessionID, current.id, { ...selection })
        },
        available(model = currentModel()) {
          return model ? isModelValid(model) : false
        },
        trackSessionCommit(
          sessionID: string,
          value: {
            providerID: string
            id: string
            variant?: string
          },
          agentID: string,
        ) {
          const committed = {
            agentID,
            selection: selectionKey({ providerID: value.providerID, modelID: value.id, variant: value.variant }),
          }
          pendingSelectionCommits.set(sessionID, committed)
          // An unchanged model emits no event; the agent may be the only durable change.
          reconcileSessionSelection(sessionID)
          return () => {
            if (pendingSelectionCommits.get(sessionID) === committed) pendingSelectionCommits.delete(sessionID)
          }
        },
        get ready() {
          return preferences.ready
        },
        get catalogReady() {
          return models() !== undefined
        },
        recent() {
          return preferences.recent
        },
        favorite() {
          return preferences.favorite
        },
        parsed: createMemo(() => {
          const value = currentSelection()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = providers()?.find((item) => item.id === value.providerID)
          const info = models()?.find((item) => item.providerID === value.providerID && item.id === value.modelID)
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? `${value.modelID} (unavailable)`,
            reasoning: (info?.variants?.length ?? 0) !== 0,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentSelection()
          if (!current) return
          const recent = preferences.recent.filter(isModelValid)
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          let next = index === -1 ? (direction === 1 ? 0 : recent.length - 1) : index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          selectModel({ ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = preferences.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentSelection()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          if (!selectModel({ ...next })) return
          setPreferences("recent", recentModels(next, preferences.recent))
          void repository.addRecent(next).catch(() => undefined)
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) return
            if (!selectModel(model)) return
            if (options?.recent) {
              setPreferences("recent", recentModels(model, preferences.recent))
              void repository.addRecent(model).catch(() => undefined)
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) return
            const exists = preferences.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            setPreferences("favorite", favoriteModels(model, preferences.favorite, !exists))
            void repository.setFavorite(model, !exists).catch(() => undefined)
          })
        },
        variant: {
          selected() {
            return currentSelection()?.variant
          },
          current() {
            return this.selected()
          },
          list() {
            const m = currentSelection()
            if (!m) return []
            const info = models()?.find((item) => item.providerID === m.providerID && item.id === m.modelID)
            return info?.variants?.map((variant) => variant.id) ?? []
          },
          set(value: string | undefined) {
            const m = currentSelection()
            if (!m) return
            const current = agent.current()
            if (route.data.type === "session") {
              setSessionDraft(route.data.sessionID, { ...m, variant: normalizeModelVariant(value) })
            } else if (current) {
              setSelectionState("newSessionModelByLocationAgent", locationAgentKey(current.id), {
                providerID: m.providerID,
                modelID: m.modelID,
                variant: value ?? "default",
              })
            }
            setPreferences("variant", modelPreferenceKey(m), value ?? "default")
            void repository.saveVariant(m, value).catch(() => undefined)
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            this.set(cycleModelVariant(this.current(), variants))
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const slots = createMemo(() => {
        const existing = new Set(
          data.session
            .list()
            .filter((x) => x.parentID === undefined)
            .map((x) => x.id),
        )
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.data.sessionID)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    const result = {
      model,
      agent,
      session,
      permission,
    }
    return result
  },
})
