import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createLedger, endRequestWindow } from "../src/monitor/ledger.js"
import { cleanupLedgers, collect, ledger, usage } from "./monitor-fixture.js"
import { CompactionObservation } from "@opencode/plugin/compaction-observation"
import { Schema } from "effect"
import { queryMonitor } from "../src/monitor/query.js"
import { Observation } from "../src/monitor/observation.js"

afterEach(cleanupLedgers)

test("early compaction attribution keeps the executed threshold snapshot through reopen", async () => {
  const db = await ledger()
  for (const trigger of ["input-threshold", "output-threshold"] as const) {
    db.requestStarted({ id: trigger, sessionID: "s", kind: "compaction", started: 100 })
    db.requestEnded(trigger, { ended: 200, status: "completed" })
    const compaction = { version: 1 as const, trigger, threshold: 1234, configuredStrategy: "auto" as const, strategySource: "built-in" as const, selectedStrategy: "native" as const, selectionReason: "auto-native" as const }
    db.requestObserved(trigger, { version: 1, completeness: "final", compaction })
    expect(db.getRequest(trigger)?.observation?.compaction).toEqual(compaction)
    expect(() => Schema.decodeUnknownSync(CompactionObservation)({ ...compaction, threshold: 0 })).toThrow()
    const reopened = createLedger(db.path)
    expect(reopened.getRequest(trigger)?.observation?.compaction).toEqual(compaction)
    reopened.close()
  }
})

test("native diagnostic boundary refuses unsupported versions, reasons and fabricated verdicts", async () => {
  const db = await ledger()
  db.requestStarted({ id: "native", sessionID: "s", kind: "step", started: 100 })
  db.requestEnded("native", { ended: 200, status: "completed" })
  const diagnostic = {
    version: 1 as const,
    source: "provider-reported" as const,
    protocol: "openai-responses" as const,
    outcome: "unknown" as const,
    reportedOutcome: "unavailable" as const,
    auth: "PRIVATE_AUTH", body: "PRIVATE_BODY", error: "PRIVATE_ERROR", prompt: "PRIVATE_PROMPT",
  }
  expect(() => db.requestObserved("native", { version: 1, completeness: "final", promptCacheDiagnostic: { ...diagnostic, outcome: "cache_miss" } })).toThrow()
  // Deliberately exercise the unknown input decoder rather than lying to the typed observer contract.
  const decode = Schema.decodeUnknownSync(Observation)
  expect(() => decode({ version: 1, completeness: "final", promptCacheDiagnostic: { ...diagnostic, version: 2 } })).toThrow()
  expect(() => decode({ version: 1, completeness: "final", promptCacheDiagnostic: { ...diagnostic, reason: "PRIVATE_REASON" } })).toThrow()
  expect(() => decode({ version: 1, completeness: "final", promptCacheDiagnostic: { ...diagnostic, cacheMissedTokens: Infinity } })).toThrow()
  db.requestObserved("native", { version: 1, completeness: "final", promptCacheDiagnostic: diagnostic })
  expect(db.getRequest("native")?.observation?.promptCacheDiagnostic).toEqual({
    version: 1, source: "provider-reported", protocol: "openai-responses", outcome: "unknown", reportedOutcome: "unavailable",
  })
  expect(JSON.stringify(db.db.query("select observation from request").all())).not.toContain("PRIVATE")
  const report = queryMonitor(db, { scope: "session", sessionID: "s", view: "cache", id: "native" }, { now: 300 })
  expect(report.detail?.request.promptCacheDiagnostic?.outcome).toBe("unknown")
  expect(report.detail?.request.measurement?.state).toBe("not-reported")
  expect(JSON.stringify(report)).not.toContain("PRIVATE")
})

