import { expect, test } from "bun:test"
import { cacheLifetime, foldSession, prefixDiff, unreadFingerprintKeys, unreadFingerprintKeyWeight, windowedSessionSignals } from "../src/monitor/cache.js"
import { fingerprintWireBody, sha256 } from "../src/monitor/fingerprint.js"
import type { RequestFingerprintData, RequestRow } from "../src/monitor/ledger.js"
import { foldUnread, unreadGain, unreadIndexWeight } from "../src/monitor/unread-index.js"

function row(index: number, change: Partial<RequestRow> = {}): RequestRow {
  return { id: `r${index}`, sessionID: "unread", kind: "step", created: index * 10, started: index * 10, ended: index * 10 + 1, status: "completed", isTitle: false, provider: "fixture", model: "fixture", agent: "build", inputTokens: 100_000, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: index + 100, cacheWriteTokens: 100_000, cost: 0, ...change }
}

function fp(index: number, body: object = { prompt_cache_retention: "24h", messages: [{ role: "user", content: "same" }] }, protocol: "openai-chat" | "openai-responses" | "anthropic-messages" = "openai-chat"): RequestFingerprintData {
  return { ...fingerprintWireBody(body, { protocol }), requestID: `r${index}`, sessionID: "unread", created: index * 10 }
}

test("reuse index keys exactly preserve production prefix decisions, including rolling markers and branching", () => {
  const fingerprints = Array.from({ length: 18 }, (_, index) => fp(index, {
    system: "rules",
    messages: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: i < 3 ? `shared${i}` : `tail${(index + i) % 3}`, ...(i === index % 5 ? { cache_control: { type: "ephemeral" } } : {}) }] })),
  }, "anthropic-messages"))
  fingerprints.push(...Array.from({ length: 8 }, (_, index) => ({ ...fp(index, {
    ...(index > 2 ? { previous_response_id: `response${index % 3}` } : {}),
    input: [{ role: "user", content: `message${index % 2}` }],
  }, "openai-responses"), responseId: sha256(`response${index}`) })))
  fingerprints.push(fp(100), fp(101, { prompt_cache_retention: "24h", messages: [{ role: "user", content: "same" }, { role: "assistant", content: "appended" }] }))
  const irregular = fingerprints[0]!
  fingerprints.push({ ...irregular, messagePrefixes: [...irregular.messagePrefixes.slice(0, 3), ...irregular.messagePrefixes.slice(3).toReversed()] })
  // Unsupported fingerprints cannot supply a correlation.
  fingerprints.push({ ...fp(102), fingerprintVersion: 999 })
  for (const before of fingerprints) {
    for (const after of fingerprints) {
      const reads = unreadFingerprintKeys(after, false)
      const indexed = unreadFingerprintKeys(before, true).some((write) => reads.some((read) => write.key === read.key && (write.tail === undefined || write.tail !== read.tail)))
      expect(indexed).toBe(prefixDiff(before, after).reusable)
    }
  }
})

test("range maxima preserve strict time boundaries, titles, selection, and write-owned lifetime", () => {
  const rows = [
    row(0, { started: 100, cacheReadTokens: 100, cacheWriteTokens: 1000 }),
    row(1, { started: 100, cacheReadTokens: 5000, cacheWriteTokens: 0 }), // simultaneous cannot warm it
    row(2, { started: 200, cacheReadTokens: 600, cacheWriteTokens: 0, isTitle: true, kind: "title" }),
    row(3, { started: 300, cacheReadTokens: 400, cacheWriteTokens: 0, agent: "other" }),
    row(4, { started: 1100, cacheReadTokens: 900, cacheWriteTokens: 0 }),
    row(5, { started: 1101, cacheReadTokens: 7000, cacheWriteTokens: 0 }),
  ]
  const fingerprints = new Map(rows.map((r, i) => [r.id, fp(i)]))
  const numeric = foldUnread(rows, fingerprints, () => 1000, unreadFingerprintKeys)
  const write = numeric.writes[0]!
  expect(unreadGain(numeric.unreadIndex, write, 1100, false)).toBe(300)
  expect(unreadGain(numeric.unreadIndex, write, 1100, true)).toBe(500)
  expect(unreadGain(numeric.unreadIndex, write, 1101, false)).toBe(800)
  expect(unreadGain(numeric.unreadIndex, write, 9999, false)).toBe(800)
  const analysis = { ...foldSession(rows, [], fingerprints).analysis, ...numeric }
  expect(windowedSessionSignals(analysis, { since: 0, until: 1100 }).unread).toBe(700)
  expect(windowedSessionSignals(analysis, { since: 0, until: 1100 }, { titles: true }).unread).toBe(500)
  expect(windowedSessionSignals(analysis, { since: 0, until: 1099 }).unread).toBe(0)
  expect(windowedSessionSignals(analysis, { since: 101, until: 9999 }).unread).toBe(0)
  expect(windowedSessionSignals(analysis, { since: 0, until: 9999 }, { agents: ["other"] }).unread).toBe(0)
  expect(windowedSessionSignals(analysis, { since: 0, until: 9999 }, { models: ["other/fixture"] }).unread).toBe(0)
})

