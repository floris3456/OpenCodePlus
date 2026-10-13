import type { RequestRow } from "./ledger.js"
import type { RequestSummary } from "./cache.js"
import { measurement } from "./measurement.js"

/** Independent corpus rule: don't trust the analyzer's chosen anchor or cause. */
export function auditCacheMisses(rows: readonly RequestRow[], summaries: readonly RequestSummary[]) {
  const verdicts = new Map(summaries.map((s) => [s.request.id, s.request.verdict]))
  return rows.flatMap((row, index) => {
    const previous = rows.slice(0, index).filter((p) => p.sessionID === row.sessionID && p.provider === row.provider && p.model === row.model &&
      p.observation?.historyEpoch === row.observation?.historyEpoch && p.status === "completed" && p.ended !== undefined && p.ended <= row.started && !p.isTitle)
      .reduce<RequestRow | undefined>((latest, p) => !latest || p.ended! > latest.ended! ? p : latest, undefined)
    const measured = measurement(row)
    const predecessor = previous && measurement(previous)
    if (measured.state !== "reported" || predecessor?.state !== "reported" || measured.input === undefined || measured.read === undefined || measured.write === undefined || predecessor.input === undefined || predecessor.read === undefined || predecessor.write === undefined) return []
    const shortfall = Math.min(predecessor.read + predecessor.write, measured.input) - measured.read
    const verdict = verdicts.get(row.id)
    return measured.input >= predecessor.input && measured.read < measured.input * 0.5 && shortfall >= 4096 && (verdict === "hit" || verdict === "none" || verdict === "unknown")
      ? [{ requestID: row.id, verdict, shortfall }] : []
  })
}
