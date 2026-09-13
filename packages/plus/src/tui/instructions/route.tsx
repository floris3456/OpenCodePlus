import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import type { TreeNode } from "../../instructions/tree.js"
import { DetailPane, isEditable } from "./detail-pane.js"
import { createInstructionsState } from "./state.js"
import { TreePane } from "./tree-pane.js"

export const WIDE_THRESHOLD = 100

function isExpandable(node: TreeNode): boolean {
  return node.kind === "group" || node.kind === "agent" || node.kind === "default"
}

function isLeaf(node: TreeNode): boolean {
  return node.itemId !== undefined
}

function isTogglable(node: TreeNode | undefined): boolean {
  if (!node) return false
  if (node.itemId === undefined) return false
  if (node.badges.readOnly === true) return false
  return node.action?.toggle.allowed === true
}

function isAcknowledgable(node: TreeNode | undefined): boolean {
  if (!node) return false
  if (node.badges.readOnly === true) return false
  if (node.itemId === undefined) return false
  if (node.badges.review !== true) return false
  return node.action?.edit.allowed === true || node.action?.toggle.allowed === true
}

function isResettable(node: TreeNode | undefined): boolean {
  if (!node) return false
  if (node.badges.readOnly === true) return false
  if (node.itemId === undefined) return false
  // state.reset refuses read-only rows and rows whose reset capability is
  // disallowed, so advertise only rows that can actually succeed.
  return node.action?.reset.allowed === true
}

export function extractAgentId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  if (!("agent" in data)) return undefined
  const value = data.agent
  if (typeof value === "string" && value.length > 0) return value
  return undefined
}

export interface InstructionsRouteProps {
  readonly context: Plugin.Context
  readonly onClose: () => void
  readonly data?: unknown
}

export function InstructionsRoute(props: InstructionsRouteProps) {
  const state = createInstructionsState(props.context)
  const dimensions = useTerminalDimensions()
  const wide = () => dimensions().width >= WIDE_THRESHOLD
  // Narrow terminals swap between panes instead of showing both.
  const [showDetail, setShowDetail] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const detailMounted = () => wide() || showDetail()
  const detailSlot = (): "wide" | "narrow" | "none" => {
    if (wide()) return "wide"
    if (showDetail()) return "narrow"
    return "none"
  }
  createEffect((previous?: "wide" | "narrow" | "none") => {
    const slot = detailSlot()
    if (previous !== undefined && previous !== slot && editing()) setEditing(false)
    if (!detailMounted() && editing()) setEditing(false)
    return slot
  }, undefined)
  onCleanup(() => state.dispose())

  const route = props.context.ui.router.current()
  const navigationData: unknown = props.data ?? (route.type === "plugin" ? route.data : undefined)
  const initialAgent = extractAgentId(navigationData)

  let initialApplied = false
  createEffect(() => {
    if (initialApplied) return
    const snap = state.snapshot()
    if (!snap) return
    if (initialAgent === undefined) {
      initialApplied = true
      return
    }
    // The first snapshot can predate the new agent's discoverability, so only
    // consume the handoff once selectAgent actually lands on it. Later
    // snapshots retry; after success the guard above never re-hijacks.
    if (state.selectAgent(initialAgent)) initialApplied = true
  })

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
    if (editing()) {
      // The detail pane owns escape while editing; this path only covers
      // races where its layer has not mounted yet.
      setEditing(false)
      return
    }
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
      // state.setEnabled reports the refusal reason itself.
      void state.setEnabled(node, false)
      return
    }
    void state.setEnabled(node, node.badges.enabled === false)
  }

  function acknowledge() {
    const node = current()
    if (!node) return
    void state.acknowledge(node)
  }

  function reset() {
    const node = current()
    if (!node) return
    // state.reset reports the refusal reason itself.
    void state.reset(node)
  }

  function hintLine(): string {
    if (editing() && detailMounted()) return "ctrl+s save · esc cancel"
    // Advertise only what the selected row supports; unsupported verbs
    // would promise actions the state layer refuses. Fixed navigation
    // verbs first, then the row-dependent verbs that fit on one line.
    const node = current()
    const hints: string[] = []
    const narrowDetail = !wide() && showDetail()
    if (!wide() && !showDetail()) {
      hints.push("up/down move")
      if (node && isLeaf(node)) hints.push("enter detail")
      if (node && isExpandable(node)) hints.push("left/right expand")
    }
    if (wide()) {
      hints.push("up/down move")
      if (node && isExpandable(node)) hints.push("left/right expand")
    }
    if (isTogglable(node)) hints.push("space toggle")
    if (isAcknowledgable(node)) hints.push("a acknowledge")
    if (detailMounted() && isEditable(node)) hints.push("e edit")
    if (isResettable(node)) hints.push("x reset")
    if (!narrowDetail) hints.push("r refresh")
    hints.push(narrowDetail ? "esc back to tree" : "esc back")
    return hints.join(" · ")
  }

  props.context.keymap.layer(() => {
    // While the detail editor owns the keyboard, tree navigation stays
    // silent so typing never moves the selection or toggles rows.
    if (editing() && detailMounted()) return { commands: [] }
    const node = current()
    return {
      commands: [
        { bind: "up,k", title: "Previous row", group: "Instructions", run: () => state.move(-1) },
        { bind: "down,j", title: "Next row", group: "Instructions", run: () => state.move(1) },
        { bind: "left,h", title: "Collapse", group: "Instructions", run: collapseOrParent },
        { bind: "right,l", title: "Expand", group: "Instructions", run: expandOrChild },
        { bind: "return", title: "Expand", group: "Instructions", run: expandOrChild },
        ...(isTogglable(node) ? [{ bind: "space", title: "Toggle enabled", group: "Instructions", run: toggle }] : []),
        ...(isAcknowledgable(node) ? [{ bind: "a", title: "Acknowledge review", group: "Instructions", run: acknowledge }] : []),
        ...(isResettable(node) ? [{ bind: "x", title: "Reset to default", group: "Instructions", run: reset }] : []),
        { bind: "r", title: "Refresh", group: "Instructions", run: () => void state.refresh() },
        { bind: "escape", title: "Back", group: "Instructions", run: back },
      ],
    }
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={props.context.theme.background.default}>
      <box flexGrow={1} minHeight={0} flexDirection={wide() ? "row" : "column"}>
        <Show
          when={wide() || !showDetail()}
          fallback={
            <DetailPane
              context={props.context}
              node={state.selected}
              snapshot={state.snapshot}
              state={state}
              editing={editing}
              onEditingChange={setEditing}
            />
          }
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
              <DetailPane
                context={props.context}
                node={state.selected}
                snapshot={state.snapshot}
                state={state}
                editing={editing}
                onEditingChange={setEditing}
              />
            </box>
          </Show>
        </Show>
      </box>
      <Show when={state.status()}>
        {(line) => (
          <text flexShrink={0} fg={props.context.theme.text.feedback.info.default}>
            {line()}
          </text>
        )}
      </Show>
      <text flexShrink={0} fg={props.context.theme.text.subdued}>
        {hintLine()}
      </text>
    </box>
  )
}
