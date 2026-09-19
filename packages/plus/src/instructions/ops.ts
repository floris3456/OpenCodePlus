import {
  addModelRecord,
  applies,
  clearModelActive,
  ensureActivateModel,
  fingerprint,
  hasModelRecordAt,
  merge,
  parseModelItemId,
  removeModelRecord,
  resolve,
  resolveResolution,
  resolveSplit,
} from "./model.js"
import type { Address, CustomizationRecord, Item, ModelRecord, RuleRecord, SplitRecord } from "./model.js"
import { buildMemo } from "./resolve-memo.js"
import type { Memo } from "./resolve-memo.js"
import { collectSkeleton, materialize, skeletonOf } from "./tree.js"
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

function findNode(input: MemoInput, rowId: string): { memo: Memo; node: TreeNode } | undefined {
  const memo = buildMemo(input as unknown as Parameters<typeof buildMemo>[0])
  const nodes = collectSkeleton(skeletonOf(memo)).map(materialize)
  const node = nodes.find((candidate) => candidate.id === rowId)
  if (node === undefined) return undefined
  return { memo, node }
}

function upstreamFor(items: readonly Item[], address: Address): Item | undefined {
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
  record: { level: Address["level"]; agent: string | null; item: string; section: string | null },
  address: Address,
): boolean {
  return (
    record.level === address.level && record.agent === address.agent && record.item === address.item && record.section === address.section
  )
}

function customizationsEqualWithoutUpdated(left: CustomizationRecord, right: CustomizationRecord): boolean {
  return (
    left.level === right.level &&
    left.agent === right.agent &&
    left.item === right.item &&
    left.section === right.section &&
    left.text === right.text &&
    left.state === right.state &&
    left.pin === right.pin &&
    left.basedOn === right.basedOn &&
    left.basedOnText === right.basedOnText &&
    left.acknowledged === right.acknowledged
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
  const next = merge(chain.customizations, chain.address, { state: resolved.enabled ? "off" : "on" }, chain.upstream)
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
  const memo = found.memo
  const refusal = toggleRefusal(node)
  if (refusal !== undefined) return { refusal }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  const next = merge(chain.customizations, chain.address, { state: value ? "on" : "off" }, chain.upstream)
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
  const next = merge(chain.customizations, chain.address, { pin: value }, chain.upstream)
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
  const next = merge(chain.customizations, chain.address, { text }, chain.upstream)
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
  if (node.address === undefined) return { refusal: `"${node.label}" cannot be reset` }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  if (node.actions?.reset !== true) return { refusal: `"${node.label}" has no override to reset` }
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
  const existing = chain.splits.find(
    (record) => record.level === address.level && record.agent === address.agent && record.item === address.item,
  )
  if (existing !== undefined && boundariesEqual(existing.boundaries, boundaries))
    return {
      records: chain.customizations,
      splits: chain.splits,
      status: `Split "${node.label}"`,
      retryHint: `split "${node.label}" against a stale revision; retry to apply`,
    }
  const rest = chain.splits.filter(
    (record) => !(record.level === address.level && record.agent === address.agent && record.item === address.item),
  )
  const nextSplits: SplitRecord[] = [
    ...rest,
    { type: "split", level: address.level, agent: address.agent, item: address.item, boundaries: [...boundaries], updated: now() },
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
  const rest = chain.splits.filter(
    (record) => !(record.level === address.level && record.agent === address.agent && record.item === address.item),
  )
  const nextSplits: SplitRecord[] = [
    ...rest,
    { type: "split", level: address.level, agent: address.agent, item: address.item, boundaries, updated: now() },
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

export function removalPlan(input: MemoInput, rowId: string): RemovalPlan {
  const found = findNode(input, rowId)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  if (node.kind === "agent") {
    if (node.actions?.remove !== true) return { refusal: `"${node.label}" cannot be deleted` }
    const match = node.id.match(/^agent:(project|global|defaults):(.+)$/)
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
    const entry = memo.ctx.teams.find((candidate) => node.id === `team:${candidate.level}:${candidate.team}`)
    if (entry !== undefined) {
      if ((entry.level as string) === "defaults")
        return { refusal: `"${node.label}" cannot be deleted: team "${entry.team}" is built in` }
      return { refusal: `"${node.label}" cannot be deleted` }
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
  const match = node.id.match(/^team:(project|global|defaults):(.+)$/)
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
  const next = ensureActivateModel(models, { level: address.level, agent: address.agent }, target, now())
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
  const next = clearModelActive(models, { level: address.level, agent: address.agent })
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
  if (!hasModelRecordAt(models, { level: address.level, agent: address.agent }, target))
    return { refusal: `"${node.label}" cannot be deleted here: remove it at its source level` }
  const next = removeModelRecord(models, { level: address.level, agent: address.agent }, target)
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
