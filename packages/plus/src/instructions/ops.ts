import { fromLabel } from "./from-label.js"
import { booleanControl, controlIds, controlItemFor, isControl } from "./agent-controls.js"
import {
  acknowledgeActiveModel,
  addModelRecord,
  applies,
  catalogueField,
  catalogueOf,
  clearModelActive,
  ensureActivateModel,
  fingerprint,
  hasModelRecordAt,
  merge,
  modelKey,
  ownAndAbove,
  parseModelItemId,
  removeModelRecord,
  resolve,
  resolveActiveModel,
  resolveResolution,
  resolveSplit,
  scopedTo,
} from "./model.js"
import type {
  Address,
  Catalogue,
  CustomizationRecord,
  Item,
  Level,
  ModelRecord,
  PresetRef,
  RecordScope,
  ReviewPart,
  RuleRecord,
  SplitRecord,
  TeamRef,
} from "./model.js"
import { buildMemo } from "./resolve-memo.js"
import type { Memo } from "./resolve-memo.js"
import { collectSkeleton, findLazy, materialize, skeletonOf } from "./tree.js"
import type { MemoInput, TeamInput, TreeNode } from "./tree.js"
import { manual, slice } from "./sections.js"
import type { Split } from "./sections.js"

export interface OpSuccess {
  readonly records: CustomizationRecord[]
  readonly splits: SplitRecord[]
  readonly models?: readonly ModelRecord[]
  readonly status: string
  readonly retryHint: string
}

export interface OpFailure {
  readonly refusal: string
}

export type OpResult = OpSuccess | OpFailure

export interface ModelOpSuccess {
  readonly models: ModelRecord[]
  readonly status: string
  readonly retryHint: string
}

export type ModelOpResult = ModelOpSuccess | OpFailure

export type RemovalPlan =
  | OpFailure
  | {
      readonly kind: "agent.delete"
      readonly scope: "project" | "global"
      readonly id: string
      readonly confirmTitle: string
      readonly confirmMessage: string
      readonly successStatus: string
    }
  | {
      readonly kind: "mcp.remove"
      readonly name: string
      readonly confirmTitle: string
      readonly confirmMessage: string
      readonly successStatus: string
    }
  | {
      readonly kind: "skill.delete"
      readonly id: string
      readonly confirmTitle: string
      readonly confirmMessage: string
      readonly successStatus: string
    }
  | {
      readonly kind: "base.delete"
      readonly id: string
      readonly confirmTitle: string
      readonly confirmMessage: string
      readonly successStatus: string
    }
  | {
      readonly kind: "instruction.delete"
      readonly name: string
      readonly confirmTitle: string
      readonly confirmMessage: string
      readonly successStatus: string
    }
  | {
      readonly kind: "team.removeAgent"
      readonly level: "project" | "global" | "defaults"
      readonly team: string
      readonly id: string
      readonly confirmTitle: string
      readonly confirmMessage: string
      readonly successStatus: string
    }
  | {
      readonly kind: "team.delete"
      readonly level: "project" | "global"
      readonly team: string
      readonly memberCount: number
      readonly enabled: boolean
      readonly confirmTitle: string
      readonly confirmMessage: string
      readonly successStatus: string
    }
  | {
      // A user preset; the server refuses it while anything links to it.
      readonly kind: "preset.delete"
      readonly ref: PresetRef
      readonly confirmTitle: string
      readonly confirmMessage: string
      readonly successStatus: string
    }
  | {
      // A Defaults entry; a Teams team pattern row (no `name`) deletes every
      // member entry of the pattern.
      readonly kind: "entry.delete"
      readonly catalogue: Catalogue
      readonly team?: string
      readonly name?: string
      readonly confirmTitle: string
      readonly confirmMessage: string
      readonly successStatus: string
    }

export type TeamPlan =
  | OpFailure
  | {
      readonly kind: "team.setEnabled"
      readonly level: "project" | "global" | "defaults"
      readonly team: string
      readonly enabled: boolean
      readonly successStatus: string
    }

export function unknownRowRefusal(rowId: string): string {
  return `Unknown row "${rowId}"`
}

export function editRefusalForLabel(label: string): string {
  return `"${label}" cannot be edited`
}

export function resolveRefusalForLabel(label: string): string {
  return `"${label}" cannot be resolved`
}

function memoOfInput(input: MemoInput): Memo {
  return buildMemo(input as unknown as Parameters<typeof buildMemo>[0])
}

function findNode(input: MemoInput, rowId: string): { memo: Memo; node: TreeNode } | undefined {
  const memo = memoOfInput(input)
  const lazy = findLazy(memo, rowId)
  if (lazy === undefined) {
    const node = controlRow(memo, rowId)
    return node === undefined ? undefined : { memo, node }
  }
  return { memo, node: materialize(lazy) }
}

// Control rows can be addressed by the Tool before a client expands their
// category. Keep the existing item id grammar, including member owner paths.
function controlRow(memo: Memo, id: string): TreeNode | undefined {
  const match = /^item:(project|global|defaults|preset):(.*):((?:setting|compaction):[^:]+)$/.exec(id)
  if (match === null || !isControl(match[3])) return undefined
  const level = match[1] as Level
  const owner = match[2]
  const item = match[3]
  const member = /^(.*?)\/:(special:)?([^:]+)$/.exec(owner)
  const shared = owner === "" || owner === "/teams"
  const parent = shared ? undefined : findLazy(memo, member === null ? `agent:${level}:${owner}` : `team:${level}:${member[1]}:${member[2] ?? ""}${member[3]}`)
  if (shared ? level !== "defaults" : parent === undefined) return undefined
  const team = member === null ? undefined : { level, team: member[1] }
  const address: Address = {
    level, agent: shared ? null : member?.[3] ?? owner, item, section: null,
    ...(team === undefined ? {} : level === "preset" || member?.[2] !== undefined || parent?.owner?.entry !== undefined ? { team } : { memberOf: team }),
    ...(member !== null || owner === "/teams" ? { catalogue: "teams" as const } : {}),
  }
  const upstream = controlItemFor(memo.ctx.items, address)
  if (upstream === undefined) return undefined
  const resolved = resolve({ upstream, address, records: memo.ctx.customizations, splits: [], scopes: memo.ctx.scopes })
  return {
    id, kind: "item", label: upstream.title, depth: (parent?.depth ?? 2) + 2, address,
    badges: { state: resolved.enabled ? "on" : "off", modified: resolved.modified, review: resolved.review, from: resolved.from, textFrom: resolved.textFrom },
    actions: { toggle: booleanControl(item), edit: !booleanControl(item), reset: resolved.overriddenHere, remove: false, split: false, pin: false },
  }
}

