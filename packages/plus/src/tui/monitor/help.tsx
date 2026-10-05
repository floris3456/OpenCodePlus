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
        { key: "1 – 5", desc: "Switch tab (Overview, Cache, Tools, Sessions, Steps)" },
        { key: "tab / shift+tab", desc: "Next / previous tab" },
        { key: "s", desc: "Step scope (This session · Team tree · Team · Project · Everything)" },
        { key: "S", desc: "Open session picker (grouped by team tree, sorted by activity)" },
        { key: "T", desc: "Pick team (scope to a chosen Plus team)" },
        { key: "t", desc: "Step window (All · Since last compaction · 15m · 1h · 24h · 7d · 30d)" },
        { key: "/", desc: "Filter rows by text" },
        { key: "?", desc: "Toggle this help view" },
        { key: "esc", desc: "Back out of drill-down / close monitor" },
      ],
    },
    {
      title: "Cache Tab",
      entries: [
        { key: "↑ / ↓ (j / k)", desc: "Select request" },
        { key: "Enter", desc: "Open request detail (cause, evidence, segment diff, timing)" },
        { key: "x", desc: "Toggle misses only" },
        { key: "⌫ / esc", desc: "Back out of detail" },
      ],
    },
    {
      title: "Tools Tab",
      entries: [
        { key: "↑ / ↓ (j / k)", desc: "Select row" },
        { key: "Enter", desc: "Drill into row (e.g. tool → targets, agent → tools)" },
        { key: "⌫ / esc", desc: "Back out of drill-down" },
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
        { key: "Enter", desc: "Scope monitor to this session (temporary; ⌫ restores)" },
        { key: "space", desc: "Scope monitor to this session's tree (temporary; ⌫ restores)" },
      ],
    },
    {
      title: "Steps Tab",
      entries: [
        { key: "↑ / ↓ (j / k)", desc: "Select step" },
        { key: "Enter", desc: "View step calls with attributed tokens & fingerprint diff" },
        { key: "⌫ / esc", desc: "Back out of step detail" },
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
        <text fg={theme().text.muted}>Press ? or esc to return</text>
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
