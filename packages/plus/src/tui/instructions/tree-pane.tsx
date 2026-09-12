import type { Plugin } from "@opencode/plugin/tui"
import { For, Show } from "solid-js"
import type { TreeNode } from "../../instructions/tree.js"

interface TreePaneProps {
  context: Plugin.Context
  nodes: () => TreeNode[]
  expanded: () => ReadonlySet<string>
  selectedId: () => string | undefined
  loading: () => boolean
}

function marker(node: TreeNode, expanded: ReadonlySet<string>): string {
  if (!isExpandable(node)) return " "
  return expanded.has(node.id) ? "-" : "+"
}

function isExpandable(node: TreeNode): boolean {
  return node.kind === "group" || node.kind === "agent" || node.kind === "default"
}

function badgeLabels(node: TreeNode): string[] {
  // Group / agent / default headers carry only structural badges; the
  // enabled | customized | review triple belongs to item rows.
  if (node.badges.readOnly === true) return ["protected"]
  if (node.itemId === undefined) return []
  const labels: string[] = []
  labels.push(node.badges.enabled === false ? "disabled" : "enabled")
  if (node.badges.customized === true) labels.push("customized")
  if (node.badges.review === true) labels.push("needs review")
  return labels
}

function badgeColor(context: Plugin.Context, label: string) {
  // The review warning owns the feedback token; every other badge is plain
  // subdued body text. No token borrows a neighbouring role for decor.
  if (label === "needs review") return context.theme.text.feedback.warning.default
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
              {(node) => (
                <box
                  flexDirection="row"
                  backgroundColor={
                    node.id === props.selectedId()
                      ? props.context.theme.background.formfield.selected
                      : undefined
                  }
                >
                  <text fg={props.context.theme.text.formfield.selected}>
                    {node.id === props.selectedId() ? "›" : " "}
                  </text>
                  <text fg={props.context.theme.text.default}>
                    {"  ".repeat(node.depth)}
                    {marker(node, props.expanded())} {node.label}
                  </text>
                  <For each={badgeLabels(node)}>
                    {(label) => <text fg={badgeColor(props.context, label)}> [{label}]</text>}
                  </For>
                </box>
              )}
            </For>
          </scrollbox>
        </Show>
      </Show>
    </box>
  )
}
