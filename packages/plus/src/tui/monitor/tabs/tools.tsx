import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import type { Plus } from "../../../rpc.js"
import {
  formatClock,
  formatDelta,
  formatMs,
  formatTokens,
  pad,
  toolLine,
  type MonitorSettings,
} from "../format.js"

export const groupMountLog: { enabled: boolean; keys: string[] } = { enabled: false, keys: [] }
export function resetGroupMountLog(): void {
  groupMountLog.enabled = true
  groupMountLog.keys.length = 0
}
export function stopGroupMountLog(): void {
  groupMountLog.enabled = false
}

export interface ToolsTabProps {
  readonly context: Plugin.Context
  readonly report: Plus.MonitorReport | undefined
  readonly settings: MonitorSettings
  readonly selectedIndex: number
  readonly onSelect: (index: number) => void
  readonly full: boolean
  readonly active: boolean
  readonly groups: readonly Plus.MonitorGroup[]
  readonly feed: readonly Plus.MonitorCall[]
  readonly onScrollRef?: (ref: ScrollBoxRenderable) => void
}

interface Cell {
  readonly text: string
  readonly width?: number
  readonly grow?: boolean
  readonly align?: "left" | "right"
}

function Cells(props: {
  readonly cells: readonly Cell[]
  readonly fg: RGBA
  readonly background?: RGBA
  readonly bold?: boolean
  readonly onSelect?: () => void
}) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      minWidth={0}
      {...(props.background === undefined ? {} : { backgroundColor: props.background })}
      onMouseUp={() => props.onSelect?.()}
    >
      <For each={props.cells}>
        {(cell) =>
          cell.grow === true ? (
            <text
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              paddingRight={1}
              wrapMode="none"
              truncate
              fg={props.fg}
              attributes={props.bold ? TextAttributes.BOLD : undefined}
            >
              {cell.text}
            </text>
          ) : (
            <text
              flexShrink={0}
              width={cell.width}
              wrapMode="none"
              fg={props.fg}
              attributes={props.bold ? TextAttributes.BOLD : undefined}
            >
              {`${pad(cell.text, (cell.width ?? 1) - 1, cell.align ?? "right")} `}
            </text>
          )
        }
      </For>
    </box>
  )
}

export function ToolsTab(props: ToolsTabProps) {
  const theme = () => props.context.theme
  const compared = createMemo(() => new Map((props.report?.compare?.groups ?? []).map((group) => [group.key, group])))
  const comparing = () => props.report?.compare !== undefined

  const groupCells = (group: Plus.MonitorGroup | undefined): Cell[] => {
    const before = group === undefined ? undefined : compared().get(group.key)
    return [
      { text: group?.label ?? props.settings.group, grow: true },
      {
        text:
          group === undefined
            ? "calls"
            : `${group.calls}${group.inner > 0 ? `+${group.inner}` : ""}${group.running > 0 ? "*" : ""}`,
        width: 7,
      },
      { text: group === undefined ? "fail" : group.errors > 0 ? String(group.errors) : "·", width: 5 },
      { text: group === undefined ? "call" : formatTokens(group.callTokens), width: 7 },
      {
        text:
          group === undefined
            ? "result"
            : `${group.estimated > 0 && group.estimated === group.calls ? "~" : ""}${formatTokens(group.resultTokens)}`,
        width: 8,
      },
      { text: group === undefined ? "carried" : formatTokens(group.carried), width: 8 },
      { text: group === undefined ? "avg" : formatMs(group.avgMs), width: 7 },
      ...(comparing()
        ? [
            { text: group === undefined ? "Δcalls" : formatDelta(group.calls, before?.calls ?? 0), width: 8 },
            {
              text: group === undefined ? "Δresult" : formatDelta(group.resultTokens, before?.resultTokens ?? 0),
              width: 8,
            },
          ]
        : []),
    ]
  }

  const feedCells = (entry: Plus.MonitorCall): Cell[] => [
    { text: formatClock(entry.started), width: 9, align: "left" },
    { text: entry.agent ?? "?", width: 17, align: "left" },
    { text: entry.tool, width: 17, align: "left" },
    { text: entry.target ?? "", grow: true },
    { text: entry.status === "running" ? "" : formatTokens(entry.callTokens), width: 7 },
    {
      text: entry.status === "running" ? "" : `${entry.measured ? "" : "~"}${formatTokens(entry.resultTokens)}`,
      width: 8,
    },
    { text: entry.ended === undefined ? "" : formatMs(entry.ended - entry.started), width: 7 },
    { text: entry.status === "running" ? "…" : entry.status === "error" ? "✗" : "", width: 2, align: "left" },
  ]

  const GroupRows = () => (
    <For each={props.groups}>
      {(group, index) => {
        if (groupMountLog.enabled) groupMountLog.keys.push(group.key)
        return (
          <Cells
            cells={groupCells(group)}
            background={
              index() === props.selectedIndex && props.active
                ? theme().background.action.primary.focused
                : theme().background.action.primary.base
            }
            fg={
              index() === props.selectedIndex && props.active
                ? theme().text.action.primary.focused
                : group.errors > 0 && group.errors === group.calls
                  ? theme().text.feedback.error.base
                  : theme().text.base
            }
            onSelect={() => props.onSelect(index())}
          />
        )
      }}
    </For>
  )

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <Show when={props.full && props.report}>
        {(current) => (
          <text fg={theme().text.base} wrapMode="none" truncate flexShrink={0}>
            {`${toolLine(current().totals)}${current().compare === undefined ? "" : `   (before: ${current().compare?.totals.calls} calls, result ${formatTokens(current().compare?.totals.resultTokens ?? 0)})`}`}
          </text>
        )}
      </Show>
      <Show
        when={props.groups.length > 0}
        fallback={
          <text fg={theme().text.muted}>
            {`No tool calls ${props.settings.scope === "session" ? "in this chat" : "here"} yet${props.settings.window === "all" ? "" : ` in the last ${props.settings.window}`}.`}
          </text>
        }
      >
        <Cells cells={groupCells(undefined)} fg={theme().text.muted} bold />
        <Show
          when={props.full}
          fallback={
            <scrollbox
              height={7}
              scrollbarOptions={{ visible: false }}
              ref={(next: ScrollBoxRenderable) => props.onScrollRef?.(next)}
            >
              <GroupRows />
            </scrollbox>
          }
        >
          <scrollbox flexGrow={1} minHeight={0} ref={(next: ScrollBoxRenderable) => props.onScrollRef?.(next)}>
            <GroupRows />
          </scrollbox>
        </Show>
      </Show>

      {/* Latest calls feed */}
      <Show when={props.full && props.feed.length > 0}>
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <text fg={theme().text.muted} wrapMode="none" attributes={TextAttributes.BOLD}>
            latest calls
          </text>
          <For each={props.feed}>
            {(entry) => (
              <Cells
                cells={feedCells(entry)}
                fg={
                  entry.status === "error"
                    ? theme().text.feedback.error.base
                    : entry.status === "running"
                      ? theme().text.feedback.info.base
                      : theme().text.muted
                }
              />
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
