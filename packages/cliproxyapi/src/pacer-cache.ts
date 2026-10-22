/**
 * Pacer's answers about one chat (Pacer's client-protocol.md, "Per-chat cache warmth" and the usage view's
 * `next_use`), read by the Pacer adapter with the chat's own capability. Plus consumes them, but this package
 * must not depend on Plus, so the adapter provides a reader here and Plus asks through `pacerCache` and
 * `pacerUsedUp`.
 */
export interface PacerCache {
  readonly warm: boolean
  /**
   * `confirmed`: the provider reported cache reads or writes on the chat's account, with the TTL sent;
   * `active`: one of its requests runs now; `assumed`: no evidence, Pacer's own guess.
   */
  readonly evidence: "active" | "confirmed" | "assumed"
  /** When the cache goes cold, on this process's clock (Pacer's own clock corrected by its `now_ms`). */
  readonly until?: number
  /** This process's clock when the answer arrived. */
  readonly at: number
}

/**
 * Pacer has decided the chat's account cannot serve its next step (a meter at its floor, or CPA no longer
 * offers the account): that step is a forced move to the other account Pacer names, after a compaction.
 */
export interface PacerUsedUp {
  /** When the account serves again (its meters at their floor reset), on this process's clock, if Pacer says. */
  readonly servesAt?: number
}

/** What one read of the chat's usage view says. */
export interface PacerChat {
  readonly cache?: PacerCache
  readonly usedUp?: PacerUsedUp
}

export interface PacerCacheQuery {
  readonly sessionID: string
  readonly providerID: string
  readonly modelID: string
  /** Epoch ms: an answer that arrived before this moment is read again. */
  readonly after?: number
}

type Reader = (query: PacerCacheQuery) => Promise<PacerChat | undefined>

const readers = new Set<Reader>()

/** Registers the adapter's reader; call the returned function when the adapter stops. */
export function providePacerChat(reader: Reader): () => void {
  readers.add(reader)
  return () => {
    readers.delete(reader)
  }
}

/** Pacer's answer for the chat's cache, or undefined: no Pacer, a model it does not coordinate, or no answer. */
export function pacerCache(query: PacerCacheQuery): Promise<PacerCache | undefined> {
  return pacerChat(query).then((chat) => chat?.cache)
}

/** Pacer's decision that the chat's account cannot serve its next step, or undefined (see `PacerUsedUp`). */
export function pacerUsedUp(query: PacerCacheQuery): Promise<PacerUsedUp | undefined> {
  return pacerChat(query).then((chat) => chat?.usedUp)
}

function pacerChat(query: PacerCacheQuery): Promise<PacerChat | undefined> {
  const reader = [...readers].at(-1)
  if (reader === undefined) return Promise.resolve(undefined)
  return reader(query).catch(() => undefined)
}
