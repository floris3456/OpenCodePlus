import { fromLabel } from "./from-label.js"
import { booleanControl, controlIds, controlItemFor, isControl } from "./agent-controls.js"
import {
  coldModelItemId,
  compactionFieldsOf,
  effectiveCompaction,
  everySettings,
  hostModelOf,
  parseColdDefaultItemId,
  parseColdModelItemId,
  parseModelFieldItemId,
  parseModelSettingItemId,
  resolveModelCompactionFields,
  settingsFor,
  setModelCompaction,
  type ModelCompactionFieldValues,
  type ModelFieldName,
  type ModelSettingsKey,
} from "./model-settings.js"
import {
  acknowledgeActiveModel,
  activateModel,
  addModelRecord,
  applies,
  canReset,
  catalogueField,
  catalogueOf,
  clearModelActive,
  deactivateModel,
  ensureActivateModel,
  fingerprint,
  formatDuration,
  formatWarming,
  hasModelRecordAt,
  merge,
  modelCandidates,
  modelItemId,
  modelKey,
  modelRuntimeScope,
  ownAndAbove,
  parseInterval,
  parseModelItemId,
  parsePrompt,
  parseWarming,
  removeModelRecord,
  reset as resetModelRecords,
  resolve,
  resolveActiveModel,
  resolutionChain,
  resolveResolution,
  resolveSplit,
  sameModelCandidate,
  sameTeam,
  scopedTo,
  setModelSettings,
  setModelWarming,
  shadowOf,
  tombstoneModelRecord,
  upstreamForEdit,
} from "./model.js"
import type {
  Address,
  Catalogue,
  CustomizationRecord,
  Item,
  Level,
  ModelCandidate,
  ModelInput,
  ModelRecord,
  ModelWarmingFields,
  OriginalCandidate,
  PresetRef,
  RecordScope,
  ReviewPart,
  RuleRecord,
  Scopes,
  SplitRecord,
  TeamRef,
} from "./model.js"
import {
  ancestorsOf,
  createFolderRecord,
  deleteFolderRecord,
  folderIdOfRef,
  folderOf,
  folderRef,
  groupScope,
  ownerLayout,
  renameFolderRecord,
  reparent,
  setOrder,
  setOrderScope,
  splitLayout,
  tabOfGroupId,
  tabOfItem,
  type FolderRecord,
  type OrderRecord,
} from "./folders.js"
import { presetOfAddress } from "./presets.js"
import { linksTouching, switchedOff } from "./rowlinks.js"
import { buildMemo } from "./resolve-memo.js"
import type { Memo } from "./resolve-memo.js"
import { requiresGateRecords, type RowlinkRecord } from "./rowlinks.js"
import { buildTreeMemo, collectSkeleton, findLazy, groupToggleOf, groupToggleRows, lazyPath, materialize, skeletonOf } from "./tree.js"
import type { MemoInput, TeamInput, TreeNode } from "./tree.js"
import { derive, headingSpan, manual, parentIndexes, relocateHeadingSpan, slice, wrappingSection, type Boundary } from "./sections.js"
import type { Split } from "./sections.js"

// Folders and display order (S1a). A move is planned from the folder and order
// records plus the tab's top-level tokens in display order, then written as one
// layout write. A token is an item id or `folder:<id>`; `into` is `folder:<id>`
// or `tab:<tab>`. A row moves only inside its own tab.
export interface LayoutRecords {
  readonly folders: readonly FolderRecord[]
  readonly orders: readonly OrderRecord[]
}

export interface MoveTarget {
  readonly into?: string | undefined
  readonly before?: string | undefined
  readonly after?: string | undefined
}

export type LayoutChange = { readonly target: string; readonly status: string; readonly layout: LayoutRecords } | { readonly refusal: string }

export type LayoutPlan = LayoutRecords | { readonly refusal: string }

type Container = { readonly folder: FolderRecord } | { readonly tab: string }

function containerKey(container: Container): string {
  return "folder" in container ? folderRef(container.folder.id) : `tab:${container.tab}`
}

function describeContainer(container: Container): string {
  return "folder" in container ? `folder "${container.folder.name}"` : `the top level of ${container.tab}`
}

function tabOfToken(folders: readonly FolderRecord[], token: string): string | undefined {
  const id = folderIdOfRef(token)
  return id === undefined ? tabOfItem(token) : folderOf(folders, id)?.tab
}

function containerOfToken(folders: readonly FolderRecord[], token: string): Container | undefined {
  const holder = folders.find((folder) => folder.items.includes(token))
  if (holder !== undefined) return { folder: holder }
  const tab = tabOfToken(folders, token)
  return tab === undefined ? undefined : { tab }
}

function containerOfRef(folders: readonly FolderRecord[], ref: string): Container | undefined {
  if (ref.startsWith("tab:")) return { tab: ref.slice("tab:".length) }
  const id = folderIdOfRef(ref)
  const folder = id === undefined ? undefined : folderOf(folders, id)
  return folder === undefined ? undefined : { folder }
}

function insertBeside(list: readonly string[], token: string, target: MoveTarget): string[] | undefined {
  const sibling = target.before ?? target.after
  if (sibling === undefined) return [...list, token]
  const index = list.indexOf(sibling)
  if (index === -1) return undefined
  const at = target.after === undefined ? index : index + 1
  return [...list.slice(0, at), token, ...list.slice(at)]
}

// `inOriginGroup`: the row sits inside one of its tab's origin subgroups (Tools › native),
// so the tab's top level cannot hold it; moving it out of a folder sends it back home.
export function planMove(
  records: LayoutRecords,
  token: string,
  top: readonly string[],
  target: MoveTarget,
  updated: string,
  inOriginGroup = false,
): LayoutPlan {
  const { folders } = records
  const movedId = folderIdOfRef(token)
  const moved = movedId === undefined ? undefined : folderOf(folders, movedId)
  const sourceTab = tabOfToken(folders, token)
  if (sourceTab === undefined || (movedId !== undefined && moved === undefined)) return { refusal: `"${token}" is not a row or folder that can move` }
  if (target.before !== undefined && target.after !== undefined) return { refusal: "give before or after, not both" }
  if (target.into === undefined && target.before === undefined && target.after === undefined)
    return { refusal: "say where it goes: into a folder or tab, or before or after a row" }
  const sibling = target.before ?? target.after
  if (sibling === token) return { refusal: `"${token}" cannot go beside itself` }
  const into = target.into === undefined ? undefined : containerOfRef(folders, target.into)
  if (target.into !== undefined && into === undefined) return { refusal: `"${target.into}" is not a folder or a tab` }
  const beside = sibling === undefined ? undefined : containerOfToken(folders, sibling)
  if (sibling !== undefined && beside === undefined) return { refusal: `"${sibling}" is not a row that can be placed beside` }
  const dest = into ?? beside
  if (dest === undefined) return { refusal: "say where it goes: into a folder or tab, or before or after a row" }
  if (into !== undefined && beside !== undefined && containerKey(into) !== containerKey(beside))
    return { refusal: `"${sibling}" is not in ${describeContainer(into)}` }
  const destTab = "folder" in dest ? dest.folder.tab : dest.tab
  if (destTab !== sourceTab) return { refusal: `"${token}" is in ${sourceTab}; it moves only within ${sourceTab}, not into ${destTab}` }
  if (moved !== undefined && "folder" in dest && (dest.folder.id === moved.id || ancestorsOf(folders, dest.folder.id).includes(moved.id)))
    return { refusal: `folder "${moved.name}" cannot move into itself or into one of its own folders` }
  const destFolder = "folder" in dest ? dest.folder.id : undefined
  const inFolder = folders.some((folder) => folder.items.includes(token))
  const cleared = folders.map((folder) =>
    folder.items.includes(token) ? { ...folder, items: folder.items.filter((item) => item !== token), updated } : folder,
  )
  const topCleared = top.filter((entry) => entry !== token)
  if (destFolder === undefined && inOriginGroup && sibling !== undefined)
    return { refusal: `"${token}" sits in an origin group of ${sourceTab}; it cannot go beside "${sibling}" at the top level` }
  const list = destFolder === undefined ? topCleared : (cleared.find((folder) => folder.id === destFolder)?.items ?? [])
  const inserted = destFolder === undefined && inOriginGroup ? topCleared : insertBeside(list, token, target)
  if (inserted === undefined) return { refusal: `"${sibling}" is not in ${describeContainer(dest)}` }
  const placed = cleared.map((folder) => {
    const next = folder.id === destFolder ? { ...folder, items: inserted, updated } : folder
    return moved?.id === folder.id ? reparent(next, destFolder) : next
  })
  const writesTop = !inFolder || destFolder === undefined
  const orders = writesTop ? setOrder(records.orders, sourceTab, destFolder === undefined ? inserted : topCleared, updated) : [...records.orders]
  return { folders: placed, orders }
}

const FOLDER_MARK = ":folder:"

// The token a tree row stands for: a folder, a tab (`tab:<tab>`), or a whole item row. Sections, groups and
// built-in structure have none.
export function rowToken(node: Pick<TreeNode, "id" | "kind" | "address">): string | undefined {
  if (node.kind === "section" && node.address?.section === null) return undefined
  if (node.kind === "group") {
    const at = node.id.indexOf(FOLDER_MARK)
    if (at !== -1) return folderRef(node.id.slice(at + FOLDER_MARK.length))
    // A tab group is `group:<level>:<owner>:<tab>`; an origin subgroup (Tools › mcp) has one more segment.
    const tab = node.id.split(":").length === 4 ? tabOfGroupId(node.id) : undefined
    return tab === undefined ? undefined : `tab:${tab}`
  }
  return node.address?.section === null ? node.address.item : undefined
}

// The index of the tab group a row sits in (nearest tab ancestor), in a flat list of rows in display order.
export function tabGroupIndex(nodes: readonly TreeNode[], index: number): number | undefined {
  const row = nodes[index]
  if (row === undefined) return undefined
  let depth = row.depth
  for (let at = index - 1; at >= 0 && depth > 0; at--) {
    const candidate = nodes[at]
    if (candidate === undefined || candidate.depth >= depth) continue
    if (rowToken(candidate)?.startsWith("tab:") === true) return at
    depth = candidate.depth
  }
  return undefined
}

// The tokens directly under a tab group, in display order (folders and rows at the tab's top level).
export function topLevelTokens(nodes: readonly TreeNode[], tabIndex: number): string[] {
  const group = nodes[tabIndex]
  if (group === undefined) return []
  const rest = nodes.slice(tabIndex + 1)
  const end = rest.findIndex((node) => node.depth <= group.depth)
  const within = end === -1 ? rest : rest.slice(0, end)
  return within.flatMap((node) => {
    if (node.depth !== group.depth + 1) return []
    const token = rowToken(node)
    return token === undefined ? [] : [token]
  })
}

export interface RowTarget {
  readonly into?: string | undefined
  readonly before?: string | undefined
  readonly after?: string | undefined
}

type Anchor = { readonly token: string; readonly label: string } | { readonly refusal: string }

// Move a row or folder (by tree row id) within its tab. Sections cannot move yet.
export function planRowMove(memo: MemoInput, layout: LayoutRecords, rowId: string, target: RowTarget, updated: string, sharedMemo?: Memo): LayoutChange {
  const active = sharedMemo ?? buildTreeMemo(memo)
  const path = lazyPath(active, rowId)
  const node = path.at(-1)
  if (node === undefined) return { refusal: unknownRowRefusal(rowId) }
  if (node.address !== undefined && node.address.section !== null) return { refusal: `"${node.label}" is a section; moving sections is not supported yet` }
  const token = rowToken(node)
  if (token === undefined || token.startsWith("tab:")) return { refusal: `"${node.label}" is built-in structure and cannot move` }
  const tab = path.slice(0, -1).findLast((row) => rowToken(row)?.startsWith("tab:"))
  if (tab === undefined) return { refusal: `"${node.label}" is not in a tab` }
  const local = ownerLayout(layout, tab.id)
  const anchorOf = (id: string | undefined): Anchor | undefined => {
    if (id === undefined) return undefined
    const folder = folderOf(layout.folders, folderIdOfRef(id) ?? "")
    if (folder !== undefined && (folder.tab !== tabOfGroupId(tab.id) || folder.owner !== undefined && folder.owner !== tab.id))
      return { refusal: `Rows move only within ${tabOfGroupId(tab.id)} of the same owner` }
    if (id.startsWith("folder:") || id.startsWith("tab:")) return { token: id, label: folderOf(layout.folders, folderIdOfRef(id) ?? "")?.name ?? id }
    const anchorPath = lazyPath(active, id)
    const anchor = anchorPath.at(-1)
    if (anchor === undefined) return { refusal: unknownRowRefusal(id) }
    const anchorToken = rowToken(anchor)
    if (anchorToken === undefined) return { refusal: `"${anchor.label}" cannot be a destination` }
    if (anchor.id !== tab.id && anchorPath.slice(0, -1).findLast((row) => rowToken(row)?.startsWith("tab:"))?.id !== tab.id)
      return { refusal: `"${anchor.label}" is not in ${tab.label}; rows move only inside their own tab` }
    return { token: anchorToken, label: anchor.label }
  }
  const into = anchorOf(target.into)
  const before = anchorOf(target.before)
  const after = anchorOf(target.after)
  const failure = [into, before, after].find((anchor): anchor is { readonly refusal: string } => anchor !== undefined && "refusal" in anchor)
  if (failure !== undefined) return { refusal: failure.refusal }
  const tokenOf = (anchor: Anchor | undefined): string | undefined => (anchor !== undefined && "token" in anchor ? anchor.token : undefined)
  const inOriginGroup = !token.startsWith("folder:") && node.depth !== tab.depth + 1
  const plan = planMove(
    local,
    local.token(token),
    tab.children().flatMap((row) => { const token = rowToken(row); return token === undefined ? [] : [local.token(token)] }),
    { into: tokenOf(into) === undefined ? undefined : local.token(tokenOf(into)!), before: tokenOf(before) === undefined ? undefined : local.token(tokenOf(before)!), after: tokenOf(after) === undefined ? undefined : local.token(tokenOf(after)!) },
    updated,
    inOriginGroup,
  )
  if ("refusal" in plan) return plan
  const where =
    into !== undefined && "token" in into
      ? into.token.startsWith("tab:")
        ? `to the top of ${tab.label}`
        : `into "${into.label}"`
      : before !== undefined && "token" in before
        ? `before "${before.label}"`
        : after !== undefined && "token" in after
          ? `after "${after.label}"`
          : ""
  return { target: local.token(token), status: `Moved "${node.label}" ${where}`, layout: local.finish(plan, updated) }
}

