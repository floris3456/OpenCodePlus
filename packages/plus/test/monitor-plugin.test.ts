import { afterEach, expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Agent } from "@opencode/schema/agent"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Stream } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../src/index.js"
import { teamsDataDir } from "../src/instructions/paths.js"
import { defaultLedgerPath, ledgerAt } from "../src/monitor/ledger.js"
import { watchMonitor } from "../src/monitor/plugin.js"
import { registerMonitorTools } from "../src/monitor/tools.js"
import { context, fullContext, toolHarness } from "./harness.js"
import { script, usage } from "./monitor-fixture.js"

const priorData = process.env.XDG_DATA_HOME
const roots: string[] = []
// Only ledgers this file opened under a temporary data home are closed; the
// environment's real data directory is never touched.
const opened: string[] = []

afterEach(async () => {
  opened.splice(0).forEach((file) => ledgerAt(file).close())
  if (priorData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorData
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function dataHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-plugin-"))
  roots.push(root)
  process.env.XDG_DATA_HOME = path.join(root, "data")
  opened.push(defaultLedgerPath())
  return root
}

function chat(clock: { now: number }) {
  const s = script("ses_live", clock)
  s.created({ agent: "build" })
  s.step("m1")
  s.call("m1", "c1", "read", { path: "/workspace/src/a.ts" })
  s.ok("m1", "c1", "a".repeat(2_500))
  s.end("m1", "tool-calls", usage(100, 30, 1_000))
  s.step("m2")
  s.end("m2", "stop", usage(100, 10, 2_130))
  return s.events
}

test("the plugin records the host's event stream into the ledger at the data directory", async () => {
  await dataHome()
  const ctx = context({
    event: { subscribe: () => Stream.fromIterable(chat({ now: 1_000 })) as never },
    session: { get: () => Effect.succeed({ id: Session.ID.make("ses_live"), title: "Live chat" }) as never },
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(ctx, () => "cfg-1")
        yield* Effect.sleep("30 millis")
      }),
    ),
  )
  expect(path.dirname(defaultLedgerPath())).toBe(path.dirname(teamsDataDir()))
  expect(defaultLedgerPath().startsWith(process.env.XDG_DATA_HOME ?? "missing")).toBe(true)
  const handlers = createHandlers(ctx, createState())
  const report = await Effect.runPromise(
    handlers["monitor.query"]({ scope: "session", sessionID: "ses_live", feed: 5 }, {} as never),
  )
  // Prompt growth 2 230 − 1 100, minus the 30 tokens m1 wrote itself.
  expect(report.totals).toMatchObject({ steps: 2, calls: 1, callTokens: 30, resultTokens: 1_100, carried: 1_100 })
  expect(report.feed[0]).toMatchObject({ tool: "read", target: "src/a.ts", measured: true })
  const byConfig = await Effect.runPromise(handlers["monitor.query"]({ scope: "all", group: "config" }, {} as never))
  expect(byConfig.groups.map((group) => group.key)).toEqual(["cfg-1"])
  // The session lookup filled in what the event stream did not carry.
  expect(ledgerAt().db.query("select title, agent from session where id = 'ses_live'").get()).toEqual({
    title: "Live chat",
    agent: "build",
  })
  const mark = await Effect.runPromise(handlers["monitor.mark"]({ label: "  before  " }, {} as never))
  expect(mark.label).toBe("before")
  const marks = await Effect.runPromise(handlers["monitor.query"]({ scope: "all" }, {} as never))
  expect(marks.marks.map((entry) => entry.label)).toEqual(["before"])
})

test("the ledger opens only when a monitored event arrives, and a broken one is tried once", async () => {
  const quiet = context({
    event: { subscribe: () => Stream.fromIterable([{ type: "session.text.delta", data: {} }]) as never },
  })
  let opens = 0
  const refuse = () => {
    opens += 1
    throw new Error("read-only file system")
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(quiet, () => undefined, refuse)
        yield* Effect.sleep("20 millis")
      }),
    ),
  )
  // Nothing monitored happened: nothing was opened.
  expect(opens).toBe(0)
  const busy = context({ event: { subscribe: () => Stream.fromIterable(chat({ now: 1 })) as never } })
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(busy, () => undefined, refuse)
        yield* Effect.sleep("20 millis")
      }),
    ),
  )
  // Six monitored events, one attempt; the watcher itself never fails.
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(opens).toBe(1)
})

test("the monitor tools answer for the calling chat and record marks", async () => {
  const root = await dataHome()
  const tools = toolHarness()
  const ctx = fullContext({ directory: path.join(root, "project") })
  const withEvents: typeof ctx = {
    ...ctx,
    event: { subscribe: () => Stream.fromIterable(chat({ now: 2_000 })) as never },
    tool: tools.domain,
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(withEvents, () => undefined)
        yield* Effect.sleep("30 millis")
      }),
    ),
  )
  await registerMonitorTools(withEvents)
  const call = (id: string, input: unknown, sessionID = "ses_live") =>
    Effect.runPromise(
      (tools.tools.get(id) as Tool.Info)
        .execute(input as never, {
          sessionID: Session.ID.make(sessionID),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_monitor_test"),
          id: Tool.CallID.make("call_monitor_test"),
          progress: () => Effect.void,
        })
        .pipe(
          Effect.map((result) => (result as { output: unknown }).output),
          Effect.catchTag("Tool.Error", (error) => Effect.succeed(error)),
        ),
    )
  const own = (await call("monitor_query", {})) as { totals: { calls: number } }
  expect(own.totals.calls).toBe(1)
  // Another chat sees nothing of this one in its own (default) session scope.
  const other = (await call("monitor_query", {}, "ses_other")) as { totals: { calls: number } }
  expect(other.totals.calls).toBe(0)
  const windowed = (await call("monitor_query", { scope: "all", window: "1h", compare: { window: "1h" } })) as {
    compare?: unknown
  }
  expect(windowed.compare).toBeDefined()
  const refused = (await call("monitor_query", { window: "soon" })) as Tool.Error
  expect(refused.message).toContain('window "soon"')
  const mark = (await call("monitor_mark", { label: "switch to opus" })) as { label: string }
  expect(mark.label).toBe("switch to opus")
})