function entityControlId(node: TreeNode, item: string): string | undefined {
  if (node.kind === "agent") return node.id.replace(/^agent:/, "item:") + `:${item}`
  const special = node.kind === "team" && node.depth === 4 ? /^team:(project|global|defaults):(.+):special:([^:]+)$/.exec(node.id) : null
  if (special !== null) return `item:${special[1]}:${special[2]}/:special:${special[3]}:${item}`
  if (node.kind !== "team" || node.depth !== 3) return undefined
  const owner = node.owner
  if (owner?.team !== undefined && owner.agent !== null) return `item:${owner.level}:${owner.team.team}/:${owner.agent}:${item}`
  const suffix = `:${node.label}`
  if (!node.id.endsWith(suffix)) return undefined
  return node.id.slice(0, -suffix.length).replace(/^team:/, "item:") + `/:${node.label}:${item}`
}

export function setAgentMode(input: MemoInput, rowId: string, mode: "primary" | "subagent" | "all"): OpResult {
  const node = findRow(input, rowId)
  const id = node === undefined ? undefined : entityControlId(node, "setting:mode")
  return id === undefined ? { refusal: `"${rowId}" is not an agent or member` } : saveText(input, id, mode)
}

/** One row by id, found by descending the lazy tree (no full expansion). */
export function findRow(input: MemoInput, rowId: string): TreeNode | undefined {
  return findNode(input, rowId)?.node
}

// ---------------------------------------------------------------------------
// Created-row resolution
//
// create returns the row id the TUI shows for the record it just wrote, so
// show, set and delete accept it without a row.unknown detour. Every id below
// is read from that same tree: entity rows are looked up by their documented
// id form and returned only when the tree holds them, so a create whose row
// is missing resolves undefined and the caller fails instead of inventing
// one. `item` names the created thing inside its row kind: the `<itemId>` of
// an item row, or the agent/team/member/entry/preset id of an entity row.

export interface CreatedRow {
  readonly id: string
  readonly item: string
}

export interface CreatedItemAddress {
  readonly level: Level
  readonly agent: string | null
  readonly item: string
  readonly catalogue?: Catalogue
}

// Only the root of the written level is walked: the row lives under it, and
// the other roots (the Presets root above all) never need resolving here.
export function createdItemRow(input: MemoInput, address: CreatedItemAddress): CreatedRow | undefined {
  const memo = memoOfInput(input)
  const lazy = collectSkeleton(skeletonOf(memo).filter((root) => root.id === `root:${address.level}`)).find(
    (candidate) =>
      candidate.address !== undefined &&
      candidate.address.level === address.level &&
      candidate.address.agent === address.agent &&
      candidate.address.item === address.item &&
      candidate.address.section === null &&
      catalogueOf(candidate.address.catalogue) === catalogueOf(address.catalogue),
  )
  if (lazy?.address === undefined) return undefined
  return { id: lazy.id, item: lazy.address.item }
}

export function createdAgentRow(input: MemoInput, scope: "project" | "global", id: string): CreatedRow | undefined {
  return createdEntityRow(input, `agent:${scope}:${id}`, "agent", id)
}

export function createdTeamRow(input: MemoInput, level: Level, team: string): CreatedRow | undefined {
  return createdEntityRow(input, `team:${level}:${team}`, "team", team)
}

export function createdMemberRow(input: MemoInput, level: Level, team: string, member: string): CreatedRow | undefined {
  return createdEntityRow(input, `team:${level}:${team}:${member}`, "team", member)
}

/** A Defaults entry row: `agent:defaults:<name>`, or `team:defaults:<pattern>:<name>` for a Teams entry. */
export function createdEntryRow(input: MemoInput, entry: { catalogue: Catalogue; team?: string; name: string }): CreatedRow | undefined {
  if (entry.catalogue === "agents") return createdEntityRow(input, `agent:defaults:${entry.name}`, "agent", entry.name)
  return createdEntityRow(input, `team:defaults:${entry.team ?? "*"}:${entry.name}`, "team", entry.name)
}

/** A preset row: `agent:preset:<id>`, `team:preset:<team>:<member>` or `team:preset:<team>`. */
export function createdPresetRow(input: MemoInput, ref: PresetRef): CreatedRow | undefined {
  if (ref.kind === "agent") return createdEntityRow(input, `agent:preset:${ref.id}`, "agent", ref.id)
  if (ref.kind === "member") return createdEntityRow(input, `team:preset:${ref.team}:${ref.id}`, "team", ref.id)
  return createdEntityRow(input, `team:preset:${ref.id}`, "team", ref.id)
}

function createdEntityRow(input: MemoInput, rowId: string, kind: "agent" | "team", item: string): CreatedRow | undefined {
  const lazy = findLazy(memoOfInput(input), rowId)
  if (lazy === undefined || lazy.kind !== kind) return undefined
  return { id: lazy.id, item }
}

// ---------------------------------------------------------------------------
// Team and member row entities
//
// Team (`team:<level>:<team>`, depth 2) and member (`team:<level>:<team>:<member>`,
// depth 3) rows carry no item address, so show renders the entity these rows
// stand for instead of a resolved text. The team is found the same way
// removalPlan resolves it: by the row's own id, so colon team names pick the
// real team rather than an id prefix, and a member row belongs to the team
// that lists it.

