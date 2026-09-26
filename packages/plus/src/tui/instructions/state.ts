import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal } from "solid-js"
import { controlItemFor, isControl } from "../../instructions/agent-controls.js"
import { applies, parsePermItemId, resolve, resolveSplit, threeWay } from "../../instructions/model.js"
import type {
  Address,
  AgentSource,
  CustomizationRecord,
  Item,
  ModelRecord,
  ReviewPart,
  RuleRecord,
  Scopes,
  SplitRecord,
} from "../../instructions/model.js"
import { withOwnerRoles, type PresetState } from "../../instructions/presets.js"
import { controlChoices, expandedTree, tree, withControlItems, type MemoInput, type TeamInput, type TreeNode } from "../../instructions/tree.js"
import { agentOf, contextOfSnapshot, itemOf, presetStateOfSnapshot, recordOf, teamOf } from "../../instructions/snapshot.js"
import {
  activateModelRow,
  addSection,
  findRow,
  isModelRowId,
  isPermRowId,
  modelReviewChoice,
  removalPlan,
  removeModelRow,
  reset,
  resetModelRow,
  resolveModelReview,
  resolveReview,
  saveSplit,
  saveText,
  setEnabled,
  setPin,
  stateReviewChoice,
  teamPlan,
  toggle,
  type ModelReviewChoice,
  type StateReviewChoice,
} from "../../instructions/ops.js"
import { query } from "../../instructions/query.js"
import { Definition, type Snapshot, type SnapshotRecord } from "../../rpc.js"

export type { TreeNode }

function recordsOf(records: readonly SnapshotRecord[]): (CustomizationRecord | SplitRecord | ModelRecord | RuleRecord)[] {
  return records
    .map((record) => {
      const converted = recordOf(record)
      if (record.team !== undefined && converted !== undefined) {
        return { ...converted, team: record.team }
      }
      return converted
    })
    .filter(
      (record): record is CustomizationRecord | SplitRecord | ModelRecord | RuleRecord =>
        record.type === "customization" || record.type === "split" || record.type === "model" || record.type === "rule",
    )
}

