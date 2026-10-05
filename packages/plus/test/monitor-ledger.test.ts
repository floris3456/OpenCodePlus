// Actual-ledger query regressions for the Monitor page controls (#7): scope,
// filters, top tools and id detail, all read from a real temporary monitor.db
// through queryMonitor, never a mock. Raw ledger/attribution coverage lives in
// monitor.test.ts; this file owns the query seams the page depends on.
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { createLedger, type Ledger, type SessionFacts } from "../src/monitor/ledger.js"
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
// releases added. createLedger must add them in place and keep every row.
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

function ids(report: ReturnType<typeof queryMonitor>): string[] {
  return report.feed.map((entry) => entry.callID).sort()
}

// A real request row through the actual ledger boundary (requestStarted +
// requestFingerprint + requestEnded), not the legacy step-only script path.
function request(
  db: Ledger,
  session: string,
  id: string,
  at: number,
  options: { kind?: "step" | "title" | "ping"; isTitle?: boolean; input?: number; read?: number; agent?: string } = {},
) {
  const wire = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "base".repeat(1600) },
      { role: "user", content: "hello" },
    ],
    tools: [{ type: "function", function: { name: "shell", description: "run", parameters: { type: "object" } } }],
  }
  db.session({ id: session, agent: options.agent ?? "build", directory: "/work/project" }, at)
  db.requestStarted({
    id,
    sessionID: session,
    messageID: id,
    started: at,
    kind: options.kind ?? "step",
    isTitle: options.isTitle,
    agent: options.agent ?? "build",
    provider: "openai",
    model: "gpt-4o",
  })
  db.requestFingerprint({
    requestID: id,
    sessionID: session,
    created: at,
    ...fingerprintWireBody(wire, { namedSystemParts: [{ name: "AGENTS.md", text: "rules" }] }),
  })
  db.requestEnded(id, {
    ended: at + 5,
    status: "completed",
    usage: { input: options.input ?? 3_000, cacheRead: options.read ?? 0, cacheWrite: 1_000, output: 100, reasoning: 10, cost: 0.01 },
  })
}

// Root build chat -> host child -> delegated team run, plus an unrelated chat.
// The same shape monitor.test.ts uses, so scope semantics are pinned twice.
async function tree() {
  const db = await ledger()
  const clock = { now: 1 }
  const resolve = async (id: string): Promise<SessionFacts | undefined> =>
    id === "ses_run" ? { id, parentID: "ses_child", runID: "run_1", role: "implementer" } : undefined
  const collector = collect(db, clock, { resolve })
  const root = script("ses_root", clock)
  root.created({ agent: "build" })
  root.step("r1")
  root.call("r1", "c_root", "read", { path: "root.ts" })
  root.ok("r1", "c_root", "a".repeat(80))
  root.end("r1", "stop", usage(100, 10, 400))
  const child = script("ses_child", clock)
  child.created({ agent: "general", parentID: "ses_root" })
  child.step("k1", "general", { id: "m", providerID: "q" })
  child.call("k1", "c_child", "grep", { pattern: "needle" })
  child.ok("k1", "c_child", "b".repeat(40))
  child.end("k1", "stop", usage(50, 5, 100))
  const run = script("ses_run", clock)
  run.created({ agent: "implementer", location: { directory: "/work/worktree" } })
  run.step("w1", "implementer")
  run.call("w1", "c_run", "edit", { path: "run.ts" })
  run.ok("w1", "c_run", "c".repeat(20))
  run.end("w1", "stop", usage(20, 3, 0))
  const other = script("ses_other", clock)
  other.created({ agent: "plan" })
  other.step("o1", "plan")
  other.call("o1", "c_other", "shell", { command: "git status" })
  other.ok("o1", "c_other", "d".repeat(10))
  other.end("o1", "stop", usage(10, 2, 0))
  ;[...root.events, ...child.events, ...run.events, ...other.events].forEach((event) => collector.observe(event))
  await collector.settle()
  return { db, clock, collector }
}

test("session scope is exactly one chat; tree lifts to the topmost root; project spans trees", async () => {
  const { db, clock } = await tree()
  const now = clock.now
  expect(ids(queryMonitor(db, { scope: "session", sessionID: "ses_root", feed: 20 }, { now }))).toEqual(["c_root"])
  expect(ids(queryMonitor(db, { scope: "session", sessionID: "ses_child", feed: 20 }, { now }))).toEqual(["c_child"])
  // From the delegated run, tree reaches the host child and its root and siblings.
  expect(ids(queryMonitor(db, { scope: "tree", sessionID: "ses_run", feed: 20 }, { now }))).toEqual([
    "c_child",
    "c_root",
    "c_run",
  ])
  // A session scope with no session reads nothing, never everything.
  expect(ids(queryMonitor(db, { scope: "session", feed: 20 }, { now }))).toEqual([])
  // Project needs a directory; without one it fails closed.
  expect(ids(queryMonitor(db, { scope: "project", feed: 20 }, { now }))).toEqual([])
  expect(ids(queryMonitor(db, { scope: "project", feed: 20 }, { directory: "/work/project", now }))).toEqual([
    "c_child",
    "c_other",
    "c_root",
    "c_run",
  ])
  // Everything reads every session.
  expect(ids(queryMonitor(db, { scope: "all", feed: 20 }, { now }))).toEqual([
    "c_child",
    "c_other",
    "c_root",
    "c_run",
  ])
})

