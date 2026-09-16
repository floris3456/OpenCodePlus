import type { Plugin } from "@opencode/plugin/tui"
import { For, Show } from "solid-js"
import type { TreeNode } from "../../instructions/tree.js"

export interface TreePaneProps {
  context: Plugin.Context
  nodes: () => TreeNode[]
  expanded: () => ReadonlySet<string>
  selectedId: () => string | undefined
  loading: () => boolean
}

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

export function badgeLabels(node: TreeNode): string[] {
  const labels: string[] = []
  // On/off reads from the badge state, not the address: item and section
  // rows always carry state, and team rows carry state with no address (a
  // synthetic address would corrupt the mutate path). Structural rows carry
  // no state and still render no badge.
  if (node.badges.state !== undefined) labels.push(node.badges.state === "off" ? "off" : "on")
  if (node.badges.modified === true) labels.push("modified")
  if (node.badges.active === true) labels.push("active")
  if (node.badges.inactive === true) labels.push("inactive")
  if (node.badges.pinned === true) labels.push("pinned")
  if (node.badges.unsupported === true) labels.push("unsupported")
  const count = node.badges.reviewCount ?? 0
  if (count > 0) labels.push(`${count} to review`)
  else if (node.badges.review === true) labels.push("review")
  return labels
}

export function isReviewLabel(label: string): boolean {
  return label === "review" || label.endsWith(" to review")
}

export function badgeColor(context: Plugin.Context, label: string) {
  // Review and unsupported both flag saved content needing user attention:
  // review means upstream changed under an override, unsupported means a
  // whole Role/persona or base row cannot be excluded. Both are warning
  // status feedback, so both own the feedback warning token. Active,
  // inactive, and pinned describe row state and stay plain subdued body text
  // like every other non-review badge: pinned in particular must never borrow
  // warning yellow.
  if (isReviewLabel(label)) return context.theme.text.feedback.warning.default
  if (label === "unsupported") return context.theme.text.feedback.warning.default
  return context.theme.text.subdued
}

export function TreePane(props: TreePaneProps) {
  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} paddingLeft={1} paddingRight={1}>
      <text flexShrink={0} fg={props.context.theme.text.subdued}>
        Instructions
      </text>
      <Show
        when={!props.loading()}
        fallback={
          <text flexShrink={0} fg={props.context.theme.text.subdued}>
            Loading…
          </text>
        }
      >
        <Show
          when={props.nodes().length > 0}
          fallback={
            <text flexShrink={0} fg={props.context.theme.text.subdued}>
              No instructions found
            </text>
          }
        >
          <scrollbox flexGrow={1}>
            <For each={props.nodes()}>
              {(node, index) => {
                const visible = () => hasVisibleChildren(props.nodes(), index())
                const marker = () => rowMarker(node, visible(), props.expanded())
                const selected = () => node.id === props.selectedId()
                return (
                  <box
                    flexDirection="row"
                    backgroundColor={selected() ? props.context.theme.background.formfield.selected : undefined}
                  >
                    <text fg={props.context.theme.text.formfield.selected}>{selected() ? "›" : " "}</text>
                    <text fg={props.context.theme.text.default}>
                      {"  ".repeat(node.depth)}
                      {marker()} {node.label}
                    </text>
                    <For each={badgeLabels(node)}>
                      {(label) => <text fg={badgeColor(props.context, label)}> [{label}]</text>}
                    </For>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </Show>
      </Show>
    </box>
  )
}
