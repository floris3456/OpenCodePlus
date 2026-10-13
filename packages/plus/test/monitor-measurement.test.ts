// Synthetic observations, exercising production measurement/fold boundaries.
import { expect, test } from "bun:test"
import { foldSession, isMiss, windowedSessionSignals } from "../src/monitor/cache.js"
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

test("reported writes are measurements; incomplete numeric data is never invented as a hit", () => {
  const first = row("a", 10, usage(10000, 10000))
  const written = row("b", 20, { version: 1, completeness: "final", inputTokens: 12000, cacheWriteInputTokens: 12000 })
  expect(measurement(written).state).toBe("reported")
  expect(fold([first, written], [])[1]?.request).toMatchObject({ verdict: "miss", missTokens: 10000 })
  const incomplete = row("b", 20, { version: 1, completeness: "final", inputTokens: 12000, cacheWriteInputTokens: 1000 })
  expect(fold([first, incomplete], [])[1]?.request.verdict).toBe("unknown")
  const missing = row("b", 20, { version: 1, completeness: "final", inputTokens: 12000 })
  expect(fold([first, missing], [])[1]?.request.verdict).toBe("none")
})

test("changed fingerprints cannot hide a measured loss; the frontier is capped by current input", () => {
  const first = row("old", 10, usage(169496, 168832))
  const observations = [usage(15025, 0), usage(15025), usage(15025, 15025), undefined]
  const results = observations.map((observation) => fold([first, row("now", 20, observation)], [fp("old"), fp("now", "contracted prompt")])[1]!.request)
  expect(results.map((r) => r.measurement?.state)).toEqual(["reported", "reported", "reported", "legacy-unknown"])
  expect(results[0]?.measurement?.read).toBe(0)
  expect(results[1]?.measurement?.read).toBeUndefined()
  expect(results[2]?.measurement?.share).toBe(1)
  expect(results.map((r) => r.verdict)).toEqual(["miss", "unknown", "hit", "none"])
  expect(results.map((r) => r.missTokens)).toEqual([15025, 0, 0, 0])
})

test("compatible measured prefix with explicit zero retains supported shortfall detection", () => {
  const result = fold([row("a", 10, usage(10000, 10000)), row("b", 20, usage(11000, 0))], [fp("a"), fp("b")])[1]!.request
  expect(result).toMatchObject({ verdict: "miss", expected: 10000, missTokens: 10000 })
  expect(result.evidence).toContain("local shortfall estimate")
  const full = fold([row("a", 10, usage(168832, 168832)), row("b", 20, usage(15025, 15025))], [fp("a"), fp("b")])[1]!.request
  expect(full).toMatchObject({ verdict: "hit", expected: 15025, missTokens: 0 })
})

test("request links explain content but the latest completed lineage request supplies the frontier", () => {
  const result = fold([
    row("a", 10, usage(10000, 10000)), row("b", 20, usage(18000, 18000)), row("c", 30, usage(11000, 10000)),
  ], [fp("a"), fp("b", "B", "a"), fp("c", "C", "a")])[2]!
  expect(result.previous?.id).toBe("b")
  expect(result.request).toMatchObject({ verdict: "hit", expected: 11000, missTokens: 0 })
})

test("running first and post-compaction rows remain pending; positive reads are not cold", () => {
  const running = { ...row("running", 10, usage(1000, 0)), status: "running", ended: undefined }
  const result = foldSession([running], [{ id: 1, sessionID: "synthetic", at: 5, kind: "compaction" }], new Map()).analysis.details[0]!.request
  expect(result).toMatchObject({ verdict: "none", measurement: { state: "running" }, missTokens: 0 })
  expect(fold([row("first", 10, usage(1000, 1000))], [fp("first")])[0]!.request.verdict).toBe("cold")
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

test("warming is excluded from useful-work ratio; final usage on a failed request stays measurable", () => {
  const requests = fold([
    row("useful", 10, usage(1000, 100)),
    { ...row("ping", 20, usage(9000, 9000)), kind: "ping" },
    { ...row("failed", 30, usage(1000, 0)), status: "error" },
  ], []).map((d) => d.request)
  expect(reuseRate(requests)).toEqual({ hitRate: 0.05, measuredRequests: 2, unknownRequests: 0, measuredInput: 2000 })
  expect(requests[2]?.verdict).toBe("hit")
  expect(requests[2]?.outcome).toBe("error")
  expect(isMiss(requests[2]!)).toBe(false)
})

test("failed and incompatible pings receive no followed-by-hit credit", () => {
  for (const variant of ["failed", "model", "prefix", "compatible"]) {
    const ping = {
      ...row("ping", 10, usage(10000, 10000)), kind: "ping",
      ...(variant === "failed" ? { status: "error" } : {}),
      ...(variant === "model" ? { model: "different" } : {}),
    }
    const analyzed = foldSession([ping, row("next", 20, usage(10000, 10000))], [], new Map([
      ["ping", fp("ping")], ["next", fp("next", variant === "prefix" ? "different prefix" : "synthetic unchanged prompt")],
    ])).analysis
    expect(windowedSessionSignals(analyzed, { since: 0, until: 30 }).pings.followedByHit).toBe(variant === "compatible" || variant === "prefix" ? 1 : 0)
  }
})

test("interior marked equality cannot locate a whole-request measured read", () => {
  const marked = { role: "user", content: [{ type: "text", text: "small boundary", cache_control: { type: "ephemeral" } }] }
  const fingerprints = ["a", "b"].map((id) => ({
    requestID: id, sessionID: "synthetic", ...fingerprintWireBody({ messages: [marked, { role: "user", content: id.repeat(20000) }] }, { protocol: "anthropic-messages" }),
  }))
  const result = fold([row("a", 10, usage(12000, 10000)), row("b", 20, usage(3000, 0))], fingerprints)[1]!.request
  expect(result.expected).toBe(3000)
  expect(result.missTokens).toBe(3000)
  expect(isMiss(result)).toBe(true)
})

test("auxiliary requests cannot hide invalidating facts after the selected anchor", () => {
  for (const kind of ["account_switch", "quota_handoff", "compaction"]) {
    for (const auxiliary of [false, true]) {
      const rows = [row("a", 10, usage(10000, 10000)), ...(auxiliary ? [{ ...row("g", 20, usage(100, 0)), kind: "generate" }] : []), row("b", 30, usage(10000, 0))]
      const request = foldSession(rows, [{ id: 1, sessionID: "synthetic", at: 15, kind }], new Map([fp("a"), fp("b")].map((p) => [p.requestID, p]))).analysis.details.at(-1)!.request
      expect(request.expected).toBe(10000)
      expect(isMiss(request)).toBe(true)
    }
  }
})

test("partial components in a final envelope are not exact read shares or measured write anchors", () => {
  const read = row("read", 10, { ...usage(5000, 5000), provenance: { cacheReadInputTokens: { source: "derived", completeness: "partial" } } })
  expect(measurement(read)).toMatchObject({ state: "reported", input: 5000, write: 0 })
  expect(measurement(read).read).toBeUndefined()
  expect(measurement(read).share).toBeUndefined()
  expect(reuseRate(fold([read], []).map((d) => d.request)).measuredRequests).toBe(0)
  const write = row("a", 10, { ...usage(5000, 0, 5000), provenance: { cacheWriteInputTokens: { source: "derived", completeness: "partial" } } })
  const result = fold([write, row("b", 20, usage(5000, 0))], [fp("a"), fp("b")])[1]!.request
  expect(result.expected).toBeUndefined()
  expect(result.verdict).toBe("unknown")
  expect(isMiss(result)).toBe(false)
})