test("many long-retention writes retain read maxima, not pairs; append touches one suffix row", () => {
  const rows = Array.from({ length: 4096 }, (_, i) => row(i))
  const fingerprint = fp(0)
  expect(unreadFingerprintKeyWeight(fingerprint)).toBe(0)
  const fingerprints = new Map(rows.map((row) => [row.id, fingerprint]))
  const previous = foldUnread(rows, fingerprints, cacheLifetime, unreadFingerprintKeys)
  expect(unreadFingerprintKeyWeight(fingerprint)).toBeGreaterThan(0)
  expect(previous.unreadIndex.work.memberships).toBe(4095)
  expect(previous.unreadIndex.buckets.size).toBe(1)
  const stack = [...previous.unreadIndex.buckets.values()].map((bucket) => bucket.root)
  const retained = new Set<typeof stack[number]>()
  while (stack.length) {
    const node = stack.pop()!
    if (retained.has(node)) continue
    retained.add(node)
    if (node.left) stack.push(node.left)
    if (node.right) stack.push(node.right)
  }
  expect(retained.size).toBeLessThanOrEqual(2 * 4095 + 14)
  const weight = unreadIndexWeight(previous.unreadIndex)
  expect(weight).toMatchObject({ nodes: retained.size, memberships: 4095, buckets: 1, subscriptions: 2 })
  const serialized = Buffer.byteLength(JSON.stringify([previous.unreadIndex.work, [...previous.unreadIndex.buckets], [...previous.unreadIndex.subscriptions]]))
  expect(weight.serializedBytes).toBeGreaterThanOrEqual(serialized)
  expect(weight.serializedBytes - serialized).toBeLessThanOrEqual(12)
  expect(unreadIndexWeight(previous.unreadIndex)).toBe(weight)
  const next = row(4096)
  fingerprints.set(next.id, fingerprint)
  const appended = foldUnread([...rows, next], fingerprints, cacheLifetime, unreadFingerprintKeys, previous, rows.length)
  expect(appended.unreadIndex.work).toMatchObject({ rows: 1, replayedRows: 0, memberships: 1 })
  expect(appended.unreadIndex.work.nodes).toBeLessThanOrEqual(14)
  expect(unreadIndexWeight(appended.unreadIndex).serializedBytes).toBeGreaterThan(weight.serializedBytes)
  expect(unreadIndexWeight(previous.unreadIndex)).toBe(weight)
  const visits = { visits: 0 }
  expect(unreadGain(appended.unreadIndex, appended.writes[0]!, 100_000_000, false, visits)).toBe(4096)
  expect(visits.visits).toBeLessThanOrEqual(30)
  // A previously retained snapshot is immutable across append.
  expect(unreadGain(previous.unreadIndex, previous.writes[0]!, 100_000_000, false)).toBe(4095)
  const correctedRows = [...rows, next].map((r, i) => i === 1000 ? { ...r, cacheReadTokens: 99999 } : r)
  const corrected = foldUnread(correctedRows, fingerprints, cacheLifetime, unreadFingerprintKeys, appended, 1000)
  const fresh = foldUnread(correctedRows, fingerprints, cacheLifetime, unreadFingerprintKeys)
  for (const cutoff of [4000, 10001, 20000, 100_000_000]) {
    for (const write of corrected.writes) {
      expect(unreadGain(corrected.unreadIndex, write, cutoff, false)).toBe(unreadGain(fresh.unreadIndex, write, cutoff, false))
    }
  }
})

test("no-gain and incompatible branches have bounded numeric storage and unknown retention stays unknown", () => {
  const rows = Array.from({ length: 4096 }, (_, i) => row(i))
  const fingerprints = new Map(rows.map((r, i) => [r.id, fp(i, { prompt_cache_retention: "24h", messages: [{ role: "user", content: `branch${i}` }] })]))
  const analysis = foldUnread(rows, fingerprints, cacheLifetime, unreadFingerprintKeys)
  expect(analysis.unreadIndex.work.memberships).toBe(0)
  expect(analysis.unreadIndex.buckets.size).toBe(0)
  expect(analysis.unreadIndex.subscriptions.size).toBe(4096 * 2)
  expect(analysis.writes.reduce((sum, write) => sum + Math.max(0, write.tokens - unreadGain(analysis.unreadIndex, write, 100_000_000, false)), 0)).toBe(4096 * 100_000)
  const unknown = foldUnread([row(0)], new Map([["r0", fp(0, { messages: [{ role: "user", content: "same" }] })]]), cacheLifetime, unreadFingerprintKeys)
  expect(unknown.writes).toHaveLength(0)
  const noGain = foldUnread(rows.map((r) => ({ ...r, cacheReadTokens: 100 })), new Map(rows.map((r) => [r.id, fp(0)])), cacheLifetime, unreadFingerprintKeys)
  expect(noGain.unreadIndex.work.memberships).toBe(0)
  expect(noGain.unreadIndex.buckets.size).toBe(0)
})

test("a later rolling 1h marker cannot extend the original 5m write lifetime", () => {
  const make = (later: boolean) => ({ system: "rules", messages: [
    { role: "user", content: [{ type: "text", text: "prefix", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "text", text: later ? "replacement" : "private", ...(later ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}) }] },
  ] })
  const before = fp(0, make(false), "anthropic-messages")
  const after = fp(1, make(true), "anthropic-messages")
  expect(prefixDiff(before, after).reusable).toBe(true)
  const rows = [row(0, { started: 100, cacheReadTokens: 0, cacheWriteTokens: 1000 }), row(1, { started: 350_000, cacheReadTokens: 1000, cacheWriteTokens: 0 })]
  const analysis = foldSession(rows, [], new Map([["r0", before], ["r1", after]])).analysis
  expect(analysis.writes[0]!.lifetime).toBe(300_000)
  expect(windowedSessionSignals(analysis, { since: 0, until: 4_000_000 }).unread).toBe(1000)
})
