// The middle pane's and sidebar's pick-up move mode (plus-1.2.0 S1b, B8).
//
// `startMove` takes the row the cursor is on; `advanceMove` turns one arrow
// press into a new previewed layout through the S1a planners (`planRowMove` for
// tabs and folders, `planGroupMove` for origin/sidebar lists). Nothing here
// writes to the store: the draft is a `LayoutRecords` the screen feeds to the
// tree until Enter drops it as one write or Esc throws it away. Section drafts
// carry the B42 planner's text records and split boundaries instead of layout.
import { folderIdOfRef, folderRef, type FolderRecord } from "../../instructions/folders.js"
import {
  baseMoveRefusal,
  listToken,
  planGroupMove,
  planRowMove,
  planSectionMove,
  planSystemMove,
  type OpResult,
  rowToken,
  type LayoutChange,
  type LayoutRecords,
  type RowTarget,
} from "../../instructions/ops.js"
import { agentsFileMoveRefusal, firstSlot, isAgentsFile, isModelPrompt, modelPromptMoveRefusal, modelPromptsSlot, toolsItemId, toolsMoveRefusal } from "../../instructions/system-order.js"
import { buildTreeMemo, lazyPath, systemSlotOf, type Lazy, type Memo, type MemoInput, type TreeNode } from "../../instructions/tree.js"

export interface MoveState {
  /** Tree row id of the row being moved; its token is stable while it moves. */
  readonly rowId: string
  /** The previewed layout, applied by the screen instead of the snapshot's. */
  readonly layout: LayoutRecords
  readonly target: string
  readonly status: string
  readonly section?: Exclude<OpResult, { refusal: string }>
  readonly isSection?: boolean
  /** A System list row: it moves up and down only (System has no folders). */
  readonly inSystem?: boolean
}

export type MoveStep = "up" | "down" | "in" | "out"

export type MoveStart = { readonly state: MoveState } | { readonly refusal: string }

export type MoveAdvance =
  | { readonly state: MoveState; readonly expand: readonly string[] }
  | { readonly refusal: string }

function folderTokenOf(node: Pick<TreeNode, "id" | "kind" | "address"> | undefined): string | undefined {
  const token = node === undefined ? undefined : listToken(node)
  return token !== undefined && folderIdOfRef(token) !== undefined ? token : undefined
}

// Pick a row up. Refuses structural rows (level tabs and group headings), except
// System's Base group, which moves with Role/persona as the request's first part,
// and its Model prompts group, one part of its own.
export function startMove(node: TreeNode, layout: LayoutRecords): MoveStart {
  if (node.address !== undefined && node.address.section !== null)
    return { state: { rowId: node.id, layout, target: node.id, isSection: true, status: `Moving "${node.label}"` } }
  // Base prompts only live inside System, where they are alternatives for one part.
  if (node.address?.item.startsWith("base:") === true) return { refusal: baseMoveRefusal }
  if (node.address?.item === toolsItemId) return { refusal: toolsMoveRefusal }
  if (node.address !== undefined && isAgentsFile(node.address.item)) return { refusal: agentsFileMoveRefusal }
  if (node.address !== undefined && isModelPrompt(node.address.item)) return { refusal: modelPromptMoveRefusal }
  const group = node.kind !== "group" ? undefined : node.id.endsWith(":base") ? firstSlot : node.id.endsWith(":model-prompts") ? modelPromptsSlot : undefined
  const token = group ?? listToken(node)
  if (token === undefined) return { refusal: `"${node.label}" is built-in structure and cannot move` }
  const inSystem = group !== undefined || node.address?.item.startsWith("system:") === true
  return { state: { rowId: node.id, layout, target: token, status: `Moving "${node.label}"`, ...(inSystem ? { inSystem } : {}) } }
}

