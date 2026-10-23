import { afterEach, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { backfillCacheBatch, captureWire, compareWire, projectCacheResult, queryCacheResults } from "../src/monitor/snapshot.js"
import { wireBody } from "../src/monitor/wire.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"
import { CACHE_COLUMNS, createLedger } from "../src/monitor/ledger.js"
import { Schema } from "effect"
import { MonitorReport } from "../src/rpc.js"
import { fingerprintWireBody, sha256 } from "../src/monitor/fingerprint.js"

afterEach(cleanupLedgers)

const body = (text = "original", max = 100) => JSON.stringify({
  model: "fixture", instructions: "system", tools: [{ name: "read", parameters: {} }],
  input: [{ role: "user", content: text }], max_output_tokens: max,
})

test("wire comparison distinguishes append, rewritten history, and output budget", () => {
  const before = body()
  const after = JSON.stringify({ ...JSON.parse(body("original", 200)), input: [
    { role: "user", content: "original" }, { role: "assistant", content: "new" },
  ] })
  expect(compareWire(before, after)).toMatchObject({ append: true, addedMessages: 1, changed: [] })
  expect(compareWire(before, body("rewritten"))).toMatchObject({ append: false, first: "input[0].content" })
  expect(compareWire(before, JSON.stringify({ ...JSON.parse(before), tools: [] }))).toMatchObject({ append: false, first: "tools[read]" })
  const inserted = JSON.stringify({ ...JSON.parse(before), tools: [{ name: "new", parameters: {} }, ...JSON.parse(before).tools] })
  expect(compareWire(before, inserted).changed).toEqual(["tools[new]"])
  expect(compareWire(inserted, JSON.stringify({ ...JSON.parse(inserted), tools: JSON.parse(inserted).tools.toReversed() })).changed).toEqual(["tools.order"])
  const marked = JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "same", cache_control: { type: "ephemeral" } }] }] })
  const moved = JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "same" }] }, { role: "user", content: [{ type: "text", text: "new", cache_control: { type: "ephemeral" } }] }] })
  expect(compareWire(marked, moved)).toMatchObject({ append: true, changed: [], markers: ["messages[0].content[0].cache_control"] })
})

test("saved results survive reopening; reads never load fingerprints or full transcripts", async () => {
  const db = await ledger()
  db.session({ id: "chat", title: "Current chat" }, 1)
  for (const [id, at, read, epoch] of [["a", 10, 10000, "a"], ["b", 20, 0, "a"], ["c", 30, 9000, "a"], ["d", 40, 0, "b"]] as const) {
    db.requestStarted({ id, sessionID: "chat", started: at, kind: "step", provider: "fixture", model: "fixture" })
    await captureWire(db, id, body(id === "b" ? "rewritten" : "original"))
    db.requestEnded(id, { ended: at + 1, status: "completed" })
    db.requestObserved(id, { version: 1, completeness: "final", historyEpoch: epoch, inputTokens: 11000, cacheReadInputTokens: read, cacheWriteInputTokens: 11000 - read })
    projectCacheResult(db, id)
  }
  const forbidden = () => { throw new Error("read path loaded history") }
  const reader = { ...db, getRequests: forbidden, getFingerprints: forbidden, getFingerprint: forbidden, getContextFacts: forbidden }
  const report = queryCacheResults(reader, { scope: "session", sessionID: "chat", view: "cache" }, { now: 100 })
  expect(report.requests?.map((row) => row.verdict)).toEqual(["cold", "miss", "partial", "cold"])
  expect(report.totals).toMatchObject({ misses: 2, missTokens: 13000, coldRequests: 2 })
  expect(Schema.toStandardSchemaV1(MonitorReport)["~standard"].validate(report)).toHaveProperty("value")
  expect(report.requests?.[1]?.causeText).toContain("input[0].content")
  expect(queryCacheResults(reader, { scope: "all", view: "sessions" }, { now: 100 }).sessions?.[0]?.title).toBe("Current chat")
  const detail = queryCacheResults(reader, { scope: "session", sessionID: "chat", id: "b" }, { now: 100 }).detail
  expect(detail?.lines.join("\n")).toContain("Current sent body: b (Prompt tab)")
  // Bodies live once per item in the private store and rebuild byte-for-byte; no whole-file copy is kept.
  expect(wireBody(db, "b")).toBe(body("rewritten"))
  expect(db.db.query("select * from cache_wire").all()).toEqual([])
  expect(statSync(`${db.path}.transcripts/wire.db`).mode & 0o777).toBe(0o600)
  expect(statSync(`${db.path}.transcripts`).mode & 0o777).toBe(0o700)
  const reopened = createLedger(db.path)
  try {
    expect(queryCacheResults(reopened, { scope: "all" }, { now: 100 }).requests).toEqual(report.requests)
  } finally {
    reopened.close()
  }
})

