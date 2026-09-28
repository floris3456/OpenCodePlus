import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { For } from "solid-js"

export type HelpGroup = readonly [string, readonly (readonly [string, string])[]]

export const HELP: readonly HelpGroup[] = [
  [
    "Move",
    [
      ["tab", "switch between the sidebar and the list"],
      ["shift+tab", "next level (wraps) · < > goes back / forward"],
      ["shift+← →", "previous / next level (same gesture)"],
      ["shift+[ ] { }", "previous / next level (terminal aliases)"],
      ["shift+1–4", "Project / Global / Defaults / Presets (! @ # $ too)"],
      ["↑↓ pgup pgdn", "move (home / end: first / last)"],
      ["→ / ←", "open or into the list / close or back to the sidebar"],
      ["[ ]  1-8", "previous / next category, or jump to one"],
      ["n / N", "next / previous row to review in this level"],
      ["E", "expand or collapse every other row in the hovered or focused pane"],
      ["ctrl+E", "the same, including the row under the cursor"],
      ["W / alt+W", "resize the panels — next stage (not yet active)"],
      ["/", "filter this level as you type · esc clears"],
      ["esc", "back one step; from the sidebar it closes the screen"],
    ],
  ],
  [
    "Change",
    [
      ["space", "turn a row, agent or team on/off"],
      ["ctrl+space", "make an enabled primary agent the current agent"],
      ["enter", "edit text · edit a rule's patterns or a limit · cycle Mode/Strategy · review"],
      ["e", "edit text full width (ctrl+d previews the change)"],
      ["c", "compare your text with upstream (a real diff)"],
      ["r", "reset this level's override"],
      ["p", "pin a Code Mode tool"],
      ["s", "split text into sections"],
    ],
  ],
  [
    "Create and link",
    [
      ["a", "add (name, then preset): agent, team, member, entry, preset, model, skill, rule, section"],
      ["l", "link an agent, member, team, entry or User preset to a preset (or unlink)"],
      ["d", "delete (asks first)"],
    ],
  ],
  [
    "Review (a row marked !)",
    [
      ["enter", "state/pin/model: keep yours or take the new value; text: the diff"],
      ["k / t", "keep yours / take the new upstream"],
      ["e", "edit a merge of the upstream change onto yours"],
      ["1 2 3 · v", "upstream change / your change / take result · split or unified"],
    ],
  ],
  [
    "Colours and marks",
    [
      ["● ○", "on / off"],
      ["◆  blue bar", "set at this level"],
      ["!  yellow bar", "needs review (!3: three below)"],
      ["dim text", "where an inherited value comes from"],
    ],
  ],
  [
    "Filter",
    [
      ["words", "match labels and ids"],
      ["key:value", "kind item group server namespace level agent state modified review source overridden active inactive unsupported codemode pinned execute can has id label updated team acked excluded tool"],
      ["! , sort:", "negate · or · sort by a key (text upstream tokens delta … are slower)"],
      ["item:perm tool:X", "permission rows of one tool (e.g. tool:shell)"],
    ],
  ],
]

/** From this terminal width the help opens extra large, in two columns. */
export const HELP_WIDE = 124

/**
 * One column of the xlarge dialog: 116 columns less its 8 columns of padding,
 * split in two with a 4-column gap.
 */
export const HELP_COLUMN_WIDTH = 52

/** A group's rendered height at this column width: title plus wrapped labels. */
export function helpHeight(group: HelpGroup, columnWidth: number): number {
  const labelWidth = Math.max(1, columnWidth - 14)
  return 1 + group[1].reduce((total, [, label]) => total + Math.max(1, Math.ceil(label.length / labelWidth)), 0)
}

/**
 * Split the groups into the two contiguous columns that minimise the taller
 * column's estimated height, preserving group order. The estimator is an
 * approximation: it only has to keep the real table balanced as it changes.
 */
export function helpColumns(groups: readonly HelpGroup[], columnWidth: number): readonly (readonly HelpGroup[])[] {
  let cut = 0
  let best = Number.POSITIVE_INFINITY
  for (let at = 1; at < groups.length; at++) {
    const height = Math.max(
      groups.slice(0, at).reduce((total, group) => total + helpHeight(group, columnWidth), 0),
      groups.slice(at).reduce((total, group) => total + helpHeight(group, columnWidth), 0),
    )
    if (height < best) {
      best = height
      cut = at
    }
  }
  return cut === 0 ? [groups] : [groups.slice(0, cut), groups.slice(cut)]
}

export function HelpDialog(props: { readonly context: Plugin.Context }) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  // Two balanced columns when there is room; the dialog scrolls when there is not.
  const columns = () => (dimensions().width >= HELP_WIDE ? helpColumns(HELP, HELP_COLUMN_WIDTH) : [HELP])
  const Group = (props: { readonly group: HelpGroup }) => (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
        {props.group[0]}
      </text>
      <For each={props.group[1]}>
        {([key, label]) => (
          <box flexDirection="row">
            <text fg={theme().text.base} width={14} flexShrink={0}>
              {key}
            </text>
            <text fg={theme().text.muted} flexGrow={1} minWidth={0} wrapMode="word">
              {label}
            </text>
          </box>
        )}
      </For>
    </box>
  )
  return (
    <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          Instructions
        </text>
        <text fg={theme().text.muted} onMouseUp={() => props.context.ui.dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox maxHeight={Math.max(8, dimensions().height - 8)} verticalScrollbarOptions={{ visible: false }}>
        <box flexDirection="row" gap={4}>
          <For each={columns()}>
            {(column) => (
              <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} gap={1}>
                <For each={column}>{(group) => <Group group={group} />}</For>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  )
}
