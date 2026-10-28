import { expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import type { SessionError } from "@opencode/schema/session-error"
import {
  OUTAGE_RETRY_DELAY,
  OUTAGE_RETRY_FOR,
  PROVIDER_ERROR_RETRY_FOR,
  createOutageRetry,
  isOutage,
  isProviderError,
} from "../src/outage.js"

const sessionID = Session.ID.make("ses_outage")
const refused = { type: "provider.transport", message: "Unable to connect. Is the computer able to access the url?" }
const gateway = { type: "provider.internal", message: "Bad Gateway", status: 502 }
const providerDown = { type: "provider.internal", message: "An unexpected error occurred.", status: 500 }

test("refused, reset, timed-out and 502/503/504 requests are an outage; a 500, a 429 or a 400 are not", () => {
  expect([refused, gateway, { type: "provider.timeout", message: "" }, { type: "provider.internal", message: "" }].map(isOutage)).toEqual([
    true,
    true,
    true,
    true,
  ])
  expect(
    [
      { type: "provider.internal", message: "quota_budget_wait: wait", status: 500 },
      { type: "provider.rate-limit", message: "", status: 429 },
      { type: "provider.invalid-request", message: "", status: 400 },
    ].map(isOutage),
  ).toEqual([false, false, false])
})

test("an outage keeps the step retrying once Core's retries are used up, for thirty minutes", () => {
  const clock = { now: 0 }
  const outage = createOutageRetry(() => clock.now)
  // Core's own retries are left as they are, and mark the next decision as one before a retry.
  const scheduled = { sessionID, error: refused, decision: { retry: true as const, delay: 2_000 } }
  outage.retry(scheduled)
  expect(scheduled.decision).toEqual({ retry: true, delay: 2_000 })
  expect(outage.retried(sessionID)).toBe(true)
  expect(outage.retried(sessionID)).toBe(false)

  clock.now = 90_000
  const usedUp: Parameters<typeof outage.retry>[0] = { sessionID, error: gateway, decision: { retry: false } }
  outage.retry(usedUp)
  expect(usedUp.decision).toEqual({ retry: true, delay: OUTAGE_RETRY_DELAY })
  expect(outage.retried(sessionID)).toBe(true)

  clock.now = OUTAGE_RETRY_FOR
  const late: Parameters<typeof outage.retry>[0] = { sessionID, error: refused, decision: { retry: false } }
  outage.retry(late)
  expect(late.decision).toEqual({ retry: false })
  expect(outage.retried(sessionID)).toBe(false)
})

test("an answer or another error starts the next outage's thirty minutes afresh", () => {
  const clock = { now: 0 }
  const outage = createOutageRetry(() => clock.now)
  const fail = (error: SessionError.Error = refused): Parameters<typeof outage.retry>[0] => {
    const event: Parameters<typeof outage.retry>[0] = { sessionID, error, decision: { retry: false } }
    outage.retry(event)
    return event
  }
  fail()
  clock.now = OUTAGE_RETRY_FOR - 1
  outage.answered(sessionID)
  clock.now += 10 * 60_000
  expect(fail().decision.retry).toBe(true)

  // A refusal that is not an outage is left to Core and the quota hook, and ends the outage.
  const refusal = fail({ type: "provider.invalid-request", message: "quota_compact_required: move", status: 409 })
  expect(refusal.decision).toEqual({ retry: false })
  clock.now += OUTAGE_RETRY_FOR - 1
  expect(fail().decision.retry).toBe(true)
})

test("a plain 500 or 529 is a provider error; a quota answer, a 400, a 429 or a 502 is not", () => {
  expect(
    [
      providerDown,
      { type: "provider.internal", message: "Service overloaded", status: 529 },
    ].map(isProviderError),
  ).toEqual([true, true])
  expect(
    [
      { type: "provider.internal", message: "quota_budget_wait: wait", status: 500 },
      { type: "provider.internal", message: "Internal error", status: 500, response: { body: "quota_compact_required" } },
      { type: "provider.invalid-request", message: "", status: 400 },
      { type: "provider.rate-limit", message: "", status: 429 },
      gateway,
    ].map(isProviderError),
  ).toEqual([false, false, false, false, false])
})

test("a 500 keeps the step retrying for six minutes once Core's retries are used up, backing off to a minute", () => {
  const clock = { now: 90_000 }
  const outage = createOutageRetry(() => clock.now)
  const fail = (): Parameters<typeof outage.retry>[0] => {
    const event: Parameters<typeof outage.retry>[0] = { sessionID, error: providerDown, decision: { retry: false } }
    outage.retry(event)
    return event
  }

  // Core still has retries of its own: its decision, and its delay, stand.
  const scheduled = { sessionID, error: providerDown, decision: { retry: true as const, delay: 2_000 } }
  outage.retry(scheduled)
  expect(scheduled.decision).toEqual({ retry: true, delay: 2_000 })
  expect(outage.retried(sessionID)).toBe(true)

  expect(fail().decision).toEqual({ retry: true, delay: 15_000 })
  expect(outage.retried(sessionID)).toBe(true)
  clock.now += 30_000
  expect(fail().decision).toEqual({ retry: true, delay: 30_000 })
  expect(outage.retried(sessionID)).toBe(true)
  clock.now += 30_000
  expect(fail().decision).toEqual({ retry: true, delay: 60_000 })
  expect(outage.retried(sessionID)).toBe(true)
  clock.now += 60_000
  expect(fail().decision).toEqual({ retry: true, delay: 60_000 })
  expect(outage.retried(sessionID)).toBe(true)

  // Six minutes after the first failure, the step fails for good.
  clock.now = 90_000 + PROVIDER_ERROR_RETRY_FOR
  expect(fail().decision).toEqual({ retry: false })
  expect(outage.retried(sessionID)).toBe(false)
})

test("a 400 is left to Core and the quota hook at once", () => {
  const outage = createOutageRetry(() => 0)
  const bad: Parameters<typeof outage.retry>[0] = {
    sessionID,
    error: { type: "provider.invalid-request", message: "Bad Request", status: 400 },
    decision: { retry: false },
  }
  outage.retry(bad)
  expect(bad.decision).toEqual({ retry: false })
  expect(outage.retried(sessionID)).toBe(false)
})

test("a quota 429 resetting hours out ends the step even when Core said retry", () => {
  const clock = { now: Date.parse("2026-10-28T12:33:00Z") }
  const outage = createOutageRetry(() => clock.now)
  const scheduled: Parameters<typeof outage.retry>[0] = {
    sessionID,
    error: { type: "provider.quota", message: "Quota exceeded. Your limit resets in 3h12m.", status: 429 },
    decision: { retry: true, delay: 2_000 },
  }
  outage.retry(scheduled)
  expect(scheduled.decision).toEqual({ retry: false })
  expect(outage.retried(sessionID)).toBe(false)

  // The same for a plain 429 that still names a quota and its reset.
  const throttled: Parameters<typeof outage.retry>[0] = {
    sessionID,
    error: { type: "provider.rate-limit", message: "429 Too Many Requests. Quota exhausted, retry after 3600", status: 429 },
    decision: { retry: true, delay: 84_000 },
  }
  outage.retry(throttled)
  expect(throttled.decision).toEqual({ retry: false })
})

test("a quota 429 resetting within two minutes keeps Core's decision", () => {
  const clock = { now: Date.parse("2026-10-28T12:33:00Z") }
  const outage = createOutageRetry(() => clock.now)
  const soon: Parameters<typeof outage.retry>[0] = {
    sessionID,
    error: { type: "provider.quota", message: "Quota exceeded for a moment, resets in 60s.", status: 429 },
    decision: { retry: true, delay: 2_000 },
  }
  outage.retry(soon)
  expect(soon.decision).toEqual({ retry: true, delay: 2_000 })

  // And a plain throttle with no quota word is untouched either way.
  const throttle: Parameters<typeof outage.retry>[0] = {
    sessionID,
    error: { type: "provider.rate-limit", message: "Too many requests, slow down", status: 429 },
    decision: { retry: false },
  }
  outage.retry(throttle)
  expect(throttle.decision).toEqual({ retry: false })
})

test("an answer resets a provider error's six minutes and its backoff", () => {
  const clock = { now: 0 }
  const outage = createOutageRetry(() => clock.now)
  const fail = (): Parameters<typeof outage.retry>[0] => {
    const event: Parameters<typeof outage.retry>[0] = { sessionID, error: providerDown, decision: { retry: false } }
    outage.retry(event)
    return event
  }

  expect(fail().decision).toEqual({ retry: true, delay: 15_000 })
  clock.now += 15_000
  expect(fail().decision).toEqual({ retry: true, delay: 30_000 })

  outage.answered(sessionID)
  clock.now += PROVIDER_ERROR_RETRY_FOR - 1
  expect(fail().decision).toEqual({ retry: true, delay: 15_000 })
})
