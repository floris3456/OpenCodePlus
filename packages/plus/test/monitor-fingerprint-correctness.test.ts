import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody, fingerprintPolicy, sha256 } from "../src/monitor/fingerprint.js"
import { prefixDiff } from "../src/monitor/cache.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"
import { queryMonitor } from "../src/monitor/query.js"

afterEach(cleanupLedgers)

const fp = (body: object, protocol: "openai-chat" | "openai-responses" | "anthropic-messages" = "openai-chat") => ({
  requestID: "fixture", sessionID: "fixture", ...fingerprintWireBody(body, { protocol }),
})

test("version and policy are explicit; missing, future and incomplete versions cannot establish equality", () => {
  const current = fp({ messages: [{ role: "user", content: "same" }] })
  expect(current).toMatchObject({ fingerprintVersion: 2, policyVersion: 1 })
  expect(fingerprintPolicy).toMatchObject({ eligibility: "unknown", ordering: "wire-only", unknown: "retain" })
  expect(prefixDiff(current, current)).toMatchObject({ known: true, reusable: true })
  for (const legacy of [
    { ...current, fingerprintVersion: undefined },
    { ...current, fingerprintVersion: 900 },
    { ...current, policyVersion: undefined },
    { ...current, policyVersion: 900 },
    { ...current, systemHash: undefined },
    { ...current, messagePrefixes: current.messagePrefixes.map((p) => ({ ...p, contentHash: undefined })) },
  ]) {
    expect(prefixDiff(current, legacy)).toMatchObject({ known: false, reusable: false, common: 0 })
    expect(prefixDiff(legacy, legacy).known).toBe(false)
  }
  const fallback = { requestID: "f", sessionID: "fixture", ...fingerprintWireBody("unparsed") }
  expect(prefixDiff(fallback, fallback).known).toBe(false)
  for (const malformed of [{ messages: "not an array" }, { messages: [], tools: ["not a tool"] }]) {
    const unsupported = fp(malformed)
    expect(prefixDiff(unsupported, unsupported).known).toBe(false)
  }
})

test("Chat system/developer role, relative order and complete block shape are wire identity", () => {
  const system = { role: "system", content: [{ type: "text", text: "rules" }] }
  const user = { role: "user", content: "hello" }
  const a = fp({ messages: [system, user] })
  for (const messages of [
    [{ ...system, role: "developer" }, user],
    [user, system],
    [{ ...system, content: [{ type: "other", text: "rules" }] }, user],
    [{ ...system, name: "named", content: system.content }, user],
  ]) expect(prefixDiff(a, fp({ messages }))).toMatchObject({ known: true, reusable: false })
})

test("Responses string input is detected without URL and never disappears from the prefix", () => {
  const make = (input: unknown) => ({ requestID: "s", sessionID: "fixture", ...fingerprintWireBody({ input }) })
  const a = make("first input")
  expect(a.protocol).toBe("openai-responses")
  expect(a.messagePrefixes).toHaveLength(1)
  expect(a.messagePrefixes[0]?.chars).toBe(JSON.stringify("first input").length)
  expect(prefixDiff(a, make("other input"))).toMatchObject({ known: true, reusable: false })
  expect(prefixDiff(a, make([{ role: "user", content: "first input" }])).reusable).toBe(false)
})

test("tool strict, schema, type and all other definition fields remain ordered constraints", () => {
  for (const protocol of ["openai-chat", "openai-responses", "anthropic-messages"] as const) {
    const tool = { type: "function", name: "read", description: "read fixture", parameters: { type: "object" }, strict: false }
    const body = { messages: [{ role: "user", content: "same" }], input: "same", tools: [tool] }
    const a = fp(body, protocol)
    for (const changed of [{ ...tool, strict: true }, { ...tool, parameters: { type: "string" } }, { ...tool, type: "custom" }, { ...tool, format: { type: "grammar" } }])
      expect(prefixDiff(a, fp({ ...body, tools: [changed] }, protocol)).reusable).toBe(false)
    const second = { ...tool, name: "write" }
    expect(prefixDiff(fp({ ...body, tools: [tool, second] }, protocol), fp({ ...body, tools: [second, tool] }, protocol)).reusable).toBe(false)
  }
  const chat = { messages: [], tools: [{ type: "function", function: { name: "read", parameters: {}, strict: false } }] }
  expect(prefixDiff(fp(chat), fp({ ...chat, tools: [{ type: "function", function: { name: "read", parameters: {}, strict: true } }] })).reusable).toBe(false)
})

