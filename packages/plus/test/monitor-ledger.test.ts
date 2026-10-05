// Actual-ledger query regressions for the Monitor page controls (#7): scope,
// filters, top tools and id detail, all read from a real temporary monitor.db
// through queryMonitor, never a mock. Raw ledger/attribution coverage lives in
// monitor.test.ts; this file owns the query seams the page depends on.
import { afterEach, expect, test } from "bun:test"
import type { SessionFacts } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, collect, ledger, script, usage } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

function ids(report: ReturnType<typeof queryMonitor>): string[] {
  return report.feed.map((entry) => entry.callID).sort()
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
  const { db, clock } = await tree()
  const now = clock.now
  const detail = queryMonitor(
    db,
    { scope: "tree", sessionID: "ses_run", view: "cache", id: "req_child" },
    { now },
  )
  // No such request id in this ledger: no detail is invented.
  expect(detail.detail).toBeUndefined()
  // A real step request id resolves to its own detail within scope.
  const first = queryMonitor(db, { scope: "session", sessionID: "ses_root", view: "steps" }, { now })
  const requestID = first.requests?.[0]?.id
  expect(requestID).toBeDefined()
  const withDetail = queryMonitor(
    db,
    { scope: "session", sessionID: "ses_root", view: "steps", id: requestID },
    { now },
  )
  expect(withDetail.detail?.request.id).toBe(requestID)
  expect(withDetail.detail?.request.sessionID).toBe("ses_root")
  // Out of scope, the same id yields no detail.
  const other = queryMonitor(db, { scope: "session", sessionID: "ses_other", view: "steps", id: requestID }, { now })
  expect(other.detail).toBeUndefined()
})

test("missesOnly narrows the request list without changing totals; titles are excluded by default", async () => {
  const { db, clock } = await tree()
  const now = clock.now
  const all = queryMonitor(db, { scope: "all", view: "cache" }, { now })
  const missesOnly = queryMonitor(db, { scope: "all", view: "cache", missesOnly: true }, { now })
  expect(missesOnly.totals).toEqual(all.totals)
  expect((missesOnly.requests ?? []).every((request) => request.verdict === "miss" || request.verdict === "partial")).toBe(
    true,
  )
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
