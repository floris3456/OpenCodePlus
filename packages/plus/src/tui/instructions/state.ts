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
import { buildTreeMemo, controlChoices, treeOf, withControlItems, type Memo, type MemoInput, type TeamInput, type TreeNode } from "../../instructions/tree.js"
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
import { matchedTree, query } from "../../instructions/query.js"
import { Definition, type Snapshot, type SnapshotRecord } from "../../rpc.js"
import { createSnapshotCache, type SnapshotCache } from "../snapshot-cache.js"

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

export function createInstructionsState(context: Plugin.Context, cache: SnapshotCache = createSnapshotCache()) {
  const plus = context.client.rpc(Definition)
  const directory = context.location?.directory
  const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>(undefined)
  const [filter, setFilter] = createSignal<string>("")
  const [status, setStatus] = createSignal<string>("")
  const [loading, setLoading] = createSignal<boolean>(true)
  let disposed = false
  let generation = 0

  // Opening the screen renders the plugin-level cached snapshot at once, stale
  // or not, and the initial reload below revalidates it in the background. The
  // first ever open (empty cache) behaves as before.
  const cached = cache.peek(directory)
  if (cached !== undefined) setSnapshot(cached.snapshot)

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

  // The filter's rows: matches plus their ancestor chains, materialised from
  // the shared memo's candidate walk. Empty until a filter applies; the
  // workspace list is the unfiltered view.
  let lastMatched: ReadonlySet<string> = new Set()
  const nodes = createMemo<TreeNode[]>(() => {
    const raw = filter().trim()
    if (raw.length === 0) {
      lastMatched = new Set()
      return []
    }
    const memo = treeMemo()
    if (memo === undefined) return []
    const result = matchedTree(memoInput(), raw, memo)
    lastMatched = result.matched
    return [...result.rows]
  })

  // A row a create flow wants selected (reveal): the route switches to its
  // level, opens the rows above it and selects it as soon as a snapshot
  // carries it. Core reloads agents on a debounce, so that can be a later
  // snapshot than the create's own refresh.
  const [revealed, setRevealed] = createSignal<{ readonly expand: readonly string[]; readonly row: string } | undefined>(undefined)

  function reveal(expand: readonly string[], row: string) {
    setRevealed({ expand, row })
  }

  // The rows a create flow asked for, or the current view (treeWith is the
  // workspace's row source).
  function treeWith(open: ReadonlySet<string>): TreeNode[] {
    const memo = treeMemo()
    return memo === undefined ? [] : treeOf(memo, open)
  }

  // Row ids the shared query engine matches (the tool layer's grammar);
  // undefined when the grammar rejects the text.
  function queryIds(where: string): ReadonlySet<string> | undefined {
    const memo = treeMemo()
    if (memo === undefined) return new Set()
    try {
      return new Set(query(memoInput(), { where, fields: ["id"] }, memo).rows.map((row) => row.id))
    } catch {
      return undefined
    }
  }

  async function load() {
    if (disposed) return
    const requestGen = ++generation
    setLoading(true)
    try {
      const fresh = await plus["instructions.snapshot"](undefined, { location: context.location })
      if (disposed || requestGen !== generation) return
      setSnapshot(fresh)
      cache.put(directory, fresh)
      setStatus("")
    } catch (error: unknown) {
      if (disposed || requestGen !== generation) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed && requestGen === generation) setLoading(false)
    }
  }

  async function refresh() {
    if (disposed) return
    const requestGen = ++generation
    setLoading(true)
    try {
      const fresh = await plus["instructions.refresh"](undefined, { location: context.location })
      if (disposed || requestGen !== generation) return
      setSnapshot(fresh)
      cache.put(directory, fresh)
      setStatus("Refreshed from host")
    } catch (error: unknown) {
      if (disposed || requestGen !== generation) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed && requestGen === generation) setLoading(false)
    }
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
      if (disposed) return false
      // The write's own instructions.changed event usually starts a reload
      // before this answer arrives. That newer load owns the snapshot, but
      // the write still succeeded: report it, or an editor never closes.
      const latest = requestGen === generation
      if (result.ok) {
        if (latest) {
          setSnapshot(result.snapshot)
          cache.put(directory, result.snapshot)
        }
        setStatus(successStatus)
        return true
      }
      if (!latest) return false
      setSnapshot(result.snapshot)
      cache.put(directory, result.snapshot)
      setStatus(
        `Revision changed (expected ${current.revision}/${current.globalRevision}, latest ${result.snapshot.revision}/${result.snapshot.globalRevision}); ${retryHint}`,
      )
      return false
    } catch (error: unknown) {
      if (disposed || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && requestGen === generation) setLoading(false)
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

  // One resolution memo per snapshot. Every tree-shaped view and every row op
  // derives from it, so a change or a keypress never rebuilds the resolve
  // context; a new snapshot is a new memo.
  const treeMemo = createMemo<Memo | undefined>(() => (snapshot() === undefined ? undefined : buildTreeMemo(memoInput())))

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
      const result = activateModelRow(memoInput(), node.id, treeMemo())
      if ("refusal" in result) {
        setStatus(result.refusal)
        return false
      }
      return persistModels(result.models, result.status, result.retryHint)
    }
    const result = toggle(memoInput(), node.enabledRow ?? node.id, treeMemo())
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
    const plan = teamPlan(memoInput(), node.id, undefined, treeMemo())
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
      if (disposed || requestGen !== generation) return false
      if (ref.enabled !== plan.enabled) {
        setStatus(`Team "${plan.team}" reported ${ref.enabled ? "enabled" : "disabled"} instead of the requested state`)
        return false
      }
      await refresh()
      if (disposed) return false
      setStatus(ref.disabledTeams.length === 0
        ? plan.successStatus
        : `${plan.successStatus}; disabled ${ref.disabledTeams.map((team) => `${team.level}:${team.team}`).join(", ")}`)
      return true
    } catch (error: unknown) {
      if (disposed || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && requestGen === generation) setLoading(false)
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
      if (disposed || requestGen !== generation) return false
      await refresh()
      if (disposed) return false
      setStatus(`Created team "${ref.team}"`)
      return true
    } catch (error: unknown) {
      if (disposed || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && requestGen === generation) setLoading(false)
    }
  }

  async function setEnabledRow(node: TreeNode, value: boolean): Promise<boolean> {
    const result = setEnabled(memoInput(), node.enabledRow ?? node.id, value, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function setPinRow(node: TreeNode, value: boolean): Promise<boolean> {
    const result = setPin(memoInput(), node.id, value, treeMemo())
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
    const result = saveText(memoInput(), node.id, text, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function resetNode(node: TreeNode): Promise<boolean> {
    if (blockedControlWrite(node)) return false
    if (isModelRowId(node.id) || node.address?.item.startsWith("model:")) {
      const result = resetModelRow(memoInput(), node.id, treeMemo())
      if ("refusal" in result) {
        setStatus(result.refusal)
        return false
      }
      return persistModels(result.models, result.status, result.retryHint)
    }
    const result = reset(memoInput(), node.id, treeMemo())
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
    const reason = findRow(memoInput(), node.id, treeMemo())?.badges.disabled
    if (reason === undefined) return false
    setStatus(reason)
    return true
  }

  async function cycleRow(node: TreeNode): Promise<boolean> {
    const current = findRow(memoInput(), node.id, treeMemo())
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
    const result = saveSplit(memoInput(), node.id, boundaries, treeMemo())
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
    const result = addSection(memoInput(), node.id, name, text, treeMemo())
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
    const result = resolveReview(memoInput(), node.id, "keep", undefined, only, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function resolveTake(node: TreeNode, only?: readonly ReviewPart[]): Promise<boolean> {
    if (blockedControlWrite(node)) return false
    const result = resolveReview(memoInput(), node.id, "take", undefined, only, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  // §3.6: the two sides of a state/pin review, and of an active-model review.
  function reviewChoice(node: TreeNode): StateReviewChoice | undefined {
    return stateReviewChoice(memoInput(), node.id, treeMemo())
  }

  function modelReview(node: TreeNode): ModelReviewChoice | undefined {
    return modelReviewChoice(memoInput(), node.id, treeMemo())
  }

  async function resolveModel(node: TreeNode, resolution: "keep" | "take"): Promise<boolean> {
    const result = resolveModelReview(memoInput(), node.id, resolution, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persistModels(result.models, result.status, result.retryHint)
  }

  async function resolveEdit(node: TreeNode, edited: string): Promise<boolean> {
    if (blockedControlWrite(node)) return false
    const result = resolveReview(memoInput(), node.id, "edit", edited, undefined, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  // t on a clean three-way merge: the same record construction as an edit, but
  // with the `Merged` status because the text was computed, not hand-written.
  async function resolveMerge(node: TreeNode, merged: string): Promise<boolean> {
    if (blockedControlWrite(node)) return false
    const result = resolveReview(memoInput(), node.id, "merge", merged, undefined, treeMemo())
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
      const result = removeModelRow(memoInput(), node.id, treeMemo())
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
    const plan = removalPlan(memoInput(), node.id, treeMemo())
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
        await plus["skill.delete"](
          { id: plan.id, scope: plan.scope, ...(plan.preset === undefined ? {} : { preset: plan.preset }) },
          { location: context.location },
        )
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
  // `instructions.changed` arrives in bursts (one write can emit several, and
  // the host reloads on its own debounce). At most one load runs at a time;
  // any event while it runs schedules exactly one trailing load. The
  // generation guard still decides which answer may write the snapshot.
  let reloadInFlight = false
  let reloadQueued = false
  async function requestReload(): Promise<void> {
    if (reloadInFlight) {
      reloadQueued = true
      return
    }
    reloadInFlight = true
    try {
      await load()
    } finally {
      reloadInFlight = false
      if (reloadQueued && !disposed) {
        reloadQueued = false
        void requestReload()
      }
    }
  }

  void requestReload()
  const unsubscribeInstructions = plus.events.on("instructions.changed", () => {
    void requestReload()
  })
  function dispose() {
    disposed = true
    generation++
    unsubscribeInstructions()
  }

  return {
    snapshot,
    memo: treeMemo,
    nodes,
    matched: (): ReadonlySet<string> => {
      nodes()
      return lastMatched
    },
    filter,
    setFilter,
    status,
    setStatus,
    loading,
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
    resolveMerge,
    reviewChoice,
    modelReview,
    resolveModel,
    reveal,
    revealed,
    treeWith,
    queryIds,
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
