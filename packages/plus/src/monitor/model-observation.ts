import type { SessionModelObserved } from "@opencode/plugin/effect/session"
import type { Ledger } from "./ledger.js"

/** No temporal joins and no Session aggregates. Multiple exchanges share one invocation usage row. */
export function recordModelObservation(ledger: Ledger, event: SessionModelObserved, directory?: string) {
  const kind = event.purpose === "warming" ? "ping" : event.kind === "primary" ? "step" : event.kind
  const status = event.outcome === "failed" ? "error" : event.outcome === "cancelled" ? "cancelled" : "completed"
  ledger.session({ id: event.sessionID, directory }, event.ended)
  const start = {
    sessionID: event.sessionID,
    kind,
    agent: event.agent,
    provider: event.model.providerID,
    model: event.model.id,
    variant: event.model.variant,
    messageID: event.messageID,
    isTitle: event.kind === "title",
  }
  const single = event.exchangeCount === 1 && event.exchanges.length === 1 ? event.exchanges[0] : undefined
  const id = single?.requestID ?? event.invocationID
  ledger.db.transaction(() => {
    if (ledger.getRequest(id)?.observation) return
    if (!single)
      event.exchanges.forEach((exchange) => {
        ledger.requestStarted({ ...start, id: exchange.requestID, started: exchange.started })
        ledger.requestEnded(exchange.requestID, {
          ended: event.ended,
          status: exchange.outcome === "failed" ? "error" : "unknown",
          messageID: event.messageID,
          usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        })
        ledger.requestObserved(exchange.requestID, {
          version: 1,
          completeness: "unavailable",
          scope: "exchange",
          invocationID: event.invocationID,
          operationID: event.operationID,
          compaction: event.compaction,
        })
      })
    ledger.requestStarted({ ...start, id, started: single?.started ?? event.started })
    ledger.requestEnded(id, {
      ended: event.ended,
      status,
      messageID: event.messageID,
      usage: event.accounting
        ? {
            input: event.accounting.tokens.input,
            output: event.accounting.tokens.output,
            reasoning: event.accounting.tokens.reasoning,
            cacheRead: event.accounting.tokens.cache.read,
            cacheWrite: event.accounting.tokens.cache.write,
            cost: event.accounting.cost ?? 0,
          }
        : undefined,
    })
    ledger.requestObserved(id, {
      ...event.usage,
      scope: "invocation",
      invocationID: event.invocationID,
      operationID: event.operationID,
      exchangeCount: event.exchangeCount,
      compaction: event.compaction,
    })
    // A final HTTP response identifies the effective fingerprint; an unacknowledged WS frame does not.
    const response = !single ? event.exchanges.findLast((exchange) => exchange.outcome === "response") : undefined
    const fingerprint = response ? ledger.getFingerprint(response.requestID) : undefined
    if (fingerprint) ledger.requestFingerprint({ ...fingerprint, requestID: id })
    if (event.exchangeCount !== event.exchanges.length)
      ledger.contextFact({
        sessionID: event.sessionID,
        at: event.ended,
        kind: "observation_gap",
        detail: { code: "exchange-limit", invocationID: event.invocationID },
      })
  })()
}
