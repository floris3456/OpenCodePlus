import { expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import type { SessionError } from "@opencode/schema/session-error"
import { OUTAGE_RETRY_DELAY, OUTAGE_RETRY_FOR, createOutageRetry, isOutage } from "../src/outage.js"

const sessionID = Session.ID.make("ses_outage")
const refused = { type: "provider.transport", message: "Unable to connect. Is the computer able to access the url?" }
const gateway = { type: "provider.internal", message: "Bad Gateway", status: 502 }

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
