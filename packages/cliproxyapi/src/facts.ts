/**
 * Quota facts (account switches and handoff progress) are produced by the
 * quota controller while the CLIProxyAPI plugin is active. The Plus monitor
 * consumes them, but the plugin must not depend on Plus, so it publishes them
 * through this registry and the monitor subscribes when Plus activates.
 */
export interface QuotaFact {
  readonly sessionID: string
  readonly kind: string
  readonly detail?: Record<string, unknown>
  readonly at: number
}

const listeners = new Set<(fact: QuotaFact) => void>()

/** Subscribes to quota facts; call the returned function to unsubscribe. */
export function onQuotaFact(listener: (fact: QuotaFact) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Publishes one fact to every subscriber. */
export function emitQuotaFact(fact: QuotaFact): void {
  for (const listener of [...listeners]) listener(fact)
}
