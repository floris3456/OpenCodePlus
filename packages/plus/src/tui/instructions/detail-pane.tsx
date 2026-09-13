import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, Show } from "solid-js"
import { effective } from "../../instructions/model.js"
import type { TreeNode } from "../../instructions/tree.js"
import type { Snapshot } from "../../rpc.js"
import { modelSnapshotOf, type InstructionsState } from "./state.js"

export interface DetailPaneProps {
  context: Plugin.Context
  node: () => TreeNode | undefined
  snapshot: () => Snapshot | undefined
  state: InstructionsState
  editing: () => boolean
  onEditingChange: (editing: boolean) => void
}

function resolvedText(node: TreeNode, snapshot: Snapshot): string {
  const found = snapshot.items.find((entry) => entry.id === node.itemId)
  if (!found) return "No item details"
  const item = { ...found, agents: [...found.agents] }
  const resolved = effective(modelSnapshotOf(snapshot), item, node.agentId ?? "*")
  return resolved.text
}

export function isEditable(node: TreeNode | undefined): boolean {
  if (!node) return false
  if (node.badges.readOnly === true) return false
  if (node.itemId === undefined) return false
  // A row whose edit is disallowed has no save path, so it must never
  // enter edit mode: opening the editor would only discard the draft.
  return node.action?.edit.allowed === true
}

function badgeLabels(node: TreeNode): string[] {
  // Same badge vocabulary as the tree pane; the detail keeps it read-only.
  if (node.badges.readOnly === true) return ["protected", "read-only"]
  if (node.itemId === undefined) return []
  const labels: string[] = []
  // The enabled state shows only where it can be toggled; elsewhere the
  // badge would read as an action that does not exist.
  if (node.action?.toggle.allowed === true) labels.push(node.badges.enabled === false ? "disabled" : "enabled")
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
  const [draft, setDraft] = createSignal<string>("")
  let area: { plainText: string; isDestroyed: boolean; focus(): void; blur(): void; gotoBufferEnd(): void } | undefined

  function editable(): boolean {
    return isEditable(props.node())
  }

  function cancelEditing() {
    area?.blur()
    setDraft("")
    props.onEditingChange(false)
  }

  async function saveEditing() {
    const target = area
    const node = props.node()
    if (!target || target.isDestroyed || !node) return
    setDraft(target.plainText)
    const saved = await props.state.saveText(node, target.plainText)
    if (saved) cancelEditing()
  }

  function isEditing(): boolean {
    return props.editing() && editable()
  }

  createEffect(() => {
    if (!isEditing()) return
    const target = area
    if (!target || target.isDestroyed) return
    target.focus()
    target.gotoBufferEnd()
  })

  // Drafts belong to one node: leaving the node discards the editor
  // instead of saving stale text against a new target. Snapshot changes
  // alone must not discard: a stale-revision save adopts the new snapshot
  // and keeps the draft so the user can save again.
  createEffect((previous: string | undefined) => {
    const node = props.node()
    const current = node?.id
    if (previous !== undefined && current !== previous && props.editing()) cancelEditing()
    return current
  }, undefined)

  props.context.keymap.layer(() => {
    if (!isEditing()) {
      const node = props.node()
      const snapshot = props.snapshot()
      if (!node || !snapshot) return { commands: [] }
      if (!editable()) return { commands: [] }
      return {
        commands: [
          {
            bind: "e",
            title: "Edit text",
            group: "Instructions",
            run: () => {
              setDraft(resolvedText(node, snapshot))
              props.onEditingChange(true)
            },
          },
        ],
      }
    }
    return {
      commands: [
        { bind: "ctrl+s", title: "Save text", group: "Instructions", run: () => void saveEditing() },
        { bind: "escape", title: "Cancel editing", group: "Instructions", run: cancelEditing },
      ],
    }
  })

  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} paddingLeft={1} paddingRight={1}>
      <Show
        when={props.node()}
        fallback={
          <text flexShrink={0} fg={props.context.theme.text.subdued}>
            Select an item
          </text>
        }
      >
        {(node) => (
          <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
            <text flexShrink={0} fg={props.context.theme.text.default}>
              {node().label} ({node().kind})
            </text>
            <Show when={scopeLine(node())}>
              {(line) => (
                <text flexShrink={0} fg={props.context.theme.text.subdued}>
                  {line()}
                </text>
              )}
            </Show>
            <For each={badgeLabels(node())}>
              {(label) => (
                <text flexShrink={0} fg={badgeColor(props.context, label)}>
                  {label}
                </text>
              )}
            </For>
            <Show when={props.snapshot()}>
              {(snapshot) => (
                <Show
                  when={isEditing()}
                  fallback={
                    <scrollbox flexGrow={1}>
                      <text fg={props.context.theme.text.default}>{resolvedText(node(), snapshot())}</text>
                    </scrollbox>
                  }
                >
                  <textarea
                    flexGrow={1}
                    initialValue={draft()}
                    textColor={props.context.theme.text.formfield.default}
                    focusedTextColor={props.context.theme.text.formfield.focused}
                    cursorColor={props.context.theme.text.formfield.focused}
                    ref={(next) => {
                      area = next
                    }}
                    onContentChange={() => {
                      if (!area || area.isDestroyed) return
                      setDraft(area.plainText)
                    }}
                  />
                  <text flexShrink={0} fg={props.context.theme.text.subdued}>
                    ctrl+s save · esc cancel
                  </text>
                </Show>
              )}
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}
