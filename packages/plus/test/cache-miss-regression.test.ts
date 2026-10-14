import { afterEach, expect, test } from "bun:test"
import { fingerprintSegments, foldSession, isMiss, prefixDiff, windowedSessionSignals } from "../src/monitor/cache.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import type { ContextFactRow, RequestRow } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"
import { auditCacheMisses } from "../src/monitor/audit.js"

afterEach(cleanupLedgers)

test("B7 audit rejects hidden losses even when the analyzer omits its predecessor", () => {
  const rows = [row("a", 10, 12000, 10000, 2000), row("b", 20, 13000, 100, 12000)]
  const summaries = foldSession(rows, [], new Map()).analysis.summaries
  expect(auditCacheMisses(rows, summaries)).toEqual([])
  for (const verdict of ["hit", "none", "unknown"] as const) {
    const broken = summaries.map((s) => ({ request: { ...s.request, verdict } }))
    expect(auditCacheMisses(rows, broken)).toEqual([{ requestID: "b", verdict, shortfall: 11900 }])
  }
})

// Minimal sanitized corpus: only measured frontiers, input, timings and kinds.
// IDs, prompts, fingerprints, accounts and absolute timestamps are synthetic.
const cases = [
  ["changed-prefix", 236032, 0, 223111, 56192, 0, 116, "step", "step", "partial"],
  ["changed-option", 84096, 0, 83556, 6912, 0, 716, "step", "step", "partial"],
  ["changed-tool", 83456, 0, 86714, 6912, 0, 86, "step", "step", "partial"],
  ["reverted", 0, 9349, 9317, 4115, 5200, 117895, "ping", "step", "partial"],
  ["expired-ping", 45312, 0, 45527, 0, 0, 1500019, "ping", "ping", "miss"],
  ["handoff", 715428, 1393, 554607, 0, 554603, 17322, "step", "compaction", "miss"],
  ["native-earlier", 262130, 0, 206665, 4115, 202479, 120416, "ping", "compaction", "partial"],
  ["expired-compaction", 4115, 202479, 238315, 0, 238311, 56607301, "compaction", "compaction", "miss"],
  ["native-incident", 156164, 0, 113800, 4115, 109614, 169615, "ping", "compaction", "partial"],
  ["warm-ping", 156164, 0, 156168, 156164, 0, 210069, "ping", "ping", "hit"],
  ["ordinary-step", 146325, 5274, 152397, 151599, 796, 4872, "step", "step", "hit"],
  ["new-epoch", 0, 238311, 13185, 0, 13183, 25, "compaction", "step", "cold"],
  ["second-epoch-step", 0, 13183, 18401, 13183, 5216, 29, "step", "step", "hit"],
] as const

function row(id: string, at: number, input: number, read: number, write: number, kind = "step"): RequestRow {
  return {
    id, sessionID: "fixture", provider: "fixture", model: "model", kind, isTitle: false,
    started: at, ended: at + 1, created: at, status: "completed",
    inputTokens: input - read - write, cacheReadTokens: read, cacheWriteTokens: write,
    outputTokens: 0, reasoningTokens: 0, cost: 0,
    observation: { version: 1, completeness: "final", inputTokens: input, cacheReadInputTokens: read, cacheWriteInputTokens: write },
  }
}
const body = () => ({
  model: "model", max_tokens: 1000,
  system: [{ type: "text", text: "synthetic system" }],
  tools: [{ name: "lookup", description: "synthetic tool", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "synthetic history", cache_control: { type: "ephemeral" } }] }],
})
const fp = (id: string, value: unknown = body()) => ({ requestID: id, sessionID: "fixture", ...fingerprintWireBody(value, { protocol: "anthropic-messages" }) })
const fact = (kind: string, at = 5): ContextFactRow => ({ id: 1, sessionID: "fixture", kind, at })

for (const [name, priorRead, priorWrite, input, read, write, gap, priorKind, kind, verdict] of cases) {
  test(`B1 sanitized corpus: ${name}`, () => {
    const rows = [row("before", 10, priorRead + priorWrite, priorRead, priorWrite, priorKind), row("now", 11 + gap, input, read, write, kind)]
    const facts = name === "reverted" ? [fact("revert", 12)] : name === "handoff" ? [fact("quota_handoff", 12)] : []
    const changed = name.startsWith("native") ? { ...body(), context_management: { edits: [{ type: "compact_20260112" }] } } : body()
    const result = foldSession(rows, facts, new Map([fp("before"), fp("now", changed)].map((p) => [p.requestID, p]))).analysis.details[1]!
    expect(result.request.verdict).toBe(verdict)
    if (verdict === "miss" || verdict === "partial") expect(result.request.missTokens).toBeGreaterThan(0)
    if (name === "native-incident") expect(result.firstDivergence).toBe("option context_management")
    if (name === "expired-compaction") expect(result.request.cause).toBe("cache-expired")
    if (name === "reverted") expect(result.request.cause).toBe("revert")
    if (name === "handoff") expect(result.request.cause).toBe("account-changed")
    if (name === "new-epoch") expect(result.request.cause).toBe("compacted")
  })
}