export type TeamRowEntity =
  | {
      readonly kind: "team"
      readonly level: Level
      readonly team: string
      readonly enabled: boolean
      readonly members: readonly string[]
      readonly overlay?: readonly string[]
    }
  | {
      readonly kind: "member"
      readonly level: Level
      readonly team: string
      readonly member: string
      readonly registered: boolean
    }

export function teamRowEntity(input: MemoInput, node: TreeNode): TeamRowEntity | undefined {
  if (node.kind !== "team") return undefined
  const memo = memoOfInput(input)
  const teams = (input.teams ?? memo.ctx.teams) as readonly TeamInput[]
  const exact = teams.find((candidate) => node.id === `team:${candidate.level}:${candidate.team}`)
  if (exact !== undefined && node.depth === 2)
    return {
      kind: "team",
      level: exact.level,
      team: exact.team,
      enabled: exact.enabled,
      members: [...exact.agents],
      ...(exact.overlay === undefined ? {} : { overlay: [...exact.overlay] }),
    }
  if (node.depth !== 3) return undefined
  const parent = teams.find((candidate) =>
    candidate.agents.some((member) => node.id === `team:${candidate.level}:${candidate.team}:${member}`),
  )
  if (parent === undefined) return undefined
  return {
    kind: "member",
    level: parent.level,
    team: parent.team,
    member: node.label,
    registered: memo.ctx.agents.some((agent) => agent.id === node.label),
  }
}

function upstreamFor(items: readonly Item[], address: Address): Item | undefined {
  if (isControl(address.item)) return controlItemFor(items, address)
  const matches = items.filter((entry) => entry.id === address.item)
  const owner = address.agent
  if (owner === null) return matches[0]
  return matches.find((entry) => applies(entry, owner)) ?? matches[0]
}

function chainFor(
  memo: Memo,
  node: TreeNode,
):
  | { address: Address; upstream: Item; customizations: CustomizationRecord[]; splits: SplitRecord[] }
  | undefined {
  const address = node.address
  if (!address) return undefined
  const found = upstreamFor(memo.ctx.items, address)
  if (!found) return undefined
  return {
    address,
    upstream: found,
    customizations: [...memo.ctx.customizations],
    splits: [...memo.ctx.splits],
  }
}

function resolvedTextOf(memo: Memo, chain: { address: Address; upstream: Item; customizations: CustomizationRecord[]; splits: SplitRecord[] }): string {
  return resolve({
    upstream: chain.upstream,
    records: chain.customizations,
    splits: chain.splits,
    scopes: memo.ctx.scopes,
    address: chain.address,
  }).text
}

function toggleRefusal(node: TreeNode): string | undefined {
  if (node.kind === "team") return `"${node.label}" cannot be toggled`
  if (node.address === undefined) return `"${node.label}" cannot be toggled`
  if (node.actions?.toggle !== true) {
    if (node.badges.unsupported === true && node.badges.unexcludable === true)
      return `"${node.label}" cannot be excluded and remains in effect`
    return `"${node.label}" cannot be toggled`
  }
  return undefined
}

function editRefusal(node: TreeNode): string | undefined {
  if (node.address === undefined) return editRefusalForLabel(node.label)
  if (node.actions?.edit !== true) {
    return editRefusalForLabel(node.label)
  }
  return undefined
}

function pinRefusal(node: TreeNode, item: Item | undefined): string | undefined {
  if (item?.execute === true) return `"${node.label}" is host-owned: toggle only`
  const pinnable = node.address?.section === null && item?.kind === "tool" && item.codemode === true
  if (!pinnable) return `"${node.label}" is not a Code Mode tool and cannot be pinned`
  if (node.actions?.pin !== true) return `"${node.label}" is not a Code Mode tool and cannot be pinned`
  return undefined
}

function sameAddress(
  record: {
    level: Address["level"]
    agent: string | null
    item: string
    section: string | null
    team?: Address["team"]
    catalogue?: Address["catalogue"]
  },
  address: Address,
): boolean {
  return record.item === address.item && record.section === address.section && scopedTo(record, address)
}

function customizationsEqualWithoutUpdated(left: CustomizationRecord, right: CustomizationRecord): boolean {
  return (
    left.level === right.level &&
    left.agent === right.agent &&
    catalogueOf(left.catalogue) === catalogueOf(right.catalogue) &&
    left.item === right.item &&
    left.section === right.section &&
    left.text === right.text &&
    left.state === right.state &&
    left.pin === right.pin &&
    left.basedOn === right.basedOn &&
    left.basedOnText === right.basedOnText &&
    left.acknowledged === right.acknowledged &&
    left.basedOnState === right.basedOnState &&
    left.basedOnPin === right.basedOnPin
  )
}

function boundariesEqual(
  left: readonly { id: string; name: string; start: number }[],
  right: readonly { id: string; name: string; start: number }[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    return other !== undefined && entry.id === other.id && entry.name === other.name && entry.start === other.start
  })
}

export function toggle(input: MemoInput, rowId: string): OpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const control = entityControlId(node, "setting:enabled")
  if (control !== undefined) return toggle(input, control)
  const memo = found.memo
  const refusal = toggleRefusal(node)
  if (refusal !== undefined) return { refusal }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  const resolved = resolve({
    upstream: chain.upstream,
    records: chain.customizations,
    splits: chain.splits,
    scopes: memo.ctx.scopes,
    address: chain.address,
  })
  // The chain context makes merge record what the chain above resolves
  // (`basedOnState`), so a later change above raises review (§3.6).
  const next = merge(
    chain.customizations,
    chain.address,
    { state: resolved.enabled ? "off" : "on" },
    chain.upstream,
    memo.ctx.scopes,
  )
  return {
    records: next,
    splits: chain.splits,
    status: resolved.enabled ? `Disabled "${node.label}"` : `Enabled "${node.label}"`,
    retryHint: `toggled "${node.label}" against a stale revision; retry to apply`,
  }
}