// A section move (plus-1.2.0 B42). It reorders one section before or after a
// sibling under the same parent, inside the same item. A heading-derived move
// rewrites the parent's effective span (the B39 parent-save); a manual split
// rewrites effective text and remaps its stable boundaries. State, pin and
// condition records are never touched; only consumed text fields go.
// Cross-item and cross-parent (nesting) moves refuse atomically.
export function planSectionMove(memo: MemoInput, rowId: string, target: RowTarget, updated: string, sharedMemo?: Memo): OpResult {
  const found = findNode(memo, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined || address.section === null) return { refusal: `"${node.label}" is not a section` }
  if (target.into !== undefined) return { refusal: `"${node.label}" moves only before or after a sibling section in its own parent` }
  const siblingId = target.before ?? target.after
  if (siblingId === undefined) return { refusal: `say where "${node.label}" goes: before or after a sibling section` }
  if (target.before !== undefined && target.after !== undefined) return { refusal: "give before or after, not both" }
  const siblingFound = findNode(memo, siblingId, found.memo)
  if (siblingFound === undefined) return { refusal: unknownRowRefusal(siblingId) }
  const sibling = siblingFound.node
  const siblingAddress = sibling.address
  if (siblingAddress === undefined || siblingAddress.section === null) return { refusal: `"${sibling.label}" is not a section` }
  if (
    siblingAddress.item !== address.item ||
    siblingAddress.agent !== address.agent ||
    siblingAddress.level !== address.level ||
    !sameTeam(siblingAddress.team, address.team) ||
    catalogueOf(siblingAddress.catalogue) !== catalogueOf(address.catalogue)
  )
    return { refusal: `"${node.label}" and "${sibling.label}" are in different items; sections move only within their own item` }

  const memberMemo = found.memo
  const chain = chainFor(memberMemo, node)
  if (chain === undefined) return { refusal: `Item not found for "${node.label}"` }
  const itemAddress: Address = { ...address, section: null }
  const whole = resolve({
    upstream: chain.upstream,
    records: chain.customizations,
    splits: chain.splits,
    scopes: memberMemo.ctx.scopes,
    address: itemAddress,
  })
  const hasManual = winningSplit(chain.splits, itemAddress, memberMemo.ctx.scopes) !== undefined
  // Assembly trims its final newline. Restore a separator before relocating a
  // final heading span, or its body would run into the next heading.
  const effectiveText = whole.fullText ?? whole.assembled
  const baseText = !hasManual ? `${effectiveText}\n` : whole.text
  const split = resolveSplit({
    text: baseText,
    title: chain.upstream.title,
    splits: chain.splits,
    scopes: memberMemo.ctx.scopes,
    address: itemAddress,
  })
  if (split.kind === "whole") return { refusal: `"${node.label}" has no sibling sections to reorder` }
  const moved = split.sections.find((section) => section.id === address.section)
  if (moved === undefined) return { refusal: `Section not found for "${node.label}"` }
  const anchor = split.sections.find((section) => section.id === siblingAddress.section)
  if (anchor === undefined) return { refusal: `Section not found for "${sibling.label}"` }
  const parents = parentIndexes(split.sections)
  const indexOf = new Map(split.sections.map((section, index) => [section.id, index]))
  const movedIndex = indexOf.get(moved.id)
  const anchorIndex = indexOf.get(anchor.id)
  if (movedIndex === undefined || anchorIndex === undefined || moved.id === anchor.id)
    return { refusal: `"${node.label}" cannot move beside "${sibling.label}"` }
  const parentIdOf = (index: number): string | null => {
    const parent = parents[index]
    return parent === undefined ? null : split.sections[parent].id
  }
  const parentId = parentIdOf(movedIndex)
  if (parentId !== parentIdOf(anchorIndex))
    return { refusal: `"${node.label}" is not a sibling of "${sibling.label}"; sections move only within the same parent` }

  const before = target.before !== undefined
  const where = `${before ? "before" : "after"} "${sibling.label}"`
  const status = `Moved "${node.label}" ${where}`

  if (split.kind !== "manual") {
    if (split.sections.some((section, index) => split.sections.some((other, otherIndex) =>
      otherIndex !== index && other.name === section.name && parents[index] === parents[otherIndex],
    ))) return { refusal: "Repeated sibling heading titles have occurrence-based identities; rename them before moving" }
    const parent = parentId === null ? undefined : split.sections.find((section) => section.id === parentId)
    const pStart = parent?.start ?? 0
    const pEnd = parent?.end ?? baseText.length
    const text = moveRawBlock(baseText, moved, anchor, before)
    const reordered = resolveSplit({ text, title: chain.upstream.title, splits: chain.splits, scopes: memberMemo.ctx.scopes, address: itemAddress })
    // Heading ids are occurrence-based. Refuse when reordering would attach an
    // existing id to different content (notably repeated sibling titles).
    if (split.sections.some((section, index) => {
      const nextIndex = reordered.sections.findIndex((entry) => entry.id === section.id)
      const next = reordered.sections[nextIndex]
      if (next === undefined) return true
      // Compare each heading's own body, not its reordered descendant span.
      const child = split.sections[index + 1]
      const nextChild = reordered.sections[nextIndex + 1]
      const end = child !== undefined && child.depth > section.depth ? child.start : section.end
      const nextEnd = nextChild !== undefined && nextChild.depth > next.depth ? nextChild.start : next.end
      return baseText.slice(section.start, end).trimEnd() !== text.slice(next.start, nextEnd).trimEnd()
    })) return { refusal: "Section heading identities would change on reorder; rename repeated headings before moving" }
    const parentText = parentId === null ? text : text.slice(pStart, pEnd)
    // Fold the same-level child texts the rewritten parent now contains, then
    // store the parent's span. A child at a more specific level survives and
    // still wins over the parent's copy (B39 rules 2 and 4).
    const consumed =
      parentId === null
        ? resolveSplit({ text: parentText, title: chain.upstream.title, splits: chain.splits, scopes: memberMemo.ctx.scopes, address: itemAddress }).sections.map(
            (section) => section.id,
          )
        : headingSpan(parentText, parent?.depth ?? 0).inner.map((child) => `${parentId}/${child.rel}`)
    let records = chain.customizations
    for (const id of consumed) records = dropSectionText(records, { ...address, section: id })
    records = merge(records, parentId === null ? itemAddress : { ...address, section: parentId }, { text: parentText }, chain.upstream, memberMemo.ctx.scopes, chain.splits)
    return { records, splits: chain.splits, status, retryHint: `moved "${node.label}" against a stale revision; retry to apply` }
  }

  // Manual split: move the effective block and shift every boundary by the same
  // offset map, so stable ids keep their content at their new positions.
  const winner = winningSplit(chain.splits, itemAddress, memberMemo.ctx.scopes)
  if (winner === undefined) return { refusal: `Section not found for "${node.label}"` }
  // Manual ids do not derive from headings. Use the rendered spans to fold
  // child edits without measuring boundaries against text of a different size.
  // A parent override can hide a manual child entirely: no safe span exists.
  const rendered = `${effectiveText}\n`
  const movedSpan = whole.spans?.get(moved.id)
  const anchorSpan = whole.spans?.get(anchor.id)
  if (movedSpan === undefined || anchorSpan === undefined || winner.boundaries.some((boundary) => !whole.spans?.has(boundary.id)))
    return { refusal: `"${node.label}" is hidden by a manual parent override; reset or edit that parent before moving its sections` }
  const movedBlock = { start: movedSpan.start, end: movedSpan.end === effectiveText.length ? rendered.length : movedSpan.end }
  const anchorBlock = { start: anchorSpan.start, end: anchorSpan.end === effectiveText.length ? rendered.length : anchorSpan.end }
  const length = movedBlock.end - movedBlock.start
  const rawInsert = before ? anchorBlock.start : anchorBlock.end
  const insert = rawInsert <= movedBlock.start ? rawInsert : rawInsert - length
  const text = moveRawBlock(rendered, movedBlock, anchorBlock, before)
  const boundaries = winner.boundaries.map((boundary) => ({
    id: boundary.id,
    name: boundary.name,
    start: mapMovedOffset(whole.spans!.get(boundary.id)!.start, movedBlock.start, movedBlock.end, insert),
    ...(boundary.depth === undefined ? {} : { depth: boundary.depth }),
  }))
  const records = merge(dropSectionText(chain.customizations, itemAddress), itemAddress, { text }, chain.upstream, memberMemo.ctx.scopes, chain.splits)
  const rest = chain.splits.filter((record) => !(record.item === itemAddress.item && scopedTo(record, address)))
  const splits: SplitRecord[] = [
    ...rest,
    {
      type: "split",
      level: address.level,
      agent: address.agent,
      ...(address.team !== undefined ? { team: address.team } : {}),
      ...catalogueField(address),
      item: address.item,
      boundaries,
      updated,
    },
  ]
  return { records, splits, status, retryHint: `moved "${node.label}" against a stale revision; retry to apply` }
}

// Move the block [block.start, block.end) of `text` immediately before or
// after `anchor` (both within the same parent), shifting the offsets between.
function moveRawBlock(text: string, block: { readonly start: number; readonly end: number }, anchor: { readonly start: number; readonly end: number }, before: boolean): string {
  const raw = text.slice(block.start, block.end)
  const without = text.slice(0, block.start) + text.slice(block.end)
  const at = (before ? anchor.start : anchor.end) <= block.start ? (before ? anchor.start : anchor.end) : (before ? anchor.start : anchor.end) - (block.end - block.start)
  return without.slice(0, at) + raw + without.slice(at)
}

// Where an offset lands after [start, end) moved to `insert` (an index into
// the text with the block removed). Offsets inside the block travel with it.
function mapMovedOffset(offset: number, start: number, end: number, insert: number): number {
  if (offset >= start && offset < end) return insert + (offset - start)
  const shifted = offset >= end ? offset - (end - start) : offset
  return shifted < insert ? shifted : shifted + (end - start)
}

function winningSplit(splits: readonly SplitRecord[], address: Address, scopes: Scopes): SplitRecord | undefined {
  return resolutionChain(address, scopes)
    .map((node) => splits.find((split) => split.item === address.item && scopedTo(split, node)))
    .find((split) => split !== undefined)
}

// The display token a row contributes to an ordered list: an item id, a
// `folder:<id>` ref, or an owner row id (an agent, a team, a team member).
// Built-in group headings and tab groups have none, so they cannot move.
export function listToken(node: Pick<TreeNode, "id" | "kind" | "address">): string | undefined {
  if (node.kind === "section" && node.address?.section === null) return undefined
  if (node.address !== undefined) return node.address.section === null ? node.address.item : undefined
  const at = node.id.indexOf(FOLDER_MARK)
  if (at !== -1) return folderRef(node.id.slice(at + FOLDER_MARK.length))
  return node.kind === "agent" || node.kind === "team" ? node.id : undefined
}

/**
 * Reorder a row or owner within a non-tab list group (a tab's origin subgroup
 * or a sidebar catalogue list), recorded as a `group:<id>` order. No folders
 * and no nesting: the row keeps its group and only changes its place among its
 * siblings. Built-in group headings have no token and refuse.
 */
export function planGroupMove(
  memo: MemoInput,
  layout: LayoutRecords,
  rowId: string,
  target: RowTarget,
  updated: string,
  sharedMemo?: Memo,
): LayoutChange {
  const active = sharedMemo ?? buildTreeMemo(memo)
  const path = lazyPath(active, rowId)
  const node = path.at(-1)
  if (node === undefined) return { refusal: unknownRowRefusal(rowId) }
  if (node.address !== undefined && node.address.section !== null) return { refusal: `"${node.label}" is a section; moving sections is not supported yet` }
  const token = listToken(node)
  if (token === undefined) return { refusal: `"${node.label}" is built-in structure and cannot move` }
  if (target.into !== undefined) return { refusal: `"${node.label}" reorders in its own list; it cannot enter a folder here` }
  if (target.before !== undefined && target.after !== undefined) return { refusal: "give before or after, not both" }
  const siblingId = target.before ?? target.after
  if (siblingId === undefined) return { refusal: "say where it goes: before or after a row" }
  if (siblingId === rowId) return { refusal: `"${node.label}" cannot go beside itself` }
  const siblingPath = lazyPath(active, siblingId)
  const sibling = siblingPath.at(-1)
  if (sibling === undefined) return { refusal: unknownRowRefusal(siblingId) }
  const parent = path.at(-2)
  const siblingParent = siblingPath.at(-2)
  if (parent === undefined || siblingParent === undefined || parent.id !== siblingParent.id)
    return { refusal: `"${sibling.label}" is not in the same list` }
  if (rowToken(parent) !== undefined) return { refusal: `"${node.label}" moves through its tab's folders` }
  const anchor = listToken(sibling)
  if (anchor === undefined) return { refusal: `"${sibling.label}" cannot be a destination` }
  const siblings = parent.children().flatMap((child) => {
    const entry = listToken(child)
    return entry === undefined ? [] : [entry]
  })
  const without = siblings.filter((entry) => entry !== token)
  const index = without.indexOf(anchor)
  if (index === -1) return { refusal: `"${sibling.label}" is not in the same list` }
  const insertAt = target.after === undefined ? index : index + 1
  const items = [...without.slice(0, insertAt), token, ...without.slice(insertAt)]
  return {
    target: token,
    status: `Moved "${node.label}" ${target.after === undefined ? "before" : "after"} "${sibling.label}"`,
    layout: { folders: layout.folders, orders: setOrderScope(layout.orders, groupScope(parent.id), items, updated) },
  }
}

// A folder created in a tab's top level or inside a folder, listed last there.
export function planFolderCreate(memo: MemoInput, layout: LayoutRecords, rowId: string, name: string, updated: string, sharedMemo?: Memo): LayoutChange {
  const trimmed = name.trim()
  if (trimmed === "") return { refusal: "a folder needs a name" }
  const path = lazyPath(sharedMemo ?? buildTreeMemo(memo), rowId.endsWith(":system") ? `${rowId}:instructions` : rowId)
  const node = path.at(-1)
  if (node === undefined) return { refusal: unknownRowRefusal(rowId) }
  // Origin subgroups are presentation headings; Add Folder belongs to their tab.
  const tabRow = path.slice(0, -1).findLast((row) => rowToken(row)?.startsWith("tab:"))
  const container = node.kind === "group" && rowToken(node) === undefined && tabRow !== undefined ? tabRow : node
  const token = rowToken(container)
  const folderId = token === undefined ? undefined : folderIdOfRef(token)
  const parent = folderId === undefined ? undefined : folderOf(layout.folders, folderId)
  const tab = token?.startsWith("tab:") === true ? token.slice("tab:".length) : parent?.tab
  if (tab === undefined) return { refusal: `"${node.label}" is not a tab or folder` }
  const owner = parent === undefined ? container.id : container.id.split(FOLDER_MARK)[0]!
  const local = ownerLayout(layout, owner)
  const created = splitLayout(
    createFolderRecord([...local.folders, ...local.orders], { tab, name: trimmed, owner, ...(parent === undefined ? {} : { parent: folderIdOfRef(local.token(folderRef(parent.id)))! }) }, updated),
  )
  const folder = created.folders.at(-1)
  if (folder === undefined) return { refusal: "the folder was not created" }
  const orders =
    parent === undefined ? setOrder(created.orders, tab, [...container.children().flatMap((row) => { const token = rowToken(row); return token === undefined ? [] : [local.token(token)] }), folderRef(folder.id)], updated) : created.orders
  return { target: folderRef(folder.id), status: `Created folder "${folder.name}" in ${tab}`, layout: local.finish({ folders: created.folders, orders }, updated) }
}

