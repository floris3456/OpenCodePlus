// Pure pieces of the monitor view: settings, the query they make, drill-down
// and the words and numbers the table prints.
import type { Plus } from "../../rpc.js"

export const TABS = ["overview", "cache", "tools", "sessions", "steps"] as const
export type TabName = (typeof TABS)[number]

export const WINDOWS = ["all", "compaction", "15m", "1h", "24h", "7d", "30d"] as const
export type WindowName = (typeof WINDOWS)[number]

export const GROUPS = [
  "tool",
  "agent",
  "model",
  "target",
  "session",
  "config",
] as const satisfies readonly Plus.MonitorGroupBy[]

export const SCOPES = ["session", "tree", "team", "project", "all"] as const satisfies readonly Plus.MonitorScope[]

export const SORTS = ["tokens", "carried", "calls", "errors", "time"] as const
export type SortName = (typeof SORTS)[number]

export const COMPARES = ["off", "previous", "mark"] as const
export type CompareName = (typeof COMPARES)[number]

const SPAN: Readonly<Record<Exclude<WindowName, "all" | "compaction">, number>> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
}

export interface MonitorSettings {
  readonly tab: TabName
  readonly scope: Plus.MonitorScope
  readonly window: WindowName
  readonly group: Plus.MonitorGroupBy
  readonly sort: SortName
  readonly team?: string
  readonly agent?: string
  readonly tool?: string
  readonly model?: string
  readonly errors: boolean
  readonly missesOnly: boolean
  readonly filterText?: string
  readonly compare: CompareName
}

export const defaultSettings: MonitorSettings = {
  tab: "overview",
  scope: "session",
  window: "all",
  group: "tool",
  sort: "tokens",
  errors: false,
  missesOnly: false,
  compare: "off",
}

/** A drill-down step: a group row or detail view turned into a filter, remembered so it can be undone. */
export interface Drill {
  readonly kind?: "tools" | "cache" | "steps"
  readonly settings: MonitorSettings
  readonly sessionID?: string
  readonly requestID?: string
}

export function cycle<T>(values: readonly T[], current: T, direction = 1): T {
  const index = values.indexOf(current)
  return values[(index + direction + values.length) % values.length] ?? current
}

/**
 * The query for these settings. The session scope needs a session (a chat
 * open in the TUI); without one it falls back to the project. A comparison
 * reads the window just before this one, or before and after the latest mark.
 */
export function queryOf(
  settings: MonitorSettings,
  context: {
    readonly sessionID?: string
    readonly now: number
    readonly marks: readonly Plus.MonitorMark[]
    readonly top: number
    readonly feed: number
    readonly id?: string
  },
): Plus.MonitorQueryInput {
  const scope =
    (settings.scope === "session" || settings.scope === "tree") && context.sessionID === undefined
      ? "project"
      : settings.scope
  const window = windowOf(settings, context.now, context.marks)
  return {
    scope,
    ...((scope === "session" || scope === "tree") && context.sessionID !== undefined
      ? { sessionID: context.sessionID }
      : {}),
    ...(settings.team !== undefined ? { team: settings.team } : {}),
    ...(settings.window === "compaction" ? { sinceCompaction: true } : {}),
    ...(window.since === undefined ? {} : { since: window.since }),
    ...(window.until === undefined ? {} : { until: window.until }),
    view: settings.tab,
    ...(context.id !== undefined ? { id: context.id } : {}),
    ...(settings.missesOnly ? { missesOnly: true } : {}),
    ...(settings.agent === undefined ? {} : { agents: [settings.agent] }),
    ...(settings.tool === undefined ? {} : { tools: [settings.tool] }),
    ...(settings.model === undefined ? {} : { models: [settings.model] }),
    ...(settings.errors ? { errors: true } : {}),
    group: settings.group,
    sort: settings.sort,
    top: context.top,
    feed: context.feed,
    ...(window.compare === undefined ? {} : { compare: window.compare }),
  }
}

function windowOf(
  settings: MonitorSettings,
  now: number,
  marks: readonly Plus.MonitorMark[],
): { since?: number; until?: number; compare?: Plus.MonitorWindow } {
  if (settings.window === "compaction") return {}
  const mark = marks[0]
  // Compare against a mark: after it is the main window, before it the comparison.
  if (settings.compare === "mark" && mark !== undefined) {
    const span = settings.window === "all" ? undefined : SPAN[settings.window as Exclude<WindowName, "all" | "compaction">]
    return { since: mark.at, compare: { ...(span === undefined ? {} : { since: mark.at - span }), until: mark.at } }
  }
  if (settings.window === "all") return {}
  const span = SPAN[settings.window as Exclude<WindowName, "all" | "compaction">]
  if (span === undefined) return {}
  const since = now - span
  if (settings.compare === "previous") return { since, compare: { since: since - span, until: since } }
  return { since }
}