test("response format, multimodal parts, opaque references and unknown settings are not lost", () => {
  const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "fixture-a" } }] }], response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } }, parallel_tool_calls: true, extension: { fixture: "a" } }
  const a = fp(body)
  for (const b of [
    fp({ ...body, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "fixture-b" } }] }] }),
    fp({ ...body, response_format: { type: "json_schema", json_schema: { schema: { type: "string" } } } }),
    fp({ ...body, parallel_tool_calls: false }),
    fp({ ...body, extension: { fixture: "b" } }),
  ]) expect(prefixDiff(a, b).reusable).toBe(false)
  expect(prefixDiff(fp({ input: "same", text: { format: { type: "json_schema", schema: { type: "object" } } } }, "openai-responses"), fp({ input: "same", text: { format: { type: "json_schema", schema: { type: "string" } } } }, "openai-responses")).reusable).toBe(false)
  expect(prefixDiff(fp({ input: [{ type: "compaction", encrypted_content: "opaque-a" }] }, "openai-responses"), fp({ input: [{ type: "compaction", encrypted_content: "opaque-b" }] }, "openai-responses")).reusable).toBe(false)
})

test("JSON object key order is not identity; ordered content blocks remain identity", () => {
  expect(prefixDiff(fp({ model: "fixture", messages: [{ role: "user", content: "same" }] }), fp({ messages: [{ content: "same", role: "user" }], model: "fixture" })).reusable).toBe(true)
  const parts = [{ type: "text", text: "first" }, { type: "text", text: "second" }]
  expect(prefixDiff(fp({ messages: [{ role: "user", content: parts }] }), fp({ messages: [{ role: "user", content: [...parts].reverse() }] })).reusable).toBe(false)
})

test("annotation labels and even annotation splitting cannot manufacture a wire change", () => {
  for (const protocol of ["openai-chat", "openai-responses", "anthropic-messages"] as const) {
    const body = { messages: [{ role: "system", content: "abc def" }, { role: "user", content: "same" }], instructions: "abc def", system: "abc def", input: "same" }
    const make = (namedSystemParts: { name: string; text: string }[]) => ({ requestID: "n", sessionID: "fixture", ...fingerprintWireBody(body, { protocol, namedSystemParts }) })
    expect(prefixDiff(make([{ name: "source A", text: "abc def" }]), make([{ name: "source B", text: "abc" }, { name: "source C", text: "def" }]))).toMatchObject({ known: true, reusable: true, changes: [] })
  }
})

test("one early message edit changes its own identity, not the independently unchanged suffix", () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `message ${i}` }))
  const a = fp({ messages })
  const b = fp({ messages: messages.map((m, i) => i === 1 ? { ...m, content: "edited" } : m) })
  expect(a.messagePrefixes[7]?.prefixHash).not.toBe(b.messagePrefixes[7]?.prefixHash)
  expect(a.messagePrefixes[7]?.contentHash).toBe(b.messagePrefixes[7]?.contentHash)
  expect(prefixDiff(a, b)).toMatchObject({ reusable: false, changes: [{ name: "message 2 (text)", change: "changed" }] })
  expect(prefixDiff(a, fp({ messages: [...messages, { role: "assistant", content: "append" }] })).reusable).toBe(true)
})

test("remembered message hashes give the same fingerprint, and only after the same prefix", () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }))
  const first = fp({ messages })
  expect(fp({ messages })).toEqual(first)
  expect(fp({ messages: [...messages, { role: "user", content: "next" }] }).messagePrefixes.slice(0, 6)).toEqual(first.messagePrefixes)
  const edited = fp({ messages: [{ role: "user", content: "other start" }, ...messages.slice(1)] })
  expect(edited.messagePrefixes.slice(1).map((m) => m.contentHash)).toEqual(first.messagePrefixes.slice(1).map((m) => m.contentHash))
  expect(edited.messagePrefixes.slice(1).filter((m, i) => m.prefixHash === first.messagePrefixes[i + 1]!.prefixHash)).toEqual([])
})

