import type { MonitorPage, MonitorQueryInput } from "../rpc.js"
import type { SessionAnalysis } from "./cache.js"

const revisions = new WeakMap<object, string>()
const currentDetail: {
  value?: { analysis: WeakRef<SessionAnalysis>; id: string; detail: NonNullable<ReturnType<SessionAnalysis["detail"]>> }
} = {}
export const CURRENT_DETAIL_BYTES = 128 * 1024

/** One bounded current drill-down, not a second per-Session analysis cache.
 * A new analysis object (correction/fingerprint/fact fold) invalidates it. */
export function requestDetail(analysis: SessionAnalysis, id: string) {
  const cached = currentDetail.value
  if (cached?.analysis.deref() === analysis && cached.id === id) return cached.detail
  const detail = analysis.detail(id)
  currentDetail.value =
    detail && Buffer.byteLength(JSON.stringify(detail), "utf8") <= CURRENT_DETAIL_BYTES
      ? { analysis: new WeakRef(analysis), id, detail }
      : undefined
  return detail
}

/** Ordered collection pages. Immutable detail arrays reuse their content revision;
 * changed populations refuse the stale offset by visibly resetting to page one. */
export function reportPage<T>(
  rows: readonly T[],
  input: NonNullable<MonitorQueryInput["pages"]>["sessions"],
  defaultLimit = 100,
) {
  const known = revisions.get(rows)
  const revision = known ?? new Bun.CryptoHasher("sha256").update(JSON.stringify(rows)).digest("hex")
  if (!known) revisions.set(rows, revision)
  const metadata = reportPageBounds(rows.length, revision, input, defaultLimit)
  return { rows: rows.slice(metadata.offset, metadata.offset + metadata.limit), metadata }
}

/** Same continuation contract for an indexed SQL collection without loading it. */
export function reportPageBounds(
  total: number,
  revision: string,
  input: NonNullable<MonitorQueryInput["pages"]>["sessions"],
  defaultLimit = 100,
) {
  const limit = Number.isFinite(input?.limit) ? Math.max(1, Math.min(500, Math.floor(input!.limit!))) : defaultLimit
  const reset = input?.cursor !== undefined && input.cursor.revision !== revision
  const offset =
    reset || !Number.isFinite(input?.cursor?.offset)
      ? 0
      : Math.max(0, Math.min(total, Math.floor(input!.cursor!.offset)))
  const returned = Math.min(limit, total - offset)
  const metadata: MonitorPage = {
    total,
    returned,
    offset,
    revision,
    limit,
    complete: returned === total,
    reset,
    ...(offset + returned < total ? { next: { offset: offset + returned, revision } } : {}),
    ...(offset > 0 ? { previous: { offset: Math.max(0, offset - limit), revision } } : {}),
  }
  return metadata
}