export function setEnabled(input: MemoInput, rowId: string, value: boolean): OpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const control = entityControlId(node, "setting:enabled")
  if (control !== undefined) return setEnabled(input, control, value)
  const memo = found.memo
  const refusal = toggleRefusal(node)
  if (refusal !== undefined) return { refusal }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  const next = merge(chain.customizations, chain.address, { state: value ? "on" : "off" }, chain.upstream, memo.ctx.scopes)
  const existing = chain.customizations.find((record) => sameAddress(record, chain.address))
  const created = next.find((record) => sameAddress(record, chain.address))
  if (existing !== undefined && created !== undefined && customizationsEqualWithoutUpdated(existing, created))
    return {
      records: chain.customizations,
      splits: chain.splits,
      status: value ? `Enabled "${node.label}"` : `Disabled "${node.label}"`,
      retryHint: `toggled "${node.label}" against a stale revision; retry to apply`,
    }
  return {
    records: next,
    splits: chain.splits,
    status: value ? `Enabled "${node.label}"` : `Disabled "${node.label}"`,
    retryHint: `toggled "${node.label}" against a stale revision; retry to apply`,
  }
}

export function setPin(input: MemoInput, rowId: string, value: boolean): OpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const address = node.address
  const item = address === undefined ? undefined : upstreamFor(memo.ctx.items, address)
  const refusal = pinRefusal(node, item)
  if (refusal !== undefined) return { refusal }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  const next = merge(chain.customizations, chain.address, { pin: value }, chain.upstream, memo.ctx.scopes)
  const existing = chain.customizations.find((record) => sameAddress(record, chain.address))
  const created = next.find((record) => sameAddress(record, chain.address))
  if (existing !== undefined && created !== undefined && customizationsEqualWithoutUpdated(existing, created))
    return {
      records: chain.customizations,
      splits: chain.splits,
      status: value ? `Pinned "${node.label}"` : `Unpinned "${node.label}"`,
      retryHint: `pinned "${node.label}" against a stale revision; retry to apply`,
    }
  return {
    records: next,
    splits: chain.splits,
    status: value ? `Pinned "${node.label}"` : `Unpinned "${node.label}"`,
    retryHint: `pinned "${node.label}" against a stale revision; retry to apply`,
  }
}

export function saveText(input: MemoInput, rowId: string, text: string): OpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const refusal = editRefusal(node)
  if (refusal !== undefined) return { refusal }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  // The chain context and splits make the baseline the text above this row
  // (a preset's or a default's), not the raw upstream: an agent whose preset
  // supplies the text is not "to review" the moment it saves its own.
  const next = merge(chain.customizations, chain.address, { text }, chain.upstream, memo.ctx.scopes, chain.splits)
  const existing = chain.customizations.find((record) => sameAddress(record, chain.address))
  const created = next.find((record) => sameAddress(record, chain.address))
  if (existing !== undefined && created !== undefined && customizationsEqualWithoutUpdated(existing, created))
    return {
      records: chain.customizations,
      splits: chain.splits,
      status: `Saved "${node.label}"`,
      retryHint: `saved "${node.label}" against a stale revision; retry to apply`,
    }
  return {
    records: next,
    splits: chain.splits,
    status: `Saved "${node.label}"`,
    retryHint: `saved "${node.label}" against a stale revision; retry to apply`,
  }
}

export function reset(input: MemoInput, rowId: string): OpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const control = entityControlId(node, "setting:enabled")
  if (control !== undefined) {
    const address = controlRow(memo, control)?.address
    if (address === undefined) return { refusal: `"${node.label}" cannot be reset` }
    return {
      records: memo.ctx.customizations.filter((record) => !((controlIds as readonly string[]).includes(record.item) && scopedTo(record, address))),
      splits: [...memo.ctx.splits], status: `Reset agent controls for "${node.label}"`, retryHint: "Agent controls changed; retry to reset",
    }
  }
  if (node.address === undefined) return { refusal: `"${node.label}" cannot be reset` }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  if (node.actions?.reset !== true) {
    const hasStored = chain.customizations.some((record) => sameAddress(record, chain.address))
    return {
      refusal: hasStored
        ? `"${node.label}" cannot be reset; set state "on" to clear the stored override`
        : `"${node.label}" has no override to reset`,
    }
  }
  // Clear through merge's removal path (null fields drop the record) so row
  // identity stays in merge's sameNode check instead of a second filter.
  const next = merge(
    chain.customizations,
    chain.address,
    { text: null, state: null, pin: null, acknowledged: null },
    chain.upstream,
  )
  return {
    records: next,
    splits: chain.splits,
    status: `Reset "${node.label}" to default`,
    retryHint: `reset "${node.label}" against a stale revision; retry to apply`,
  }
}

export function saveSplit(
  input: MemoInput,
  rowId: string,
  boundaries: readonly { id: string; name: string; start: number }[],
): OpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const address = node.address
  if (!address) return { refusal: `"${node.label}" cannot be split` }
  if (node.actions?.split !== true) return { refusal: `"${node.label}" cannot be split` }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  const existing = chain.splits.find((record) => record.item === address.item && scopedTo(record, address))
  if (existing !== undefined && boundariesEqual(existing.boundaries, boundaries))
    return {
      records: chain.customizations,
      splits: chain.splits,
      status: `Split "${node.label}"`,
      retryHint: `split "${node.label}" against a stale revision; retry to apply`,
    }
  const rest = chain.splits.filter((record) => !(record.item === address.item && scopedTo(record, address)))
  const nextSplits: SplitRecord[] = [
    ...rest,
    {
      type: "split",
      level: address.level,
      agent: address.agent,
      ...(address.team !== undefined ? { team: address.team } : {}),
      ...catalogueField(address),
      item: address.item,
      boundaries: [...boundaries],
      updated: now(),
    },
  ]
  return {
    records: chain.customizations,
    splits: nextSplits,
    status: `Split "${node.label}"`,
    retryHint: `split "${node.label}" against a stale revision; retry to apply`,
  }
}