test("rolling breakpoint is a marker change, not a message content edit", () => {
  const a = fp({ max_tokens: 64, messages: [{ role: "user", content: [{ type: "text", text: "same", cache_control: { type: "ephemeral" } }] }] }, "anthropic-messages")
  const b = fp({ max_tokens: 64, messages: [{ role: "user", content: [{ type: "text", text: "same" }] }] }, "anthropic-messages")
  expect(a.messagePrefixes[0]?.contentHash).toBe(b.messagePrefixes[0]?.contentHash)
  expect(prefixDiff(a, b)).toMatchObject({ reusable: false, changes: [{ name: "cache markers", change: "changed" }] })
})

test("a field named cache_control inside structured payload is content, not a wire breakpoint", () => {
  const make = (value: string) => fp({ messages: [{ role: "user", content: [{ type: "fixture", payload: { cache_control: value } }] }] })
  expect(prefixDiff(make("a"), make("b")).reusable).toBe(false)
})

test("unknown cache-control fields cannot silently disappear from marker identity", () => {
  const make = (extension: string) => fp({ messages: [{ role: "user", content: [{ type: "text", text: "same", cache_control: { type: "ephemeral", extension } }] }] }, "anthropic-messages")
  expect(prefixDiff(make("a"), make("b"))).toMatchObject({ reusable: false, changes: [{ name: "cache markers", change: "changed" }] })
})

test("versioned prefix matching retains marked-tail replacement and exact linked-response constraints", () => {
  const marked = { role: "user", content: [{ type: "text", text: "stable prefix", cache_control: { type: "ephemeral", ttl: "5m" } }] }
  const make = (tail: string) => fp({ messages: [marked, { role: "user", content: tail }] }, "anthropic-messages")
  expect(prefixDiff(make("private tail"), make("replacement tail"))).toMatchObject({ known: true, reusable: true, append: false, changes: [] })
  const a = { ...fp({ input: "prefix" }, "openai-responses"), responseId: sha256("response-fixture") }
  const b = fp({ input: "next", previous_response_id: "response-fixture" }, "openai-responses")
  expect(prefixDiff(a, b)).toMatchObject({ known: true, reusable: true, append: true })
  expect(prefixDiff(a, fp({ input: "next", previous_response_id: "unrelated" }, "openai-responses"))).toMatchObject({ known: true, reusable: false })
})

test("production fingerprint/ledger/export omit synthetic prompt, schema and option secret sentinels", async () => {
  const db = await ledger()
  const secret = "SYNTHETIC_SECRET_SENTINEL_3a97"
  db.session({ id: "fixture" }, 100)
  db.requestStarted({ id: "fixture", sessionID: "fixture", kind: "step", started: 100 })
  db.requestFingerprint(fp({ messages: [{ role: "system", content: secret }, { role: "user", content: secret }], tools: [{ type: "function", function: { name: "fixture", description: secret, parameters: { const: secret } } }], response_format: { type: "json_schema", schema: { const: secret } }, extension: secret }))
  const stored = db.db.query("select * from request_fingerprint").all()
  expect(JSON.stringify(stored)).not.toContain(secret)
  expect(JSON.stringify(db.getFingerprint("fixture"))).not.toContain(secret)
  expect(JSON.stringify(queryMonitor(db, { scope: "session", sessionID: "fixture", view: "cache", id: "fixture" }, { now: 200 }))).not.toContain(secret)
})

test("production content/tool/marker hashes round-trip through existing deltas below the 10% gate", async () => {
  const db = await ledger()
  const full = Array.from({ length: 100 }, (_, i) => ({
    ...fp({ messages: Array.from({ length: 128 + i }, (_, j) => ({ role: "user", content: `fixture ${j}`, ...(j === 64 ? { cache_control: { type: "ephemeral", ttl: "5m" } } : {}) })), tools: [{ name: "fixture", input_schema: { type: "object" }, strict: true }] }, "anthropic-messages"),
    requestID: `delta-${i}`,
  }))
  full.forEach((wire) => db.requestFingerprint(wire))
  full.forEach((wire) => {
    expect(db.getFingerprint(wire.requestID)?.messagePrefixes).toEqual(wire.messagePrefixes)
    expect(db.getFingerprint(wire.requestID)?.tools).toEqual(wire.tools)
    expect(db.getFingerprint(wire.requestID)?.cacheControl).toEqual(wire.cacheControl)
  })
  const rows = db.db.query<{ message_prefixes: string }, []>("select message_prefixes from request_fingerprint").all()
  expect(rows.reduce((sum, r) => sum + r.message_prefixes.length, 0) / full.reduce((sum, wire) => sum + JSON.stringify(wire.messagePrefixes).length, 0)).toBeLessThan(0.1)
})
