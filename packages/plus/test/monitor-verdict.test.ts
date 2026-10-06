// The verdict the Monitor puts on a request is what the user reads first, so
// these cases drive the real classification pipeline (ledger -> analyzeSession
// -> queryMonitor) with the exact Anthropic rolling-marker wire shape from
// session ses_eef806cfaffeVCcKl4cQ9YgF4u (provider cliproxyapi, model
// claude-opus-5-5, 5-minute prompt-cache TTL) and the expected-cold controls.
import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { isMiss } from "../src/monitor/cache.js"
import type { Ledger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(() => cleanupLedgers())

const PROVIDER = "cliproxyapi"
const MODEL = "claude-opus-5-5"
const VARIANT = "xhigh"

// Anthropic rolling breakpoints: the last message always carries the marker,
// so every step moves it. Message bodies are static unless a case replaces one
// (a tail edit) or `edits` rewrites an earlier historical message in place.
const anthropicBody = (
  system: string,
  count: number,
  lastText?: string,
  edits?: Readonly<Record<number, string>>,
) => ({
  model: MODEL,
  system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
  messages: Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [
      {
        type: "text",
        text: edits?.[i] ?? (i === count - 1 && lastText !== undefined ? lastText : `m${i}`),
        ...(i === count - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      },
    ],
  })),
  max_tokens: 1000,
})

interface Row {
  readonly id: string
  readonly at: number
  readonly kind?: "step" | "ping"
  readonly status?: "completed" | "error"
  readonly error?: string
  readonly read?: number
  readonly write?: number
  readonly input?: number
  readonly system?: string
  readonly count?: number
  readonly lastText?: string
  readonly edits?: Readonly<Record<number, string>>
  readonly provider?: string
  readonly model?: string
  readonly variant?: string
  readonly agent?: string
}

function record(db: Ledger, session: string, row: Row): string {
  // Request ids are globally unique in the ledger, so namespace by session.
  const id = `${session}-${row.id}`
  db.session({ id: session, agent: row.agent ?? "build", directory: "/project" }, row.at)
  db.requestStarted({
    id,
    sessionID: session,
    messageID: id,
    started: row.at,
    kind: row.kind ?? "step",
    provider: row.provider ?? PROVIDER,
    model: row.model ?? MODEL,
    variant: row.variant ?? VARIANT,
    agent: row.agent ?? "build",
  })
  db.requestFingerprint({
    requestID: id,
    sessionID: session,
    created: row.at,
    ...fingerprintWireBody(anthropicBody(row.system ?? "sys".repeat(4000), row.count ?? 1, row.lastText, row.edits), {
      protocol: "anthropic-messages",
    }),
  })
  db.requestEnded(id, {
    ended: row.at + 1,
    status: row.status ?? "completed",
    ...(row.error === undefined ? {} : { error: row.error }),
    usage: {
      input: row.input ?? 2,
      output: 100,
      reasoning: 0,
      cacheRead: row.read ?? 0,
      cacheWrite: row.write ?? 0,
      cost: 0,
    },
  })
  return id
}

const last = (db: Ledger, session: string, id: string) => {
  const report = queryMonitor(
    db,
    { scope: "session", sessionID: session, view: "cache", id: `${session}-${id}` },
    { now: 1_000_000_000_000 },
  )
  return report.detail!
}

test("a rolling-marker step that reused its prefix is a hit, not a prefix change", async () => {
  const db = await ledger()
  record(db, "rolling", { id: "a", at: 1000, count: 36, read: 83471, write: 1456 })
  record(db, "rolling", { id: "b", at: 2000, count: 37, read: 83500, write: 1400 })
  const detail = last(db, "rolling", "b")
  expect(detail.request.verdict).toBe("hit")
  expect(detail.request.expected).toBe(83471)
})

test("a large read drop with a changed reusable segment is a partial miss", async () => {
  const db = await ledger()
  // 12:02:24 step read 83471 write 1456, then 12:02:32 step read 38697 write
  // 32650 after the build agent's system prompt was edited in config.
  record(db, "partial", { id: "warm", at: 1000, count: 36, system: "sys".repeat(4000), read: 83471, write: 1456 })
  record(db, "partial", {
    id: "bust",
    at: 9459,
    count: 38,
    system: `${"sys".repeat(4000)} edited`,
    read: 38697,
    write: 32650,
  })
  const detail = last(db, "partial", "bust")
  expect(detail.request.verdict).toBe("partial")
  expect(detail.request.cause).toBe("prefix-changed")
  expect(detail.request.missTokens).toBe(44774)
  expect(detail.request.evidence).toContain("system part base template changed")
})

