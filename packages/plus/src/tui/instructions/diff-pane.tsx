import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { merge3, unifiedDiff } from "../../instructions/diff-lines.js"
import type { Resolution, ThreeWay } from "../../instructions/model.js"
import { KeyHints } from "./row.js"

export interface DiffPaneProps {
  readonly context: Plugin.Context
  readonly title: string
  /** Breadcrumb of the row under review. */
  readonly path?: string
  readonly threeWay: ThreeWay
  readonly active: () => boolean
  /** Under review (upstream changed under your override); otherwise a read-only compare. */
  readonly review?: boolean
  readonly onResolve: (resolution: Resolution, edited?: string) => Promise<void>
}

interface Editor {
  readonly plainText: string
  readonly isDestroyed: boolean
  focus(): void
  blur(): void
  gotoBufferEnd(): void
}

interface Comparison {
  readonly label: string
  readonly from: string
  readonly to: string
  readonly left: string
  readonly right: string
}

/** The comparisons a review answers (docs/instructions-redesign.md §2.2). */
export function comparisonsOf(threeWay: ThreeWay, review: boolean): Comparison[] {
  const yours: Comparison = { label: "Your change", from: "original upstream", to: "yours", left: threeWay.original, right: threeWay.mine }
  if (!review && threeWay.original === threeWay.upstream) return [yours]
  return [
    { label: "Upstream change", from: "original upstream", to: "new upstream", left: threeWay.original, right: threeWay.upstream },
    yours,
    { label: "Take result", from: "yours", to: "new upstream", left: threeWay.mine, right: threeWay.upstream },
  ]
}

export const CONFLICT_MARKER = /^(<<<<<<< yours|=======|>>>>>>> upstream)$/m

/** +added −removed of a unified patch. */
export function patchCounts(patch: string): { added: number; removed: number } {
  const lines = patch.split("\n").filter((line) => !line.startsWith("+++") && !line.startsWith("---"))
  return { added: lines.filter((line) => line.startsWith("+")).length, removed: lines.filter((line) => line.startsWith("-")).length }
}

