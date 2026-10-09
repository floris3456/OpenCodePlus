import type { MonitorReport } from "../rpc.js"

export const QUERY_CACHE_LIMIT = { entries: 32, bytes: 8 * 1024 * 1024 } as const

export interface QueryBoundary {
  readonly until: number
  readonly nextData: number
  readonly nextExpiry: number
}

interface Entry {
  readonly revision: string
  readonly bounds: readonly QueryBoundary[]
  readonly report: MonitorReport
  readonly bytes: number
}

/** Bounded, ledger-local read snapshots. Time advancement is safe only while
 * neither an exclusive data cutoff nor an inclusive expiry cutoff is crossed.
 * Serialized-content accounting is not an engine heap measurement.
 */
export class QueryCache {
  private readonly entries = new Map<string, Entry>()
  private bytes = 0
  private hits = 0
  private misses = 0

  constructor(private readonly limits: { entries: number; bytes: number } = QUERY_CACHE_LIMIT) {}

  get(key: string, revision: string, untils: readonly number[]) {
    const entry = this.entries.get(key)
    if (
      !entry ||
      entry.revision !== revision ||
      untils.some((until, index) => {
        const bound = entry.bounds[index]!
        return until !== bound.until && (until < bound.until || until > bound.nextData || until >= bound.nextExpiry)
      })
    ) {
      this.misses++
      if (entry) this.remove(key)
      return
    }
    this.hits++
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.report
  }

  set(key: string, revision: string, bounds: readonly QueryBoundary[], report: MonitorReport) {
    this.remove(key)
    const bytes = Buffer.byteLength(JSON.stringify([key, bounds, report]), "utf8")
    if (bytes > this.limits.bytes || this.limits.entries < 1) return
    this.entries.set(key, { revision, bounds, report, bytes })
    this.bytes += bytes
    for (const id of this.entries.keys()) {
      if (this.entries.size <= this.limits.entries && this.bytes <= this.limits.bytes) break
      this.remove(id)
    }
  }

  stats() {
    return { entries: this.entries.size, bytes: this.bytes, hits: this.hits, misses: this.misses }
  }

  private remove(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.bytes -= entry.bytes
  }
}
