import type { Plugin } from "@opencode/plugin/tui"
import { ruleItem } from "../../instructions/rules.js"
import { modelActivationRefusal, reflectedEndpoint, reflectedRows } from "../../instructions/reflection.js"
import { createMemo, createSignal } from "solid-js"
import { Option, Schema } from "effect"
import { controlItemFor, isControl } from "../../instructions/agent-controls.js"
import { applies, formatDuration, formatWarming, parsePermItemId, parseWarming, resolve, resolveSplit, scopedTo, threeWay } from "../../instructions/model.js"
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
import { deltaOf, keyIdentity, recordIdentity, snapshotRecordOf, type Delta } from "../../instructions/delta.js"
import type { StoredRecord } from "../../instructions/store.js"
import { buildTreeMemo, controlChoices, findLazy, groupToggleRows, lazyPath, tabLayout, treeOf, withControlItems, type Lazy, type Memo, type MemoInput, type TeamInput, type TreeNode } from "../../instructions/tree.js"
import {
  isDefaultSwitchField,
  isEvery,
  isModelDefaultRowId,
  isModelFieldRowId,
  modelDefaultItemId,
  parseColdDefaultItemId,
  parseColdModelItemId,
  parseModelDefaultItemId,
  parseModelFieldItemId,
  parseModelSettingItemId,
  type HostModel,
  type ModelSettingsRecord,
} from "../../instructions/model-settings.js"
import { agentOf, contextOfSnapshot, hostModelOf, itemOf, modelDefaultsViewOf, modelSettingsRecordOf, presetStateOfSnapshot, recordOf, teamOf } from "../../instructions/snapshot.js"
import {
  activateModelRow,
  addColdModelRow,
  addDefaultColdModel,
  addSection,
  coldListForItem,
  defaultColdList,
  findRow,
  removeColdModelRow,
  removeDefaultColdModel,
  setModelCompactionRow,
  isModelRowId,
  isPermRowId,
  modelReviewChoice,
  removalPlan,
  removeModelRow,
  reset,
  resetModelFieldRow,
  resetModelRow,
  resolveModelReview,
  resolveReview,
  saveSplit,
  saveText,
  setEnabled,
  setModelFieldRow,
  setPin,
  setRequires,
  conditionChoices,
  stateReviewChoice,
  teamPlan,
  toggle,
  toggleGroup,
  type ModelReviewChoice,
  type StateReviewChoice,
  planFolderCreate,
  planFolderDelete,
  planFolderRename,
  planLayoutReview,
  planRowMove,
  rowToken,
  type LayoutChange,
  type LayoutRecords,
  type RowTarget,
} from "../../instructions/ops.js"
import { folderIdOfRef } from "../../instructions/folders.js"
import { matchedTree, query } from "../../instructions/query.js"
import { storedRecords } from "../../instructions/resolve-memo.js"
import { advanceMove, startMove, type MoveState, type MoveStep } from "./move.js"
import { Definition, InstructionsBatchOutput, InstructionsClipboardOutput, type Plus, type Snapshot, type SnapshotRecord } from "../../rpc.js"
import { createSnapshotCache, type SnapshotCache } from "../snapshot-cache.js"
import { rowlinkView, sameOwnerView, sameEndpoint, writeRowlink, type RowlinkType, type RowlinkEndpoint, type RowlinkRecord } from "../../instructions/rowlinks.js"
import { markerIn } from "../../instructions/requires.js"

export type { TreeNode }

