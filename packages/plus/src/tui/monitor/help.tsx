import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"

export interface HelpProps {
  readonly context: Plugin.Context
  readonly onClose: () => void
}

interface KeyEntry {
  readonly key: string
  readonly desc: string
}

export function MonitorHelp(props: HelpProps) {
  const theme = () => props.context.theme

  const sections: { title: string; entries: KeyEntry[] }[] = [
    {
      title: "Navigation & Scope",
      entries: [
        { key: "1 – 5", desc: "Switch tab (Cache, Prompt, Tools, Sessions; Team while a team is active)" },
        { key: "tab / shift+tab", desc: "Next / previous tab" },
        { key: "s", desc: "Choose scope: this chat, its subagents, the project, everything, or any session" },
        { key: "S", desc: "Add another session to the combined report (selected sessions are omitted)" },
        { key: "T", desc: "Pick team (scope to a chosen Plus team)" },
        { key: "t", desc: "Step window (All · Since last compaction · 15m · 1h · 24h · 7d · 30d)" },
        { key: "/", desc: "Filter rows by text" },
        { key: "?", desc: "Toggle this help view" },
        { key: "esc", desc: "Close monitor immediately" },
      ],
    },
    {
      title: "Cache Tab",
      entries: [
        { key: "↑ / ↓ (j / k)", desc: "Select request" },
        { key: "Enter", desc: "Open request detail (cause, evidence, segment diff, timing)" },
        { key: "P (shift+p)", desc: "Show what this request sent (Prompt tab)" },
        { key: "x", desc: "Toggle misses and cold starts only" },
        { key: "[ / ] · l", desc: "Older / newer page · latest" },
        { key: "⌫", desc: "Back out of detail" },
      ],
    },
    {
      title: "Prompt Tab",
      entries: [
        { key: "↑ / ↓ · PgUp/PgDn", desc: "Select item (one row per item sent: options, system, tools, message parts)" },
        { key: "Enter", desc: "Show the item readable; v toggles its exact JSON" },
        { key: "[ / ]", desc: "Previous / next sent request of this session" },
        { key: "l", desc: "Follow the latest request live" },
        { key: "x", desc: "Only items new or changed since the previous request (+ new, ~ changed, * cache hint moved)" },
        { key: "/", desc: "Filter items by text" },
        { key: "⌫ / esc", desc: "Back out of the item" },
      ],
    },
    {
      title: "Tools Tab",
      entries: [
        { key: "↑ / ↓ (j / k)", desc: "Select row" },
        { key: "Enter", desc: "Filter by row (e.g. tool → targets, agent → tools)" },
        { key: "⌫", desc: "Undo last filter" },
        { key: "g", desc: "Group by (tool · agent · model · target · session · config)" },
        { key: "o", desc: "Sort by (tokens · carried · calls · errors · time)" },
        { key: "a", desc: "Filter by agent" },
        { key: "f", desc: "Filter by tool" },
        { key: "F (shift+f)", desc: "Filter by model" },
        { key: "x", desc: "Toggle failed calls only" },
        { key: "c", desc: "Compare (off · previous window · before/after mark)" },
        { key: "m", desc: "Mark this moment" },
      ],
    },
    {
      title: "Sessions Tab",
      entries: [
        { key: "↑ / ↓ (j / k)", desc: "Select session in delegation tree" },
        { key: "Enter", desc: "Add this session to the report (no duplicates; ⌫ undoes)" },
        { key: "space", desc: "Add this session's tree to the report (no duplicates; ⌫ undoes)" },
      ],
    },
    {
      title: "Team Tab",
      entries: [
        { key: "↑ / ↓", desc: "Select run" },
        { key: "Enter", desc: "Open the run's chat (closes the monitor)" },
        { key: "ctrl+a / ctrl+t", desc: "Active or inactive runs · this chat's tree or all runs" },
        { key: "ctrl+d", desc: "Stop an idle run, resume a stopped one" },
        { key: "e", desc: "Edit the project checks (.opencodeplus/checks.json)" },
      ],
    },
  ]

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      minWidth={0}
      backgroundColor={theme().background.raised.base}
    >
      <box flexDirection="row" flexShrink={0} marginBottom={1}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexGrow={1}>
          Monitor Keys &amp; Help
        </text>
        <text fg={theme().text.muted}>Press ? to return · esc closes monitor</text>
      </box>
      <scrollbox flexGrow={1}>
        <For each={sections}>
          {(section) => (
            <box flexDirection="column" marginBottom={1}>
              <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
                {section.title}
              </text>
              <For each={section.entries}>
                {(entry) => (
                  <box flexDirection="row">
                    <text fg={theme().text.action.primary.focused} width={18}>
                      {entry.key}
                    </text>
                    <text fg={theme().text.base} flexGrow={1}>
                      {entry.desc}
                    </text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  )
}
