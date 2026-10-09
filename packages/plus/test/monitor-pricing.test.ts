import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { MonitorReport } from "../src/rpc.js"
import { fingerprintWireBody, sha256 } from "../src/monitor/fingerprint.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

async function fixture() {
  const db = await ledger()
  db.session({ id: "pricing" }, 1)
  const add = (id: string, at: number, read: number, options: { write?: number; variant?: string; legacy?: boolean; partial?: boolean; missingWrite?: boolean; total?: number } = {}) => {
    db.requestStarted({ id, sessionID: "pricing", started: at, kind: "step", provider: "fixture", model: "fixture", ...(options.variant ? { variant: options.variant } : {}) })
    db.requestEnded(id, { ended: at + 1, status: "completed", usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 7, reasoning: 0, cost: 0.42 } })
    if (!options.legacy) db.requestObserved(id, { version: 1, completeness: "final", ...(options.partial ? {} : { inputTokens: options.total ?? 10000 }), cacheReadInputTokens: read, ...(options.missingWrite ? {} : { cacheWriteInputTokens: options.write ?? 0 }) })
    db.requestFingerprint({ requestID: id, sessionID: "pricing", ...fingerprintWireBody({ input: "same synthetic wire", ...(id === "anchor" ? {} : { previous_response_id: "anchor-response" }) }, { protocol: "openai-responses" }), ...(id === "anchor" ? { responseId: sha256("anchor-response") } : {}) })
  }
  const price = (at: number, rates: object[], extra: object = {}) => db.contextFact({ sessionID: "pricing", at, kind: "pricing", detail: { provider: "fixture", model: "fixture", rates, ...extra } })
  const query = (id?: string) => queryMonitor(db, { scope: "session", sessionID: "pricing", view: "cache", ...(id ? { id } : {}) }, { now: 100 })
  return { db, add, price, query }
}

