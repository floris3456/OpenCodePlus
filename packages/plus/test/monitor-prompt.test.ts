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

test("a body that cannot be rebuilt exactly keeps its compressed copy", async () => {
  const db = await ledger()
  const pretty = JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "hi" }] }, null, 2)
  db.requestStarted({ id: "pretty", sessionID: "chat", kind: "step", started: 1 })
  await captureWire(db, "pretty", pretty, { sessionID: "chat", at: 1 })
  expect(queryPrompt(db, { requestID: "pretty" })).toMatchObject({ exact: false, rows: [{ kind: "option" }, { kind: "prompt", summary: "hi" }] })
  expect(db.db.query("select request_id from cache_wire").all()).toEqual([{ request_id: "pretty" }])
})
