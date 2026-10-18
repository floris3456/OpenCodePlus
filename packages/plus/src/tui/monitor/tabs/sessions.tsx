import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import type { Plus } from "../../../rpc.js"
import { formatClock, formatCost, formatTokens, formatReusePercent } from "../format.js"
import { createRowStore, createRowWindow } from "../window.js"

export interface SessionsTabProps {
  readonly width?: number
  readonly context: Plugin.Context
  /** The checklist rows in display order: roots, and the sessions of expanded trees under them. */
  readonly rows: readonly Plus.MonitorSessionRow[]
  readonly list: Plus.MonitorSessionList | undefined
  /** Inactive sessions are listed too. */
  readonly all: boolean
  readonly checked: (row: Plus.MonitorSessionRow) => boolean
  readonly expanded: (rootID: string) => boolean
  readonly selectedIndex: number
  readonly onSelect: (index: number) => void
  readonly active: boolean
  readonly onScrollRef?: (ref: ScrollBoxRenderable) => void
}

export function SessionsTab(props: SessionsTabProps) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()

  // Only the rows around the viewport are instantiated; the selection index
  // still runs over the whole list, and the window follows it.
  const window = createRowWindow({
    context: props.context,
    items: () => props.rows,
    selectedIndex: () => props.selectedIndex,
    key: (session) => session.sessionID,
  })
  const rows = createRowStore(() => window, "sessionID")

  const summary = () => {
    const list = props.list
    const trees = list === undefined ? "" : list.roots > list.limit
      ? ` · trees ${list.offset + 1}-${Math.min(list.roots, list.offset + list.limit)}/${list.roots} [ ]`
      : ` · ${list.roots} ${list.roots === 1 ? "tree" : "trees"}`
    const hidden = !props.all && (list?.inactive ?? 0) > 0 ? ` · ${list!.inactive} inactive hidden` : ""
    const total = window.total
    const position = total === 0 ? "" : ` · row ${Math.min(props.selectedIndex, total - 1) + 1} of ${total}`
    return `${props.all ? "All sessions" : "Active sessions"}${trees}${hidden}${position} · [S] ${props.all ? "active only" : "all"}`
  }

  // Drop whole columns when the terminal is narrow so labels never lose their
  // values; keep the session, state, steps, tokens and last activity always.
  const available = () => (props.width ?? dimensions().width) - 2
  const nameWidth = () => (available() >= 88 ? 40 : 34)
  const showAgent = () => available() >= 122
  const showCost = () => available() >= 108
  const showHitRate = () => available() >= 98
  const showRead = () => available() >= 88

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme().text.muted} wrapMode="none" truncate>
          {summary()}
        </text>
      </box>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme().text.muted} width={nameWidth()} attributes={TextAttributes.BOLD}>
          Session / Role
        </text>
        <Show when={showAgent()}>
          <text fg={theme().text.muted} width={14} attributes={TextAttributes.BOLD}>
            Agent
          </text>
        </Show>
        <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
          State
        </text>
        <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
          Steps
        </text>
        <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
          Tokens
        </text>
        <Show when={showRead()}>
          <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
            Read
          </text>
        </Show>
        <Show when={showHitRate()}>
          <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
            Hit Rate
          </text>
        </Show>
        <Show when={showCost()}>
          <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
            Cost
          </text>
        </Show>
        <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
          Last seen
        </text>
      </box>

      <Show
        when={props.rows.length > 0}
        fallback={
          <box paddingLeft={1} paddingTop={1}>
            <text fg={theme().text.muted}>
              {props.list === undefined ? "Loading sessions…" : props.all ? "No sessions recorded." : "No active sessions · [S] show inactive"}
            </text>
          </box>
        }
      >
        <scrollbox
          flexGrow={1}
          minHeight={0}
          id="monitor-scroll"
          ref={(next: ScrollBoxRenderable) => {
            window.ref(next)
            props.onScrollRef?.(next)
          }}
        >
          <Show when={window.start > 0}>
            <box height={window.start} flexShrink={0} />
          </Show>
          <For each={rows.items}>
            {(s, index) => {
              const at = () => window.start + index()
              const isSelected = () => at() === props.selectedIndex && props.active
              const bg = () =>
                isSelected() ? theme().background.action.primary.focused : theme().background.action.primary.base
              const fg = () =>
                isSelected() ? theme().text.action.primary.focused : s.active === false ? theme().text.muted : theme().text.base
              const mark = () => (isSelected() ? fg() : props.checked(s) ? theme().text.formfield.selected : theme().text.muted)

              // Getters so a same-id row whose fields changed updates in place
              // rather than keeping the first render's text.
              const branch = () => {
                if (s.depth > 0) return `${"  ".repeat(s.depth)}└─ `
                if ((s.descendants ?? 0) === 0) return "  "
                return props.expanded(s.sessionID) ? "▼ " : "▶ "
              }
              const name = () => s.title ?? s.role ?? s.sessionID.slice(0, 10)
              const below = () => (s.depth === 0 && (s.descendants ?? 0) > 0 && !props.expanded(s.sessionID) ? ` (${s.descendants})` : "")
              const tokens = () => formatTokens(s.input + s.output + s.reasoning + s.cacheRead + s.cacheWrite)

              return (
                <box
                  id={`monitor-row-${s.sessionID}`}
                  flexDirection="row"
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={bg()}
                  onMouseUp={() => props.onSelect(at())}
                >
                  <box width={nameWidth()} flexDirection="row" flexShrink={0}>
                    <text fg={mark()} flexShrink={0} wrapMode="none">
                      {props.checked(s) ? "[x] " : "[ ] "}
                    </text>
                    <text fg={fg()} wrapMode="none" truncate>
                      {`${branch()}${name()}${below()}`}
                    </text>
                  </box>
                  <Show when={showAgent()}>
                    <text fg={fg()} width={14} wrapMode="none" truncate>
                      {s.agent ?? "—"}
                    </text>
                  </Show>
                  <text fg={theme().text.muted} width={10} wrapMode="none" truncate>
                    {s.state ?? (s.active === false ? "inactive" : "—")}
                  </text>
                  <text fg={fg()} width={8}>
                    {String(s.steps)}
                  </text>
                  <text fg={fg()} width={10}>
                    {tokens()}
                  </text>
                  <Show when={showRead()}>
                    <text fg={fg()} width={10}>
                      {formatTokens(s.cacheRead)}
                    </text>
                  </Show>
                  <Show when={showHitRate()}>
                    <text fg={fg()} width={10}>
                      {formatReusePercent(s.hitRate)}
                    </text>
                  </Show>
                  <Show when={showCost()}>
                    <text fg={fg()} width={10}>
                      {formatCost(s.cost) ?? "$0.00"}
                    </text>
                  </Show>
                  <text fg={theme().text.muted} width={10}>
                    {s.lastActive ? formatClock(s.lastActive) : "—"}
                  </text>
                </box>
              )
            }}
          </For>
          <Show when={window.end < window.total}>
            <box height={window.total - window.end} flexShrink={0} />
          </Show>
        </scrollbox>
      </Show>
    </box>
  )
}
