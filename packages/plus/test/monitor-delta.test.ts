import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { createLedger } from "../src/monitor/ledger.js"
import { sessionFold } from "../src/monitor/report.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

test("normal append/completion/correction/fact reads only changed payloads, including independent SQL", async () => {
  const db = await ledger()
  for (let i = 0; i < 100; i++) {
    db.requestStarted({ id: `r${i}`, sessionID: "s", kind: "step", started: i })
    db.contextFact({ sessionID: "s", at: i, kind: "fixture" })
  }
  sessionFold(db, "s")
  const fullRows = spyOn(db, "getRequests")
  const fullFacts = spyOn(db, "getContextFacts")
  const rows = spyOn(db, "changedRequests")
  const facts = spyOn(db, "changedContextFacts")
  const other = createLedger(db.path)
  const sql = new Database(db.path)
  const verify = (requests: number, context: number) => {
    const folded = sessionFold(db, "s")
    expect(rows.mock.results.at(-1)?.value).toHaveLength(requests)
    expect(facts.mock.results.at(-1)?.value).toHaveLength(context)
    const fresh = createLedger(db.path)
    try {
      const expected = sessionFold(fresh, "s")
      expect(folded.rows).toEqual(expected.rows)
      expect(folded.facts).toEqual(expected.facts)
      for (const row of folded.rows) expect(folded.analysis.detail(row.id)).toEqual(expected.analysis.detail(row.id))
    } finally { fresh.close() }
    expect(fullRows).not.toHaveBeenCalled()
    expect(fullFacts).not.toHaveBeenCalled()
  }
  try {
    other.requestStarted({ id: "append", sessionID: "s", kind: "step", started: 100 })
    verify(1, 0)
    other.requestEnded("append", { ended: 101, status: "completed" })
    verify(1, 0)
    sql.query("update request set started = 50, input_tokens = 987 where id = 'append'").run()
    verify(1, 0)
    sql.query("insert into context_fact(session_id, at, kind, detail) values ('s', 60, 'compaction', '{}')").run()
    verify(0, 1)
    sql.query("update context_fact set at = 10, kind = 'changed' where id = 101").run()
    verify(0, 1)
    other.requestFingerprint({ requestID: "append", sessionID: "s", ...fingerprintWireBody({ input: [{ role: "user", content: "late" }] }) })
    verify(0, 0)
    expect(sessionFold(db, "s").rows.filter((r) => r.started === 50).map((r) => r.id)).toEqual(["r50", "append"])
    console.log("delta work: append=1/0 completion=1/0 correction=1/0 new-fact=0/1 fact-correction=0/1 late-fingerprint=0/0; full payload calls=0")
  } finally { sql.close(); other.close() }
})

test("deletion, movement, id changes and prune reset safely; live index remains bounded", async () => {
  const db = await ledger()
  for (let i = 0; i < 5; i++) {
    db.requestStarted({ id: `r${i}`, sessionID: "s", kind: "step", started: i })
    db.contextFact({ sessionID: "s", at: i, kind: "fixture" })
  }
  sessionFold(db, "s")
  sessionFold(db, "destination")
  const verify = () => {
    const fresh = createLedger(db.path)
    try {
      for (const id of ["s", "destination"]) {
        expect(sessionFold(db, id).rows).toEqual(sessionFold(fresh, id).rows)
        expect(sessionFold(db, id).facts).toEqual(sessionFold(fresh, id).facts)
      }
    } finally { fresh.close() }
  }
  db.db.exec("delete from request where id = 'r0'; delete from context_fact where id = 1")
  verify()
  db.db.exec("update request set session_id = 'destination' where id = 'r1'; update context_fact set session_id = 'destination' where id = 2")
  verify()
  db.db.exec("update request set id = 'renamed' where id = 'r2'")
  verify()
  db.prune(4)
  verify()
  const n = db.db.query<{ n: number }, []>("select count(*) as n from analysis_change").get()!.n
  expect(n).toBe(db.getRequests("s").length + db.getContextFacts("s").length)
  expect(db.db.query<{ n: number }, []>("select count(*) as n from analysis_reset").get()!.n).toBeLessThanOrEqual(4)
})

test("raw fingerprint base correction and session move invalidate decoded descendants and old session", async () => {
  const db = await ledger()
  for (const [i, id] of ["a", "b"].entries()) {
    db.requestStarted({ id, sessionID: "s", kind: "step", started: i })
    db.requestFingerprint({ requestID: id, sessionID: "s", created: i, ...fingerprintWireBody({ input: [{ role: "user", content: "shared" }] }) })
  }
  sessionFold(db, "s")
  db.db.exec(`update request_fingerprint set message_prefixes = '[]' where request_id = 'a'`)
  const verify = () => {
    const fresh = createLedger(db.path)
    try {
      const actual = sessionFold(db, "s")
      const expected = sessionFold(fresh, "s")
      for (const row of actual.rows) expect(actual.analysis.detail(row.id)).toEqual(expected.analysis.detail(row.id))
    } finally { fresh.close() }
  }
  verify()
  db.db.exec("update request_fingerprint set session_id = 'destination' where request_id = 'b'")
  verify()
})

test("additive migration explicitly replaces legacy plain triggers on a synthetic copy", async () => {
  const db = await ledger()
  // Separate SQLite fixture is a copy, never a live monitor database.
  const copy = `${db.path}.copy`
  db.db.exec(`vacuum into '${copy}'`)
  const sql = new Database(copy)
  sql.exec("delete from meta where key = 'analysis_delta'")
  for (const table of ["request", "context_fact"]) {
    for (const operation of ["insert", "update", "delete"]) sql.exec(`drop trigger ${table}_change_${operation}`)
    sql.exec(`create trigger ${table}_change_insert after insert on ${table} begin
      insert into session_change(session_id, rev) values(new.session_id, 1) on conflict(session_id) do update set rev = rev + 1; end`)
  }
  sql.close()
  const migrated = createLedger(copy)
  try {
    migrated.requestStarted({ id: "new", sessionID: "s", started: 1, kind: "step" })
    expect(migrated.changedRequests("s", 0)?.map((row) => row.id)).toEqual(["new"])
    expect(migrated.db.query("select value from meta where key = 'analysis_delta'").get()).toEqual({ value: "1" })
  } finally { migrated.close() }
})
