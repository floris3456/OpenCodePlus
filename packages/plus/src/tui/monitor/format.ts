// Pure pieces of the monitor view: settings, the query they make, drill-down
// and the words and numbers the table prints.
import type { Plus } from "../../rpc.js"

export const WINDOWS = ["all", "15m", "1h", "24h", "7d", "30d"] as const
export type WindowName = (typeof WINDOWS)[number]

export const GROUPS = [
  "tool",
  "agent",
  "model",
  "target",
  "session",
  "config",
] as const satisfies readonly Plus.MonitorGroupBy[]
export const SCOPES = ["session", "project", "all"] as const satisfies readonly Plus.MonitorScope[]
export const SORTS = ["tokens", "carried", "calls", "errors", "time"] as const
export type SortName = (typeof SORTS)[number]
export const COMPARES = ["off", "previous", "mark"] as const
export type CompareName = (typeof COMPARES)[number]

const SPAN: Readonly<Record<Exclude<WindowName, "all">, number>> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
}

export interface MonitorSettings {
  readonly scope: Plus.MonitorScope
  readonly window: WindowName
  readonly group: Plus.MonitorGroupBy
  readonly sort: SortName
  readonly agent?: string
  readonly tool?: string
  readonly model?: string
  readonly errors: boolean
  readonly compare: CompareName
}

export const defaultSettings: MonitorSettings = {
  scope: "session",
  window: "all",
  group: "tool",
  sort: "tokens",
  errors: false,
  compare: "off",
}

/** A drill-down step: a group row turned into a filter, remembered so it can be undone. */
export interface Drill {
  readonly settings: MonitorSettings
  readonly sessionID?: string
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
  },
): Plus.MonitorQueryInput {
  const scope = settings.scope === "session" && context.sessionID === undefined ? "project" : settings.scope
  const window = windowOf(settings, context.now, context.marks)
  return {
    scope,
    ...(scope === "session" && context.sessionID !== undefined ? { sessionID: context.sessionID } : {}),
    ...(window.since === undefined ? {} : { since: window.since }),
    ...(window.until === undefined ? {} : { until: window.until }),
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
  const mark = marks[0]
  // Compare against a mark: after it is the main window, before it the comparison.
  if (settings.compare === "mark" && mark !== undefined) {
    const span = settings.window === "all" ? undefined : SPAN[settings.window]
    return { since: mark.at, compare: { ...(span === undefined ? {} : { since: mark.at - span }), until: mark.at } }
  }
  if (settings.window === "all") return {}
  const span = SPAN[settings.window]
  const since = now - span
  if (settings.compare === "previous") return { since, compare: { since: since - span, until: since } }
  return { since }
}

/** What the compare setting reads in words, for the header. */
export function compareLabel(settings: MonitorSettings, marks: readonly Plus.MonitorMark[]): string | undefined {
  if (settings.compare === "off") return undefined
  if (settings.compare === "mark")
    return marks[0] === undefined ? "no mark yet (m sets one)" : `before/after “${marks[0].label}”`
  return settings.window === "all" ? "pick a window (t) to compare" : `previous ${settings.window}`
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
  session: "this chat + delegated",
  project: "this project",
  all: "everywhere",
}

/** The totals line: what the model read and wrote, then what tools cost. */
export function totalsLine(totals: Plus.MonitorTotals): string {
  const cost = formatCost(totals.cost)
  return [
    `${totals.steps} steps`,
    `${totals.calls} calls${totals.errors > 0 ? ` (${totals.errors} failed)` : ""}${totals.running > 0 ? ` · ${totals.running} running` : ""}`,
    `in ${formatTokens(totals.input)}`,
    `cache ${formatTokens(totals.cacheRead)}`,
    `out ${formatTokens(totals.output + totals.reasoning)}`,
    ...(cost === undefined ? [] : [cost]),
  ].join(" · ")
}

export function toolLine(totals: Plus.MonitorTotals): string {
  return `tools: call ${formatTokens(totals.callTokens)} · result ${formatTokens(totals.resultTokens)} · carried ${formatTokens(totals.carried)}`
}
