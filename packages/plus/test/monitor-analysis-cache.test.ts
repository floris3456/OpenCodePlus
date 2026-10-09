import { afterEach, expect, test } from "bun:test"
import { AnalysisCache, ANALYSIS_CACHE_LIMIT } from "../src/monitor/analysis-cache.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { foldSession, unreadFingerprintKeyWeight } from "../src/monitor/cache.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

async function fixture() {
  const db = await ledger()
  db.requestStarted({ id: "synthetic", sessionID: "synthetic", kind: "step", started: 1 })
  const fold = foldSession(db.getRequests("synthetic"), [], new Map([
    ["synthetic", { requestID: "synthetic", sessionID: "synthetic", ...fingerprintWireBody({ input: [{ role: "user", content: "synthetic" }] }) }],
  ]))
  return { revision: "1", mark: 1, perRequest: false, fold }
}

test("serialized-content and segment budgets refuse oversize entries without evicting valid ones", async () => {
  const value = await fixture()
  const measured = new AnalysisCache()
  measured.set("s", value)
  const size = measured.stats()
  expect(size.bytes).toBeGreaterThan(0)
  expect(size.segments).toBeGreaterThan(0)
  expect(value.fold.analysis.work.details).toBe(0)
  for (const bound of ["bytes", "segments", "rows"] as const) {
    const exact = new AnalysisCache({ ...ANALYSIS_CACHE_LIMIT, [bound]: size[bound] })
    exact.set("s", value)
    expect(exact.get("s")).toBe(value)
    const refused = new AnalysisCache({ ...ANALYSIS_CACHE_LIMIT, [bound]: size[bound] - 1 })
    const empty = { ...value, fold: foldSession([], [], new Map()) }
    refused.set("empty", empty)
    refused.set("oversized", value)
    expect(refused.get("oversized")).toBeUndefined()
    expect(refused.get("empty")).toBe(empty)
    expect(refused.stats()[bound]).toBeLessThanOrEqual(size[bound] - 1)
    // Refusal changes caching only, not the computed production answer.
    expect(value.fold.analysis.detail("synthetic")?.request.id).toBe("synthetic")
  }
})

test("LRU eviction and replacement reconcile every accounted dimension", async () => {
  const value = await fixture()
  const measured = new AnalysisCache()
  measured.set("one", value)
  const size = measured.stats()
  for (const bound of ["bytes", "segments", "rows", "sessions"] as const) {
    const cache = new AnalysisCache({ ...ANALYSIS_CACHE_LIMIT, [bound]: size[bound] * 2 })
    cache.set("a", value)
    cache.set("b", value)
    expect(cache.get("a")).toBe(value) // Touch a; b is evicted next.
    cache.set("c", value)
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("a")).toBe(value)
    expect(cache.get("c")).toBe(value)
    expect(cache.stats()).toEqual({ sessions: 2, rows: size.rows * 2, bytes: size.bytes * 2, segments: size.segments * 2 })
    cache.set("c", value)
    expect(cache.stats()[bound]).toBe(size[bound] * 2)
  }
  expect(value.fold.analysis.work.details).toBe(0)
})

test("completion first creates derived keys on a retained fingerprint and is charged before admission", async () => {
  const value = await fixture()
  const fp = value.fold.analysis.fingerprints.get("synthetic")!
  const cache = new AnalysisCache()
  cache.set("s", value)
  const before = cache.stats().bytes
  expect(unreadFingerprintKeyWeight(fp)).toBe(0)
  const completed = { ...value, fold: foldSession(
    [{ ...value.fold.rows[0]!, status: "completed", cacheReadTokens: 100 }], [], value.fold.analysis.fingerprints,
  ) }
  cache.set("s", completed)
  expect(unreadFingerprintKeyWeight(fp)).toBeGreaterThan(0)
  expect(cache.stats().bytes).toBeGreaterThan(before)
  const bounded = new AnalysisCache({ ...ANALYSIS_CACHE_LIMIT, bytes: before })
  bounded.set("completed", completed)
  expect(bounded.get("completed")).toBeUndefined()
  expect(completed.fold.analysis.work.details).toBe(0)
})
