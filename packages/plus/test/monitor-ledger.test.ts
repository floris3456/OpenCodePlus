// The durable ledger's own boundary: schema v2 migration from a real v1 file,
// idempotent writes across instances, retention pruning, and the revision seam
// that invalidates query-time analysis after an in-place update.
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { createLedger, ledgerAt, type Ledger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, collect, ledger, script, usage } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-ledger-"))
  dirs.push(dir)
  return path.join(dir, "monitor.db")
}

// An older monitor.db: the pre-migration shape, missing the columns later
// releases added (session.team, request.finish, the fingerprint response ids).
// createLedger must add them in place and keep every row readable.
function writeOlder(file: string): void {
  const db = new Database(file, { create: true })
  db.exec(`
    create table session (id text primary key, parent_id text, agent text, title text, directory text, run_id text, role text, first_seen integer not null, last_seen integer not null);
    create table step (session_id text not null, message_id text not null, kind text not null, idx integer not null, epoch integer not null, agent text, provider text, model text, variant text, config text, started integer not null, ended integer, finish text, input integer not null default 0, output integer not null default 0, reasoning integer not null default 0, cache_read integer not null default 0, cache_write integer not null default 0, cost real not null default 0, primary key (session_id, message_id));
    create table call (session_id text not null, call_id text not null, message_id text not null, parent_call text, idx integer not null, epoch integer not null, agent text, model text, config text, tool text not null, target text, status text not null, error text, started integer not null, ended integer, input_chars integer not null default 0, result_chars integer not null default 0, call_tokens integer not null default 0, result_tokens integer not null default 0, measured integer not null default 0, primary key (session_id, call_id));
    create table epoch (session_id text not null, epoch integer not null, last_idx integer not null, primary key (session_id, epoch));
    create table mark (id integer primary key autoincrement, at integer not null, label text not null);
    create table meta (key text primary key, value text not null);
    create table request (id text primary key, session_id text not null, kind text not null, is_title integer not null default 0, agent text, provider text, model text, variant text, started integer not null, ended integer, duration integer, status text not null default 'completed', error text, input_tokens integer not null default 0, output_tokens integer not null default 0, reasoning_tokens integer not null default 0, cache_read_tokens integer not null default 0, cache_write_tokens integer not null default 0, cost real not null default 0, message_id text, created integer not null);
    create table request_fingerprint (request_id text primary key, session_id text not null, protocol text not null, system_parts text not null default '[]', tools text not null default '[]', options_hash text not null default '', options_keys text not null default '{}', message_prefixes text not null default '[]', cache_key text, cache_control text, body_hash text not null, created integer not null);
    create table context_fact (id integer primary key autoincrement, session_id text not null, at integer not null, kind text not null, detail text not null default '{}', unique (session_id, at, kind, detail));
  `)
  db.query("insert into session (id, agent, title, first_seen, last_seen) values (?, ?, ?, ?, ?)").run(
    "ses_old",
    "build",
    "Old chat",
    1,
    1,
  )
  db.query(
    "insert into step (session_id, message_id, kind, idx, epoch, agent, provider, model, started, ended, finish, input, output, cache_read) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("ses_old", "m1", "step", 0, 0, "build", "p", "m1", 1, 2, "stop", 100, 10, 50)
  db.query("insert into request (id, session_id, kind, started, created) values (?, ?, ?, ?, ?)").run(
    "req_old",
    "ses_old",
    "step",
    1,
    1,
  )
  db.query(
    "insert into request_fingerprint (request_id, session_id, protocol, body_hash, created) values (?, ?, ?, ?, ?)",
  ).run("req_old", "ses_old", "anthropic", "bodyhash", 1)
  db.query("insert into meta (key, value) values ('schema', '1')").run()
  db.close()
}

test("an older monitor.db migrates in place and keeps its rows readable", async () => {
  const file = await tempFile()
  writeOlder(file)
  const migrated = createLedger(file)
  try {
    // The added columns exist; nothing the old file stored was dropped.
    expect(
      migrated.db.query<{ name: string }, []>("pragma table_info(session)").all().some((c) => c.name === "team"),
    ).toBe(true)
    expect(
      migrated.db.query<{ name: string }, []>("pragma table_info(request)").all().some((c) => c.name === "finish"),
    ).toBe(true)
    expect(
      migrated.db
        .query<{ name: string }, []>("pragma table_info(request_fingerprint)")
        .all()
        .some((c) => c.name === "response_id"),
    ).toBe(true)
    // The old step and request are still readable through the real query path.
    const report = queryMonitor(migrated, { scope: "all", view: "steps" }, { now: 10 })
    expect(report.totals.steps).toBe(1)
    expect(report.totals.input).toBe(100)
    expect(report.requests?.find((request) => request.id === "req_old")).toMatchObject({ sessionID: "ses_old" })
    expect(migrated.getFingerprint("req_old")?.bodyHash).toBe("bodyhash")
    // The schema marker advanced.
    expect(migrated.db.query<{ value: string }, []>("select value from meta where key = 'schema'").get()?.value).toBe("2")
  } finally {
    migrated.close()
  }
})

test("two handles on one file share the same durable facts and the revision tracks the other's writes", async () => {
  const file = await tempFile()
  const first = createLedger(file)
  const second = createLedger(file)
  try {
    const clock = { now: 10 }
    const s = script("ses_shared", clock)
    s.step("m1")
    s.end("m1", "stop", usage(10, 5, 100))
    collect(first, clock).observe(s.events[0]!)
    collect(first, clock).observe(s.events[1]!)
    // The second handle reads the committed step.
    const before = queryMonitor(second, { scope: "all", view: "steps" }, { now: 20 })
    expect(before.totals.steps).toBe(1)
    // A write through the first handle advances the second's revision, so a
    // cached analysis keyed on it cannot serve the stale value.
    const revision = second.revision()
    const t = script("ses_shared", clock)
    t.step("m2")
    t.end("m2", "stop", usage(10, 5, 200))
    collect(first, clock).observe(t.events[0]!)
    collect(first, clock).observe(t.events[1]!)
    expect(second.revision()).not.toBe(revision)
    const after = queryMonitor(second, { scope: "all", view: "steps" }, { now: 30 })
    expect(after.totals.steps).toBe(2)
  } finally {
    first.close()
    second.close()
  }
})

test("writing the same request twice is idempotent and prune keeps in-window rows", async () => {
  const db: Ledger = await ledger()
  const clock = { now: 1_000 }
  const s = script("ses_idem", clock)
  s.step("m1")
  s.call("m1", "c1", "read", { path: "a" })
  s.ok("m1", "c1", "z".repeat(200))
  s.end("m1", "stop", usage(10, 5, 100))
  const collector = collect(db, clock)
  // Observing the same event stream twice writes the same rows.
  s.events.forEach((event) => collector.observe(event))
  const rows = () => ({
    steps: db.db.query("select session_id, message_id, idx, input, output from step order by idx").all(),
    calls: db.db.query("select session_id, call_id, tool, status, result_tokens from call order by call_id").all(),
  })
  const once = rows()
  s.events.forEach((event) => collector.observe(event))
  expect(rows()).toEqual(once)

  clock.now = 100_000
  const later = script("ses_idem", clock)
  later.step("m2")
  later.end("m2", "stop", usage(1, 1))
  later.events.forEach((event) => collector.observe(event))
  db.prune(50_000)
  expect(db.db.query("select message_id from step order by idx").all()).toEqual([{ message_id: "m2" }])
  expect(db.db.query("select count(*) as c from call").get()).toEqual({ c: 0 })
})

test("ledgerAt returns one shared handle per file and close forgets it", async () => {
  const file = await tempFile()
  const a = ledgerAt(file)
  const b = ledgerAt(file)
  expect(a).toBe(b)
  a.close()
  const c = ledgerAt(file)
  expect(c).not.toBe(a)
  c.close()
})
