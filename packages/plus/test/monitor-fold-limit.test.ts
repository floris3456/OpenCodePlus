// Overview and steps fold whole request histories synchronously on the
// service's one thread: past a bound they refuse instead of freezing it, and
// the agent tool asks for the saved-results cache view unless told otherwise.
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
import { MONITOR_FOLD_LIMIT, MonitorFoldLimit, sessionFold } from "../src/monitor/report.js"
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

test("overview and steps refuse to fold more than the limit; a kept fold does not count", async () => {
  const db = await ledger()
  requests(db, "big", MONITOR_FOLD_LIMIT + 1, 1_000)
  requests(db, "small", 3, 1_000_000)
  const context = { now: 10_000_000 }

  expect(() => queryMonitor(db, { scope: "all", view: "overview" }, context)).toThrow(MonitorFoldLimit)
  expect(() => queryMonitor(db, { scope: "all", view: "steps" }, context)).toThrow(MonitorFoldLimit)
  // A window holding only the small session folds three requests.
  expect(() => queryMonitor(db, { scope: "all", view: "overview", since: 999_999 }, context)).not.toThrow()
  // Saved-results views never fold.
  expect(() => queryMonitor(db, { scope: "all", view: "tools" }, context)).not.toThrow()

  sessionFold(db, "big")
  expect(() => queryMonitor(db, { scope: "all", view: "overview" }, context)).not.toThrow()
})

test("the monitor tool defaults to the cache view and reports a refused overview as its error", async () => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-fold-"))
  roots.push(root)
  process.env.XDG_DATA_HOME = path.join(root, "data")
  opened.push(defaultLedgerPath())
  const tools = toolHarness()
  const ctx = { ...fullContext({ directory: path.join(root, "project") }), tool: tools.domain }
  await registerMonitorTools(ctx)
  const call = (input: unknown) =>
    Effect.runPromise(
      (tools.tools.get("monitor_query") as Tool.Info)
        .execute(input as never, {
          sessionID: Session.ID.make("ses_big"),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_fold_test"),
          id: Tool.CallID.make("call_fold_test"),
          progress: () => Effect.void,
        })
        .pipe(
          Effect.map((result) => (result as { output: Record<string, unknown> }).output),
          Effect.catchTag("Tool.Error", (error) => Effect.succeed({ refused: error.message })),
        ),
    )
  requests(ledgerAt(), "ses_big", MONITOR_FOLD_LIMIT + 1, Date.now() - 1_000_000)

  // The cache view's shape: a request page, read from saved results.
  expect(Object.keys(await call({}))).toContain("requestPage")
  const refused = await call({ view: "overview" })
  expect(String(refused.refused)).toStartWith(`monitor.too_large: this report would first fold ${MONITOR_FOLD_LIMIT + 1} requests of 1 session`)
})
