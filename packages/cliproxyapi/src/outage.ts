import type { SessionRetry } from "@opencode/plugin/effect/session"
import type { SessionError } from "@opencode/schema/session-error"

/**
 * How long a chat keeps retrying while CPA cannot answer: long enough for a CPA restart, including the
 * minutes before CT104's watch notices CPA is down or slow and restarts it.
 */
export const OUTAGE_RETRY_FOR = 30 * 60_000
/** The wait between those retries, once Core's own retries are used up. */
export const OUTAGE_RETRY_DELAY = 15_000
/**
 * The compaction decision's metadata mark for a step retried after an outage. Plus, which decides after this
 * plugin, then counts a cache that goes cold within a minute as cold, and compacts first.
 */
export const OUTAGE_MARK = "cpa.outage"
/**
 * How long a chat keeps retrying a provider that answers HTTP 500 or 529 (a model backend that is having a
 * bad few minutes) once Core's own retries are used up, without waiting thirty minutes on a dead provider.
 */
export const PROVIDER_ERROR_RETRY_FOR = 6 * 60_000
/** The first wait between those retries; each one doubles up to the cap. */
export const PROVIDER_ERROR_RETRY_DELAY = 15_000
export const PROVIDER_ERROR_RETRY_MAX_DELAY = 60_000

/** CPA explained a quota answer (its own protocol uses HTTP 500 for some of them). */
const QUOTA_CODE = /\bquota_[a-z_]+/

/** CPA, or the proxy in front of it, did not answer: refused, reset, timed out, or a 502/503/504. */
export function isOutage(error: SessionError.Error) {
  if (error.type === "provider.transport" || error.type === "provider.timeout") return true
  return error.type === "provider.internal" && (error.status === undefined || [502, 503, 504].includes(error.status))
}

/**
 * The provider answered, and answered badly: a plain HTTP 500 or 529. CPA's quota answers also arrive as a
 * 500, but they carry a `quota_*` code that the quota hook handles, so they are not this class.
 */
export function isProviderError(error: SessionError.Error) {
  if (error.type !== "provider.internal") return false
  if (error.status !== 500 && error.status !== 529) return false
  return ![error.message, error.response?.body ?? ""].some((text) => QUOTA_CODE.test(text))
}

/**
 * Per chat: when CPA stopped answering it, when its provider errors started, and whether its next decision
 * runs before a retry.
 */
export function createOutageRetry(now: () => number) {
  const since = new Map<string, number>()
  const extensions = new Map<string, number>()
  const retrying = new Set<string>()
  return {
    /** Keeps the step retrying through an outage or a provider error once Core's own retries are used up. */
    retry(event: Pick<SessionRetry, "sessionID" | "error" | "decision">) {
      if (isOutage(event.error)) return outage(event)
      if (isProviderError(event.error)) return providerError(event)
      since.delete(event.sessionID)
      extensions.delete(event.sessionID)
    },
    /** CPA answered the chat again. */
    answered(sessionID: string) {
      since.delete(sessionID)
      extensions.delete(sessionID)
    },
    /** Whether this compaction decision runs before a retry after an outage; true once per retry. */
    retried(sessionID: string) {
      return retrying.delete(sessionID)
    },
  }

  function outage(event: Pick<SessionRetry, "sessionID" | "error" | "decision">) {
    const start = since.get(event.sessionID) ?? now()
    since.set(event.sessionID, start)
    if (!event.decision.retry && now() - start < OUTAGE_RETRY_FOR)
      event.decision = { retry: true, delay: OUTAGE_RETRY_DELAY }
    if (event.decision.retry) retrying.add(event.sessionID)
  }

  // A provider error keeps Core's schedule for a while: 15 s, then 30 s, then a minute between tries.
  function providerError(event: Pick<SessionRetry, "sessionID" | "error" | "decision">) {
    const start = since.get(event.sessionID) ?? now()
    since.set(event.sessionID, start)
    if (!event.decision.retry && now() - start < PROVIDER_ERROR_RETRY_FOR) {
      const count = extensions.get(event.sessionID) ?? 0
      extensions.set(event.sessionID, count + 1)
      event.decision = {
        retry: true,
        delay: Math.min(PROVIDER_ERROR_RETRY_DELAY * 2 ** count, PROVIDER_ERROR_RETRY_MAX_DELAY),
      }
    }
    if (event.decision.retry) retrying.add(event.sessionID)
  }
}
