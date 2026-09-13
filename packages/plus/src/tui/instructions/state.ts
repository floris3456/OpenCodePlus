import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { mergeCustomization, resetFields } from "../../instructions/model.js"
import type { Customization, Item, MergeCustomizationFields } from "../../instructions/model.js"
import { tree, type TreeNode } from "../../instructions/tree.js"
import { Definition, type Snapshot } from "../../rpc.js"

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
      ...(record.text === undefined ? {} : { text: record.text }),
      state: record.state,
      basedOn: record.basedOn,
      ...(record.reviewed === undefined ? {} : { reviewed: record.reviewed }),
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
      agents: current.agents.map((agent) => ({
        id: agent.id,
        scope: agent.scope,
        ...(agent.path === undefined ? {} : { path: agent.path }),
      })),
      tools: current.tools.map((tool) => ({ id: tool.id, native: tool.native })),
      project: { version: 1, protectedAgents: [...current.protectedAgents] },
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

  function selectAgent(agentId: string): boolean {
    if (disposed) return false
    const current = snapshot()
    if (!current) return false
    const agent = current.agents.find((entry) => entry.id === agentId)
    if (!agent) return false
    const groupId = agent.scope === "builtin" ? "group:defaults" : `group:${agent.scope}`
    if (!expanded().has(groupId)) {
      setExpanded((previous) => {
        const next = new Set(previous)
        next.add(groupId)
        return next
      })
    }
    const nodeId = `agent:${agentId}`
    setSelectedId(nodeId)
    return true
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
    if (node.itemId === undefined) {
      setStatus(`"${node.label}" cannot be toggled`)
      return
    }
    const toggle = node.action?.toggle
    if (toggle?.allowed === false) {
      setStatus(`"${node.label}" cannot be toggled: ${toggle.reason}`)
      return
    }
    await mutateFields(
      node,
      { state: value ? "enabled" : "disabled" },
      value ? `Enabled "${node.label}"` : `Disabled "${node.label}"`,
      `Revision changed; reloaded, toggle "${node.label}" again to apply`,
    )
  }

  async function acknowledge(node: TreeNode) {
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
      setStatus(`"${node.label}" cannot be acknowledged`)
      return
    }
    const edit = node.action?.edit
    const toggle = node.action?.toggle
    if (edit?.allowed !== true && toggle?.allowed !== true) {
      const reason = edit?.allowed === false ? edit.reason : toggle?.allowed === false ? toggle.reason : "action is not supported"
      setStatus(`"${node.label}" cannot be acknowledged: ${reason}`)
      return
    }
    if (node.badges.review !== true) {
      setStatus(`"${node.label}" needs no review`)
      return
    }
    const item = current.items.find((entry) => entry.id === node.itemId)
    if (!item) {
      setStatus(`Item not found for "${node.label}"`)
      return
    }
    await mutateFields(
      node,
      { reviewed: item.fingerprint },
      `Acknowledged "${node.label}"`,
      `Revision changed; reloaded, acknowledge "${node.label}" again to apply`,
    )
  }

  async function saveText(node: TreeNode, text: string): Promise<boolean> {
    const edit = node.action?.edit
    if (edit?.allowed === false) {
      setStatus(`"${node.label}" cannot be edited: ${edit.reason}`)
      return false
    }
    return mutateFields(
      node,
      { text },
      `Saved "${node.label}"`,
      `Revision changed; reloaded, save "${node.label}" again to apply`,
    )
  }

  async function reset(node: TreeNode): Promise<boolean> {
    // Every refusal lands before the confirm: offering a destructive dialog
    // for a row that cannot proceed would only scare the user, then refuse.
    if (node.badges.readOnly) {
      const owner = node.agentId ?? "default"
      setStatus(`"${node.label}" is read-only: agent "${owner}" is protected`)
      return false
    }
    if (node.itemId === undefined) {
      setStatus(`"${node.label}" cannot be reset`)
      return false
    }
    const resettable = node.action?.reset
    if (resettable?.allowed === false) {
      setStatus(`"${node.label}" cannot be reset: ${resettable.reason}`)
      return false
    }
    const confirmed = await context.ui.dialog.confirm({
      title: `Reset "${node.label}"?`,
      message: `Reset "${node.label}" to its default? This discards the customization and cannot be undone.`,
    })
    if (!confirmed) {
      setStatus(`Reset of "${node.label}" cancelled`)
      return false
    }
    return mutateFields(
      node,
      resetFields(node),
      `Reset "${node.label}" to default`,
      `Revision changed; reloaded, reset "${node.label}" again to apply`,
    )
  }

  async function mutateFields(
    node: TreeNode,
    fields: MergeCustomizationFields,
    successStatus: string,
    staleStatus: string,
  ): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    if (node.badges.readOnly) {
      const owner = node.agentId ?? "default"
      setStatus(`"${node.label}" is read-only: agent "${owner}" is protected`)
      return false
    }
    if (node.itemId === undefined) {
      setStatus(`"${node.label}" cannot be changed`)
      return false
    }
    const found = current.items.find((entry) => entry.id === node.itemId)
    if (!found) {
      setStatus(`Item not found for "${node.label}"`)
      return false
    }
    const item: Item = { ...found, agents: [...found.agents] }
    const agent = node.agentId ?? "*"
    const model = modelSnapshotOf(current)
    const customizations = mergeCustomization(model.customizations, item, agent, fields)
    setLoading(true)
    try {
      const result = await plus["instructions.mutate"](
        { expectedRevision: current.revision, customizations },
        { location: context.location },
      )
      if (disposed) return false
      if (result.ok) {
        setSnapshot(result.snapshot)
        setStatus(successStatus)
        ensureSelection()
        return true
      }
      setSnapshot(result.snapshot)
      setStatus(`Revision changed (expected ${current.revision}, latest ${result.snapshot.revision}); ${staleStatus}`)
      ensureSelection()
      return false
    } catch (error: unknown) {
      if (disposed) return false
      setStatus(errorMessage(error))
      return false
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
    selectAgent,
    move,
    setEnabled,
    acknowledge,
    saveText,
    reset,
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
