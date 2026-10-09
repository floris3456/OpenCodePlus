import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionModelObserved } from "@opencode/plugin/effect/session"
import { recordModelObservation } from "../src/monitor/model-observation.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, collect, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

test("synthetic fallback exports correlation and counts one invocation, not its exchange children", async () => {
  const db = await ledger()
  const event: SessionModelObserved = {
    sessionID: Session.ID.make("ses_synthetic"), agent: Agent.ID.make("build"),
    model: Model.Ref.make({ providerID: Provider.ID.make("synthetic"), id: Model.ID.make("fixture") }),
    kind: "primary", invocationID: "invocation", operationID: "operation", messageID: "message",
    started: 10, ended: 30, outcome: "completed",
    usage: { version: 1, completeness: "final", inputTokens: 1000, cacheReadInputTokens: 100, cacheWriteInputTokens: 900, nonCachedInputTokens: 0, outputTokens: 1, reasoningTokens: undefined, provenance: undefined, inconsistent: false },
    accounting: { tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 100, write: 900 } }, cost: 0.01 },
    exchanges: [
      { requestID: "ws", transport: "websocket", started: 11, outcome: "prepared" },
      { requestID: "http", transport: "http", started: 12, outcome: "response" },
    ], exchangeCount: 2,
  }
  db.stepStarted({ sessionID: "ses_synthetic", messageID: "message", kind: "step", idx: 1, epoch: 0, started: 10 })
  db.stepEnded("ses_synthetic", "message", 30, "stop", { input: 0, output: 1, reasoning: 0, cacheRead: 100, cacheWrite: 900, cost: 0.01 })
  recordModelObservation(db, event)
  const report = queryMonitor(db, { scope: "session", sessionID: "ses_synthetic", view: "cache", id: "invocation" }, { now: 100 })
  expect(report.totals).toMatchObject({ requests: 1, exchangeRows: 2, steps: 1, cost: 0.01, cacheRead: 100, cacheWrite: 900, hitRate: 0.1, measuredRequests: 1, unknownRequests: 0 })
  expect(report.requests).toHaveLength(3) // No diagnostic exchange result was omitted.
  expect(report.detail?.request).toMatchObject({ outcome: "completed", measurement: { scope: "invocation", invocationID: "invocation", operationID: "operation", exchangeCount: 2 } })
  expect(report.requests?.filter((r) => r.measurement?.scope === "exchange").map((r) => r.outcome)).toEqual(["unknown", "unknown"])
  expect(queryMonitor(db, { scope: "session", sessionID: "ses_synthetic", view: "sessions" }, { now: 100 }).sessions?.[0]).toMatchObject({ requests: 1, steps: 1, measuredRequests: 1, unknownRequests: 0 })
  expect(queryMonitor(db, { scope: "session", sessionID: "ses_synthetic", view: "overview" }, { now: 100 }).agents?.[0]?.steps).toBe(1)
  recordModelObservation(db, { ...event, accounting: { ...event.accounting!, cost: 100 } })
  expect(queryMonitor(db, { scope: "session", sessionID: "ses_synthetic", view: "cache" }, { now: 100 }).totals).toEqual(report.totals)
})

test("serialized compaction aggregate never adds its already observed invocation usage twice", async () => {
  const db = await ledger()
  const collector = collect(db, { now: 100 })
  collector.observe({ type: "session.compaction.started", created: 1, data: { sessionID: "ses_compact" } })
  for (const started of [10, 20]) {
    recordModelObservation(db, {
      sessionID: Session.ID.make("ses_compact"), agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID: Provider.ID.make("synthetic"), id: Model.ID.make("fixture") }),
      kind: "compaction", invocationID: `invocation-${started}`, operationID: "operation",
      started, ended: started + 1, outcome: "completed", exchanges: [], exchangeCount: 0,
      usage: { version: 1, completeness: "final", inputTokens: 1000, cacheReadInputTokens: 100, cacheWriteInputTokens: 900, nonCachedInputTokens: 0, outputTokens: 1, reasoningTokens: undefined, provenance: undefined, inconsistent: false },
      accounting: { tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 100, write: 900 } }, cost: 0.01 },
    })
  }
  const ended = { type: "session.compaction.failed", created: 30, data: { sessionID: "ses_compact", cost: 0.02, tokens: { input: 0, output: 2, reasoning: 0, cache: { read: 200, write: 1800 } } } }
  collector.observe(ended)
  const report = queryMonitor(db, { scope: "session", sessionID: "ses_compact", view: "cache" }, { now: 100 })
  expect(report.totals).toMatchObject({ requests: 2, steps: 1, cacheRead: 200, cacheWrite: 1800, output: 2, cost: 0.02, measuredRequests: 2, unknownRequests: 0 })
  expect(report.requests?.map((r) => r.outcome)).toEqual(["completed", "completed"])
  collector.observe(ended)
  expect(queryMonitor(db, { scope: "session", sessionID: "ses_compact", view: "cache" }, { now: 100 }).totals).toEqual(report.totals)
  expect(db.db.query("select cache_read, cache_write, cost, finish from step").all()).toEqual([{ cache_read: 200, cache_write: 1800, cost: 0.02, finish: "error" }])
})
