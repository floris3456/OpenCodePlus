import { expect, test } from "bun:test"
import {
  DEFAULT_HOLD_MS,
  HOLD_MARKER,
  HOLD_REPLY,
  RECEIVED_MISSING,
  RECEIVED_SENTINEL,
  REFUSAL_ARGUMENTS,
  REFUSAL_CALL_ID,
  REFUSAL_COMMAND,
  REFUSAL_MARKER,
  REFUSAL_SENTINEL,
  REPLY,
  parseArgs,
  startLabProvider,
  usage,
  type LabProvider,
} from "../docs/round3-lab.js"

interface ToolCall {
  readonly id: string
  readonly function: { readonly name: string; readonly arguments: string }
}

interface Message {
  readonly role?: string
  readonly content?: string | null
  readonly tool_calls?: ReadonlyArray<ToolCall>
}

interface Choice {
  readonly message?: Message
  readonly delta?: { readonly role?: string; readonly content?: string }
  readonly finish_reason: string | null
}

interface Completion {
  readonly choices: ReadonlyArray<Choice>
}

interface ToolCallDelta {
  readonly id?: string
  readonly function?: { readonly name?: string; readonly arguments?: string }
}

interface StreamChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly role?: string; readonly content?: string; readonly tool_calls?: ReadonlyArray<ToolCallDelta> }
    readonly finish_reason?: string | null
  }>
}

function withServer(body: (provider: LabProvider) => Promise<void>): () => Promise<void> {
  return async () => {
    const provider = startLabProvider({ port: 0, holdMs: 300 })
    try {
      await body(provider)
    } finally {
      provider.stop()
    }
  }
}

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function completion(provider: LabProvider, body: Record<string, unknown>): Promise<Completion> {
  const response = await post(provider.url, "/v1/chat/completions", body)
  expect(response.status).toBe(200)
  return (await response.json()) as Completion
}

async function frames(provider: LabProvider, body: Record<string, unknown>): Promise<string[]> {
  const response = await post(provider.url, "/v1/chat/completions", { ...body, stream: true })
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const text = await response.text()
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length))
}

function chunks(frames: readonly string[]): StreamChunk[] {
  return frames.filter((frame) => frame !== "[DONE]").map((frame) => JSON.parse(frame) as StreamChunk)
}

function refusalExchange(result: string): ReadonlyArray<Record<string, unknown>> {
  return [
    { role: "user", content: `please ${REFUSAL_MARKER}` },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: REFUSAL_CALL_ID, type: "function", function: { name: "shell", arguments: REFUSAL_ARGUMENTS } }],
    },
    { role: "tool", tool_call_id: REFUSAL_CALL_ID, content: result },
  ]
}

test("binds loopback on an ephemeral port and replies with one deterministic short text", withServer(async (provider) => {
  expect(provider.url).toBe(`http://127.0.0.1:${provider.port}`)
  expect(provider.port).toBeGreaterThan(0)

  const marker = "round3-prompt-secret"
  const first = await completion(provider, { model: "fixture", messages: [{ role: "user", content: marker }] })
  expect(first.choices[0]?.message?.content).toBe(REPLY)
  expect(first.choices[0]?.message?.tool_calls).toBeUndefined()
  expect(first.choices[0]?.finish_reason).toBe("stop")

  const second = await completion(provider, { model: "fixture", messages: [{ role: "user", content: marker }] })
  expect(second.choices[0]?.message?.content).toBe(REPLY)

  expect(provider.proof()).toEqual({
    requests: 2,
    streams: 0,
    holds: 0,
    refusals: 0,
    refusalResults: 0,
    sentinelSeen: false,
  })
  // The fixture keeps no prompt content anywhere.
  const proof = await (await fetch(`${provider.url}/proof`)).text()
  expect(proof).not.toContain(marker)
}))

test("streams a reply as role, content, finish and DONE in order", withServer(async (provider) => {
  const streamed = await frames(provider, { model: "fixture", messages: [{ role: "user", content: "hello" }] })
  expect(streamed.at(-1)).toBe("[DONE]")
  const parsed = chunks(streamed)
  expect(parsed[0]?.choices?.[0]?.delta).toEqual({ role: "assistant" })
  expect(parsed[1]?.choices?.[0]?.delta).toEqual({ content: REPLY })
  expect(parsed.at(-1)?.choices?.[0]?.finish_reason).toBe("stop")
  expect(provider.proof().streams).toBe(1)
}))

test("answers ROUND3_REFUSAL with one native shell call while the exchange has no result", withServer(async (provider) => {
  const body = { model: "fixture", messages: [{ role: "user", content: REFUSAL_MARKER }] }
  const refusal = await completion(provider, body)
  const call = refusal.choices[0]?.message?.tool_calls?.[0]
  expect(refusal.choices[0]?.finish_reason).toBe("tool_calls")
  expect(refusal.choices[0]?.message?.content).toBeNull()
  expect(call?.id).toBe(REFUSAL_CALL_ID)
  expect(call?.function.name).toBe("shell")
  expect(JSON.parse(call?.function.arguments ?? "")).toEqual({ command: REFUSAL_COMMAND })

  const streamed = await frames(provider, body)
  const deltas = chunks(streamed).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [])
  expect(deltas[0]?.id).toBe(REFUSAL_CALL_ID)
  expect(deltas[0]?.function?.name).toBe("shell")
  expect(deltas.map((delta) => delta.function?.arguments ?? "").join("")).toBe(REFUSAL_ARGUMENTS)
  expect(chunks(streamed).at(-1)?.choices?.[0]?.finish_reason).toBe("tool_calls")
  expect(streamed.at(-1)).toBe("[DONE]")

  expect(provider.proof().refusals).toBe(2)
  expect(provider.proof().refusalResults).toBe(0)
}))