export function addSection(input: MemoInput, rowId: string, name: string, text: string): OpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const address = node.address
  if (!address || node.kind !== "item") return { refusal: `"${node.label}" does not support sections` }
  if (node.actions?.split !== true) return { refusal: `"${node.label}" does not support sections` }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  const currentText = resolvedTextOf(memo, chain)
  const preview = resolveSplit({
    text: currentText,
    title: chain.upstream.title,
    splits: chain.splits,
    scopes: memo.ctx.scopes,
    address: chain.address,
  })
  const existing =
    preview.kind === "manual"
      ? preview.sections
          .filter((section) => section.id !== "preamble")
          .map((section) => ({ id: section.id, name: section.name, start: section.start }))
      : [{ id: "existing", name: chain.upstream.title, start: 0 }]
  const nextStart = currentText.length
  const used = new Set(existing.map((entry) => entry.id))
  const boundaries = [...existing, { id: claim(slugify(name), used), name, start: nextStart }]
  const split = manual(currentText, boundaries)
  const added = split.sections.find((section) => section.start === nextStart && section.name === name)
  if (!added) return { refusal: `Could not add "${name}" to "${node.label}"` }
  const rest = chain.splits.filter((record) => !(record.item === address.item && scopedTo(record, address)))
  const nextSplits: SplitRecord[] = [
    ...rest,
    {
      type: "split",
      level: address.level,
      agent: address.agent,
      ...(address.team !== undefined ? { team: address.team } : {}),
      ...catalogueField(address),
      item: address.item,
      boundaries,
      updated: now(),
    },
  ]
  const sectionAddress: Address = { ...address, section: added.id }
  const sectionUpstream = upstreamSliceOf(split, currentText, added.id)
  const nextCustomizations = merge(
    chain.customizations,
    sectionAddress,
    { text },
    { text: sectionUpstream, fingerprint: fingerprint(sectionUpstream) },
    memo.ctx.scopes,
    nextSplits,
  )
  return {
    records: nextCustomizations,
    splits: nextSplits,
    status: `Added "${name}" to "${node.label}"`,
    retryHint: `added "${name}" against a stale revision; retry to apply`,
  }
}

export function resolveReview(
  input: MemoInput,
  rowId: string,
  resolution: "keep" | "take" | "edit",
  edited?: string,
  only?: readonly ReviewPart[],
): OpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  if (resolution === "edit") {
    const refusal = editRefusal(node)
    if (refusal !== undefined) return { refusal }
    if (edited === undefined) return { refusal: `"${node.label}" cannot be edited: edit requires text` }
  }
  const chain = chainFor(memo, node)
  if (!chain || !node.address) return { refusal: resolveRefusalForLabel(node.label) }
  const next = resolveResolution(
    {
      upstream: chain.upstream,
      records: chain.customizations,
      splits: chain.splits,
      scopes: memo.ctx.scopes,
      address: chain.address,
    },
    resolution,
    edited,
    only,
  )
  if (resolution === "keep") {
    return {
      records: next,
      splits: chain.splits,
      status: `Kept "${node.label}"`,
      retryHint: `resolved "${node.label}" against a stale revision; retry`,
    }
  }
  if (resolution === "take") {
    return {
      records: next,
      splits: chain.splits,
      status: `Took upstream for "${node.label}"`,
      retryHint: `resolved "${node.label}" against a stale revision; retry`,
    }
  }
  return {
    records: next,
    splits: chain.splits,
    status: `Edited "${node.label}"`,
    retryHint: `resolved "${node.label}" against a stale revision; retry`,
  }
}

/**
 * The two sides of a state/pin review (§3.6), in the words the TUI's choice
 * shows: "Keep yours (off)" / "Take from preset Orchestrator (on)". Undefined
 * when the row has no state or pin under review.
 */
export interface StateReviewChoice {
  /** The parts the choice resolves (state and/or pin; never text). */
  readonly parts: readonly ReviewPart[]
  readonly mine: string
  readonly above: string
  /** Where the value above comes from ("from preset Orchestrator", "native", …). */
  readonly from: string
}

export function stateReviewChoice(input: MemoInput, rowId: string): StateReviewChoice | undefined {
  const found = findNode(input, rowId)
  if (found === undefined) return undefined
  const parts = (found.node.badges.reviewOf ?? []).filter((part) => part !== "text")
  if (parts.length === 0) return undefined
  const chain = chainFor(found.memo, found.node)
  if (chain === undefined) return undefined
  const pair = ownAndAbove({
    upstream: chain.upstream,
    records: chain.customizations,
    splits: chain.splits,
    scopes: found.memo.ctx.scopes,
    address: chain.address,
  })
  if (pair === undefined) return undefined
  const describe = (state: "on" | "off" | undefined, pin: boolean | undefined) =>
    [
      ...(parts.includes("state") && state !== undefined ? [state] : []),
      ...(parts.includes("pin") ? [pin === true ? "pinned" : "not pinned"] : []),
    ].join(", ")
  return {
    parts,
    mine: describe(pair.own.state, pair.own.pin),
    above: describe(pair.above.enabled ? "on" : "off", pair.above.pinned),
    from: fromLabel(parts.includes("state") ? pair.above.from : pair.above.pinFrom, {
      labels: found.memo.ctx.labels,
      level: chain.address.level,
    }),
  }
}

/** A model row's active-model review (§3.6): this row, and the active model the chain above resolves now. */
export interface ModelReviewChoice {
  readonly mine: string
  /** Undefined when nothing above is active and the agent has no model of its own. */
  readonly above?: string
  readonly from?: string
}

