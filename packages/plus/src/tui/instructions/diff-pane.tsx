import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { unifiedDiff } from "../../instructions/diff-lines.js"
import { defaultInclude, mergeUnits, renderMerge, type MergeEntry } from "../../instructions/merge-units.js"
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
  /** Take result only: shown as merge rows; the include set decides its text. */
  readonly merge?: boolean
}

type MergeRow = { readonly type: "context"; readonly text: string } | { readonly type: "change"; readonly id: string; readonly label: string; readonly text: string; readonly conflict: boolean }

/**
 * The comparisons a review answers (docs/instructions-redesign.md §2.2). Take
 * result is the merge proposal (B13): rows from mergeUnits, with the default
 * include set. Its text carries no conflict markers.
 */
export function comparisonsOf(threeWay: ThreeWay, review: boolean): Comparison[] {
  const yours: Comparison = { label: "Your change", from: "original upstream", to: "yours", left: threeWay.original, right: threeWay.mine }
  if (!review && threeWay.original === threeWay.upstream) return [yours]
  const entries = mergeUnits(threeWay.original, threeWay.mine, threeWay.upstream)
  return [
    { label: "Upstream change", from: "original upstream", to: "new upstream", left: threeWay.original, right: threeWay.upstream },
    yours,
    { label: "Take result", from: "yours", to: "merged result", left: threeWay.mine, right: renderMerge(entries, defaultInclude(entries)), merge: true },
  ]
}

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
  const [cursor, setCursor] = createSignal(0)
  let area: Editor | undefined
  let scroll: ScrollBoxRenderable | undefined

  const entries = createMemo(() => mergeUnits(props.threeWay.original, props.threeWay.mine, props.threeWay.upstream))
  const [include, setInclude] = createSignal(defaultInclude(entries()))
  // A new proposal (a fresh threeWay after a save or a refresh) starts from its defaults.
  createEffect(
    on(
      () => JSON.stringify(props.threeWay),
      () => {
        setInclude(defaultInclude(entries()))
        setCursor(0)
      },
      { defer: true },
    ),
  )
  const rows = createMemo(() => mergeRows(entries()))
  const changes = createMemo(() => rows().flatMap((row) => (row.type === "change" ? [row] : [])))
  const cursorId = () => changes()[cursor()]?.id
  const rendered = () => renderMerge(entries(), include())

  const review = () => props.review !== false
  const comparisons = createMemo(() => comparisonsOf(props.threeWay, review()))
  const current = () => comparisons()[Math.min(tab(), comparisons().length - 1)]!
  const onMerge = () => current().merge === true
  // Each tab shows both sides in full, so every tab shares one continuous line
  // universe and no unchanged text is missing. Compact hunks (the default)
  // stay for the tab counters and every non-review caller.
  const patch = createMemo(() =>
    unifiedDiff(current().left, current().right, { from: current().from, to: current().to }, { context: Number.POSITIVE_INFINITY }),
  )
  const view = () => ((split() ?? dimensions().width >= 120) ? "split" : "unified")

  function moveCursor(step: number) {
    const last = changes().length - 1
    if (last < 0) return
    const next = Math.min(last, Math.max(0, cursor() + step))
    setCursor(next)
    const id = changes()[next]?.id
    if (id !== undefined) scroll?.scrollChildIntoView(`merge-${id}`)
  }

  function toggle() {
    const id = cursorId()
    if (id === undefined) return
    setInclude((prev) => new Set(prev.has(id) ? [...prev].filter((item) => item !== id) : [...prev, id]))
  }

  // t saves the merge as shown. A merge equal to upstream is saved as take
  // (follow upstream); any other render is saved as the merged text.
  function saveMerge() {
    const text = rendered()
    if (text === props.threeWay.upstream) {
      void props.onResolve("take")
      return
    }
    void props.onResolve("merge", text)
  }

  // e edits the merged text the include set renders, in every tab.
  function startEdit() {
    setDraft(rendered())
    setEditing(true)
  }

  function cancelEdit() {
    area?.blur()
    setDraft("")
    setEditing(false)
  }

  async function saveEdit() {
    const target = area
    if (target === undefined || target.isDestroyed) return
    const text = target.plainText
    setDraft(text)
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
              { bind: "u", title: "Take upstream", group: "Instructions", run: () => void props.onResolve("take") },
              { bind: "t", title: "Save merged result", group: "Instructions", run: saveMerge },
            ]
          : []),
        { bind: "e", title: review() ? "Edit merged text" : "Edit text", group: "Instructions", run: startEdit },
        ...comparisons().map((_, index) => ({ bind: String(index + 1), title: `Show comparison ${index + 1}`, group: "Instructions", run: () => setTab(index) })),
        { bind: "tab", title: "Next comparison", group: "Instructions", run: () => setTab((tab() + 1) % comparisons().length) },
        { bind: "v", title: "Split or unified", group: "Instructions", run: () => setSplit(view() !== "split") },
        { bind: "space", title: "Include or exclude row", group: "Instructions", run: () => (onMerge() ? toggle() : undefined) },
        { bind: "up", title: "Scroll up or previous row", group: "Instructions", run: () => (onMerge() ? moveCursor(-1) : scroll?.scrollBy(-1)) },
        { bind: "down", title: "Scroll down or next row", group: "Instructions", run: () => (onMerge() ? moveCursor(1) : scroll?.scrollBy(1)) },
        { bind: "pageup", title: "Page up", group: "Instructions", run: () => scroll?.scrollBy(-Math.max(1, (scroll?.viewport.height ?? 10) - 2)) },
        { bind: "pagedown", title: "Page down", group: "Instructions", run: () => scroll?.scrollBy(Math.max(1, (scroll?.viewport.height ?? 10) - 2)) },
      ],
    }
  })

  function hints(): (readonly [string, string])[] {
    if (editing()) return [["ctrl+s", "save"], ["esc", "cancel"]]
    return [
      ...(review() ? ([["k", "keep mine"], ["u", "take upstream"], ["t", "save merged"]] as const) : []),
      ["e", review() ? "edit merged" : "edit"],
      ...(comparisons().length > 1 ? ([["1-3", "comparison"]] as const) : []),
      ...(onMerge() ? ([["space", "include"], ["↑↓", "row"]] as const) : ([["v", view() === "split" ? "unified" : "split"], ["↑↓", "scroll"]] as const)),
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
                  const counts = () => patchCounts(unifiedDiff(comparison.left, comparison.merge === true ? rendered() : comparison.right, { from: "a", to: "b" }))
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
              when={!onMerge()}
              fallback={
                <scrollbox flexGrow={1} minHeight={0} ref={(next: ScrollBoxRenderable) => (scroll = next)} verticalScrollbarOptions={{ visible: false }}>
                  <For each={rows()}>
                    {(row) =>
                      row.type === "context" ? (
                        <text wrapMode="word" fg={theme().text.muted}>
                          {`  ${row.text}`}
                        </text>
                      ) : (
                        <text id={`merge-${row.id}`} wrapMode="word">
                          <span style={{ fg: theme().text.formfield.selected }}>
                            {`${cursorId() === row.id ? "›" : " "} ${include().has(row.id) ? "[x]" : "[ ]"} `}
                          </span>
                          <span style={{ fg: row.conflict && !include().has(row.id) ? theme().text.feedback.warning.base : theme().text.base }}>
                            {`${row.label}  ${row.text}`}
                          </span>
                        </text>
                      )
                    }
                  </For>
                </scrollbox>
              }
            >
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
            </Show>
          </>
        }
      >
        <text flexShrink={0} fg={theme().text.muted} paddingTop={1}>
          {review() ? "Merged: the upstream change applied onto yours" : "Yours"}
        </text>
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

// One row per merge unit (B13): unchanged units are context; a change entry is
// one row, and a both-changed entry is two rows, yours then upstream. Rows show
// their text without the unit's final newline; no conflict markers.
function mergeRows(entries: readonly MergeEntry[]): MergeRow[] {
  return entries.flatMap((entry): MergeRow[] => {
    if (entry.type === "unchanged") return [{ type: "context", text: entry.text.replace(/\n$/, "") }]
    if (entry.kind === "both" && entry.upstreamId !== undefined)
      return [
        { type: "change", id: entry.id, label: "yours", text: shown(entry.yours), conflict: false },
        { type: "change", id: entry.upstreamId, label: "upstream (conflicts with yours)", text: shown(entry.upstream), conflict: true },
      ]
    return [{ type: "change", id: entry.id, label: entry.kind, text: shown(entry.kind === "upstream" ? entry.upstream : entry.yours), conflict: false }]
  })
}

function shown(units: readonly string[]): string {
  return units.join("").replace(/\n$/, "") || "(removed)"
}