test("execution decisions are allow-listed, immutable history; unsupported decision values refuse writes", async () => {
  const db = await ledger()
  db.requestStarted({ id: "decision", sessionID: "s", kind: "compaction", started: 100 })
  db.requestEnded("decision", { ended: 200, status: "error" })
  const decision = {
    version: 1 as const,
    trigger: "manual" as const,
    configuredStrategy: "auto" as const,
    strategySource: "built-in" as const,
    selectedStrategy: "text-summary" as const,
    selectionReason: "anthropic-below-minimum" as const,
    error: "SECRET PROVIDER ERROR",
    system: "SECRET SYSTEM TEXT",
    metadata: { "SECRET KEY": "SECRET VALUE" },
  }
  expect(() => Schema.decodeUnknownSync(CompactionObservation)({ ...decision, selectionReason: "SECRET REASON" })).toThrow()
  expect(() => Schema.decodeUnknownSync(CompactionObservation)({ ...decision, version: 99 })).toThrow()
  db.requestObserved("decision", { version: 1, completeness: "unavailable", compaction: decision })
  const stored = db.getRequest("decision")?.observation?.compaction
  expect(stored).toEqual({ version: 1, trigger: "manual", configuredStrategy: "auto", strategySource: "built-in", selectedStrategy: "text-summary", selectionReason: "anthropic-below-minimum" })
  db.requestObserved("decision", { version: 1, completeness: "unavailable", compaction: { ...decision, configuredStrategy: "remote", selectedStrategy: "native", selectionReason: "explicit-remote" } })
  expect(db.getRequest("decision")?.observation?.compaction).toEqual(stored)
  const reopened = createLedger(db.path)
  try {
    expect(reopened.getRequest("decision")?.observation?.compaction).toEqual(stored)
    expect(JSON.stringify(reopened.db.query("select observation from request").all())).not.toContain("SECRET")
    const report = queryMonitor(reopened, { scope: "session", sessionID: "s", view: "cache", id: "decision" }, { now: 300 })
    expect(report.detail?.request.compaction).toEqual(stored)
    expect(report.detail?.lines[0]).toContain("configured auto (built-in); selected text-summary; reason anthropic-below-minimum")
    expect(JSON.stringify(report)).not.toContain("SECRET")
  } finally {
    reopened.close()
  }
})

test("legacy rows remain unknown; exact observations are idempotent, allow-listed, and survive aggregate settlement", async () => {
  const db = await ledger()
  db.requestStarted({ id: "attempt", sessionID: "s", kind: "compaction", started: 110 })
  expect(db.getRequest("attempt")?.observation).toBeUndefined()
  db.requestEnded("attempt", {
    ended: 120,
    status: "completed",
    usage: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 1 },
  })
  const payload = {
    version: 1 as const,
    completeness: "final" as const,
    inputTokens: 10,
    cacheReadInputTokens: 0,
    headers: "PRIVATE HEADER",
    body: "PRIVATE BODY",
  }
  db.requestObserved("attempt", payload)
  db.requestObserved("attempt", { version: 1, completeness: "final", inputTokens: 999 })
  endRequestWindow(
    db,
    { id: "aggregate", sessionID: "s", kind: "compaction", started: 100, messageID: "compaction" },
    {
      ended: 200,
      status: "completed",
      usage: { input: 1000, output: 200, reasoning: 0, cacheRead: 500, cacheWrite: 0, cost: 20 },
    },
  )
  expect(db.getRequest("attempt")?.inputTokens).toBe(10)
  expect(db.getRequest("attempt")?.observation).toEqual({
    version: 1,
    completeness: "final",
    inputTokens: 10,
    cacheReadInputTokens: 0,
  })
  expect(db.getRequests("s")).toHaveLength(1)
  expect(JSON.stringify(db.db.query("select observation from request").all())).not.toContain("PRIVATE")
})

test("unknown payloads survive supported reopen and writes without supplying measurements", async () => {
  const db = await ledger()
  db.requestStarted({ id: "r", sessionID: "s", kind: "step", started: 100 })
  const future = '{"version":27,"completeness":"final","inputTokens":123,"future":{"opaque":true}}'
  db.db.query("update request set observation = ? where id = 'r'").run(future)
  const other = createLedger(db.path)
  try {
    expect(other.getRequest("r")?.observation).toEqual({ version: 27, completeness: "unavailable" })
    other.requestObserved("r", { version: 1, completeness: "final", inputTokens: 99 })
    other.requestEnded("r", { ended: 200, status: "completed" })
    expect(other.db.query<{ observation: string }, []>("select observation from request").get()?.observation).toBe(
      future,
    )
  } finally {
    other.close()
  }
})

