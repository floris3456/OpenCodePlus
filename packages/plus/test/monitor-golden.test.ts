// The Monitor on a long chat: a generated Anthropic session of about 1,500
// requests and 1,500 messages (monitor-golden-fixture.ts). Old confident verdicts
// were not provider truth: this legacy fixture cannot establish sparse field
// presence. Accounting, deterministic folding and the speed gates still stand.
// Reports read saved results: a repeat costs nothing, other chats' writes leave
// this chat's results alone, and a change in this chat drops only the results
// it can affect, saved again to what a cold analysis gives.
import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { analyzeSession } from "../src/monitor/cache.js"
import { createLedger, type Ledger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import type { MonitorQueryInput } from "../src/rpc.js"
import golden from "./fixtures/monitor-golden-anthropic.json"
import { saveAll } from "./monitor-fixture.js"
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
  saveAll(db)
})

afterAll(async () => {
  db.close()
  await fs.rm(dir, { recursive: true, force: true })
})

// Counts the ledger reads this chat's analysis makes: whole histories, the
// rows of ranged reads, and single fingerprints.
function counted(ledger: Ledger) {
  const zero = { requests: 0, fingerprints: 0, ranged: 0, fingerprint: 0, requestRows: 0, factRows: 0 }
  const reads = { ...zero }
  const wrapped: Ledger = {
    ...ledger,
    getRequests: (id) => {
      if (id === GOLDEN_SESSION) reads.requests++
      return ledger.getRequests(id)
    },
    getRequestsBetween: (id, from, to) => {
      const rows = ledger.getRequestsBetween(id, from, to)
      if (id === GOLDEN_SESSION) reads.ranged += rows.length
      return rows
    },
    getFingerprints: (id) => {
      reads.fingerprints++
      return ledger.getFingerprints(id)
    },
    getFingerprint: (id) => {
      if (id.startsWith(GOLDEN_SESSION)) reads.fingerprint++
      return ledger.getFingerprint(id)
    },
    changedRequests: (id, since) => {
      const rows = ledger.changedRequests(id, since)
      reads.requestRows += rows?.length ?? 0
      return rows
    },
    changedContextFacts: (id, since) => {
      const rows = ledger.changedContextFacts(id, since)
      reads.factRows += rows?.length ?? 0
      return rows
    },
  }
  return { ledger: wrapped, reads, reset: () => Object.assign(reads, zero) }
}

