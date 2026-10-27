import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

test.each(["none", "error", "running"] as const)("compaction facts cannot hide measured misses after %s", async (status) => {
  const db = await ledger()
  db.session({ id: "synthetic" }, 1)
  for (const [id, at, input, read] of [
    ["before", 10, 239004, 238592],
    ["compacted", 30, 81720, 2176],
    ["warm", 40, 81814, 81536],
    ["miss", 50, 81814, 0],
  ] as const) {
    db.requestStarted({ id, sessionID: "synthetic", started: at, kind: "step", model: "fixture", provider: "fixture" })
    db.requestEnded(id, { ended: at + 1, status: "completed" })
    db.requestObserved(id, { version: 1, completeness: "final", inputTokens: input, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
    db.requestFingerprint({ requestID: id, sessionID: "synthetic", ...fingerprintWireBody({ input: id === "before" ? "old context" : "compacted context" }, { protocol: "openai-responses" }) })
  }
  if (status !== "none") {
    db.requestStarted({ id: "retry", sessionID: "synthetic", started: 25, kind: "step", model: "fixture", provider: "fixture" })
    if (status === "error") db.requestEnded("retry", { ended: 26, status })
  }
  db.contextFact({ sessionID: "synthetic", at: 20, kind: "compaction" })
  const report = queryMonitor(db, { scope: "session", sessionID: "synthetic", view: "cache" }, { now: 100 })
  expect(report.requests?.map((request) => request.verdict)).toEqual(["cold", ...(status === "none" ? [] : [status === "error" ? "error" : "none"] as const), "partial", "hit", "miss"])
  expect(report.requests?.find((request) => request.id === "compacted")).toMatchObject({ missTokens: 79544, measurement: { read: 2176 } })
  expect(queryMonitor(db, { scope: "session", sessionID: "synthetic", view: "cache", id: "compacted" }, { now: 100 }).detail?.request.verdict).toBe("partial")
  expect(report.totals.misses).toBe(2)
  expect(report.totals.missTokens).toBe(79544 + 81536)
  const misses = queryMonitor(db, { scope: "session", sessionID: "synthetic", view: "cache", missesOnly: true }, { now: 100 })
  expect(misses.requests?.map((r) => r.id)).toEqual(["compacted", "miss"])
  expect(misses.totals).toEqual(report.totals)
})

test("persisted explicit, missing and legacy reads stay distinct through report/RPC population", async () => {
  const db = await ledger()
  db.session({ id: "synthetic" }, 1)
  for (const [id, at] of [["measured", 1], ["missing", 3], ["legacy", 5]] as const) {
    db.requestStarted({ id, sessionID: "synthetic", started: at, kind: "step" })
    db.requestEnded(id, { ended: at + 1, status: "completed", usage: { input: 0, output: 0, reasoning: 0, cacheRead: 100, cacheWrite: 900, cost: 0 } })
  }
  db.requestObserved("measured", { version: 1, completeness: "final", inputTokens: 1000, cacheReadInputTokens: 100, cacheWriteInputTokens: 900 })
  db.requestObserved("missing", { version: 1, completeness: "final", inputTokens: 1000 })
  const report = queryMonitor(db, { scope: "session", sessionID: "synthetic", view: "cache" }, { now: 10 })
  expect(report.totals).toMatchObject({ hitRate: 0.1, measuredRequests: 1, unknownRequests: 2, measuredInput: 1000 })
  expect(report.requests?.map((r) => r.measurement?.state)).toEqual(["reported", "not-reported", "legacy-unknown"])
  expect(report.totals.cacheRead).toBe(300) // Accounting stays untouched, not reused as measurement.
  expect(queryMonitor(db, { scope: "session", sessionID: "synthetic", view: "sessions" }, { now: 10 }).sessions?.[0]?.hitRate).toBe(0.1)
})

test("persisted explicit zero alerts survive late fingerprint corrections and append stays incremental", async () => {
  const db = await ledger()
  db.session({ id: "synthetic" }, 1)
  const fingerprint = (id: string, text: string) => db.requestFingerprint({
    requestID: id, sessionID: "synthetic", ...fingerprintWireBody({ input: text }, { protocol: "openai-responses" }),
  })
  const add = (id: string, at: number, read: number) => {
    db.requestStarted({ id, sessionID: "synthetic", started: at, kind: "step", model: "fixture", provider: "fixture" })
    db.requestEnded(id, { ended: at + 1, status: "completed" })
    db.requestObserved(id, { version: 1, completeness: "final", inputTokens: 10000, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
    fingerprint(id, "synthetic same wire")
  }
  add("a", 10, 10000)
  add("b", 20, 0)
  const query = () => queryMonitor(db, { scope: "session", sessionID: "synthetic", view: "cache" }, { now: 100 })
  expect(query().requests?.[1]).toMatchObject({ verdict: "miss", missTokens: 10000 })
  const saved = () => db.db.query<{ request_id: string }, []>("select request_id from cache_result order by request_id").all().map((row) => row.request_id)
  add("c", 30, 10000)
  // Appending leaves the saved results before it alone.
  expect(saved()).toEqual(["a", "b"])
  query()
  expect(saved()).toEqual(["a", "b", "c"])
  fingerprint("b", "synthetic corrected final request")
  // A correction drops what it can affect, from b on.
  expect(saved()).toEqual(["a"])
  expect(query().requests?.[1]).toMatchObject({ verdict: "miss", missTokens: 10000 })
})
