import type { Plugin } from "@opencode/plugin/tui"
import { badgeLabels } from "../../instructions/from-label.js"
import { controlKind, type TreeNode } from "../../instructions/tree.js"

// The badge words are shared with `instructions_list` (from-label.ts).
export { badgeLabels }

// Visible children come straight from the flat list: the next row is deeper.
export function hasVisibleChildren(nodes: readonly TreeNode[], index: number): boolean {
  const node = nodes[index]
  const next = nodes[index + 1]
  if (node === undefined || next === undefined) return false
  return next.depth > node.depth
}

// Sections, model rows, and perm rule rows are always leaves. Every other row
// owns logical children (an item always has its split sections), so a
// collapsed non-section row keeps its "+" marker even though the children are
// hidden from the flat list.
export function isExpandableRow(node: TreeNode, visibleChildren: boolean, expanded: ReadonlySet<string>): boolean {
  if (node.kind === "section") return false
  if (node.kind === "item" && controlKind(node.address?.item) !== undefined) return false
  if (node.address?.item.startsWith("model:")) return false
  if (node.address?.item.startsWith("perm:")) return false
  if (visibleChildren) return true
  if (expanded.has(node.id)) return false
  return true
}

export function rowMarker(node: TreeNode, visibleChildren: boolean, expanded: ReadonlySet<string>): string {
  if (!isExpandableRow(node, visibleChildren, expanded)) return " "
  return expanded.has(node.id) ? "-" : "+"
}

export function isReviewLabel(label: string): boolean {
  return label === "review" || label.endsWith(" to review") || label.startsWith("to review")
}

/**
 * Where an inheriting row's value comes from, for the dim suffix after its
 * badges ("from preset Orchestrator", "OpenCode", "off by default", …).
 * Nothing when the row sets the value itself.
 */
export function provenanceSuffix(node: TreeNode): string | undefined {
  const label = node.badges.fromLabel
  if (label === undefined || label === "set here") return undefined
  return label
}

export function badgeColor(context: Plugin.Context, label: string) {
  // Review and unsupported both flag saved content needing user attention:
  // review means upstream changed under an override, unsupported means a
  // whole Role/persona or base row cannot be excluded. Both are warning
  // status feedback, so both own the feedback warning token. Active,
  // inactive, and pinned describe row state and stay plain subdued body text
  // like every other non-review badge: pinned in particular must never borrow
  // warning yellow.
  if (isReviewLabel(label)) return context.theme.text.feedback.warning.base
  if (label === "unsupported") return context.theme.text.feedback.warning.base
  // A link to a deleted preset: the rows fall through until it is relinked.
  if (label === "missing preset") return context.theme.text.feedback.warning.base
  return context.theme.text.muted
}

export function controlColor(context: Plugin.Context, node: TreeNode) {
  return node.badges.disabled === undefined ? context.theme.text.formfield.base : context.theme.text.formfield.disabled
}

export function controlLabels(node: TreeNode): string[] {
  return [
    ...(node.badges.hidden === true ? ["hidden"] : []),
    ...(node.badges.mode ? [node.badges.mode] : []),
    ...(node.badges.disabled === undefined ? [] : ["Remote"]),
  ]
}
