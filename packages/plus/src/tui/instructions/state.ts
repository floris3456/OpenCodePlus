import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal } from "solid-js"
import { applies, resolve, resolveSplit, scopesOf, threeWay } from "../../instructions/model.js"
import type {
  Address,
  AgentSource,
  CustomizationRecord,
  Item,
  SplitRecord,
} from "../../instructions/model.js"
import { expandedTree, tree, type MemoInput, type TeamInput, type TreeNode } from "../../instructions/tree.js"
import { agentOf, itemOf, recordOf, teamOf } from "../../instructions/snapshot.js"
import { addSection, removalPlan, reset, resolveReview, saveSplit, saveText, setEnabled, teamPlan, toggle } from "../../instructions/ops.js"
import { query } from "../../instructions/query.js"
import { Definition, type Snapshot, type SnapshotRecord } from "../../rpc.js"

export type { TreeNode }

function recordsOf(records: readonly SnapshotRecord[]): (CustomizationRecord | SplitRecord)[] {
  return records.map(recordOf)
}

function toRpcRecords(
  customizations: readonly CustomizationRecord[],
  splits: readonly (SplitRecord & { updated?: string })[],
): SnapshotRecord[] {
  return [
    ...customizations.map(
      (record): SnapshotRecord => ({
        type: "customization",
        level: record.level,
        agent: record.agent,
        item: record.item,
        section: record.section,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(record.state === undefined ? {} : { state: record.state }),
        basedOn: record.basedOn,
        ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
        ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
        updated: record.updated,
      }),
    ),
    ...splits.map((record): SnapshotRecord => {
      const known = record.updated ?? now()
      return {
        type: "split",
        level: record.level,
        agent: record.agent,
        item: record.item,
        boundaries: [...record.boundaries],
        updated: known,
      }
    }),
  ]
}

