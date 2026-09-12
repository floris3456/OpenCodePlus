import type { Plugin } from "@opencode/plugin/tui"
import { For, Show } from "solid-js"
import { effective } from "../../instructions/model.js"
import type { TreeNode } from "../../instructions/tree.js"
import { modelSnapshotOf } from "./state.js"
import type { Snapshot } from "../../rpc.js"

interface DetailPaneProps {
  context: Plugin.Context
  node: () => TreeNode | undefined
  snapshot: () => Snapshot | undefined
}

function resolvedText(node: TreeNode, snapshot: Snapshot): string {
  const found = snapshot.items.find((entry) => entry.id === node.itemId)
  if (!found) return "No item details"
  const item = { ...found, agents: [...found.agents] }
  const resolved = effective(modelSnapshotOf(snapshot), item, node.agentId ?? "*")
  return resolved.text
}

function badgeLabels(node: TreeNode): string[] {
  // Same badge vocabulary as the tree pane; the detail keeps it read-only.
  if (node.badges.readOnly === true) return ["protected", "read-only"]
  if (node.itemId === undefined) return []
  const labels: string[] = []
  labels.push(node.badges.enabled === false ? "disabled" : "enabled")
  if (node.badges.customized === true) labels.push("customized")
  if (node.badges.review === true) labels.push("needs review")
  return labels
}

function badgeColor(context: Plugin.Context, label: string) {
  if (label === "needs review") return context.theme.text.feedback.warning.default
  if (label === "protected" || label === "read-only") return context.theme.text.subdued
  return context.theme.text.default
}

function scopeLine(node: TreeNode): string | undefined {
  if (node.scope) return `Scope: ${node.scope}`
  if (node.agentId) return `Agent: ${node.agentId}`
  return undefined
}

export function DetailPane(props: DetailPaneProps) {
  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} paddingLeft={1} paddingRight={1}>
      <Show when={props.node()} fallback={<text fg={props.context.theme.text.subdued}>Select an item</text>}>
        {(node) => (
          <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
            <text fg={props.context.theme.text.default}>
              {node().label} ({node().kind})
            </text>
            <Show when={scopeLine(node())}>
              {(line) => <text fg={props.context.theme.text.subdued}>{line()}</text>}
            </Show>
            <For each={badgeLabels(node())}>
              {(label) => <text fg={badgeColor(props.context, label)}>{label}</text>}
            </For>
            <Show when={props.snapshot()}>
              {(snapshot) => (
                <scrollbox flexGrow={1}>
                  <text fg={props.context.theme.text.default}>{resolvedText(node(), snapshot())}</text>
                </scrollbox>
              )}
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}