export function recordsOf(records: readonly SnapshotRecord[]): (CustomizationRecord | SplitRecord | ModelRecord | RuleRecord | RowlinkRecord)[] {
  return records
    .map((record) => {
      const converted = recordOf(record)
      if (record.team !== undefined && converted !== undefined) {
        return { ...converted, team: record.team }
      }
      return converted
    })
    .filter(
      (record): record is CustomizationRecord | SplitRecord | ModelRecord | RuleRecord | RowlinkRecord =>
        record.type === "customization" || record.type === "split" || record.type === "model" || record.type === "rule" || record.type === "rowlink",
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
        ...(record.requires === undefined ? {} : { requires: [...record.requires] }),
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
        ...(record.warming === undefined ? {} : { warming: record.warming }),
        ...(record.interval === undefined ? {} : { interval: record.interval }),
        ...(record.waiting === undefined ? {} : { waiting: record.waiting }),
        ...(record.subagent === undefined ? {} : { subagent: record.subagent }),
        ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
        ...(record.compactWarm === undefined ? {} : { compactWarm: record.compactWarm }),
        ...(record.coldCompact === undefined ? {} : { coldCompact: record.coldCompact }),
        ...(record.coldModels === undefined ? {} : { coldModels: [...record.coldModels] }),
        ...(record.compactionStrategy === undefined ? {} : { compactionStrategy: record.compactionStrategy }),
        ...(record.compactionModel === undefined ? {} : { compactionModel: record.compactionModel }),
        ...(record.compactionInstructions === undefined ? {} : { compactionInstructions: record.compactionInstructions }),
        ...(record.imageConvert === undefined ? {} : { imageConvert: record.imageConvert }),
        ...(record.imageShrink === undefined ? {} : { imageShrink: record.imageShrink }),
        ...(record.imagesFull === undefined ? {} : { imagesFull: record.imagesFull }),
        ...(record.compactionInput === undefined ? {} : { compactionInput: record.compactionInput }),
        ...(record.compactionOutput === undefined ? {} : { compactionOutput: record.compactionOutput }),
        ...(record.removed === undefined ? {} : { removed: record.removed }),
        ...(record.originalCandidate === undefined
          ? {}
          : {
              originalCandidate: {
                ...record.originalCandidate,
                ...(record.originalCandidate.editedFields === undefined ? {} : { editedFields: [...record.originalCandidate.editedFields] }),
              },
            }),
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
  const [selection, setSelection] = createSignal<ReadonlySet<string>>(new Set())
  const [notices, setNotices] = createSignal<readonly { readonly id: string; readonly text: string }[]>([])
  const noticeSince = new Date().toISOString()
  const noticeSeen = new Set<string>()
  const noticeTimers = new Set<ReturnType<typeof setTimeout>>()
  async function readNotices() {
    const result = await plus["instructions.log"]({ where: `since:${noticeSince}`, limit: 100 }, { location: context.location })
    if (disposed) return
    for (const entry of result.entries.toReversed()) {
      // One save can be logged in both stores; its revision differs but its
      // actor, timestamp and change receipt are the same.
      const id = JSON.stringify([entry.ts, entry.actor, entry.op, entry.target, entry.summary])
      if (noticeSeen.has(id)) continue
      noticeSeen.add(id)
      const who = entry.actor.type === "tui" ? "You" : entry.actor.agent ?? entry.actor.type
      setNotices((previous) => [...previous, { id, text: `${who}: ${entry.summary}` }].slice(-4))
      const timer = setTimeout(() => {
        noticeTimers.delete(timer)
        if (!disposed) setNotices((previous) => previous.filter((notice) => notice.id !== id))
      }, 4500)
      noticeTimers.add(timer)
    }
    while (noticeSeen.size > 200) noticeSeen.delete(noticeSeen.values().next().value!)
  }
  const [clipboard, setClipboard] = createSignal<{ readonly id: string; readonly mode: "copy" | "cut"; readonly rows: readonly string[] }>()

  async function clipboardOperation(action: "copy" | "cut" | "paste", node: TreeNode): Promise<boolean> {
    await awaitDrain()
    const previous = clipboard()
    try {
      const result = await plus["instructions.run"]({ op: "clipboard", actor: { type: "tui" }, input: {
        action,
        ...(previous === undefined ? {} : { clipboard: previous.id }),
        ...(action === "paste" ? { into: node.id } : { ids: selectionContains(node) ? [...selection()] : [node.id] }),
      } }, { location: context.location })
      const decoded = Schema.decodeUnknownOption(Schema.Union([InstructionsClipboardOutput, Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })]))(result)
      if (disposed) {
        if (Option.isSome(decoded) && !("error" in decoded.value) && decoded.value.clipboard !== undefined)
          await plus["instructions.run"]({ op: "clipboard", input: { action: "clear", clipboard: decoded.value.clipboard }, actor: { type: "tui" } }, { location: context.location })
        return false
      }
      if (Option.isNone(decoded)) { setStatus("Unexpected clipboard response"); return false }
      if ("error" in decoded.value) { setStatus(decoded.value.error.message); return false }
      if (action === "paste") {
        if (decoded.value.consumed) { setClipboard(undefined); setSelection(new Set<string>()) }
        await refresh()
        const row = decoded.value.rows.at(-1)
        const memo = treeMemo()
        if (row !== undefined && memo !== undefined) reveal(lazyPath(memo, row).slice(0, -1).map((entry) => entry.id), row)
      }
      if (decoded.value.clipboard !== undefined && decoded.value.mode !== undefined)
        setClipboard({ id: decoded.value.clipboard, mode: decoded.value.mode, rows: decoded.value.rows })
      setStatus(decoded.value.status)
      return true
    } catch (error) {
      setStatus(errorMessage(error))
      return false
    }
  }

  function cancelClipboard(): boolean {
    const current = clipboard()
    if (current === undefined) return false
    setClipboard(undefined)
    void plus["instructions.run"]({ op: "clipboard", input: { action: "clear", clipboard: current.id }, actor: { type: "tui" } }, { location: context.location }).catch((error) => setStatus(errorMessage(error)))
    setStatus("Cut cancelled")
    return true
  }

  function reflect<Args extends readonly unknown[]>(operation: (node: TreeNode, ...args: Args) => Promise<boolean>, label: string) {
    return async (node: TreeNode, ...args: Args): Promise<boolean> => {
      const memo = treeMemo()
      if (memo === undefined || selection().size === 0) return operation(node, ...args)
      const rows = reflectedRows(memo, node.id, [...selection()])
      if (rows.targets.length === 1 && rows.skipped.length === 0) return operation(rows.targets[0]!, ...args)
      const failed: string[] = []
      const applied: string[] = []
      for (const target of rows.targets) {
        if (await operation(target, ...args)) applied.push(target.id)
        else failed.push(`${target.label}: ${status()}`)
      }
      setStatus(`${label}: ${applied.length} applied${rows.skipped.length === 0 ? "" : `, ${rows.skipped.length} without this setting`}${failed.length === 0 ? "" : `; ${failed.join("; ")}`}`)
      return applied.length > 0 && failed.length === 0
    }
  }

  async function confirmSelection(node: TreeNode, label: string, operation: (node: TreeNode, approved?: boolean) => Promise<boolean>): Promise<boolean> {
    const memo = treeMemo()
    const targets = memo === undefined ? [] : reflectedRows(memo, node.id, [...selection()]).targets
    if (targets.length <= 1) return operation(node)
    const approved = await context.ui.dialog.confirm({ title: `${label} ${targets.length} rows?`, message: `${label} the corresponding rows in the selection? Their existing data will be changed.` })
    if (!approved) return false
    return reflect(operation, label)(node, true)
  }

  function selectionContains(node: TreeNode): boolean {
    const memo = treeMemo()
    return memo !== undefined && selection().size > 0 && lazyPath(memo, node.id).some((row) => selection().has(row.id))
  }

  async function batchOperation(node: TreeNode, op: "set" | "reset" | "split" | "create" | "delete" | "move" | "link", input: Record<string, unknown>): Promise<boolean> {
    await awaitDrain()
    try {
      const result = await plus["instructions.run"]({ op: "batch", input: { op, id: node.id, selected: [...selection()], input }, actor: { type: "tui" } }, { location: context.location })
      const decoded = Schema.decodeUnknownOption(Schema.Union([InstructionsBatchOutput, Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })]))(result)
      if (Option.isNone(decoded)) { setStatus("Unexpected batch response"); return false }
      if ("error" in decoded.value) { setStatus(decoded.value.error.message); return false }
      await refresh()
      setStatus(`${decoded.value.applied.length} applied, ${decoded.value.skipped.length} without this setting${decoded.value.failed.length === 0 ? "" : `; ${decoded.value.failed.map((failure) => `${failure.id}: ${failure.reason}`).join("; ")}`}`)
      return decoded.value.applied.length > 0 && decoded.value.failed.length === 0
    } catch (error) {
      setStatus(errorMessage(error))
      return false
    }
  }
  // The S1b pick-up move draft: while set, the tree renders this layout instead
  // of the snapshot's. One write on drop, none on cancel.
  const [move, setMove] = createSignal<MoveState | undefined>(undefined)
  let disposed = false
  let generation = 0

  let confirmedRecords: StoredRecord[] = []
  // Store revisions this screen's own writes produced, with when: their
  // instructions.changed events need no reload. A host change re-emits the same
  // revisions later (nothing was written since), so the match expires.
  const ownWrites = new Map<string, number>()
  let lastOpStatus = ""
  let localVersion = 0
  let draining = false

  interface PendingEdit {
    readonly version: number
    readonly resolve: (ok: boolean) => void
  }
  const pendingEdits: PendingEdit[] = []
  const drainWaiters: (() => void)[] = []

  function notifyDrainWaiters() {
    const waiters = drainWaiters.splice(0)
    for (const w of waiters) w()
  }

  function resolvePending(maxVersion: number, ok: boolean) {
    for (let i = pendingEdits.length - 1; i >= 0; i--) {
      const edit = pendingEdits[i]
      if (edit !== undefined && edit.version <= maxVersion) {
        edit.resolve(ok)
        pendingEdits.splice(i, 1)
      }
    }
  }

  function applyDeltaToRecords(current: readonly StoredRecord[], delta: Delta): StoredRecord[] {
    const removals = new Set(delta.remove.map(keyIdentity))
    const added = new Set(delta.upsert.map(recordIdentity))
    return [
      ...current.filter((r) => !removals.has(recordIdentity(r)) && !added.has(recordIdentity(r))),
      ...delta.upsert,
    ]
  }

  function optimisticStoredRecords(): StoredRecord[] {
    const cur = snapshot()
    return cur === undefined ? [] : recordsOf(cur.records)
  }

  async function awaitDrain(): Promise<void> {
    while (
      draining ||
      deltaOf(confirmedRecords, optimisticStoredRecords()).upsert.length +
        deltaOf(confirmedRecords, optimisticStoredRecords()).remove.length >
        0
    ) {
      if (!draining) void scheduleDrain()
      await new Promise<void>((resolve) => drainWaiters.push(resolve))
    }
  }

  // Opening the screen renders the plugin-level cached snapshot at once, stale
  // or not, and the initial reload below revalidates it in the background. The
  // first ever open (empty cache) behaves as before.
  const cached = cache.peek(directory)
  if (cached !== undefined) {
    setSnapshot(cached.snapshot)
    confirmedRecords = recordsOf(cached.snapshot.records)
  }

  // Presets and Defaults entries get the Role/persona row every agent has.
  // An optimistic edit replaces the records and keeps the items array, so the
  // converted items (with control and role rows) are reused unless the items or
  // the preset state (links, entries, presets: records) changed.
  let itemsReuse: { readonly items: Snapshot["items"]; readonly presets: string; readonly value: Item[] } | undefined
  const itemsForTree = createMemo<Item[]>(() => {
    const current = snapshot()
    if (!current) return []
    const presetState = presetStateOfSnapshot(current)
    const presets = JSON.stringify(presetState)
    if (itemsReuse !== undefined && itemsReuse.items === current.items && itemsReuse.presets === presets) return itemsReuse.value
    const value = withOwnerRoles(withControlItems(current.items.map(itemOf)), presetState)
    itemsReuse = { items: current.items, presets, value }
    return value
  })

  const recordsForTree = createMemo<(CustomizationRecord | SplitRecord | ModelRecord | RuleRecord | RowlinkRecord)[]>(() => {
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

  const modelSettingsForTree = createMemo<ModelSettingsRecord[]>(() => {
    const current = snapshot()
    if (!current) return []
    return (current.modelSettings ?? []).map(modelSettingsRecordOf)
  })

  const hostModelsForTree = createMemo<HostModel[]>(() => {
    const current = snapshot()
    if (!current) return []
    return (current.hostModels ?? []).map(hostModelOf)
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
      // Edits still queued (not yet confirmed) stay on screen: they are laid
      // over the fresh records, row by row, as the server will apply them.
      const pending = deltaOf(confirmedRecords, optimisticStoredRecords())
      const freshStored = recordsOf(fresh.records)
      cache.put(directory, fresh)
      confirmedRecords = freshStored
      if (pending.upsert.length + pending.remove.length === 0) {
        setSnapshot(fresh)
        setStatus("")
        return
      }
      const rebased = applyDeltaToRecords(freshStored, pending)
      setSnapshot({
        ...fresh,
        records: rebased.map(snapshotRecordOf).filter((record): record is SnapshotRecord => record !== undefined),
      })
      void scheduleDrain()
    } catch (error: unknown) {
      if (disposed || requestGen !== generation) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed && requestGen === generation) setLoading(false)
    }
  }

  async function refresh() {
    if (disposed) return
    await awaitDrain()
    const requestGen = ++generation
    setLoading(true)
    try {
      const fresh = await plus["instructions.refresh"](undefined, { location: context.location })
      if (disposed || requestGen !== generation) return
      setSnapshot(fresh)
      cache.put(directory, fresh)
      confirmedRecords = recordsOf(fresh.records)
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
    const item = matches.find((entry) => owner === null || applies(entry, owner)) ?? matches[0]
    const memo = treeMemo()
    return item === undefined || memo === undefined ? item : ruleItem(item, memo.ctx.rules, memo.ctx.scopes, address)
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

  // The editable text is the effective span (B39 rule 4): a whole heading item
  // shows its sections applied, as the read pane does. Sections have no
  // difference between text and fullText.
  function resolvedText(node: TreeNode): string {
    const chain = chainFor(node)
    if (!chain) return ""
    const scopesValue = scopes()
    const resolved = resolve({
      upstream: chain.upstream,
      records: chain.customizations,
      splits: chain.splits,
      scopes: scopesValue,
      address: chain.address,
    })
    return resolved.fullText ?? resolved.text
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

  async function scheduleDrain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (true) {
        const optimistic = optimisticStoredRecords()
        const delta = deltaOf(confirmedRecords, optimistic)
        const count = delta.upsert.length + delta.remove.length
        if (count === 0) {
          resolvePending(localVersion, true)
          if (!disposed && lastOpStatus !== "") {
            setStatus(lastOpStatus)
          }
          break
        }

        const dispatchVersion = localVersion
        const wantSnapshot = dispatchVersion === localVersion

        if (!disposed) {
          setStatus(`Saving ${count} change(s)…`)
        }

        const payload: Plus.MutateInputDelta = {
          actor: { type: "tui" },
          changes: {
            upsert: delta.upsert.map(snapshotRecordOf).filter((r): r is SnapshotRecord => r !== undefined),
            remove: delta.remove,
          },
          ...(wantSnapshot ? { snapshot: true } : {}),
        }

        const touchedIdentities = new Set([
          ...delta.upsert.map(recordIdentity),
          ...delta.remove.map(keyIdentity),
        ])
        const confirmedMap = new Map(confirmedRecords.map((r) => [recordIdentity(r), r]))

        let result: Plus.MutateResult | undefined
        let errorThrown: unknown = undefined
        try {
          result = await plus["instructions.mutate"](payload, { location: context.location })
        } catch (err: unknown) {
          errorThrown = err
        }

        if (errorThrown === undefined && result !== undefined && result.ok === true) {
          confirmedRecords = applyDeltaToRecords(confirmedRecords, delta)
          ownWrites.set(`${result.revision}/${result.globalRevision}`, Date.now())

          if (wantSnapshot && result.snapshot !== undefined) {
            if (localVersion === dispatchVersion) {
              if (!disposed) {
                setSnapshot(result.snapshot)
                cache.put(directory, result.snapshot)
              }
              confirmedRecords = recordsOf(result.snapshot.records)
            }
          }

          resolvePending(dispatchVersion, true)

          if (localVersion === dispatchVersion) {
            if (!disposed) {
              setStatus(lastOpStatus)
            }
            break
          }
        } else {
          const cur = snapshot()
          const currentOptimistic = optimisticStoredRecords()
          const currentMap = new Map(currentOptimistic.map((r) => [recordIdentity(r), r]))
          for (const id of touchedIdentities) {
            currentMap.delete(id)
            const confirmedRow = confirmedMap.get(id)
            if (confirmedRow !== undefined) {
              currentMap.set(id, confirmedRow)
            }
          }
          const revertedStored = Array.from(currentMap.values())
          if (cur) {
            const nextRecords = revertedStored.map(snapshotRecordOf).filter((r): r is SnapshotRecord => r !== undefined)
            setSnapshot({ ...cur, records: nextRecords })
          }

          if (result && !result.ok && "reason" in result && result.reason === "stale" && "snapshot" in result && result.snapshot) {
            if (!disposed) {
              setSnapshot(result.snapshot)
              cache.put(directory, result.snapshot)
            }
            confirmedRecords = recordsOf(result.snapshot.records)
          }

          const msg = errorThrown !== undefined
            ? errorMessage(errorThrown)
            : (result && !result.ok && "error" in result && typeof result.error === "object" && result.error !== null && "message" in result.error
                ? String(result.error.message)
                : result && !result.ok && "reason" in result
                  ? `Revision changed (expected ${cur?.revision}/${cur?.globalRevision}, latest ${result.snapshot.revision}/${result.snapshot.globalRevision}); retry`
                  : "Write did not complete")

          if (!disposed) {
            setStatus(msg)
          }

          resolvePending(dispatchVersion, false)

          const remainingDelta = deltaOf(confirmedRecords, optimisticStoredRecords())
          if (remainingDelta.upsert.length + remainingDelta.remove.length === 0) {
            break
          }
        }
      }
    } finally {
      draining = false
      notifyDrainWaiters()
    }
  }

  async function persist(
    nextCustomizations: readonly CustomizationRecord[],
    nextSplits: readonly (SplitRecord & { updated?: string })[],
    successStatus: string,
    retryHint: string,
    nextModels?: readonly ModelRecord[],
    nextRules?: readonly RuleRecord[],
    nextRowlinks?: readonly RowlinkRecord[],
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

    const links = nextRowlinks === undefined ? current.records.filter((record) => record.type === "rowlink") : nextRowlinks.map(snapshotRecordOf).filter((record): record is SnapshotRecord => record !== undefined)
    // Saved as the tree reads them: no edit equal to what its row inherits (inherited.ts).
    const stored = storedRecords(memoInput(), [...nextCustomizations, ...nextSplits, ...preservedRules]).filter(
      (record): record is CustomizationRecord => record.type === "customization",
    )
    const nextSnapshotRecords = [...toRpcRecords(stored, nextSplits, preserved, preservedRules), ...links]
    setSnapshot({ ...current, records: nextSnapshotRecords })

    lastOpStatus = successStatus
    localVersion++
    const version = localVersion
    const editPromise = new Promise<boolean>((resolve) => {
      pendingEdits.push({ version, resolve })
    })
    void scheduleDrain()
    return editPromise
  }

  function memoInput(): MemoInput {
    const movement = move()
    const draft = movement?.layout
    return {
      items: itemsForTree(),
      records: movement?.section === undefined ? recordsForTree() : [
        ...movement.section.records,
        ...movement.section.splits,
        ...recordsForTree().filter((record) => record.type === "model" || record.type === "rule"),
      ],
      agents: agentsForTree(),
      teams: teamsForTree(),
      modelSettings: modelSettingsForTree(),
      hostModels: hostModelsForTree(),
      folders: draft?.folders ?? snapshot()?.folders ?? [],
      orders: draft?.orders ?? snapshot()?.orders ?? [],
      ...presetStateForTree(),
    }
  }

  // One resolution memo per snapshot. Every tree-shaped view and every row op
  // derives from it, so a change or a keypress never rebuilds the resolve
  // context; a new snapshot is a new memo.
  const treeMemo = createMemo<Memo | undefined>(() => (snapshot() === undefined ? undefined : buildTreeMemo(memoInput())))

  async function persistModels(models: readonly ModelRecord[], successStatus: string, retryHint: string, switched?: readonly CustomizationRecord[]): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const converted = recordsOf(current.records)
    const customizations = converted.filter((record): record is CustomizationRecord => record.type === "customization")
    const splits = converted.filter((record): record is SplitRecord => record.type === "split")
    return persist(switched === undefined ? customizations : [...switched], splits, successStatus, retryHint, models)
  }

  async function toggleRow(node: TreeNode): Promise<boolean> {
    if (node.kind === "team" && node.enabledRow === undefined) return toggleTeamRow(node)
    if (node.kind === "group") return toggleGroupRow(node)
    if (isModelRowId(node.id) || node.address?.item.startsWith("model:")) {
      const result = activateModelRow(memoInput(), node.id, treeMemo())
      if ("refusal" in result) {
        setStatus(result.refusal)
        return false
      }
      return result.records === undefined
        ? persistModels(result.models, result.status, result.retryHint)
        : persist(result.records, recordsForTree().filter((record): record is SplitRecord => record.type === "split"), result.status, result.retryHint, result.models)
    }
    const result = toggle(memoInput(), node.enabledRow ?? node.id, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint, result.models)
  }

  async function toggleSelected(node: TreeNode): Promise<boolean> {
    if (isModelRowId(node.id) || node.address?.item.startsWith("model:")) {
      const memo = treeMemo()
      const refusal = memo === undefined ? undefined : modelActivationRefusal(reflectedRows(memo, node.id, [...selection()]).targets)
      if (refusal !== undefined) { setStatus(refusal); return false }
      return reflect(toggleRow, "Activated")(node)
    }
    const enabled = node.badges.state !== "on"
    return reflect(async (target) => {
      if (target.kind === "group" || target.kind === "team" && target.enabledRow === undefined)
        return target.badges.state === (enabled ? "on" : "off") || await toggleRow(target)
      return setEnabledRow(target, enabled)
    }, enabled ? "Enabled" : "Disabled")(node)
  }

  // A group row turns its nearest toggleable rows on or off in one write
  // (ops.toggleGroup): all on means all off, otherwise all on. Team groups
  // toggle all their teams through team.setEnabled and the write queue.
  async function toggleGroupRow(node: TreeNode): Promise<boolean> {
    const memo = treeMemo()
    const lazy = memo === undefined ? undefined : findLazy(memo, node.id)
    const found = lazy === undefined ? undefined : groupToggleRows(lazy)
    if (found?.hasTeam) {
      return toggleTeamsGroup(node, found.rows)
    }
    const result = toggleGroup(memoInput(), node.id, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint, result.models)
  }

  async function toggleTeamsGroup(node: TreeNode, rows: readonly Lazy[]): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const teamRows = rows.flatMap((leaf) => {
      const match = leaf.id.match(/^team:(project|global):(.+)$/)
      if (!match) return []
      return [{
        level: match[1] as "project" | "global",
        team: match[2],
        enabled: leaf.partial().state === "on",
      }]
    })
    if (teamRows.length === 0) {
      setStatus(`"${node.label}" has no toggleable teams`)
      return false
    }
    // Only one team can be on at a time (enabling one disables the others), so
    // a Teams group can only turn them all off.
    if (!teamRows.some((t) => t.enabled)) {
      setStatus("Only one team can be on at a time: press space on a team to switch it on")
      return false
    }
    const targetState = false

    const nextTeams = (current.teams ?? []).map((t) => {
      const matched = teamRows.find((tr) => tr.level === t.level && tr.team === t.team)
      return matched ? { ...t, enabled: targetState } : t
    })
    setSnapshot({ ...current, teams: nextTeams })

    await awaitDrain()

    const requestGen = ++generation
    setLoading(true)
    try {
      for (const t of teamRows) {
        await plus["team.setEnabled"](
          { level: t.level, team: t.team, enabled: targetState },
          { location: context.location },
        )
      }
      if (disposed || requestGen !== generation) return false
      await refresh()
      if (disposed) return false
      setStatus(targetState ? `Enabled ${teamRows.length} team(s)` : `Disabled ${teamRows.length} team(s)`)
      return true
    } catch (error: unknown) {
      if (disposed || requestGen !== generation) return false
      setStatus(errorMessage(error))
      await refresh()
      return false
    } finally {
      if (!disposed && requestGen === generation) setLoading(false)
    }
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
    await awaitDrain()
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
    await awaitDrain()
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

  // Folders and display order (S1a): each change is planned by ops.ts from the
  // snapshot it was read on, then written as one layout write. Refresh re-reads
  // the snapshot the way a server event would, so every view updates from it.
  async function layoutAction(change: LayoutChange): Promise<boolean> {
    if ("refusal" in change) {
      setStatus(change.refusal)
      return false
    }
    const revision = snapshot()?.globalRevision ?? 0
    const projectRevision = snapshot()?.revision ?? 0
    await awaitDrain()
    const requestGen = ++generation
    setLoading(true)
    try {
      await plus["layout.write"](
        {
          folders: [...change.layout.folders],
          orders: [...change.layout.orders],
          expectedGlobalRevision: revision,
          expectedProjectRevision: projectRevision,
          target: change.target,
          status: change.status,
        },
        { location: context.location },
      )
      if (disposed || requestGen !== generation) return false
      await refresh()
      if (disposed) return false
      setStatus(change.status)
      return true
    } catch (error: unknown) {
      if (disposed || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && requestGen === generation) setLoading(false)
    }
  }

  function layoutNow(): LayoutRecords {
    return { folders: snapshot()?.folders ?? [], orders: snapshot()?.orders ?? [] }
  }

  function createFolder(node: TreeNode, name: string): Promise<boolean> {
    return layoutAction(planFolderCreate(memoInput(), layoutNow(), node.id, name, new Date().toISOString()))
  }

  function moveRow(node: TreeNode, target: RowTarget): Promise<boolean> {
    return layoutAction(planRowMove(memoInput(), layoutNow(), node.id, target, new Date().toISOString()))
  }

  // ---- pick-up move mode (S1b) ----

  function beginMove(node: TreeNode): boolean {
    if (move() !== undefined) return false
    const started = startMove(node, layoutNow())
    if ("refusal" in started) {
      setStatus(started.refusal)
      return false
    }
    setMove(started.state)
    return true
  }

  // One arrow press. Returns the tree ids to open (the folder entered), so the
  // moved row stays visible.
  function stepMove(step: MoveStep): readonly string[] {
    const current = move()
    if (current === undefined) return []
    const advanced = advanceMove(memoInput(), current, step, treeMemo())
    if ("refusal" in advanced) {
      setStatus(advanced.refusal)
      return []
    }
    setMove(advanced.state)
    return advanced.expand
  }

  async function commitMove(): Promise<boolean> {
    const current = move()
    if (current === undefined) return false
    if (current.isSection && current.section === undefined) {
      setMove(undefined)
      return true
    }
    const ok = current.section === undefined
      ? await layoutAction({ target: current.target, status: current.status, layout: current.layout })
      : await persist(current.section.records, current.section.splits, current.status, current.section.retryHint)
    // On failure the store still holds the old order, so the preview goes too.
    if (move() === current) setMove(undefined)
    return ok
  }

  function cancelMove(): boolean {
    const had = move() !== undefined
    setMove(undefined)
    return had
  }

  function renameFolder(node: TreeNode, to: string): Promise<boolean> {
    const id = folderIdOfRef(rowToken(node) ?? "")
    if (id === undefined) {
      setStatus(`"${node.label}" is not a folder`)
      return Promise.resolve(false)
    }
    const owner = node.id.split(":folder:")[0]!
    return layoutAction(planFolderRename(layoutNow(), id, to, new Date().toISOString(), owner, inheritedLayout(owner)))
  }

  function deleteFolder(node: TreeNode): Promise<boolean> {
    const id = folderIdOfRef(rowToken(node) ?? "")
    if (id === undefined) {
      setStatus(`"${node.label}" is not a folder`)
      return Promise.resolve(false)
    }
    const owner = node.id.split(":folder:")[0]!
    return layoutAction(planFolderDelete(layoutNow(), id, new Date().toISOString(), owner, inheritedLayout(owner)))
  }

  // The tab a tab's layout comes from when it has none of its own (tree.ts tabLayout).
  function inheritedLayout(tabId: string): string | undefined {
    const memo = treeMemo()
    return memo === undefined ? undefined : tabLayout(memo, tabId).inherited
  }

  // A tab whose own layout is to review: keep it, or take what it inherits.
  function resolveLayout(node: TreeNode, resolution: "keep" | "take"): Promise<boolean> {
    return layoutAction(planLayoutReview(memoInput(), layoutNow(), node.id, resolution, new Date().toISOString(), treeMemo()))
  }

  // T6: rename a renamable row through the same RPC path the palette and the
  // tools use. Agents and team members both go through agent.rename (a member
  // names its team); teams through team.rename. Returns the renamed row's new
  // tree id; the caller reveals it.
  //
  // The write emits a store-change event, whose reload bumps the generation
  // while the RPC is in flight. The id is still valid, so the return is not
  // gated on the generation: only an explicit refresh is skipped when another
  // reload already owns the snapshot.
  async function renameRow(
    input:
      | { readonly kind: "agent"; readonly level: "project" | "global"; readonly from: string; readonly to: string }
      | { readonly kind: "member"; readonly level: "project" | "global"; readonly team: string; readonly from: string; readonly to: string }
      | { readonly kind: "team"; readonly level: "project" | "global"; readonly from: string; readonly to: string },
  ): Promise<string | undefined> {
    await awaitDrain()
    const requestGen = ++generation
    setLoading(true)
    try {
      if (input.kind === "team") {
        const result = await plus["team.rename"]({ level: input.level, from: input.from, to: input.to }, { location: context.location })
        if (disposed) return undefined
        const row = `team:${input.level}:${result.to}`
        if (requestGen === generation) await refresh()
        if (disposed) return undefined
        setStatus(`Renamed team ${input.from} to ${result.to}`)
        return row
      }
      const result =
        input.kind === "member"
          ? await plus["agent.rename"]({ scope: input.level, team: input.team, from: input.from, to: input.to }, { location: context.location })
          : await plus["agent.rename"]({ scope: input.level, from: input.from, to: input.to }, { location: context.location })
      if (disposed) return undefined
      const row = input.kind === "member" ? `team:${input.level}:${input.team}:${result.to}` : `agent:${input.level}:${result.to}`
      if (requestGen === generation) await refresh()
      if (disposed) return undefined
      setStatus(input.kind === "member" ? `Renamed member ${input.from} to ${result.to}` : `Renamed agent ${input.from} to ${result.to}`)
      return row
    } catch (error: unknown) {
      if (disposed) return undefined
      setStatus(errorMessage(error))
      return undefined
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

  // "Shown when": the rows this system row or section is sent under (null
  // drops this level's condition; [] sends it always).
  async function setRequiresRow(node: TreeNode, ids: readonly string[] | null): Promise<boolean> {
    const result = setRequires(memoInput(), node.id, ids, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persist(result.records, result.splits, result.status, result.retryHint)
  }

  async function saveTextRow(node: TreeNode, text: string): Promise<boolean> {
    if (blockedControlWrite(node)) return false
    const result = saveText(memoInput(), node.id, text, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    const saved = await persist(result.records, result.splits, result.status, result.retryHint)
    if (result.notice !== undefined) context.ui.toast.show({ variant: "warning", message: result.notice })
    return saved
  }

  async function resetNode(node: TreeNode, approved = false): Promise<boolean> {
    if (isModelDefaultRowId(node.id)) return editModelSettings(node, { warming: null, interval: null, waiting: null, subagent: null, prompt: null, effort: null })
    const setting = node.address === undefined ? undefined : parseModelSettingItemId(node.address.item)
    if (setting !== undefined) {
      // The cold-cache group's reset drops this level's switch and list.
      if (setting.field === "coldCompact") return editModelSettings(node, { coldCompact: null, coldModels: null })
      return editModelSettings(node, { [setting.field]: null })
    }
    if (isModelFieldRowId(node.id)) {
      const result = resetModelFieldRow(memoInput(), node.id, treeMemo())
      if ("refusal" in result) {
        setStatus(result.refusal)
        return false
      }
      return persistModels(result.models, result.status, result.retryHint)
    }
    // The compaction switch rows: the cold-cache group and the coldCompact
    // field carry no `modelfield:` row id on a switch, so clear the field here.
    const switchItem = node.address?.item
    if (switchItem !== undefined && parseColdModelItemId(switchItem) !== undefined) return setModelCompaction(node, { coldModels: null })
    if (switchItem !== undefined && node.id.endsWith(":cold"))
      return setModelCompaction(node, { coldCompact: null, coldModels: null })
    if (switchItem !== undefined && switchItem.includes("modelfield:compactWarm:")) return setModelCompaction(node, { compactWarm: null })
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
    const confirmed = approved || await context.ui.dialog.confirm({
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
    return persist(result.records, result.splits, result.status, result.retryHint, undefined, undefined, result.rowlinks)
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
    return reflect(saveTextRow, "Updated")(current, choices[(index + 1) % choices.length])
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

  // Enter on a model field row under an agent/member/preset: set that one
  // field at the row's level. Inherited rows plant a local record; empty text
  // clears the field.
  async function editModelField(node: TreeNode, text: string): Promise<boolean> {
    const result = setModelFieldRow(memoInput(), node.id, text, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persistModels(result.models, result.status, result.retryHint, result.records)
  }

  // One compaction field on an agent/member/preset model row: set at this
  // level (null clears it so the level below decides), one write.
  async function setModelCompaction(
    node: TreeNode,
    fields: { compactWarm?: string | null; coldCompact?: string | null; coldModels?: readonly string[] | null; compactionStrategy?: string | null; compactionModel?: string | null; compactionInstructions?: string | null; compactionInput?: string | null; compactionOutput?: string | null; imageConvert?: string | null; imageShrink?: string | null; imagesFull?: string | null },
  ): Promise<boolean> {
    const result = setModelCompactionRow(memoInput(), node.id, fields, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persistModels(result.models, result.status, result.retryHint)
  }

  /** What a Defaults › Models row resolves to now, for the inspector and its edit dialog. */
  function modelDefaultsView(node: TreeNode) {
    const current = snapshot()
    return current === undefined ? undefined : modelDefaultsViewOf(current, node.address?.item)
  }

  // A Defaults › Models row or one of its field rows: set or clear fields
  // through modelSettings.set. The rows are server-owned (a separate snapshot
  // field), so this is its own call, not the inventory mutate.
  async function editModelSettings(
    node: TreeNode,
    fields: {
      warming?: string | null
      interval?: string | null
      waiting?: string | null
      subagent?: string | null
      prompt?: string | null
      effort?: string | null
      compactWarm?: string | null
      coldCompact?: string | null
      coldModels?: readonly string[] | null
      compactionStrategy?: string | null
      compactionModel?: string | null
      compactionInstructions?: string | null
      imageConvert?: string | null
      imageShrink?: string | null
      imagesFull?: string | null
      compactionInput?: string | null
      compactionOutput?: string | null
    },
  ): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const item = node.address?.item
    const key = item === undefined ? undefined : (parseModelDefaultItemId(item) ?? parseModelSettingItemId(item)?.key ?? parseColdDefaultItemId(item)?.key)
    if (key === undefined) {
      setStatus(`"${node.label}" is not a Defaults › Models row`)
      return false
    }
    const label = isEvery(key) ? "Every model" : `${key.providerID}/${key.modelID}`
    await awaitDrain()
    const requestGen = ++generation
    setLoading(true)
    try {
      const result = await plus["modelSettings.set"]({ ...key, ...fields }, { location: context.location })
      if (disposed || requestGen !== generation) return false
      setSnapshot(await plus["instructions.snapshot"](undefined, { location: context.location }))
      if (disposed) return false
      const rounded = roundedNote(fields.warming, result.record?.warming, modelDefaultsViewOf(snapshot()!, modelDefaultItemId(key))?.interval.value)
      setStatus(`${defaultsStatus(label, result.record)}${rounded}`)
      return true
    } catch (error: unknown) {
      if (disposed || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && requestGen === generation) setLoading(false)
    }
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
  async function remove(node: TreeNode, approved = false): Promise<boolean> {
    await awaitDrain()
    if (isModelDefaultRowId(node.id)) {
      if (node.actions?.remove !== true) {
        setStatus(`"${node.label}" has no Defaults › Models values to clear`)
        return false
      }
      const confirmed = approved || await context.ui.dialog.confirm({
        title: `Clear "${node.label}"?`,
        message: `Clear the Defaults › Models values for "${node.label}"? Warming then follows the level below it again.`,
      })
      if (confirmed !== true) {
        setStatus(`Delete of "${node.label}" cancelled`)
        return false
      }
      return editModelSettings(node, { warming: null, interval: null, waiting: null, subagent: null, prompt: null, effort: null })
    }
    if (isModelRowId(node.id) || node.address?.item.startsWith("model:")) {
      const result = removeModelRow(memoInput(), node.id, treeMemo())
      if ("refusal" in result) {
        setStatus(result.refusal)
        return false
      }
      const confirmed = approved || await context.ui.dialog.confirm({
        title: `Remove "${node.label}"?`,
        message: `Remove model "${node.label}" at this level? A local candidate is deleted; an inherited or upstream one is hidden here, and re-adding the model clears that.`,
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
      const custom = current?.records.some((record) => record.type === "rule" && record.tool === parsed.tool && record.id === parsed.ruleId && scopedTo(record, address))
      if (!custom) {
        setStatus(`"${node.label}" cannot be deleted: only user-created rules can be deleted`)
        return false
      }
      const confirmed = approved || await context.ui.dialog.confirm({
        title: `Remove "${node.label}"?`,
        message: `Remove rule "${node.label}"? This cannot be undone.`,
      })
      if (confirmed !== true) {
        setStatus(`Delete of "${node.label}" cancelled`)
        return false
      }
      try {
        await plus["rule.remove"](
           { level: address.level, agent: address.agent, ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }), ...(address.team === undefined ? {} : { team: address.team }), tool: parsed.tool, id: parsed.ruleId },
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
    const confirmed = approved || await context.ui.dialog.confirm({
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
      } else if (plan.kind === "system.delete") {
        await plus["system.delete"]({ id: plan.id }, { location: context.location })
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
  const unsubscribeInstructions = plus.events.on("instructions.changed", (event?: unknown) => {
    void readNotices().catch((error) => { if (!disposed) setStatus(errorMessage(error)) })
    const payload = (event && typeof event === "object" && "data" in event ? event.data : event) as
      | Plus.InstructionsChanged
      | undefined
    const now = Date.now()
    for (const [key, at] of ownWrites) if (now - at > 5000) ownWrites.delete(key)
    if (payload !== undefined && ownWrites.has(`${payload.revision}/${payload.globalRevision}`)) return
    void requestReload()
  })
  function dispose() {
    if (clipboard() !== undefined) cancelClipboard()
    disposed = true
    unsubscribeInstructions()
    for (const timer of noticeTimers) clearTimeout(timer)
  }

  // Space on a compaction switch: the field row (`Compact before cold`) or the
  // cold-cache group. Agent rows write the model inventory; Defaults field
  // rows write through modelSettings.set.
  async function toggleModelSwitch(node: TreeNode): Promise<boolean> {
    const item = node.address?.item
    if (item === undefined) {
      setStatus(`"${node.label}" cannot be toggled`)
      return false
    }
    const setting = parseModelSettingItemId(item)
    const value = (node.badges.value ?? "").toLowerCase().startsWith("on") ? "off" : "on"
    if (setting !== undefined && isDefaultSwitchField(setting.field)) {
      return reflect(editModelSettings, "Model switch")(node, { [setting.field]: value } as never)
    }
    const field = parseModelFieldItemId(item)?.field
    if (field !== "compactWarm" && field !== "coldCompact") { setStatus(`"${node.label}" is not a model switch`); return false }
    return reflect(setModelCompaction, "Model switch")(node, { [field]: value })
  }

  // The strategy a Defaults compaction field cycles from: the first word of the
  // row's shown value (Auto / Local / Remote).
  function modelCompactionView(node: TreeNode): string | undefined {
    const value = node.badges.value
    if (value === undefined) return undefined
    const word = value.split(" ")[0]
    return word === undefined ? undefined : word.toLowerCase()
  }

  // a on a cold-cache list: append through the catalogue picker. The route
  // picks the model and calls this with it.
  async function addColdModel(node: TreeNode, model: string): Promise<boolean> {
    const item = node.address?.item
    if (item !== undefined && isDefaultColdNode(item)) {
      const edit = addDefaultColdModel(memoInput(), node.id, model, treeMemo())
      if ("refusal" in edit) {
        setStatus(edit.refusal)
        return false
      }
      return editModelSettings(node, { coldModels: edit.coldModels } as never)
    }
    const result = addColdModelRow(memoInput(), node.id, model, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persistModels(result.models, result.status, result.retryHint)
  }

  // d on a cold-cache list row.
  async function removeColdModel(node: TreeNode): Promise<boolean> {
    const item = node.address?.item
    if (item !== undefined && isDefaultColdNode(item)) {
      const edit = removeDefaultColdModel(memoInput(), node.id, treeMemo())
      if ("refusal" in edit) {
        setStatus(edit.refusal)
        return false
      }
      return editModelSettings(node, { coldModels: edit.coldModels } as never)
    }
    const result = removeColdModelRow(memoInput(), node.id, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persistModels(result.models, result.status, result.retryHint)
  }

  // m picks a list row up; ↑/↓ move it in a draft; Enter drops (one write);
  // Esc restores (no write). The draft is keyed by the row id and the list.
  const [coldMove, setColdMove] = createSignal<{ readonly rowId: string; readonly models: readonly string[]; readonly index: number }>()
  function beginColdMove(node: TreeNode): boolean {
    const item = node.address?.item
    if (item === undefined) return false
    const defaults = parseColdDefaultItemId(item)
    if (defaults !== undefined) {
      setColdMove({ rowId: node.id, models: defaultColdList(memoInput(), defaults.key), index: defaults.index })
      return true
    }
    const agent = parseColdModelItemId(item)
    const memo = treeMemo()
    const address = node.address
    const found = agent === undefined || address === undefined || memo === undefined ? undefined : coldListForItem(memoInput(), address, memo.ctx.scopes)
    if (agent === undefined || found === undefined) {
      setStatus(`"${node.label}" is not a cold-cache list row`)
      return false
    }
    setColdMove({ rowId: node.id, models: found, index: agent.index })
    return true
  }
  function moveColdDraft(delta: -1 | 1): boolean {
    const move = coldMove()
    if (move === undefined) return false
    const to = move.index + delta
    if (to < 0 || to >= move.models.length) return false
    const models = [...move.models]
    const [moved] = models.splice(move.index, 1)
    if (moved === undefined) return false
    models.splice(to, 0, moved)
    setColdMove({ ...move, models, index: to })
    return true
  }
  async function commitColdMove(): Promise<boolean> {
    const move = coldMove()
    if (move === undefined) return false
    setColdMove(undefined)
    const node = findRow(memoInput(), move.rowId, treeMemo())
    if (node === undefined) {
      setStatus("That row is gone")
      return false
    }
    const item = node.address?.item
    if (item !== undefined && parseColdDefaultItemId(item) !== undefined) return editModelSettings(node, { coldModels: move.models } as never)
    const result = setModelCompactionRow(memoInput(), node.id, { coldModels: move.models }, treeMemo())
    if ("refusal" in result) {
      setStatus(result.refusal)
      return false
    }
    return persistModels(result.models, result.status, result.retryHint)
  }
  function cancelColdMove(): boolean {
    const had = coldMove() !== undefined
    setColdMove(undefined)
    return had
  }

  const [linkPrimary, setLinkPrimary] = createSignal<TreeNode>()
  function beginRowlink(node: TreeNode): boolean {
    if (node.address === undefined) {
      setStatus("This row cannot be linked")
      return false
    }
    setLinkPrimary(node)
    setStatus(`Link from "${node.label}": navigate to another row and press L; Esc cancels`)
    return true
  }
  function linksFor(node: TreeNode) {
    const memo = treeMemo()
    const chain = chainFor(node)
    if (node.address === undefined || memo === undefined) return []
    // Inspect the source span, not assembled/fullText (which strips markers).
    const marker = chain === undefined ? [] : markerIn(resolve({ ...chain, records: chain.customizations, scopes: memo.ctx.scopes }).text) ?? []
    return rowlinkView(memo.ctx.scopes.rowlinks ?? [], memo.ctx.scopes, node.address, node.address, marker)
  }
  async function saveRowlink(primary: Pick<TreeNode, "address" | "label">, target: RowlinkEndpoint, link: RowlinkType, enabled = true): Promise<boolean> {
    const current = snapshot()
    const address = primary.address
    if (current === undefined || address === undefined) return false
    if (sameEndpoint(address, target.item, target.section)) {
      setStatus("A row cannot link to itself")
      return false
    }
    const converted = recordsOf(current.records)
    const links = writeRowlink(converted.filter((record) => record.type === "rowlink"), address, address, target, link, enabled, now())
    setSnapshot({ ...current, records: [...current.records.filter((record) => record.type !== "rowlink"), ...links.map(snapshotRecordOf).filter((record): record is SnapshotRecord => record !== undefined)] })
    lastOpStatus = enabled ? `Linked "${primary.label}" (${link})` : `Disabled link from "${primary.label}"`
    localVersion++
    const version = localVersion
    const edit = new Promise<boolean>((resolve) => pendingEdits.push({ version, resolve }))
    void scheduleDrain()
    return edit
  }

  function reflectRowlink(node: TreeNode, primary: Pick<TreeNode, "address" | "label">, target: RowlinkEndpoint, operation: (primary: Pick<TreeNode, "address" | "label">, target: RowlinkEndpoint) => Promise<boolean>): Promise<boolean> {
    const memo = treeMemo()
    if (memo === undefined || !selectionContains(node)) return operation(primary, target)
    const selected = [...selection()]
    return reflect(async (row) => {
      if (primary.address === undefined || row.address === undefined) { setStatus("This row cannot own a link"); return false }
      const from = reflectedEndpoint(memo, node.id, row.id, selected, primary.address)
      const to = reflectedEndpoint(memo, node.id, row.id, selected, target)
      if (from === undefined || to === undefined) { setStatus("Does not have the corresponding link endpoint"); return false }
      return operation({ address: { ...row.address, ...from }, label: from.item }, to)
    }, "Row link")(node)
  }
  async function deleteRowlink(primary: Pick<TreeNode, "address" | "label">, target: RowlinkEndpoint): Promise<boolean> {
    const current = snapshot()
    const address = primary.address
    if (current === undefined || address === undefined) return false
    const records = current.records.filter((record) => !(record.type === "rowlink" && scopedTo(record, address)
      && sameEndpoint(address, record.item, record.section) && sameEndpoint(target, record.target, record.targetSection)))
    if (records.length === current.records.length) {
      setStatus("Inherited links can be disabled with Space; delete them at their source level")
      return false
    }
    setSnapshot({ ...current, records })
    lastOpStatus = `Deleted link from "${primary.label}"`
    localVersion++
    const version = localVersion
    const edit = new Promise<boolean>((resolve) => pendingEdits.push({ version, resolve }))
    void scheduleDrain()
    return edit
  }
  function rowlinkTarget(node: TreeNode): boolean {
    const primary = linkPrimary()
    if (primary?.address === undefined || node.address === undefined || !sameOwnerView(primary.address, node.address) || sameEndpoint(primary.address, node.address.item, node.address.section)) {
      setStatus("Link endpoints must be different rows in the same owner and level")
      return false
    }
    return true
  }
  function cancelRowlink() { setLinkPrimary(undefined) }

  return {
    selection,
    effectiveItem: (node: TreeNode) => node.address === undefined ? undefined : upstreamFor(itemsForTree(), node.address),
    notices,
    clipboard,
    isCut: (node: TreeNode) => {
      const pending = clipboard()
      const memo = treeMemo()
      return pending?.mode === "cut" && memo !== undefined && lazyPath(memo, node.id).some((row) => pending.rows.includes(row.id))
    },
    clipboardOperation,
    cancelClipboard,
    setSelection,
    reflect,
    selectionContains,
    batchOperation,
    linkPrimary,
    beginRowlink,
    linksFor,
    saveRowlink,
    saveSelectedRowlink: (node: TreeNode, primary: Pick<TreeNode, "address" | "label">, target: RowlinkEndpoint, link: RowlinkType, enabled = true) => reflectRowlink(node, primary, target, (from, to) => saveRowlink(from, to, link, enabled)),
    deleteSelectedRowlink: (node: TreeNode, primary: Pick<TreeNode, "address" | "label">, target: RowlinkEndpoint) => reflectRowlink(node, primary, target, deleteRowlink),
    deleteRowlink,
    rowlinkTarget,
    cancelRowlink,
    snapshot,
    move,
    beginMove,
    stepMove,
    commitMove,
    cancelMove,
    coldMove,
    toggleModelSwitch,
    modelCompactionView,
    addColdModel: reflect(addColdModel, "Added fallback model"),
    removeColdModel: reflect(removeColdModel, "Removed fallback model"),
    beginColdMove,
    moveColdDraft,
    commitColdMove,
    cancelColdMove,
    memo: treeMemo,
    pathOf: (id: string) => {
      const result = matchedTree(memoInput(), `id:${id}`, treeMemo())
      const index = result.rows.findIndex((row) => row.id === id)
      if (index < 0) return []
      const chain: TreeNode[] = [result.rows[index]!]
      for (let at = index - 1; at >= 0; at--) {
        const row = result.rows[at]!
        if (row.depth < chain[0]!.depth) chain.unshift(row)
      }
      return chain
    },
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
    toggle: toggleSelected,
    cycle: cycleRow,
    setEnabled: reflect(setEnabledRow, "Enabled state"),
    setPin: reflect(setPinRow, "Pinned state"),
    togglePin: (node: TreeNode) => reflect(setPinRow, "Pinned state")(node, node.badges.pinned !== true),
    setRequires: reflect(setRequiresRow, "Condition"),
    conditionChoices: () => {
      const memo = treeMemo()
      return memo === undefined ? [] : conditionChoices(memo)
    },
    saveText: reflect(saveTextRow, "Description"),
    reset: (node: TreeNode) => confirmSelection(node, "Reset", resetNode),
    saveSplit: reflect(saveSplitRow, "Split"),
    addSection: reflect(addSectionRow, "Added section"),
    createTeam,
    createFolder: reflect(createFolder, "Created category"),
    moveRow,
    renameFolder: reflect(renameFolder, "Renamed category"),
    renameRow,
    deleteFolder: reflect(deleteFolder, "Deleted category"),
    splitPreview,
    resolvedText,
    threeWay: threeWayFor,
    resolveKeep: reflect(resolveKeep, "Kept overrides"),
    resolveTake: reflect(resolveTake, "Accepted upstream"),
    resolveEdit: reflect(resolveEdit, "Resolved review"),
    resolveMerge: reflect(resolveMerge, "Merged review"),
    reviewChoice,
    modelReview,
    resolveModel,
    resolveLayout,
    editModelField: reflect(editModelField, "Model setting"),
    editModelSettings: reflect(editModelSettings, "Model setting"),
    setModelCompaction: reflect(setModelCompaction, "Compaction setting"),
    modelDefaultsView,
    reveal,
    revealed,
    treeWith,
    queryIds,
    remove: (node: TreeNode) => confirmSelection(node, "Delete", remove),
    refresh,
    dispose,
  }
}

export type InstructionsState = ReturnType<typeof createInstructionsState>

function now(): string {
  return new Date().toISOString()
}

// The server rounds a warming time up to whole pings; say so when it did.
function roundedNote(typed: string | null | undefined, stored: string | undefined, interval: number | undefined): string {
  if (typed === undefined || typed === null || stored === undefined) return ""
  const parsed = parseWarming(typed)
  if ("error" in parsed || formatWarming(parsed) === stored) return ""
  return ` (${formatWarming(parsed)} rounds up to ${stored}: whole ${interval === undefined ? "" : `${formatDuration(interval)} `}pings)`
}

// Whether a row's item id belongs to a Defaults › Models cold-cache list: the
// group's switch item or one of its numbered list rows.
function isDefaultColdNode(item: string): boolean {
  if (parseColdDefaultItemId(item) !== undefined) return true
  return parseModelSettingItemId(item)?.field === "coldCompact"
}

function defaultsStatus(label: string, record: Plus.SnapshotModelSettingsRecord | null): string {
  if (record === null) return `Defaults › Models "${label}" inherits`
  const set = [
    ...(record.warming === undefined ? [] : [`warming ${record.warming}`]),
    ...(record.interval === undefined ? [] : [`every ${record.interval}`]),
    ...(record.waiting === undefined ? [] : [`waiting ${record.waiting}`]),
    ...(record.subagent === undefined ? [] : [`subagent ${record.subagent}`]),
    ...(record.prompt === undefined ? [] : ["a prompt"]),
    ...(record.effort === undefined ? [] : [`effort ${record.effort}`]),
  ]
  return `Defaults › Models "${label}": ${set.join(", ")}`
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