export function createInstructionsState(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>(undefined)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined)
  const [filter, setFilter] = createSignal<string>("")
  const [status, setStatus] = createSignal<string>("")
  const [loading, setLoading] = createSignal<boolean>(true)
  let disposed = false
  let disabled = false
  let generation = 0

  const itemsForTree = createMemo<Item[]>(() => {
    const current = snapshot()
    if (!current) return []
    return current.items.map(itemOf)
  })

  const recordsForTree = createMemo<(CustomizationRecord | SplitRecord)[]>(() => {
    const current = snapshot()
    if (!current) return []
    return recordsOf(current.records)
  })

  const agentsForTree = createMemo<AgentSource[]>(() => {
    const current = snapshot()
    if (!current) return []
    return current.agents.map(agentOf)
  })

  const teamsForTree = createMemo<TeamInput[]>(() => {
    const current = snapshot()
    if (!current) return []
    return (current.teams ?? []).map(teamOf)
  })

  const allNodes = createMemo<TreeNode[]>(() => {
    const current = snapshot()
    if (!current) return []
    return tree({
      items: itemsForTree(),
      records: recordsForTree(),
      agents: agentsForTree(),
      teams: teamsForTree(),
      expanded: expanded(),
    })
  })

  const fullTree = createMemo<TreeNode[]>(() => {
    const current = snapshot()
    if (!current) return []
    return expandedTree({ items: itemsForTree(), records: recordsForTree(), agents: agentsForTree(), teams: teamsForTree() })
  })

  function ancestorsOf(
    all: readonly TreeNode[],
    byId: ReadonlyMap<string, TreeNode>,
    indexById: ReadonlyMap<string, number>,
    node: TreeNode,
  ): TreeNode[] {
    // tree() emits the full logical pre-order list: ancestors of node are the
    // nearest preceding rows with strictly smaller depth.
    const index = indexById.get(node.id)
    if (index === undefined) return []
    const out: TreeNode[] = []
    let depth = node.depth
    for (let at = index - 1; at >= 0; at--) {
      const candidate = all[at]
      if (candidate === undefined) break
      if (candidate.depth < depth) {
        out.unshift(byId.get(candidate.id) ?? candidate)
        depth = candidate.depth
        if (depth <= 0) break
      }
    }
    return out
  }

  const nodes = createMemo<TreeNode[]>(() => {
    const raw = filter()
    if (raw.trim().length === 0) return allNodes()
    // Reveal matches hidden inside collapsed ancestors: match against the
    // full logical tree and include each match with its ancestor chain.
    // Matches come from the shared query engine so the TUI and the tool
    // layer filter the same rows. Gated Code Mode sections never surface and
    // the ancestor chain stays here, never in the engine.
    const full = fullTree()
    const matched = matchFilter(raw, full)
    const byId = new Map(full.map((node) => [node.id, node]))
    const indexById = new Map(full.map((node, index) => [node.id, index] as const))
    const included = new Map<string, TreeNode>()
    for (const node of matched) {
      for (const ancestor of ancestorsOf(full, byId, indexById, node)) included.set(ancestor.id, ancestor)
      included.set(node.id, node)
    }
    return [...included.values()]
  })

  // Engine first so structured filters behave like the tool layer; anything
  // the grammar rejects falls back to the legacy label/id substring match.
  function matchFilter(raw: string, full: TreeNode[]): TreeNode[] {
    const visible = (node: TreeNode) => node.kind !== "section" || node.actions?.toggle === true
    try {
      const ids = new Set(
        query(
          { items: itemsForTree(), records: recordsForTree(), agents: agentsForTree(), teams: teamsForTree() },
          { where: raw, fields: ["id"] },
        ).rows.map((row) => row.id),
      )
      return full.filter((node) => ids.has(node.id) && visible(node))
    } catch {
      const normalized = raw.trim().toLowerCase()
      return full.filter(
        (node) => visible(node) && (node.label.toLowerCase().includes(normalized) || node.id.toLowerCase().includes(normalized)),
      )
    }
  }

  const selected = createMemo<TreeNode | undefined>(() => {
    return nodes().find((node) => node.id === selectedId())
  })

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
    if (disposed || disabled) return
    const requestGen = ++generation
    setLoading(true)
    try {
      const fresh = await plus["instructions.snapshot"](undefined, { location: context.location })
      if (disposed || disabled || requestGen !== generation) return
      const firstLoad = snapshot() === undefined
      setSnapshot(fresh)
      if (firstLoad && expanded().size === 0) {
        const roots = allNodes().filter((node) => node.kind === "root")
        if (roots.length > 0) setExpanded(new Set(roots.map((node) => node.id)))
      }
      setStatus("")
      ensureSelection()
    } catch (error: unknown) {
      if (disposed || disabled || requestGen !== generation) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed && !disabled && requestGen === generation) setLoading(false)
    }
  }

  async function refresh() {
    if (disposed || disabled) return
    const requestGen = ++generation
    setLoading(true)
    try {
      const fresh = await plus["instructions.refresh"](undefined, { location: context.location })
      if (disposed || disabled || requestGen !== generation) return
      setSnapshot(fresh)
      setStatus("Refreshed from host")
      ensureSelection()
    } catch (error: unknown) {
      if (disposed || disabled || requestGen !== generation) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed && !disabled && requestGen === generation) setLoading(false)
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
    const entry = current.agents.find((candidate) => candidate.id === agentId)
    if (!entry) return false
    const next = new Set(expanded())
    // Agents live under their level's Agents group at every level, so reveal
    // the whole chain down to the agent.
    next.add(`root:${entry.scope}`)
    next.add(`group:${entry.scope}:agents`)
    setExpanded(next)
    setSelectedId(`agent:${entry.scope}:${agentId}`)
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

  function upstreamFor(items: readonly Item[], address: Address): Item | undefined {
    const matches = items.filter((entry) => entry.id === address.item)
    const owner = address.agent
    if (owner === null) return matches[0]
    return matches.find((entry) => applies(entry, owner)) ?? matches[0]
  }

  function chainFor(node: TreeNode):
    | { address: Address; upstream: Item; customizations: CustomizationRecord[]; splits: SplitRecord[] }
    | undefined {
    const current = snapshot()
    const address = node.address
    if (!current || !address) return undefined
    const found = upstreamFor(current.items, address)
    if (!found) return undefined
    const upstream: Item = itemOf(found)
    const converted = recordsOf(current.records)
    return {
      address,
      upstream,
      customizations: converted.filter((record): record is CustomizationRecord => record.type === "customization"),
      splits: converted.filter((record): record is SplitRecord => record.type === "split"),
    }
  }

  function scopes(): ReturnType<typeof scopesOf> {
    const current = snapshot()
    if (!current) return { global: new Set<string>(), defaults: new Set<string>() }
    return scopesOf(current.agents.map(agentOf))
  }

  function resolvedText(node: TreeNode): string {
    const chain = chainFor(node)
    if (!chain) return ""
    const scopesValue = scopes()
    return resolve({
      upstream: chain.upstream,
      records: chain.customizations,
      splits: chain.splits,
      scopes: scopesValue,
      address: chain.address,
    }).text
  }

  function threeWayFor(node: TreeNode): { original: string; mine: string; upstream: string } | undefined {
    const chain = chainFor(node)
    if (!chain) return undefined
    return threeWay({
      upstream: chain.upstream,
      records: chain.customizations,
      splits: chain.splits,
      scopes: scopes(),
      address: chain.address,
    })
  }

  async function persist(
    nextCustomizations: readonly CustomizationRecord[],
    nextSplits: readonly (SplitRecord & { updated?: string })[],
    successStatus: string,
    retryHint: string,
  ): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const requestGen = ++generation
    setLoading(true)
    try {
      const result = await plus["instructions.mutate"](
        {
          expectedRevision: current.revision,
          expectedGlobalRevision: current.globalRevision,
          records: toRpcRecords(nextCustomizations, nextSplits),
        },
        { location: context.location },
      )
      if (disposed || disabled || requestGen !== generation) return false
      if (result.ok) {
        setSnapshot(result.snapshot)
        setStatus(successStatus)
        ensureSelection()
        return true
      }
      setSnapshot(result.snapshot)
      setStatus(
        `Revision changed (expected ${current.revision}/${current.globalRevision}, latest ${result.snapshot.revision}/${result.snapshot.globalRevision}); ${retryHint}`,
      )
      ensureSelection()
      return false
    } catch (error: unknown) {
      if (disposed || disabled || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && !disabled && requestGen === generation) setLoading(false)
    }
  }

  function memoInput(): MemoInput {
    return { items: itemsForTree(), records: recordsForTree(), agents: agentsForTree(), teams: teamsForTree() }
  }

  async function toggleRow(node: TreeNode): Promise<boolean> {
    if (node.kind === "team") return toggleTeamRow(node)
    const result = toggle(memoInput(), node.id)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  // Team toggle: the tree row id is `team:<level>:<team>` (member rows hang
  // one level deeper as `team:<level>:<team>:<member>`). The match takes the
  // first segment after `team:` as the level and everything after as the
  // team name, so names containing colons still parse. Member rows carry no
  // toggle action, so only the team row itself reaches here. Enablement reads from the snapshot (same source the badge
  // renders), inverts, calls team.setEnabled, then refreshes from the host
  // exactly like agent.delete/mcp.remove do — the fresh snapshot rebuilds
  // the tree with the new state. Declared errors surface as status text
  // like every other action path.
  async function toggleTeamRow(node: TreeNode): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const plan = teamPlan(memoInput(), node.id)
    if ("refusal" in plan) {
      setStatus(plan.refusal)
      return false
    }
    const requestGen = ++generation
    setLoading(true)
    try {
      const ref = await plus["team.setEnabled"](
        { level: plan.level, team: plan.team, enabled: plan.enabled },
        { location: context.location },
      )
      if (disposed || disabled || requestGen !== generation) return false
      if (ref.enabled !== plan.enabled) {
        setStatus(`Team "${plan.team}" reported ${ref.enabled ? "enabled" : "disabled"} instead of the requested state`)
        return false
      }
      await refresh()
      if (disposed || disabled) return false
      setStatus(plan.successStatus)
      return true
    } catch (error: unknown) {
      if (disposed || disabled || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && !disabled && requestGen === generation) setLoading(false)
    }
  }

  // a on the Teams group: create the team directory through team.create, then
  // refresh from the host exactly like toggleTeamRow/remove do — the fresh
  // snapshot rebuilds the tree with the new disabled row. Declared errors
  // surface as status text like every other action path.
  async function createTeam(level: "project" | "global", team: string): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const requestGen = ++generation
    setLoading(true)
    try {
      const ref = await plus["team.create"]({ level, team }, { location: context.location })
      if (disposed || disabled || requestGen !== generation) return false
      await refresh()
      if (disposed || disabled) return false
      setStatus(`Created team "${ref.team}"`)
      return true
    } catch (error: unknown) {
      if (disposed || disabled || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && !disabled && requestGen === generation) setLoading(false)
    }
  }

  async function setEnabledRow(node: TreeNode, value: boolean): Promise<boolean> {
    const result = setEnabled(memoInput(), node.id, value)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function saveTextRow(node: TreeNode, text: string): Promise<boolean> {
    const result = saveText(memoInput(), node.id, text)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function resetNode(node: TreeNode): Promise<boolean> {
    const result = reset(memoInput(), node.id)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    const confirmed = await context.ui.dialog.confirm({
      title: `Reset "${node.label}"?`,
      message: `Reset "${node.label}" to its default? This discards the override and cannot be undone.`,
    })
    if (!confirmed) {
      setStatus(`Reset of "${node.label}" cancelled`)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function saveSplitRow(
    node: TreeNode,
    boundaries: readonly { id: string; name: string; start: number }[],
  ): Promise<boolean> {
    const result = saveSplit(memoInput(), node.id, boundaries)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  // a on an item row: append one section through the manual splitter path.
  // Both halves persist in one mutate: the SplitRecord boundary for the item
  // and the CustomizationRecord text for the new section. Appending at the
  // end keeps existing offsets stable, so the first add on an unsplit item
  // coherently splits its existing text plus the new section.
  async function addSectionRow(node: TreeNode, name: string, text: string): Promise<boolean> {
    const result = addSection(memoInput(), node.id, name, text)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  // Yellow (review) resolutions via threeWay/resolveResolution.
  async function resolveKeep(node: TreeNode): Promise<boolean> {
    const result = resolveReview(memoInput(), node.id, "keep")
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function resolveTake(node: TreeNode): Promise<boolean> {
    const result = resolveReview(memoInput(), node.id, "take")
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function resolveEdit(node: TreeNode, edited: string): Promise<boolean> {
    const result = resolveReview(memoInput(), node.id, "edit", edited)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  function splitPreview(node: TreeNode) {
    const chain = chainFor(node)
    if (!chain || !node.address) return undefined
    return resolveSplit({
      text: resolvedText(node),
      title: chain.upstream.title,
      splits: chain.splits,
      scopes: scopes(),
      address: chain.address,
    })
  }

  // d: delete rows whose tree actions allow remove. Agent rows go through
  // agent.delete, shared MCP rows through mcp.remove, project skills through
  // skill.delete, user base templates through base.delete, and project
  // instruction files through instruction.delete. Anything else keeps an
  // honest refusal naming why it cannot be deleted. The route offers d on
  // every item and section row so refusals reach the user as status text;
  // rows without remove actions never delete.
  async function remove(node: TreeNode): Promise<boolean> {
    const plan = removalPlan(memoInput(), node.id)
    if ("refusal" in plan) {
      setStatus(plan.refusal)
      return false
    }
    const confirmed = await context.ui.dialog.confirm({
      title: plan.confirmTitle,
      message: plan.confirmMessage,
    })
    if (confirmed !== true) {
      setStatus(`Delete of "${node.label}" cancelled`)
      return false
    }
    try {
      if (plan.kind === "agent.delete") {
        await plus["agent.delete"]({ scope: plan.scope, id: plan.id }, { location: context.location })
      } else if (plan.kind === "mcp.remove") {
        await plus["mcp.remove"]({ name: plan.name }, { location: context.location })
      } else if (plan.kind === "skill.delete") {
        await plus["skill.delete"]({ id: plan.id }, { location: context.location })
      } else if (plan.kind === "base.delete") {
        await plus["base.delete"]({ id: plan.id }, { location: context.location })
      } else {
        await plus["instruction.delete"]({ name: plan.name }, { location: context.location })
      }
      if (disposed) return false
      await refresh()
      if (disposed) return false
      setStatus(plan.successStatus)
      return true
    } catch (error: unknown) {
      setStatus(errorMessage(error))
      return false
    }
  }
  void load()
  const unsubscribeInstructions = plus.events.on("instructions.changed", () => {
    void load()
  })
  const unsubscribeProject = plus.events.on("project.changed", (event) => {
    if (!event.data.enabled) {
      disabled = true
      generation++
      setSnapshot(undefined)
      setSelectedId(undefined)
      setLoading(false)
      setStatus("Project mode is disabled for this directory")
      return
    }
    disabled = false
    void load()
  })

  function dispose() {
    disposed = true
    generation++
    unsubscribeInstructions()
    unsubscribeProject()
  }

  return {
    snapshot,
    nodes,
    allNodes,
    selected,
    selectedId,
    expanded,
    filter,
    setFilter,
    status,
    loading,
    toggleExpanded,
    select,
    selectAgent,
    move,
    toggle: toggleRow,
    setEnabled: setEnabledRow,
    saveText: saveTextRow,
    reset: resetNode,
    saveSplit: saveSplitRow,
    addSection: addSectionRow,
    createTeam,
    splitPreview,
    resolvedText,
    threeWay: threeWayFor,
    resolveKeep,
    resolveTake,
    resolveEdit,
    remove,
    refresh,
    dispose,
  }
}

export type InstructionsState = ReturnType<typeof createInstructionsState>

function now(): string {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}