/** What the compare setting reads in words, for the header. */
export function compareLabel(settings: MonitorSettings, marks: readonly Plus.MonitorMark[]): string | undefined {
  if (settings.compare === "off") return undefined
  if (settings.compare === "mark")
    return marks[0] === undefined ? "no mark yet (m sets one)" : `before/after “${marks[0].label}”`
  return settings.window === "all" || settings.window === "compaction"
    ? "pick a window (t) to compare"
    : `previous ${settings.window}`
}

/** Enter on a group row: filter to it and look one level deeper. */
export function drillInto(settings: MonitorSettings, group: Plus.MonitorGroup): Drill | undefined {
  if (settings.group === "tool") return { settings: { ...settings, tool: group.key, group: "target" } }
  if (settings.group === "agent") return { settings: { ...settings, agent: group.key, group: "tool" } }
  if (settings.group === "model") return { settings: { ...settings, model: group.key, group: "tool" } }
  if (settings.group === "session")
    return { settings: { ...settings, scope: "session", group: "tool" }, sessionID: group.key }
  return undefined
}

/** True when the text filter is off or one of the values contains it. */
export function textMatches(filter: string | undefined, values: readonly (string | undefined)[]): boolean {
  if (filter === undefined || filter === "") return true
  const needle = filter.toLowerCase()
  return values.some((value) => value !== undefined && value.toLowerCase().includes(needle))
}

/**
 * The Cache tab's rows, newest first. The report keeps its chronological
 * (oldest-first) order for every other consumer; only this tab reverses.
 */
export function cacheRequests(
  report: Plus.MonitorReport | undefined,
  missesOnly: boolean,
): readonly Plus.MonitorRequest[] {
  const list = report?.requests ?? []
  const filtered = missesOnly
    ? list.filter((request) => request.verdict === "miss" || request.verdict === "partial")
    : list
  return filtered.toReversed()
}

/**
 * Apply the `/` text filter to the rendered rows only. Totals still answer the
 * real query; the tables drop rows whose identifiers do not contain the text.
 */
export function filterReport(report: Plus.MonitorReport, filter: string | undefined): Plus.MonitorReport {
  if (filter === undefined || filter === "") return report
  return {
    ...report,
    groups: report.groups.filter((group) => textMatches(filter, [group.key, group.label])),
    feed: report.feed.filter((call) =>
      textMatches(filter, [call.agent, call.model, call.tool, call.target, call.error]),
    ),
    ...(report.requests === undefined
      ? {}
      : {
          requests: report.requests.filter((request) =>
            textMatches(filter, [
              request.id,
              request.agent,
              request.model,
              request.kind,
              request.cause,
              request.evidence,
              ...(request.tools ?? []),
            ]),
          ),
        }),
    ...(report.sessions === undefined
      ? {}
      : {
          sessions: report.sessions.filter((session) =>
            textMatches(filter, [
              session.sessionID,
              session.title,
              session.agent,
              session.role,
              session.team,
              session.state,
              session.runID,
            ]),
          ),
        }),
    ...(report.agents === undefined
      ? {}
      : { agents: report.agents.filter((agent) => textMatches(filter, [agent.agent, agent.model])) }),
    ...(report.topMisses === undefined
      ? {}
      : {
          topMisses: report.topMisses.filter((request) =>
            textMatches(filter, [request.id, request.agent, request.model, request.cause, request.evidence]),
          ),
        }),
    ...(report.topTools === undefined
      ? {}
      : { topTools: report.topTools.filter((group) => textMatches(filter, [group.key, group.label])) }),
    ...(report.compare === undefined
      ? {}
      : {
          compare: {
            ...report.compare,
            groups: report.compare.groups.filter((group) => textMatches(filter, [group.key, group.label])),
          },
        }),
  }
}

export function formatTokens(value: number): string {
  const n = Math.round(value)
  if (Math.abs(n) < 1_000) return String(n)
  if (Math.abs(n) < 1_000_000) return `${trim(n / 1_000)}k`
  if (Math.abs(n) < 1_000_000_000) return `${trim(n / 1_000_000)}M`
  return `${trim(n / 1_000_000_000)}B`
}

function trim(value: number): string {
  return Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "")
}

export function formatDelta(now: number, before: number): string {
  if (before === 0 && now === 0) return "·"
  if (before === 0) return "new"
  const change = Math.round(((now - before) / before) * 100)
  return change === 0 ? "±0%" : `${change > 0 ? "+" : ""}${change}%`
}

