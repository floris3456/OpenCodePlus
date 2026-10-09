// Synthetic observations, exercising production measurement/fold boundaries.
import { expect, test } from "bun:test"
import { foldSession, isMiss } from "../src/monitor/cache.js"
import { fingerprintWireBody, sha256 } from "../src/monitor/fingerprint.js"
import type { RequestFingerprintData, RequestRow } from "../src/monitor/ledger.js"
import { measurement, reuseRate, type UsageObservation } from "../src/monitor/measurement.js"

function row(id: string, at: number, observation?: UsageObservation): RequestRow & { observation?: UsageObservation } {
  return {
    id, sessionID: "synthetic", kind: "step", isTitle: false, started: at, ended: at + 1, created: at,
    status: "completed", provider: "synthetic", model: "fixture", agent: "build",
    inputTokens: 15025, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    reasoningTokens: 0, cost: 0, ...(observation ? { observation } : {}),
  }
}
const usage = (input: number, read?: number, write = 0): UsageObservation => ({
  version: 1, completeness: "final", inputTokens: input, cacheReadInputTokens: read, cacheWriteInputTokens: write,
})
function fp(id: string, text = "synthetic unchanged prompt", previous?: string): RequestFingerprintData {
  return {
    requestID: id, sessionID: "synthetic",
    ...fingerprintWireBody({ input: [{ role: "user", content: text }], ...(previous ? { previous_response_id: previous } : {}) }, { protocol: "openai-responses" }),
    responseId: sha256(id),
  }
}
const fold = (rows: RequestRow[], fps: RequestFingerprintData[]) => foldSession(rows, [], new Map(fps.map((p) => [p.requestID, p]))).analysis.details

test("168832 historical read cannot manufacture loss in a changed 15025 input request", () => {
  const first = row("old", 10, usage(169496, 168832))
  const observations = [usage(15025, 0), usage(15025), usage(15025, 15025), undefined]
  const results = observations.map((observation) => fold([first, row("now", 20, observation)], [fp("old"), fp("now", "contracted prompt")])[1]!.request)
  expect(results.map((r) => r.measurement?.state)).toEqual(["reported", "not-reported", "reported", "legacy-unknown"])
  expect(results[0]?.measurement?.read).toBe(0)
  expect(results[1]?.measurement?.read).toBeUndefined()
  expect(results[2]?.measurement?.share).toBe(1)
  for (const result of results) {
    expect(result.expected).toBeUndefined()
    expect(result.missTokens).toBe(0)
    expect(isMiss(result)).toBe(false)
    expect(result.confidence).toBe("unknown")
  }
})

test("compatible measured prefix with explicit zero retains supported shortfall detection", () => {
  const result = fold([row("a", 10, usage(10000, 10000)), row("b", 20, usage(11000, 0))], [fp("a"), fp("b")])[1]!.request
  expect(result).toMatchObject({ verdict: "miss", expected: 10000, missTokens: 10000 })
  expect(result.evidence).toContain("local shortfall estimate")
  const full = fold([row("a", 10, usage(168832, 168832)), row("b", 20, usage(15025, 15025))], [fp("a"), fp("b")])[1]!.request
  expect(full).toMatchObject({ verdict: "hit", expected: 15025, missTokens: 0 })
})

test("branch A→C uses A, never B's larger read count", () => {
  const result = fold([
    row("a", 10, usage(10000, 10000)), row("b", 20, usage(18000, 18000)), row("c", 30, usage(11000, 10000)),
  ], [fp("a"), fp("b", "B", "a"), fp("c", "C", "a")])[2]!
  expect(result.previous?.id).toBe("a")
  expect(result.request).toMatchObject({ verdict: "hit", expected: 10000, missTokens: 0 })
})

test("running first and post-compaction rows remain pending; positive reads are not cold", () => {
  const running = { ...row("running", 10, usage(1000, 0)), status: "running", ended: undefined }
  const result = foldSession([running], [{ id: 1, sessionID: "synthetic", at: 5, kind: "compaction" }], new Map()).analysis.details[0]!.request
  expect(result).toMatchObject({ verdict: "none", measurement: { state: "running" }, missTokens: 0 })
  expect(fold([row("first", 10, usage(1000, 1000))], [fp("first")])[0]!.request.verdict).toBe("hit")
})

test("inclusive measured population: read100 + write900 is10%; zero and missing denominators unavailable", () => {
  const requests = fold([row("r", 10, usage(1000, 100, 900)), row("unknown", 20)], []).map((d) => d.request)
  expect(reuseRate(requests)).toEqual({ hitRate: 0.1, measuredRequests: 1, unknownRequests: 1, measuredInput: 1000 })
  expect(reuseRate([]).hitRate).toBeUndefined()
  expect(reuseRate(fold([row("z", 10, usage(0, 0))], []).map((d) => d.request)).hitRate).toBeUndefined()
  const partial = row("partial", 10, { version: 1, completeness: "final", nonCachedInputTokens: 100, cacheReadInputTokens: 0 })
  expect(measurement(partial)).not.toHaveProperty("input")
  expect(reuseRate(fold([partial], []).map((d) => d.request))).toMatchObject({ measuredRequests: 0, unknownRequests: 1 })
})

test("legacy, unknown version, invalid metrics, partial usage and overlap cannot support anomalies", () => {
  for (const observation of [undefined, { ...usage(1000, 0), version: 999 }, usage(1000, 2000), usage(1000, -1), { ...usage(1000, 0), completeness: "partial" as const }]) {
    const result = fold([row("a", 10, usage(10000, 10000)), row("b", 20, observation)], [fp("a"), fp("b")])[1]!.request
    expect(isMiss(result)).toBe(false)
    expect(result.missTokens).toBe(0)
  }
  const overlapping = { ...row("a", 10, usage(10000, 10000)), ended: 30 }
  expect(fold([overlapping, row("b", 20, usage(10000, 0))], [fp("a"), fp("b")])[1]!.request.expected).toBeUndefined()
})
