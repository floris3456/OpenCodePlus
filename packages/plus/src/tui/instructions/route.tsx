import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, onCleanup, Show } from "solid-js"
import type { TreeNode } from "../../instructions/tree.js"
import { DetailPane } from "./detail-pane.js"
import { createInstructionsState } from "./state.js"
import { TreePane } from "./tree-pane.js"

export const WIDE_THRESHOLD = 100

function isExpandable(node: TreeNode): boolean {
  return node.kind === "group" || node.kind === "agent" || node.kind === "default"
}

function isLeaf(node: TreeNode): boolean {
  return node.itemId !== undefined
}

function isTogglable(node: TreeNode): boolean {
  return node.itemId !== undefined && node.badges.readOnly !== true
}

export function InstructionsRoute(props: { context: Plugin.Context; onClose: () => void }) {
  const state = createInstructionsState(props.context)
  const dimensions = useTerminalDimensions()
  const wide = () => dimensions().width >= WIDE_THRESHOLD
  // Narrow terminals swap between panes instead of showing both.
  const [showDetail, setShowDetail] = createSignal(false)
  onCleanup(() => state.dispose())

  function current(): TreeNode | undefined {
    return state.selected()
  }

  function collapseOrParent() {
    const node = current()
    if (!node) return
    if (isExpandable(node) && state.expanded().has(node.id)) {
      state.toggleExpanded(node.id)
      return
    }
    const nodes = state.nodes()
    const index = nodes.findIndex((entry) => entry.id === node.id)
    for (let at = index - 1; at >= 0; at--) {
      const candidate = nodes[at]
      if (candidate.depth < node.depth && isExpandable(candidate)) {
        state.select(candidate.id)
        return
      }
    }
  }

  function expandOrChild() {
    const node = current()
    if (!node) return
    if (!wide() && isLeaf(node)) {
      setShowDetail(true)
      return
    }
    if (isExpandable(node)) state.toggleExpanded(node.id)
  }

  function back() {
    if (!wide() && showDetail()) {
      setShowDetail(false)
      return
    }
    props.onClose()
  }

  function toggle() {
    const node = current()
    if (!node) return
    if (!isTogglable(node)) {
      // state.setEnabled reports the read-only / non-item reason itself.
      if (node.badges.readOnly === true || node.itemId === undefined) void state.setEnabled(node, false)
      return
    }
    void state.setEnabled(node, node.badges.enabled === false)
  }

  props.context.keymap.layer(() => ({
    commands: [
      { bind: "up,k", title: "Previous row", group: "Instructions", run: () => state.move(-1) },
      { bind: "down,j", title: "Next row", group: "Instructions", run: () => state.move(1) },
      { bind: "left,h", title: "Collapse", group: "Instructions", run: collapseOrParent },
      { bind: "right,l", title: "Expand", group: "Instructions", run: expandOrChild },
      { bind: "return", title: "Expand", group: "Instructions", run: expandOrChild },
      { bind: "space", title: "Toggle enabled", group: "Instructions", run: toggle },
      { bind: "r", title: "Refresh", group: "Instructions", run: () => state.refresh() },
      { bind: "escape", title: "Back", group: "Instructions", run: back },
    ],
  }))

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={props.context.theme.background.default}>
      <box flexGrow={1} minHeight={0} flexDirection={wide() ? "row" : "column"}>
        <Show
          when={wide() || !showDetail()}
          fallback={<DetailPane context={props.context} node={state.selected} snapshot={state.snapshot} />}
        >
          <box flexGrow={wide() ? 1 : 0} width={wide() ? "50%" : "100%"}>
            <TreePane
              context={props.context}
              nodes={state.nodes}
              expanded={state.expanded}
              selectedId={state.selectedId}
              loading={state.loading}
            />
          </box>
          <Show when={wide()}>
            <box flexGrow={1} width="50%">
              <DetailPane context={props.context} node={state.selected} snapshot={state.snapshot} />
            </box>
          </Show>
        </Show>
      </box>
      <Show when={state.status()}>{(line) => <text fg={props.context.theme.text.feedback.info.default}>{line()}</text>}</Show>
      <text fg={props.context.theme.text.subdued}>
        {wide()
          ? "up/down move · left/right expand · space toggle · r refresh · esc back"
          : showDetail()
            ? "esc back to tree"
            : "up/down move · enter detail · space toggle · r refresh · esc back"}
      </text>
    </box>
  )
}