test("unknown shortfall and absent rates are not free; explicit zero rates are priced", async () => {
  const f = await fixture()
  f.add("anchor", 10, 10000)
  f.add("missing-price", 20, 0)
  f.add("legacy", 30, 0, { legacy: true })
  expect(f.query().requests?.[0]).toMatchObject({ missCost: 0, pricing: { state: "zero-shortfall", shortfall: 0 } })
  expect(f.query().requests?.[1]?.missCost).toBeUndefined()
  expect(f.query().requests?.[1]?.pricing?.state).toBe("unpriced")
  expect(f.query().requests?.[2]?.missCost).toBeUndefined()
  expect(f.query().requests?.[2]?.pricing?.state).toBe("unknown-shortfall")
  f.price(35, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
  f.add("free", 40, 0)
  expect(f.query().requests?.[3]).toMatchObject({ missCost: 0, pricing: { state: "priced", rates: { input: 0, read: 0, write: 0 } } })
  expect(f.query().totals.missCost).toBeUndefined()
  expect(f.query().totals.pricingCoverage).toMatchObject({ requests: 4, priced: 1, zeroShortfall: 1, unpriced: 1, unknownShortfall: 1, complete: false, subsetScenarioCost: 0 })
  expect(Schema.decodeUnknownSync(MonitorReport)(f.query()).totals.cost).toBe(1.68)
})

test("inclusive measured input selects tier; shortfall differential uses input/write minus read, not output", async () => {
  const f = await fixture()
  f.price(1, [{ input: 2, output: 999, cache: { read: 0.5, write: 3 } }, { tier: { type: "context", size: 5000 }, input: 6, output: 999, cache: { read: 1, write: 8 } }])
  f.add("anchor", 10, 10000)
  f.add("fresh", 20, 0)
  f.add("written", 30, 0, { write: 4000 })
  const report = f.query("written")
  expect(report.requests?.[1]?.missCost).toBe(0.05)
  expect(report.detail?.request).toMatchObject({ missCost: 0.058, output: 7, cost: 0.42, pricing: { state: "priced", factAt: 1, source: "recorded-model-rates", tierAbove: 5000, inputBasis: "inclusive-measured", rates: { input: 6, read: 1, write: 8 } } })
  expect(report.totals).toMatchObject({ cost: 1.26, pricingCoverage: { complete: true, priced: 2, zeroShortfall: 1 } })
  expect(report.totals.missCost).toBeCloseTo(0.108)
  expect(report.detail?.lines.join(" ")).toContain("not billed loss or net savings")
})

test("variant mismatch, partial legacy input and unsupported duration pricing refuse estimates", async () => {
  const f = await fixture()
  f.price(1, [{ input: 2, output: 3, cache: { read: 0.5, write: 3 } }])
  f.add("anchor", 10, 10000, { variant: "priority" })
  f.add("variant", 20, 0, { variant: "priority" })
  f.add("partial", 30, 0, { partial: true })
  expect(f.query().requests?.[1]?.pricing).toMatchObject({ state: "unpriced", reason: "Recorded rates do not identify the request variant" })
  expect(f.query().requests?.[2]?.pricing?.state).toBe("unknown-shortfall")
  f.price(35, [{ input: 2, output: 3, cache: { read: 0.5, write: 3 } }], { mixedTTL: true, variant: "priority" })
  f.add("mixed", 40, 0, { write: 1000, variant: "priority" })
  expect(f.query("mixed").detail?.request.pricing).toMatchObject({ state: "unpriced", reason: "Write-duration pricing is unsupported" })
  expect(f.query().totals.missCost).toBeUndefined()
})

test("missing cache read rate is not zero; empty pricing population has no complete total", async () => {
  const f = await fixture()
  expect(f.query().totals.missCost).toBeUndefined()
  expect(f.query().totals.pricingCoverage?.complete).toBe(false)
  f.price(1, [{ input: 2, output: 3, cache: { write: 3 } }])
  f.add("anchor", 10, 10000)
  f.add("missing-read-price", 20, 0)
  expect(f.query().requests?.[1]?.pricing?.state).toBe("unpriced")
  expect(f.query().requests?.[1]?.missCost).toBeUndefined()
})

test("priced subset is visible but incomplete; all-current-input reuse proves zero without an anchor", async () => {
  const f = await fixture()
  f.add("anchor", 10, 10000)
  f.add("unknown-price", 20, 0)
  f.price(25, [{ input: 2, output: 3, cache: { read: 0.5, write: 3 } }])
  f.add("priced", 30, 0)
  f.add("full", 40, 15025, { total: 15025 })
  f.db.requestFingerprint({ requestID: "full", sessionID: "pricing", ...fingerprintWireBody({ input: "different contracted current request" }, { protocol: "openai-responses" }) })
  expect(f.query("full").detail?.request).toMatchObject({ missCost: 0, missTokens: 0, pricing: { state: "zero-shortfall", shortfall: 0 } })
  expect(f.query("full").detail?.request.expected).toBeUndefined()
  expect(f.query().totals.pricingCoverage).toMatchObject({ complete: false, priced: 1, unpriced: 1, zeroShortfall: 2, subsetScenarioCost: 0.015 })
  expect(f.query().totals.missCost).toBeUndefined()
})

test("historical 168832 reads cannot turn contracted fully cached 15025 input into a loss", async () => {
  const f = await fixture()
  f.add("anchor", 10, 168832, { total: 168832 })
  f.add("contracted", 20, 15025, { total: 15025 })
  f.db.requestFingerprint({ requestID: "contracted", sessionID: "pricing", ...fingerprintWireBody({ input: "contracted new instructions and tools" }, { protocol: "openai-responses" }) })
  expect(f.query("contracted").detail?.request).toMatchObject({ missTokens: 0, missCost: 0, pricing: { state: "zero-shortfall", shortfall: 0 } })
  expect(f.query("contracted").detail?.request.expected).toBeUndefined()
})

test("zero input proves zero scenario; missing write measurement refuses a positive scenario", async () => {
  const f = await fixture()
  f.price(1, [{ input: 2, output: 3, cache: { read: 0.5, write: 3 } }])
  f.add("anchor", 10, 10000)
  f.add("no-write", 20, 0, { missingWrite: true })
  expect(f.query().requests?.[1]?.pricing).toMatchObject({ state: "unpriced", reason: "Complete cache-write measurement unavailable" })
  f.add("empty", 30, 0, { total: 0 })
  expect(f.query().requests?.[2]).toMatchObject({ missCost: 0, pricing: { state: "zero-shortfall", shortfall: 0 } })
})