test("a full bust after an expired TTL names the gap and the failed keep-alive pings", async () => {
  const db = await ledger()
  const base = 1_000_000
  // 12:14:38 step read 143713; two errored keep-alive pings at 12:18:38 and
  // 12:22:41; idle 8.4 min > 5-minute TTL; 12:23:05 step read 0 write 147223.
  record(db, "expired", { id: "warm", at: base, count: 104, read: 143713, write: 661 })
  record(db, "expired", {
    id: "ping-1",
    at: base + 239_918,
    kind: "ping",
    status: "error",
    error: "overloaded_error",
    count: 106,
    read: 0,
    write: 0,
  })
  record(db, "expired", {
    id: "ping-2",
    at: base + 483_139,
    kind: "ping",
    status: "error",
    error: "overloaded_error",
    count: 106,
    read: 0,
    write: 0,
  })
  record(db, "expired", {
    id: "full",
    at: base + 506_943,
    count: 106,
    lastText: "rewritten context",
    read: 0,
    write: 147223,
  })
  const detail = last(db, "expired", "full")
  expect(detail.request.verdict).toBe("miss")
  expect(detail.request.cause).toBe("cache-expired")
  expect(detail.request.confidence).toBe("likely")
  expect(detail.request.missTokens).toBe(143713)
  expect(detail.request.evidence).toContain("gap 506943ms")
  expect(detail.request.evidence).toContain("2/2 failed")
})

test("an errored usage-less ping is its own non-hit outcome, not a cache verdict", async () => {
  const db = await ledger()
  record(db, "errored", { id: "warm", at: 1000, count: 104, read: 143713, write: 661 })
  record(db, "errored", {
    id: "ping",
    at: 2000,
    kind: "ping",
    status: "error",
    error: "overloaded_error",
    count: 106,
    read: 0,
    write: 0,
  })
  const detail = last(db, "errored", "ping")
  expect(detail.request.verdict).toBe("error")
  expect(detail.request.cause).toBeUndefined()
  expect(detail.request.verdict).not.toBe("hit")
  expect(isMiss(detail.request)).toBe(false)
  expect(detail.request.evidence).toContain("no cache usage")
})

test("expected-cold cases stay cold with their own cause", async () => {
  const db = await ledger()
  // First request of a session.
  record(db, "first", { id: "one", at: 1000, read: 0, write: 1000 })
  const first = last(db, "first", "one")
  expect(first.request.verdict).toBe("cold")
  expect(first.request.cause).toBe("unknown")
  expect(first.request.evidence).toContain("First recorded request")

  // First request after compaction.
  record(db, "compacted", { id: "warm", at: 1000, count: 4, read: 4000, write: 0 })
  db.contextFact({ sessionID: "compacted", at: 1500, kind: "compaction" })
  record(db, "compacted", { id: "after", at: 2000, count: 6, read: 0, write: 5000 })
  const after = last(db, "compacted", "after")
  expect(after.request.verdict).toBe("cold")
  expect(after.request.cause).toBe("compacted")
  expect(after.request.evidence).toContain("cold start expected")

  // First request after a model/variant switch.
  record(db, "switch", { id: "warm", at: 1000, count: 4, read: 4000, write: 0 })
  record(db, "switch", { id: "after", at: 2000, count: 6, read: 0, write: 5000, model: "claude-sonnet-5" })
  const switched = last(db, "switch", "after")
  expect(switched.request.verdict).toBe("cold")
  expect(switched.request.cause).toBe("model-switch")
})

