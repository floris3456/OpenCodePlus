import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, Message } from "../src/index.js"
import { Anthropic, AnthropicCompatible } from "../src/providers.js"
import { compileRequest } from "../src/route/client.js"
import { testEffect } from "./lib/effect.js"
import { dynamicResponse } from "./lib/http.js"

// The compaction delta contains the entire summary, not incremental text.
const fixture = (content: string | null = "Keep building the website.", stop = "compaction") =>
  [
    { type: "message_start", message: { id: "msg_compact", usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "compaction", content, signature: "fixture-signature" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stop },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [{ type: "compaction", input_tokens: 51000, output_tokens: 400, cache_read_input_tokens: 2000 }],
      },
    },
    { type: "message_stop" },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

for (const model of [
  Anthropic.configure({ apiKey: "fixture" }).model("claude-opus-4-6"),
  AnthropicCompatible.configure({ baseURL: "https://relay.example/v1", provider: "relay" }).model("claude-opus-4-6"),
]) {
  const it = testEffect(dynamicResponse((input) => Effect.sync(() => {
    if (input.request.method === "GET") return input.respond(JSON.stringify({ capabilities: { compaction: { supported: true } } }))
    const body = JSON.parse(input.text)
    expect(input.request.headers["anthropic-beta"]).toContain("compact-2026-09-04")
    expect(input.request.headers["anthropic-beta"]).toContain("fixture-beta")
    expect(input.request.headers["anthropic-version"]).toBe("2023-06-01")
    expect(body.stream).toBe(true)
    expect(body.context_management).toBeNull()
    expect(body.compaction).toEqual({ type: "summarize" })
    expect(body.messages[0].content[0].text).toBe("History")
    return input.respond(fixture(), { headers: { "content-type": "text/event-stream" } })
  })))
  it.effect(`${model.provider}: trigger compaction returns a replayable checkpoint and iteration usage`, () =>
    Effect.gen(function* () {
      const request = LLM.request({ model, prompt: "History", http: { headers: { "anthropic-beta": "fixture-beta" } } })
      expect(LLMClient.canCompact(request, { mechanism: "trigger" })).toBe(true)
      const response = yield* LLMClient.compact(request, { mechanism: "trigger" })
      expect(response.checkpoint).toEqual({ type: "compaction", provider: model.provider, text: "Keep building the website.", signature: "fixture-signature" })
      expect(response.usage).toMatchObject({ inputTokens: 53000, nonCachedInputTokens: 51000, cacheReadInputTokens: 2000, outputTokens: 400 })
      const replay = yield* compileRequest(LLM.request({ model, messages: [Message.assistant(response.checkpoint), Message.user("Continue")] }))
      expect(replay.body).toMatchObject({ messages: [{ role: "assistant", content: [{ type: "compaction", content: "Keep building the website." }] }, { role: "user", content: [{ type: "text", text: "Continue" }] }] })
    }),
  )
}

// On-demand accepts the conversation as it stands, including an assistant ending.
for (const model of [
  Anthropic.configure({ apiKey: "fixture" }).model("claude-opus-4-6"),
  AnthropicCompatible.configure({ baseURL: "https://relay.example/v1", provider: "relay" }).model("claude-opus-4-6"),
]) {
  const it = testEffect(dynamicResponse((input) => Effect.sync(() => {
    if (input.request.method === "GET") return input.respond(JSON.stringify({ capabilities: { compaction: { supported: true } } }))
    const body = JSON.parse(input.text)
    const last = body.messages.at(-1)
    expect(last.role).toBe("assistant")
    expect(last.content.at(-1).text).toBe("Reply")
    return input.respond(fixture(), { headers: { "content-type": "text/event-stream" } })
  })))
  it.effect(`${model.provider}: on-demand compaction preserves an assistant-ending history`, () =>
    Effect.gen(function* () {
      const request = LLM.request({
        model,
        messages: [Message.user("History"), Message.assistant("Reply")],
      })
      const response = yield* LLMClient.compact(request, { mechanism: "trigger" })
      expect(response.checkpoint).toEqual({ type: "compaction", provider: model.provider, text: "Keep building the website.", signature: "fixture-signature" })
    }),
  )
}

