// Overview and steps answer from saved per-request results: no query folds a
// session's history on the service's thread, however many requests it holds.
// The agent tool asks for the cache view unless told otherwise.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultLedgerPath, ledgerAt, type Ledger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { sessionCacheStats } from "../src/monitor/report.js"
import { backfillCacheBatch } from "../src/monitor/snapshot.js"
import { registerMonitorTools } from "../src/monitor/tools.js"
import { fullContext, toolHarness } from "./harness.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

const priorData = process.env.XDG_DATA_HOME
const roots: string[] = []
const opened: string[] = []

afterEach(async () => {
  await cleanupLedgers()
  opened.splice(0).forEach((file) => ledgerAt(file).close())
  if (priorData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorData
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function requests(db: Ledger, sessionID: string, count: number, from: number) {
  db.session({ id: sessionID }, from)
  Array.from({ length: count }, (_, index) => `${sessionID}-${index}`).forEach((id, index) => {
    db.requestStarted({ id, sessionID, kind: "step", started: from + index, provider: "p", model: "m", agent: "build", messageID: id })
    db.requestEnded(id, { ended: from + index + 1, status: "completed", usage: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } })
  })
}

test("overview and steps answer from saved results without folding a session", async () => {
  const db = await ledger()
  requests(db, "big", 3_000, 1_000)
  requests(db, "small", 3, 1_000_000)
  // The background backfill saves a large backlog; a query saves only about 100 ms of it.
  while (backfillCacheBatch(db, 1_000) > 0) continue
  const context = { now: 10_000_000 }

  const overview = queryMonitor(db, { scope: "all", view: "overview" }, context)
  expect(overview.totals.requests).toBe(3_003)
  expect(overview.cachePending).toBe(0)
  expect(overview.context?.map((row) => row.sessionID).toSorted()).toEqual(["big", "small"])
  expect(queryMonitor(db, { scope: "all", view: "steps" }, context).requestPage?.total).toBe(3_003)
  expect(queryMonitor(db, { scope: "all", view: "overview", since: 999_999 }, context).totals.requests).toBe(3)
  expect(sessionCacheStats(db).sessions).toBe(0)
})

test("the backfill saves the newest results first, a screen's latest page", async () => {
  const db = await ledger()
  requests(db, "s", 5, 1_000)
  const saved = (where: string) =>
    db.db
      .query<{ id: string }, []>(`select request_id id from cache_result where ${where} order by started`)
      .all()
      .map((row) => row.id)
  expect(backfillCacheBatch(db, 2)).toBe(2)
  expect(saved("1")).toEqual(["s-3", "s-4"])
  while (backfillCacheBatch(db, 2) > 0) continue
  // Results an older release saved without the fold's wording go newest first too.
  db.db.run("update cache_result set fold = null")
  expect(backfillCacheBatch(db, 2)).toBe(2)
  expect(saved("fold is null")).toEqual(["s-0", "s-1", "s-2"])
})

test("the monitor tool defaults to the cache view", async () => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-saved-"))
  roots.push(root)
  process.env.XDG_DATA_HOME = path.join(root, "data")
  opened.push(defaultLedgerPath())
  const tools = toolHarness()
  const ctx = { ...fullContext({ directory: path.join(root, "project") }), tool: tools.domain }
  await registerMonitorTools(ctx)
  requests(ledgerAt(), "ses_saved", 3, Date.now() - 1_000_000)
  const output = await Effect.runPromise(
    (tools.tools.get("monitor_query") as Tool.Info)
      .execute({} as never, {
        sessionID: Session.ID.make("ses_saved"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_saved_test"),
        id: Tool.CallID.make("call_saved_test"),
        progress: () => Effect.void,
      })
      .pipe(Effect.map((result) => (result as { output: Record<string, unknown> }).output)),
  )
  // The cache view's shape: a request page, read from saved results.
  expect(Object.keys(output)).toContain("requestPage")
})
