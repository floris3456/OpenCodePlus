import { afterEach, expect, spyOn, test } from "bun:test"
import { QueryCache } from "../src/monitor/query-cache.js"
import { queryCacheStats, queryMonitor } from "../src/monitor/query.js"
import { createLedger, HOUR, type Ledger } from "../src/monitor/ledger.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"
import type { MonitorQueryInput } from "../src/rpc.js"

afterEach(cleanupLedgers)

function fresh(db: Ledger, input: MonitorQueryInput, now: number) {
  const reader = createLedger(db.path)
  try {
    return queryMonitor(reader, input, { now })
  } finally {
    reader.close()
  }
}

test("unchanged report skips aggregate SQL and refreshes only its clock", async () => {
  const db = await ledger()
  db.requestStarted({ id: "r", sessionID: "s", kind: "step", started: 1 })
  const input = { scope: "all" as const, view: "cache" as const, until: 10 }
  const first = queryMonitor(db, input, { now: 10 })
  const queries = spyOn(db.db, "query")
  const again = queryMonitor(db, input, { now: 11 })
  expect(again).toEqual({ ...first, now: 11 })
  expect(queryCacheStats(db)).toMatchObject({ hits: 1, misses: 1 })
  expect(queries).not.toHaveBeenCalled()
  queries.mockRestore()
  expect(again).toEqual(fresh(db, input, 11))
})

test("direct SQL, cross-handle writes, scope and time-window changes never reuse stale aggregates", async () => {
  const db = await ledger()
  for (const [id, started] of [
    ["a", 1],
    ["b", 3],
  ] as const)
    db.requestStarted({ id, sessionID: "s", kind: "step", started })
  const input = { scope: "session" as const, sessionID: "s", view: "cache" as const, until: 10 }
  queryMonitor(db, input, { now: 10 })
  db.db.query("update request set input_tokens = 123 where id = 'a'").run()
  expect(queryMonitor(db, input, { now: 10 }).totals.input).toBe(123)
  const writer = createLedger(db.path)
  try {
    writer.requestEnded("b", {
      status: "completed",
      ended: 4,
      usage: { input: 77, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 },
    })
  } finally {
    writer.close()
  }
  expect(queryMonitor(db, input, { now: 10 }).totals.input).toBe(200)
  for (const query of [
    input,
    { ...input, since: 2 },
    { ...input, until: 2 },
    { ...input, sessionID: "missing" },
    { ...input, compare: { since: 2, until: 10 } },
  ]) {
    expect(queryMonitor(db, query, { now: 10 })).toEqual(fresh(db, query, 10))
  }
})

test("live host state and agent map values, not just map identity, invalidate report snapshots", async () => {
  const db = await ledger()
  db.session({ id: "s", agent: "recorded" }, 1)
  db.requestStarted({ id: "r", sessionID: "s", kind: "step", started: 1 })
  const input = { scope: "all" as const, view: "sessions" as const, until: 10 }
  const states = new Map([["s", "running"]])
  const agents = new Map([["s", "first"]])
  const first = queryMonitor(db, input, { now: 10, states, agents })
  states.set("s", "succeeded")
  agents.set("s", "second")
  const next = queryMonitor(db, input, { now: 10, states, agents })
  expect(next.sessions?.[0]).toMatchObject({ state: "succeeded", agent: "second" })
  expect(first.sessions?.[0]).toMatchObject({ state: "running", agent: "first" })
  expect(queryCacheStats(db)).toMatchObject({ hits: 0, misses: 2 })
})

test("report retention bounds and strict expiry/exclusive data edges preserve answers", async () => {
  const db = await ledger()
  const report = queryMonitor(db, { scope: "all" }, { now: 1 })
  const cache = new QueryCache({ entries: 2, bytes: 100_000 })
  const bounds = [{ until: 10, nextData: 20, nextExpiry: 30 }]
  cache.set("a", "1", bounds, report)
  cache.set("b", "1", bounds, report)
  expect(cache.get("a", "1", [20])).toBe(report) // Data at20 is still excluded.
  cache.set("c", "1", bounds, report)
  expect(cache.get("b", "1", [10])).toBeUndefined() // LRU, not answer removal.
  expect(cache.get("a", "1", [21])).toBeUndefined()
  cache.set("expiry", "1", [{ until: 10, nextData: Infinity, nextExpiry: 30 }], report)
  expect(cache.get("expiry", "1", [29])).toBe(report)
  expect(cache.get("expiry", "1", [30])).toBeUndefined()
  cache.set("reverse", "1", bounds, report)
  expect(cache.get("reverse", "1", [9])).toBeUndefined()
  const refused = new QueryCache({ entries: 2, bytes: 1 })
  refused.set("large", "1", bounds, report)
  expect(refused.stats()).toMatchObject({ entries: 0, bytes: 0 })
  expect(report).toEqual(fresh(db, { scope: "all" }, 1))
})

test("advancing real windows reuse unchanged work but cross future data and write-expiry boundaries", async () => {
  const db = await ledger()
  const fp = fingerprintWireBody({ messages: [{ role: "user", content: "synthetic" }], prompt_cache_retention: "24h" })
  db.requestStarted({ id: "write", sessionID: "s", kind: "step", started: 1 })
  db.requestEnded("write", {
    status: "completed",
    ended: 2,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 100, cost: 0 },
  })
  db.requestFingerprint({ requestID: "write", sessionID: "s", ...fp })
  db.requestStarted({ id: "future", sessionID: "s", kind: "step", started: 100 })
  const input = { scope: "all" as const, view: "cache" as const }
  queryMonitor(db, input, { now: 10 })
  queryMonitor(db, input, { now: 20 })
  expect(queryCacheStats(db).hits).toBe(1)
  expect(queryMonitor(db, input, { now: 99 }).totals.requests).toBe(1)
  expect(queryMonitor(db, input, { now: 100 }).totals.requests).toBe(2)
  for (const now of [86_399_999, 86_400_000, 86_400_001]) {
    expect(queryMonitor(db, input, { now })).toEqual(fresh(db, input, now))
  }
})

test("comparison advancement and facet edge hours invalidate independently of the primary cutoff", async () => {
  const db = await ledger()
  db.requestStarted({ id: "comparison-only", sessionID: "s", kind: "step", started: 20 })
  const input = { scope: "all" as const, view: "cache" as const, until: 10, compare: { since: 0 } }
  queryMonitor(db, input, { now: 15 })
  expect(queryMonitor(db, input, { now: 18 }).compare?.totals.requests).toBe(0)
  expect(queryCacheStats(db).hits).toBe(1)
  expect(queryMonitor(db, input, { now: 20 }).compare?.totals.requests).toBe(1)
  expect(queryMonitor(db, input, { now: 20 })).toEqual(fresh(db, input, 20))

  db.db
    .query(
      `insert into call_hour (hour, session_id, epoch, agent, model, config, tool)
    values (?, 's', 0, 'synthetic-agent', '', '', 'synthetic-tool')`,
    )
    .run(1)
  const facets = { scope: "all" as const }
  expect(queryMonitor(db, facets, { now: HOUR - 2 }).facets.agents).toEqual([])
  expect(queryMonitor(db, facets, { now: HOUR - 1 }).facets.agents).toEqual(["synthetic-agent"])
  expect(queryMonitor(db, facets, { now: HOUR - 1 })).toEqual(fresh(db, facets, HOUR - 1))
})