export function planFolderRename(layout: LayoutRecords, id: string, name: string, updated: string, owner?: string): LayoutChange {
  if (owner !== undefined) {
    const local = ownerLayout(layout, owner)
    const plan = planFolderRename(local, folderIdOfRef(local.token(folderRef(id)))!, name, updated)
    return "refusal" in plan ? plan : { ...plan, layout: local.finish(plan.layout, updated) }
  }
  const folder = folderOf(layout.folders, id)
  const trimmed = name.trim()
  if (folder === undefined) return { refusal: `folder "${id}" does not exist` }
  if (trimmed === "") return { refusal: "a folder needs a name" }
  const next = splitLayout(renameFolderRecord([...layout.folders, ...layout.orders], id, trimmed, updated))
  return { target: folderRef(id), status: `Renamed folder "${folder.name}" to "${trimmed}"`, layout: next }
}

// A deleted folder's rows and child folders take its place in the list it sat in.
export function planFolderDelete(layout: LayoutRecords, id: string, updated: string, owner?: string): LayoutChange {
  if (owner !== undefined) {
    const local = ownerLayout(layout, owner)
    const plan = planFolderDelete(local, folderIdOfRef(local.token(folderRef(id)))!, updated)
    return "refusal" in plan ? plan : { ...plan, layout: local.finish(plan.layout, updated) }
  }
  const folder = folderOf(layout.folders, id)
  if (folder === undefined) return { refusal: `folder "${id}" does not exist` }
  const where = folder.parent === undefined ? `the top level of ${folder.tab}` : `folder "${folderOf(layout.folders, folder.parent)?.name ?? folder.parent}"`
  const next = splitLayout(deleteFolderRecord([...layout.folders, ...layout.orders], id, updated))
  return { target: folderRef(id), status: `Deleted folder "${folder.name}"; its rows returned to ${where}`, layout: next }
}

export interface OpSuccess {
  readonly records: CustomizationRecord[]
  readonly splits: SplitRecord[]
  readonly models?: readonly ModelRecord[]
  /** The op's complete rowlink list, when it changed links (the legacy `requires` adapter). */
  readonly rowlinks?: readonly RowlinkRecord[]
  readonly status: string
  readonly retryHint: string
  /** Set when the write is saved but the assembled text does not send it (B25): names the row that replaces it. */
  readonly notice?: string
}

export interface OpFailure {
  readonly refusal: string
}

export type OpResult = OpSuccess | OpFailure

export interface ModelOpSuccess {
  readonly models: ModelRecord[]
  readonly records?: CustomizationRecord[]
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
      readonly scope: "project" | "global" | "defaults" | "preset"
      readonly preset?: string
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
      // A user preset; the server refuses it while any existing row links to
      // it and removes orphan links of gone owners with it.
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

function findNode(input: MemoInput, rowId: string, sharedMemo?: Memo): { memo: Memo; node: TreeNode } | undefined {
  const active = sharedMemo ?? memoOfInput(input)
  const lazy = findLazy(active, rowId)
  if (lazy === undefined) {
    const node = controlRow(active, rowId)
    return node === undefined ? undefined : { memo: active, node }
  }
  return { memo: active, node: materialize(lazy) }
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

function entityControlId(memo: Memo, node: TreeNode, item: string): string | undefined {
  if (node.kind === "agent") return node.id.replace(/^agent:/, "item:") + `:${item}`
  if (node.kind !== "team") return undefined
  const owner = node.owner
  if (owner !== undefined) {
    if (owner.agent === null || owner.team === undefined || node.id !== `team:${owner.level}:${owner.team.team}:${owner.agent}`) return undefined
    return `item:${owner.level}:${owner.team.team}/:${owner.agent}:${item}`
  }
  if (memo.ctx.teams.some((team) => node.id === `team:${team.level}:${team.team}`)) return undefined
  const special = /^team:(project|global|defaults):(.+):special:([^:]+)$/.exec(node.id)
  if (special !== null && memo.ctx.teams.some((team) => team.level === special[1] && team.team === special[2]))
    return `item:${special[1]}:${special[2]}/:special:${special[3]}:${item}`
  const team = memo.ctx.teams.find((team) => team.agents.some((member) => node.id === `team:${team.level}:${team.team}:${member}`))
  return team === undefined ? undefined : `item:${team.level}:${team.team}/:${node.label}:${item}`
}

export function setAgentMode(input: MemoInput, rowId: string, mode: "primary" | "subagent" | "all", sharedMemo?: Memo): OpResult {
  const found = findNode(input, rowId, sharedMemo)
  const id = found === undefined ? undefined : entityControlId(found.memo, found.node, "setting:mode")
  return id === undefined ? { refusal: `"${rowId}" is not an agent or member` } : saveText(input, id, mode, sharedMemo)
}

/** Concrete control writes and implicit field changes, checked by execute.before. */
export function instructionControlInputs(input: MemoInput, tool: string, value: unknown, sharedMemo?: Memo): Readonly<Record<string, unknown>>[] {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") return []
  const fields = value as Record<string, unknown>
  const found = findNode(input, value.id, sharedMemo)
  if (found === undefined) return []
  if (tool === "instructions_set" && fields.preset === undefined && found.node.address?.item === "setting:mode")
    return [{ ...fields, mode: fields.text ?? true }]
  const enabledId = entityControlId(found.memo, found.node, "setting:enabled")
    ?? (found.node.address !== undefined && booleanControl(found.node.address.item) ? value.id : undefined)
  if (enabledId === undefined) return []
  if (tool === "instructions_reset") {
    const plan = reset(input, value.id, sharedMemo)
    if ("refusal" in plan) return []
    return found.memo.ctx.customizations
      .filter((record) => !plan.records.some((remaining) => sameAddress(remaining, record)))
      .map((record) => ({ id: entityControlId(found.memo, found.node, record.item) ?? value.id }))
  }
  if (tool !== "instructions_set" || fields.preset !== undefined) return []
  const mode = fields.mode === undefined ? [] : [{ ...fields, id: entityControlId(found.memo, found.node, "setting:mode"), text: fields.mode }]
  const toggles = fields.state !== undefined || [fields.mode, fields.text, fields.pin, fields.resolve].every((field) => field === undefined)
  if (!toggles) return mode
  const plan = fields.state === undefined ? toggle(input, value.id, sharedMemo) : setEnabled(input, value.id, fields.state === "on", sharedMemo)
  const address = controlRow(found.memo, enabledId)?.address
  if ("refusal" in plan || address === undefined) return mode
  const state = plan.records.find((record) => sameAddress(record, address))?.state
  return [...mode, { ...fields, id: enabledId, state }]
}

/** One row by id, found by descending the lazy tree (no full expansion). */
export function findRow(input: MemoInput, rowId: string, sharedMemo?: Memo): TreeNode | undefined {
  return findNode(input, rowId, sharedMemo)?.node
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
  readonly team?: TeamRef
  readonly memberOf?: TeamRef
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
      sameTeam(candidate.address.team, address.team) &&
      (address.memberOf === undefined || sameTeam(candidate.address.memberOf, address.memberOf)) &&
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
    if (node.address.item.startsWith("param:")) return `"${node.label}" is required by its tool and cannot be switched off`
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
    JSON.stringify(left.requires) === JSON.stringify(right.requires) &&
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

// ── write-time switches (B9, B10) ─────────────────────────────────────────
//
// An `either` rowlink is a durable on/off relationship: turning the
// primary on saves the connected rows off *in the same save*, like exclusive
// models and teams, so a request never evaluates it. `either` fires from
// whichever end turns on. One hop only: the
// rows it turns off do not fire their own links (B10). Only the effective
// links fire — `switchedOff` reads the same nearest-level/tombstone answer the
// link tool reports, so an upstream switch masked at this level does nothing.
// A connected row owned by a protected agent refuses the whole write before
// any record changes (`isProtected`, supplied by the tool actor only).

type SwitchResult = { readonly records: CustomizationRecord[]; readonly models?: ModelRecord[]; readonly disabled: readonly string[] } | { readonly refusal: string }

function applySwitches(
  memo: Memo,
  chain: { readonly address: Address; readonly customizations: CustomizationRecord[] },
  records: CustomizationRecord[],
  on: boolean,
  isProtected?: (owner: string | null) => boolean,
  models: readonly ModelRecord[] = memo.ctx.models,
): SwitchResult {
  if (!on) return { records, disabled: [] }
  const targets = switchedOff(
    memo.ctx.scopes.rowlinks ?? [],
    memo.ctx.scopes,
    chain.address,
    { item: chain.address.item, section: chain.address.section },
  )
  if (targets.length === 0) return { records, disabled: [] }
  if (isProtected?.(chain.address.agent) === true)
    return { refusal: `agent.protected: row belongs to protected agent "${chain.address.agent}"; turning this on would disable a linked row` }
  let out = records
  let modelOut = models
  const disabled: string[] = []
  for (const endpoint of targets) {
    const address = { ...chain.address, item: endpoint.item, section: endpoint.section }
    if (isControl(endpoint.item) && !booleanControl(endpoint.item))
      return { refusal: `Linked row "${endpoint.item}" has no switch state` }
    const model = modelTargetOf(address)
    if (model !== undefined && endpoint.section === null) {
      const active = effectiveModelAt(memo, address, modelOut)
      if (active === undefined || !sameModelCandidate(active, model)) continue
      modelOut = deactivateModel(modelOut, modelScopeOf(address), model, now(), memo.ctx.scopes)
      disabled.push(endpoint.item)
      continue
    }
    const upstream = upstreamFor(memo.ctx.items, address)
    if (upstream === undefined) return { refusal: `Linked row "${endpoint.item}" cannot be switched` }
    // Already off (by inheritance or an earlier row): writing an off record
    // would be noise, and an off toggle never writes a linked row at all.
    if (!resolve({ upstream, records: out, splits: memo.ctx.splits, scopes: memo.ctx.scopes, address }).enabled) continue
    out = merge(out, address, { state: "off" }, upstream, memo.ctx.scopes)
    disabled.push(endpoint.item)
  }
  return { records: out, ...(modelOut === models ? {} : { models: [...modelOut] }), disabled }
}

// Shared completion boundary for Space, picks and automatic creation. Compute
// against the pre-activation memo, then persist both record kinds together.
export function switchModelActivation(input: MemoInput, address: Address, target: ModelCandidate | { providerID: string; modelID: string; variant?: string }, models: ModelRecord[], isProtected?: (owner: string | null) => boolean, sharedMemo?: Memo): SwitchResult {
  const memo = sharedMemo ?? memoOfInput(input)
  const active = effectiveModelAt(memo, address, modelsOfInput(input))
  const selected = effectiveModelAt(memo, address, models)
  const records = customizationsOfInput(input)
  return applySwitches(memo, { address, customizations: records }, records,
    selected !== undefined && sameModelCandidate(selected, target) && (active === undefined || !sameModelCandidate(active, target)), isProtected, models)
}

export function toggle(input: MemoInput, rowId: string, sharedMemo?: Memo, isProtected?: (owner: string | null) => boolean): OpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const control = entityControlId(found.memo, node, "setting:enabled")
  if (control !== undefined) return toggle(input, control, sharedMemo, isProtected)
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
  const turnedOn = !resolved.enabled
  const switched = applySwitches(memo, chain, next, turnedOn, isProtected)
  if ("refusal" in switched) return switched
  const suffix = switched.disabled.length === 0 ? "" : `; disabled ${switched.disabled.join(", ")}`
  return {
    records: switched.records,
    ...(switched.models === undefined ? {} : { models: switched.models }),
    splits: chain.splits,
    status: `${resolved.enabled ? `Disabled "${node.label}"` : `Enabled "${node.label}"`}${suffix}`,
    retryHint: `toggled "${node.label}" against a stale revision; retry to apply`,
  }
}

export function setEnabled(
  input: MemoInput,
  rowId: string,
  value: boolean,
  sharedMemo?: Memo,
  isProtected?: (owner: string | null) => boolean,
): OpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const control = entityControlId(found.memo, node, "setting:enabled")
  if (control !== undefined) return setEnabled(input, control, value, sharedMemo, isProtected)
  const memo = found.memo
  const refusal = toggleRefusal(node)
  if (refusal !== undefined) return { refusal }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  const next = merge(chain.customizations, chain.address, { state: value ? "on" : "off" }, chain.upstream, memo.ctx.scopes)
  // Switches fire only on an actual off→on transition, exactly as `toggle`
  // does: an explicit `state:"on"` on an already-on row writes nothing new.
  const wasOn = resolve({
    upstream: chain.upstream,
    records: chain.customizations,
    splits: chain.splits,
    scopes: memo.ctx.scopes,
    address: chain.address,
  }).enabled
  const switched = applySwitches(memo, chain, next, value && !wasOn, isProtected)
  if ("refusal" in switched) return switched
  const suffix = switched.disabled.length === 0 ? "" : `; disabled ${switched.disabled.join(", ")}`
  const existing = chain.customizations.find((record) => sameAddress(record, chain.address))
  const created = switched.records.find((record) => sameAddress(record, chain.address))
  if (
    switched.disabled.length === 0 &&
    existing !== undefined &&
    created !== undefined &&
    customizationsEqualWithoutUpdated(existing, created)
  )
    return {
      records: chain.customizations,
      splits: chain.splits,
      status: value ? `Enabled "${node.label}"` : `Disabled "${node.label}"`,
      retryHint: `toggled "${node.label}" against a stale revision; retry to apply`,
    }
  return {
    records: switched.records,
    splits: chain.splits,
    status: `${value ? `Enabled "${node.label}"` : `Disabled "${node.label}"`}${suffix}`,
    ...(switched.models === undefined ? {} : { models: switched.models }),
    retryHint: `toggled "${node.label}" against a stale revision; retry to apply`,
  }
}

// Space on a group row turns its nearest toggleable rows on or off in one
// write: all of its rows on means all off, otherwise (some or none on) all
// on, unless `target` names the state explicitly (the agent tool's
// `set {id, state}`). Every row merges through the same per-row logic as
// `toggle`/`setEnabled`, in sequence on the accumulated records, so one
// result carries every row's change. Rows that refuse (a protected agent, a
// row `toggleRefusal` refuses) are skipped and named; when every row refuses
// the op refuses. Team rows cannot be expressed as record toggles (teams use
// `team.setEnabled`), so a group holding teams refuses and names the team
// path instead.
export function toggleGroup(
  input: MemoInput,
  groupId: string,
  sharedMemo?: Memo,
  target?: boolean,
  isProtected?: (agent: string) => boolean,
): OpResult {
  const memo = sharedMemo ?? memoOfInput(input)
  const lazy = findLazy(memo, groupId)
  if (lazy === undefined || lazy.kind !== "group") return { refusal: unknownRowRefusal(groupId) }
  const label = materialize(lazy).label
  const found = groupToggleRows(lazy)
  if (found.hasTeam) return { refusal: `"${label}" holds teams: enable teams one by one` }
  // The same gate the tree uses for the row's toggle action: model-only,
  // permission-only and section-only groups (a tool's Description group)
  // carry no group toggle.
  if (!groupToggleOf(lazy).toggle) return { refusal: `"${label}" has no toggleable rows` }
  const rows = found.rows.flatMap((leaf) => {
    const row = findNode(input, leaf.enabledRow ?? leaf.id, memo)
    if (row === undefined) return []
    const state = row.node.badges.state
    // Name the entity the row stands for (an agent, not its Enabled
    // control), so skipped rows read `"alpha" — protected`.
    return state === "on" || state === "off" ? [{ node: row.node, label: materialize(leaf).label, on: state === "on" }] : []
  })
  if (rows.length === 0) return { refusal: `"${label}" has no toggleable rows` }
  const want = target ?? !rows.every((row) => row.on)
  let records = [...memo.ctx.customizations]
  let models = [...memo.ctx.models]
  const splits = [...memo.ctx.splits]
  const skipped: string[] = []
  let applied = 0
  for (const row of rows) {
    const agent = groupRowAgent(row.node)
    if (agent !== undefined && isProtected?.(agent) === true) {
      skipped.push(`"${row.label}" — protected`)
      continue
    }
    const address = row.node.address
    if (address === undefined) {
      skipped.push(`"${row.label}" — "${row.label}" cannot be toggled`)
      continue
    }
    const refusal = toggleRefusal(row.node)
    if (refusal !== undefined) {
      skipped.push(`"${row.label}" — ${refusal}`)
      continue
    }
    const upstream = upstreamFor(memo.ctx.items, address)
    if (upstream === undefined) {
      skipped.push(`"${row.label}" — Item not found for "${row.label}"`)
      continue
    }
    // The chain context makes merge record what the chain above resolves,
    // exactly as `toggle` does for one row.
    const wasOn = resolve({ upstream, records, splits, scopes: memo.ctx.scopes, address }).enabled
    const next = merge(records, address, { state: want ? "on" : "off" }, upstream, memo.ctx.scopes)
    const switched = applySwitches(memo, { address, customizations: records }, next, want && !wasOn,
      (owner) => owner !== null && isProtected?.(owner) === true, models)
    if ("refusal" in switched) return switched
    records = switched.records
    models = switched.models ?? models
    applied += 1
  }
  if (applied === 0) return { refusal: skipped[0] ?? `"${label}" has no toggleable rows` }
  return {
    records,
    splits,
    status: `${want ? "Enabled" : "Disabled"} ${applied} row${applied === 1 ? "" : "s"} in "${label}"${skipped.length === 0 ? "" : ` (skipped: ${skipped.join(", ")})`}`,
    models,
    retryHint: `toggled "${label}" against a stale revision; retry to apply`,
  }
}

// The agent a row belongs to for the tool actor's protected check (tools.ts
// `protectedOf`): presets are never protected, entities answer by id.
function groupRowAgent(node: TreeNode): string | undefined {
  if (node.owner?.level === "preset" || node.address?.level === "preset") return undefined
  if (node.kind === "agent") {
    const agent = node.id.split(":").slice(2).join(":")
    return agent === "" ? undefined : agent
  }
  return node.address?.agent ?? node.owner?.agent ?? undefined
}

export function setPin(input: MemoInput, rowId: string, value: boolean, sharedMemo?: Memo): OpResult {
  const found = findNode(input, rowId, sharedMemo)
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

// ── "shown when": a system row's or section's condition (requires.ts) ─────

const CONDITION_ID = /^!?(tool|skill|mcp|perm):\S+$/

/** One row a condition can name, for a picker: its id, label and kind of row. */
export interface ConditionChoice {
  readonly id: string
  readonly label: string
  readonly group: "Tools" | "Skills" | "MCP servers" | "Rules"
  /** Rules: the tool whose permission it is. */
  readonly tool?: string
}

/** The rows a condition can name: tools, skills, MCP servers and permission rows, once each. */
export function conditionChoices(memo: Memo): ConditionChoice[] {
  const seen = new Set<string>()
  const out: ConditionChoice[] = []
  for (const item of memo.ctx.items) {
    if (seen.has(item.id)) continue
    const group =
      item.kind === "tool" && item.execute !== true
        ? "Tools"
        : item.kind === "skill"
          ? "Skills"
          : item.kind === "mcp"
            ? "MCP servers"
            : item.kind === "perm" && item.policy === undefined
              ? "Rules"
              : undefined
    if (group === undefined) continue
    seen.add(item.id)
    out.push({ id: item.id, label: item.title, group, ...(item.permTool === undefined ? {} : { tool: item.permTool }) })
  }
  return out.toSorted((left, right) => left.group.localeCompare(right.group) || left.id.localeCompare(right.id))
}

// Up to five row ids a mistyped one probably meant: same kind, and either
// containing what was typed or within two edits of it.
function nearIds(wanted: string, known: ReadonlySet<string>): string[] {
  const kind = wanted.slice(0, wanted.indexOf(":") + 1)
  const name = wanted.slice(kind.length)
  return [...known]
    .filter((candidate) => candidate.startsWith(kind))
    .map((candidate) => ({ candidate, distance: candidate.includes(name) ? 0 : editDistance(candidate.slice(kind.length), name) }))
    .filter((entry) => entry.distance <= 2)
    .toSorted((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
    .slice(0, 5)
    .map((entry) => entry.candidate)
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[right.length]!
}

/** A condition in words: `tool:x on and perm:shell:git-push off`. */
export function describeCondition(ids: readonly string[]): string {
  if (ids.length === 0) return "always"
  return ids.map((id) => (id.startsWith("!") ? `${id.slice(1)} off` : `${id} on`)).join(" and ")
}

/**
 * Set when a system row or section is sent: `ids` are row ids that must be on
 * (`!id`: off), an empty list sends it always, null drops this level's
 * condition so the level above (or the section's own line) decides again.
 * Every id must name a row that exists, so a typo cannot silently hide text.
 */
export function setRequires(input: MemoInput, rowId: string, ids: readonly string[] | null, sharedMemo?: Memo): OpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  if (node.actions?.requires !== true)
    return {
      refusal: `"${node.label}" cannot be sent conditionally: only system rows (instruction files, Tools and rules; not Role/persona as a whole) and the sections of system rows can`,
    }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }
  const value = ids === null ? null : [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))]
  if (value !== null) {
    const known = new Set(memo.ctx.items.map((item) => item.id))
    for (const id of value) {
      if (!CONDITION_ID.test(id))
        return { refusal: `"${id}" is not a row id: use tool:<id>, skill:<id>, mcp:<server> or perm:<tool>:<rule>, with ! for "must be off"` }
      const bare = id.replace(/^!/, "")
      if (!known.has(bare)) {
        const near = nearIds(bare, known)
        return { refusal: `no row "${bare}" exists${near.length === 0 ? "" : `; did you mean ${near.join(", ")}?`}` }
      }
      if (value.includes(id.startsWith("!") ? bare : `!${bare}`)) return { refusal: `"${bare}" cannot be required both on and off` }
    }
  }
  // Compatibility adapter (B43): the stored condition is a rowlink list for
  // the target at this level, not a customization field, so the two authorities
  // cannot disagree on reload. The customization records pass through
  // unchanged; `value` was validated above.
  const updated = new Date().toISOString()
  const rowlinks = requiresGateRecords(
    memo.ctx.scopes.rowlinks ?? [],
    chain.address,
    { item: chain.address.item, section: chain.address.section },
    value,
    updated,
  )
  const status =
    value === null ? `"${node.label}" is sent as the level above or its text says` : `"${node.label}" is sent ${value.length === 0 ? "always" : `when ${describeCondition(value)}`}`
  return { records: chain.customizations, splits: chain.splits, rowlinks, status, retryHint: `set when "${node.label}" is sent against a stale revision; retry to apply` }
}

