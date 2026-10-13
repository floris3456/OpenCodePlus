import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, Message } from "../src/index.js"
import { Anthropic } from "../src/providers.js"
import { compileRequest } from "../src/route/client.js"
import { testEffect } from "./lib/effect.js"
import { dynamicResponse } from "./lib/http.js"

const block = { type: "compaction", content: "Synthetic portable summary", signature: "synthetic-signature" }
const model = Anthropic.configure({ apiKey: "fixture" }).model("claude-opus-5-5")
const request = LLM.request({
  model, system: "Same system", messages: [Message.user("History"), Message.assistant("Reply")],
  generation: { maxTokens: 4096, stop: ["stop"] },
  http: { body: { stop_sequences: ["overlay-stop"], tool_choice: { type: "any" }, output_config: { format: { type: "json_schema", schema: { type: "object" } }, task_budget: { remaining: 10 } } } },
})
const events = [
  { type: "message_start", message: { id: "fixture", usage: { input_tokens: 0, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: block },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "compaction" }, usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 60, output_tokens: 584, cache_read_input_tokens: 46706, cache_creation_input_tokens: 0 }] } },
  { type: "message_stop" },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")

testEffect(dynamicResponse((input) => Effect.gen(function* () {
  if (input.request.method === "GET") return input.respond(JSON.stringify({ capabilities: { compaction: { supported: true } } }), { headers: { "content-type": "application/json" } })
  const before = yield* compileRequest(request)
  const body = JSON.parse(input.text)
  expect(input.request.headers["anthropic-beta"]).toContain("compact-2026-09-04")
  if (!body.compaction) {
    expect(body.messages[0]).toEqual({ role: "assistant", content: [{ ...block, cache_control: { type: "ephemeral" } }] })
    expect(body.context_management).toBeUndefined()
    return input.respond(events, { headers: { "content-type": "text/event-stream" } })
  }
  expect(body.messages).toEqual(before.body.messages)
  expect(body.system).toEqual(before.body.system)
  expect(body.compaction).toMatchObject({ type: "summarize" })
  expect(body.context_management).toBeNull()
  expect(body.stop_sequences).toBeUndefined()
  expect(body.tool_choice).toBeUndefined()
  expect(body.output_config?.format).toBeUndefined()
  expect(body.output_config?.task_budget?.remaining).toBeUndefined()
  expect(input.request.headers["anthropic-beta"]).toContain("compact-2026-09-04")
  return input.respond(events, { headers: { "content-type": "text/event-stream" } })
}))).effect("C2/B6 on-demand wire shape and whole-block streaming preserve signature and iteration usage", () => Effect.gen(function* () {
  const response = yield* LLMClient.compact(request, { mechanism: "trigger" })
  expect(response.usage).toMatchObject({ inputTokens: 46766, cacheReadInputTokens: 46706, outputTokens: 584 })
  expect(response.checkpoint).toMatchObject({ text: block.content, signature: block.signature })
  const replay = yield* compileRequest(LLM.request({ model, messages: [Message.assistant(response.checkpoint), Message.user("Continue")] }))
  expect(replay.body.messages[0]).toEqual({ role: "assistant", content: [{ ...block, cache_control: { type: "ephemeral" } }] })
  expect(replay.body.context_management).toBeUndefined()
  yield* LLMClient.generate(LLM.request({ model, messages: [Message.assistant(response.checkpoint), Message.user("Continue")] }))
}))

testEffect(dynamicResponse((input) => Effect.sync(() => {
  expect(input.request.method).toBe("GET")
  expect(input.request.headers["anthropic-beta"]).toContain("compact-2026-09-04")
  return input.respond(JSON.stringify({ capabilities: { compaction: { supported: false } } }), { headers: { "content-type": "application/json" } })
}))).effect("C2 unsupported on-demand model is refused before a summarization request", () => Effect.gen(function* () {
  const error = yield* LLMClient.compact(request, { mechanism: "trigger" }).pipe(Effect.flip)
  expect(error.reason._tag).toBe("UnsupportedOperation")
}))

testEffect(dynamicResponse((input) => Effect.sync(() => {
  expect(input.request.method).toBe("GET")
  return input.respond(JSON.stringify({ capabilities: { compaction: { supported: true } } }), { headers: { "content-type": "application/json" } })
}))).effect("C2 legacy unsigned blocks choose local conversion before an on-demand POST", () => Effect.gen(function* () {
  const error = yield* LLMClient.compact(LLM.request({ model, messages: [Message.assistant({ type: "compaction", provider: model.provider, text: "Legacy summary" }), Message.user("Continue")] }), { mechanism: "trigger" }).pipe(Effect.flip)
  expect(error.reason).toMatchObject({ _tag: "UnsupportedOperation", message: expect.stringContaining("Legacy threshold") })
}))

for (const stop of ["max_tokens", "model_context_window_exceeded", "compaction"] as const) {
  testEffect(dynamicResponse((input) => Effect.sync(() => {
    if (input.request.method === "GET") return input.respond(JSON.stringify({ capabilities: { compaction: { supported: true } } }), { headers: { "content-type": "application/json" } })
    return input.respond(events.replace('"stop_reason":"compaction"', `"stop_reason":"${stop}"`).replace(block.content, ""), { headers: { "content-type": "text/event-stream" } })
  }))).effect(`C2 no-summary ${stop} retains billed iteration usage in the failure`, () => Effect.gen(function* () {
    const error = yield* LLMClient.compact(request, { mechanism: "trigger" }).pipe(Effect.flip)
    expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput", compaction: "unusable", usage: { cacheReadInputTokens: 46706, outputTokens: 584 } })
  }))
}
