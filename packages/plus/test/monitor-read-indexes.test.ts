import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createLedger, type Ledger } from "../src/monitor/ledger.js"
import { legacySteps, projectCacheResult, savedTotals } from "../src/monitor/snapshot.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

/** Every statement a read prepares, with the plan SQLite chose for it. */
function plans(db: Ledger, read: () => void) {
  const statements: string[] = []
  const query = db.db.query.bind(db.db)
  db.db.query = ((sql: string) => {
    statements.push(sql)
    return query(sql)
  }) as typeof db.db.query
  try {
    read()
  } finally {
    db.db.query = query
  }
  return statements.map((sql) => ({
    sql,
    plan: db.db.query<{ detail: string }, []>(`explain query plan ${sql}`).all().map((row) => row.detail),
  }))
}

test("ping follow-ups skip title and exchange requests; an unsaved one is unknown", async () => {
  const db = await ledger()
  db.session({ id: "chat" }, 1)
  const request = (id: string, at: number, kind: string, options: { read?: number; title?: boolean; exchange?: boolean; save?: boolean } = {}) => {
    db.requestStarted({ id, sessionID: "chat", kind, started: at, ...(options.title ? { isTitle: true } : {}) })
    db.requestEnded(id, { status: "completed", ended: at + 1 })
    db.requestObserved(id, {
      version: 1, completeness: "final", historyEpoch: "one", inputTokens: 10000,
      cacheReadInputTokens: options.read ?? 10000, cacheWriteInputTokens: 0, ...(options.exchange ? { scope: "exchange" as const } : {}),
    })
    if (options.save !== false) projectCacheResult(db, id)
  }
  request("p1", 10, "ping")
  request("title", 12, "title", { title: true, read: 0 })
  request("exchange", 14, "step", { exchange: true, read: 0 })
  request("hit", 20, "step")
  request("p2", 30, "ping")
  request("unsaved", 40, "step", { read: 0, save: false })
  request("p3", 50, "ping")
  const totals = savedTotals(db, { scope: "all" }, {}, { since: 0, until: 100 })
  // Nothing follows p3.
  expect(totals.pings).toMatchObject({ sent: 3, followedByHit: 1, followedByMiss: 0, followedByCold: 0, unused: 1, unknown: 1 })
  // A window that ends before a ping's next request leaves it unused.
  expect(savedTotals(db, { scope: "all" }, {}, { since: 0, until: 35 }).pings).toMatchObject({ sent: 2, followedByHit: 1, unused: 1 })
})

test("all-history totals read only indexes: v1 steps, step totals and ping follow-ups", async () => {
  const db = await ledger()
  db.session({ id: "chat" }, 1)
  db.requestStarted({ id: "p1", sessionID: "chat", kind: "ping", started: 10 })
  db.requestEnded("p1", { status: "completed", ended: 11 })
  projectCacheResult(db, "p1")
  const window = { since: 0, until: 100 }
  const read = plans(db, () => {
    savedTotals(db, { scope: "all" }, {}, window)
    legacySteps(db, { scope: "all" }, {}, window)
  })
  const ping = read.find((entry) => entry.sql.includes("p.kind = 'ping'"))!
  expect(ping.plan.filter((detail) => /\b(r|next) USING/.test(detail))).toEqual([
    expect.stringContaining("SEARCH r USING COVERING INDEX request_follow"),
    expect.stringContaining("SEARCH next USING COVERING INDEX request_follow"),
  ])
  expect(ping.plan.some((detail) => detail.includes("SEARCH result USING COVERING INDEX cache_result_session_totals"))).toBe(true)
  const legacy = read.find((entry) => entry.sql.includes("from step s"))!
  expect(legacy.plan).toContainEqual(expect.stringContaining("SEARCH s USING COVERING INDEX step_window"))
  expect(legacy.plan).toContainEqual(expect.stringContaining("SEARCH r USING COVERING INDEX request_message"))
})

test("a ledger opened by an older release gets the read indexes and loses the step index they replace", async () => {
  const db = await ledger()
  const file = db.db.filename
  db.db.exec("drop index step_window")
  db.db.exec("drop index request_follow")
  db.db.exec("create index step_started on step(started)")
  db.db.close()
  const reopened = createLedger(file)
  const indexes = reopened.db.query<{ name: string }, []>("select name from sqlite_master where type = 'index'").all().map((row) => row.name)
  expect(indexes).toContain("step_window")
  expect(indexes).toContain("request_follow")
  expect(indexes).not.toContain("step_started")
  reopened.db.close()
  // Nothing else in the file was rewritten: it still opens as a plain SQLite database.
  expect(new Database(file, { readonly: true }).query("pragma quick_check").get()).toEqual({ quick_check: "ok" })
})
