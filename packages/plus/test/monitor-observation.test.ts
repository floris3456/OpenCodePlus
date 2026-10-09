import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createLedger, endRequestWindow } from "../src/monitor/ledger.js"
import { cleanupLedgers, collect, ledger, usage } from "./monitor-fixture.js"
import { CompactionObservation } from "@opencode/plugin/compaction-observation"
import { Schema } from "effect"

afterEach(cleanupLedgers)

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