export function modelReviewChoice(input: MemoInput, rowId: string): ModelReviewChoice | undefined {
  const found = findNode(input, rowId)
  const address = found?.node.address
  if (found === undefined || address === undefined || modelTargetOf(address) === undefined) return undefined
  const scope = modelScopeOf(address)
  const upstream = modelUpstreamOf(found.memo, address)
  const above = resolveActiveModel({
    models: modelsOfInput(input).filter((record) => !scopedTo(record, scope)),
    scopes: found.memo.ctx.scopes,
    level: address.level,
    agent: address.agent,
    ...(address.team === undefined ? {} : { team: address.team }),
    ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }),
    ...(address.memberOf === undefined ? {} : { memberOf: address.memberOf }),
    ...(upstream === undefined ? {} : { upstream }),
  })
  if (above === undefined) return { mine: found.node.label }
  return {
    mine: found.node.label,
    above: modelKey(above),
    from: fromLabel(above.from, { labels: found.memo.ctx.labels, level: address.level }),
  }
}

// Keep: the own active model re-records the active model above it now, so the
// review clears and yours stays. Take: the own active flag goes, so the model
// above wins again.
export function resolveModelReview(input: MemoInput, rowId: string, resolution: "keep" | "take"): ModelOpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined || modelTargetOf(address) === undefined) return { refusal: resolveRefusalForLabel(node.label) }
  const models = modelsOfInput(input)
  const scope = modelScopeOf(address)
  const upstream = modelUpstreamOf(found.memo, address)
  const next =
    resolution === "keep"
      ? acknowledgeActiveModel(models, scope, { scopes: found.memo.ctx.scopes, ...(upstream === undefined ? {} : { upstream }) })
      : clearModelActive(models, scope)
  const status = resolution === "keep" ? `Kept "${node.label}"` : `Took the model above for "${node.label}"`
  return { models: next, status, retryHint: `resolved "${node.label}" against a stale revision; retry` }
}

// The agent's own model, as the tree and activation read it.
function modelUpstreamOf(memo: Memo, address: Address) {
  const owner = address.agent
  if (owner === null) return undefined
  const agents = memo.ctx.agents
  return agents.find((entry) => entry.id === owner && entry.scope === address.level)?.model ?? agents.find((entry) => entry.id === owner)?.model
}

