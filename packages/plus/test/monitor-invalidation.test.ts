import { afterEach, expect, spyOn, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { createLedger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { ANALYSIS_CACHE_LIMIT, sessionFoldResumeFrom } from "../src/monitor/report.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

test("late first fingerprint and correction match a fresh handle, including cross-handle writes", async () => {
  const db = await ledger()
  for (const [id, started] of [["a", 10], ["b", 20]] as const) {
    db.session({ id: "synthetic" }, started)
    db.requestStarted({ id, sessionID: "synthetic", started, kind: "step", provider: "fixture", model: "fixture" })
    db.requestEnded(id, { status: "completed", ended: started + 1 })
  }
  const query = () => queryMonitor(db, { scope: "session", sessionID: "synthetic", view: "cache", id: "b" }, { now: 100 })
  expect(query().detail?.segments).toEqual([])
  const other = createLedger(db.db.filename)
  try {
    for (const [id, text] of [["a", "first"], ["b", "changed"]]) {
      other.requestFingerprint({ requestID: id!, sessionID: "synthetic", ...fingerprintWireBody({ input: text }, { protocol: "openai-responses" }) })
    }
    // Array input is understood by both fingerprint versions; the later
    // version also covers string input in the separate fingerprint controls.
    other.requestFingerprint({ requestID: "a", sessionID: "synthetic", ...fingerprintWireBody({ input: [{ role: "user", content: "first" }] }, { protocol: "openai-responses" }) })
    other.requestFingerprint({ requestID: "b", sessionID: "synthetic", ...fingerprintWireBody({ input: [{ role: "user", content: "changed" }] }, { protocol: "openai-responses" }) })
    expect(query().detail?.segments.length).toBeGreaterThan(0)
    expect(query()).toEqual(queryMonitor(other, { scope: "session", sessionID: "synthetic", view: "cache", id: "b" }, { now: 100 }))
    expect(sessionFoldResumeFrom(db, "synthetic")).toBe(0)
    other.requestFingerprint({ requestID: "b", sessionID: "synthetic", ...fingerprintWireBody({ input: [{ role: "user", content: "first" }] }, { protocol: "openai-responses" }) })
    const fresh = createLedger(db.db.filename)
    try {
      expect(query()).toEqual(queryMonitor(fresh, { scope: "session", sessionID: "synthetic", view: "cache", id: "b" }, { now: 100 }))
      expect(query().detail?.segments).toEqual([])
      expect(sessionFoldResumeFrom(db, "synthetic")).toBe(1)
    } finally { fresh.close() }
  } finally { other.close() }
})

test("historical context cutoff cannot read the future post-compaction request", async () => {
  const db = await ledger()
  db.session({ id: "synthetic" }, 1)
  db.contextFact({ sessionID: "synthetic", at: 20, kind: "compaction" })
  db.requestStarted({ id: "future", sessionID: "synthetic", kind: "step", started: 40 })
  const report = queryMonitor(db, { scope: "session", sessionID: "synthetic", view: "overview", until: 30 }, { now: 100 })
  expect(report.context?.[0]).not.toHaveProperty("atCompaction")
})

test("narrow window reads only relevant histories but retains predecessor context", async () => {
  const db = await ledger()
  for (const session of ["old-a", "old-b", "selected"]) {
    db.session({ id: session }, 1)
    db.requestStarted({ id: session, sessionID: session, kind: "step", started: 1 })
    db.requestEnded(session, { status: "completed", ended: 2 })
  }
  db.requestStarted({ id: "recent", sessionID: "selected", kind: "step", started: 20 })
  const reads = spyOn(db, "getRequests")
  const report = queryMonitor(db, { scope: "all", view: "cache", since: 10 }, { now: 30 })
  expect(reads.mock.calls).toEqual([["selected"]])
  expect(reads.mock.results[0]?.value).toHaveLength(2)
  expect(report.requests?.map((r) => r.id)).toEqual(["recent"])
  reads.mockRestore()
})

test("analysis retention is bounded and eviction changes work, not query results", async () => {
  const db = await ledger()
  const query = (sessionID: string) => queryMonitor(db, { scope: "session", sessionID, view: "cache" }, { now: 100 })
  for (let i = 0; i <= ANALYSIS_CACHE_LIMIT.sessions; i++) {
    db.requestStarted({ id: `r${i}`, sessionID: `s${i}`, kind: "step", started: 1 })
    query(`s${i}`)
  }
  expect(sessionFoldResumeFrom(db, "s0")).toBeUndefined()
  const reads = spyOn(db, "getRequests")
  const first = query("s0")
  expect(reads).toHaveBeenCalledTimes(1)
  expect(query("s0")).toEqual(first)
  expect(reads).toHaveBeenCalledTimes(1)
  reads.mockRestore()
})
