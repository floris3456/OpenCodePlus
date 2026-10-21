/**
 * Pacer's answer about one chat's prompt cache (Pacer's client-protocol.md, "Per-chat cache warmth"),
 * read by the Pacer adapter with the chat's own capability. Plus consumes it, but this package must not
 * depend on Plus, so the adapter provides a reader here and Plus asks through `pacerCache`.
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

export interface PacerCacheQuery {
  readonly sessionID: string
  readonly providerID: string
  readonly modelID: string
  /** Epoch ms: an answer that arrived before this moment is read again. */
  readonly after?: number
}

type Reader = (query: PacerCacheQuery) => Promise<PacerCache | undefined>

const readers = new Set<Reader>()

/** Registers the adapter's reader; call the returned function when the adapter stops. */
export function providePacerCache(reader: Reader): () => void {
  readers.add(reader)
  return () => {
    readers.delete(reader)
  }
}

/** Pacer's answer for the chat, or undefined: no Pacer, a model it does not coordinate, or no answer. */
export function pacerCache(query: PacerCacheQuery): Promise<PacerCache | undefined> {
  const reader = [...readers].at(-1)
  if (reader === undefined) return Promise.resolve(undefined)
  return reader(query).catch(() => undefined)
}