// One arrow press. `input` already carries the draft layout (the screen's
// `memoInput` swaps the draft in while a move is active), so the tree the
// planner sees is exactly the preview on screen.
export function advanceMove(input: MemoInput, state: MoveState, step: MoveStep, sharedMemo?: Memo): MoveAdvance {
  const memo = sharedMemo ?? buildTreeMemo(input)
  const path = lazyPath(memo, state.rowId)
  const node = path.at(-1)
  if (node === undefined) return { refusal: "That row is gone" }
  const parent = path.at(-2)
  const section = node.address !== undefined && node.address.section !== null
  const siblings = (parent?.children() ?? []).filter((entry) => !section || entry.address?.section !== undefined && entry.address.section !== null)
  const position = siblings.findIndex((entry) => entry.id === state.rowId)
  if (node.address !== undefined && node.address.section !== null) {
    if (step === "in" || step === "out")
      return { refusal: "Sections move only within the same parent; cross-parent nesting is not supported (B42)" }
    const neighbour = siblings[position + (step === "up" ? -1 : 1)]
    if (neighbour === undefined) return { refusal: "Already at the edge of its sibling sections" }
    const change = planSectionMove(input, node.id, step === "up" ? { before: neighbour.id } : { after: neighbour.id }, new Date().toISOString(), memo)
    if ("refusal" in change) return change
    return { state: { ...state, section: change, status: change.status }, expand: [] }
  }
  // A System list moves whole parts: the neighbour is the next row of another
  // part, so Role/persona and Base pass each other's rows as one.
  if (parent !== undefined && parent.id.startsWith("group:") && parent.id.endsWith(":system")) {
    if (step === "in" || step === "out") return { refusal: "System has no folders: its list is the order the model receives the parts" }
    const slot = systemSlotOf(memo, node)
    const ahead = step === "up" ? siblings.slice(0, position).reverse() : siblings.slice(position + 1)
    const neighbour = ahead.find((entry) => systemSlotOf(memo, entry) !== slot)
    if (neighbour === undefined) return { refusal: step === "up" ? "Already at the top of its list" : "Already at the bottom of its list" }
    return apply(state, planSystemMove(input, state.layout, node.id, step === "up" ? { before: neighbour.id } : { after: neighbour.id }, new Date().toISOString(), memo))
  }
  switch (step) {
    case "up":
    case "down": {
      const neighbour = siblings[position + (step === "up" ? -1 : 1)]
      if (neighbour === undefined) return { refusal: step === "up" ? "Already at the top of its list" : "Already at the bottom of its list" }
      return apply(state, planFor(input, state.layout, node, parent, step === "up" ? { before: neighbour.id } : { after: neighbour.id }, memo))
    }
    case "in": {
      // Origin headings are fixed presentation structure, not folder boundaries.
      // Their ordinary rows enter the first root folder of the same tab; within
      // a folder or tab, Right retains its next-sibling nesting behavior.
      const tab = path.slice(0, -1).findLast((row) => rowToken(row)?.startsWith("tab:"))
      const origin = parent !== undefined && rowToken(parent) === undefined && tab !== undefined
      const next = origin
        ? tab.children().find((entry) => folderTokenOf(entry) !== undefined)
        : siblings[position + 1]
      if (next === undefined) return { refusal: `"${node.label}" has no folder below to enter` }
      if (next.address !== undefined && next.address.section !== null) return { refusal: `"${next.label}" is a section; moving sections is owed` }
      if (folderTokenOf(next) === undefined) return { refusal: `"${next.label}" is not a folder to enter` }
      return apply(state, planFor(input, state.layout, node, parent, { into: next.id }, memo), [next.id])
    }
    case "out": {
      const parentFolder = folderTokenOf(parent)
      if (parentFolder === undefined) return { refusal: `"${node.label}" is not inside a folder` }
      const into = holderRef(state.layout.folders, parentFolder)
      if (into === undefined) return { refusal: `"${node.label}" cannot leave its folder` }
      return apply(state, planFor(input, state.layout, node, parent, { into }, memo))
    }
  }
}

// Tabs and folders go through planRowMove; an origin/sidebar list group through
// planGroupMove. `parent` is the row's current container.
function planFor(input: MemoInput, layout: LayoutRecords, node: Lazy, parent: Lazy | undefined, target: RowTarget, memo: Memo): LayoutChange {
  const updated = new Date().toISOString()
  const inTabOrFolder = target.into !== undefined || parent === undefined || folderTokenOf(parent) !== undefined || rowToken(parent)?.startsWith("tab:") === true
  return inTabOrFolder
    ? planRowMove(input, layout, node.id, target, updated, memo)
    : planGroupMove(input, layout, node.id, target, updated, memo)
}

function apply(state: MoveState, change: LayoutChange, expand: readonly string[] = []): MoveAdvance {
  if ("refusal" in change) return { refusal: change.refusal }
  const relocated = (id: string) => {
    const at = id.indexOf(":folder:")
    if (at < 0) return id
    const owner = id.slice(0, at)
    const copied = `${owner}/${id.slice(at + ":folder:".length)}`
    return change.layout.folders.some((folder) => folder.owner === owner && folder.id === copied) ? `${owner}:folder:${copied}` : id
  }
  return { state: { ...state, rowId: relocated(state.rowId), layout: change.layout, target: change.target, status: change.status }, expand: expand.map(relocated) }
}

// The list that holds `token`: the folder whose `items` name it, else the tab
// the token belongs to.
function holderRef(folders: readonly FolderRecord[], token: string): string | undefined {
  const holder = folders.find((folder) => folder.items.includes(token))
  if (holder !== undefined) return folderRef(holder.id)
  const id = folderIdOfRef(token)
  const tab = id === undefined ? undefined : folders.find((folder) => folder.id === id)?.tab
  return tab === undefined ? undefined : `tab:${tab}`
}