// The TUI's whole-set write: every `persist` call resubmits the complete
// record list through `instructions.mutate`, so this serializer has to carry
// the same optional fields `toRecord` (index.ts) and `toSnapshotRecords`
// (tools.ts) preserve. Two are easy to drop silently: a rule's `message` — the
// refusal text the model reads — and the shared-inventory `catalogue`, which
// decides whether a Defaults row resolves through the Agents or the Teams
// catalogue. Absent keys stay absent so an unset field encodes exactly as it
// did before it existed.
export function toRpcRecords(
  customizations: readonly CustomizationRecord[],
  splits: readonly (SplitRecord & { updated?: string })[],
  models?: readonly ModelRecord[],
  rules?: readonly RuleRecord[],
): SnapshotRecord[] {
  return [
    ...customizations.map(
      (record): SnapshotRecord => ({
        type: "customization",
        level: record.level,
        agent: record.agent,
        ...(record.team !== undefined ? { team: record.team } : {}),
        ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
        item: record.item,
        section: record.section,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(record.state === undefined ? {} : { state: record.state }),
        ...(record.pin === undefined ? {} : { pin: record.pin }),
        basedOn: record.basedOn,
        ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
        ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
        ...(record.basedOnState === undefined ? {} : { basedOnState: record.basedOnState }),
        ...(record.basedOnPin === undefined ? {} : { basedOnPin: record.basedOnPin }),
        updated: record.updated,
      }),
    ),
    ...splits.map((record): SnapshotRecord => {
      const known = record.updated ?? now()
      return {
        type: "split",
        level: record.level,
        agent: record.agent,
        ...(record.team !== undefined ? { team: record.team } : {}),
        ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
        item: record.item,
        boundaries: [...record.boundaries],
        updated: known,
      }
    }),
    ...(models ?? []).map(
      (record): SnapshotRecord => ({
        type: "model",
        level: record.level,
        agent: record.agent,
        ...(record.team !== undefined ? { team: record.team } : {}),
        ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
        providerID: record.providerID,
        modelID: record.modelID,
        ...(record.variant === undefined ? {} : { variant: record.variant }),
        ...(record.active === undefined ? {} : { active: record.active }),
        ...(record.basedOn === undefined ? {} : { basedOn: record.basedOn }),
        updated: record.updated,
      }),
    ),
    ...(rules ?? []).map(
      (record): SnapshotRecord => ({
        type: "rule",
        level: record.level,
        agent: record.agent,
        ...(record.team !== undefined ? { team: record.team } : {}),
        ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
        tool: record.tool,
        id: record.id,
        label: record.label,
        patterns: [...record.patterns],
        keywords: [...record.keywords],
        ...(record.message === undefined ? {} : { message: record.message }),
        updated: record.updated,
      }),
    ),
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

  // Presets and Defaults entries get the Role/persona row every agent has.
  const itemsForTree = createMemo<Item[]>(() => {
    const current = snapshot()
    if (!current) return []
    return withOwnerRoles(withControlItems(current.items.map(itemOf)), presetStateOfSnapshot(current))
  })

  const recordsForTree = createMemo<(CustomizationRecord | SplitRecord | ModelRecord | RuleRecord)[]>(() => {
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
    return (current.teams ?? []).map((team) => ({
      ...teamOf(team),
      ...(team.overlay !== undefined ? { overlay: [...team.overlay] } : {}),
    }))
  })

  const presetStateForTree = createMemo<PresetState>(() => {
    const current = snapshot()
    if (!current) return {}
    return presetStateOfSnapshot(current)
  })

  const allNodes = createMemo<TreeNode[]>(() => {
    const current = snapshot()
    if (!current) return []
    return tree({
      items: itemsForTree(),
      records: recordsForTree(),
      agents: agentsForTree(),
      teams: teamsForTree(),
      ...presetStateForTree(),
      expanded: expanded(),
    })
  })

  let cachedFullTree:
    | {
        readonly revision: number
        readonly globalRevision: number
        readonly tree: TreeNode[]
      }
    | undefined

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
    if (raw.trim().length === 0) {
      cachedFullTree = undefined
      return allNodes()
    }
    // Reveal matches hidden inside collapsed ancestors: match against the
    // full logical tree and include each match with its ancestor chain.
    // Matches come from the shared query engine so the TUI and the tool
    // layer filter the same rows. Code Mode rows are live and filter like any
    // other row; the ancestor chain stays here, never in the engine.
    const current = snapshot()
    if (!current) return []
    if (
      cachedFullTree === undefined ||
      cachedFullTree.revision !== current.revision ||
      cachedFullTree.globalRevision !== current.globalRevision
    ) {
      cachedFullTree = {
        revision: current.revision,
        globalRevision: current.globalRevision,
        tree: expandedTree({
          items: itemsForTree(),
          records: recordsForTree(),
          agents: agentsForTree(),
          teams: teamsForTree(),
          ...presetStateForTree(),
        }),
      }
    }
    const full = cachedFullTree.tree
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
          {
            items: itemsForTree(),
            records: recordsForTree(),
            agents: agentsForTree(),
            teams: teamsForTree(),
            ...presetStateForTree(),
          },
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

  // A row a create flow wants selected (reveal): its ancestors are expanded
  // and it is selected as soon as a snapshot carries it. Core reloads agents
  // on a debounce, so that can be a later snapshot than the create's own
  // refresh. Moving the cursor drops the wish.
  let pending: { readonly expand: readonly string[]; readonly row: string } | undefined

  function reveal(expand: readonly string[], row: string) {
    pending = { expand, row }
    applyPending()
  }

  function applyPending(): boolean {
    const wanted = pending
    if (wanted === undefined) return false
    const next = new Set([...expanded(), ...wanted.expand])
    if (next.size !== expanded().size) setExpanded(next)
    if (!nodes().some((node) => node.id === wanted.row)) return false
    pending = undefined
    setSelectedId(wanted.row)
    return true
  }

  function ensureSelection() {
    if (applyPending()) return
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
    pending = undefined
    setSelectedId(id)
  }

  function selectAgent(agentId: string): boolean {
    if (disposed) return false
    const current = snapshot()
    if (!current) return false
    const entry = current.agents.find((candidate) => candidate.id === agentId)
    if (!entry) return false
    const origin = entry.origin ?? "user"
    const next = new Set(expanded())
    // Agents live under their level's Agents group at every level, so reveal
    // the whole chain down to the agent through the origin subgroup. Special
    // agents nest under Native, so they need both the Native parent and the
    // native:special child; other origins need only their own subgroup.
    next.add(`root:${entry.scope}`)
    next.add(`group:${entry.scope}:agents`)
    next.add(`group:${entry.scope}:agents:${origin}`)
    if (origin === "special") {
      next.add(`group:${entry.scope}:agents:native`)
      next.add(`group:${entry.scope}:agents:native:special`)
    }
    setExpanded(next)
    setSelectedId(`agent:${entry.scope}:${agentId}`)
    return true
  }

  function move(delta: number) {
    pending = undefined
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
    if (isControl(address.item)) return controlItemFor(items, address)
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
    const upstream = upstreamFor(itemsForTree(), address)
    if (!upstream) return undefined
    const converted = recordsOf(current.records)
    return {
      address,
      upstream,
      customizations: converted.filter((record): record is CustomizationRecord => record.type === "customization"),
      splits: converted.filter((record): record is SplitRecord => record.type === "split"),
    }
  }

  function scopes(): Scopes {
    const current = snapshot()
    if (!current) return { global: new Set<string>(), defaults: new Set<string>() }
    return contextOfSnapshot(current)
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
    nextModels?: readonly ModelRecord[],
    nextRules?: readonly RuleRecord[],
  ): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const converted = recordsOf(current.records)
    const preserved =
      nextModels ?? converted.filter((record): record is ModelRecord => record.type === "model")
    const preservedRules =
      nextRules ?? converted.filter((record): record is RuleRecord => record.type === "rule")
    const requestGen = ++generation
    setLoading(true)
    try {
      const result = await plus["instructions.mutate"](
        {
          expectedRevision: current.revision,
          expectedGlobalRevision: current.globalRevision,
          records: toRpcRecords(nextCustomizations, nextSplits, preserved, preservedRules),
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
    return {
      items: itemsForTree(),
      records: recordsForTree(),
      agents: agentsForTree(),
      teams: teamsForTree(),
      ...presetStateForTree(),
    }
  }

  async function persistModels(models: readonly ModelRecord[], successStatus: string, retryHint: string): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const converted = recordsOf(current.records)
    const customizations = converted.filter((record): record is CustomizationRecord => record.type === "customization")
    const splits = converted.filter((record): record is SplitRecord => record.type === "split")
    return persist(customizations, splits, successStatus, retryHint, models)
  }

  async function toggleRow(node: TreeNode): Promise<boolean> {
    if (node.kind === "team" && node.enabledRow === undefined) return toggleTeamRow(node)
    if (isModelRowId(node.id) || node.address?.item.startsWith("model:")) {
      const result = activateModelRow(memoInput(), node.id)
      if ("refusal" in result) {
        setStatus(result.refusal)
        return false
      }
      return persistModels(result.models, result.status, result.retryHint)
    }
    const result = toggle(memoInput(), node.enabledRow ?? node.id)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  // Team toggle: the tree row id is `team:<level>:<team>` (member rows hang
  // one level deeper as `team:<level>:<team>:<member>`). The match takes the
  // first segment after `team:` as the level and everything after as the
  // team name, so names containing colons still parse. Member rows toggle
  // their Enabled item above, so only the team itself reaches here. Enablement reads from the snapshot (same source the badge
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
    const result = setEnabled(memoInput(), node.enabledRow ?? node.id, value)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function setPinRow(node: TreeNode, value: boolean): Promise<boolean> {
    const result = setPin(memoInput(), node.id, value)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function togglePinRow(node: TreeNode): Promise<boolean> {
    return setPinRow(node, node.badges.pinned !== true)
  }

  async function saveTextRow(node: TreeNode, text: string): Promise<boolean> {
    if (blockedControlWrite(node)) return false
    const result = saveText(memoInput(), node.id, text)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function resetNode(node: TreeNode): Promise<boolean> {
    if (blockedControlWrite(node)) return false
    if (isModelRowId(node.id) || node.address?.item.startsWith("model:")) {
      const result = resetModelRow(memoInput(), node.id)
      if ("refusal" in result) {
        setStatus(result.refusal)
        return false
      }
      return persistModels(result.models, result.status, result.retryHint)
    }
    const result = reset(memoInput(), node.id)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    const confirmed = await context.ui.dialog.confirm({
      title: node.enabledRow === undefined ? `Reset "${node.label}"?` : `Reset controls for "${node.label}"?`,
      message: node.enabledRow === undefined
        ? `Reset "${node.label}" to its default? This discards the override and cannot be undone.`
        : "Remove all Settings and Compaction overrides at this level, including retained local compaction values, and follow inherited values?",
    })
    if (!confirmed) {
      setStatus(`Reset of "${node.label}" cancelled`)
      return false
    }
    if (blockedControlWrite(node)) return false
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  // A snapshot update can make an already-open local editor unavailable.
  // Resolve the current row at save/reset/review time, rather than trusting
  // the node captured when the editor opened, and retain every saved value.
  function blockedControlWrite(node: TreeNode): boolean {
    if (node.address?.item !== "compaction:model" && node.address?.item !== "compaction:instructions") return false
    const reason = findRow(memoInput(), node.id)?.badges.disabled
    if (reason === undefined) return false
    setStatus(reason)
    return true
  }

  async function cycleRow(node: TreeNode): Promise<boolean> {
    const current = findRow(memoInput(), node.id)
    const choices = controlChoices(current?.address?.item)
    if (current === undefined || choices === undefined || current.actions?.edit !== true) return false
    const value = resolvedText(current)
    const index = choices.indexOf(value)
    return saveTextRow(current, choices[(index + 1) % choices.length])
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

  // Yellow (review) resolutions via threeWay/resolveResolution. `only` limits
  // them to some parts under review (the state/pin choice before the text's
  // three-way diff).
  async function resolveKeep(node: TreeNode, only?: readonly ReviewPart[]): Promise<boolean> {
    if (blockedControlWrite(node)) return false
    const result = resolveReview(memoInput(), node.id, "keep", undefined, only)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function resolveTake(node: TreeNode, only?: readonly ReviewPart[]): Promise<boolean> {
    if (blockedControlWrite(node)) return false
    const result = resolveReview(memoInput(), node.id, "take", undefined, only)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  // §3.6: the two sides of a state/pin review, and of an active-model review.
  function reviewChoice(node: TreeNode): StateReviewChoice | undefined {
    return stateReviewChoice(memoInput(), node.id)
  }

  function modelReview(node: TreeNode): ModelReviewChoice | undefined {
    return modelReviewChoice(memoInput(), node.id)
  }

  async function resolveModel(node: TreeNode, resolution: "keep" | "take"): Promise<boolean> {
    const result = resolveModelReview(memoInput(), node.id, resolution)
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persistModels(result.models, result.status, result.retryHint)
  }

  async function resolveEdit(node: TreeNode, edited: string): Promise<boolean> {
    if (blockedControlWrite(node)) return false
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
  // skill.delete, user base templates through base.delete, project
  // instruction files through instruction.delete, and model candidates through
  // the model mutate path (remove at this level only). Anything else keeps an
  // honest refusal naming why it cannot be deleted. The route offers d on
  // every item and section row so refusals reach the user as status text;
  // rows without remove actions never delete.
  async function remove(node: TreeNode): Promise<boolean> {
    if (isModelRowId(node.id) || node.address?.item.startsWith("model:")) {
      const result = removeModelRow(memoInput(), node.id)
      if ("refusal" in result) {
        setStatus(result.refusal)
        return false
      }
      const confirmed = await context.ui.dialog.confirm({
        title: `Remove "${node.label}"?`,
        message: `Remove model "${node.label}" at this level? This cannot be undone.`,
      })
      if (confirmed !== true) {
        setStatus(`Delete of "${node.label}" cancelled`)
        return false
      }
      return persistModels(result.models, result.status, result.retryHint)
    }
    if (isPermRowId(node.id) || node.address?.item.startsWith("perm:")) {
      const address = node.address
      const parsed = address === undefined ? undefined : parsePermItemId(address.item)
      if (address === undefined || parsed === undefined) {
        setStatus(`"${node.label}" cannot be deleted`)
        return false
      }
      const current = snapshot()
      const custom = current?.items.find((entry) => entry.id === address.item)?.custom === true
      if (!custom) {
        setStatus(`"${node.label}" cannot be deleted: only user-created rules can be deleted`)
        return false
      }
      const confirmed = await context.ui.dialog.confirm({
        title: `Remove "${node.label}"?`,
        message: `Remove rule "${node.label}"? This cannot be undone.`,
      })
      if (confirmed !== true) {
        setStatus(`Delete of "${node.label}" cancelled`)
        return false
      }
      try {
        await plus["rule.remove"](
          { level: address.level, agent: address.agent, tool: parsed.tool, id: parsed.ruleId },
          { location: context.location },
        )
        if (disposed) return false
        await refresh()
        if (disposed) return false
        setStatus(`Removed "${node.label}"`)
        return true
      } catch (error: unknown) {
        setStatus(errorMessage(error))
        return false
      }
    }
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
      if (plan.kind === "team.delete") {
        await plus["team.delete"]({ level: plan.level, team: plan.team }, { location: context.location })
      } else if (plan.kind === "agent.delete") {
        await plus["agent.delete"]({ scope: plan.scope, id: plan.id }, { location: context.location })
      } else if (plan.kind === "team.removeAgent") {
        await plus["team.removeAgent"](
          { level: plan.level, team: plan.team, id: plan.id },
          { location: context.location },
        )
      } else if (plan.kind === "mcp.remove") {
        await plus["mcp.remove"]({ name: plan.name }, { location: context.location })
      } else if (plan.kind === "skill.delete") {
        await plus["skill.delete"]({ id: plan.id }, { location: context.location })
      } else if (plan.kind === "base.delete") {
        await plus["base.delete"]({ id: plan.id }, { location: context.location })
      } else if (plan.kind === "preset.delete") {
        const refused = await plus["preset.delete"]({ ref: plan.ref }, { location: context.location }).then(
          () => undefined,
          (error: unknown) => error,
        )
        if (refused !== undefined) {
          // Only other projects link to it: they cannot be relinked from here,
          // so the human may delete over them once more, knowingly.
          const elsewhere = onlyElsewhere(refused)
          if (elsewhere === undefined) throw refused
          const forced = await context.ui.dialog.confirm({
            title: `Delete preset ${node.label} anyway?`,
            message: `Other projects link to it: ${elsewhere.join(", ")}. Their links will show as a missing preset until relinked there. Delete anyway?`,
          })
          if (forced !== true) {
            setStatus(`Delete of "${node.label}" cancelled`)
            return false
          }
          await plus["preset.delete"]({ ref: plan.ref, confirm: true }, { location: context.location })
        }
      } else if (plan.kind === "entry.delete") {
        await plus["entry.delete"](
          {
            catalogue: plan.catalogue,
            ...(plan.team === undefined ? {} : { team: plan.team }),
            ...(plan.name === undefined ? {} : { name: plan.name }),
          },
          { location: context.location },
        )
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
      // A preset something links to is refused with the list of who uses it
      // (preset.inUse); that list is what the human needs, so it is toasted.
      if (plan.kind === "preset.delete" || plan.kind === "entry.delete")
        context.ui.toast.show({ variant: "error", message: refusalWithUsers(error) })
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
    setStatus,
    loading,
    toggleExpanded,
    select,
    selectAgent,
    move,
    toggle: toggleRow,
    cycle: cycleRow,
    setEnabled: setEnabledRow,
    setPin: setPinRow,
    togglePin: togglePinRow,
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
    reviewChoice,
    modelReview,
    resolveModel,
    reveal,
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

// The server's message, plus the users a preset.inUse refusal carries when the
// message does not already name them.
// The users of a preset.inUse refusal when every one of them is in another
// project (`data.elsewhere`); undefined when any is here, or for any other error.
function onlyElsewhere(error: unknown): string[] | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) return undefined
  const data = error.data
  if (typeof data !== "object" || data === null || !("users" in data) || !("elsewhere" in data)) return undefined
  if (!Array.isArray(data.users) || !Array.isArray(data.elsewhere)) return undefined
  const users = data.users.filter((user): user is string => typeof user === "string")
  const count = data.elsewhere.reduce(
    (total: number, project: unknown) =>
      total + (typeof project === "object" && project !== null && "users" in project && Array.isArray(project.users) ? project.users.length : 0),
    0,
  )
  return users.length > 0 && count === users.length ? users : undefined
}

function refusalWithUsers(error: unknown): string {
  const message = errorMessage(error)
  if (typeof error !== "object" || error === null || !("data" in error)) return message
  const data = error.data
  if (typeof data !== "object" || data === null || !("users" in data) || !Array.isArray(data.users)) return message
  const users = data.users.filter((user): user is string => typeof user === "string")
  if (users.every((user) => message.includes(user))) return message
  return `${message} (used by ${users.join(", ")})`
}