test("an errored ping is not counted toward the followed-by-hit signal", async () => {
  const db = await ledger()
  record(db, "signals", { id: "warm", at: 1000, count: 36, read: 8000, write: 0 })
  record(db, "signals", {
    id: "ping",
    at: 2000,
    kind: "ping",
    status: "error",
    error: "overloaded_error",
    count: 36,
    read: 0,
    write: 0,
  })
  const report = queryMonitor(db, { scope: "session", sessionID: "signals", view: "overview" }, { now: 3000 })
  expect(report.pings).toMatchObject({ sent: 1, followedByHit: 0, followedByMiss: 0 })
})

test("an errored step is a failed request, not a cache miss or hit", async () => {
  const db = await ledger()
  record(db, "estep", { id: "warm", at: 1000, count: 36, read: 8000, write: 0 })
  record(db, "estep", { id: "failed", at: 2000, count: 38, status: "error", error: "429", read: 0, write: 0 })
  const detail = last(db, "estep", "failed")
  expect(detail.request.verdict).toBe("error")
  expect(detail.request.cause).toBeUndefined()
  expect(isMiss(detail.request)).toBe(false)
})

test("an expired gap that still reused its prefix is a hit, not a miss", async () => {
  const db = await ledger()
  // The provider sometimes keeps a prefix longer than its nominal TTL: the
  // observed read is what decides, not the clock alone.
  record(db, "kept", { id: "warm", at: 1000, count: 36, read: 10000, write: 0 })
  record(db, "kept", { id: "late", at: 400_000, count: 37, read: 10100, write: 200 })
  const detail = last(db, "kept", "late")
  expect(detail.request.verdict).toBe("hit")
  expect(detail.request.cause).toBeUndefined()
})

test("rotating endpoints and quota hand-offs still name their cause", async () => {
  const db = await ledger()
  record(db, "acct", { id: "warm", at: 1000, count: 36, read: 8000, write: 0 })
  db.contextFact({ sessionID: "acct", at: 1500, kind: "account_switch", detail: { previous: "a", alias: "b" } })
  record(db, "acct", { id: "after", at: 2000, count: 38, read: 0, write: 9000 })
  const detail = last(db, "acct", "after")
  expect(detail.request.verdict).toBe("miss")
  expect(detail.request.cause).toBe("account-changed")
  expect(detail.accounts[0]).toMatchObject({ from: "a", to: "b" })
})

test("a cold write creates the prefix; a following full rewrite is a miss", async () => {
  const db = await ledger()
  // First request of the session writes the whole prefix (read=0, write>=4096).
  record(db, "coldwrite", { id: "first", at: 1000, count: 40, read: 0, write: 20000 })
  const created = last(db, "coldwrite", "first")
  expect(created.request.verdict).toBe("cold")

  // The very next rolling-marker request reads 0 and rewrites the whole
  // prefix: the cold write proves a prefix existed and was not reused. No
  // model switch or compaction applies, so this is a provider-side bust.
  record(db, "coldwrite", { id: "rewrite", at: 2000, count: 42, read: 0, write: 21000 })
  const rewrite = last(db, "coldwrite", "rewrite")
  expect(rewrite.request.verdict).toBe("miss")
  expect(rewrite.request.cause).toBe("unknown")
  expect(rewrite.request.expected).toBe(20000)
  expect(rewrite.request.missTokens).toBe(20000)
  expect(rewrite.request.evidence).toContain("read 0 times")
})

test("a cold write followed by a successful read is a hit", async () => {
  const db = await ledger()
  record(db, "coldread", { id: "first", at: 1000, count: 40, read: 0, write: 20000 })
  record(db, "coldread", { id: "second", at: 2000, count: 42, read: 20500, write: 300 })
  const second = last(db, "coldread", "second")
  expect(second.request.verdict).toBe("hit")
  expect(second.request.cause).toBeUndefined()
})

test("a write-only baseline past the TTL names expiry and counts its cost", async () => {
  const db = await ledger()
  const base = 1_000_000
  record(db, "coldexpired", { id: "first", at: base, count: 40, read: 0, write: 20000 })
  db.contextFact({
    sessionID: "coldexpired",
    at: base + 1_000,
    kind: "pricing",
    detail: { provider: PROVIDER, model: MODEL, rates: [{ input: 2, output: 5, cache: { read: 0.1, write: 3 } }] },
  })
  record(db, "coldexpired", { id: "late", at: base + 400_000, count: 42, read: 0, write: 21000 })
  const late = last(db, "coldexpired", "late")
  expect(late.request.verdict).toBe("miss")
  expect(late.request.cause).toBe("cache-expired")
  expect(late.request.missTokens).toBe(20000)
  // 20000 written at the cache-write rate 3/Mtok = 0.06.
  expect(late.request.missCost).toBeCloseTo(0.06)
})

