import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import type { TreeNode } from "../../instructions/tree.js"
import { createInstructionsDialogs } from "./dialogs.js"
import { createInstructionsState } from "./state.js"

// NOTE (parallel work): DiffPane (diff-pane.tsx) and Splitter
// (splitter.tsx) land separately. Enter/diff uses state.threeWay plus
// state.resolveKeep/resolveTake/resolveEdit; s/split uses
// state.splitPreview plus state.saveSplit. Keep those signatures stable
// when wiring the panes in here.
export const WIDE_THRESHOLD = 100

function isExpandable(node: TreeNode): boolean {
  return node.kind === "root" || node.kind === "group" || node.kind === "agent"
}

function canToggle(node: TreeNode | undefined): boolean {
  return node?.address !== undefined && node?.actions?.toggle === true
}

function canEdit(node: TreeNode | undefined): boolean {
  return node?.address !== undefined && node?.actions?.edit === true
}

function canReset(node: TreeNode | undefined): boolean {
  return node?.address !== undefined && node?.actions?.reset === true
}

function canRemove(node: TreeNode | undefined): boolean {
  return node?.actions?.remove === true
}

function canSplit(node: TreeNode | undefined): boolean {
  return node?.actions?.split === true
}

function isReview(node: TreeNode | undefined): boolean {
  return node?.badges.review === true
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
  const dialogs = createInstructionsDialogs(props.context, state)
  const dimensions = useTerminalDimensions()
  const wide = () => dimensions().width >= WIDE_THRESHOLD
  const [showDetail, setShowDetail] = createSignal(false)
  const [showHelp, setShowHelp] = createSignal(false)
  onCleanup(() => {
    state.dispose()
    dialogs.dispose()
  })

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
    const list = state.nodes()
    const index = list.findIndex((entry) => entry.id === node.id)
    for (let at = index - 1; at >= 0; at--) {
      const candidate = list[at]
      if (candidate.depth < node.depth && isExpandable(candidate)) {
        state.select(candidate.id)
        return
      }
    }
  }

  function expandOrChild() {
    const node = current()
    if (!node) return
    if (!wide() && node.address !== undefined && !isExpandable(node)) {
      setShowDetail(true)
      return
    }
    if (isExpandable(node)) state.toggleExpanded(node.id)
  }

  function back() {
    if (showHelp()) {
      setShowHelp(false)
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
    void state.toggle(node)
  }

  function add() {
    void dialogs.addFor(current())
  }

  function remove() {
    const node = current()
    if (!node) return
    void state.remove(node)
  }

  function resetRow() {
    const node = current()
    if (!node) return
    void state.reset(node)
  }

  async function splitRow() {
    const node = current()
    if (!node) return
    if (!canSplit(node)) {
      return
    }
    const text = state.resolvedText(node)
    const mid = Math.floor(text.length / 2)
    const newline = text.indexOf("\n", mid)
    const start = newline === -1 ? mid : newline + 1
    await state.saveSplit(node, [
      { id: "part-1", name: "Part 1", start: 0 },
      { id: "part-2", name: "Part 2", start },
    ])
  }

  async function filterPrompt() {
    const raw = await props.context.ui.dialog.prompt({
      title: "Filter",
      description: "Filter rows by label (empty clears)",
      value: state.filter(),
    })
    if (raw === undefined) return
    state.setFilter(raw)
  }

  async function enter() {
    const node = current()
    if (!node || node.address === undefined) {
      expandOrChild()
      return
    }
    if (isReview(node)) {
      const choice = await props.context.ui.dialog.select<"keep" | "take" | "edit">({
        title: `Resolve "${node.label}"`,
        options: [
          { title: "Keep mine", value: "keep" },
          { title: "Take upstream", value: "take" },
          { title: "Edit", value: "edit" },
        ],
      })
      if (choice === undefined) return
      if (choice === "keep") {
        await state.resolveKeep(node)
        return
      }
      if (choice === "take") {
        await state.resolveTake(node)
        return
      }
      const edited = await props.context.ui.dialog.prompt({
        title: `Edit "${node.label}"`,
        value: state.resolvedText(node),
      })
      if (edited === undefined) return
      await state.resolveEdit(node, edited)
      return
    }
    if (!canEdit(node)) {
      expandOrChild()
      return
    }
    const edited = await props.context.ui.dialog.prompt({
      title: `Edit "${node.label}"`,
      value: state.resolvedText(node),
    })
    if (edited === undefined) return
    await state.saveText(node, edited)
  }

  function hintLine(): string {
    if (showHelp()) return "esc close help"
    if (state.snapshot() === undefined) return "esc back"
    const node = current()
    const hints: string[] = ["up/down move"]
    if (node && isExpandable(node)) hints.push("left/right expand")
    if (!wide() && node && node.address !== undefined && !isExpandable(node) && !showDetail())
      hints.push("right detail")
    hints.push("enter edit")
    if (canToggle(node)) hints.push("space toggle")
    hints.push("a add")
    if (canRemove(node)) hints.push("d delete")
    if (canReset(node)) hints.push("r reset")
    if (canSplit(node)) hints.push("s split")
    hints.push("/ filter")
    hints.push("? help")
    if (!wide() && showDetail()) hints.push("esc back to tree")
    else hints.push("esc back")
    return hints.join(" · ")
  }

  function helpText(): string {
    return [
      "up/k down/j move · left/h collapse · right/l expand",
      "enter edit (diff menu on yellow review rows)",
      "space toggle include/exclude · a add · d delete (confirm)",
      "r reset override · s split record persistence",
      "/ filter rows · ? help · esc back",
    ].join("\n")
  }

  props.context.keymap.layer(() => {
    if (showHelp()) return { commands: [{ bind: "escape", title: "Close help", group: "Instructions", run: back }] }
    if (state.snapshot() === undefined)
      return {
        commands: [{ bind: "escape", title: "Back", group: "Instructions", run: back }],
      }
    const node = current()
    const narrowDetail = !wide() && showDetail()
    if (narrowDetail)
      return {
        commands: [{ bind: "escape", title: "Back to tree", group: "Instructions", run: back }],
      }
    return {
      commands: [
        { bind: "up,k", title: "Previous row", group: "Instructions", run: () => state.move(-1) },
        { bind: "down,j", title: "Next row", group: "Instructions", run: () => state.move(1) },
        { bind: "left,h", title: "Collapse", group: "Instructions", run: collapseOrParent },
        { bind: "right,l", title: "Expand", group: "Instructions", run: expandOrChild },
        { bind: "return", title: "Edit or diff", group: "Instructions", run: () => void enter() },
        ...(canToggle(node)
          ? [{ bind: "space", title: "Toggle include", group: "Instructions", run: toggle }]
          : []),
        { bind: "a", title: "Add", group: "Instructions", run: add },
        ...(canRemove(node)
          ? [{ bind: "d", title: "Delete", group: "Instructions", run: remove }]
          : []),
        ...(canReset(node)
          ? [{ bind: "r", title: "Reset override", group: "Instructions", run: resetRow }]
          : []),
        ...(canSplit(node)
          ? [{ bind: "s", title: "Split", group: "Instructions", run: () => void splitRow() }]
          : []),
        { bind: "/", title: "Filter", group: "Instructions", run: () => void filterPrompt() },
        { bind: "?", title: "Help", group: "Instructions", run: () => setShowHelp(true) },
        { bind: "escape", title: "Back", group: "Instructions", run: back },
      ],
    }
  })

  function marker(node: TreeNode): string {
    if (!isExpandable(node)) return " "
    return state.expanded().has(node.id) ? "-" : "+"
  }

  function badges(node: TreeNode): string {
    const parts: string[] = []
    if (node.badges.state !== undefined) parts.push(node.badges.state)
    if (node.badges.modified === true) parts.push("modified")
    if (node.badges.review === true) parts.push("review")
    if (node.badges.reviewCount !== undefined && node.badges.reviewCount > 0)
      parts.push(`${node.badges.reviewCount} to review`)
    if (node.badges.active === true) parts.push("active")
    if (parts.length === 0) return ""
    return ` [${parts.join(", ")}]`
  }

  function badgeColor(node: TreeNode) {
    if (node.badges.review === true) return props.context.theme.text.feedback.warning.default
    return props.context.theme.text.subdued
  }

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={props.context.theme.background.default}>
      <Show
        when={state.snapshot() !== undefined}
        fallback={
          <box flexGrow={1} minHeight={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
            <text fg={props.context.theme.text.feedback.info.default}>
              {state.status() || "No snapshot loaded"}
            </text>
          </box>
        }
      >
      <box flexGrow={1} minHeight={0} flexDirection={wide() ? "row" : "column"}>
        <Show
          when={wide() || !showDetail()}
          fallback={
            <box flexGrow={1} flexDirection="column" minHeight={0} paddingLeft={1} paddingRight={1}>
              <Show when={current()}>
                {(node) => (
                  <box flexDirection="column" gap={1}>
                    <text fg={props.context.theme.text.default}>
                      {node().label}
                      {badges(node())}
                    </text>
                    <text fg={props.context.theme.text.subdued}>{state.resolvedText(node())}</text>
                    <Show when={isReview(node())}>
                      <text fg={props.context.theme.text.feedback.warning.default}>needs review · enter diff</text>
                    </Show>
                  </box>
                )}
              </Show>
            </box>
          }
        >
          <box flexGrow={wide() ? 1 : 0} width={wide() ? "50%" : "100%"} flexDirection="column" minHeight={0}>
            <text fg={props.context.theme.text.subdued}>Instructions</text>
            <Show
              when={!state.loading()}
              fallback={
                <text fg={props.context.theme.text.subdued}>Loading…</text>
              }
            >
              <Show
                when={state.snapshot() !== undefined}
                fallback={
                  <text fg={props.context.theme.text.feedback.info.default}>
                    {state.status() || "No snapshot loaded"}
                  </text>
                }
              >
                <Show when={state.filter()}>
                  {(query) => (
                    <text fg={props.context.theme.text.subdued}>{`Filter: ${query()}`}</text>
                  )}
                </Show>
                <Show
                  when={state.nodes().length > 0}
                  fallback={
                    <text fg={props.context.theme.text.subdued}>No instructions found</text>
                  }
                >
                  <scrollbox flexGrow={1}>
                    <For each={state.nodes()}>
                      {(node) => (
                        <box
                          flexDirection="row"
                          backgroundColor={
                            node.id === state.selectedId()
                              ? props.context.theme.background.formfield.selected
                              : undefined
                          }
                        >
                          <text fg={props.context.theme.text.formfield.selected}>
                            {node.id === state.selectedId() ? "›" : " "}
                          </text>
                          <text fg={props.context.theme.text.default}>
                            {"  ".repeat(node.depth)}
                            {marker(node)} {node.label}
                          </text>
                          <Show when={badges(node)}>
                            <text fg={badgeColor(node)}>{badges(node)}</text>
                          </Show>
                        </box>
                      )}
                    </For>
                  </scrollbox>
                </Show>
              </Show>
            </Show>
          </box>
          <Show when={wide() && state.snapshot() !== undefined}>
            <box flexGrow={1} width="50%" flexDirection="column" minHeight={0} paddingLeft={1} paddingRight={1}>
              <Show when={current()}>
                {(node) => (
                  <box flexDirection="column" gap={1}>
                    <text fg={props.context.theme.text.default}>
                      {node().label}
                      {badges(node())}
                    </text>
                    <text fg={props.context.theme.text.subdued}>{state.resolvedText(node())}</text>
                    <Show when={isReview(node())}>
                      <text fg={props.context.theme.text.feedback.warning.default}>needs review · enter diff</text>
                    </Show>
                  </box>
                )}
              </Show>
            </box>
          </Show>
        </Show>
      </box>
      </Show>
      <Show when={showHelp()}>
        <text fg={props.context.theme.text.default}>{helpText()}</text>
      </Show>
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