test("B5 one inserted option is one change, not a positional cascade", () => {
  const diff = prefixDiff(fp("a"), fp("b", { ...body(), context_management: { edits: [] } }))
  expect(diff.changes.map((p) => [p.name, p.change])).toEqual([["option context_management", "added"]])
  const changed = body()
  changed.messages[0]!.content[0]!.text = "edited"
  expect(prefixDiff(fp("a"), fp("b", changed)).changes[0]?.name).toBe("message 1 (text)")
})

test("B2 explanations and B4 fact timing cannot erase measured loss", () => {
  const rows = [row("a", 10, 12000, 10000, 2000), row("b", 20, 13000, 100, 12000)]
  const mutationsByKind: Record<ReturnType<typeof fingerprintSegments>[number]["kind"], unknown[]> = {
    option: [{ ...body(), context_management: {} }, { ...body(), max_tokens: 5 }, { ...body(), max_tokens: undefined }],
    marker: [{ ...body(), messages: [{ role: "user", content: [{ type: "text", text: "synthetic history", cache_control: { type: "ephemeral", ttl: "1h" } }] }] }],
    tool: [{ ...body(), tools: [] }, { ...body(), tools: [...body().tools, { name: "new_tool", input_schema: {} }] }, { ...body(), tools: [{ ...body().tools[0], description: "changed" }] }],
    system: [{ ...body(), system: [] }, { ...body(), system: [{ type: "text", text: "changed" }] }],
    message: [{ ...body(), messages: [] }, { ...body(), messages: [{ role: "user", content: "reverted" }] }],
  }
  const mutations = [body(), ...[...new Set(fingerprintSegments(fp("a")).map((s) => s.kind))].flatMap((kind) => mutationsByKind[kind])]
  for (const value of mutations) for (const kind of ["compaction", "compaction_started", "revert", "instruction_update", "warming", "quota_handoff"]) {
    for (const at of [11, 15, 21 - 0.01, 21 + 0.01, 5021]) {
      const result = foldSession(rows, [fact(kind, at)], new Map([["a", fp("a")], ["b", fp("b", value)]])).analysis.summaries[1]!.request
      expect(result).toMatchObject({ verdict: "partial", missTokens: 11900 })
    }
  }
  expect(foldSession([rows[0]!, { ...rows[1]!, variant: "changed" }], [], new Map()).analysis.summaries[1]?.request).toMatchObject({ verdict: "partial", missTokens: 11900 })
  const warm = [rows[0]!, row("b", 20, 13000, 12000, 0)]
  const reordered = Object.fromEntries(Object.entries(body()).reverse())
  expect(foldSession(warm, [fact("warming", 15)], new Map([["a", fp("a")], ["b", fp("b", reordered)]])).analysis.summaries[1]?.request.verdict).toBe("hit")
})

test("B3 deterministic random sequences obey detection and ping partition invariants", () => {
  let seed = 7919
  const random = () => (seed = (seed * 16807) % 2147483647)
  const rows = Array.from({ length: 100 }, (_, i) => {
    const read = random() % 20000
    return row(`r${i}`, i * 10, 30000, read, random() % (30000 - read), i % 3 === 0 ? "ping" : "step")
  })
  const analysis = foldSession(rows, [], new Map()).analysis
  for (const { request } of analysis.summaries) {
    if (request.verdict === "hit") expect(request.cacheRead).toBeGreaterThan((request.expected ?? 0) - 128)
    if (request.verdict === "none") expect(request.measurement?.state).not.toBe("reported")
    if (isMiss(request)) expect(request.missTokens).toBeGreaterThan(0)
  }
  const pings = windowedSessionSignals(analysis, { since: 0, until: 1000 }).pings
  expect(pings.followedByHit + pings.followedByMiss + pings.followedByCold + pings.unused + pings.unknown).toBe(pings.sent)
})

test("B1/B3 all nine corpus losses survive persistence, totals and missesOnly", async () => {
  const db = await ledger()
  for (const [name, priorRead, priorWrite, input, read, write, gap, priorKind, kind] of cases) {
    db.session({ id: name }, 1)
    const rows = [row(`${name}-before`, 10, priorRead + priorWrite, priorRead, priorWrite, priorKind), row(`${name}-now`, 11 + gap, input, read, write, kind)]
    for (const r of rows) {
      db.requestStarted({ id: r.id, sessionID: name, provider: r.provider, model: r.model, kind: r.kind, started: r.started })
      db.requestEnded(r.id, { ended: r.ended!, status: "completed" })
      db.requestObserved(r.id, { ...r.observation!, version: 1, completeness: "final" })
      db.requestFingerprint({ ...fp(r.id, r.id.endsWith("now") ? { ...body(), context_management: {} } : body()), sessionID: name })
    }
    // Neither a fact written after completion nor a later fingerprint correction
    // may retract an already measured shortfall.
    db.contextFact({ sessionID: name, kind: "compaction", at: rows[1]!.ended! + 10 })
  }
  const report = queryMonitor(db, { scope: "all", view: "cache", missesOnly: true }, { now: 60000000 })
  expect(report.requests).toHaveLength(9)
  expect(report.totals.misses).toBe(9)
  expect(report.requests?.every((r) => isMiss(r) && (r.missTokens ?? 0) > 0)).toBe(true)
  expect(report.totals.missTokens).toBe(report.requests!.reduce((sum, r) => sum + (r.missTokens ?? 0), 0))
})
