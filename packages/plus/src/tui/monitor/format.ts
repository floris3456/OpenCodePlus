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

export function formatClock(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":")
}

export function formatCost(value: number): string | undefined {
  if (value <= 0) return undefined
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

/** The totals line: always-visible labelled totals. */
export function totalsLine(totals: Plus.MonitorTotals, width = 120): string {
  const hr = totals.hitRate === undefined ? "—" : `${Math.round(totals.hitRate * 100)}%`
  const cost = formatCost(totals.cost) ?? "$0.00"
  const missCost = (totals.missCost ?? 0) > 0 ? ` (${formatCost(totals.missCost!)})` : ""

  if (width < 90) {
    return [
      `reqs: ${totals.requests ?? totals.steps}`,
      `steps: ${totals.steps}`,
      `read: ${formatTokens(totals.cacheRead)}`,
      `hit rate: ${hr}`,
      `misses: ${totals.misses ?? "—"}`,
      `cost: ${cost}`,
    ].join(" · ")
  }

  return [
    `reqs: ${totals.requests ?? totals.steps}`,
    `steps: ${totals.steps}`,
    `in: ${formatTokens(totals.input)}`,
    `read: ${formatTokens(totals.cacheRead)}`,
    `write: ${formatTokens(totals.cacheWrite)}`,
    `out: ${formatTokens(totals.output)}`,
    ...(totals.reasoning > 0 ? [`reason: ${formatTokens(totals.reasoning)}`] : []),
    `hit rate: ${hr}`,
    `misses: ${totals.misses ?? "—"}${missCost}`,
    ...((totals.pings ?? 0) > 0 ? [`pings: ${totals.pings}`] : []),
    `cost: ${cost}`,
  ].join(" · ")
}

export function toolLine(totals: Plus.MonitorTotals): string {
  return `tools: call ${formatTokens(totals.callTokens)} · result ${formatTokens(totals.resultTokens)} · carried ${formatTokens(totals.carried)}`
}
