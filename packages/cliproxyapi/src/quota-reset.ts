import type { SessionError } from "@opencode/schema/session-error"

/**
 * A provider answer that says the account is out of quota, and when it serves
 * again: `text` is the UTC clock line a settlement and a refusal print.
 */
export interface QuotaReset {
  readonly untilMs: number
  readonly text: string
}

/** How long an out-of-quota answer with no readable reset is assumed to last. */
export const QUOTA_RESET_UNKNOWN_MS = 15 * 60_000

/** A word that makes a 429 a quota answer rather than a throttle Core retries itself. */
const QUOTA_WORDS = /quota|usage limit|limit reached|exhausted|reset/i

/** One or more `<n> <unit>` runs: "3h12m", "2 hours", "1h 5m 3s", "90 seconds". */
const DURATION = String.raw`(?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*)+`
const RESET_PHRASE = new RegExp(String.raw`(?:resets?|try again)\s+(?:in|after)\s+(${DURATION})`, "i")
const BARE_IN = new RegExp(String.raw`\bin\s+(${DURATION})`, "i")
const RESET_AT = /resets?\s+at\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2}))/i
const RESETS_AT_UNIX = /resets?_at["']?\s*[:=]\s*["']?(\d{10,13})/i
const RETRY_AFTER = /retry[\s-]after\s*:?\s*(\d+)/i

/**
 * The reset time a quota answer names, for a provider that will not serve until
 * then. Core classifies a 429 whose body says "quota exceeded … resets in
 * 3h12m" as a quota (`provider.quota`, not retried), but drops the reset time,
 * so a step that fails on one has nothing to tell the parent. A plain throttle
 * ("Too many requests, slow down") is not this: Core's own retries handle it.
 */
export function quotaReset(
  error: Pick<SessionError.Error, "type" | "message" | "status" | "response">,
  now: number,
): QuotaReset | undefined {
  if (error.status !== 429 && error.type !== "provider.quota") return undefined
  const text = `${error.message}\n${error.response?.body ?? ""}`
  if (!QUOTA_WORDS.test(text)) return undefined
  const untilMs = resetTime(text, now)
  // A quota with no readable reset still cools the provider for a while: it
  // must not be retried at once, and 15 minutes is the shortest wait worth it.
  if (untilMs === undefined) {
    const fallback = now + QUOTA_RESET_UNKNOWN_MS
    return { untilMs: fallback, text: `${quotaResetText(fallback, now)}; reset time unknown` }
  }
  return { untilMs, text: quotaResetText(untilMs, now) }
}

/** "<HH:MM> UTC (in <h> h <m> min)", the line a settlement and a refusal print. */
export function quotaResetText(untilMs: number, now: number): string {
  return `${clock(untilMs)} UTC (${relative(untilMs, now)})`
}

/** The moment the answer names, from its body text, in ms; undefined when nothing parses. */
function resetTime(text: string, now: number): number | undefined {
  const iso = RESET_AT.exec(text)
  if (iso !== null) {
    const at = Date.parse(iso[1]!)
    if (!Number.isNaN(at)) return at
  }
  // A quota response's JSON body carries the reset as unix seconds or ms.
  const unix = RESETS_AT_UNIX.exec(text)
  if (unix !== null) {
    const value = Number(unix[1])
    if (Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  }
  // "retry after 120" is seconds, like the HTTP header of the same name.
  const retryAfter = RETRY_AFTER.exec(text)
  if (retryAfter !== null) return now + Number(retryAfter[1]) * 1000
  const phrase = RESET_PHRASE.exec(text) ?? BARE_IN.exec(text)
  if (phrase === null) return undefined
  const span = duration(phrase[1]!)
  return span === undefined ? undefined : now + span
}

function duration(text: string): number | undefined {
  const units = [...text.matchAll(/(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi)]
  if (units.length === 0) return undefined
  return units.reduce((sum, unit) => sum + Number(unit[1]) * unitMs(unit[2]!), 0)
}

function unitMs(unit: string): number {
  const first = unit[0]!.toLowerCase()
  if (first === "h") return 60 * 60_000
  if (first === "m") return 60_000
  return 1000
}

/** "<HH:MM>" on the UTC clock. */
function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`
}

/** "in <h> h <m> min", the whole minutes between now and the reset. */
function relative(untilMs: number, now: number): string {
  const minutes = Math.max(0, Math.round((untilMs - now) / 60_000))
  return `in ${Math.floor(minutes / 60)} h ${minutes % 60} min`
}