test("schema-2 migrates without backfilling presence; future schema refuses before changing metadata or tables", async () => {
  const db = await ledger()
  db.requestStarted({ id: "legacy", sessionID: "s", kind: "step", started: 100 })
  // A schema-2 ledger has neither the column nor the later index that reads it.
  db.db.exec("drop index request_follow")
  db.db.exec("alter table request drop column observation")
  db.db.exec("update meta set value = '2' where key = 'schema'")
  const migrated = createLedger(db.path)
  try {
    expect(migrated.getRequest("legacy")?.observation).toBeUndefined()
  } finally {
    migrated.close()
  }
  db.db.exec("update meta set value = '987' where key = 'schema'")
  const tables = db.db.query("select sql from sqlite_master order by name").all()
  expect(() => createLedger(db.path)).toThrow("Unsupported monitor ledger schema")
  const read = new Database(db.path, { readonly: true })
  try {
    expect(read.query<{ value: string }, []>("select value from meta where key = 'schema'").get()?.value).toBe("987")
    expect(read.query("select sql from sqlite_master order by name").all()).toEqual(tables)
  } finally {
    read.close()
  }
})

test("ended Physical Attempt never suppresses logical Step start/end or retry dedup", async () => {
  const db = await ledger()
  db.requestStarted({ id: "failed-attempt", sessionID: "s", kind: "step", messageID: "A", started: 100 })
  db.requestEnded("failed-attempt", { ended: 110, status: "error" })
  const collector = collect(db, { now: 9000 })
  const start = {
    type: "session.step.started",
    created: 100,
    data: { sessionID: "s", assistantMessageID: "A", started: 100 },
  }
  const end = {
    type: "session.step.ended",
    created: 200,
    data: { sessionID: "s", assistantMessageID: "A", finish: "stop", tokens: usage(100, 10) },
  }
  collector.observe(start)
  collector.observe(end)
  collector.observe(start)
  collector.observe(end)
  expect(db.db.query("select idx, input, output, ended from step").all()).toEqual([
    { idx: 0, input: 100, output: 10, ended: 200 },
  ])
})

test("partial and nonfinite inclusive totals are refused at the persistence boundary", async () => {
  const db = await ledger()
  db.requestStarted({ id: "r", sessionID: "s", kind: "step", started: 100 })
  expect(() => db.requestObserved("r", { version: 1, completeness: "final", inputTokens: 10 })).toThrow("requires an ended request")
  expect(() =>
    db.requestObserved("r", {
      version: 1,
      completeness: "partial",
      inputTokens: 10,
      provenance: { inputTokens: { source: "derived", completeness: "partial" } },
    }),
  ).toThrow("Partial input total")
  expect(() => db.requestObserved("r", { version: 1, completeness: "final", inputTokens: Infinity })).toThrow()
  expect(db.getRequest("r")?.observation).toBeUndefined()
  db.requestEnded("r", { ended: 200, status: "error" })
  db.requestObserved("r", { version: 1, completeness: "partial", inputTokens: 10, cacheReadInputTokens: 11, cacheWriteInputTokens: -1 })
  expect(db.getRequest("r")?.observation).toMatchObject({ inconsistent: true, cacheWriteInputTokens: -1 })
})

test("provider-reported dropped thinking reaches the request, its detail and the step alert", async () => {
  const db = await ledger()
  db.requestStarted({ id: "dropped", sessionID: "s", kind: "step", started: 100 })
  db.requestEnded("dropped", { ended: 200, status: "completed" })
  const droppedThinking = { blocks: 2, first: "messages.1.content.0", reasons: ["prefix_binding_mismatch"] }
  db.requestObserved("dropped", { version: 1, completeness: "final", droppedThinking })
  expect(db.getRequest("dropped")?.observation?.droppedThinking).toEqual(droppedThinking)
  const reopened = createLedger(db.path)
  expect(reopened.getRequest("dropped")?.observation?.droppedThinking).toEqual(droppedThinking)
  reopened.close()
  const report = queryMonitor(db, { scope: "session", sessionID: "s", view: "cache", id: "dropped" }, { now: 300 })
  expect(report.detail?.request.droppedThinking).toEqual(droppedThinking)
  expect(report.detail?.lines).toContain(
    "Provider dropped 2 earlier thinking blocks before the model read this request, from messages.1.content.0 on; the answer was made without that reasoning. Reported reason: the request before them changed since they were written",
  )
})