// The next normal request replays the checkpoint on the Anthropic path: beta header + compaction block first.
const textFixture = (text: string) =>
  [
    { type: "message_start", message: { id: "msg_continue", usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 0, output_tokens: 5 } },
    { type: "message_stop" },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

for (const model of [
  Anthropic.configure({ apiKey: "fixture" }).model("claude-opus-4-6"),
  AnthropicCompatible.configure({ baseURL: "https://relay.example/v1", provider: "relay" }).model("claude-opus-4-6"),
]) {
  const it = testEffect(dynamicResponse((input) => Effect.sync(() => {
    const body = JSON.parse(input.text)
    expect(input.request.headers["anthropic-beta"]).toContain("compact-2026-09-04")
    expect(body.messages[0]).toEqual({ role: "assistant", content: [{ type: "compaction", content: "Keep building the website.", signature: "fixture-signature", cache_control: { type: "ephemeral" } }] })
    expect(body.messages[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "Continue" }] })
    // The replayed block needs its strategy, with a trigger that never compacts in-band before Core does.
    expect(body.context_management).toBeUndefined()
    return input.respond(textFixture("Continuing."), { headers: { "content-type": "text/event-stream" } })
  })))
  it.effect(`${model.provider}: a request after a native checkpoint replays the compaction block`, () =>
    Effect.gen(function* () {
      const checkpoint = { type: "compaction" as const, provider: model.provider, text: "Keep building the website.", signature: "fixture-signature" }
      const response = yield* LLMClient.generate(
        LLM.request({ model, messages: [Message.assistant(checkpoint), Message.user("Continue")] }),
      )
      expect(response.message.content).toEqual([{ type: "text", text: "Continuing." }])
    }),
  )
}

const responseLayer = (stream: string) => dynamicResponse((input) => Effect.succeed(input.respond(
  input.request.method === "GET" ? JSON.stringify({ capabilities: { compaction: { supported: true } } }) : stream,
)))

for (const [name, stream, message] of [
  ["null summary", fixture(null), "no usable summary checkpoint"],
  ["ordinary answer", fixture("Summary", "end_turn"), "without a summary"],
  ["truncated stream", fixture().replace("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", ""), "ended unexpectedly"],
] as const) {
  testEffect(responseLayer(stream)).effect(`trigger compaction refuses ${name}`, () => Effect.gen(function* () {
    const request = LLM.request({ model: Anthropic.configure({ apiKey: "fixture" }).model("claude-opus-4-6"), prompt: "History" })
    const error = yield* LLMClient.compact(request, { mechanism: "trigger" }).pipe(Effect.flip)
    expect(error.message).toContain(message)
  }))
}

// A completed call is billable even when its response cannot be used, and Core must be able to tell a
// normal answer (Anthropic did not trigger) from a compaction that produced no usable summary.
const usageError = () =>
  Effect.gen(function* () {
    const request = LLM.request({ model: Anthropic.configure({ apiKey: "fixture" }).model("claude-opus-4-6"), prompt: "History" })
    const error = yield* LLMClient.compact(request, { mechanism: "trigger" }).pipe(Effect.flip)
    if (error.reason._tag !== "InvalidProviderOutput") return yield* Effect.die("Expected InvalidProviderOutput")
    return error.reason
  })

for (const [name, stream, compaction] of [
  ["null summary", fixture(null), "unusable"],
  ["ordinary answer", fixture("Summary", "end_turn"), "unusable"],
] as const) {
  testEffect(responseLayer(stream)).effect(`trigger compaction reports the completed call's usage for ${name}`, () =>
    Effect.gen(function* () {
      const reason = yield* usageError()
      expect(reason.compaction).toBe(compaction)
      expect(reason.usage).toMatchObject({
        inputTokens: 53000,
        nonCachedInputTokens: 51000,
        cacheReadInputTokens: 2000,
        outputTokens: 400,
      })
    }),
  )
}

for (const body of [{ messages: [] }, { context_management: {} }, { stream: false }]) {
  testEffect(dynamicResponse(() => Effect.die("Invalid compaction must not reach HTTP"))).effect(
    `trigger compaction refuses raw ${Object.keys(body)[0]} overrides before HTTP`,
    () => Effect.gen(function* () {
      const request = LLM.request({ model: Anthropic.configure({ apiKey: "fixture" }).model("claude-opus-4-6"), prompt: "History", http: { body } })
      const error = yield* LLMClient.compact(request, { mechanism: "trigger" }).pipe(Effect.flip)
      expect(error.reason._tag).toBe("InvalidRequest")
    }),
  )
}
