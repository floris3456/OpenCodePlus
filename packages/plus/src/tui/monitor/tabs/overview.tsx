import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import type { Plus } from "../../../rpc.js"
import { formatClock, formatCost, formatTokens } from "../format.js"

export interface OverviewTabProps {
  readonly context: Plugin.Context
  readonly report: Plus.MonitorReport | undefined
  readonly full: boolean
}

export function OverviewTab(props: OverviewTabProps) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const current = () => props.report
  // The agent table drops its model column before it would clip on narrow terminals.
  const showModel = () => dimensions().width - 2 >= 90

  const topTools = () => {
    const groups = current()?.groups ?? []
    return [...groups].sort((a, b) => b.carried - a.carried).slice(0, 3)
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

  const contextInfo = () => {
    const r = current()
    return r?.context?.[0]
  }

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      {/* Unstable prefix warnings */}
      <Show when={(current()?.unstable?.length ?? 0) > 0}>
        <box flexDirection="column" marginBottom={1} paddingLeft={1} backgroundColor={theme().background.raised.base}>
          <text fg={theme().text.feedback.warning.base} attributes={TextAttributes.BOLD}>
            ⚠ Unstable Prefix Detected
          </text>
          <For each={current()?.unstable}>
            {(u) => (
              <text fg={theme().text.feedback.warning.base}>
                {`  • Segment “${u.segment}” diverged across ${u.streak} consecutive requests`}
              </text>
            )}
          </For>
        </box>
      </Show>

      {/* Token Mix & Context */}
      <box flexDirection="column" marginBottom={1}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          Token Mix &amp; Context
        </text>
        <Show when={current()?.totals}>
          {(totals) => (
            <box flexDirection="column" paddingLeft={1}>
              <text fg={theme().text.base}>
                {`Input: ${formatTokens(totals().input)} (uncached) · Cache Read: ${formatTokens(totals().cacheRead)} · Cache Write: ${formatTokens(totals().cacheWrite)}`}
              </text>
              <text fg={theme().text.base}>
                {`Output: ${formatTokens(totals().output)} · Reasoning: ${formatTokens(totals().reasoning)} · Hit Rate: ${Math.round(totals().hitRate * 100)}%`}
              </text>
              <Show when={contextInfo()}>
                {(ctx) => (
                  <text fg={theme().text.muted}>
                    {`Context Size: ${formatTokens(ctx().now)} tokens${ctx().atCompaction ? ` (at last compaction: ${formatTokens(ctx().atCompaction!)})` : ""}`}
                  </text>
                )}
              </Show>
              <Show when={current()?.pings}>
                {(p) => (
                  <text fg={theme().text.muted}>
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
          <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
            Top Cache Misses
          </text>
          <Show
            when={topMisses().length > 0}
            fallback={<text fg={theme().text.muted}>  No cache misses recorded</text>}
          >
            <For each={topMisses()}>
              {(miss, index) => (
                <box flexDirection="column" paddingLeft={1}>
                  <text fg={theme().text.feedback.error.base}>
                    {`#${index() + 1} [${miss.verdict.toUpperCase()}] ${miss.cause ?? "miss"}${miss.confidence ? ` (${miss.confidence})` : ""}: ${miss.evidence ?? "cache miss"}`}
                  </text>
                  <text fg={theme().text.muted}>
                    {`   missed ${formatTokens(miss.missTokens ?? miss.input)} · ${formatCost(miss.missCost ?? miss.cost) ?? "$0.00"} · ${miss.model ?? miss.agent ?? ""}`}
                  </text>
                </box>
              )}
            </For>
          </Show>
        </box>

        {/* Top 3 Carried Tools */}
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
            Top Tools by Carried Tokens
          </text>
          <Show
            when={topTools().length > 0}
            fallback={<text fg={theme().text.muted}>  No tool calls in scope</text>}
          >
            <For each={topTools()}>
              {(tool, index) => (
                <box flexDirection="column" paddingLeft={1}>
                  <text fg={theme().text.base}>
                    {`#${index() + 1} ${tool.label}: ${formatTokens(tool.carried)} carried`}
                  </text>
                  <text fg={theme().text.muted}>
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
          <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
            Agents in Scope
          </text>
          <box flexDirection="row" flexShrink={0} paddingLeft={1}>
            <text fg={theme().text.muted} width={16} attributes={TextAttributes.BOLD}>Agent</text>
            <Show when={showModel()}>
              <text fg={theme().text.muted} width={18} attributes={TextAttributes.BOLD}>Model</text>
            </Show>
            <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>Steps</text>
            <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Hit Rate</text>
            <text fg={theme().text.muted} width={8} attributes={TextAttributes.BOLD}>Misses</text>
            <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Tokens</text>
            <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Cost</text>
            <text fg={theme().text.muted} width={10} attributes={TextAttributes.BOLD}>Active</text>
          </box>
          <For each={agents()}>
            {(agent) => (
              <box flexDirection="row" flexShrink={0} paddingLeft={1}>
                <text fg={theme().text.base} width={16} wrapMode="none" truncate>{agent.agent}</text>
                <Show when={showModel()}>
                  <text fg={theme().text.muted} width={18} wrapMode="none" truncate>{agent.model ?? "—"}</text>
                </Show>
                <text fg={theme().text.base} width={8}>{String(agent.steps)}</text>
                <text fg={agent.hitRate < 0.5 ? theme().text.feedback.warning.base : theme().text.base} width={10}>
                  {`${Math.round(agent.hitRate * 100)}%`}
                </text>
                <text fg={agent.misses > 0 ? theme().text.feedback.error.base : theme().text.muted} width={8}>
                  {String(agent.misses)}
                </text>
                <text fg={theme().text.base} width={10}>{formatTokens(agent.tokens)}</text>
                <text fg={theme().text.base} width={10}>{formatCost(agent.cost) ?? "$0.00"}</text>
                <text fg={theme().text.muted} width={10}>{formatClock(agent.lastActive)}</text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