test("an in-memory ledger keeps its transcripts in memory, not in the working directory", async () => {
  const memory = createLedger(":memory:")
  try {
    memory.requestStarted({ id: "m", sessionID: "chat", started: 1, kind: "step", provider: "fixture", model: "fixture" })
    await captureWire(memory, "m", body())
    await captureWire(memory, "n", "not json")
    expect(wireBody(memory, "m")).toBe(body())
    expect(existsSync(":memory:.transcripts")).toBe(false)
  } finally {
    memory.close()
  }
})

test("detection survives every full-body mutation and remains independent of explanations", async () => {
  const db = await ledger()
  const variants = [
    { ...JSON.parse(body()), instructions: "changed" },
    { ...JSON.parse(body()), tools: [{ name: "read", parameters: { changed: true } }] },
    { ...JSON.parse(body()), context_management: { edits: [{ type: "compact_20260112" }] } },
    { ...JSON.parse(body()), input: [{ role: "user", content: "reverted" }] },
    { ...JSON.parse(body()), max_output_tokens: 999 },
  ]
  for (const [index, wire] of variants.entries()) {
    const sessionID = `case-${index}`
    db.session({ id: sessionID }, 1)
    for (const [id, at, read, sent] of [[`${index}-a`, 10, 10000, body()], [`${index}-b`, 20, 1000, JSON.stringify(wire)]] as const) {
      db.requestStarted({ id, sessionID, started: at, kind: "compaction" })
      await captureWire(db, id, sent)
      db.requestEnded(id, { ended: at + 1, status: "completed" })
      db.requestObserved(id, { version: 1, completeness: "final", historyEpoch: "epoch", inputTokens: 11000, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
      projectCacheResult(db, id)
    }
  }
  const report = queryCacheResults(db, { scope: "all" }, { now: 100 })
  expect(report.requests?.filter((row) => row.verdict === "partial").map((row) => row.missTokens)).toEqual([9000, 9000, 9000, 9000, 9000])
  expect(report.totals.missTokens).toBe(45000)
})

test("first load of 3000 saved requests does not rebuild histories", async () => {
  const db = await ledger()
  db.session({ id: "chat" }, 1)
  db.requestStarted({ id: "seed", sessionID: "chat", kind: "step", started: 1 })
  db.requestEnded("seed", { status: "completed", ended: 2 })
  db.requestObserved("seed", { version: 1, completeness: "final", inputTokens: 10000, cacheReadInputTokens: 10000, cacheWriteInputTokens: 0 })
  projectCacheResult(db, "seed")
  db.db.exec(`with recursive n(x) as (values(1) union all select x+1 from n where x < 3000)
    insert into cache_result select 'r-' || x, 'chat', x + 10, verdict,
      json_set(summary, '$.id', 'r-' || x, '$.at', x + 10), detail, ${CACHE_COLUMNS.map(([name]) => name).join(", ")}
      from n, cache_result where request_id = 'seed'`)
  const start = performance.now()
  const report = queryCacheResults(db, { scope: "session", sessionID: "chat" }, { now: 10000 })
  const elapsed = performance.now() - start
  expect(report.requests).toHaveLength(100)
  expect(report.requestPage?.total).toBe(3001)
  expect(elapsed).toBeLessThan(200)
  console.log(`Cache screen 3001 rows, first read: ${elapsed.toFixed(2)} ms`)
})

test("archive failure cannot hide a miss; zero-duration requests cannot select themselves", async () => {
  const db = await ledger()
  db.session({ id: "chat" }, 1)
  for (const [id, at, read] of [["a", 10, 10000], ["b", 20, 0]] as const) {
    db.requestStarted({ id, sessionID: "chat", kind: "step", started: at })
    await captureWire(db, id, id === "b" ? "invalid-json" : body())
    db.requestEnded(id, { status: "completed", ended: at })
    db.requestObserved(id, { version: 1, completeness: "final", inputTokens: 10000, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
    projectCacheResult(db, id)
  }
  expect(queryCacheResults(db, { scope: "all" }, { now: 100 }).requests?.map((row) => row.verdict)).toEqual(["cold", "miss"])
  db.prune(100)
  expect(db.db.query("select * from cache_result").all()).toEqual([])
  expect(db.db.query("select * from cache_wire").all()).toEqual([])
})

test("a read saves a few just-ended results but leaves a historical backlog to the backfill", async () => {
  const db = await ledger()
  db.session({ id: "chat" }, 1)
  const end = (count: number, from: number) => Array.from({ length: count }, (_, index) => {
    const id = `r-${from + index}`
    db.requestStarted({ id, sessionID: "chat", kind: "step", started: from + index })
    db.requestEnded(id, { status: "completed", ended: from + index })
    db.requestObserved(id, { version: 1, completeness: "final", inputTokens: 10000, cacheReadInputTokens: 10000, cacheWriteInputTokens: 0 })
  })
  end(17, 10)
  const backlog = queryCacheResults(db, { scope: "all" }, { now: 1000 })
  expect(backlog.cachePending).toBe(17)
  expect(backlog.requests).toEqual([])
  backfillCacheBatch(db, 100)
  end(2, 100)
  const recent = queryCacheResults(db, { scope: "all" }, { now: 1000 })
  expect(recent.cachePending).toBe(0)
  expect(recent.requests).toHaveLength(19)
})

test("every saved ping has exactly one follow-up bucket", async () => {
  const db = await ledger()
  db.session({ id: "chat" }, 1)
  for (const [id, at, kind, read, epoch] of [
    ["p1", 10, "ping", 10000, "one"], ["hit", 20, "step", 10000, "one"],
    ["p2", 30, "ping", 10000, "one"], ["miss", 40, "step", 0, "one"],
    ["p3", 50, "ping", 10000, "one"], ["cold", 60, "step", 0, "two"],
    ["p4", 70, "ping", 10000, "two"],
  ] as const) {
    db.requestStarted({ id, sessionID: "chat", kind, started: at })
    db.requestEnded(id, { status: "completed", ended: at + 1 })
    db.requestObserved(id, { version: 1, completeness: "final", historyEpoch: epoch, inputTokens: 10000, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
    projectCacheResult(db, id)
  }
  expect(queryCacheResults(db, { scope: "all" }, { now: 100 }).pings).toMatchObject({
    sent: 4, followedByHit: 1, followedByMiss: 1, followedByCold: 1, unused: 1, unknown: 0,
  })
})

test.each([false, true])("warming private-tail replacement is not blamed for a loss (cached mutation=%s)", async (mutated) => {
  const db = await ledger()
  const prefix = [
    { role: "user", content: [{ type: "text", text: "cached conversation" }] },
    { role: "assistant", content: [{ type: "text", text: "cached answer", cache_control: { type: "ephemeral" } }] },
  ]
  for (const [id, at, kind, read] of [["ping", 10, "ping", 10000], ["step", 20, "step", 0]] as const) {
    const messages = [...prefix, { role: "user", content: [{ type: "text", text: id === "ping" ? "private keepalive" : "new user input" }] }]
    if (mutated && id === "step") messages[0] = { role: "user", content: [{ type: "text", text: "rewritten history" }] }
    const sent = JSON.stringify({ model: "fixture", messages })
    db.session({ id: "chat" }, at)
    db.requestStarted({ id, sessionID: "chat", kind, started: at })
    db.requestFingerprint({ requestID: id, sessionID: "chat", ...fingerprintWireBody(sent, { protocol: "anthropic-messages" }) })
    await captureWire(db, id, sent)
    db.requestEnded(id, { status: "completed", ended: at + 1 })
    db.requestObserved(id, { version: 1, completeness: "final", inputTokens: 10020, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
    projectCacheResult(db, id)
  }
  const request = queryCacheResults(db, { scope: "all" }, { now: 100 }).requests?.at(-1)
  expect(request).toMatchObject({ verdict: "miss", missTokens: 10000 })
  expect(request?.causeText).toBe(mutated ? "Sent content changed: messages[0].content[0].text" : "Unknown upstream loss; warming tail replaced")
})

test("a step after its cache expired keeps that cause when its prompt changed too (a cold instructions rebase)", async () => {
  const db = await ledger()
  for (const [id, at, read, folder] of [["warm", 10, 10000, "a"], ["cold", 400_000, 0, "b"]] as const) {
    const sent = JSON.stringify({
      model: "fixture",
      system: [{ type: "text", text: `Instructions from: /project/${folder}/AGENTS.md`, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })
    db.session({ id: "chat" }, at)
    db.requestStarted({ id, sessionID: "chat", kind: "step", started: at })
    db.requestFingerprint({ requestID: id, sessionID: "chat", ...fingerprintWireBody(sent, { protocol: "anthropic-messages" }) })
    await captureWire(db, id, sent)
    db.requestEnded(id, { status: "completed", ended: at + 1 })
    db.requestObserved(id, { version: 1, completeness: "final", inputTokens: 10020, cacheReadInputTokens: read, cacheWriteInputTokens: 10020 - read })
    projectCacheResult(db, id)
  }
  expect(queryCacheResults(db, { scope: "all" }, { now: 500_000 }).requests?.at(-1)).toMatchObject({
    verdict: "miss", cause: "cache-expired", causeText: "observed: cache expired",
  })
  const detail = queryCacheResults(db, { scope: "all", id: "cold" }, { now: 500_000 }).detail
  expect(detail?.lines.join("\n")).toContain("Changed existing content: system[0].text")
})

test("linked Responses deltas are distinguished from rewritten full history", async () => {
  const db = await ledger()
  for (const [id, at, read] of [["a", 10, 10000], ["b", 20, 0]] as const) {
    const sent = JSON.stringify({ ...JSON.parse(body(id)), ...(id === "b" ? { previous_response_id: "response-one" } : {}) })
    db.session({ id: "chat" }, at)
    db.requestStarted({ id, sessionID: "chat", kind: "step", started: at })
    db.requestFingerprint({ requestID: id, sessionID: "chat", ...fingerprintWireBody(sent, { protocol: "openai-responses" }), ...(id === "a" ? { responseId: sha256("response-one") } : {}) })
    await captureWire(db, id, sent)
    db.requestEnded(id, { status: "completed", ended: at + 1 })
    db.requestObserved(id, { version: 1, completeness: "final", inputTokens: 11000, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
    projectCacheResult(db, id)
  }
  expect(queryCacheResults(db, { scope: "all" }, { now: 100 }).requests?.at(-1)).toMatchObject({
    verdict: "miss", missTokens: 10000, causeText: "Unknown upstream loss; linked continuation",
  })
})

test("saved miss pricing uses the matching model's recorded rates", async () => {
  const db = await ledger()
  db.session({ id: "chat" }, 1)
  db.contextFact({ sessionID: "chat", at: 1, kind: "pricing", detail: { provider: "fixture", model: "a", rates: [{ input: 2, output: 5, cache: { read: 0.5, write: 3 } }] } })
  db.contextFact({ sessionID: "chat", at: 2, kind: "pricing", detail: { provider: "fixture", model: "b", rates: [{ input: 99, output: 5, cache: { read: 1, write: 100 } }] } })
  for (const [id, at, read] of [["a", 10, 10000], ["b", 20, 0]] as const) {
    db.requestStarted({ id, sessionID: "chat", kind: "step", started: at, provider: "fixture", model: "a" })
    db.requestEnded(id, { status: "completed", ended: at + 1 })
    db.requestObserved(id, { version: 1, completeness: "final", inputTokens: 11000, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
    projectCacheResult(db, id)
  }
  const report = queryCacheResults(db, { scope: "all" }, { now: 100 })
  expect(report.requests?.at(-1)?.missCost).toBeCloseTo(0.015)
  expect(report.totals.missCost).toBeCloseTo(0.015)
})

test("session picker includes chats with no completed request", async () => {
  const db = await ledger()
  db.session({ id: "active", title: "Talking now" }, 100)
  const report = queryCacheResults(db, { scope: "all", view: "sessions" }, { now: 101 })
  expect(report.sessions?.map((row) => row.sessionID)).toEqual(["active"])
})

test("unknown upstream cause is explicit when full sent prefix is unchanged", async () => {
  const db = await ledger()
  for (const [id, at, read] of [["a", 10, 10000], ["b", 20, 0]] as const) {
    db.session({ id: "chat" }, at)
    db.requestStarted({ id, sessionID: "chat", started: at, kind: "step" })
    await captureWire(db, id, body())
    db.requestEnded(id, { ended: at + 1, status: "completed" })
    db.requestObserved(id, { version: 1, completeness: "final", inputTokens: 10000, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
    projectCacheResult(db, id)
  }
  expect(queryCacheResults(db, { scope: "all" }, { now: 100 }).requests?.[1]).toMatchObject({
    verdict: "miss", missTokens: 10000, causeText: "Unknown upstream loss; prefix unchanged",
  })
})