export function saveText(input: MemoInput, rowId: string, text: string, sharedMemo?: Memo): OpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const refusal = editRefusal(node)
  if (refusal !== undefined) return { refusal }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }

  if (chain.address.section === null) {
    const newSplit = derive(text, chain.upstream.title)

    if (newSplit.kind !== "whole") {
      const currentText = resolvedTextOf(memo, chain)
      const currentSplit = resolveSplit({
        text: currentText,
        title: chain.upstream.title,
        splits: chain.splits,
        scopes: memo.ctx.scopes,
        address: chain.address,
      })

      // Section patches cannot replace a local whole-span baseline: clearing
      // it before comparing unchanged sections loses their authored text.
      // Keep that span (folding local section text into the submitted whole
      // text), as we do when creating a new heading skeleton.
      // Manual boundaries retain their existing section-edit contract.
      if (
        currentSplit.kind !== "manual" &&
        (chain.customizations.some((record) => record.text !== undefined && sameAddress(record, chain.address)) ||
          currentSplit.sections.length !== newSplit.sections.length ||
          currentSplit.sections.some((section, index) => section.id !== newSplit.sections[index]?.id))
      ) {
        const records = chain.customizations.reduce(
          (out, record) =>
            record.section !== null && record.text !== undefined && sameAddress(record, { ...chain.address, section: record.section })
              ? merge(out, { ...chain.address, section: record.section }, { text: null }, chain.upstream, memo.ctx.scopes, chain.splits)
              : out,
          chain.customizations,
        )
        return {
          records: merge(records, chain.address, { text }, chain.upstream, memo.ctx.scopes, chain.splits),
          splits: chain.splits,
          status: `Saved "${node.label}"`,
          retryHint: `saved "${node.label}" against a stale revision; retry to apply`,
        }
      }

      let customizations = chain.customizations
      customizations = merge(customizations, chain.address, { text: null }, chain.upstream, memo.ctx.scopes, chain.splits)

      for (const sec of newSplit.sections) {
        const newSecText = slice(text, sec)
        const prevSec = currentSplit.sections.find((s) => s.id === sec.id)
        const prevSecText = prevSec !== undefined ? slice(currentText, prevSec) : undefined
        if (prevSecText === undefined || newSecText.trimEnd() !== prevSecText.trimEnd()) {
          const upstreamSecText = upstreamForEdit({
            upstream: chain.upstream,
            records: customizations,
            splits: chain.splits,
            scopes: memo.ctx.scopes,
            address: { ...chain.address, section: sec.id },
          })
          if (newSecText.trimEnd() === upstreamSecText.trimEnd()) {
            customizations = merge(customizations, { ...chain.address, section: sec.id }, { text: null }, chain.upstream, memo.ctx.scopes, chain.splits)
          } else {
            customizations = merge(customizations, { ...chain.address, section: sec.id }, { text: newSecText }, chain.upstream, memo.ctx.scopes, chain.splits)
          }
        }
      }

      for (const prevSec of currentSplit.sections) {
        if (!newSplit.sections.some((s) => s.id === prevSec.id)) {
          customizations = merge(customizations, { ...chain.address, section: prevSec.id }, { text: "" }, chain.upstream, memo.ctx.scopes, chain.splits)
        }
      }

      return {
        records: customizations,
        splits: chain.splits,
        status: `Saved "${node.label}"`,
        retryHint: `saved "${node.label}" against a stale revision; retry to apply`,
      }
    } else {
      chain.customizations = chain.customizations.reduce(
        (out, record) =>
          record.section !== null && record.text !== undefined && sameAddress(record, { ...chain.address, section: record.section })
            ? merge(out, { ...chain.address, section: record.section }, { text: null }, chain.upstream, memo.ctx.scopes, chain.splits)
            : out,
        chain.customizations,
      )
    }
  }

  // The chain context and splits make the baseline the text above this row
  // (a preset's or a default's), not the raw upstream: an agent whose preset
  // supplies the text is not "to review" the moment it saves its own.
  const next = merge(chain.customizations, chain.address, { text }, chain.upstream, memo.ctx.scopes, chain.splits)
  const existing = chain.customizations.find((record) => sameAddress(record, chain.address))
  const created = next.find((record) => sameAddress(record, chain.address))
  const unchanged = existing !== undefined && created !== undefined && customizationsEqualWithoutUpdated(existing, created)
  const records = unchanged ? chain.customizations : withoutInnerChildren(memo, chain, next, text)
  const notice = hiddenNotice(memo, chain, records)
  return {
    records,
    splits: chain.splits,
    status: notice ?? `Saved "${node.label}"`,
    retryHint: `saved "${node.label}" against a stale revision; retry to apply`,
    ...(notice === undefined ? {} : { notice }),
  }
}

// A parent section's text now holds the child sections inside its span: the
// child texts saved at this same level are dropped, so the parent's edit is
// not undone by an older child record (B39 rule 4). Children saved at a more
// specific level stay.
function withoutInnerChildren(
  memo: Memo,
  chain: { address: Address; upstream: Item; customizations: CustomizationRecord[]; splits: SplitRecord[] },
  records: CustomizationRecord[],
  text: string,
): CustomizationRecord[] {
  const sectionId = chain.address.section
  if (sectionId === null) return records
  const itemText = resolve({
    upstream: chain.upstream,
    records: chain.customizations,
    splits: chain.splits,
    scopes: memo.ctx.scopes,
    address: { ...chain.address, section: null },
  }).text
  const depth = resolveSplit({
    text: itemText,
    title: chain.upstream.title,
    splits: chain.splits,
    scopes: memo.ctx.scopes,
    address: chain.address,
  }).sections.find((section) => section.id === sectionId)?.depth ?? 0
  return headingSpan(text, depth).inner.reduce((out, child) => {
    const address: Address = { ...chain.address, section: `${sectionId}/${child.rel}` }
    const stored = out.some((record) => record.text !== undefined && sameAddress(record, address))
    return stored ? merge(out, address, { text: null }, chain.upstream, memo.ctx.scopes, chain.splits) : out
  }, records)
}

// B25: a section write that the assembled text does not send says so, naming
// the row that replaces it. A shared (Defaults) write is checked for every
// agent the item applies to, since it reaches each of them. Read from the same
// resolution the assembly uses.
function hiddenNotice(
  memo: Memo,
  chain: { address: Address; upstream: Item; customizations: CustomizationRecord[]; splits: SplitRecord[] },
  records: readonly CustomizationRecord[],
): string | undefined {
  const sectionId = chain.address.section
  if (sectionId === null) return undefined
  // An agent sees its own text from Project down, so a Defaults or Global write
  // is checked there: a Project copy hides it even though the write's own chain
  // does not include Project.
  const viewers: Address[] =
    chain.address.agent === null
      ? memo.ctx.agents.filter((agent) => applies(chain.upstream, agent.id)).map((agent) => ({ ...chain.address, level: "project", agent: agent.id }))
      : [{ ...chain.address, level: "project" }]
  return viewers.flatMap((address): string[] => {
    const shadow = shadowOf({ upstream: chain.upstream, records, splits: chain.splits, scopes: memo.ctx.scopes, address }, sectionId)
    const node = shadow === undefined ? undefined : resolutionChain(address, memo.ctx.scopes)[shadow.rank]
    if (shadow === undefined || node === undefined) return []
    const owner = node.team !== undefined && node.agent !== null ? `${node.team.team}/:${node.agent}` : (node.agent ?? (node.catalogue === "teams" ? "/teams" : ""))
    const label = shadow.by === null ? chain.upstream.title : shadow.name
    const row = shadow.by === null ? `item:${node.level}:${owner}:${chain.address.item}` : `section:${node.level}:${owner}:${chain.address.item}:${shadow.by}`
    return [`Saved, but "${label}" (${row}) at ${levelNames[node.level]} replaces this text; edit or reset that row for this change to take effect.`]
  })[0]
}