export function formatMs(ms: number): string {
  if (ms <= 0) return "·"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${trim(ms / 1_000)}s`
  return `${trim(ms / 60_000)}m`
}

/**
 * A timing that never invents a zero: an omitted value is explicitly unknown
 * (`—`), while a real zero stays a real zero (`0ms`).
 */
export function formatMsLabel(ms: number | undefined): string {
  if (ms === undefined) return "—"
  if (ms <= 0) return "0ms"
  return formatMs(ms)
}

export function formatClock(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":")
}

export function formatCost(value: number): string | undefined {
  if (value <= 0) return undefined
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`
}

/**
 * A labelled cost that never invents a free number: an absent value is
 * explicitly unknown (`—`), a known zero is `$0.00`, and any other value uses
 * the same short form as `formatCost`.
 */
export function formatCostLabel(value: number | undefined): string {
  if (value === undefined) return "—"
  if (value <= 0) return "$0.00"
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`
}

export function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  const fitted = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
  return align === "left" ? fitted.padEnd(width) : fitted.padStart(width)
}

export const scopeWords: Readonly<Record<Plus.MonitorScope, string>> = {
  session: "This session",
  tree: "Team tree",
  team: "Team",
  project: "Project",
  all: "Everything",
}

export const windowLabels: Readonly<Record<WindowName, string>> = {
  all: "All",
  compaction: "Since last compaction",
  "15m": "15m",
  "1h": "1h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
}

/**
 * The full page's totals: every metric is always present and labelled, wrapped
 * across as many lines as `width` needs. A metric is never dropped and an
 * unknown miss cost is `—`, never a substituted or invented number.
 */
export function totalsLines(totals: Plus.MonitorTotals, width = 120): string[] {
  const hr = totals.hitRate === undefined ? "—" : `${Math.round(totals.hitRate * 100)}%`
  const cost = formatCostLabel(totals.cost)
  const missCost = formatCostLabel(totals.missCost)
  // steps is required; requests, misses and pings are optional and must show
  // — when the RPC omitted them rather than an invented zero.
  const metrics = [
    `reqs: ${totals.requests ?? "—"}`,
    `steps: ${totals.steps}`,
    `in: ${formatTokens(totals.input)}`,
    `read: ${formatTokens(totals.cacheRead)}`,
    `write: ${formatTokens(totals.cacheWrite)}`,
    `out: ${formatTokens(totals.output)}`,
    `reason: ${formatTokens(totals.reasoning)}`,
    `hit rate: ${hr}`,
    `misses: ${totals.misses ?? "—"}`,
    `miss cost: ${missCost}`,
    `pings: ${totals.pings ?? "—"}`,
    `cost: ${cost}`,
  ]
  // The page insets its content by one column on each side, so wrap to the
  // usable width rather than the terminal width to avoid renderer clipping.
  return wrapLabels(metrics, Math.max(20, width - 2))
}

function wrapLabels(metrics: readonly string[], width: number): string[] {
  const lines: string[] = []
  let current = ""
  for (const metric of metrics) {
    const candidate = current === "" ? metric : `${current} · ${metric}`
    if (current !== "" && candidate.length > width) {
      lines.push(current)
      current = metric
    } else {
      current = candidate
    }
  }
  if (current !== "") lines.push(current)
  return lines
}

/** The compact composer totals: one line, never a horizontal overflow. */
export function totalsLine(totals: Plus.MonitorTotals, width = 120): string {
  const hr = totals.hitRate === undefined ? "—" : `${Math.round(totals.hitRate * 100)}%`
  const cost = formatCostLabel(totals.cost)
  if (width < 90) {
    return [
      `reqs: ${totals.requests ?? "—"}`,
      `steps: ${totals.steps}`,
      `read: ${formatTokens(totals.cacheRead)}`,
      `hit rate: ${hr}`,
      `misses: ${totals.misses ?? "—"}`,
      `cost: ${cost}`,
    ].join(" · ")
  }
  return [
    `reqs: ${totals.requests ?? "—"}`,
    `steps: ${totals.steps}`,
    `in: ${formatTokens(totals.input)}`,
    `read: ${formatTokens(totals.cacheRead)}`,
    `write: ${formatTokens(totals.cacheWrite)}`,
    `out: ${formatTokens(totals.output)}`,
    `reason: ${formatTokens(totals.reasoning)}`,
    `hit rate: ${hr}`,
    `misses: ${totals.misses ?? "—"}`,
    `miss cost: ${formatCostLabel(totals.missCost)}`,
    `pings: ${totals.pings ?? "—"}`,
    `cost: ${cost}`,
  ].join(" · ")
}

export function toolLine(totals: Plus.MonitorTotals): string {
  return `tools: call ${formatTokens(totals.callTokens)} · result ${formatTokens(totals.resultTokens)} · carried ${formatTokens(totals.carried)}`
}
