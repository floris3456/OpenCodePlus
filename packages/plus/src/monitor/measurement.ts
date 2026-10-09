import type { MonitorRequest } from "../rpc.js"
import type { RequestRow } from "./ledger.js"

/** Sparse invocation usage, separate from the zero-filled Session accounting view. */
export interface UsageObservation {
  readonly version: number
  readonly completeness: "final" | "partial" | "unavailable"
  /** Present only for a complete inclusive total, never a partial component sum. */
  readonly inputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly nonCachedInputTokens?: number
  readonly outputTokens?: number
  readonly reasoningTokens?: number
}

export function measurement(row: RequestRow & { readonly observation?: UsageObservation }): NonNullable<MonitorRequest["measurement"]> {
  if (row.status === "running") return { state: "running" }
  const usage = row.observation
  if (!usage) return { state: "legacy-unknown" }
  if (usage.version !== 1) return { state: "unknown-version" }
  const input = usage.inputTokens
  const read = usage.cacheReadInputTokens
  const write = usage.cacheWriteInputTokens
  const values = [input, read, write, usage.nonCachedInputTokens, usage.outputTokens, usage.reasoningTokens]
  if (values.some((n) => n !== undefined && (!Number.isFinite(n) || n < 0)) ||
    (input !== undefined && (read ?? 0) + (write ?? 0) > input)) return { state: "inconsistent" }
  return {
    state: usage.completeness !== "final" ? "unavailable" : read === undefined ? "not-reported" : "reported",
    ...(input === undefined ? {} : { input }),
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
    ...(usage.completeness === "final" && input !== undefined && input > 0 && read !== undefined ? { share: read / input } : {}),
  }
}

/** Same measured population in both sums; warming is not useful-work reuse. */
export function reuseRate(rows: readonly MonitorRequest[], legacy = 0) {
  const useful = rows.filter((row) => row.kind !== "ping")
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