test("a cold write does not mask a real model switch as a miss", async () => {
  const db = await ledger()
  record(db, "coldswitch", { id: "first", at: 1000, count: 40, read: 0, write: 20000 })
  record(db, "coldswitch", { id: "switch", at: 2000, count: 42, read: 0, write: 21000, model: "claude-sonnet-5" })
  const switched = last(db, "coldswitch", "switch")
  expect(switched.request.verdict).toBe("cold")
  expect(switched.request.cause).toBe("model-switch")
})

test("an errored request's tokens never move the hit rate but stay in totals", async () => {
  const db = await ledger()
  record(db, "erated", { id: "warm", at: 1000, count: 36, read: 8000, write: 0 })
  // The error row carries a large real input count, which must not be added to
  // the rate denominator. Old behavior: 8000 / (8000 + 2 + 8000) ≈ 0.5;
  // correct: 8000 / (8000 + 2) ≈ 0.99975.
  record(db, "erated", {
    id: "failed",
    at: 2000,
    kind: "ping",
    status: "error",
    error: "overloaded_error",
    count: 38,
    read: 0,
    write: 0,
    input: 8000,
  })
  const report = queryMonitor(
    db,
    { scope: "session", sessionID: "erated", view: "overview" },
    { now: 3000 },
  )
  const failed = queryMonitor(
    db,
    { scope: "session", sessionID: "erated", view: "cache", id: "erated-failed" },
    { now: 3000 },
  ).detail?.request
  expect(failed).toMatchObject({ verdict: "error", error: expect.any(String) })
  expect(report.totals.hitRate).toBeCloseTo(8000 / 8002, 6)
  // Tokens and requests are unchanged: input 2 + 8000, requests 2.
  expect(report.totals.input).toBe(8002)
  expect(report.totals.requests).toBe(2)
  expect(report.agents?.find((a) => a.agent === "build")?.hitRate).toBeCloseTo(8000 / 8002, 6)
  const sessions = queryMonitor(db, { scope: "session", sessionID: "erated", view: "sessions" }, { now: 3000 })
  expect(sessions.sessions?.find((s) => s.sessionID === "erated")?.hitRate).toBeCloseTo(8000 / 8002, 6)
  expect(sessions.sessions?.find((s) => s.sessionID === "erated")?.input).toBe(8002)
})

test("historical-message edits are a real prefix change; tail growth and rolling markers are not", async () => {
  const db = await ledger()
  // An early historical message is rewritten in place while the system prompt,
  // tools and rolling markers stay the same.
  record(db, "hist", { id: "warm", at: 1000, count: 6, read: 8000, write: 0 })
  record(db, "hist", { id: "edit", at: 2000, count: 6, read: 0, write: 9000, edits: { 1: "EDITED" } })
  const edited = last(db, "hist", "edit")
  expect(edited.request.verdict).toBe("miss")
  expect(edited.request.cause).toBe("prefix-changed")
  expect(edited.request.evidence).toContain("message 2 (text) changed")

  // Control: pure tail growth keeps the rolling-marker prefix and is not a
  // prefix change.
  record(db, "tail", { id: "warm", at: 1000, count: 6, read: 8000, write: 0 })
  record(db, "tail", { id: "grow", at: 2000, count: 8, read: 8100, write: 100 })
  const grown = last(db, "tail", "grow")
  expect(grown.request.verdict).toBe("hit")
  expect(grown.request.cause).toBeUndefined()

  // Control: replacing the last (tail) message is conversation growth, not a
  // prefix edit.
  record(db, "lastedit", { id: "warm", at: 1000, count: 6, read: 8000, write: 0 })
  record(db, "lastedit", { id: "replace", at: 2000, count: 6, read: 8100, write: 100, lastText: "new tail" })
  const replaced = last(db, "lastedit", "replace")
  expect(replaced.request.verdict).toBe("hit")
  expect(replaced.request.cause).toBeUndefined()
})