test("agent, tool and model filters narrow calls and steps; facets stay unfiltered", async () => {
  const { db, clock } = await tree()
  const now = clock.now
  const byAgent = queryMonitor(db, { scope: "all", agents: ["general"], feed: 20 }, { now })
  expect(ids(byAgent)).toEqual(["c_child"])
  expect(byAgent.totals).toMatchObject({ calls: 1, steps: 1, input: 50 })
  // Facets describe the scope, not the active filters.
  expect([...byAgent.facets.agents].sort()).toEqual(["build", "general", "implementer", "plan"])

  const byTool = queryMonitor(db, { scope: "all", tools: ["edit"], feed: 20 }, { now })
  expect(ids(byTool)).toEqual(["c_run"])
  const byModel = queryMonitor(db, { scope: "all", models: ["q/m"], feed: 20 }, { now })
  expect(ids(byModel)).toEqual(["c_child"])
  expect(byModel.facets.models).toContain("q/m")
})

test("a failed-only filter keeps failed calls and their step totals", async () => {
  const db = await ledger()
  const clock = { now: 1_000 }
  const collector = collect(db, clock)
  const s = script("ses_err", clock)
  s.created({ agent: "build" })
  s.step("m1")
  s.call("m1", "c1", "read", { path: "a" })
  s.ok("m1", "c1", "x".repeat(30))
  s.call("m1", "c2", "shell", { command: "git status" })
  s.fail("m1", "c2", "exit 1")
  s.end("m1", "stop", usage(30, 4))
  s.events.forEach((event) => collector.observe(event))
  const now = clock.now
  const failed = queryMonitor(db, { scope: "all", errors: true, feed: 20 }, { now })
  expect(failed.feed.map((entry) => entry.callID)).toEqual(["c2"])
  expect(failed.totals.errors).toBe(1)
  const all = queryMonitor(db, { scope: "all", feed: 20 }, { now })
  expect(ids(all)).toEqual(["c1", "c2"])
  expect(all.totals.errors).toBe(1)
})

test("the overview top tools are tool-grouped and independent of the requested grouping", async () => {
  const db = await ledger()
  const clock = { now: 1_000 }
  const collector = collect(db, clock)
  const s = script("ses_top", clock)
  s.created({ agent: "build" })
  s.step("m1")
  s.call("m1", "c1", "read", { path: "a.ts" })
  s.call("m1", "c2", "read", { path: "b.ts" })
  s.call("m1", "c3", "shell", { command: "bun test" })
  s.at(1_000)
  s.ok("m1", "c1", "a".repeat(3_000))
  s.at(2_000)
  s.ok("m1", "c2", "b".repeat(1_000))
  s.at(3_000)
  s.ok("m1", "c3", "c".repeat(500))
  s.end("m1", "stop", usage(1_000, 100, 9_000))
  s.events.forEach((event) => collector.observe(event))
  const now = clock.now
  // Grouping by target, the table keeps target rows but the overview top tools
  // are the tool-level groups, ordered by carried tokens.
  const report = queryMonitor(
    db,
    { scope: "session", sessionID: "ses_top", view: "overview", group: "target", sort: "tokens", top: 20, feed: 0 },
    { now },
  )
  expect(report.groups.map((group) => group.key)).toEqual(["read a.ts", "read b.ts", "shell bun test"])
  expect(report.topTools?.map((group) => group.key)).toEqual(["read", "shell"])
  expect(report.topTools?.every((group) => group.key === group.label)).toBe(true)
  // topTools is an overview section only.
  expect(queryMonitor(db, { scope: "session", sessionID: "ses_top", view: "tools" }, { now }).topTools).toBeUndefined()
})

test("id returns detail only for the requested request and respects scope", async () => {
  const { db } = await tree()
  const now = 600
  // Seed a real request row (not a legacy step) and ask for its detail.
  request(db, "ses_root", "req_root", 500, { input: 2_000, read: 1_500 })
  const root = queryMonitor(db, { scope: "session", sessionID: "ses_root", view: "steps" }, { now })
  expect(root.requests?.some((entry) => entry.id === "req_root")).toBe(true)
  const withDetail = queryMonitor(
    db,
    { scope: "session", sessionID: "ses_root", view: "steps", id: "req_root" },
    { now },
  )
  expect(withDetail.detail?.request.id).toBe("req_root")
  expect(withDetail.detail?.request.sessionID).toBe("ses_root")
  expect(withDetail.detail?.request.input).toBe(2_000)
  // An id that is not in this ledger invents no detail.
  expect(queryMonitor(db, { scope: "all", view: "cache", id: "req_missing" }, { now }).detail).toBeUndefined()
  // Out of scope, the same id yields no detail.
  const other = queryMonitor(db, { scope: "session", sessionID: "ses_other", view: "steps", id: "req_root" }, { now })
  expect(other.detail).toBeUndefined()
})

