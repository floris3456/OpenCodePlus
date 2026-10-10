// Vendored from opencode-pacer@35cfeff (src/core/meter.ts).
// The quota meter the sidebar shows: Pacer's usage view plus the quota that
// each reply carries (X-Pacer-Quota). Countdowns run locally between readings;
// a reset that passed shows "reset due" until a reading confirms it.

import type { QuotaReply, QuotaWindow, UsageView } from "./protocol.js"

export interface CredentialState {
  id: string
  alias: string
  provider: string
  shared_with: string[]
  windows: QuotaWindow[]
  /** When Pacer produced these windows (Unix ms). */
  at_ms: number
}

export interface Served {
  auth: string
  at_ms: number
}

export interface MeterSnapshot {
  v: 1
  credentials: CredentialState[]
  served: Record<string, Served>
}

export class Meter {
  private creds = new Map<string, CredentialState>()
  private served = new Map<string, Served>()
  private listeners = new Set<() => void>()

  /** Pacer's view of every account. A newer reply for an account is kept. */
  applyView(view: UsageView): void {
    for (const c of view.credentials) {
      const old = this.creds.get(c.id)
      if (old && old.at_ms > view.now_ms) {
        this.creds.set(c.id, { ...old, alias: c.alias, provider: c.provider, shared_with: c.shared_with })
        continue
      }
      this.creds.set(c.id, { ...c, at_ms: view.now_ms })
    }
    this.notify()
  }

  /** The quota a reply carried; `session` marks which account served that chat. */
  applyReply(reply: QuotaReply, session?: string): void {
    const old = this.creds.get(reply.auth)
    if (!old || old.at_ms <= reply.at_ms) {
      this.creds.set(reply.auth, {
        id: reply.auth,
        alias: reply.alias || old?.alias || reply.auth,
        provider: reply.provider,
        shared_with: old?.shared_with ?? [],
        windows: reply.windows,
        at_ms: reply.at_ms,
      })
    }
    if (session) {
      const last = this.served.get(session)
      if (!last || last.at_ms <= reply.at_ms) this.served.set(session, { auth: reply.auth, at_ms: reply.at_ms })
    }
    this.notify()
  }

  rows(filter?: { provider?: string }): CredentialState[] {
    return [...this.creds.values()]
      .filter((c) => !filter?.provider || c.provider === filter.provider)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.alias.localeCompare(b.alias))
  }

  lastServed(session: string): Served | undefined {
    return this.served.get(session)
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  snapshot(): MeterSnapshot {
    return { v: 1, credentials: [...this.creds.values()], served: Object.fromEntries(this.served) }
  }

  /** Merges a snapshot written by another process (newer data wins). */
  restore(s: MeterSnapshot): void {
    if (!s || s.v !== 1 || !Array.isArray(s.credentials)) return
    for (const c of s.credentials) {
      const old = this.creds.get(c.id)
      if (!old || old.at_ms < c.at_ms) this.creds.set(c.id, c)
    }
    for (const [session, value] of Object.entries(s.served ?? {})) {
      const old = this.served.get(session)
      if (!old || old.at_ms < value.at_ms) this.served.set(session, value)
    }
    this.notify()
  }

  private notify() {
    for (const fn of this.listeners) fn()
  }
}

/** 18000 → "5h", 604800 → "7d", a month → "30d". */
export function durationLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${Math.round(seconds / 60)}m`
}

/** Time until a reset: "37m", "4h 12m", "3d 4h"; "reset due" once it passed. */
export function countdown(resetMs: number, nowMs: number): string {
  const s = Math.floor((resetMs - nowMs) / 1000)
  if (s <= 0) return "reset due"
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${Math.max(m, 1)}m`
}

export type Severity = "ok" | "warning" | "error"

/** Pacer's colour thresholds: 20% and 10% left. */
export function severity(left: number | undefined): Severity {
  if (left === undefined) return "ok"
  if (left <= 10) return "error"
  if (left <= 20) return "warning"
  return "ok"
}

export interface WindowLine {
  /** "5h", "7d", "30d" */
  label: string
  /** Named limits ("opus", "gemini", "fable"), undefined for the account-wide one. */
  scope?: string
  /** Whole % left, rounded down; undefined when unknown. */
  left?: number
  severity: Severity
  /** Countdown, "reset due", or undefined when no reset is known. */
  reset?: string
  /** A word for an unusual state: stale, not started, no reading, conflicting. */
  note?: string
}

export function windowLine(w: QuotaWindow, nowMs: number): WindowLine {
  const left = w.left === undefined ? undefined : Math.floor(w.left)
  const line: WindowLine = {
    label: durationLabel(w.seconds),
    scope: w.scope === "all" ? undefined : w.scope,
    left,
    severity: severity(left),
  }
  if (w.reset_ms) {
    line.reset = countdown(w.reset_ms, nowMs)
    if (w.reset_quality === "estimated" && line.reset !== "reset due") line.reset = `~${line.reset}`
  }
  if (w.state === "awaiting-confirmation") line.reset = "reset due"
  else if (w.state === "stale") line.note = "stale"
  else if (w.state === "dormant") line.note = "not started"
  else if (w.state === "unknown") line.note = "no reading"
  else if (w.state === "conflicting" || w.state === "ambiguous") line.note = w.state
  return line
}

/** A text bar for `left` % in `width` cells. */
export function bar(left: number | undefined, width: number): string {
  if (left === undefined || width <= 0) return "·".repeat(Math.max(width, 0))
  const full = Math.round((Math.max(0, Math.min(100, left)) / 100) * width)
  return "█".repeat(full) + "░".repeat(width - full)
}
