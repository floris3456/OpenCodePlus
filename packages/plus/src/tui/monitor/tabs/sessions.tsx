import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import type { Plus } from "../../../rpc.js"
import { formatClock, formatCost, formatTokens } from "../format.js"

export interface SessionsTabProps {
  readonly context: Plugin.Context
  readonly report: Plus.MonitorReport | undefined
  readonly selectedIndex: number
  readonly onSelect: (index: number) => void
  readonly onScopeSession: (sessionID: string) => void
  readonly onScopeTree: (sessionID: string) => void
  readonly active: boolean
  readonly onScrollRef?: (ref: ScrollBoxRenderable) => void
}

export function SessionsTab(props: SessionsTabProps) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const sessions = () => props.report?.sessions ?? []

  // Drop whole columns when the terminal is narrow so labels never lose their
  // values; keep the session, state, steps, tokens and last activity always.
  const available = () => dimensions().width - 2
  const showAgent = () => available() >= 116
  const showCost = () => available() >= 102
  const showHitRate = () => available() >= 92
  const showRead = () => available() >= 82

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme().text.muted} width={34} attributes={TextAttributes.BOLD}>Session / Role</text>
        <Show when={showAgent()}>
          <text fg={theme().text.muted} width={14} attributes={TextAttributes.BOLD}>Agent</text>
        </Show>
        <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>State</text>
        <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>Steps</text>
        <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Tokens</text>
        <Show when={showRead()}>
          <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Read</text>
        </Show>
        <Show when={showHitRate()}>
          <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Hit Rate</text>
        </Show>
        <Show when={showCost()}>
          <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Cost</text>
        </Show>
        <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Active</text>
      </box>

      <Show
        when={sessions().length > 0}
        fallback={
          <box paddingLeft={1} paddingTop={1}>
            <text fg={theme().text.muted}>No sessions recorded in scope.</text>
          </box>
        }
      >
        <scrollbox flexGrow={1} ref={(next: ScrollBoxRenderable) => props.onScrollRef?.(next)}>
          <For each={sessions()}>
            {(s, index) => {
              const isSelected = () => index() === props.selectedIndex && props.active
              const bg = () =>
                isSelected()
                  ? theme().background.action.primary.focused
                  : theme().background.action.primary.base
              const fg = () => (isSelected() ? theme().text.action.primary.focused : theme().text.base)

              const indent = "  ".repeat(s.depth) + (s.depth > 0 ? "└─ " : "")
              const name = `${indent}${s.title ?? s.role ?? s.sessionID.slice(0, 10)}`

              return (
                <box
                  flexDirection="row"
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={bg()}
                  onMouseUp={() => props.onSelect(index())}
                >
                  <text fg={fg()} width={34} wrapMode="none" truncate>{name}</text>
                  <Show when={showAgent()}>
                    <text fg={fg()} width={14} wrapMode="none" truncate>{s.agent ?? "—"}</text>
                  </Show>
                  <text fg={theme().text.muted} width={10} wrapMode="none" truncate>{s.state ?? "—"}</text>
                  <text fg={fg()} width={8}>{String(s.steps)}</text>
                  <text fg={fg()} width={10}>
                    {formatTokens(s.input + s.output + s.reasoning + s.cacheRead + s.cacheWrite)}
                  </text>
                  <Show when={showRead()}>
                    <text fg={fg()} width={10}>{formatTokens(s.cacheRead)}</text>
                  </Show>
                  <Show when={showHitRate()}>
                    <text fg={fg()} width={10}>{`${Math.round(s.hitRate * 100)}%`}</text>
                  </Show>
                  <Show when={showCost()}>
                    <text fg={fg()} width={10}>{formatCost(s.cost) ?? "$0.00"}</text>
                  </Show>
                  <text fg={theme().text.muted} width={10}>{formatClock(s.lastActive)}</text>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}
