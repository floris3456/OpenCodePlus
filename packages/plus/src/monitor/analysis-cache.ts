import { unreadFingerprintKeyWeight, type SessionFold } from "./cache.js"
import { unreadIndexWeight } from "./unread-index.js"
import type { RequestFingerprintData } from "./ledger.js"

// Serialized retained content is a deterministic budget, not a JS heap estimate.
// Sized for the existing 40k × 200-prefix qualification. Oversized individual
// histories do not displace all other Sessions merely to be discarded afterward.
export const ANALYSIS_CACHE_LIMIT = {
  sessions: 256,
  rows: 50_000,
  bytes: 2 * 1024 * 1024 * 1024,
  segments: 12_000_000,
} as const

export interface CachedSession {
  revision: string
  readonly mark: number
  readonly perRequest: boolean
  readonly fold: SessionFold
  readonly lastFrom?: number
}

type Limits = { readonly [K in keyof typeof ANALYSIS_CACHE_LIMIT]: number }
type Weight = { rows: number; bytes: number; segments: number }

/** Ledger-local LRU, bounded by rows, fingerprint segments and serialized content.
 * This is not a hard heap bound: JS containers and derived comparison caches
 * have runtime overhead, measured separately by the qualification workload.
 */
export class AnalysisCache {
  private readonly entries = new Map<string, { value: CachedSession; weight: Weight }>()
  private readonly sizes = new WeakMap<object, number>()
  private readonly retained: Weight = { rows: 0, bytes: 0, segments: 0 }

  constructor(private readonly limits: Limits = ANALYSIS_CACHE_LIMIT) {}

  /** Whether a fold is kept for the session, without moving it in the LRU. */
  has(id: string) {
    return this.entries.has(id)
  }

  get(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.entries.set(id, entry)
    return entry.value
  }

  stats() {
    return { sessions: this.entries.size, ...this.retained }
  }

  set(id: string, value: CachedSession) {
    const fold = value.fold
    const weight = {
      rows: fold.rows.length,
      bytes: 0,
      segments: 0,
    }
    this.remove(id)
    if (weight.rows > this.limits.rows) return
    // Sum small objects rather than serializing the whole fold (which would
    // invoke its legacy details getter). Fingerprint objects are charged once
    // below; read/write indexes refer to those same objects.
    for (const group of [fold.rows, fold.facts, fold.analysis.summaries, fold.analysis.unstable]) {
      for (const entry of group) {
        weight.bytes += this.bytes(entry)
        if (weight.bytes > this.limits.bytes) return
      }
    }
    for (const fp of fold.analysis.fingerprints.values()) {
      if (!fp) continue
      weight.bytes += this.fingerprintBytes(fp)
      // Do not memoize absent derived keys: a later completion can first need
      // them while retaining the same fingerprint object.
      weight.bytes += unreadFingerprintKeyWeight(fp)
      weight.segments += fp.messagePrefixes.length + fp.systemParts.length + fp.tools.length * 3 + Object.keys(fp.optionsKeys).length + (fp.cacheControl?.length ?? 0)
      if (weight.bytes > this.limits.bytes || weight.segments > this.limits.segments) return
    }
    // Resume streaks and write/read indexes are retained too. Their keys refer
    // to the derived-key arrays already charged with the fingerprint.
    for (const point of fold.resume) weight.bytes += this.bytes([...point.streaks]) + 32
    for (const group of [fold.analysis.writes, fold.analysis.reads]) {
      for (const entry of group) {
        const existing = this.sizes.get(entry)
        const bytes = existing ?? Buffer.byteLength(JSON.stringify({ ...entry, keys: undefined }), "utf8")
        if (existing === undefined) this.sizes.set(entry, bytes)
        weight.bytes += bytes
        if (weight.bytes > this.limits.bytes) return
      }
    }
    weight.bytes += this.bytes([...fold.names])
    weight.bytes += unreadIndexWeight(fold.analysis.unreadIndex).serializedBytes
    if (weight.bytes > this.limits.bytes || weight.segments > this.limits.segments) return
    this.entries.set(id, { value, weight })
    this.retained.rows += weight.rows
    this.retained.bytes += weight.bytes
    this.retained.segments += weight.segments
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.limits.sessions && this.retained.rows <= this.limits.rows &&
        this.retained.bytes <= this.limits.bytes && this.retained.segments <= this.limits.segments) break
      this.remove(key)
    }
  }

  private bytes(value: object) {
    const existing = this.sizes.get(value)
    if (existing !== undefined) return existing
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
    this.sizes.set(value, bytes)
    return bytes
  }

  private fingerprintBytes(fp: RequestFingerprintData) {
    const existing = this.sizes.get(fp)
    if (existing !== undefined) return existing
    // The exact full JSON size, without serializing the shared message records
    // for every delta-decoded row. Keep the original budget units/limits: this
    // does not discount shared parts or turn the byte budget into a heap claim.
    const bytes = Buffer.byteLength(JSON.stringify({ ...fp, messagePrefixes: [] }), "utf8") +
      fp.messagePrefixes.reduce((sum, part) => sum + this.bytes(part), 0) + Math.max(0, fp.messagePrefixes.length - 1)
    this.sizes.set(fp, bytes)
    return bytes
  }

  private remove(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.retained.rows -= entry.weight.rows
    this.retained.bytes -= entry.weight.bytes
    this.retained.segments -= entry.weight.segments
  }
}
