import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import type { Ledger } from "../src/monitor/ledger.js"
import { monitorStep } from "../src/monitor/plugin.js"
import { queryMonitor } from "../src/monitor/query.js"
import { sessionFoldResumeFrom } from "../src/monitor/report.js"
import { context } from "./harness.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

const PROVIDER = "anthropic"
const MODEL = "claude-sonnet-4"
const VARIANT = "default"

const anthropicBody = (
  system: string,
  count: number,
  lastText?: string,
  marker = count - 1,
) => ({
  model: MODEL,
  system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
  messages: Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [
      {
        type: "text",
        text: i === count - 1 && lastText !== undefined ? lastText : `m${i}`,
        ...(i === marker ? { cache_control: { type: "ephemeral" } } : {}),
      },
    ],
  })),
  max_tokens: 1000,
})

interface Row {
  readonly id: string
  readonly at: number
  readonly kind?: "step" | "ping"
  readonly status?: "completed" | "error" | "running"
  readonly read?: number
  readonly write?: number
  readonly input?: number
  readonly system?: string
  readonly count?: number
  readonly lastText?: string
}

function record(db: Ledger, session: string, row: Row): string {
  const id = `${session}-${row.id}`
  db.session({ id: session, agent: "build", directory: "/project" }, row.at)
  db.requestStarted({
    id,
    sessionID: session,
    messageID: id,
    started: row.at,
    kind: row.kind ?? "step",
    provider: PROVIDER,
    model: MODEL,
    variant: VARIANT,
    agent: "build",
  })
  db.requestFingerprint({
    requestID: id,
    sessionID: session,
    created: row.at,
    ...fingerprintWireBody(anthropicBody(row.system ?? "sys".repeat(4000), row.count ?? 1, row.lastText), {
      protocol: "anthropic-messages",
    }),
  })
  if (row.status !== "running") {
    db.requestEnded(id, {
      ended: row.at + 1,
      status: row.status ?? "completed",
      usage: {
        input: row.input ?? 2,
        output: 100,
        reasoning: 0,
        cacheRead: row.read ?? 0,
        cacheWrite: row.write ?? 0,
        cost: 0,
      },
    })
  }
  return id
}

afterEach(async () => {
  await cleanupLedgers()
})

test("a session whose legacy last step has positive reads -> miss:false without quantifying reuse", async () => {
  const db = await ledger()
  const ctx = context()
  record(db, "ses_hit", { id: "1", at: 1000, count: 2, read: 0, write: 5000 })
  record(db, "ses_hit", { id: "2", at: 2000, count: 3, read: 5000, write: 200 })

  const result = await monitorStep(ctx, { sessionID: "ses_hit" }, db)
  expect(result.status).toBe("ready")
  if (result.status === "ready") {
    expect(result.miss).toBe(false)
    expect(result.notReused).toBe(0)
    expect(result.stepID).toBe("ses_hit-2")
    expect(result.requestID).toBe("ses_hit-2")
  }
})

test("a legacy prefix change remains an observed fact, not a supported miss", async () => {
  const db = await ledger()
  const ctx = context()
  record(db, "ses_prefix", { id: "1", at: 1000, count: 2, system: "alpha".repeat(1000), read: 0, write: 5000 })
  record(db, "ses_prefix", { id: "2", at: 2000, count: 2, system: "beta".repeat(1000), read: 0, write: 5000 })

  const result = await monitorStep(ctx, { sessionID: "ses_prefix" }, db)
  expect(result.status).toBe("ready")
  if (result.status === "ready") {
    expect(result.miss).toBe(false)
    expect(result.cause).toBe("prefix-changed")
    expect(result.changedPart).toBeDefined()
    expect(result.causeText).toBe("observed: prompt changed · system wire")
    expect(result.notReused).toBe(0)
  }
})

test("a drop under 1,024 -> miss:false", async () => {
  const db = await ledger()
  const ctx = context()
  record(db, "ses_drop", { id: "1", at: 1000, count: 2, read: 5000, write: 0 })
  // Drop of 500 tokens is under 1,024 threshold
  record(db, "ses_drop", { id: "2", at: 2000, count: 3, read: 4500, write: 500 })

  const result = await monitorStep(ctx, { sessionID: "ses_drop" }, db)
  expect(result.status).toBe("ready")
  if (result.status === "ready") {
    expect(result.miss).toBe(false)
  }
})

test("unrecorded step -> pending", async () => {
  const db = await ledger()
  const ctx = context()
  // Empty session
  const empty = await monitorStep(ctx, { sessionID: "ses_empty" }, db)
  expect(empty).toEqual({ status: "pending" })

  // Running step
  record(db, "ses_run", { id: "1", at: 1000, status: "running" })
  const running = await monitorStep(ctx, { sessionID: "ses_run" }, db)
  expect(running).toEqual({ status: "pending" })
})

test("a second call after one more row folds only from the new row", async () => {
  const db = await ledger()
  const ctx = context()
  record(db, "ses_inc", { id: "1", at: 1000, count: 2, read: 0, write: 4000 })

  const first = await monitorStep(ctx, { sessionID: "ses_inc" }, db)
  expect(first.status).toBe("ready")
  expect(sessionFoldResumeFrom(db, "ses_inc")).toBe(0)

  // Append one more row
  record(db, "ses_inc", { id: "2", at: 2000, count: 3, read: 4000, write: 100 })

  const second = await monitorStep(ctx, { sessionID: "ses_inc" }, db)
  expect(second.status).toBe("ready")
  // Fold resumed from index 1, folding only the new row
  expect(sessionFoldResumeFrom(db, "ses_inc")).toBe(1)
})

test("quota.switch compaction -> account changed · compacted first and /monitor report shows the same", async () => {
  const db = await ledger()
  const ctx = context()
  record(db, "ses_quota", { id: "1", at: 1000, count: 2, read: 4000, write: 0 })
  db.contextFact({
    sessionID: "ses_quota",
    at: 1500,
    kind: "compaction",
    detail: { "quota.switch": true },
  })
  record(db, "ses_quota", { id: "2", at: 2000, count: 2, read: 0, write: 5000 })

  const result = await monitorStep(ctx, { sessionID: "ses_quota" }, db)
  expect(result.status).toBe("ready")
  if (result.status === "ready") {
    expect(result.cause).toBe("account-changed-compacted-first")
    expect(result.causeText).toBe("observed: account changed · compacted first")
    expect(result.miss).toBe(false)
    expect(result.notReused).toBe(0)
  }

  // /monitor's report shows the same
  const report = queryMonitor(
    db,
    { scope: "session", sessionID: "ses_quota", view: "cache", id: "ses_quota-2" },
    { now: 3000 },
  )
  expect(report.detail?.request.cause).toBe("account-changed-compacted-first")
  expect(report.detail?.request.causeText).toBe("observed: account changed · compacted first")
  expect(report.detail?.request.measurement?.state).toBe("legacy-unknown")
})
