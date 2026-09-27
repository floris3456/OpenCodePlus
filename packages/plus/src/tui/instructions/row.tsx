import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import type { TreeNode } from "../../instructions/tree.js"
import type { Row } from "./workspace.js"

// One row of the sidebar or the list (docs/instructions-redesign.md §2.1):
//
//   ▎▾ ● label                     meta   marks
//
// The gutter carries the one thing that needs attention (review before
// "set here"); the glyph is the on/off state; meta is where an inherited
// value comes from, or a control's value; marks are ◆ (set at this level),
// ! (to review) and the few tags worth a word (active, pinned, hidden …).

/** The focused pane's cursor: unique on screen (› is the breadcrumb and path separator). */
export const CURSOR = "▌"

/** The provenance worth printing: the baseline (OpenCode, upstream) and "set here" are not. */
export function rowMeta(node: TreeNode): string | undefined {
  if (node.badges.value !== undefined && node.badges.state === undefined) return node.badges.value
  const from = node.badges.fromLabel
  if (from === undefined || from === "set here" || from === "OpenCode" || from === "upstream") return undefined
  return from
}

export function rowTags(node: TreeNode, sidebar: boolean): string[] {
  return [
    // Primary is the usual mode; the sidebar names only the others.
    ...(sidebar && node.badges.mode !== undefined && node.badges.mode !== "primary" ? [node.badges.mode] : []),
    ...(node.badges.hidden === true ? ["hidden"] : []),
    ...(node.badges.active === true ? ["active"] : []),
    ...(node.badges.inactive === true ? ["inactive"] : []),
    ...(node.badges.pinned === true ? ["pinned"] : []),
    ...(node.badges.disabled !== undefined ? ["Remote"] : []),
  ]
}

export type Attention = "review" | "modified" | undefined

export function attentionOf(node: TreeNode): Attention {
  if (node.badges.review === true || (node.badges.reviewCount ?? 0) > 0) return "review"
  if (node.badges.modified === true || node.badges.fromLabel === "set here") return "modified"
  return undefined
}

/** ! for a row under review, !N for a branch holding N; ◆ for a value set at this level. */
export function marksOf(node: TreeNode): string {
  const count = node.badges.reviewCount ?? 0
  const review = count > 0 ? `!${count}` : node.badges.review === true ? "!" : ""
  const modified = node.badges.modified === true || node.badges.fromLabel === "set here" ? "◆" : ""
  return [modified, review].filter((mark) => mark.length > 0).join(" ")
}

export function glyphOf(node: TreeNode): string | undefined {
  if (node.badges.state === "on") return "●"
  if (node.badges.state === "off") return "○"
  return undefined
}

export interface RowLineProps {
  readonly context: Plugin.Context
  readonly row: Row
  readonly selected: boolean
  readonly focused: boolean
  readonly sidebar?: boolean
  /** Provenance not worth printing here: inside a preset, "from preset <itself>". */
  readonly quiet?: string
  /** An owner's tools switched on; none is a warning (the agent cannot act). */
  readonly tools?: number
  readonly onSelect?: () => void
  readonly onActivate?: () => void
}