export function removalPlan(input: MemoInput, rowId: string): RemovalPlan {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const preset = node.owner?.preset
  if (preset !== undefined) {
    if (preset.origin !== "user")
      return { refusal: `"${node.label}" cannot be deleted: ${preset.origin === "native" ? "Native" : "Plus"} presets are read-only` }
    return {
      kind: "preset.delete",
      ref: preset.ref,
      confirmTitle: `Delete preset ${node.label}?`,
      confirmMessage: `Delete preset "${node.label}"? Anything created from it must be relinked first. This cannot be undone.`,
      successStatus: `Deleted preset ${node.label}`,
    }
  }
  const entry = node.owner?.entry
  if (entry !== undefined) {
    const named = entry.name === undefined ? `team entry "${entry.team}" and its member entries` : `entry "${node.label}"`
    return {
      kind: "entry.delete",
      catalogue: entry.catalogue,
      ...(entry.team === undefined ? {} : { team: entry.team }),
      ...(entry.name === undefined ? {} : { name: entry.name }),
      confirmTitle: `Delete Defaults entry ${node.label}?`,
      confirmMessage: `Delete Defaults ${named}? Its own settings go with it. This cannot be undone.`,
      successStatus: `Deleted Defaults entry ${node.label}`,
    }
  }
  if (node.kind === "agent") {
    if (node.actions?.remove !== true) return { refusal: `"${node.label}" cannot be deleted` }
    const match = node.id.match(/^agent:(project|global|defaults|preset):(.+)$/)
    const agentId = match?.[2]
    const scope = match?.[1]
    if (!agentId || !scope) return { refusal: `"${node.label}" cannot be deleted` }
    if (scope !== "project" && scope !== "global")
      return { refusal: `"${node.label}" cannot be deleted: agent.delete supports scope project|global only` }
    return {
      kind: "agent.delete",
      scope,
      id: agentId,
      confirmTitle: `Delete agent ${agentId}?`,
      confirmMessage: `Delete ${scope} agent "${agentId}"? This cannot be undone.`,
      successStatus: `Deleted agent ${agentId}`,
    }
  }
  if (node.kind === "team") {
    if (node.id.includes(":special")) return { refusal: `"${node.label}" cannot be deleted` }
    const teams = ((input.teams ?? memo.ctx.teams) as readonly TeamInput[])
    const match = node.id.match(/^team:(project|global|defaults|preset):(.+)$/s)
    const level = match?.[1]
    if (level) {
      const levelTeams = teams.filter((candidate) => candidate.level === level)
      const exactTeam = levelTeams.find((candidate) => node.id === `team:${level}:${candidate.team}`)
      const memberTeam = levelTeams.find(
        (candidate) =>
          candidate.team !== exactTeam?.team &&
          candidate.agents.some((member) => node.id === `team:${level}:${candidate.team}:${member}`),
      )
      if (exactTeam !== undefined && memberTeam !== undefined) {
        return {
          refusal: `"${exactTeam.team}" is ambiguous: it matches both a team and a member of team "${memberTeam.team}". Rename one to continue.`,
        }
      }
    }
    const entry = memo.ctx.teams.find((candidate) => node.id === `team:${candidate.level}:${candidate.team}`)
    if (entry !== undefined) {
      if ((entry.level as string) === "defaults")
        return { refusal: `"${node.label}" cannot be deleted: team "${entry.team}" is built in` }
      const memberCount = entry.agents.length
      const enabled = entry.enabled
      const statusText = enabled ? "enabled" : "disabled"
      return {
        kind: "team.delete",
        level: entry.level as "project" | "global",
        team: entry.team,
        memberCount,
        enabled,
        confirmTitle: `Delete team ${entry.team}?`,
        confirmMessage: `Delete ${entry.level} team "${entry.team}" and its ${memberCount} member file(s)? It is currently ${statusText}. This cannot be undone.`,
        successStatus: `Deleted team ${entry.team}`,
      }
    }
    const candidates = ((input.teams ?? memo.ctx.teams) as readonly TeamInput[]).toSorted(
      (left, right) => right.team.length - left.team.length,
    )
    const parent = candidates.find(
      (candidate) =>
        node.id === `team:${candidate.level}:${candidate.team}:${node.label}` ||
        candidate.agents.some((member) => node.id === `team:${candidate.level}:${candidate.team}:${member}`) ||
        node.id.startsWith(`team:${candidate.level}:${candidate.team}:`),
    )
    if (parent === undefined) return { refusal: `"${node.label}" cannot be deleted` }
    if ((parent.level as string) === "defaults" && !(parent.overlay?.includes(node.label) ?? false))
      return { refusal: `"${node.label}" cannot be deleted: shipped member of built-in team "${parent.team}"` }
    return {
      kind: "team.removeAgent",
      level: parent.level,
      team: parent.team,
      id: node.label,
      confirmTitle: `Delete team member ${node.label}?`,
      confirmMessage: `Delete member "${node.label}" from team "${parent.team}"? This cannot be undone.`,
      successStatus: `Deleted team member ${node.label}`,
    }
  }
  const address = node.address
  if (node.kind === "item" && node.actions?.remove !== true) {
    const refusal = refusalFor(input, rowId)
    if (refusal !== undefined) return { refusal }
    return { refusal: `"${node.label}" cannot be deleted` }
  }
  if (node.kind === "section")
    return { refusal: `"${node.label}" cannot be deleted: sections are toggled or split, not deleted` }
  if (node.actions?.remove !== true) return { refusal: `"${node.label}" cannot be deleted` }
  if (address && address.item.startsWith("mcp:") && address.level === "defaults" && address.agent === null) {
    const name = address.item.slice("mcp:".length)
    return {
      kind: "mcp.remove",
      name,
      confirmTitle: `Remove MCP server ${name}?`,
      confirmMessage: `Remove MCP server "${name}"? This cannot be undone.`,
      successStatus: `Removed MCP server ${name}`,
    }
  }
  const itemId = address?.item ?? node.label
  const item = address === undefined ? undefined : upstreamFor(memo.ctx.items, address)
  if (item === undefined) return { refusal: `"${node.label}" cannot be deleted` }
  if (item.kind === "skill" && itemId.startsWith("skill:")) {
    const skillId = itemId.slice("skill:".length)
    if (node.actions?.remove !== true || item.group !== "project")
      return { refusal: `"${node.label}" cannot be deleted: skill "${skillId}" is not project-owned` }
    return {
      kind: "skill.delete",
      id: skillId,
      confirmTitle: `Delete skill ${skillId}?`,
      confirmMessage: `Delete project skill "${skillId}"? This cannot be undone.`,
      successStatus: `Deleted skill ${skillId}`,
    }
  }
  if (item.kind === "base" && itemId.startsWith("base:")) {
    const templateId = itemId.slice("base:".length)
    if (node.actions?.remove !== true)
      return { refusal: `"${node.label}" cannot be deleted: base template "${templateId}" is built in` }
    return {
      kind: "base.delete",
      id: templateId,
      confirmTitle: `Delete base template ${templateId}?`,
      confirmMessage: `Delete base template "${templateId}"? This cannot be undone.`,
      successStatus: `Deleted base template ${templateId}`,
    }
  }
  if (item.kind === "system" && itemId.startsWith("system:") && itemId !== "system:role") {
    const relative = itemId.slice("system:".length)
    if (node.actions?.remove !== true)
      return { refusal: `"${node.label}" cannot be deleted: instruction "${relative}" is not project-owned` }
    return {
      kind: "instruction.delete",
      name: relative,
      confirmTitle: `Delete instruction ${relative}?`,
      confirmMessage: `Delete instruction "${relative}"? This cannot be undone.`,
      successStatus: `Deleted instruction ${relative}`,
    }
  }
  if (item.kind === "system" && itemId === "system:role")
    return { refusal: `"${node.label}" cannot be deleted: the agent's own prompt body is not a file` }
  return { refusal: `"${node.label}" cannot be deleted` }
}

export function teamPlan(input: MemoInput, rowId: string, desired?: boolean): TeamPlan {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  if (node.kind !== "team") return { refusal: `"${node.label}" cannot be toggled` }
  if (node.actions?.toggle !== true) return { refusal: `"${node.label}" cannot be toggled` }
  const match = node.id.match(/^team:(project|global|defaults|preset):(.+)$/)
  const level = match?.[1]
  const team = match === null || match === undefined ? undefined : match[2]
  if (level !== "project" && level !== "global" && level !== "defaults")
    return { refusal: `"${node.label}" cannot be toggled` }
  if (team === undefined) return { refusal: `"${node.label}" cannot be toggled` }
  const entry = memo.ctx.teams.find((candidate) => candidate.level === level && candidate.team === team)
  if (!entry) return { refusal: `"${node.label}" cannot be toggled` }
  const next = desired ?? !entry.enabled
  return {
    kind: "team.setEnabled",
    level,
    team,
    enabled: next,
    successStatus: next ? `Enabled team "${team}"` : `Disabled team "${team}"`,
  }
}

