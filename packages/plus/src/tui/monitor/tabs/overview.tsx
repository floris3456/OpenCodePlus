import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import type { Plus } from "../../../rpc.js"
import { formatClock, formatCost, formatCostLabel, formatTokens, formatReusePercent, pad } from "../format.js"

export interface OverviewTabProps {
  readonly context: Plugin.Context
  readonly report: Plus.MonitorReport | undefined
  readonly full: boolean
  readonly collection?: Plus.MonitorPageSection
}

export function OverviewTab(props: OverviewTabProps) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const current = () => props.report
  // The agent table drops its model column before it would clip on narrow terminals.
  // Columns keep Time/agent 16, Steps 8, Hit 10, Misses 8, Tokens 10, Cost 10,
  // Active 10 = 72; the model column adds 18, so it needs 90 + padding + margins.
  const showModel = () => dimensions().width - 4 >= 95

  const topTools = () => {
    const r = current()
    if (!r) return []
    if (r.topTools && r.topTools.length > 0) return r.topTools.slice(0, 3)
    return []
  }

  const topMisses = () => {
    const r = current()
    if (!r) return []
    if (r.topMisses && r.topMisses.length > 0) return r.topMisses.slice(0, 3)
    const requests = r.requests ?? []
    return requests
      .filter((req) => req.verdict === "miss" || req.verdict === "partial")
      .sort((a, b) => (b.missCost ?? 0) - (a.missCost ?? 0) || (b.missTokens ?? 0) - (a.missTokens ?? 0))
      .slice(0, 3)
  }

  const agents = () => {
    const r = current()
    if (!r) return []
    if (r.agents && r.agents.length > 0) return r.agents
    return []
  }

  return (
    <Show
      when={props.collection}
      fallback={
        <scrollbox flexGrow={1} minHeight={0}>
          <box flexDirection="column" flexGrow={1} minWidth={0}>
            {/* Unstable prefix warnings */}
            <Show when={(current()?.unstable?.length ?? 0) > 0}>
              <box
                flexDirection="column"
                marginBottom={1}
                paddingLeft={1}
                backgroundColor={theme().background.raised.base}
              >
                <text fg={theme().text.feedback.warning.base} attributes={TextAttributes.BOLD} flexShrink={0}>
                  ⚠ Unstable Prefix Detected
                </text>
                <For each={current()?.unstable}>
                  {(u) => (
                    <text fg={theme().text.feedback.warning.base} flexShrink={0}>
                      {`  • Segment “${u.segment}” diverged across ${u.streak} consecutive requests`}
                    </text>
                  )}
                </For>
              </box>
            </Show>

            {/* Token Mix & Context */}
            <box flexDirection="column" marginBottom={1}>
              <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
                Token Mix &amp; Context
              </text>
              <Show when={current()?.totals}>
                {(totals) => (
                  <box flexDirection="column" paddingLeft={1} minWidth={0} flexShrink={0}>
                    <Show
                      when={dimensions().width >= 100}
                      fallback={
                        <text fg={theme().text.base} wrapMode="none" truncate>
                          {`In: ${formatTokens(totals().input)} · Read: ${formatTokens(totals().cacheRead)} · Write: ${formatTokens(totals().cacheWrite)} · Reuse: ${formatReusePercent(totals().hitRate)}`}
                        </text>
                      }
                    >
                      <text fg={theme().text.base} wrapMode="none" truncate>
                        {`Input: ${formatTokens(totals().input)} (uncached) · Cache Read: ${formatTokens(totals().cacheRead)} · Cache Write: ${formatTokens(totals().cacheWrite)}`}
                      </text>
                      <text fg={theme().text.base} wrapMode="none" truncate>
                        {`Output: ${formatTokens(totals().output)} · Reasoning: ${formatTokens(totals().reasoning)} · Input reuse: ${formatReusePercent(totals().hitRate)}`}
                      </text>
                    </Show>
                    <text fg={theme().text.muted} wrapMode="none" truncate>
                      {`Coverage: ${totals().measuredRequests ?? 0} measured · ${totals().unknownRequests ?? 0} unknown (warming excluded)`}
                    </text>
                    <For each={current()?.context ?? []}>
                      {(ctx) => (
                        <text fg={theme().text.muted} wrapMode="none" truncate>
                          {`Context Size: ${ctx.inputState === "pending" ? "pending" : ctx.inputState === "unavailable" ? "unavailable" : `${formatTokens(ctx.measuredNow ?? ctx.now)} tokens${ctx.inputState === "stored" ? " (stored accounting)" : ""}`}${ctx.atCompaction ? ` (at last compaction: ${formatTokens(ctx.atCompaction)})` : ""} · ${ctx.sessionID}`}
                        </text>
                      )}
                    </For>
                    <Show when={current()?.pings}>
                      {(p) => (
                        <text fg={theme().text.muted} wrapMode="none" truncate>
                          {`Keep-alive Pings: ${p().sent} sent · Cost: ${formatCost(p().cost) ?? "$0.00"} · Subsequent: ${p().followedByHit} hits, ${p().followedByMiss} misses`}
                        </text>
                      )}
                    </Show>
                  </box>
                )}
              </Show>
            </box>

            {/* Top Misses & Top Carried Tools */}
            <box flexDirection="row" marginBottom={1} minWidth={0}>
              {/* Top 3 Misses */}
              <box flexDirection="column" flexGrow={1} minWidth={0} marginRight={1}>
                <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={0} wrapMode="none" truncate>
                  {dimensions().width >= 100 ? "Top Cache Misses" : "Top Misses"}
                </text>
                <Show
                  when={topMisses().length > 0}
                  fallback={
                    <text fg={theme().text.muted} flexShrink={0}>
                      {" "}
                      No cache misses recorded
                    </text>
                  }
                >
                  <For each={topMisses()}>
                    {(miss, index) => (
                      <box flexDirection="column" paddingLeft={1} minWidth={0} flexShrink={0}>
                        <text
                          fg={theme().text.feedback.error.base}
                          wrapMode="none"
                          truncate
                          flexShrink={1}
                          minWidth={0}
                        >
                          {`#${index() + 1} [${miss.verdict.toUpperCase()}] ${miss.causeText ?? miss.cause ?? "miss"}${miss.confidence ? ` (${miss.confidence})` : ""}: ${miss.evidence ?? "cache miss"}`}
                        </text>
                        <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={1} minWidth={0}>
                          {`   missed ${formatTokens(miss.missTokens ?? miss.input)} · ${formatCostLabel(miss.missCost)} · ${miss.model ?? miss.agent ?? ""}`}
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>

              {/* Top 3 Carried Tools */}
              <box flexDirection="column" flexGrow={1} minWidth={0}>
                <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={0} wrapMode="none" truncate>
                  {dimensions().width >= 110 ? "Top Tools by Carried Tokens" : "Top Tools"}
                </text>
                <Show
                  when={topTools().length > 0}
                  fallback={
                    <text fg={theme().text.muted} flexShrink={0}>
                      {" "}
                      No tool calls in scope
                    </text>
                  }
                >
                  <For each={topTools()}>
                    {(tool, index) => (
                      <box flexDirection="column" paddingLeft={1} minWidth={0} flexShrink={0}>
                        <text fg={theme().text.base} wrapMode="none" truncate flexShrink={1} minWidth={0}>
                          {`#${index() + 1} ${tool.label}: ${formatTokens(tool.carried)} carried`}
                        </text>
                        <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={1} minWidth={0}>
                          {`   ${tool.calls} calls · result ${formatTokens(tool.resultTokens)} · avg ${tool.avgMs}ms`}
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </box>

            {/* Agents in Scope Table */}
            <Show when={agents().length > 0}>
              <box flexDirection="column" flexGrow={1} minWidth={0}>
                <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
                  Agents in Scope
                </text>
                <box flexDirection="row" flexShrink={0} paddingLeft={1}>
                  <text fg={theme().text.muted} width={16} attributes={TextAttributes.BOLD}>
                    {pad("Agent", 16)}
                  </text>
                  <Show when={showModel()}>
                    <text fg={theme().text.muted} width={18} attributes={TextAttributes.BOLD}>
                      {pad("Model", 18)}
                    </text>
                  </Show>
                  <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                    {pad("Steps", 8)}
                  </text>
                  <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
                    {pad("Hit Rate", 10)}
                  </text>
                  <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>
                    {pad("Misses", 8)}
                  </text>
                  <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
                    {pad("Tokens", 10)}
                  </text>
                  <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
                    {pad("Cost", 10)}
                  </text>
                  <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>
                    {pad("Active", 10)}
                  </text>
                </box>
                <For each={agents()}>
                  {(agent) => {
                    // Fixed-width cells are padded to their exact widths so the
                    // renderer never wraps or overdraws a narrow row.
                    const cells = () => [
                      { text: pad(agent.agent, 16), width: 16 },
                      ...(showModel() ? [{ text: pad(agent.model ?? "—", 18), width: 18 }] : []),
                      { text: pad(String(agent.steps), 8), width: 8 },
                      { text: pad(formatReusePercent(agent.hitRate), 10), width: 10 },
                      { text: pad(String(agent.misses), 8), width: 8 },
                      { text: pad(formatTokens(agent.tokens), 10), width: 10 },
                      { text: pad(formatCost(agent.cost) ?? "$0.00", 10), width: 10 },
                      { text: pad(formatClock(agent.lastActive), 10), width: 10 },
                    ]
                    return (
                      <box flexDirection="row" flexShrink={0} paddingLeft={1} minWidth={0}>
                        <For each={cells()}>
                          {(cell) => (
                            <text fg={theme().text.base} width={cell.width} wrapMode="none">
                              {cell.text}
                            </text>
                          )}
                        </For>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Show>
          </box>
        </scrollbox>
      }
    >
      <scrollbox flexGrow={1} minHeight={0}>
        <For
          each={
            props.collection === "context"
              ? current()?.context?.map((row) => JSON.stringify(row))
              : props.collection === "unstable"
                ? current()?.unstable?.map((row) => JSON.stringify(row))
                : current()?.agents?.map((row) => JSON.stringify(row))
          }
        >
          {(row) => (
            <text fg={theme().text.base} flexShrink={0}>
              {row}
            </text>
          )}
        </For>
      </scrollbox>
    </Show>
  )
}
