import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Plus } from "../../../rpc.js"
import {
  formatClock,
  formatCost,
  formatMs,
  formatMsLabel,
  formatTokens,
  formatReportedRead,
  formatReportedWriteByTTL,
} from "../format.js"
import { createRowStore, createRowWindow } from "../window.js"
import { RequestFacts } from "../request-facts.js"

export interface StepsTabProps {
  readonly context: Plugin.Context
  readonly report: Plus.MonitorReport | undefined
  readonly selectedIndex: number
  readonly onSelect: (index: number) => void
  readonly detailID: string | undefined
  readonly active: boolean
  readonly onScrollRef?: (ref: ScrollBoxRenderable) => void
  readonly collection?: Plus.MonitorPageSection
}

export function StepsTab(props: StepsTabProps) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const requests = () => props.report?.requests ?? []
  const [details, setDetails] = createStore<{ detail: Plus.MonitorRequestDetail | undefined }>({
    detail: props.report?.detail,
  })
  createEffect(() => setDetails("detail", reconcile(props.report?.detail)))
  const detail = () => details.detail

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

  // Narrow terminals drop whole columns, keeping time, kind, agent/model,
  // input, read and output (the fields that identify a step).
  const available = () => dimensions().width - 2
  const showReason = () => available() >= 110
  const showCost = () => available() >= 102
  const showWrite = () => available() >= 88
  const showFinish = () => available() >= 80
  const compact = () => available() < 86

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      <Show
        when={
          props.detailID !== undefined &&
          detail() !== undefined &&
          props.collection &&
          props.collection !== "detail.segments"
        }
        fallback={
          <Show
            when={props.detailID !== undefined && detail() !== undefined}
            fallback={
              <box flexDirection="column" flexGrow={1} minWidth={0}>
                {/* Header row */}
                <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
                  <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
                    Time
                  </text>
                  <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
                    Kind
                  </text>
                  <text fg={theme().text.muted} width={16} attributes={TextAttributes.BOLD}>
                    Agent/Model
                  </text>
                  <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                    In
                  </text>
                  <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                    Read
                  </text>
                  <Show when={showWrite()}>
                    <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                      Write
                    </text>
                  </Show>
                  <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                    Out
                  </text>
                  <Show when={showReason()}>
                    <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                      Reason
                    </text>
                  </Show>
                  <Show when={showCost()}>
                    <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                      Cost
                    </text>
                  </Show>
                  <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                    Time
                  </text>
                  <Show when={showFinish()}>
                    <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
                      Finish
                    </text>
                  </Show>
                  <text fg={theme().text.muted} flexGrow={1} attributes={TextAttributes.BOLD}>
                    Tools Called
                  </text>
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
                      <text fg={theme().text.muted}>No steps or requests recorded in scope.</text>
                    </box>
                  }
                >
                  <scrollbox
                    flexGrow={1}
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
                      {(req, index) => {
                        const at = () => window.start + index()
                        const isSelected = () => at() === props.selectedIndex && props.active
                        const bg = () =>
                          isSelected()
                            ? theme().background.action.primary.focused
                            : theme().background.action.primary.base
                        const fg = () => (isSelected() ? theme().text.action.primary.focused : theme().text.base)

                        return (
                          <box
                            id={`monitor-row-${req.id}`}
                            flexDirection="row"
                            flexShrink={0}
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={bg()}
                            onMouseUp={() => props.onSelect(at())}
                          >
                            <text fg={fg()} width={10}>
                              {formatClock(req.at)}
                            </text>
                            <text fg={fg()} width={10}>
                              {req.kind}
                            </text>
                            <text fg={fg()} width={15} wrapMode="none" truncate>
                              {req.model ?? req.agent ?? "—"}
                            </text>
                            <box width={1} flexShrink={0} />
                            <text fg={fg()} width={8}>
                              {formatTokens(req.input)}
                            </text>
                            <text fg={fg()} width={8}>
                              {formatReportedRead(req)}
                            </text>
                            <Show when={showWrite()}>
                              <text fg={fg()} width={8}>
                                {formatTokens(req.cacheWrite)}
                              </text>
                            </Show>
                            <text fg={fg()} width={8}>
                              {formatTokens(req.output)}
                            </text>
                            <Show when={showReason()}>
                              <text fg={fg()} width={8}>
                                {formatTokens(req.reasoning)}
                              </text>
                            </Show>
                            <Show when={showCost()}>
                              <text fg={fg()} width={8}>
                                {formatCost(req.cost) ?? "$0.00"}
                              </text>
                            </Show>
                            <text fg={fg()} width={8}>
                              {formatMsLabel(req.durationMs)}
                            </text>
                            <Show when={showFinish()}>
                              <text fg={theme().text.muted} width={10} wrapMode="none" truncate>
                                {req.finish ?? "—"}
                              </text>
                            </Show>
                            <text fg={fg()} flexGrow={1} wrapMode="none" truncate>
                              {req.tools && req.tools.length > 0 ? req.tools.join(", ") : "—"}
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
            {/* Step detail drill-down */}
            {(() => {
              const d = detail()!
              const req = d.request
              const calls = d.calls ?? []
              return (
                <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1} paddingRight={1}>
                  <box flexDirection="row" flexShrink={0} marginBottom={1}>
                    <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexGrow={1}>
                      {`Step Detail: ${req.id} (${req.kind}) at ${formatClock(req.at)} · Finish: ${req.finish ?? "none"}`}
                    </text>
                    <text fg={theme().text.muted}>Press ⌫ to return to list · esc closes monitor</text>
                  </box>

                  {/* Calls with attributed tokens */}
                  <text fg={theme().text.base} flexShrink={0}>
                    {formatReportedWriteByTTL(req)}
                  </text>
                  <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
                    Tools Called by this Step:
                  </text>
                  <Show
                    when={calls.length > 0}
                    fallback={<text fg={theme().text.muted}> No tool calls in this step.</text>}
                  >
                    <box flexDirection="row" flexShrink={0}>
                      <text fg={theme().text.muted} width={14} attributes={TextAttributes.BOLD}>
                        Tool
                      </text>
                      <text fg={theme().text.muted} width={compact() ? 16 : 26} attributes={TextAttributes.BOLD}>
                        Target
                      </text>
                      <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
                        Call Tokens
                      </text>
                      <text fg={theme().text.muted} width={12} attributes={TextAttributes.BOLD}>
                        Result Tokens
                      </text>
                      <text fg={theme().text.muted} width={12} attributes={TextAttributes.BOLD}>
                        Carried
                      </text>
                      <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                        Status
                      </text>
                    </box>
                    <For each={calls}>
                      {(c) => (
                        <box flexDirection="row" flexShrink={0}>
                          <text fg={theme().text.base} width={14} wrapMode="none" truncate>
                            {c.tool}
                          </text>
                          <text fg={theme().text.muted} width={compact() ? 16 : 26} wrapMode="none" truncate>
                            {c.target ?? "—"}
                          </text>
                          <text fg={theme().text.base} width={10}>
                            {formatTokens(c.callTokens)}
                          </text>
                          <text fg={theme().text.base} width={12}>
                            {formatTokens(c.resultTokens)}
                          </text>
                          <text fg={theme().text.base} width={12}>
                            {formatTokens(c.carried)}
                          </text>
                          <text
                            fg={
                              c.status === "error"
                                ? theme().text.feedback.error.base
                                : c.status === "running"
                                  ? theme().text.feedback.info.base
                                  : theme().text.feedback.success.base
                            }
                            width={8}
                          >
                            {c.status}
                          </text>
                        </box>
                      )}
                    </For>
                  </Show>

                  {/* Fingerprint change against previous request */}
                  <box flexDirection="column" marginTop={1} flexGrow={1} minWidth={0}>
                    <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
                      Fingerprint Change vs Previous Request:
                    </text>
                    <Show when={d.firstDivergence}>
                      <text fg={theme().text.feedback.warning.base}>{`First Divergence: ${d.firstDivergence}`}</text>
                    </Show>
                    <Show
                      when={d.segments.length > 0}
                      fallback={
                        <text fg={theme().text.muted}>
                          {d.previous === undefined
                            ? "  No earlier request to compare."
                            : "  No segment changes recorded."}
                        </text>
                      }
                    >
                      <For each={d.segments}>
                        {(seg) => (
                          <text fg={theme().text.base}>
                            {`  • [${seg.change.toUpperCase()}] ${seg.kind} “${seg.name}” (${seg.before ? formatTokens(seg.before.tokens) : "0"} → ${seg.after ? formatTokens(seg.after.tokens) : "0"} tokens)`}
                          </text>
                        )}
                      </For>
                    </Show>
                  </box>
                </box>
              )
            })()}
          </Show>
        }
      >
        <RequestFacts context={props.context} detail={detail()!} collection={props.collection!} />
      </Show>
    </box>
  )
}