export function refusalFor(input: MemoInput, rowId: string): string | undefined {
  const found = findNode(input, rowId)
  if (found === undefined) return unknownRowRefusal(rowId)
  const node = found.node
  const memo = found.memo
  const address = node.address
  if (address === undefined) return undefined
  const item = upstreamFor(memo.ctx.items, address)
  if (item === undefined) return undefined
  if (item.kind === "skill") {
    const skillId = address.item.startsWith("skill:") ? address.item.slice("skill:".length) : address.item
    return `"${node.label}" cannot be deleted: skill "${skillId}" is not project-owned`
  }
  if (item.kind === "base") {
    const templateId = address.item.startsWith("base:") ? address.item.slice("base:".length) : address.item
    return `"${node.label}" cannot be deleted: base template "${templateId}" is built in`
  }
  if (item.kind === "system" && item.id !== "system:role") {
    const relative = address.item.startsWith("system:") ? address.item.slice("system:".length) : address.item
    return `"${node.label}" cannot be deleted: instruction "${relative}" is not project-owned`
  }
  if (node.kind === "section") return `"${node.label}" cannot be deleted: sections are toggled or split, not deleted`
  if (item.id === "system:role") return `"${node.label}" cannot be deleted: the agent's own prompt body is not a file`
  if (item.kind === "tool" || item.kind === "mcp") return `"${node.label}" cannot be deleted: ${item.kind} rows are not files`
  return undefined
}

function modelsOfInput(input: MemoInput): ModelRecord[] {
  return input.records.filter((record): record is ModelRecord => record.type === "model")
}

function customizationsOfInput(input: MemoInput): CustomizationRecord[] {
  return input.records.filter((record): record is CustomizationRecord => record.type === "customization")
}

function splitsOfInput(input: MemoInput): SplitRecord[] {
  return input.records.filter((record): record is SplitRecord => record.type === "split")
}

function modelTargetOf(address: Address): { providerID: string; modelID: string; variant?: string } | undefined {
  return parseModelItemId(address.item)
}

// The row's own node (a member row's is per-agent) plus the team it resolves
// with, which activation reads for the active model above.
function modelScopeOf(address: Address): RecordScope & { readonly memberOf?: TeamRef } {
  return {
    level: address.level,
    agent: address.agent,
    ...(address.team !== undefined ? { team: address.team } : {}),
    ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }),
    ...(address.memberOf === undefined ? {} : { memberOf: address.memberOf }),
  }
}

// Space on a model row activates it exclusively at that level, creating the
// local row when the candidate is inherited. Activating the already-active
// row is a no-op that still reports success without writing.
export function activateModelRow(input: MemoInput, rowId: string): ModelOpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined) return { refusal: `"${node.label}" cannot be toggled` }
  if (node.actions?.toggle !== true) return { refusal: `"${node.label}" cannot be toggled` }
  const target = modelTargetOf(address)
  if (target === undefined) return { refusal: `"${node.label}" cannot be toggled` }
  const models = modelsOfInput(input)
  // With the chain context the active record stores the active model above
  // it (`basedOn`), so a later change above raises review (§3.6).
  const agents = found.memo.ctx.agents
  const owner = address.agent
  const upstream =
    owner === null
      ? undefined
      : (agents.find((entry) => entry.id === owner && entry.scope === address.level)?.model ??
        agents.find((entry) => entry.id === owner)?.model)
  const next = ensureActivateModel(models, modelScopeOf(address), target, now(), {
    scopes: found.memo.ctx.scopes,
    ...(upstream === undefined ? {} : { upstream }),
  })
  if (JSON.stringify(next) === JSON.stringify(models))
    return { models: next, status: `Activated "${node.label}"`, retryHint: `activated "${node.label}" against a stale revision; retry to apply` }
  return { models: next, status: `Activated "${node.label}"`, retryHint: `activated "${node.label}" against a stale revision; retry to apply` }
}

// r on a model row clears only that level's active flag, leaving candidates
// so the chain falls through. No active at this level refuses.
export function resetModelRow(input: MemoInput, rowId: string): ModelOpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined) return { refusal: `"${node.label}" has no override to reset` }
  if (node.actions?.reset !== true) return { refusal: `"${node.label}" has no override to reset` }
  const models = modelsOfInput(input)
  const next = clearModelActive(models, modelScopeOf(address))
  if (JSON.stringify(next) === JSON.stringify(models)) return { refusal: `"${node.label}" has no override to reset` }
  return { models: next, status: `Reset "${node.label}" to default`, retryHint: `reset "${node.label}" against a stale revision; retry to apply` }
}

// d on a model row deletes the candidate at this level only. Inherited rows
// with no local record refuse: remove at the source level instead.
export function removeModelRow(input: MemoInput, rowId: string): ModelOpResult {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined) return { refusal: `"${node.label}" cannot be deleted` }
  const target = modelTargetOf(address)
  if (target === undefined) return { refusal: `"${node.label}" cannot be deleted` }
  const models = modelsOfInput(input)
  const addr = modelScopeOf(address)
  if (!hasModelRecordAt(models, addr, target))
    return { refusal: `"${node.label}" cannot be deleted here: remove it at its source level` }
  const next = removeModelRecord(models, addr, target)
  return { models: next, status: `Removed "${node.label}"`, retryHint: `removed "${node.label}" against a stale revision; retry to apply` }
}

export function isModelRowId(rowId: string): boolean {
  return rowId.includes(":model:")
}

export function isPermRowId(rowId: string): boolean {
  return rowId.includes(":perm:")
}

export function ruleRecordsOf(input: MemoInput): RuleRecord[] {
  return input.records.filter((record): record is RuleRecord => record.type === "rule")
}

export function modelRecordsOf(input: MemoInput): ModelRecord[] {
  return modelsOfInput(input)
}

export function customizationRecordsOf(input: MemoInput): CustomizationRecord[] {
  return customizationsOfInput(input)
}

export function splitRecordsOf(input: MemoInput): SplitRecord[] {
  return splitsOfInput(input)
}

function upstreamSliceOf(split: Split, text: string, id: string): string {
  const section = split.sections.find((entry) => entry.id === id)
  if (section === undefined) return ""
  return slice(text, section)
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "section"
}

function claim(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  used.add(`${base}-${n}`)
  return `${base}-${n}`
}

function now(): string {
  return new Date().toISOString()
}