// The same query through a second handle, whose analysis cache is cold.
function cold(input: MonitorQueryInput) {
  const fresh = createLedger(file)
  const report = queryMonitor(fresh, input, { now: NOW })
  fresh.close()
  return JSON.parse(JSON.stringify(report))
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

test("a long legacy Anthropic chat keeps accounting, unknown diagnoses and loads in seconds", () => {
  const fresh = createLedger(file)
  const started = performance.now()
  const report = queryMonitor(fresh, cache, { now: NOW })
  const coldMs = performance.now() - started
  fresh.close()

  // The old snapshot is retained as historical evidence, not regenerated as
  // truth. Independently require unknown diagnoses and exact stored accounting.
  const rows = db.getRequests(GOLDEN_SESSION)
  expect(rows).toHaveLength(1500)
  expect(report.requests).toHaveLength(100)
  expect(report.requestPage?.total).toBe(1499)
  const all = [...report.requests!]
  let cursor = report.requestPage?.older
  while (cursor) {
    const page = queryMonitor(db, { ...cache, requestPage: { cursor, direction: "older" } }, { now: NOW })
    expect(page.totals).toEqual(report.totals)
    all.push(...page.requests!)
    cursor = page.requestPage?.older
  }
  expect(all).toHaveLength(1499)
  expect(new Set(all.map((request) => request.id)).size).toBe(1499)
  expect(all.map((request) => request.id).sort()).toEqual(rows.filter((row) => !row.isTitle).map((row) => row.id).sort())
  expect(report.totals).toMatchObject({ misses: 0, missTokens: 0, pricingCoverage: { complete: false } })
  expect(report.totals.missCost).toBeUndefined()
  expect(report.totals.hitRate).toBeUndefined()
  for (const [key, column] of [
    ["input", "inputTokens"], ["output", "outputTokens"],
    ["cacheRead", "cacheReadTokens"], ["cacheWrite", "cacheWriteTokens"], ["cost", "cost"],
  ] as const) {
    expect(report.totals[key]).toBeCloseTo(rows.filter((row) => !row.isTitle).reduce((sum, row) => sum + row[column], 0), 8)
  }
  const details = analyzeSession(db, db.getRequests(GOLDEN_SESSION), db.getContextFacts(GOLDEN_SESSION)).details
  expect(details).toHaveLength(1500)
  details.forEach((detail, index) => {
    const row = rows[index]!
    expect(detail.request).toMatchObject({
      id: row.id,
      verdict: row.status === "error" ? "error" : "none",
      confidence: "unknown",
      missTokens: 0,
      measurement: { state: row.status === "running" ? "running" : "legacy-unknown" },
      input: row.inputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens,
    })
    expect(detail.request.expected).toBeUndefined()
  })
  // Generated pre-version fingerprints cannot recover missing wire identity.
  expect(details[300]?.request.cause).toBe("unknown")
  expect(details[300]?.segments).toEqual([])
  expect(details[300]?.instructions).toMatchObject([{ keys: ["AGENTS.md"] }])
  expect(details[900]?.accounts).toMatchObject([{ from: "Small", to: "Large" }])
  expect(plain(report)).toEqual(cold(cache))
  // Recorded at about 70 s before the speed-up; about 0.4 s after it. The bound leaves room for a slow machine.
  expect(golden.recorded.queryMs).toBeGreaterThan(30_000)
  expect(coldMs).toBeLessThan(10_000)
}, 120_000)

test("a repeat costs nothing, other chats' writes leave this chat alone, and a change drops only what it affects", () => {
  const saved = () => db.db.query<{ n: number }, [string]>("select count(*) n from cache_result where session_id = ?").get(GOLDEN_SESSION)!.n
  const probe = counted(db)
  // Saved results answer; only the running step is analyzed, from the few rows it reads.
  const first = queryMonitor(probe.ledger, cache, { now: NOW })
  expect(probe.reads).toEqual({ requests: 0, fingerprints: 0, ranged: 3, fingerprint: 3, requestRows: 0, factRows: 0 })

  // Nothing changed: nothing is read again.
  probe.reset()
  const started = performance.now()
  expect(plain(queryMonitor(probe.ledger, cache, { now: NOW }))).toEqual(plain(first))
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(probe.reads).toEqual({ requests: 0, fingerprints: 0, ranged: 0, fingerprint: 0, requestRows: 0, factRows: 0 })

  // Another chat writes: this chat's saved results stand; only its running step is analyzed again.
  db.requestStarted({ id: "other-1", sessionID: "ses_other", kind: "step", started: NOW - 10_000 })
  db.requestFingerprint({ ...db.getFingerprint(`${GOLDEN_SESSION}-00010`)!, requestID: "other-1", sessionID: "ses_other" })
  db.contextFact({ sessionID: "ses_other", at: NOW - 10_000, kind: "warming", detail: { state: "on" } })
  expect(saved()).toBe(1499)
  probe.reset()
  expect(plain(queryMonitor(probe.ledger, cache, { now: NOW }))).toEqual(plain(first))
  expect(probe.reads).toEqual({ requests: 0, fingerprints: 0, ranged: 3, fingerprint: 3, requestRows: 0, factRows: 0 })

  // The running step completes and a new one starts. Its result and changed
  // segments read its 3 nearest rows; the one earlier write whose lifetime
  // covers it is counted again over that lifetime's 16 requests; the new step
  // reads 2. Nothing earlier is touched.
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
  expect(saved()).toBe(1499)
  probe.reset()
  const appended = plain(queryMonitor(probe.ledger, cache, { now: NOW }))
  expect(probe.reads).toEqual({ requests: 0, fingerprints: 0, ranged: 5, fingerprint: 25, requestRows: 0, factRows: 0 })
  expect(saved()).toBe(1500)
  expect(appended.requests.at(-2)).toMatchObject({ cacheRead: 400_000, cacheWrite: 2_000, verdict: "none", measurement: { state: "legacy-unknown" } })
  expect(appended).toEqual(cold(cache))

  // Changes deep in the history: a corrected early fingerprint and a fact back
  // in time drop the results from that point on; saved again, they match a cold analysis.
  const early = rows[200]!
  db.requestFingerprint({ ...db.getFingerprint(early.id)!, optionsKeys: { max_tokens: "changed" } })
  expect(saved()).toBe(200)
  db.contextFact({ sessionID: GOLDEN_SESSION, at: rows[600]!.started - 1, kind: "account_switch", detail: { from: "Large", to: "Small" } })
  saveAll(db)
  expect(saved()).toBe(1500)
  probe.reset()
  for (const view of ["cache", "overview"] as const) {
    expect(plain(queryMonitor(probe.ledger, { ...cache, view }, { now: NOW }))).toEqual(cold({ ...cache, view }))
  }
  // Each of the two reports reads only the running step's 2 rows.
  expect(probe.reads).toEqual({ requests: 0, fingerprints: 0, ranged: 4, fingerprint: 4, requestRows: 0, factRows: 0 })

  // Another process (here a second connection) completes a request of this chat.
  const other = createLedger(file)
  other.requestEnded(next, {
    ended: running.started + 14_000,
    status: "completed",
    usage: { input: 3, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 402_000, cost: 0.4 },
  })
  other.close()
  const completed = plain(queryMonitor(probe.ledger, cache, { now: NOW }))
  expect(completed.requests.at(-1)).toMatchObject({ verdict: "none", cacheWrite: 402_000, measurement: { state: "legacy-unknown" }, missTokens: 0 })
  expect(completed).toEqual(cold(cache))
}, 120_000)
