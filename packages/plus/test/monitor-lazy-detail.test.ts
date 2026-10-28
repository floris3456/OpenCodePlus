import { afterEach, expect, spyOn, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { createLedger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { sessionCacheStats } from "../src/monitor/report.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

test("polling reads saved summaries; a requested detail expands exactly that row without changing totals", async () => {
  const db = await ledger()
  db.session({ id: "synthetic" }, 1)
  for (let i = 0; i < 20; i++) {
    const id = `r${i}`
    db.requestStarted({ id, sessionID: "synthetic", kind: "step", started: i * 10 })
    db.requestEnded(id, { status: "completed", ended: i * 10 + 1 })
    db.requestFingerprint({ requestID: id, sessionID: "synthetic", ...fingerprintWireBody({ input: `synthetic ${i}` }) })
  }
  const query = { scope: "session" as const, sessionID: "synthetic", view: "cache" as const }
  const first = queryMonitor(db, query, { now: 300 })
  for (const view of ["overview", "cache", "steps", "sessions"] as const) queryMonitor(db, { ...query, view }, { now: 300 })
  // No poll folds the session's history, and returned rows are summaries only.
  expect(sessionCacheStats(db).sessions).toBe(0)
  expect(first.requests?.every((row) => !Object.hasOwn(row, "lines") && !Object.hasOwn(row, "segments") && !Object.hasOwn(row, "pings"))).toBe(true)
  const reads = spyOn(db, "getRequestsBetween")
  const selected = queryMonitor(db, { ...query, id: "r10" }, { now: 300 })
  expect(reads.mock.calls.length).toBe(1)
  reads.mockRestore()
  expect(selected.totals).toEqual(first.totals)
  expect(selected.detail?.request.id).toBe("r10")
  expect(selected.detail?.segments[0]?.before?.hash).toBeDefined()
  expect(selected.detail?.lines.length).toBeGreaterThan(0)
  // Missing and excluded IDs never expand.
  expect(queryMonitor(db, { ...query, id: "not-present" }, { now: 300 }).detail).toBeUndefined()
  expect(queryMonitor(db, { ...query, id: "r10", since: 150 }, { now: 300 }).detail).toBeUndefined()
  expect(sessionCacheStats(db).sessions).toBe(0)
})

test("late cross-handle correction invalidates lazy detail and equals a fresh production fold", async () => {
  const db = await ledger()
  for (const [id, started] of [["a", 1], ["b", 3]] as const) {
    db.requestStarted({ id, sessionID: "synthetic", kind: "step", started })
    db.requestEnded(id, { status: "completed", ended: started + 1 })
  }
  const query = { scope: "session" as const, sessionID: "synthetic", view: "cache" as const, id: "b" }
  expect(queryMonitor(db, query, { now: 10 }).detail?.segments).toEqual([])
  const other = createLedger(db.db.filename)
  try {
    for (const id of ["a", "b"]) other.requestFingerprint({ requestID: id, sessionID: "synthetic", ...fingerprintWireBody({ input: id }) })
    const changed = queryMonitor(db, query, { now: 10 })
    expect(changed.detail?.segments.length).toBeGreaterThan(0)
    expect(changed).toEqual(queryMonitor(other, query, { now: 10 }))
    other.requestFingerprint({ requestID: "b", sessionID: "synthetic", ...fingerprintWireBody({ input: "a" }) })
    expect(queryMonitor(db, query, { now: 10 }).detail?.segments).toEqual([])
    expect(queryMonitor(db, query, { now: 10 })).toEqual(queryMonitor(other, query, { now: 10 }))
  } finally { other.close() }
})