const levelNames: Record<Level, string> = { project: "Project", global: "Global", defaults: "Defaults", preset: "Preset" }

export function reset(input: MemoInput, rowId: string, sharedMemo?: Memo): OpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const control = entityControlId(memo, node, "setting:enabled")
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
    const hasStored = canReset(chain.customizations, chain.address)
    return {
      refusal: hasStored
        ? `"${node.label}" cannot be reset; set state "on" to clear the stored override`
        : `"${node.label}" has no override to reset`,
    }
  }
  // Clear through merge's removal path (null fields drop the record) so row
  // identity stays in merge's sameNode check instead of a second filter.
  let next = merge(
    chain.customizations,
    chain.address,
    { text: null, state: null, pin: null, acknowledged: null },
    chain.upstream,
  )
  if (chain.address.section === null) {
    next = resetModelRecords(next, chain.address)
  }
  // A local "shown when" list is a rowlink override too: reset drops it, so
  // the level above or the text decides again (B43).
  const localGate = (link: RowlinkRecord): boolean =>
    scopedTo(link, chain.address) &&
    (link.link === "shownWhenOn" || link.link === "shownWhenOff" || link.link === "shownAlways") &&
    link.target === chain.address.item &&
    link.targetSection === chain.address.section
  return {
    records: next,
    splits: chain.splits,
    rowlinks: (memo.ctx.scopes.rowlinks ?? []).filter((link) => !localGate(link)),
    status: `Reset "${node.label}" to default`,
    retryHint: `reset "${node.label}" against a stale revision; retry to apply`,
  }
}