test("titles are excluded by default and included with titles: true", async () => {
  const db = await ledger()
  request(db, "ses_t", "req_step", 100, { input: 2_000 })
  request(db, "ses_t", "req_title", 200, { kind: "title", isTitle: true, input: 500 })
  const now = 300
  const excluded = queryMonitor(db, { scope: "session", sessionID: "ses_t", view: "cache" }, { now })
  expect(excluded.requests?.map((entry) => entry.id)).toEqual(["req_step"])
  const included = queryMonitor(db, { scope: "session", sessionID: "ses_t", view: "cache", titles: true }, { now })
  expect(included.requests?.map((entry) => entry.id)).toEqual(["req_step", "req_title"])
  expect(included.totals.requests).toBe(2)
})

test("missesOnly narrows the request list to the miss without changing totals", async () => {
  const db = await ledger()
  // A warm predecessor that reads the cache, then a miss: the filtered list
  // must be non-empty and hold exactly the miss, with totals unchanged.
  request(db, "ses_m", "req_seed", 50, { input: 2_000, read: 0 })
  request(db, "ses_m", "req_hit", 100, { input: 400, read: 6_000 })
  request(db, "ses_m", "req_miss", 200, { input: 4_000, read: 0 })
  const now = 300
  const all = queryMonitor(db, { scope: "session", sessionID: "ses_m", view: "cache" }, { now })
  expect(all.requests?.map((entry) => entry.id)).toEqual(["req_seed", "req_hit", "req_miss"])
  expect(all.requests?.map((entry) => entry.verdict)).toEqual(["cold", "hit", "miss"])
  const missesOnly = queryMonitor(db, { scope: "session", sessionID: "ses_m", view: "cache", missesOnly: true }, { now })
  expect(missesOnly.totals).toEqual(all.totals)
  expect(missesOnly.requests?.map((entry) => entry.id)).toEqual(["req_miss"])
  expect(missesOnly.requests?.every((entry) => entry.verdict === "miss" || entry.verdict === "partial")).toBe(true)
})

test("a ping is listed with its kind and its usage survives the query", async () => {
  const db = await ledger()
  db.session({ id: "ses_ping", agent: "build" }, 1)
  db.requestStarted({ id: "req_ping", sessionID: "ses_ping", kind: "ping", started: 100, agent: "build", provider: "p", model: "m" })
  db.requestEnded("req_ping", {
    ended: 200,
    status: "completed",
    usage: { input: 0, output: 4, reasoning: 0, cacheRead: 8_000, cacheWrite: 0, cost: 0.002 },
  })
  const report = queryMonitor(db, { scope: "session", sessionID: "ses_ping", view: "cache" }, { now: 300 })
  const ping = report.requests?.find((request) => request.id === "req_ping")
  expect(ping).toMatchObject({ kind: "ping", cacheRead: 8_000, output: 4, cost: 0.002 })
  expect(report.totals.pings).toBe(1)
  expect(report.totals.pingCost).toBeCloseTo(0.002)
})

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
    const report = queryMonitor(migrated, { scope: "all", view: "steps" }, { now: 10 })
    expect(report.totals.steps).toBe(1)
    expect(report.totals.input).toBe(100)
    expect(report.requests?.find((entry) => entry.id === "req_old")).toMatchObject({ sessionID: "ses_old" })
    expect(migrated.getFingerprint("req_old")?.bodyHash).toBe("bodyhash")
    expect(migrated.db.query<{ value: string }, []>("select value from meta where key = 'schema'").get()?.value).toBe("2")
  } finally {
    migrated.close()
  }
})

test("two handles share the same durable facts and the revision tracks the other's writes", async () => {
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
    const before = queryMonitor(second, { scope: "all", view: "steps" }, { now: 20 })
    expect(before.totals.steps).toBe(1)
    const revision = second.revision()
    const t = script("ses_shared", clock)
    t.step("m2")
    t.end("m2", "stop", usage(10, 5, 200))
    collect(first, clock).observe(t.events[0]!)
    collect(first, clock).observe(t.events[1]!)
    expect(second.revision()).not.toBe(revision)
    expect(queryMonitor(second, { scope: "all", view: "steps" }, { now: 30 }).totals.steps).toBe(2)
  } finally {
    first.close()
    second.close()
  }
})