export function RowLine(props: RowLineProps) {
  const theme = () => props.context.theme
  const node = () => props.row.node
  let armed = false
  const off = () => node().badges.state === "off"
  const heading = () => props.row.role === "catalogue" || (props.row.role === "group" && props.row.depth === 0 && !props.sidebar)
  const background = () => {
    if (!props.selected) return undefined
    return props.focused ? theme().background.action.primary.focused : theme().background.surface.overlay
  }
  const labelColor = () => {
    if (props.selected && props.focused) return theme().text.action.primary.focused
    if (node().badges.disabled !== undefined) return theme().text.formfield.disabled
    if (off() || props.row.context === true || (props.row.role === "group" && props.sidebar)) return theme().text.subdued
    return theme().text.default
  }
  const gutter = () => {
    const attention = attentionOf(node())
    if (attention === "review") return theme().text.feedback.warning.default
    if (attention === "modified") return theme().text.feedback.info.default
    return undefined
  }
  const marker = () => (props.row.expandable ? (props.row.expanded ? "▾" : "▸") : " ")
  const valueRow = () => node().badges.value !== undefined && node().badges.state === undefined
  // The sidebar names owners: where their values come from is the inspector's.
  const meta = () => {
    const value = props.sidebar === true ? undefined : rowMeta(node())
    return value === props.quiet ? undefined : value
  }
  const detail = () => [meta(), ...rowTags(node(), props.sidebar === true)].filter((part) => part !== undefined).join(" · ")
  const marks = () => marksOf(node())
  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      backgroundColor={background()}
      // A click selects; a click on the row already selected opens it.
      onMouseDown={() => {
        armed = props.selected && props.focused
        props.onSelect?.()
      }}
      onMouseUp={(event) => {
        if (event.button === 0 && armed) props.onActivate?.()
        armed = false
      }}
    >
      {/* The cursor (focused pane only) takes the gutter; the marks at the end keep saying why it is coloured. */}
      <text flexShrink={0} fg={props.selected && props.focused ? labelColor() : gutter() ?? theme().text.subdued}>
        {props.selected && props.focused ? CURSOR : gutter() === undefined ? " " : "▎"}
      </text>
      <text flexShrink={0} wrapMode="none" fg={theme().text.subdued}>
        {`${"  ".repeat(Math.max(0, props.row.depth))}${marker()} `}
      </text>
      <Show when={glyphOf(node())}>
        {(glyph) => (
          <text flexShrink={0} fg={props.selected && props.focused ? labelColor() : off() ? theme().text.subdued : theme().text.formfield.selected}>
            {`${glyph()} `}
          </text>
        )}
      </Show>
      <text
        flexShrink={1}
        minWidth={Math.min(props.row.label.length, 14)}
        wrapMode="none"
        truncate
        fg={labelColor()}
        attributes={heading() ? TextAttributes.BOLD : undefined}
      >
        {props.row.label}
      </text>
      <box flexGrow={1} minWidth={1} />
      <Show when={detail().length > 0}>
        <text flexShrink={3} minWidth={0} wrapMode="none" truncate fg={props.selected && props.focused ? labelColor() : valueRow() ? theme().text.formfield.default : node().badges.active === true ? theme().text.formfield.selected : theme().text.subdued}>
          {`${detail()} `}
        </text>
      </Show>
      <Show when={props.tools}>
        {(count) => (
          <text flexShrink={0} wrapMode="none" fg={props.selected && props.focused ? labelColor() : theme().text.subdued}>
            {`${String(count()).padStart(3)} `}
          </text>
        )}
      </Show>
      <Show when={props.tools === 0}>
        <text flexShrink={0} wrapMode="none" fg={theme().text.feedback.warning.default}>
          {"no tools "}
        </text>
      </Show>
      <Show when={node().owner?.linkMissing === true}>
        <text flexShrink={0} wrapMode="none" fg={theme().text.feedback.warning.default}>
          {"missing preset "}
        </text>
      </Show>
      <Show when={marks().length > 0}>
        <text flexShrink={0} wrapMode="none" fg={marks().includes("!") ? theme().text.feedback.warning.default : theme().text.feedback.info.default}>
          {`${marks()} `}
        </text>
      </Show>
    </box>
  )
}

/** The OpenCode footer: bold key, dim label. */
export function KeyHints(props: { readonly context: Plugin.Context; readonly hints: readonly (readonly [string, string])[] }) {
  return (
    <text flexShrink={0} wrapMode="none" truncate paddingLeft={1}>
      {props.hints.map(([key, label], index) => (
        <>
          <span style={{ fg: props.context.theme.text.default }}>
            <b>{key}</b>
          </span>
          <span style={{ fg: props.context.theme.text.subdued }}>{` ${label}${index < props.hints.length - 1 ? "   " : ""}`}</span>
        </>
      ))}
    </text>
  )
}
