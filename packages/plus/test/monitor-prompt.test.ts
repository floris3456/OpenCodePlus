import { afterEach, expect, test } from "bun:test"
import { captureWire } from "../src/monitor/snapshot.js"
import { aliasWire, pruneWire, queryPrompt, wireBody, wireStore } from "../src/monitor/wire.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

const anthropic = (messages: unknown[], marker = 1) => JSON.stringify({
  model: "claude-fixture",
  max_tokens: 32000,
  system: [{ type: "text", text: "You are a fixture agent.\nSecond line." }],
  tools: [{ name: "read", description: "Read a file. More detail here.", input_schema: { type: "object" } }],
  messages: messages.map((message, index) => index === marker
    ? { ...(message as object), content: [...((message as { content: object[] }).content.slice(0, -1)), { ...((message as { content: object[] }).content.at(-1)!), cache_control: { type: "ephemeral" } }] }
    : message),
  stream: true,
})

const first = [
  { role: "user", content: [{ type: "text", text: "Find   the\nbug please" }] },
  { role: "assistant", content: [{ type: "thinking", thinking: "Look at the reader first.", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "read", input: { filePath: "src/a.ts" } }] },
]
const second = [
  ...first,
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "line one\nline two" }] },
]

test("each sent item is stored once, rebuilds the exact body, and is summarized deterministically", async () => {
  const db = await ledger()
  db.session({ id: "chat" }, 1)
  for (const [id, at, body] of [["a", 10, anthropic(first)], ["b", 20, anthropic(second, 2)]] as const) {
    db.requestStarted({ id, sessionID: "chat", kind: "step", started: at, provider: "fixture", model: "claude-fixture" })
    await captureWire(db, id, body, { sessionID: "chat", at })
  }
  expect(wireBody(db, "a")).toBe(anthropic(first))
  expect(wireBody(db, "b")).toBe(anthropic(second, 2))
  expect(db.db.query("select * from cache_wire").all()).toEqual([])
  // b repeats a's options, system, tool and first message; only its new items are stored.
  const store = wireStore(db)
  expect(store.query<{ n: number }, []>("select count(*) n from element").get()!.n).toBe(9)

  const prompt = queryPrompt(db, { sessionID: "chat" })
  expect(prompt).toMatchObject({ requestID: "b", position: 1, count: 2, older: "a", exact: true, protocol: "anthropic-messages", model: "fixture/claude-fixture" })
  expect(prompt.rows?.map((row) => [row.path, row.kind, row.summary, row.change, row.marker ?? false])).toEqual([
    ["model", "option", 'model = "claude-fixture"', "same", false],
    ["max_tokens", "option", "max_tokens = 32000", "same", false],
    ["system[0]", "system", "You are a fixture agent.", "same", false],
    ["tools[0]", "tool", "read — Read a file.", "same", false],
    ["messages[0].content[0]", "prompt", "Find the bug please", "same", false],
    // The cache hint moved off this message: same content, different bytes.
    ["messages[1].content[0]", "thinking", "Look at the reader first.", "marker", false],
    ["messages[1].content[1]", "call", "read src/a.ts", "marker", false],
    ["messages[2].content[0]", "result", "read · 17 chars · line one", "new", true],
    ["stream", "option", "stream = true", "same", false],
  ])
  expect(queryPrompt(db, { requestID: "b", direction: "older" }).rows?.every((row) => row.change === "first")).toBe(true)
})

test("a poll for the request already shown answers without rows, and Enter returns the item verbatim and readable", async () => {
  const db = await ledger()
  db.requestStarted({ id: "only", sessionID: "chat", kind: "step", started: 1 })
  await captureWire(db, "only", anthropic(first), { sessionID: "chat", at: 1 })
  expect(queryPrompt(db, { sessionID: "chat", known: "only" })).toEqual({ requestID: "only", unchanged: true })
  const call = queryPrompt(db, { requestID: "only" }).rows!.findIndex((row) => row.kind === "call")
  const detail = queryPrompt(db, { requestID: "only", row: call }).detail!
  expect(JSON.parse(detail.json)).toEqual({ type: "tool_use", id: "toolu_1", name: "read", input: { filePath: "src/a.ts" }, cache_control: { type: "ephemeral" } })
  expect(detail.text).toContain("input:\n  filePath: src/a.ts")
  expect(queryPrompt(db, { sessionID: "nothing-sent" })).toEqual({ count: 0 })
})

test("Responses items: function calls, outputs, reasoning and JSON-string arguments", async () => {
  const db = await ledger()
  const body = JSON.stringify({
    model: "gpt-fixture",
    instructions: "System text\nmore",
    input: [
      { role: "user", content: [{ type: "input_text", text: "<system-reminder>Plan mode</system-reminder>" }] },
      { type: "reasoning", summary: [], encrypted_content: "x".repeat(1200) },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: JSON.stringify({ command: "bun test\nmore" }) },
      { type: "function_call_output", call_id: "call_1", output: "3 pass" },
    ],
    tools: [{ type: "function", name: "shell", description: "Run a command.", parameters: {} }],
  })
  db.requestStarted({ id: "r", sessionID: "chat", kind: "step", started: 1 })
  await captureWire(db, "r", body, { sessionID: "chat", at: 1, url: "https://api.example/v1/responses" })
  const prompt = queryPrompt(db, { requestID: "r" })
  expect(prompt.protocol).toBe("openai-responses")
  expect(prompt.rows?.map((row) => [row.kind, row.summary])).toEqual([
    ["option", 'model = "gpt-fixture"'],
    ["system", "System text"],
    ["reminder", "Plan mode"],
    ["thinking", "encrypted · 1,200 chars"],
    ["call", "shell bun test more"],
    ["result", "shell · 6 chars · 3 pass"],
    ["tool", "shell — Run a command."],
  ])
  expect(queryPrompt(db, { requestID: "r", row: 4 }).detail?.text).toContain("arguments:\n  command:\n    bun test\n    more")
})

