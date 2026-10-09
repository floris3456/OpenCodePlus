// The middle pane's and sidebar's pick-up move mode (plus-1.2.0 S1b, B8).
//
// `startMove` takes the row the cursor is on; `advanceMove` turns one arrow
// press into a new previewed layout through the S1a planners (`planRowMove` for
// tabs and folders, `planGroupMove` for origin/sidebar lists). Nothing here
// writes to the store: the draft is a `LayoutRecords` the screen feeds to the
// tree until Enter drops it as one write or Esc throws it away. A section move
// is refused here and stays owed until the fold-on-move rule is settled.
import { folderIdOfRef, folderRef, type FolderRecord } from "../../instructions/folders.js"
import {
  listToken,
  planGroupMove,
  planRowMove,
  rowToken,
  tabGroupIndex,
  type LayoutChange,
  type LayoutRecords,
  type RowTarget,
} from "../../instructions/ops.js"
import { expandedTree, type MemoInput, type TreeNode } from "../../instructions/tree.js"

export interface MoveState {
  /** Tree row id of the row being moved; its token is stable while it moves. */
  readonly rowId: string
  /** The previewed layout, applied by the screen instead of the snapshot's. */
  readonly layout: LayoutRecords
  readonly target: string
  readonly status: string
}

export type MoveStep = "up" | "down" | "in" | "out"

export type MoveStart = { readonly state: MoveState } | { readonly refusal: string }

export type MoveAdvance =
  | { readonly state: MoveState; readonly expand: readonly string[] }
  | { readonly refusal: string }

function folderTokenOf(node: TreeNode | undefined): string | undefined {
  const token = node === undefined ? undefined : listToken(node)
  return token !== undefined && folderIdOfRef(token) !== undefined ? token : undefined
}

// Pick a row up. Refuses structural rows (level tabs, group headings, sections).
export function startMove(node: TreeNode, layout: LayoutRecords): MoveStart {
  if (node.address !== undefined && node.address.section !== null)
    return { refusal: `"${node.label}" is a section; moving sections is owed` }
  const token = listToken(node)
  if (token === undefined) return { refusal: `"${node.label}" is built-in structure and cannot move` }
  return { state: { rowId: node.id, layout, target: token, status: `Moving "${node.label}"` } }
}

// One arrow press. `input` already carries the draft layout (the screen's
// `memoInput` swaps the draft in while a move is active), so the tree the
// planner sees is exactly the preview on screen.
export function advanceMove(input: MemoInput, state: MoveState, step: MoveStep): MoveAdvance {
  const nodes = expandedTree(input)
  const index = nodes.findIndex((node) => node.id === state.rowId)
  const node = nodes[index]
  if (node === undefined) return { refusal: "That row is gone" }
  const parent = parentOf(nodes, index)
  const siblings = parent === undefined ? [] : directChildren(nodes, parent)
  const position = siblings.findIndex((entry) => entry.id === state.rowId)
  switch (step) {
    case "up":
    case "down": {
      const neighbour = siblings[position + (step === "up" ? -1 : 1)]
      if (neighbour === undefined) return { refusal: step === "up" ? "Already at the top of its list" : "Already at the bottom of its list" }
      return apply(state, planFor(input, state.layout, node, parent, step === "up" ? { before: neighbour.id } : { after: neighbour.id }))
    }
    case "in": {
      // Origin headings are fixed presentation structure, not folder boundaries.
      // Their ordinary rows enter the first root folder of the same tab; within
      // a folder or tab, Right retains its next-sibling nesting behavior.
      const tabIndex = tabGroupIndex(nodes, index)
      const origin = parent !== undefined && rowToken(parent) === undefined && tabIndex !== undefined
      const next = origin
        ? directChildren(nodes, nodes[tabIndex]!).find((entry) => folderTokenOf(entry) !== undefined)
        : siblings[position + 1]
      if (next === undefined) return { refusal: `"${node.label}" has no folder below to enter` }
      if (next.address !== undefined && next.address.section !== null) return { refusal: `"${next.label}" is a section; moving sections is owed` }
      if (folderTokenOf(next) === undefined) return { refusal: `"${next.label}" is not a folder to enter` }
      return apply(state, planFor(input, state.layout, node, parent, { into: next.id }), [next.id])
    }
    case "out": {
      const parentFolder = folderTokenOf(parent)
      if (parentFolder === undefined) return { refusal: `"${node.label}" is not inside a folder` }
      const into = holderRef(state.layout.folders, parentFolder)
      if (into === undefined) return { refusal: `"${node.label}" cannot leave its folder` }
      return apply(state, planFor(input, state.layout, node, parent, { into }))
    }
  }
}

// Tabs and folders go through planRowMove; an origin/sidebar list group through
// planGroupMove. `parent` is the row's current container.
function planFor(input: MemoInput, layout: LayoutRecords, node: TreeNode, parent: TreeNode | undefined, target: RowTarget): LayoutChange {
  const updated = new Date().toISOString()
  const inTabOrFolder = target.into !== undefined || parent === undefined || folderTokenOf(parent) !== undefined || rowToken(parent)?.startsWith("tab:") === true
  return inTabOrFolder
    ? planRowMove(input, layout, node.id, target, updated)
    : planGroupMove(input, layout, node.id, target, updated)
}

function apply(state: MoveState, change: LayoutChange, expand: readonly string[] = []): MoveAdvance {
  if ("refusal" in change) return { refusal: change.refusal }
  return { state: { ...state, layout: change.layout, target: change.target, status: change.status }, expand }
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

function parentOf(nodes: readonly TreeNode[], index: number): TreeNode | undefined {
  const depth = nodes[index]?.depth
  if (depth === undefined || depth === 0) return undefined
  for (let at = index - 1; at >= 0; at--) if ((nodes[at]?.depth ?? -1) < depth) return nodes[at]
  return undefined
}

function directChildren(nodes: readonly TreeNode[], parent: TreeNode): TreeNode[] {
  const index = nodes.findIndex((node) => node.id === parent.id)
  if (index === -1) return []
  const out: TreeNode[] = []
  for (let at = index + 1; at < nodes.length; at++) {
    const row = nodes[at]!
    if (row.depth <= parent.depth) break
    if (row.depth === parent.depth + 1) out.push(row)
  }
  return out
}
