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

/** CPA, or the proxy in front of it, did not answer: refused, reset, timed out, or a 502/503/504. */
export function isOutage(error: SessionError.Error) {
  if (error.type === "provider.transport" || error.type === "provider.timeout") return true
  return error.type === "provider.internal" && (error.status === undefined || [502, 503, 504].includes(error.status))
}

/** Per chat: when CPA stopped answering it, and whether its next decision runs before a retry. */
export function createOutageRetry(now: () => number) {
  const since = new Map<string, number>()
  const retrying = new Set<string>()
  return {
    /** Keeps the step retrying through an outage once Core's own retries are used up. */
    retry(event: Pick<SessionRetry, "sessionID" | "error" | "decision">) {
      if (!isOutage(event.error)) {
        since.delete(event.sessionID)
        return
      }
      const start = since.get(event.sessionID) ?? now()
      since.set(event.sessionID, start)
      if (!event.decision.retry && now() - start < OUTAGE_RETRY_FOR)
        event.decision = { retry: true, delay: OUTAGE_RETRY_DELAY }
      if (event.decision.retry) retrying.add(event.sessionID)
    },
    /** CPA answered the chat again. */
    answered(sessionID: string) {
      since.delete(sessionID)
    },
    /** Whether this compaction decision runs before a retry after an outage; true once per retry. */
    retried(sessionID: string) {
      return retrying.delete(sessionID)
    },
  }
}
