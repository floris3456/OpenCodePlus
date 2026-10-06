// Pure words and numbers for the compact credential usage view. Rendering and
// polling live in usage-view.tsx and usage-store.ts.
import type { UsageSnapshot, UsageWindow } from "./usage.js"

export function usageArguments(input = "") {
  const value = input.trim()
  if (value === "") return false
  if (value === "--all") return true
  return undefined
}

const UNITS = [
  { seconds: 86400, short: "d", long: "day" },
  { seconds: 3600, short: "h", long: "hour" },
  { seconds: 60, short: "m", long: "minute" },
  { seconds: 1, short: "s", long: "second" },
] as const

/** Largest unit that divides the window exactly: 18000 → 5 hours, 604800 → 7 days. */
function windowUnit(seconds: number) {
  const unit = UNITS.find((item) => seconds >= item.seconds && seconds % item.seconds === 0) ?? UNITS[3]
  return { count: Math.round(seconds / unit.seconds), unit }
}

/** Full window name, including a model or app scope: "5 hours", "7 days · sonnet". */
export function windowLabel(window: UsageWindow) {
  const value = windowUnit(window.seconds)
  const duration = `${value.count} ${value.unit.long}${value.count === 1 ? "" : "s"}`
  return window.scope === "all" ? duration : `${duration} · ${window.scope}`
}

/** Compact duration column: "5h", "7d", "30m". */
export function windowShort(window: UsageWindow) {
  const value = windowUnit(window.seconds)
  return `${value.count}${value.unit.short}`
}

/** Whole remaining percent, rounded down so the bar never overstates capacity. */
export function percentLabel(remaining: number) {
  const value = Math.max(0, Math.min(100, remaining))
  if (value > 0 && value < 1) return "<1%"
  return `${Math.floor(value)}%`
}

export function exactPercent(remaining: number) {
  return `${Number(Math.max(0, Math.min(100, remaining)).toFixed(1))}%`
}

/** Filled and empty cells of a remaining-quota bar of exactly `width` cells. */
export function barCells(remaining: number, width: number) {
  const size = Math.max(0, width)
  const filled = Math.min(size, Math.round((Math.max(0, Math.min(100, remaining)) / 100) * size))
  return { filled: "█".repeat(filled), empty: "░".repeat(size - filled) }
}

/**
 * Short countdown with two units, so it never reads like a window name:
 * "6d 23h", "5h 0m", "59m", "<1m".
 */
export function countdown(seconds: number) {
  if (seconds < 60) return "<1m"
  const minutes = Math.ceil(seconds / 60)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

export type WindowState = "normal" | "low" | "critical" | "stale" | "reset" | "dormant" | "unlimited"

/**
 * Display state of one window. `reset` means the reset time passed and no newer
 * reading exists; `stale` means the reading is older than the bridge's maximum age.
 * Neither is shown as current capacity.
 */
export function windowState(window: UsageWindow, snapshot: UsageSnapshot, now: number): WindowState {
  if (window.not_applicable) return "unlimited"
  if (window.dormant) return "dormant"
  if (window.reset <= now) return "reset"
  if (now - window.observed > snapshot.max_age_seconds) return "stale"
  if (window.remaining <= 10) return "critical"
  if (window.remaining <= 20) return "low"
  return "normal"
}

/** Right-hand status column (at most seven cells). */
export function windowTail(window: UsageWindow, state: WindowState, now: number) {
  if (state === "unlimited") return "n/a"
  if (state === "dormant") return "dormant"
  if (state === "reset") return "reset"
  if (state === "stale") return "STALE"
  return countdown(window.reset - now)
}

/** Exact detail line for one window; keeps dates and full names out of the compact row. */
export function windowDetail(window: UsageWindow, state: WindowState, now: number) {
  const label = windowLabel(window)
  if (state === "unlimited") return `${label} · no limit for this window`
  if (state === "dormant") return `${label} · window has not started`
  if (state === "reset") return `${label} · reset passed; awaiting a fresh reading`
  const when = new Date(window.reset * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  const age = state === "stale" ? ` · reading ${countdown(now - window.observed)} old` : ""
  return `${label} · ${exactPercent(window.remaining)} left · resets ${when}${age}`
}

/** The credential this chat is using or last used, else none. */
export function identity(snapshot: UsageSnapshot, id: string) {
  if (snapshot.active.includes(id)) return "active"
  if (snapshot.current === id) return "last"
  return undefined
}
