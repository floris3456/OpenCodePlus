// The Monitor on a long chat: a generated Anthropic session of about 1,500
// requests and 1,500 messages (monitor-golden-fixture.ts). Its verdicts were
// recorded from the Monitor before the 1.1.18 speed-up, which took about 70 s
// for this chat; they must not change, and the chat must load in seconds.
// The analysis cache must answer a repeat at no cost, ignore other chats'
// writes, and fold a change in this chat incrementally to the same result a
// cold analysis gives.
import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { analyzeSession } from "../src/monitor/cache.js"
import { createLedger, type Ledger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import type { MonitorQueryInput } from "../src/rpc.js"
import golden from "./fixtures/monitor-golden-anthropic.json"
import { GOLDEN_SESSION, writeGoldenSession } from "./monitor-golden-fixture.js"

const NOW = 1_800_000_000_000
const cache: MonitorQueryInput = { scope: "session", sessionID: GOLDEN_SESSION, view: "cache" }
let dir = ""
let file = ""
let db: Ledger

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-golden-"))
  file = path.join(dir, "monitor.db")
  db = createLedger(file)
  writeGoldenSession(db)
})

afterAll(async () => {
  db.close()
  await fs.rm(dir, { recursive: true, force: true })
})

// Counts the ledger reads one session's analysis makes.
function counted(ledger: Ledger) {
  const reads = { requests: 0, fingerprints: 0, fingerprint: 0 }
  const wrapped: Ledger = {
    ...ledger,
    getRequests: (id) => {
      if (id === GOLDEN_SESSION) reads.requests++
      return ledger.getRequests(id)
    },
    getFingerprints: (id) => {
      reads.fingerprints++
      return ledger.getFingerprints(id)
    },
    getFingerprint: (id) => {
      reads.fingerprint++
      return ledger.getFingerprint(id)
    },
  }
  return { ledger: wrapped, reads, reset: () => Object.assign(reads, { requests: 0, fingerprints: 0, fingerprint: 0 }) }
}

// The same query through a second handle, whose analysis cache is cold.
function cold(input: MonitorQueryInput) {
  const fresh = createLedger(file)
  const report = queryMonitor(fresh, input, { now: NOW })
  fresh.close()
  return JSON.parse(JSON.stringify(report))
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

test("a long Anthropic chat keeps the verdicts recorded before the speed-up and loads in seconds", () => {
  const fresh = createLedger(file)
  const started = performance.now()
  const report = queryMonitor(fresh, cache, { now: NOW })
  const coldMs = performance.now() - started
  fresh.close()

  // The query leaves out the title request (row 0), as when it was recorded.
  expect(report.requests?.map((r): unknown[] => [r.verdict, r.cause ?? null, r.expected ?? null, r.missTokens])).toEqual(
    golden.rows.slice(1).map((row) => row.slice(0, 4)),
  )
  expect({
    misses: report.totals.misses,
    missTokens: report.totals.missTokens,
    missCost: report.totals.missCost ?? null,
    hitRate: report.totals.hitRate,
  }).toEqual(golden.totals)
  const details = analyzeSession(db, db.getRequests(GOLDEN_SESSION), db.getContextFacts(GOLDEN_SESSION)).details
  expect(
    details.map((d): unknown[] => [d.request.verdict, d.request.cause ?? null, d.request.expected ?? null, d.request.missTokens, d.timing.gapMs ?? null]),
  ).toEqual(golden.rows)
  // Recorded at about 70 s before the speed-up; about 0.4 s after it. The bound leaves room for a slow machine.
  expect(golden.recorded.queryMs).toBeGreaterThan(30_000)
  expect(coldMs).toBeLessThan(10_000)
}, 120_000)

test("a repeat costs nothing, other chats' writes are ignored, and a change folds incrementally", () => {
  const probe = counted(db)
  const first = queryMonitor(probe.ledger, cache, { now: NOW })
  expect(probe.reads).toEqual({ requests: 1, fingerprints: 1, fingerprint: 0 })

  // Nothing changed: nothing is read again.
  probe.reset()
  const started = performance.now()
  expect(plain(queryMonitor(probe.ledger, cache, { now: NOW }))).toEqual(plain(first))
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(probe.reads).toEqual({ requests: 0, fingerprints: 0, fingerprint: 0 })

  // Another chat writes: this chat's analysis stands.
  db.requestStarted({ id: "other-1", sessionID: "ses_other", kind: "step", started: NOW - 10_000 })
  db.requestFingerprint({ ...db.getFingerprint(`${GOLDEN_SESSION}-00010`)!, requestID: "other-1", sessionID: "ses_other" })
  db.contextFact({ sessionID: "ses_other", at: NOW - 10_000, kind: "warming", detail: { state: "on" } })
  probe.reset()
  expect(plain(queryMonitor(probe.ledger, cache, { now: NOW }))).toEqual(plain(first))
  expect(probe.reads).toEqual({ requests: 0, fingerprints: 0, fingerprint: 0 })

  // The running step completes and a new one starts: only its fingerprint is loaded.
  const rows = db.getRequests(GOLDEN_SESSION)
  const running = rows.at(-1)!
  db.requestEnded(running.id, {
    ended: running.started + 4_000,
    status: "completed",
    usage: { input: 3, output: 300, reasoning: 0, cacheRead: 400_000, cacheWrite: 2_000, cost: 0.2 },
  })
  const next = `${GOLDEN_SESSION}-next`
  db.requestStarted({ id: next, sessionID: GOLDEN_SESSION, kind: "step", agent: "build", provider: "cliproxyapi", model: "claude-opus-5-5", variant: "xhigh", started: running.started + 10_000 })
  db.requestFingerprint({ ...db.getFingerprint(running.id)!, requestID: next, created: running.started + 10_000 })
  probe.reset()
  const appended = plain(queryMonitor(probe.ledger, cache, { now: NOW }))
  expect(probe.reads).toEqual({ requests: 1, fingerprints: 0, fingerprint: 1 })
  expect(appended.requests.at(-2).verdict).not.toBe("none")
  expect(appended).toEqual(cold(cache))

  // Changes deep in the history: a corrected early fingerprint and a fact back
  // in time. The fold resumes there and still matches a cold analysis.
  const early = rows[200]!
  db.requestFingerprint({ ...db.getFingerprint(early.id)!, optionsKeys: { max_tokens: "changed" } })
  db.contextFact({ sessionID: GOLDEN_SESSION, at: rows[600]!.started - 1, kind: "account_switch", detail: { from: "Large", to: "Small" } })
  probe.reset()
  for (const view of ["cache", "overview"] as const) {
    expect(plain(queryMonitor(probe.ledger, { ...cache, view }, { now: NOW }))).toEqual(cold({ ...cache, view }))
  }
  expect(probe.reads).toEqual({ requests: 1, fingerprints: 0, fingerprint: 1 })

  // Another process (here a second connection) completes a request of this chat.
  const other = createLedger(file)
  other.requestEnded(next, {
    ended: running.started + 14_000,
    status: "completed",
    usage: { input: 3, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 402_000, cost: 0.4 },
  })
  other.close()
  const completed = plain(queryMonitor(probe.ledger, cache, { now: NOW }))
  expect(completed.requests.at(-1).verdict).toBe("miss")
  expect(completed).toEqual(cold(cache))
}, 120_000)
