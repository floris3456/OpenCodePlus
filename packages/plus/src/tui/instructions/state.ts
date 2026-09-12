import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import type { Customization, Item } from "../../instructions/model.js"
import { tree, type TreeNode } from "../../instructions/tree.js"
import { Definition, type Snapshot, type SnapshotCustomization } from "../../rpc.js"

export interface ModelSnapshot {
  revision: number
  items: Item[]
  customizations: Customization[]
}

export function modelSnapshotOf(rpc: Snapshot): ModelSnapshot {
  return {
    revision: rpc.revision,
    items: rpc.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      owner: item.owner,
      title: item.title,
      text: item.text,
      agents: [...item.agents],
      fingerprint: item.fingerprint,
      available: item.available,
    })),
    customizations: rpc.customizations.map((record) => ({
      item: record.item,
      agent: record.agent,
      text: record.text,
      state: record.state,
      basedOn: record.basedOn,
      reviewed: record.reviewed,
      updated: record.updated,
    })),
  }
}

export function createInstructionsState(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>(undefined)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined)
  const [status, setStatus] = createSignal<string>("")
  const [loading, setLoading] = createSignal<boolean>(true)
  let disposed = false

  function nodes(): TreeNode[] {
    const current = snapshot()
    if (!current) return []
    return tree({
      snapshot: modelSnapshotOf(current),
      agents: current.agents.map((agent) => ({ id: agent.id, scope: agent.scope, path: agent.path })),
      expanded: expanded(),
    })
  }

  function selected(): TreeNode | undefined {
    return nodes().find((node) => node.id === selectedId())
  }

  function ensureSelection() {
    const list = nodes()
    if (list.length === 0) {
      setSelectedId(undefined)
      return
    }
    const current = selectedId()
    if (current !== undefined && list.some((node) => node.id === current)) return
    setSelectedId(list[0].id)
  }

  async function load() {
    if (disposed) return
    setLoading(true)
    try {
      const fresh = await plus["instructions.snapshot"](undefined, { location: context.location })
      if (disposed) return
      const firstLoad = snapshot() === undefined
      setSnapshot(fresh)
      // First load only: expand the top-level groups so agents are visible.
      // Group ids come from tree(...) itself; nothing is hardcoded here.
      if (firstLoad && expanded().size === 0) {
        const groups = nodes()
          .filter((node) => node.kind === "group")
          .map((node) => node.id)
        if (groups.length > 0) setExpanded(new Set(groups))
      }
      setStatus("")
      ensureSelection()
    } catch (error: unknown) {
      if (disposed) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed) setLoading(false)
    }
  }

  async function refresh() {
    if (disposed) return
    setLoading(true)
    try {
      const fresh = await plus["instructions.refresh"](undefined, { location: context.location })
      if (disposed) return
      setSnapshot(fresh)
      setStatus("Refreshed from host")
      ensureSelection()
    } catch (error: unknown) {
      if (disposed) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed) setLoading(false)
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function select(id: string) {
    setSelectedId(id)
  }

  function move(delta: number) {
    const list = nodes()
    if (list.length === 0) return
    const current = selectedId()
    const index = list.findIndex((node) => node.id === current)
    if (index === -1) {
      const target = delta >= 0 ? list[0] : list[list.length - 1]
      setSelectedId(target.id)
      return
    }
    const next = Math.min(list.length - 1, Math.max(0, index + delta))
    setSelectedId(list[next].id)
  }

  async function setEnabled(node: TreeNode, value: boolean) {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return
    }
    if (node.badges.readOnly) {
      const owner = node.agentId ?? "default"
      setStatus(`"${node.label}" is read-only: agent "${owner}" is protected`)
      return
    }
    if (node.itemId === undefined) {
      setStatus(`"${node.label}" cannot be toggled`)
      return
    }
    const item = current.items.find((entry) => entry.id === node.itemId)
    if (!item) {
      setStatus(`Item not found for "${node.label}"`)
      return
    }
    const agent = node.agentId ?? "*"
    const existing = current.customizations.find((record) => record.item === node.itemId && record.agent === agent)
    const nextState: SnapshotCustomization["state"] = value ? "enabled" : "disabled"
    const existingText = existing?.text
    const existingReviewed = existing?.reviewed
    const record: SnapshotCustomization = {
      item: node.itemId,
      agent,
      state: nextState,
      basedOn: existing?.basedOn ?? item.fingerprint,
      updated: new Date().toISOString(),
      ...(existingText === undefined ? {} : { text: existingText }),
      ...(existingReviewed === undefined ? {} : { reviewed: existingReviewed }),
    }
    const customizations = [
      ...current.customizations.filter((entry) => !(entry.item === node.itemId && entry.agent === agent)),
      record,
    ]
    setLoading(true)
    try {
      const result = await plus["instructions.mutate"](
        { expectedRevision: current.revision, customizations },
        { location: context.location },
      )
      if (disposed) return
      if (result.ok) {
        setSnapshot(result.snapshot)
        setStatus(value ? `Enabled "${node.label}"` : `Disabled "${node.label}"`)
        ensureSelection()
        return
      }
      setSnapshot(result.snapshot)
      setStatus(
        `Revision changed (expected ${current.revision}, latest ${result.snapshot.revision}); reloaded, toggle again to apply`,
      )
      ensureSelection()
    } catch (error: unknown) {
      if (disposed) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed) setLoading(false)
    }
  }

  void load()
  const unsubscribe = plus.events.on("instructions.changed", () => {
    void load()
  })

  function dispose() {
    disposed = true
    unsubscribe()
  }

  return {
    snapshot,
    nodes,
    selected,
    selectedId,
    expanded,
    status,
    loading,
    toggleExpanded,
    select,
    move,
    setEnabled,
    refresh,
    dispose,
  }
}

export type InstructionsState = ReturnType<typeof createInstructionsState>

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}
