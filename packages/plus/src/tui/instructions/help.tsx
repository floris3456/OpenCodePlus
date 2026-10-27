import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { For } from "solid-js"

export type HelpGroup = readonly [string, readonly (readonly [string, string])[]]

/**
 * The complete key reference (?): every key the browse layer binds, grouped by
 * what it is for. The footer (route.tsx hints) shows only what acts on the
 * current row; this dialog is where navigation and the less frequent keys live.
 */
export const HELP: readonly HelpGroup[] = [
  [
    "Navigate",
    [
      ["↑ ↓", "previous / next row"],
      ["pgup pgdn", "a page at a time; home / end: first / last row"],
      ["← →", "close or back to the sidebar / open the row, or into its list"],
      ["tab", "switch between the sidebar and the list"],
      ["shift+tab", "next level (wraps)"],
      ["shift+← →", "previous / next level (same gesture)"],
      ["shift+[ ] { }", "previous / next level (terminal aliases)"],
      ["< >", "previous / next level"],
      ["shift+1–4", "Project / Global / Defaults / Presets (! @ # $ too)"],
      ["[ ]", "previous / next category"],
      ["1–9", "jump to a category"],
      ["/", "filter this level as you type; esc clears"],
      ["n / N", "next / previous row to review in this level"],
      ["shift+e", "expand or collapse every other row in the hovered or focused pane"],
      ["ctrl+e", "the same, including the row under the cursor"],
      ["shift+w", "resize the panels (wide): ←/[ move divider left · →/] move divider right · tab switch · enter/esc save"],
    ],
  ],
  [
    "Select",
    [
      ["x", "select or deselect the row"],
      ["shift+↑ ↓", "extend the selection a row at a time"],
      ["ctrl+a", "select every visible row"],
      ["esc", "clear the selection (then: cancel a cut, close the list, close the screen)"],
      ["", "selected rows stay selected across agents and tabs; edits reflect to the compatible settings"],
      ["ctrl+space", "make an enabled primary agent the current agent"],
    ],
  ],
  [
    "Edit the row",
    [
      ["enter", "the row's own action: edit text · edit a rule or a limit · edit a model · cycle Strategy/Compaction · toggle · review · open"],
      ["space", "turn a row, agent or team on/off (on a permission row with no patterns: switch)"],
      ["e", "edit the text full width"],
      ["shift+r", "rename a user agent, team member, team or folder"],
      ["r", "reset this level's override (on an agent or member: its controls)"],
      ["p", "pin a Code Mode tool"],
      ["s", "split the text into sections"],
      ["w", "shown when: send a system row or section only while chosen rows are on · on a model prompt also its models"],
      ["shift+l", "row links: select the first row, navigate to another, shift+l finishes; esc cancels"],
      ["l", "link an agent, member, team, entry or user preset to a preset (or unlink)"],
      ["c", "compare your text with upstream (a real diff)"],
      ["n / N", "the next / previous row to review"],
    ],
  ],
  [
    "Add, copy, move",
    [
      ["a", "add: agent, team, member, entry, preset, model, skill, rule, section, folder, system row · a tool row offers Section or Permission rule"],
      ["ctrl+c", "copy the selected rows, else the row under the cursor"],
      ["ctrl+x", "cut them (pending until the paste succeeds; esc cancels)"],
      ["ctrl+v", "paste onto the row under the cursor: the same row of another agent, an agent onto an agent, or into a category"],
      ["ctrl+d", "duplicate: an independent copy right after the original, one row named \"<name> copy\" (esc keeps it): agent, team, member, skill, preset, System row, folder with its contents"],
      ["m", "move: ↑/↓ move, → into the folder below, ← out, enter drops, esc restores · a cold-cache list: ↑/↓ reorder the try order"],
      ["d", "delete (asks first; a user category's rows go home)"],
    ],
  ],
  [
    "Panels",
    [
      ["shift+w", "resize the panels: ←/[ and →/] move the divider, tab switches panel, enter or esc saves"],
    ],
  ],
  [
    "Review (a row marked !)",
    [
      ["enter", "state/pin/model: keep yours or take the new value; text: the diff"],
      ["k / t", "keep yours / take the merged result"],
      ["e", "edit a merge of the upstream change onto yours"],
      ["1 2 3 · v", "upstream change / your change / take result (merged) · split or unified"],
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
  [
    "Colours and marks",
    [
      ["● ○", "on / off"],
      ["◆  blue bar", "set at this level"],
      ["!  yellow bar", "needs review (!3: three below)"],
      ["dim text", "where an inherited value comes from"],
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
