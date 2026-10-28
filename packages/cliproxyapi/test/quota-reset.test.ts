import { expect, test } from "bun:test"
import { QUOTA_RESET_UNKNOWN_MS, quotaReset } from "../src/quota-reset.js"

// A fixed clock, so every text below is the UTC line a settlement prints.
const now = Date.parse("2026-10-28T12:33:00Z")

function quota(message: string, status = 429, body?: string) {
  return quotaReset({ type: "provider.quota", message, status, ...(body === undefined ? {} : { response: { body } }) }, now)
}

test("a quota answer's reset reads from every form the providers use", () => {
  expect(quota("Quota exceeded. Your limit resets in 3h12m.")).toEqual({
    untilMs: Date.parse("2026-10-28T15:45:00Z"),
    text: "15:45 UTC (in 3 h 12 min)",
  })
  expect(quota("Usage limit reached; reset in 45m.")).toEqual({
    untilMs: Date.parse("2026-10-28T13:18:00Z"),
    text: "13:18 UTC (in 0 h 45 min)",
  })
  expect(quota("Insufficient quota: resets in 2 hours.")).toEqual({
    untilMs: Date.parse("2026-10-28T14:33:00Z"),
    text: "14:33 UTC (in 2 h 0 min)",
  })
  expect(quota("Quota exhausted. Try again in 90 seconds.")).toEqual({
    untilMs: now + 90_000,
    text: "12:34 UTC (in 0 h 2 min)",
  })
  expect(quota("Quota exceeded for this account: in 1h 5m 3s")).toEqual({
    untilMs: now + 3_900_000 + 3_000,
    text: "13:38 UTC (in 1 h 5 min)",
  })
  expect(quota("Quota exhausted. Your limit resets at 2026-10-28T15:45:00Z.")).toEqual({
    untilMs: Date.parse("2026-10-28T15:45:00Z"),
    text: "15:45 UTC (in 3 h 12 min)",
  })
  // CPA and friends put the reset in the answer body as unix seconds or ms.
  const seconds = 1_793_201_234
  expect(quota("Quota exceeded", 429, `{"error":"quota_exceeded","resets_at": ${seconds}}`)).toEqual({
    untilMs: seconds * 1000,
    text: clockText(seconds * 1000),
  })
  const millis = seconds * 1000
  expect(quota("Quota exceeded", 429, `{"resets_at": ${millis}}`)).toEqual({
    untilMs: millis,
    text: clockText(millis),
  })
  // "retry after 120" is seconds, like the HTTP header of that name.
  expect(quota("Quota exceeded for this key, retry after 120")).toEqual({
    untilMs: now + 120_000,
    text: "12:35 UTC (in 0 h 2 min)",
  })
})

test("a quota answer with no readable reset cools for fifteen minutes and says so", () => {
  const parsed = quota("Quota exceeded for this account.")
  expect(parsed?.untilMs).toBe(now + QUOTA_RESET_UNKNOWN_MS)
  expect(parsed?.text).toContain("reset time unknown")
  expect(parsed?.text.startsWith("12:48 UTC")).toBe(true)
})

test("a plain throttle, another status, or no quota word is not a quota reset", () => {
  expect(quota("Too many requests, slow down")).toBeUndefined()
  expect(quotaReset({ type: "provider.internal", message: "Quota exceeded. Resets in 1h.", status: 500 }, now)).toBeUndefined()
  expect(quotaReset({ type: "provider.rate-limit", message: "429 Too Many Requests", status: 429 }, now)).toBeUndefined()
  expect(quotaReset({ type: "provider.quota", message: "Your plan does not include this model." }, now)).toBeUndefined()
})

function clockText(at: number) {
  const date = new Date(at)
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC (in ${Math.floor(minutes / 60)} h ${minutes % 60} min)`
}