export function saveSplit(
  input: MemoInput,
  rowId: string,
  boundaries: readonly { id: string; name: string; start: number }[],
  sharedMemo?: Memo,
): OpResult {
  const found = findNode(input, rowId, sharedMemo)
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

export function addSection(input: MemoInput, rowId: string, name: string, text: string, sharedMemo?: Memo, includesHeading = false): OpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const address = node.address
  if (!address || (node.kind !== "item" && node.kind !== "section")) return { refusal: `"${node.label}" does not support sections` }
  if (node.kind === "item" && node.actions?.split !== true) return { refusal: `"${node.label}" does not support sections` }
  const chain = chainFor(memo, node)
  if (!chain) return { refusal: `Item not found for "${node.label}"` }

  const itemAddress: Address = { ...address, section: null }
  const currentText = resolvedTextOf(memo, { ...chain, address: itemAddress })
  const preview = resolveSplit({
    text: currentText,
    title: chain.upstream.title,
    splits: chain.splits,
    scopes: memo.ctx.scopes,
    address: itemAddress,
  })

  if (preview.kind === "heading") {
    const isSection = node.kind === "section" && address.section !== null
    const targetSection = isSection ? preview.sections.find((s) => s.id === address.section) : undefined
    if (isSection && targetSection === undefined) return { refusal: `Section not found for "${node.label}"` }

    // B39: a heading-derived section's customization is its full span, so an add
    // appends to the end of the selected parent's EFFECTIVE span and writes that
    // parent. Writing a deeper leaf instead buries the new heading inside the
    // leaf's override (the live a36 defect: "Added" showed up in Child's own
    // editor). For an item row use the wrapper, if present, otherwise save the
    // full item span: a top-level sibling must not live in the last leaf's copy.
    const appendDepth = targetSection !== undefined
      ? targetSection.depth + 1
      : (() => {
          const wrapper = wrappingSection(preview)
          const nonPreamble = preview.sections.filter((s) => s.id !== "preamble")
          return wrapper !== undefined ? wrapper.depth + 1 : (nonPreamble.length > 0 ? Math.min(...nonPreamble.map((s) => s.depth)) : 0)
        })()
    const anchor = targetSection ?? wrappingSection(preview)

    const hashes = "#".repeat(Math.max(1, appendDepth + 1))
    if (includesHeading) {
      const source = derive(text.trim(), name)
      const depth = source.sections[0]?.depth ?? 0
      if (source.sections.some((section) => hashes.length + section.depth - depth > 6))
        return { refusal: "This section is too deeply nested here; paste it under a shallower section" }
    }
    const headingLine = `${hashes} ${name}`
    const body = text.trim()
    const sectionBlock = includesHeading ? relocateHeadingSpan(body, name, hashes.length - 1) : body.length > 0 ? `${headingLine}\n\n${body}` : headingLine

    // The anchor's resolved text is its effective full span, with the child
    // overrides that win over it (B39 rule 2) already applied. Writing that span
    // back and folding the consumed same-level child texts keeps their content
    // once and cannot lose it on a reload; more specific children stay.
    const anchorAddress: Address = { ...itemAddress, section: anchor?.id ?? null }
    const resolvedAnchor = resolve({
      upstream: chain.upstream,
      records: chain.customizations,
      splits: chain.splits,
      scopes: memo.ctx.scopes,
      address: anchorAddress,
    })
    const anchorText = anchor === undefined ? (resolvedAnchor.fullText ?? resolvedAnchor.assembled) : resolvedAnchor.text
    const trimmedAnchor = anchorText.trimEnd()
    const newAnchorText = trimmedAnchor.length > 0 ? `${trimmedAnchor}\n\n${sectionBlock}\n` : `${sectionBlock}\n`

    const folded = anchor === undefined
      ? preview.sections.reduce((records, section) => dropSectionText(records, { ...itemAddress, section: section.id }), chain.customizations)
      : chain.customizations
    const written = merge(
      folded,
      anchorAddress,
      { text: newAnchorText },
      chain.upstream,
      memo.ctx.scopes,
      chain.splits,
    )
    const nextCustomizations = withoutInnerChildren(
      memo,
      { ...chain, address: anchorAddress },
      written,
      newAnchorText,
    )

    return {
      records: nextCustomizations,
      splits: chain.splits,
      status: `Added "${name}" to "${node.label}"`,
      retryHint: `added "${name}" against a stale revision; retry to apply`,
    }
  }

  const isSection = node.kind === "section" && address.section !== null
  const targetSection = isSection ? preview.sections.find((s) => s.id === address.section) : undefined
  if (isSection && targetSection === undefined) return { refusal: `Section not found for "${node.label}"` }

  const existingSplit = chain.splits.find((record) => record.item === address.item && scopedTo(record, address))
  const existing: Boundary[] =
    existingSplit !== undefined
      ? [...existingSplit.boundaries]
      : preview.kind === "manual" || preview.kind === "block"
        ? preview.sections
            .filter((section) => section.id !== "preamble")
            .map((section) => ({ id: section.id, name: section.name, start: section.start, depth: section.depth }))
        : [{ id: "existing", name: chain.upstream.title, start: 0, depth: 0 }]

  const insertPos = targetSection !== undefined ? targetSection.end : currentText.length
  const newDepth = targetSection !== undefined ? (targetSection.depth ?? 0) + 1 : 0
  const used = new Set(existing.map((entry) => entry.id))
  const newId = claim(slugify(name), used)
  const newBoundary: Boundary = { id: newId, name, start: insertPos, depth: newDepth }

  let insertIndex = existing.length
  if (targetSection !== undefined) {
    const targetIdx = existing.findIndex((b) => b.id === targetSection.id)
    if (targetIdx !== -1) {
      insertIndex = targetIdx + 1
      while (
        insertIndex < existing.length &&
        (existing[insertIndex].start < targetSection.end ||
          (existing[insertIndex].depth ?? 0) > (targetSection.depth ?? 0))
      ) {
        insertIndex += 1
      }
    }
  }
  const boundaries = [...existing.slice(0, insertIndex), newBoundary, ...existing.slice(insertIndex)]

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

  const sectionAddress: Address = { ...itemAddress, section: newId }
  const split = manual(currentText, boundaries)
  const sectionUpstream = upstreamSliceOf(split, currentText, newId)
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
  resolution: "keep" | "take" | "edit" | "merge",
  edited?: string,
  only?: readonly ReviewPart[],
  sharedMemo?: Memo,
): OpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  if (resolution === "edit" || resolution === "merge") {
    const refusal = editRefusal(node)
    if (refusal !== undefined) return { refusal }
    if (edited === undefined)
      return {
        refusal:
          resolution === "merge"
            ? `"${node.label}" cannot be merged: merge requires the merged text`
            : `"${node.label}" cannot be edited: edit requires text`,
      }
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
      records: dropSectionText(next, chain.address),
      splits: chain.splits,
      status: `Took upstream for "${node.label}"`,
      retryHint: `resolved "${node.label}" against a stale revision; retry`,
    }
  }
  if (resolution === "merge") {
    return {
      records: next,
      splits: chain.splits,
      status: `Merged "${node.label}"`,
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
  /** Where the value above comes from ("from preset Orchestrator", "OpenCode", …). */
  readonly from: string
}

export function stateReviewChoice(input: MemoInput, rowId: string, sharedMemo?: Memo): StateReviewChoice | undefined {
  const found = findNode(input, rowId, sharedMemo)
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
  const own = presetOfAddress(found.memo.ctx.listing, chain.address)
  return {
    parts,
    mine: describe(pair.own.state, pair.own.pin),
    above: describe(pair.above.enabled ? "on" : "off", pair.above.pinned),
    from: fromLabel(parts.includes("state") ? pair.above.from : pair.above.pinFrom, {
      labels: found.memo.ctx.labels,
      level: chain.address.level,
      ...(own === undefined ? {} : { own }),
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

export function modelReviewChoice(input: MemoInput, rowId: string, sharedMemo?: Memo): ModelReviewChoice | undefined {
  const found = findNode(input, rowId, sharedMemo)
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
  const own = presetOfAddress(found.memo.ctx.listing, address)
  return {
    mine: found.node.label,
    above: modelKey(above),
    from: fromLabel(above.from, { labels: found.memo.ctx.labels, level: address.level, ...(own === undefined ? {} : { own }) }),
  }
}

// Keep: the own active model re-records the active model above it now, so the
// review clears and yours stays. Take: the own active flag goes, so the model
// above wins again.
// Take follows upstream for the whole row (B41): the text of the item's
// section customizations at the same level goes in the same write. A section
// record keeps only the state, pin or condition it carries.
// Section ids are heading paths, so `a/x` is under `a` and `ab` is not. A take
// on the item clears every section at its level; a take on a section clears
// that section and its descendants, never a sibling or an ancestor.
export function dropSectionText(records: readonly CustomizationRecord[], address: Address): CustomizationRecord[] {
  return records.flatMap((record) => {
    if (record.item !== address.item || record.section === null || record.text === undefined || !scopedTo(record, address)) return [record]
    if (address.section !== null && record.section !== address.section && !record.section.startsWith(`${address.section}/`)) return [record]
    const cleared = { ...record, text: undefined, basedOnText: undefined, acknowledged: undefined }
    if (cleared.state === undefined && cleared.pin === undefined && cleared.requires === undefined) return []
    return [cleared]
  })
}

export function resolveModelReview(input: MemoInput, rowId: string, resolution: "keep" | "take", sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
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

// The runtime chain an agent's model answer resolves through at this address:
// a native built-in's Defaults row runs at Project, so the same rows the tree
// marks active are the ones a removal decision reads. The row's own level stays
// where edits write.
function runtimeModelInput(memo: Memo, address: Address, models: readonly ModelRecord[]): ModelInput {
  const owner = address.agent
  const agentScope = owner === null ? undefined : memo.ctx.agents.find((entry) => entry.id === owner)?.scope
  const team = address.memberOf ?? address.team
  const runtime = modelRuntimeScope({
    scopes: memo.ctx.scopes,
    level: address.level,
    owner,
    ...(agentScope === undefined ? {} : { agentScope }),
    ...(team === undefined ? {} : { team }),
  })
  const upstream = modelUpstreamOf(memo, address)
  return {
    models,
    scopes: runtime.scopes,
    level: runtime.level,
    agent: owner,
    ...(address.team === undefined ? {} : { team: address.team }),
    ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }),
    ...(address.memberOf === undefined ? {} : { memberOf: address.memberOf }),
    ...(upstream === undefined ? {} : { upstream }),
  }
}

function effectiveModelAt(memo: Memo, address: Address, models: readonly ModelRecord[]): ModelCandidate | undefined {
  return resolveActiveModel(runtimeModelInput(memo, address, models))
}

function activeModelRefusal(label: string): string {
  return `"${label}" is the active model here: activate another model first`
}

export function removalPlan(input: MemoInput, rowId: string, sharedMemo?: Memo): RemovalPlan {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const memo = found.memo
  const preset = node.owner?.preset
  if (preset !== undefined) {
    if (preset.origin !== "user")
      return { refusal: `"${node.label}" cannot be deleted: ${preset.origin === "native" ? "OpenCode" : "Plus"} presets are read-only` }
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
    const scope = item.skillScope ?? (item.group === "project" ? "project" : undefined)
    if (node.actions?.remove !== true || scope === undefined)
      return { refusal: `"${node.label}" cannot be deleted: skill "${skillId}" is not user-authored` }
    return {
      kind: "skill.delete",
      id: skillId,
      scope,
      ...(item.skillPreset === undefined ? {} : { preset: item.skillPreset }),
      confirmTitle: `Delete skill ${skillId}?`,
      confirmMessage: `Delete ${scope} skill "${skillId}"? This cannot be undone.`,
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

export function teamPlan(input: MemoInput, rowId: string, desired?: boolean, sharedMemo?: Memo): TeamPlan {
  const found = findNode(input, rowId, sharedMemo)
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

export function refusalFor(input: MemoInput, rowId: string, sharedMemo?: Memo): string | undefined {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return unknownRowRefusal(rowId)
  const node = found.node
  const memo = found.memo
  const address = node.address
  if (address === undefined) return undefined
  const item = upstreamFor(memo.ctx.items, address)
  if (item === undefined) return undefined
  if (item.kind === "skill") {
    const skillId = address.item.startsWith("skill:") ? address.item.slice("skill:".length) : address.item
    if (item.skillScope !== undefined || item.group === "project") return undefined
    return `"${node.label}" cannot be deleted: skill "${skillId}" is not user-authored`
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
export function activateModelRow(input: MemoInput, rowId: string, sharedMemo?: Memo, isProtected?: (owner: string | null) => boolean): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
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
  const switched = switchModelActivation(input, address, target, next, isProtected, found.memo)
  if ("refusal" in switched) return switched
  const suffix = switched.disabled.length === 0 ? "" : `; disabled ${switched.disabled.join(", ")}`
  return { models: switched.models ?? next, records: switched.records, status: `Activated "${node.label}"${suffix}`, retryHint: `activated "${node.label}" against a stale revision; retry to apply` }
}

/** The target a completed `/models`, variant-dialog or cycle-effort pick names. */
export interface ModelPick {
  readonly agent: string
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export interface ModelPickSuccess {
  readonly models: readonly ModelRecord[]
  readonly records?: readonly CustomizationRecord[]
  readonly status: string
  readonly retryHint: string
  /** The tree row id the pick addresses or wrote. */
  readonly rowId: string
  /** The level the pick wrote (or would no-op at). */
  readonly level: Level
  /** False when the pick was already the effective model and wrote nothing. */
  readonly changed: boolean
}

export type ModelPickResult = ModelPickSuccess | OpFailure

// The team a pick's agent resolves as a member of, or the flat agent. Matches
// the runtime: `buildActiveModels` resolves only what Plus published, so a
// member of a disabled team is not in force and must not redirect the pick. An
// id in more than one enabled team is genuinely ambiguous: the row to write
// would be a guess, so the pick refuses instead.
function pickOwnerOf(
  input: MemoInput,
  agent: string,
): { readonly kind: "agent"; readonly level: Level } | { readonly kind: "member"; readonly level: Level; readonly team: string } | { readonly refusal: string } {
  const teams = (input.teams ?? []).filter(
    (team) => team.enabled && (team.agents.includes(agent) || (team.overlay?.includes(agent) ?? false)),
  )
  if (teams.length > 1)
    return {
      refusal: `"${agent}" is a member of teams ${teams.map((team) => `"${team.team}"`).join(", ")}: the model to change is ambiguous`,
    }
  const only = teams[0]
  if (only !== undefined) return { kind: "member", level: only.level, team: only.team }
  // The runtime's agent list orders team winners before stand-alone agents and
  // keeps the first per id, so a stand-alone row wins the fallback.
  const source =
    input.agents.find((entry) => entry.id === agent && entry.team === undefined) ??
    input.agents.find((entry) => entry.id === agent)
  if (source === undefined) return { refusal: `Unknown agent "${agent}"` }
  return { kind: "agent", level: source.scope }
}

/**
 * Decide what a completed user model pick writes, purely: the record list and
 * the address, or a refusal. Mirrors `buildActiveModels` for the agent's
 * effective model and write level, then reuses the tree's row operations on
 * the agent's model rows at that level. The caller saves the returned `models`
 * with a revision-checked write and logs once; a no-op returns the input list.
 */
export function pickModelRow(input: MemoInput, pick: ModelPick, sharedMemo?: Memo, isProtected?: (owner: string | null) => boolean): ModelPickResult {
  const memo = sharedMemo ?? memoOfInput(input)
  const ctx = memo.ctx
  const target = { providerID: pick.providerID, modelID: pick.modelID, ...(pick.variant === undefined ? {} : { variant: pick.variant }) }
  const owner = pickOwnerOf(input, pick.agent)
  if ("refusal" in owner) return owner
  const agents = ctx.agents
  // The agent's own model (file frontmatter, else host), the same fallback the
  // tree and activation read.
  const upstream =
    agents.find((entry) => entry.id === pick.agent && entry.scope === owner.level)?.model ??
    agents.find((entry) => entry.id === pick.agent)?.model
  const memberOf = owner.kind === "member" ? { level: owner.level, team: owner.team } : undefined
  const catalogue = owner.kind === "member" ? ("teams" as const) : undefined
  // Resolve the effective model exactly as buildActiveModels does.
  const runtime = modelRuntimeScope({
    scopes: ctx.scopes,
    level: owner.level,
    owner: pick.agent,
    ...(memberOf === undefined ? {} : { team: memberOf }),
  })
  const effective = resolveActiveModel({
    models: ctx.models,
    scopes: runtime.scopes,
    level: runtime.level,
    agent: pick.agent,
    ...(memberOf === undefined ? {} : { memberOf }),
    ...(catalogue === undefined ? {} : { catalogue }),
    ...(upstream === undefined ? {} : { upstream }),
  })
  // Write level: for an agent (not a team member), always the chat's Project
  // level so other projects are never affected. For a team member, keep the
  // level that supplies the model, else Global, else the team's tier,
  // because member resolution and tree rows sit at the team's definition
  // level and cannot resolve a Project-level member row.
  const winnerSource = effective?.source
  const writeLevel: Level =
    owner.kind === "agent"
      ? "project"
      : winnerSource === "project" || winnerSource === "global"
        ? winnerSource
        : runtime.scopes.global.has(pick.agent)
          ? "global"
          : owner.level
  const ownerPath = owner.kind === "member" ? `${owner.team}/:${pick.agent}` : pick.agent
  const rowId = `item:${writeLevel}:${ownerPath}:${modelItemId(target)}`
  // The rows shown at the write level: the union down the chain from there.
  const candidates = modelCandidates({
    models: ctx.models,
    scopes: ctx.scopes,
    level: writeLevel,
    agent: pick.agent,
    ...(memberOf === undefined ? {} : { memberOf }),
    ...(catalogue === undefined ? {} : { catalogue }),
    ...(upstream === undefined ? {} : { upstream }),
  })
  const label = `${pick.providerID}/${pick.modelID}${pick.variant === undefined ? "" : `@${pick.variant}`}`
  const success = (models: readonly ModelRecord[], changed: boolean, status: string, records?: readonly CustomizationRecord[]): ModelPickSuccess => ({
    models,
    ...(records === undefined ? {} : { records }),
    status,
    retryHint: `activated "${label}" against a stale revision; retry to apply`,
    rowId,
    level: writeLevel,
    changed,
  })
  // (a) already the effective model: no write.
  if (effective !== undefined && sameModelCandidate(effective, target))
    return success(ctx.models, false, `Activated "${label}"`)
  // (b) the exact candidate is present: activate it.
  if (candidates.some((candidate) => sameModelCandidate(candidate, target))) {
    const activated = activateModelRow(input, rowId, memo, isProtected)
    if ("refusal" in activated) return activated
    return success(activated.models, true, activated.status, activated.records)
  }
  // (c) the same provider/model is present with another effort: change it in
  // place, preferring the active row, then make it active.
  const sameModel = candidates
    .filter((candidate) => candidate.providerID === target.providerID && candidate.modelID === target.modelID)
    .toSorted((left, right) => {
      const leftId = modelItemId(left)
      const rightId = modelItemId(right)
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
    })
  const match =
    sameModel.find((candidate) => effective !== undefined && sameModelCandidate(candidate, effective)) ?? sameModel[0]
  if (match !== undefined) {
    const matchRowId = `item:${writeLevel}:${ownerPath}:${modelItemId(match)}`
    const edited = editModelRow(input, matchRowId, { ...target, editedField: "effort" }, memo, isProtected)
    if ("refusal" in edited) return edited
    // Editing in place keeps the row active; when the match was an inactive
    // candidate, activate it on the edited state in one more row operation.
    const editedInput: MemoInput = {
      ...input,
      records: [...input.records.filter((record) => record.type !== "model" && (edited.records === undefined || record.type !== "customization")), ...(edited.records ?? []), ...edited.models],
    }
    const activated = activateModelRow(editedInput, rowId, undefined, isProtected)
    if ("refusal" in activated) return activated
    return success(activated.models, true, activated.status, activated.records)
  }
  // (d) no row for the candidate: add and activate one, with the same context
  // activation uses. The new row carries no per-row warming/interval/prompt, so
  // those resolve from Defaults › Models.
  const scope = {
    level: writeLevel,
    agent: pick.agent,
    ...(memberOf === undefined ? {} : { memberOf }),
    ...(catalogue === undefined ? {} : { catalogue }),
  }
  const next = ensureActivateModel(ctx.models, scope, target, now(), {
    scopes: ctx.scopes,
    ...(upstream === undefined ? {} : { upstream }),
  })
  const switched = switchModelActivation(input, { ...scope, item: modelItemId(target), section: null }, target, next, isProtected, memo)
  if ("refusal" in switched) return switched
  const suffix = switched.disabled.length === 0 ? "" : `; disabled ${switched.disabled.join(", ")}`
  return success(switched.models ?? next, true, `Activated "${label}"${suffix}`, switched.records)
}

// w on a model row sets cache warming for this agent and model at this level:
// "off", "on" or a total time such as "45m"; blank clears it so the level
// below (or the host configuration) decides. Inherited rows plant the local
// candidate, like activation.
export function setModelWarmingRow(input: MemoInput, rowId: string, text: string, sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined || node.actions?.toggle !== true) return { refusal: `"${node.label}" cannot set cache warming` }
  const target = modelTargetOf(address)
  if (target === undefined) return { refusal: `"${node.label}" cannot set cache warming` }
  const parsed = text.trim().length === 0 ? undefined : parseWarming(text)
  if (parsed !== undefined && "error" in parsed) return { refusal: parsed.error }
  const models = modelsOfInput(input)
  const value = parsed === undefined ? undefined : formatWarming(parsed)
  const next = setModelWarming(models, modelScopeOf(address), target, value, now())
  if (JSON.stringify(next) === JSON.stringify(models)) return { refusal: `"${node.label}" has no cache warming to clear` }
  const status = value === undefined ? `Cache warming for "${node.label}" inherits` : `Cache warming for "${node.label}": ${value}`
  return { models: next, status, retryHint: `set cache warming on "${node.label}" against a stale revision; retry to apply` }
}

// r on a model row clears only that level's active flag, leaving candidates
// so the chain falls through. No active at this level refuses.
export function resetModelRow(input: MemoInput, rowId: string, sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
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

// d on a model row removes the candidate at this level only:
// - a live local record is deleted;
// - an inherited or upstream row is hidden at this level by a tombstone
//   (`removed: true`), which also hides it from addresses resolving through
//   this node. The source level is never touched, and re-adding the model here
//   clears the tombstone.
// The row that is the agent's effective model refuses: "activate another model
// first" is the explicit replacement the human has to make. A local active
// record may be deleted when the chain below still resolves another stored
// model (activating there already happened); falling to the host configuration
// is what the refusal prevents.
export function removeModelRow(input: MemoInput, rowId: string, sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined || node.actions?.toggle !== true) return { refusal: `"${node.label}" cannot be deleted` }
  const target = modelTargetOf(address)
  if (target === undefined) return { refusal: `"${node.label}" cannot be deleted` }
  const models = modelsOfInput(input)
  const addr = modelScopeOf(address)
  const effective = effectiveModelAt(found.memo, address, models)
  if (effective !== undefined && sameModelCandidate(effective, target)) {
    const localActive = models.some(
      (record) => record.removed !== true && scopedTo(record, addr) && record.active === true && sameModelCandidate(record, target),
    )
    if (!localActive) return { refusal: activeModelRefusal(node.label) }
    const next = effectiveModelAt(found.memo, address, removeModelRecord(models, addr, target))
    if (next === undefined || next.source === "upstream") return { refusal: activeModelRefusal(node.label) }
  }
  const hasLocal = hasModelRecordAt(models, addr, target)
  const next = hasLocal ? removeModelRecord(models, addr, target) : tombstoneModelRecord(models, addr, target, now())
  const status = hasLocal ? `Removed "${node.label}"` : `Hidden "${node.label}" at this level`
  return { models: next, status, retryHint: `${hasLocal ? "removed" : "hid"} "${node.label}" against a stale revision; retry to apply` }
}

export interface ModelEditFields {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  /** undefined = leave warming alone; "" clears it; else a parseWarming value. */
  readonly warming?: string
  /** undefined = leave the ping interval alone; "" clears it; else a parseInterval value. */
  readonly interval?: string
  /** undefined = leave the keep-alive text alone; "" clears it; else a parsePrompt value. */
  readonly prompt?: string
  readonly editedField?: "model" | "effort"
}

// Enter on a model row: replace the candidate (provider/model/variant) at this
// level and set or clear its cache warming in one save. An inherited or
// upstream row plants a local record like activation does; editing the
// effective model keeps it effective, and a local record's active flag moves
// with the replaced record. Warming is validated like the warming tool/prompt
// (off, on, a total time, or empty to inherit).
export function editModelRow(input: MemoInput, rowId: string, fields: ModelEditFields, sharedMemo?: Memo, isProtected?: (owner: string | null) => boolean): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined || node.actions?.toggle !== true) return { refusal: `"${node.label}" cannot be edited` }
  const from = modelTargetOf(address)
  if (from === undefined) return { refusal: `"${node.label}" cannot be edited` }
  const models = modelsOfInput(input)
  const addr = modelScopeOf(address)
  const to = { providerID: fields.providerID, modelID: fields.modelID, ...(fields.variant === undefined ? {} : { variant: fields.variant }) }
  const local = models.find((record) => record.removed !== true && scopedTo(record, addr) && sameModelCandidate(record, from))
  const effective = effectiveModelAt(found.memo, address, models)
  // A local active record keeps its flag. A local record that is not active
  // but names the effective model (the level below resolves the same
  // candidate, e.g. after a Model reset preserved its warming) also stays
  // effective: editing the row that is in force must not silently drop it.
  const staysActive = local?.active === true || (effective !== undefined && sameModelCandidate(effective, from))
  const targetChanged = !sameModelCandidate(from, to)
  // Replacement changes endpoint identity. Until that operation has a safe
  // shared migration, refuse rather than leaving a saved relationship orphaned.
  if (targetChanged && linksTouching(found.memo.ctx.scopes.rowlinks ?? [], found.memo.ctx.scopes, address,
    { item: address.item, section: null }).length > 0)
    return { refusal: `"${node.label}" is linked: remove its links before replacing the candidate` }
  const upstream = modelUpstreamOf(found.memo, address)
  const context = { scopes: found.memo.ctx.scopes, ...(upstream === undefined ? {} : { upstream }) }
  // A replaced candidate carries its record's keep-alive fields to the new one,
  // and the old candidate is hidden at this level with a tombstone. So editing
  // Model/Effort changes THAT row (one row becomes the new candidate), never
  // leaving the old candidate listed beside the new one — whether the old row
  // was a local record, inherited, or the agent's upstream model.
  const carried: ModelWarmingFields = local === undefined
    ? {}
    : {
        ...(local.warming === undefined ? {} : { warming: local.warming }),
        ...(local.interval === undefined ? {} : { interval: local.interval }),
        ...(local.prompt === undefined ? {} : { prompt: local.prompt }),
      }
  let originalCandidate: OriginalCandidate | undefined = local?.originalCandidate
  if (originalCandidate === undefined && targetChanged) {
    const aboveInput = runtimeModelInput(found.memo, address, models.filter((record) => !scopedTo(record, addr)))
    const aboveCandidates = modelCandidates(aboveInput)
    const orig = aboveCandidates.find((c) => sameModelCandidate(c, from))
    if (orig !== undefined) {
      originalCandidate = {
        providerID: orig.providerID,
        modelID: orig.modelID,
        ...(orig.variant === undefined ? {} : { variant: orig.variant }),
        source: orig.source,
      }
    } else if (upstream !== undefined && sameModelCandidate(upstream, from)) {
      originalCandidate = {
        providerID: upstream.providerID,
        modelID: upstream.modelID,
        ...(upstream.variant === undefined ? {} : { variant: upstream.variant }),
        source: "upstream",
      }
    } else if (local !== undefined) {
      // The replaced candidate is a local-only row (added at this level, not
      // inherited). It is its own original: capture it so a later Model reset
      // restores this candidate instead of guessing the active model above.
      originalCandidate = {
        providerID: from.providerID,
        modelID: from.modelID,
        ...(from.variant === undefined ? {} : { variant: from.variant }),
        source: addr.level,
      }
    }
  }

  if (originalCandidate !== undefined) {
    const existing = new Set<"model" | "effort">(originalCandidate.editedFields ?? [])
    if (fields.editedField === "model") {
      existing.add("model")
    } else if (fields.editedField === "effort") {
      existing.add("effort")
    } else if (targetChanged) {
      existing.add("model")
    }
    const nextEdited = Array.from(existing)
    originalCandidate = {
      ...originalCandidate,
      editedFields: nextEdited,
    }
  }

  const toWithOriginal = {
    ...to,
    ...(originalCandidate === undefined ? {} : { originalCandidate }),
  }
  const swapped = targetChanged
    ? addModelRecord(tombstoneModelRecord(models, addr, from, now()), addr, toWithOriginal, now())
    : addModelRecord(models, addr, toWithOriginal, now())
  // Re-activate only when the active flag has to be carried over: a replaced
  // record keeps it, and an inherited/upstream edit plants it. A same-target
  // local active record is left exactly as it is.
  const withActive = staysActive && (targetChanged || local === undefined || local.active !== true)
    ? activateModel(swapped, addr, toWithOriginal, context)
    : swapped
  const warming = fields.warming === undefined || fields.warming.trim().length === 0 ? undefined : parseWarming(fields.warming)
  if (warming !== undefined && "error" in warming) return { refusal: warming.error }
  const interval = fields.interval === undefined || fields.interval.trim().length === 0 ? undefined : parseInterval(fields.interval)
  if (interval !== undefined && "error" in interval) return { refusal: interval.error }
  const prompt = fields.prompt === undefined || fields.prompt.trim().length === 0 ? undefined : parsePrompt(fields.prompt)
  if (prompt !== undefined && "error" in prompt) return { refusal: prompt.error }
  const fieldsSet = fields.warming !== undefined || fields.interval !== undefined || fields.prompt !== undefined
  const settings = {
    ...(fields.warming === undefined ? {} : { warming: warming === undefined ? null : formatWarming(warming) }),
    ...(fields.interval === undefined ? {} : { interval: interval === undefined ? null : formatDuration(interval.interval) }),
    ...(fields.prompt === undefined ? {} : { prompt: prompt === undefined ? null : prompt.prompt }),
  }
  const merged: ModelWarmingFields = { ...(targetChanged ? carried : {}), ...settings }
  const next = fieldsSet || Object.keys(merged).length > 0 ? setModelSettings(withActive, addr, toWithOriginal, merged, now()) : withActive
  if (JSON.stringify(next) === JSON.stringify(models)) return { refusal: `"${node.label}" has no changes to save` }
  const onlySettings = fieldsSet && JSON.stringify(withActive) === JSON.stringify(models)
  const status = onlySettings
    ? `Cache warming for "${node.label}": ${warmingSummaryOf(settings)}`
    : `Updated "${node.label}"`
  const switched = switchModelActivation(input, { ...address, item: modelItemId(to) }, to, next, isProtected, found.memo)
  if ("refusal" in switched) return switched
  return { models: switched.models ?? next, records: switched.records, status, retryHint: `edited "${node.label}" against a stale revision; retry to apply` }
}

// One field row under an agent/member/preset model row. `setModelFieldRow`
// edits that field alone at the row's level; `resetModelFieldRow` clears it so
// the level below (or Defaults › Models) decides. Both reuse editModelRow on
// the parent model row, so an inherited field plants a local record like the
// TUI and a local one keeps its active flag.
export function parentModelRowId(rowId: string, target: { providerID: string; modelID: string; variant?: string }): string | undefined {
  const at = rowId.indexOf("modelfield:")
  if (at === -1) return undefined
  return `${rowId.slice(0, at)}${modelItemId(target)}`
}

export type ModelFieldEdit =
  | { readonly fields: ModelEditFields }
  | { readonly compaction: ModelCompactionFieldValues }
  | { readonly error: string }

// Interpret one field row's Enter text for the field the row names. Model /
// Effort are candidate edits, Warming / Ping every / Keep-alive prompt are
// warming settings, and the compaction fields run through the shared C1
// validator (model-settings.ts). No field falls through to `prompt`: writing a
// compaction value must never overwrite the keep-alive prompt.
export function modelFieldEdit(
  field: ModelFieldName,
  target: { providerID: string; modelID: string; variant?: string },
  text: string,
): ModelFieldEdit {
  if (field === "model") {
    const parsed = parseModelText(text)
    if (parsed === undefined) return { error: `takes provider/model or provider/model#variant (got "${text}")` }
    const variant = parsed.variant ?? target.variant
    return {
      fields: {
        providerID: parsed.providerID,
        modelID: parsed.modelID,
        ...(variant === undefined ? {} : { variant }),
        editedField: "model",
      },
    }
  }
  if (field === "effort") {
    const variant = text.trim()
    return {
      fields: {
        providerID: target.providerID,
        modelID: target.modelID,
        ...(variant.length === 0 ? {} : { variant }),
        editedField: "effort",
      },
    }
  }
  const base = { providerID: target.providerID, modelID: target.modelID, ...(target.variant === undefined ? {} : { variant: target.variant }) }
  if (field === "warming") return { fields: { ...base, warming: text } }
  if (field === "interval") return { fields: { ...base, interval: text } }
  if (field === "prompt") return { fields: { ...base, prompt: text } }
  const asTyped =
    field === "compactionInput" || field === "compactionOutput" ? { [field]: text }
      : field === "compactionStrategy" ? { compactionStrategy: text }
      : field === "compactionModel" ? { compactionModel: text }
        : field === "compactionInstructions" ? { compactionInstructions: text }
          : field === "compactWarm" ? { compactWarm: text }
            : { coldCompact: text }
  const validated = compactionFieldsOf(asTyped)
  if ("error" in validated) return { error: validated.error }
  return { compaction: validated.fields }
}

// A model row's text replaces the candidate: "provider/model" or
// "provider/model#variant" (the form the compaction model and the README use).
export function parseModelText(text: string): { providerID: string; modelID: string; variant?: string } | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const hash = trimmed.indexOf("#")
  const ref = hash === -1 ? trimmed : trimmed.slice(0, hash)
  const variant = hash === -1 ? undefined : trimmed.slice(hash + 1).trim()
  const slash = ref.indexOf("/")
  if (slash === -1) return undefined
  const providerID = ref.slice(0, slash).trim()
  const modelID = ref.slice(slash + 1).trim()
  if (providerID.length === 0 || modelID.length === 0) return undefined
  if (hash !== -1 && (variant === undefined || variant.length === 0)) return undefined
  return { providerID, modelID, ...(variant === undefined ? {} : { variant }) }
}

export function setModelFieldRow(input: MemoInput, rowId: string, text: string, sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const address = found.node.address
  const parsed = address === undefined ? undefined : parseModelFieldItemId(address.item)
  if (parsed === undefined || address === undefined) return { refusal: `"${found.node.label}" is not a model field` }
  const parent = parentModelRowId(found.node.id, parsed.target)
  if (parent === undefined) return { refusal: `"${found.node.label}" is not a model field` }
  const edit = modelFieldEdit(parsed.field, parsed.target, text)
  if ("error" in edit) return { refusal: edit.error }
  if ("compaction" in edit) {
    const models = modelsOfInput(input)
    const next = setModelCompaction(models, modelScopeOf(address), parsed.target, edit.compaction, now())
    if (JSON.stringify(next) === JSON.stringify(models)) return { refusal: `"${found.node.label}" has no changes to save` }
    return {
      models: next,
      status: `Updated "${found.node.label}"`,
      retryHint: `edited "${found.node.label}" against a stale revision; retry to apply`,
    }
  }
  return editModelRow(input, parent, edit.fields, sharedMemo)
}

// `r` on a field row clears that field at the row's level. Warming, Ping every
// and Keep-alive prompt go through the shared edit; Effort drops the variant
// (or restores the inherited variant when originally set). Model clears the local
// candidate override at this level and restores the original candidate this row
// replaced, preserving compatible local effort and unrelated keep-alive fields.
// One row still never becomes two (the closed editing decision).
export function resetModelFieldRow(input: MemoInput, rowId: string, sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const address = found.node.address
  const parsed = address === undefined ? undefined : parseModelFieldItemId(address.item)
  if (parsed === undefined || address === undefined) return { refusal: `"${found.node.label}" is not a model field` }
  const models = modelsOfInput(input)
  const addr = modelScopeOf(address)
  const local = models.find(
    (record) => record.removed !== true && scopedTo(record, addr) && sameModelCandidate(record, parsed.target),
  )
  if (local === undefined) return { refusal: `"${found.node.label}" has no override to reset` }

  if (parsed.field === "warming" || parsed.field === "interval" || parsed.field === "prompt") {
    if (local[parsed.field] === undefined) return { refusal: `"${found.node.label}" has no override to reset` }
    const next = setModelSettings(models, addr, parsed.target, { [parsed.field]: null }, now())
    if (JSON.stringify(next) === JSON.stringify(models)) return { refusal: `"${found.node.label}" has no override to reset` }
    return {
      models: next,
      status: `Reset "${found.node.label}"`,
      retryHint: `reset "${found.node.label}" against a stale revision; retry to apply`,
    }
  }

  // Compaction fields (Compact before cold, Strategy, Model, Instructions) use
  // the C1 store: null clears this level so the level below (or Defaults ›
  // Models) decides again. An explicit empty Instructions is a value, not a
  // reset, so reset only fires when this level actually sets the field.
  if (
    parsed.field === "compactionInput" ||
    parsed.field === "compactionOutput" ||
    parsed.field === "compactWarm" ||
    parsed.field === "coldCompact" ||
    parsed.field === "compactionStrategy" ||
    parsed.field === "compactionModel" ||
    parsed.field === "compactionInstructions"
  ) {
    if (local[parsed.field] === undefined) return { refusal: `"${found.node.label}" has no override to reset` }
    const next = setModelCompaction(models, addr, parsed.target, { [parsed.field]: null } as ModelCompactionFieldValues, now())
    if (JSON.stringify(next) === JSON.stringify(models)) return { refusal: `"${found.node.label}" has no override to reset` }
    return {
      models: next,
      status: `Reset "${found.node.label}"`,
      retryHint: `reset "${found.node.label}" against a stale revision; retry to apply`,
    }
  }

  if (parsed.field === "effort") {
    const orig = local.originalCandidate
    if (orig !== undefined) {
      const isEffortEdited = orig.editedFields !== undefined
        ? orig.editedFields.includes("effort")
        : ((local.variant ?? undefined) !== (orig.variant ?? undefined))
      if (!isEffortEdited) {
        return { refusal: `"${found.node.label}" has no override to reset` }
      }
      const origVariant = orig.variant ?? undefined
      const targetWithRestoredVariant = {
        providerID: local.providerID,
        modelID: local.modelID,
        ...(origVariant === undefined ? {} : { variant: origVariant }),
      }
      const remainingEditedFields = (orig.editedFields ?? []).filter((f) => f !== "effort")
      const isModelStillEdited = remainingEditedFields.includes("model")
      const carried: ModelWarmingFields = {
        ...(local.warming === undefined ? {} : { warming: local.warming }),
        ...(local.interval === undefined ? {} : { interval: local.interval }),
        ...(local.prompt === undefined ? {} : { prompt: local.prompt }),
      }
      const wasActive = local.active === true
      const hasOtherOverrides = Object.keys(carried).length > 0 || wasActive
      const nextOriginalCandidate: OriginalCandidate | undefined = (remainingEditedFields.length > 0 || hasOtherOverrides)
        ? { ...orig, editedFields: remainingEditedFields }
        : undefined
      let without = removeModelRecord(models, addr, parsed.target)
      if (!isModelStillEdited) {
        without = without.filter(
          (record) => !(record.removed === true && scopedTo(record, addr) && sameModelCandidate(record, orig)),
        )
      }
      let next: ModelRecord[]
      // Mirror the Model branch: a local-only original (source === this level)
      // has no lower row, so removing its tombstone is not enough — the record
      // itself must come back. An inherited/upstream original resumes by
      // dropping the tombstone.
      const restoresLocalRow = orig.source === addr.level
      if (nextOriginalCandidate !== undefined || hasOtherOverrides || restoresLocalRow) {
        const added = addModelRecord(
          without,
          addr,
          {
            ...targetWithRestoredVariant,
            ...(nextOriginalCandidate !== undefined ? { originalCandidate: nextOriginalCandidate } : {}),
          },
          now(),
        )
        const withSettings = Object.keys(carried).length > 0
          ? setModelSettings(added, addr, targetWithRestoredVariant, carried, now())
          : added
        next = wasActive
          ? activateModel(withSettings, addr, targetWithRestoredVariant, { scopes: found.memo.ctx.scopes })
          : withSettings
      } else {
        next = without
      }
      if (JSON.stringify(next) === JSON.stringify(models)) return { refusal: `"${found.node.label}" has no override to reset` }
      const restoredLabel = origVariant ?? "none"
      return {
        models: next,
        status: `Reset "${found.node.label}" to "${restoredLabel}"`,
        retryHint: `reset "${found.node.label}" against a stale revision; retry to apply`,
      }
    }
    if (local.variant !== undefined) {
      // A plain local row (no originalCandidate) drops its variant in place.
      // Going through editModelRow would record this reset as an Effort edit
      // of the old variant, so a second reset would bring it back instead of
      // refusing. Like editModelRow, the old candidate is hidden at this level
      // so one row never becomes two when it is also inherited.
      const target = { providerID: local.providerID, modelID: local.modelID }
      const carried: ModelWarmingFields = {
        ...(local.warming === undefined ? {} : { warming: local.warming }),
        ...(local.interval === undefined ? {} : { interval: local.interval }),
        ...(local.prompt === undefined ? {} : { prompt: local.prompt }),
      }
      const added = addModelRecord(tombstoneModelRecord(models, addr, local, now()), addr, target, now())
      const withSettings = Object.keys(carried).length > 0 ? setModelSettings(added, addr, target, carried, now()) : added
      const upstream = modelUpstreamOf(found.memo, address)
      const next = local.active === true
        ? activateModel(withSettings, addr, target, { scopes: found.memo.ctx.scopes, ...(upstream === undefined ? {} : { upstream }) })
        : withSettings
      return {
        models: next,
        status: `Reset "${found.node.label}" to "none"`,
        retryHint: `reset "${found.node.label}" against a stale revision; retry to apply`,
      }
    }
    return { refusal: `"${found.node.label}" has no override to reset` }
  }

  if (parsed.field === "model") {
    const orig = local.originalCandidate
    if (orig !== undefined) {
      const isModelEdited = orig.editedFields !== undefined
        ? orig.editedFields.includes("model")
        : (local.providerID !== orig.providerID || local.modelID !== orig.modelID || !sameModelCandidate(local, orig))
      if (!isModelEdited) {
        // The Model field was not replaced here, so resetting it again is a
        // no-op. Only the model ROW's r clears activation; a FIELD reset must
        // never erase the local row (that would drop its remaining Effort,
        // keep-alive or active fields). Refuse with no write.
        return { refusal: `"${found.node.label}" has no override to reset` }
      }
      const origTarget = { providerID: orig.providerID, modelID: orig.modelID }
      const remainingEditedFields = (orig.editedFields ?? []).filter((f) => f !== "model")
      const isEffortStillEdited = remainingEditedFields.includes("effort")
      let restoredVariant: string | undefined
      if (!isEffortStillEdited) {
        restoredVariant = orig.variant
      } else {
        const host = hostModelOf(found.memo.ctx.hostModels, origTarget)
        const compatible = host?.variants === undefined || host.variants.length === 0 || (local.variant !== undefined && host.variants.includes(local.variant))
        restoredVariant = compatible ? local.variant : orig.variant
      }
      const restoredCandidate = {
        ...origTarget,
        ...(restoredVariant === undefined ? {} : { variant: restoredVariant }),
      }
      const effortStillDifferent = (restoredVariant ?? undefined) !== (orig.variant ?? undefined)
      const carried: ModelWarmingFields = {
        ...(local.warming === undefined ? {} : { warming: local.warming }),
        ...(local.interval === undefined ? {} : { interval: local.interval }),
        ...(local.prompt === undefined ? {} : { prompt: local.prompt }),
      }
      const wasActive = local.active === true
      const hasOtherOverrides = Object.keys(carried).length > 0 || wasActive
      const nextOriginalCandidate: OriginalCandidate | undefined = (remainingEditedFields.length > 0 || hasOtherOverrides)
        ? { ...orig, editedFields: remainingEditedFields }
        : undefined
      let without = removeModelRecord(models, addr, parsed.target)
      if (!isEffortStillEdited || !effortStillDifferent) {
        without = without.filter(
          (record) => !(record.removed === true && scopedTo(record, addr) && sameModelCandidate(record, orig)),
        )
      }
      without = without.filter(
        (record) => !(record.removed === true && scopedTo(record, addr) && sameModelCandidate(record, restoredCandidate)),
      )
      let next: ModelRecord[]
      // A local-only original (source === this level) has no lower row: removing
      // its tombstone is not enough, the record itself must come back. An
      // inherited/upstream original resumes by dropping the tombstone.
      const restoresLocalRow = orig.source === addr.level
      if (nextOriginalCandidate !== undefined || hasOtherOverrides || restoresLocalRow) {
        const added = addModelRecord(
          without,
          addr,
          {
            ...restoredCandidate,
            ...(nextOriginalCandidate !== undefined ? { originalCandidate: nextOriginalCandidate } : {}),
          },
          now(),
        )
        const withSettings = Object.keys(carried).length > 0
          ? setModelSettings(added, addr, restoredCandidate, carried, now())
          : added
        next = wasActive
          ? activateModel(withSettings, addr, restoredCandidate, { scopes: found.memo.ctx.scopes })
          : withSettings
      } else {
        next = without
      }
      if (JSON.stringify(next) === JSON.stringify(models)) return { refusal: `"${found.node.label}" has no override to reset` }
      return {
        models: next,
        status: `Reset "${found.node.label}" to "${modelKey(restoredCandidate)}"`,
        retryHint: `reset "${found.node.label}" against a stale revision; retry to apply`,
      }
    }
    // Legacy fallback without originalCandidate: the row was written before
    // original metadata existed, so what it replaced is unknown. Guessing the
    // active model above would restore a different candidate; refuse honestly.
    return {
      refusal: `"${found.node.label}" has no recorded original candidate to restore; delete the row instead`,
    }
  }

  return { refusal: `"${found.node.label}" is not a model field` }
}

// The compaction fields on an agent/member/preset model row (plus-1.1.18 §2).
// `setModelCompactionRow` sets or, with null, clears one or more fields at the
// row's level; the cold-cache list is edited as a whole, one write per action.

export function setModelCompactionRow(
  input: MemoInput,
  rowId: string,
  fields: ModelCompactionFieldValues,
  sharedMemo?: Memo,
): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined) return { refusal: `"${node.label}" is not a model field` }
  // A field row and a cold-cache row (its group switch or a list row) both
  // name the model to write; the list row's item carries its target too.
  const target = parseModelFieldItemId(address.item)?.target ?? parseColdModelItemId(address.item)?.target
  if (target === undefined) return { refusal: `"${node.label}" is not a model field` }
  const models = modelsOfInput(input)
  const next = setModelCompaction(models, modelScopeOf(address), target, fields, now())
  if (JSON.stringify(next) === JSON.stringify(models)) return { refusal: `"${node.label}" has no changes to save` }
  return { models: next, status: `Updated "${node.label}"`, retryHint: `edited "${node.label}" against a stale revision; retry to apply` }
}

// Space on an agent model row's compaction switch (`compactWarm` field or the
// cold-cache group): writes the inverse of the effective value.
export function toggleModelCompactionSwitch(input: MemoInput, rowId: string, sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined || node.actions?.toggle !== true) return { refusal: `"${node.label}" cannot be toggled` }
  const parsed = parseModuleCompactionSwitch(node)
  if ("refusal" in parsed) return parsed
  const on = effectiveSwitch(input, found.memo.ctx.scopes, modelScopeOf(address), parsed.target, parsed.field)
  return setModelCompactionRow(input, rowId, { [parsed.field]: on ? "off" : "on" } as ModelCompactionFieldValues, sharedMemo)
}

function parseModuleCompactionSwitch(node: { readonly address?: Address; readonly label: string }): { readonly target: { providerID: string; modelID: string; variant?: string }; readonly field: "compactWarm" | "coldCompact" } | { readonly refusal: string } {
  const parsed = node.address === undefined ? undefined : parseModelFieldItemId(node.address.item)
  const field = parsed?.field === "compactWarm" || parsed?.field === "coldCompact" ? parsed.field : undefined
  if (parsed === undefined || field === undefined) return { refusal: `"${node.label}" is not a compaction switch` }
  return { target: parsed.target, field }
}

// The effective value of compactWarm/coldCompact for one model row's chain,
// from the model rows and Defaults › Models (the agent-wide switch has no
// agent-wide seat: C1 resolves these two from the model row and below only).
function effectiveSwitch(
  input: MemoInput,
  scopes: Scopes,
  scope: RecordScope,
  target: { providerID: string; modelID: string; variant?: string },
  field: "compactWarm" | "coldCompact",
): boolean {
  const row = resolveModelCompactionFields(
    { models: input.records.filter((record): record is ModelRecord => record.type === "model"), scopes, ...scope },
    target,
  )
  const modelSettings = input.modelSettings ?? []
  const model = settingsFor(modelSettings, target)
  const every = everySettings(modelSettings)
  return effectiveCompaction({
    row,
    ...(model === undefined ? {} : { model }),
    ...(every === undefined ? {} : { every }),
  })[field].value
}

// The effective cold-cache list for one model row's chain (row, then model,
// then Every model, then built-in).
function effectiveColdList(
  input: MemoInput,
  scopes: Scopes,
  scope: RecordScope,
  target: { providerID: string; modelID: string; variant?: string },
): readonly string[] {
  const row = resolveModelCompactionFields(
    { models: input.records.filter((record): record is ModelRecord => record.type === "model"), scopes, ...scope },
    target,
  )
  const modelSettings = input.modelSettings ?? []
  const model = settingsFor(modelSettings, target)
  const every = everySettings(modelSettings)
  return effectiveCompaction({
    row,
    ...(model === undefined ? {} : { model }),
    ...(every === undefined ? {} : { every }),
  }).coldModels.value
}

/**
 * `a` on an agent cold-cache list: append through the catalogue picker. The
 * row's address is either the group's switch item or a list row's item; both
 * name the target. An inherited list is copied to this level first, so one
 * write holds the whole new order.
 */
export function addColdModelRow(input: MemoInput, rowId: string, model: string, sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  if (address === undefined) return { refusal: `"${node.label}" is not a cold-cache list` }
  const target = coldTargetOf(address.item)
  if (target === undefined) return { refusal: `"${node.label}" is not a cold-cache list` }
  const current = effectiveColdList(input, found.memo.ctx.scopes, modelScopeOf(address), target)
  if (current.includes(model)) return { refusal: `"${model}" is already in the cold-cache list` }
  return setModelCompactionRow(input, rowId, { coldModels: [...current, model] }, sharedMemo)
}

/** `d` on an agent cold-cache list row: drop that entry, keeping the order. */
export function removeColdModelRow(input: MemoInput, rowId: string, sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  const parsed = address === undefined ? undefined : parseColdModelItemId(address.item)
  if (address === undefined || parsed === undefined) return { refusal: `"${node.label}" is not a cold-cache list row` }
  const current = effectiveColdList(input, found.memo.ctx.scopes, modelScopeOf(address), parsed.target)
  if (parsed.index >= current.length) return { refusal: `"${node.label}" is no longer in the list` }
  const next = current.filter((_, index) => index !== parsed.index)
  return setModelCompactionRow(input, rowId, { coldModels: next }, sharedMemo)
}

/** `m` then ↑/↓ on an agent cold-cache list row: move one entry, one write on drop. */
export function moveColdModelRow(input: MemoInput, rowId: string, delta: -1 | 1, sharedMemo?: Memo): ModelOpResult {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const address = node.address
  const parsed = address === undefined ? undefined : parseColdModelItemId(address.item)
  if (address === undefined || parsed === undefined) return { refusal: `"${node.label}" is not a cold-cache list row` }
  const current = effectiveColdList(input, found.memo.ctx.scopes, modelScopeOf(address), parsed.target)
  const to = parsed.index + delta
  if (to < 0 || to >= current.length) return { refusal: `"${node.label}" is already at the edge of the list` }
  const next = [...current]
  const [moved] = next.splice(parsed.index, 1)
  if (moved === undefined) return { refusal: `"${node.label}" is no longer in the list` }
  next.splice(to, 0, moved)
  return setModelCompactionRow(input, rowId, { coldModels: next }, sharedMemo)
}

/** The effective cold-cache list a model row resolves to, for the move draft's base. */
export function coldListForItem(input: MemoInput, address: Address, scopes: Scopes): readonly string[] | undefined {
  const list = parseColdModelItemId(address.item)
  const field = parseModelFieldItemId(address.item)
  const target = list?.target ?? (field !== undefined && field.field === "coldCompact" ? field.target : undefined)
  if (target === undefined) return undefined
  return effectiveColdList(input, scopes, modelScopeOf(address), target)
}

/** The target an agent cold-cache row names (its switch item or a list row). */
function coldTargetOf(item: string): { providerID: string; modelID: string; variant?: string } | undefined {
  const list = parseColdModelItemId(item)
  if (list !== undefined) return list.target
  const field = parseModelFieldItemId(item)
  if (field !== undefined && field.field === "coldCompact") return field.target
  return undefined
}

// Defaults › Models cold-cache list edits return the fields modelSettings.set
// needs; the caller writes them through the RPC.

/** A Defaults cold-cache edit's result: the row's key and the whole new list. */
export interface DefaultColdEdit {
  readonly key: ModelSettingsKey
  readonly coldModels: readonly string[]
}

/** `a` on a Defaults cold-cache list: copy the inherited list and append. */
export function addDefaultColdModel(input: MemoInput, rowId: string, model: string, sharedMemo?: Memo): DefaultColdEdit | { readonly refusal: string } {
  return defaultColdEdit(input, rowId, (current) => (current.includes(model) ? { refusal: `"${model}" is already in the cold-cache list` } : { models: [...current, model] }), sharedMemo)
}

/** `d` on a Defaults cold-cache list row. */
export function removeDefaultColdModel(input: MemoInput, rowId: string, sharedMemo?: Memo): DefaultColdEdit | { readonly refusal: string } {
  return defaultColdEdit(input, rowId, (current, index) => {
    if (index === undefined || index >= current.length) return { refusal: "that row is no longer in the list" }
    return { models: current.filter((_, at) => at !== index) }
  }, sharedMemo)
}

/** `m` then ↑/↓ on a Defaults cold-cache list row. */
export function moveDefaultColdModel(input: MemoInput, rowId: string, delta: -1 | 1, sharedMemo?: Memo): DefaultColdEdit | { readonly refusal: string } {
  return defaultColdEdit(input, rowId, (current, index) => {
    if (index === undefined) return { refusal: "that row is not a list row" }
    const to = index + delta
    if (to < 0 || to >= current.length) return { refusal: "that row is already at the edge of the list" }
    const next = [...current]
    const [moved] = next.splice(index, 1)
    if (moved === undefined) return { refusal: "that row is no longer in the list" }
    next.splice(to, 0, moved)
    return { models: next }
  }, sharedMemo)
}

function defaultColdEdit(
  input: MemoInput,
  rowId: string,
  edit: (current: readonly string[], index: number | undefined) => { readonly models: readonly string[] } | { readonly refusal: string },
  sharedMemo?: Memo,
): DefaultColdEdit | { readonly refusal: string } {
  const found = findNode(input, rowId, sharedMemo)
  if (found === undefined) return { refusal: unknownRowRefusal(rowId) }
  const node = found.node
  const item = node.address?.item
  if (item === undefined) return { refusal: `"${node.label}" is not a cold-cache list` }
  const setting = parseModelSettingItemId(item)
  const list = parseColdDefaultItemId(item)
  const key = setting?.key ?? list?.key
  if (key === undefined) return { refusal: `"${node.label}" is not a cold-cache list` }
  const current = defaultColdList(input, key)
  const outcome = edit(current, list?.index)
  if ("refusal" in outcome) return outcome
  return { key, coldModels: outcome.models }
}

/** The effective cold-cache list of one Defaults › Models row. */
export function defaultColdList(input: MemoInput, key: ModelSettingsKey): readonly string[] {
  const modelSettings = input.modelSettings ?? []
  const record = settingsFor(modelSettings, key)
  const every = everySettings(modelSettings)
  if (key.providerID === undefined && key.modelID === undefined) return effectiveCompaction({ ...(record === undefined ? {} : { model: record }) }).coldModels.value
  return effectiveCompaction({ ...(record === undefined ? {} : { model: record }), ...(every === undefined ? {} : { every }) }).coldModels.value
}
// `coldModelItemId` is re-exported for the tree's list rows.
export { coldModelItemId }

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

// The one-line "warming" status a fields-only save reports.
function warmingSummaryOf(settings: ModelWarmingFields): string {
  const parts = [
    ...(settings.warming === undefined || settings.warming === null ? [] : [`${settings.warming}`]),
    ...(settings.interval === undefined || settings.interval === null ? [] : [`every ${settings.interval}`]),
    ...(settings.prompt === undefined || settings.prompt === null ? [] : ["a prompt"]),
  ]
  return parts.length === 0 ? "inherits" : parts.join(", ")
}