test("reports the real tool result, never fabricates the sentinel, and does not latch", withServer(async (provider) => {
  // A result without the sentinel is reported as missing.
  const missing = await completion(provider, { model: "fixture", messages: refusalExchange("the user denied this request") })
  expect(missing.choices[0]?.message?.content).toBe(RECEIVED_MISSING)
  expect(missing.choices[0]?.message?.tool_calls).toBeUndefined()
  expect(provider.proof().sentinelSeen).toBe(false)
  expect(provider.proof().refusalResults).toBe(1)

  // Reset clears the counters, not the exchange-based behaviour.
  const reset = await post(provider.url, "/reset", {})
  expect(reset.status).toBe(200)
  expect(await reset.json()).toEqual({
    ok: true,
    requests: 0,
    streams: 0,
    holds: 0,
    refusals: 0,
    refusalResults: 0,
    sentinelSeen: false,
  })

  // Only the exact sentinel counts, and it is acknowledged without re-calling.
  const seen = await completion(provider, {
    model: "fixture",
    messages: refusalExchange(`Denied by rule: ${REFUSAL_SENTINEL}`),
  })
  expect(seen.choices[0]?.message?.content).toBe(RECEIVED_SENTINEL)
  expect(seen.choices[0]?.message?.tool_calls).toBeUndefined()
  expect(provider.proof().sentinelSeen).toBe(true)

  // A new user prompt starts a new exchange and selects a fresh shell call.
  const again = await completion(provider, {
    model: "fixture",
    messages: [...refusalExchange(`Denied by rule: ${REFUSAL_SENTINEL}`), { role: "user", content: `try again ${REFUSAL_MARKER}` }],
  })
  expect(again.choices[0]?.finish_reason).toBe("tool_calls")
  expect(again.choices[0]?.message?.tool_calls?.[0]?.function.name).toBe("shell")
  expect(provider.proof().refusals).toBe(1)
  expect(provider.proof().refusalResults).toBe(1)

  // A normal message never selects a shell call, even with a refusal in history.
  const normal = await completion(provider, {
    model: "fixture",
    messages: [...refusalExchange(`Denied by rule: ${REFUSAL_SENTINEL}`), { role: "user", content: "and now a normal question" }],
  })
  expect(normal.choices[0]?.message?.content).toBe(REPLY)
  expect(normal.choices[0]?.message?.tool_calls).toBeUndefined()
  expect(provider.proof().refusals).toBe(1)
}))

test("keeps a ROUND3_HOLD stream open with periodic content tokens", withServer(async (provider) => {
  const started = Date.now()
  const streamed = await frames(provider, { model: "fixture", messages: [{ role: "user", content: `work ${HOLD_MARKER}` }] })
  const elapsed = Date.now() - started
  expect(elapsed).toBeGreaterThanOrEqual(300)
  const content = chunks(streamed)
    .map((chunk) => chunk.choices?.[0]?.delta?.content)
    .filter((text): text is string => text !== undefined)
  expect(content[0]).toBe(HOLD_REPLY)
  expect(content.length).toBeGreaterThanOrEqual(2)
  expect(chunks(streamed).at(-1)?.choices?.[0]?.finish_reason).toBe("stop")
  expect(streamed.at(-1)).toBe("[DONE]")
  expect(provider.proof().holds).toBe(1)
}))

test("POST /shutdown stops the owned server and unknown routes are 404", withServer(async (provider) => {
  const missing = await fetch(`${provider.url}/nope`)
  expect(missing.status).toBe(404)

  const response = await post(provider.url, "/shutdown", {})
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })

  let stopped = false
  for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
    stopped = await fetch(`${provider.url}/proof`).then(
      () => false,
      () => true,
    )
    if (!stopped) await Bun.sleep(25)
  }
  expect(stopped).toBe(true)
}))

test("the CLI documents the lab contract and parses only its flags", () => {
  const text = usage()
  expect(text).toContain("/v1/chat/completions")
  expect(text).toContain("--port")
  expect(text).toContain("--hold-ms")
  expect(text).toContain(String(DEFAULT_HOLD_MS))
  expect(parseArgs([])).toEqual({ help: false, port: undefined, holdMs: undefined })
  expect(parseArgs(["--port", "0", "--hold-ms", "5"])).toEqual({ help: false, port: 0, holdMs: 5 })
  expect(parseArgs(["--help"])).toEqual({ help: true, port: undefined, holdMs: undefined })
  expect(() => parseArgs(["--port", "-1"])).toThrow("non-negative integer")
  expect(() => parseArgs(["--nope"])).toThrow("unknown flag")
})