test("an invocation shares its final exchange's body, and retention removes items no request uses", async () => {
  const db = await ledger()
  db.requestStarted({ id: "old", sessionID: "chat", kind: "step", started: 5 })
  db.requestStarted({ id: "kept", sessionID: "chat", kind: "step", started: 500 })
  await captureWire(db, "old", anthropic(first), { sessionID: "chat", at: 5 })
  await captureWire(db, "kept", anthropic(second, 2), { sessionID: "chat", at: 500 })
  aliasWire(db, "invocation", "old")
  expect(wireBody(db, "invocation")).toBe(anthropic(first))
  pruneWire(db, 100)
  expect(wireBody(db, "old")).toBeUndefined()
  expect(wireBody(db, "invocation")).toBeUndefined()
  expect(wireBody(db, "kept")).toBe(anthropic(second, 2))
  // Only the surviving request's items remain.
  expect(wireStore(db).query<{ n: number }, []>("select count(*) n from element").get()!.n).toBe(8)
})

// A chat whose request `i` sends messages 0..i with the cache hint on the last.
async function chat(db: Awaited<ReturnType<typeof ledger>>, count: number, sessionID = "chat") {
  const history = Array.from({ length: count }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `message ${i}` }] }))
  const bodies = history.map((_, i) => anthropic(history.slice(0, i + 1), i))
  for (const [i, body] of bodies.entries()) {
    db.requestStarted({ id: `r${i}`, sessionID, kind: "step", started: 10 + i })
    await captureWire(db, `r${i}`, body, { sessionID, at: 10 + i })
  }
  return bodies
}

const count = (db: Awaited<ReturnType<typeof ledger>>, table: string) =>
  wireStore(db).query<{ n: number }, []>(`select count(*) n from ${table}`).get()!.n

test("a request stores only the rows it does not share with the chat's previous request", async () => {
  const db = await ledger()
  const bodies = await chat(db, 12)
  bodies.forEach((body, i) => expect(wireBody(db, `r${i}`)).toBe(body))
  // r0 stores model, max_tokens, system, tools, its message and stream. Each later
  // request shares the four options and every message but the one that lost its
  // cache hint, and stores that message, its new one and stream.
  expect(count(db, "wire_row")).toBe(6 + 11 * 3)
  expect(queryPrompt(db, { requestID: "r11" }).rows?.map((row) => row.change)).toEqual([
    ...Array(14).fill("same"), "marker", "new", "same",
  ])
})

test("every 64th request of a chain stores its list in full", async () => {
  const db = await ledger()
  const bodies = await chat(db, 70)
  expect(wireStore(db).query("select source from wire where source not in (select source from wire_base) order by at").all())
    .toEqual([{ source: "r0" }, { source: "r64" }])
  expect(wireStore(db).query<{ depth: number }, []>("select max(depth) depth from wire_base").get()!.depth).toBe(63)
  bodies.forEach((body, i) => expect(wireBody(db, `r${i}`)).toBe(body))
})

test("storing a request again keeps the requests that share its old rows intact", async () => {
  const db = await ledger()
  const bodies = await chat(db, 3)
  await captureWire(db, "r1", bodies[1]!, { sessionID: "chat", at: 11 })
  expect(count(db, "wire_row")).toBe(6 + 2 * 3)
  const replaced = anthropic([{ role: "user", content: [{ type: "text", text: "replaced" }] }], 0)
  await captureWire(db, "r1", replaced, { sessionID: "chat", at: 11 })
  expect(wireBody(db, "r1")).toBe(replaced)
  expect(wireBody(db, "r0")).toBe(bodies[0])
  expect(wireBody(db, "r2")).toBe(bodies[2])
})

test("retention keeps a full copy of a request whose shared rows expire", async () => {
  const db = await ledger()
  const bodies = await chat(db, 3)
  pruneWire(db, 11)
  expect(wireBody(db, "r0")).toBeUndefined()
  expect(wireBody(db, "r1")).toBe(bodies[1])
  expect(wireBody(db, "r2")).toBe(bodies[2])
  expect(wireStore(db).query("select source, base from wire_base").all()).toEqual([{ source: "r2", base: "r1" }])
})

test("a request whose shared rows another version removed reads as unavailable", async () => {
  const db = await ledger()
  await chat(db, 2)
  wireStore(db).query("delete from wire_row where source = 'r0'").run()
  expect(wireBody(db, "r1")).toBeUndefined()
  expect(queryPrompt(db, { requestID: "r1" }).rows).toEqual([])
})

test("a body that cannot be rebuilt exactly keeps its compressed copy", async () => {
  const db = await ledger()
  const pretty = JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "hi" }] }, null, 2)
  db.requestStarted({ id: "pretty", sessionID: "chat", kind: "step", started: 1 })
  await captureWire(db, "pretty", pretty, { sessionID: "chat", at: 1 })
  expect(queryPrompt(db, { requestID: "pretty" })).toMatchObject({ exact: false, rows: [{ kind: "option" }, { kind: "prompt", summary: "hi" }] })
  expect(db.db.query("select request_id from cache_wire").all()).toEqual([{ request_id: "pretty" }])
})
