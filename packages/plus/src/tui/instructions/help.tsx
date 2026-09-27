import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { For } from "solid-js"

export const HELP: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  [
    "Move",
    [
      ["tab", "switch between the sidebar and the list"],
      ["↑↓ pgup pgdn", "move (home / end: first / last)"],
      ["→ / ←", "open or into the list / close or back to the sidebar"],
      ["< >", "previous / next level (Project, Global, Defaults, Presets)"],
      ["[ ]  1-8", "previous / next category, or jump to one"],
      ["n / N", "next / previous row to review in this level"],
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

export function HelpDialog(props: { readonly context: Plugin.Context }) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  // Two columns when there is room; the dialog scrolls when there is not.
  const columns = () => (dimensions().width >= HELP_WIDE ? [HELP.slice(0, 2), HELP.slice(2)] : [HELP])
  const Group = (group: { readonly title: string; readonly keys: readonly (readonly [string, string])[] }) => (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme().text.default} attributes={TextAttributes.BOLD}>
        {group.title}
      </text>
      <For each={group.keys}>
        {([key, label]) => (
          <box flexDirection="row">
            <text fg={theme().text.default} width={14} flexShrink={0}>
              {key}
            </text>
            <text fg={theme().text.subdued} flexGrow={1} minWidth={0} wrapMode="word">
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
        <text fg={theme().text.default} attributes={TextAttributes.BOLD}>
          Instructions
        </text>
        <text fg={theme().text.subdued} onMouseUp={() => props.context.ui.dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox maxHeight={Math.max(8, dimensions().height - 8)} verticalScrollbarOptions={{ visible: false }}>
        <box flexDirection="row" gap={4}>
          <For each={columns()}>
            {(column) => (
              <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} gap={1}>
                <For each={column}>{([title, keys]) => <Group title={title} keys={keys} />}</For>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  )
}
