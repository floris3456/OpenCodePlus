import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { createLedger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { sessionFold } from "../src/monitor/report.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

test("polling folds only summaries; requested detail expands exactly one row without changing totals", async () => {
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
  const analysis = sessionFold(db, "synthetic").analysis
  expect(analysis.work.details).toBe(0)
  for (const view of ["overview", "cache", "steps", "sessions"] as const) queryMonitor(db, { ...query, view }, { now: 300 })
  expect(analysis.work.details).toBe(0)
  expect(analysis.summaries.every((row) => !Object.hasOwn(row, "lines") && !Object.hasOwn(row, "segments") && !Object.hasOwn(row, "pings"))).toBe(true)
  const selected = queryMonitor(db, { ...query, id: "r10" }, { now: 300 })
  expect(analysis.work.details).toBe(1)
  expect(selected.totals).toEqual(first.totals)
  expect(selected.detail?.request.id).toBe("r10")
  expect(selected.detail?.segments[0]?.before?.hash).toBeDefined()
  expect(selected.detail?.lines.length).toBeGreaterThan(0)
  queryMonitor(db, { ...query, id: "not-present" }, { now: 300 })
  queryMonitor(db, { ...query, id: "r10", since: 150 }, { now: 300 })
  expect(analysis.work.details).toBe(1) // Missing and excluded IDs never expand.
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
