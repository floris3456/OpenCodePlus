import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { Observation, readObservation } from "../src/monitor/observation.js"
import { createLedger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { MonitorReport } from "../src/rpc.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

test("TTL allowlist preserves zero/missing and strips unknown buckets and private fields on disk", async () => {
  const db = await ledger()
  db.requestStarted({ id: "sparse", sessionID: "s", kind: "step", started: 0 })
  db.requestEnded("sparse", { ended: 1, status: "completed" })
  const payload = {
    version: 1 as const,
    completeness: "final" as const,
    cacheWriteInputTokens: 900,
    cacheWriteInputTokensByTTL: { "5m": 0, "24h": 900, auth: "PRIVATE_AUTH" },
    provenance: {
      cacheWriteInputTokensByTTL: {
        "5m": { source: "reported" as const, completeness: "complete" as const },
        secret: "PRIVATE_META",
      },
    },
  }
  db.requestObserved("sparse", payload)
  const reopened = createLedger(db.path)
  try {
    expect(reopened.getRequest("sparse")?.observation?.cacheWriteInputTokensByTTL).toEqual({ "5m": 0 })
    expect(reopened.getRequest("sparse")?.observation?.cacheWriteInputTokensByTTL?.["1h"]).toBeUndefined()
    expect(JSON.stringify(reopened.db.query("select observation from request").all())).not.toContain("PRIVATE")
    expect(JSON.stringify(reopened.db.query("select observation from request").all())).not.toContain("24h")
    const report = Schema.decodeUnknownSync(MonitorReport)(queryMonitor(reopened, { scope: "session", sessionID: "s", view: "cache", id: "sparse" }, { now: 10 }))
    expect(report.requests?.[0]?.measurement?.writeByTTL).toEqual({ "5m": 0 })
    expect(report.detail?.request.measurement?.writeByTTL?.["1h"]).toBeUndefined()
    expect(JSON.stringify(report)).not.toContain("PRIVATE")
    expect(report.totals.missCost).toBeUndefined()
  } finally {
    reopened.close()
  }
})

test("negative/nonfinite/type-invalid buckets refuse writes; inconsistent/partial detail is not made complete", async () => {
  const db = await ledger()
  db.requestStarted({ id: "invalid", sessionID: "s", kind: "step", started: 0 })
  db.requestEnded("invalid", { ended: 1, status: "completed" })
  for (const bucket of [-1, Infinity, NaN]) {
    expect(() =>
      db.requestObserved("invalid", {
        version: 1,
        completeness: "final",
        cacheWriteInputTokensByTTL: { "5m": bucket },
      }),
    ).toThrow()
    expect(db.getRequest("invalid")?.observation).toBeUndefined()
  }
  const decode = Schema.decodeUnknownSync(Observation)
  for (const bucket of [-1, Infinity, NaN, "PRIVATE_INVALID"]) {
    expect(() => decode({ version: 1, completeness: "final", cacheWriteInputTokensByTTL: { "5m": bucket } })).toThrow()
  }
  expect(
    readObservation(
      JSON.stringify({
        version: 1,
        completeness: "final",
        cacheWriteInputTokens: 10,
        cacheWriteInputTokensByTTL: { "5m": 11 },
      }),
    ).inconsistent,
  ).toBe(true)
  expect(
    readObservation(
      JSON.stringify({
        version: 1,
        completeness: "final",
        cacheWriteInputTokens: 10,
        cacheWriteInputTokensByTTL: { "5m": 5, "1h": 4 },
      }),
    ).inconsistent,
  ).toBe(true)
  expect(
    readObservation(
      JSON.stringify({
        version: 1,
        completeness: "partial",
        cacheWriteInputTokensByTTL: { "5m": 5 },
        provenance: { cacheWriteInputTokensByTTL: { "5m": { source: "reported", completeness: "partial" } } },
      }),
    ).inconsistent,
  ).toBe(true)
})
