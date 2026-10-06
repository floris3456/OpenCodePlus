import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import type { Plus } from "../../../rpc.js"
import { formatClock, formatCost, formatMs, formatMsLabel, formatTokens } from "../format.js"
import { createRowStore, createRowWindow, rowWindowLog } from "../window.js"

export interface CacheTabProps {
  readonly context: Plugin.Context
  readonly report: Plus.MonitorReport | undefined
  readonly selectedIndex: number
  readonly onSelect: (index: number) => void
  readonly detailID: string | undefined
  readonly missesOnly: boolean
  readonly active: boolean
  readonly onScrollRef?: (ref: ScrollBoxRenderable) => void
}

export function CacheTab(props: CacheTabProps) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const detail = () => props.report?.detail

  // Narrow terminals drop whole columns, keeping time, kind (so pings stay
  // distinguishable), verdict, cause and evidence; the agent/model column goes
  // first, then input and cost.
  const available = () => dimensions().width - 2
  const showInput = () => available() >= 96
  const showCost = () => available() >= 110
  const showAgent = () => available() >= 84
  const compact = () => available() < 86
  const causeWidth = () => (compact() ? 16 : 18)
  const kindWidth = () => 10
  const kindLabel = (kind: Plus.MonitorRequest["kind"]) => kind

  const requests = () => {
    const list = props.report?.requests ?? []
    if (props.missesOnly) {
      return list.filter((r) => r.verdict === "miss" || r.verdict === "partial")
    }
    return list
  }

  // Only the rows around the viewport are instantiated; the selection index
  // still runs over the whole filtered list, and the window follows it.
  const window = createRowWindow({
    context: props.context,
    items: requests,
    selectedIndex: () => props.selectedIndex,
  })
  const rows = createRowStore(() => window, "id")

  const position = () => {
    const total = window.total
    if (total === 0) return undefined
    const index = Math.min(props.selectedIndex, total - 1)
    return `row ${index + 1} of ${total}`
  }

  const verdictFg = (verdict: Plus.MonitorRequest["verdict"]) => {
    switch (verdict) {
      case "miss":
        return theme().text.feedback.error.base
      case "partial":
        return theme().text.feedback.warning.base
      case "hit":
        return theme().text.feedback.success.base
      case "cold":
      case "none":
      default:
        return theme().text.muted
    }
  }

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      <Show
        when={props.detailID !== undefined && detail() !== undefined}
        fallback={
          <box flexDirection="column" flexGrow={1} minWidth={0}>
            {/* Header row */}
            <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
              <text fg={theme().text.muted} width={9} attributes={TextAttributes.BOLD}>Time</text>
              <text fg={theme().text.muted} width={kindWidth()} attributes={TextAttributes.BOLD}>Kind</text>
              <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Verdict</text>
              <text fg={theme().text.muted} width={causeWidth()} attributes={TextAttributes.BOLD}>Cause</text>
              <Show when={showAgent()}>
                <text fg={theme().text.muted} width={16} attributes={TextAttributes.BOLD}>Agent/Model</text>
              </Show>
              <Show when={showInput()}>
                <text fg={theme().text.muted} width={9} attributes={TextAttributes.BOLD}>In</text>
              </Show>
              <text fg={theme().text.muted} width={9} attributes={TextAttributes.BOLD}>Read</text>
              <Show when={showCost()}>
                <text fg={theme().text.muted} width={9} attributes={TextAttributes.BOLD}>Cost</text>
              </Show>
              <text fg={theme().text.muted} flexGrow={1} attributes={TextAttributes.BOLD}>Evidence</text>
            </box>

            <Show when={position()}>
              {(text) => (
                <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
                  <text fg={theme().text.muted}>{text()}</text>
                </box>
              )}
            </Show>

            <Show
              when={requests().length > 0}
              fallback={
                <box paddingLeft={1} paddingTop={1}>
                  <text fg={theme().text.muted}>
                    {props.missesOnly ? "No cache misses recorded in scope." : "No requests recorded in scope."}
                  </text>
                </box>
              }
            >
              <scrollbox
                flexGrow={1}
                ref={(next: ScrollBoxRenderable) => {
                  window.ref(next)
                  props.onScrollRef?.(next)
                }}
              >
                <Show when={window.start > 0}>
                  <box height={window.start} flexShrink={0} />
                </Show>
                <For each={rows.items}>
                  {(req, index) => {
                    const at = () => window.start + index()
                    if (rowWindowLog.enabled) rowWindowLog.keys.push(req.id)
                    const isSelected = () => at() === props.selectedIndex && props.active
                    const bg = () =>
                      isSelected()
                        ? theme().background.action.primary.focused
                        : theme().background.action.primary.base
                    const fg = () => (isSelected() ? theme().text.action.primary.focused : theme().text.base)

                    return (
                      <box
                        flexDirection="row"
                        flexShrink={0}
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={bg()}
                        onMouseUp={() => props.onSelect(at())}
                      >
                        <text fg={fg()} width={9}>{formatClock(req.at)}</text>
                        <text fg={req.kind === "ping" ? theme().text.muted : fg()} width={kindWidth()} wrapMode="none" truncate>
                          {kindLabel(req.kind)}
                        </text>
                        <text fg={isSelected() ? fg() : verdictFg(req.verdict)} width={10} attributes={TextAttributes.BOLD}>
                          {`[${req.verdict.toUpperCase()}]`}
                        </text>
                        <text fg={req.cause ? theme().text.feedback.warning.base : theme().text.muted} width={causeWidth()} wrapMode="none" truncate>
                          {req.cause ?? "—"}
                        </text>
                        <Show when={showAgent()}>
                          <text fg={fg()} width={16} wrapMode="none" truncate>
                            {req.model ?? req.agent ?? "—"}
                          </text>
                        </Show>
                        <Show when={showInput()}>
                          <text fg={fg()} width={9}>{formatTokens(req.input)}</text>
                        </Show>
                        <text fg={fg()} width={9}>{formatTokens(req.cacheRead)}</text>
                        <Show when={showCost()}>
                          <text fg={fg()} width={9}>{formatCost(req.cost) ?? "$0.00"}</text>
                        </Show>
                        <text fg={req.evidence ? fg() : theme().text.muted} flexGrow={1} wrapMode="none" truncate>
                          {req.evidence ?? "—"}
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
        }
      >
        {/* Detail drill-down */}
        {(() => {
          const d = detail()!
          const req = d.request
          return (
            <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1} paddingRight={1}>
              <box flexDirection="row" flexShrink={0} marginBottom={1}>
                <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexGrow={1}>
                  {`Request Detail: ${req.id} · ${req.kind} at ${formatClock(req.at)}`}
                </text>
                <text fg={theme().text.muted}>Press ⌫ or esc to return to list</text>
              </box>

              {/* Verdict & Cause */}
              <box flexDirection="row" flexShrink={0} marginBottom={1}>
                <text fg={verdictFg(req.verdict)} attributes={TextAttributes.BOLD}>
                  {`[${req.verdict.toUpperCase()}] `}
                </text>
                <text fg={theme().text.base}>
                  {`Cause: ${req.cause ?? "none"}${req.confidence ? ` (${req.confidence})` : ""}`}
                </text>
                <Show when={req.expected !== undefined}>
                  <text fg={theme().text.muted}>
                    {` · Expected prefix: ${formatTokens(req.expected!)} tokens`}
                  </text>
                </Show>
                <text fg={theme().text.muted}>
                  {` · Cache read: ${formatTokens(req.cacheRead)} · Miss tokens: ${formatTokens(req.missTokens ?? 0)}`}
                </text>
              </box>

              {/* Ids */}
              <text fg={theme().text.muted} flexShrink={0}>
                {`Session: ${req.sessionID}${req.messageID === undefined ? "" : ` · Message: ${req.messageID}`}`}
              </text>

              {/* Timing */}
              <box flexDirection="column" flexShrink={0} marginBottom={1}>
                <text fg={theme().text.muted}>
                  {`Gap since last request: ${formatMsLabel(d.timing.gapMs)} · Cache lifetime: ${formatMsLabel(d.timing.lifetimeMs)} · Warming: ${d.timing.warming ?? "—"}`}
                </text>
                <text fg={theme().text.muted}>
                  {`Pings on the prefix: ${d.pings.length}${d.timing.lastPingAt === undefined ? "" : ` · last at ${formatClock(d.timing.lastPingAt)}`}`}
                </text>
                <Show when={d.firstDivergence}>
                  <text fg={theme().text.feedback.warning.base}>
                    {`First diverging segment: ${d.firstDivergence}`}
                  </text>
                </Show>
              </box>

              {/* Evidence lines */}
              <Show when={d.lines.length > 0}>
                <box flexDirection="column" flexShrink={0} marginBottom={1}>
                  <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
                    Evidence:
                  </text>
                  <For each={d.lines}>
                    {(line) => <text fg={theme().text.base}>{`  • ${line}`}</text>}
                  </For>
                </box>
              </Show>

              {/* Segment diff table */}
              <Show when={d.segments.length > 0}>
                <box flexDirection="column" flexGrow={1} minWidth={0}>
                  <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
                    Fingerprint Segments:
                  </text>
                  <box flexDirection="row" flexShrink={0}>
                    <text fg={theme().text.muted} width={compact() ? 24 : 30} attributes={TextAttributes.BOLD}>Segment</text>
                    <text fg={theme().text.muted} width={compact() ? 8 : 12} attributes={TextAttributes.BOLD}>Kind</text>
                    <text fg={theme().text.muted} width={compact() ? 8 : 12} attributes={TextAttributes.BOLD}>Change</text>
                    <text fg={theme().text.muted} width={compact() ? 12 : 14} attributes={TextAttributes.BOLD}>Before</text>
                    <text fg={theme().text.muted} width={compact() ? 12 : 14} attributes={TextAttributes.BOLD}>After</text>
                  </box>
                  <scrollbox flexGrow={1}>
                    <For each={d.segments}>
                      {(seg) => (
                        <box flexDirection="row" flexShrink={0}>
                          <text fg={theme().text.base} width={compact() ? 24 : 30} wrapMode="none" truncate>{seg.name}</text>
                          <text fg={theme().text.muted} width={compact() ? 8 : 12}>{seg.kind}</text>
                          <text
                            fg={
                              seg.change === "changed"
                                ? theme().text.feedback.warning.base
                                : seg.change === "added"
                                  ? theme().text.feedback.success.base
                                  : theme().text.feedback.error.base
                            }
                            width={compact() ? 8 : 12}
                          >
                            {seg.change}
                          </text>
                          <text fg={theme().text.muted} width={compact() ? 12 : 14}>
                            {seg.before ? formatTokens(seg.before.tokens) : "—"}
                          </text>
                          <text fg={theme().text.base} width={compact() ? 12 : 14}>
                            {seg.after ? formatTokens(seg.after.tokens) : "—"}
                          </text>
                        </box>
                      )}
                    </For>
                  </scrollbox>
                </box>
              </Show>
            </box>
          )
        })()}
      </Show>
    </box>
  )
}
