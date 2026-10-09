import type { MonitorRequest } from "../rpc.js"
import type { RequestRow } from "./ledger.js"
import type { RequestObservation } from "./observation.js"

/** Sparse invocation usage, separate from the zero-filled Session accounting view. */
export type UsageObservation = RequestObservation

export function measurement(row: RequestRow): NonNullable<MonitorRequest["measurement"]> {
  if (row.status === "running") return { state: "running" }
  const usage = row.observation
  if (!usage) return { state: "legacy-unknown" }
  if (usage.version !== 1) return { state: "unknown-version" }
  const input = usage.provenance?.inputTokens?.completeness === "partial" ? undefined : usage.inputTokens
  const read = usage.provenance?.cacheReadInputTokens?.completeness === "partial" ? undefined : usage.cacheReadInputTokens
  const write = usage.provenance?.cacheWriteInputTokens?.completeness === "partial" ? undefined : usage.cacheWriteInputTokens
  const values = [input, read, write, usage.nonCachedInputTokens, usage.outputTokens, usage.reasoningTokens]
  if (usage.inconsistent || values.some((n) => n !== undefined && (!Number.isFinite(n) || n < 0)) ||
    (input !== undefined && (read ?? 0) + (write ?? 0) > input)) return { state: "inconsistent" }
  return {
    ...(usage.scope === undefined ? {} : { scope: usage.scope }),
    ...(usage.invocationID === undefined ? {} : { invocationID: usage.invocationID }),
    ...(usage.operationID === undefined ? {} : { operationID: usage.operationID }),
    ...(usage.exchangeCount === undefined ? {} : { exchangeCount: usage.exchangeCount }),
    state: usage.completeness !== "final" || usage.provenance?.cacheReadInputTokens?.completeness === "partial"
      ? "unavailable" : read === undefined ? "not-reported" : "reported",
    ...(input === undefined ? {} : { input }),
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
    ...(usage.cacheWriteInputTokensByTTL === undefined ? {} : { writeByTTL: usage.cacheWriteInputTokensByTTL }),
    ...(usage.completeness === "final" && input !== undefined && input > 0 && read !== undefined ? { share: read / input } : {}),
  }
}

/** Same measured population in both sums; warming is not useful-work reuse. */
export function reuseRate(rows: readonly MonitorRequest[], legacy = 0) {
  const useful = rows.filter((row) => row.kind !== "ping" && row.measurement?.scope !== "exchange")
  const measured = useful.filter((row) => row.measurement?.state === "reported" && row.measurement.input !== undefined)
  const input = measured.reduce((sum, row) => sum + row.measurement!.input!, 0)
  const read = measured.reduce((sum, row) => sum + row.measurement!.read!, 0)
  return {
    ...(input > 0 ? { hitRate: read / input } : {}),
    measuredRequests: measured.length,
    unknownRequests: useful.length + legacy - measured.length,
    measuredInput: input,
  }
}