// A review or compare of one row's text, rendered with OpenCode's diff
// renderer (the <diff> element and the theme's diff tokens, as /diff and the
// permission prompt use). It only knows ThreeWay strings plus a title, so the
// same pane works for whole items and for sections at any level.
export function DiffPane(props: DiffPaneProps) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const [tab, setTab] = createSignal(0)
  const [split, setSplit] = createSignal<boolean | undefined>(undefined)
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [conflicts, setConflicts] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  let area: Editor | undefined
  let scroll: ScrollBoxRenderable | undefined

  const review = () => props.review !== false
  const comparisons = createMemo(() => comparisonsOf(props.threeWay, review()))
  const current = () => comparisons()[Math.min(tab(), comparisons().length - 1)]!
  const patch = createMemo(() => unifiedDiff(current().left, current().right, { from: current().from, to: current().to }))
  const view = () => ((split() ?? dimensions().width >= 120) ? "split" : "unified")

  // e edits a merge of the upstream change onto yours, not yours alone.
  function startEdit() {
    const merged = review() ? merge3(props.threeWay.original, props.threeWay.mine, props.threeWay.upstream) : { text: props.threeWay.mine, conflicts: 0 }
    setDraft(merged.text)
    setConflicts(merged.conflicts)
    setNotice(merged.conflicts > 0 ? `${merged.conflicts} conflicting region${merged.conflicts === 1 ? "" : "s"} marked <<<<<<< yours … >>>>>>> upstream: resolve before saving` : "")
    setEditing(true)
  }

  function cancelEdit() {
    area?.blur()
    setDraft("")
    setNotice("")
    setEditing(false)
  }

  async function saveEdit() {
    const target = area
    if (target === undefined || target.isDestroyed) return
    const text = target.plainText
    setDraft(text)
    if (CONFLICT_MARKER.test(text)) {
      setNotice("Conflict markers remain: keep one side of each marked region, then save")
      return
    }
    await props.onResolve("edit", text)
    setEditing(false)
  }

  createEffect(() => {
    if (!editing()) return
    const target = area
    if (target === undefined || target.isDestroyed) return
    target.focus()
    target.gotoBufferEnd()
  })

  props.context.keymap.layer(() => {
    // Inactive means the route mounted another mode: stay silent so typing
    // and route keys pass through untouched.
    if (!props.active()) return { commands: [] }
    if (editing())
      return {
        commands: [
          { bind: "ctrl+s", title: "Save edit", group: "Instructions", run: () => void saveEdit() },
          { bind: "escape", title: "Cancel editing", group: "Instructions", run: cancelEdit },
        ],
      }
    return {
      commands: [
        ...(review()
          ? [
              { bind: "k", title: "Keep mine", group: "Instructions", run: () => void props.onResolve("keep") },
              { bind: "t", title: "Take new upstream", group: "Instructions", run: () => void props.onResolve("take") },
            ]
          : []),
        { bind: "e", title: review() ? "Edit merged text" : "Edit text", group: "Instructions", run: startEdit },
        ...comparisons().map((_, index) => ({ bind: String(index + 1), title: `Show comparison ${index + 1}`, group: "Instructions", run: () => setTab(index) })),
        { bind: "tab", title: "Next comparison", group: "Instructions", run: () => setTab((tab() + 1) % comparisons().length) },
        { bind: "v", title: "Split or unified", group: "Instructions", run: () => setSplit(view() !== "split") },
        { bind: "up", title: "Scroll up", group: "Instructions", run: () => scroll?.scrollBy(-1) },
        { bind: "down", title: "Scroll down", group: "Instructions", run: () => scroll?.scrollBy(1) },
        { bind: "pageup", title: "Page up", group: "Instructions", run: () => scroll?.scrollBy(-Math.max(1, (scroll?.viewport.height ?? 10) - 2)) },
        { bind: "pagedown", title: "Page down", group: "Instructions", run: () => scroll?.scrollBy(Math.max(1, (scroll?.viewport.height ?? 10) - 2)) },
      ],
    }
  })

  function hints(): (readonly [string, string])[] {
    if (editing()) return [["ctrl+s", "save"], ["esc", "cancel"]]
    return [
      ...(review() ? ([["k", "keep mine"], ["t", "take new"]] as const) : []),
      ["e", review() ? "edit merged" : "edit"],
      ...(comparisons().length > 1 ? ([["1-3", "comparison"]] as const) : []),
      ["v", view() === "split" ? "unified" : "split"],
      ["↑↓", "scroll"],
      ["esc", "back"],
    ]
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text flexShrink={0} fg={theme().text.base} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <Show when={props.path}>
          {(path) => (
            <text flexGrow={1} minWidth={0} wrapMode="none" truncate fg={theme().text.muted}>
              {path()}
            </text>
          )}
        </Show>
        <Show when={review()} fallback={<text flexShrink={0} fg={theme().text.muted}>compare</text>}>
          <text flexShrink={0} fg={theme().text.feedback.warning.base}>
            needs review: upstream changed since your edit
          </text>
        </Show>
      </box>
      <Show
        when={editing()}
        fallback={
          <>
            <box flexDirection="row" flexShrink={0} gap={2} paddingTop={1}>
              <For each={comparisons()}>
                {(comparison, index) => {
                  const counts = () => patchCounts(unifiedDiff(comparison.left, comparison.right, { from: "a", to: "b" }))
                  const selected = () => index() === Math.min(tab(), comparisons().length - 1)
                  return (
                    <text flexShrink={0} wrapMode="none" onMouseUp={() => setTab(index())}>
                      <span style={{ fg: theme().text.muted }}>{`${index() + 1} `}</span>
                      <span style={{ fg: selected() ? theme().text.base : theme().text.muted }}>
                        {selected() ? <b><u>{comparison.label}</u></b> : comparison.label}
                      </span>
                      <span style={{ fg: theme().diff.text.added }}>{` +${counts().added}`}</span>
                      <span style={{ fg: theme().diff.text.removed }}>{` -${counts().removed}`}</span>
                    </text>
                  )
                }}
              </For>
            </box>
            <text flexShrink={0} fg={theme().text.muted}>
              {`${current().from} → ${current().to}`}
            </text>
            <Show
              when={patch().length > 0}
              fallback={
                <box flexGrow={1} paddingTop={1}>
                  <text fg={theme().text.muted}>No differences</text>
                </box>
              }
            >
              <scrollbox flexGrow={1} minHeight={0} ref={(next: ScrollBoxRenderable) => (scroll = next)} verticalScrollbarOptions={{ visible: false }}>
                <diff
                  diff={patch()}
                  view={view()}
                  showLineNumbers={true}
                  width="100%"
                  wrapMode="word"
                  fg={theme().text.base}
                  addedBg={theme().diff.background.added}
                  removedBg={theme().diff.background.removed}
                  contextBg={theme().diff.background.context}
                  addedSignColor={theme().diff.highlight.added}
                  removedSignColor={theme().diff.highlight.removed}
                  lineNumberFg={theme().diff.lineNumber.text}
                  lineNumberBg={theme().diff.background.context}
                  addedLineNumberBg={theme().diff.lineNumber.background.added}
                  removedLineNumberBg={theme().diff.lineNumber.background.removed}
                />
              </scrollbox>
            </Show>
          </>
        }
      >
        <text flexShrink={0} fg={theme().text.muted} paddingTop={1}>
          {review() ? "Merged: the upstream change applied onto yours" : "Yours"}
        </text>
        <Show when={notice()}>
          {(line) => (
            <text flexShrink={0} fg={conflicts() > 0 || CONFLICT_MARKER.test(draft()) ? theme().text.feedback.warning.base : theme().text.muted} wrapMode="word">
              {line()}
            </text>
          )}
        </Show>
        <textarea
          flexGrow={1}
          initialValue={draft()}
          textColor={theme().text.formfield.base}
          focusedTextColor={theme().text.formfield.focused}
          cursorColor={theme().text.formfield.focused}
          ref={(next) => {
            area = next
          }}
          onContentChange={() => {
            if (area === undefined || area.isDestroyed) return
            setDraft(area.plainText)
          }}
        />
      </Show>
      <KeyHints context={props.context} hints={hints()} />
    </box>
  )
}
