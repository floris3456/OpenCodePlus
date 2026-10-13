// The verdict the Monitor puts on a request is what the user reads first, so
// these legacy accounting cases drive the real classification pipeline (ledger -> analyzeSession
// -> queryMonitor) with the exact Anthropic rolling-marker wire shape from
// session ses_eef806cfaffeVCcKl4cQ9YgF4u (provider cliproxyapi, model
// claude-opus-5-5, requested ephemeral retention) and the first-request controls.
import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { isMiss } from "../src/monitor/cache.js"
import type { Ledger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import type { Plus } from "../src/rpc.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(() => cleanupLedgers())

const PROVIDER = "cliproxyapi"
const MODEL = "claude-opus-5-5"
const VARIANT = "xhigh"

// Anthropic rolling breakpoints: a step's last message carries the marker, so
// every step moves it. A keep-alive ping keeps it on the history's last message
// (`marker`) and appends its private prompt uncached after it. Message bodies
// are static unless a case replaces one (a tail edit) or `edits` rewrites an
// earlier historical message in place.
const anthropicBody = (
  system: string,
  count: number,
  lastText?: string,
  edits?: Readonly<Record<number, string>>,
  marker = count - 1,
) => ({
  model: MODEL,
  system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
  messages: Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [
      {
        type: "text",
        text: edits?.[i] ?? (i === count - 1 && lastText !== undefined ? lastText : `m${i}`),
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
  readonly status?: "completed" | "error"
  readonly error?: string
  readonly read?: number
  readonly write?: number
  readonly input?: number
  readonly system?: string
  readonly count?: number
  readonly lastText?: string
  readonly edits?: Readonly<Record<number, string>>
  readonly marker?: number
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
    ...fingerprintWireBody(anthropicBody(row.system ?? "sys".repeat(4000), row.count ?? 1, row.lastText, row.edits, row.marker), {
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

// requestEnded preserves accounting, not sparse provider field presence. Neither
// positive historical reads nor stored zeros establish a measured shortfall.
function legacy(request: Plus.MonitorRequest) {
  expect(request).toMatchObject({ verdict: "none", confidence: "unknown", missTokens: 0, measurement: { state: "legacy-unknown" } })
  expect(request.expected).toBeUndefined()
  expect(request.measurement?.share).toBeUndefined()
  expect(request.evidence).toContain("field presence unknown")
  expect(isMiss(request)).toBe(false)
}

test("legacy rolling-marker reads retain accounting without asserting a hit or prefix change", async () => {
  const db = await ledger()
  record(db, "rolling", { id: "a", at: 1000, count: 36, read: 83471, write: 1456 })
  record(db, "rolling", { id: "b", at: 2000, count: 37, read: 83500, write: 1400 })
  const detail = last(db, "rolling", "b")
  legacy(detail.request)
  expect(detail.request).toMatchObject({ cacheRead: 83500, cacheWrite: 1400 })
  expect(detail.request.cause).toBe("unknown")
})

test("a legacy read drop retains the system edit but cannot quantify a partial miss", async () => {
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
  legacy(detail.request)
  expect(detail.request.cause).toBe("prefix-changed")
  expect(detail.request).toMatchObject({ cacheRead: 38697, cacheWrite: 32650 })
  expect(detail.request.evidence).toContain("system wire changed")
})

test("legacy zero after a long gap retains failed pings without asserting expiry", async () => {
  const db = await ledger()
  const base = 1_000_000
  // 12:14:38 step read 143713; two errored keep-alive pings at 12:18:38 and
  // 12:22:41; idle 8.4 min > 5-minute TTL; 12:23:05 step read 0 write 147223.
  // As recorded, the pings mark messages[104] and append an uncached prompt at
  // messages[105]; the step then marks messages[105], so messages[104] differs
  // from the ping's only by its moved marker.
  record(db, "expired", { id: "warm", at: base, count: 104, read: 143713, write: 661 })
  record(db, "expired", {
    id: "ping-1",
    at: base + 239_918,
    kind: "ping",
    status: "error",
    error: "overloaded_error",
    count: 106,
    marker: 104,
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
    marker: 104,
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
  legacy(detail.request)
  expect(detail.request.cacheWrite).toBe(147223)
  expect(detail.request.cause).toBe("cache-expired")
  expect(detail.timing.lastPingAt).toBe(base + 483_139)
  expect(detail.timing.warming).toBe("failed")
  expect(detail.pings).toHaveLength(2)
  expect(detail.pings.every((ping) => ping.error !== undefined)).toBe(true)
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
  expect(detail.request.evidence).toContain("measurement is independent")
})

test("legacy first, compacted and switched requests retain facts without asserting cold", async () => {
  const db = await ledger()
  // First request of a session.
  record(db, "first", { id: "one", at: 1000, read: 0, write: 1000 })
  const first = last(db, "first", "one")
  legacy(first.request)
  expect(first.request.cause).toBe("unknown")
  expect(first.previous).toBeUndefined()

  // First request after compaction.
  record(db, "compacted", { id: "warm", at: 1000, count: 4, read: 4000, write: 0 })
  db.contextFact({ sessionID: "compacted", at: 1500, kind: "compaction" })
  record(db, "compacted", { id: "after", at: 2000, count: 6, read: 0, write: 5000 })
  const after = last(db, "compacted", "after")
  expect(after.request).toMatchObject({ verdict: "none", missTokens: 0, measurement: { state: "legacy-unknown" } })
  expect(after.request.cause).toBe("compacted")
  expect(after.request.evidence).toContain("Compaction occurred")

  // First request after a model/variant switch.
  record(db, "switch", { id: "warm", at: 1000, count: 4, read: 4000, write: 0 })
  record(db, "switch", { id: "after", at: 2000, count: 6, read: 0, write: 5000, model: "claude-sonnet-5" })
  const switched = last(db, "switch", "after")
  legacy(switched.request)
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

test("legacy positive reads after a long gap cannot be overwritten by an expiry verdict", async () => {
  const db = await ledger()
  // A nominal retention window is not proof of expiry, and positive stored
  // reads are accounting evidence even when sparse observation is unavailable.
  record(db, "kept", { id: "warm", at: 1000, count: 36, read: 10000, write: 0 })
  record(db, "kept", { id: "late", at: 400_000, count: 37, read: 10100, write: 200 })
  const detail = last(db, "kept", "late")
  legacy(detail.request)
  expect(detail.request.cacheRead).toBe(10100)
  expect(detail.request.cause).toBe("cache-expired")
})

test("rotating endpoints and quota hand-offs still name their cause", async () => {
  const db = await ledger()
  record(db, "acct", { id: "warm", at: 1000, count: 36, read: 8000, write: 0 })
  db.contextFact({ sessionID: "acct", at: 1500, kind: "account_switch", detail: { previous: "a", alias: "b" } })
  record(db, "acct", { id: "after", at: 2000, count: 38, read: 0, write: 9000 })
  const detail = last(db, "acct", "after")
  legacy(detail.request)
  expect(detail.request.cause).toBe("account-changed")
  expect(detail.accounts[0]).toMatchObject({ from: "a", to: "b" })
})

test("legacy writes retain sizes but cannot establish an eligible warmed prefix", async () => {
  const db = await ledger()
  // First request of the session writes the whole prefix (read=0, write>=4096).
  record(db, "coldwrite", { id: "first", at: 1000, count: 40, read: 0, write: 20000 })
  const created = last(db, "coldwrite", "first")
  legacy(created.request)

  // Stored write counts do not locate an eligible boundary or prove a bust.
  record(db, "coldwrite", { id: "rewrite", at: 2000, count: 42, read: 0, write: 21000 })
  const rewrite = last(db, "coldwrite", "rewrite")
  legacy(rewrite.request)
  expect(rewrite.request.cause).toBe("unknown")
  expect(rewrite.request.cacheWrite).toBe(21000)
})

test("legacy write followed by positive reads retains both counters without a measured hit", async () => {
  const db = await ledger()
  record(db, "coldread", { id: "first", at: 1000, count: 40, read: 0, write: 20000 })
  record(db, "coldread", { id: "second", at: 2000, count: 42, read: 20500, write: 300 })
  const second = last(db, "coldread", "second")
  legacy(second.request)
  expect(second.request).toMatchObject({ cacheRead: 20500, cacheWrite: 300 })
  expect(second.request.cause).toBe("unknown")
})

test("pricing cannot turn a legacy write-only baseline into an expiry loss", async () => {
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
  legacy(late.request)
  expect(late.request.cause).toBe("cache-expired")
  expect(late.request.cacheWrite).toBe(21000)
  expect(late.request.missCost).toBeUndefined() // Legacy usage cannot establish a zero-priced shortfall.
})

test("a legacy write does not mask an observed model switch or fabricate a miss", async () => {
  const db = await ledger()
  record(db, "coldswitch", { id: "first", at: 1000, count: 40, read: 0, write: 20000 })
  record(db, "coldswitch", { id: "switch", at: 2000, count: 42, read: 0, write: 21000, model: "claude-sonnet-5" })
  const switched = last(db, "coldswitch", "switch")
  legacy(switched.request)
  expect(switched.request.cause).toBe("model-switch")
})

test("legacy and errored accounting stays in totals but never enters a measured ratio", async () => {
  const db = await ledger()
  record(db, "erated", { id: "warm", at: 1000, count: 36, read: 8000, write: 0 })
  // Neither legacy row has a usable measurement denominator. The failed row's
  // accounting still contributes to totals, not to a guessed reuse ratio.
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
  expect(report.totals.hitRate).toBeUndefined()
  // Tokens and requests are unchanged: input 2 + 8000, requests 2.
  expect(report.totals.input).toBe(8002)
  expect(report.totals.requests).toBe(2)
  expect(report.totals.cacheRead).toBe(8000)
  expect(report.agents?.find((a) => a.agent === "build")?.hitRate).toBeUndefined()
  const sessions = queryMonitor(db, { scope: "session", sessionID: "erated", view: "sessions" }, { now: 3000 })
  expect(sessions.sessions?.find((s) => s.sessionID === "erated")?.hitRate).toBeUndefined()
  expect(sessions.sessions?.find((s) => s.sessionID === "erated")?.input).toBe(8002)
})

test("historical-message edits are a real prefix change; tail growth and rolling markers are not", async () => {
  const db = await ledger()
  // An early historical message is rewritten in place while the system prompt,
  // tools and rolling markers stay the same.
  record(db, "hist", { id: "warm", at: 1000, count: 6, read: 8000, write: 0 })
  record(db, "hist", { id: "edit", at: 2000, count: 6, read: 0, write: 9000, edits: { 1: "EDITED" } })
  const edited = last(db, "hist", "edit")
  legacy(edited.request)
  expect(edited.request.cause).toBe("prefix-changed")
  expect(edited.request.evidence).toContain("message 2 (text) changed")

  record(db, "penultimate", { id: "warm", at: 1000, count: 6, read: 8000, write: 0 })
  record(db, "penultimate", { id: "edit", at: 2000, count: 6, read: 0, write: 9000, edits: { 4: "EDITED" } })
  const penultimate = last(db, "penultimate", "edit")
  legacy(penultimate.request)
  expect(penultimate.request.cause).toBe("prefix-changed")
  expect(penultimate.request.evidence).toContain("message 5 (text) changed")

  // After a keep-alive ping (marker on the history's last message, private
  // prompt after it), an edit before that marked message is still a rewrite.
  record(db, "afterping", { id: "warm", at: 1000, count: 4, read: 8000, write: 0 })
  record(db, "afterping", { id: "ping", at: 1500, kind: "ping", count: 6, marker: 4, read: 8000, write: 0 })
  record(db, "afterping", { id: "edit", at: 2000, count: 6, read: 0, write: 9000, edits: { 3: "EDITED" } })
  const afterPing = last(db, "afterping", "edit")
  legacy(afterPing.request)
  expect(afterPing.request.cause).toBe("prefix-changed")
  expect(afterPing.request.evidence).toContain("message 4 (text) changed")

  // Control: pure tail growth keeps the rolling-marker prefix and is not a
  // prefix change.
  record(db, "tail", { id: "warm", at: 1000, count: 6, read: 8000, write: 0 })
  record(db, "tail", { id: "grow", at: 2000, count: 8, read: 8100, write: 100 })
  const grown = last(db, "tail", "grow")
  legacy(grown.request)
  expect(grown.request.cause).toBe("unknown")

  // Control: replacing the last (tail) message is conversation growth, not a
  // prefix edit.
  record(db, "lastedit", { id: "warm", at: 1000, count: 6, read: 8000, write: 0 })
  record(db, "lastedit", { id: "replace", at: 2000, count: 6, read: 8100, write: 100, lastText: "new tail" })
  const replaced = last(db, "lastedit", "replace")
  legacy(replaced.request)
  expect(replaced.request.cause).toBe("unknown")
})
