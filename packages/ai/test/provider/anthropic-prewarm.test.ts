import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMRequest } from "../../src/index.js"
import { Auth, Endpoint, LLMClient, Route } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import * as AnthropicMessages from "../../src/protocols/anthropic-messages.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse, json } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-opus-5-5" })

const usage = { input_tokens: 3, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 900, output_tokens: 0 }

const dropped = [
  { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
  { type: "thinking_dropped", path: "messages.3.content.0", reason: "prefix_binding_mismatch" },
]

describe("Anthropic zero-token pre-warm", () => {
  it.effect("sends the request unstreamed and reads the single Message reply", () =>
    Effect.gen(function* () {
      const request = LLM.request({ model, prompt: "ping", generation: { maxTokens: 0 } })
      const compiled = yield* compileRequest(request)
      expect(compiled.body).toMatchObject({ stream: false, max_tokens: 0 })

      const bodies: string[] = []
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.sync(() => {
              bodies.push(input.text)
              return json(input, {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-opus-5-5",
                content: [],
                stop_reason: "max_tokens",
                stop_sequence: null,
                usage,
              })
            }),
          ),
        ),
      )
      expect(JSON.parse(bodies[0]!)).toMatchObject({ stream: false, max_tokens: 0 })
      expect(response.text).toBe("")
      expect(response.finishReason).toMatchObject({ normalized: "length", raw: "max_tokens" })
      expect(response.usage).toMatchObject({
        cacheReadInputTokens: 120_000,
        cacheWriteInputTokens: 900,
        nonCachedInputTokens: 3,
        outputTokens: 0,
      })
    }),
  )

  it.effect("fails a zero-token reply that carries content", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "ping", generation: { maxTokens: 0 } })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.sync(() =>
              json(input, { type: "message", content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", usage }),
            ),
          ),
        ),
        Effect.flip,
      )
      expect(error.message).toContain("Anthropic returned content to a zero-token request")
    }),
  )

  it.effect("keeps streaming every request with an output budget", () =>
    Effect.gen(function* () {
      const compiled = yield* compileRequest(LLM.request({ model, prompt: "Hello", generation: { maxTokens: 20 } }))
      expect(compiled.body).toMatchObject({ stream: true, max_tokens: 20 })
    }),
  )

  it.effect("offers the pre-warm only where Anthropic accepts a zero-token request", () =>
    Effect.gen(function* () {
      const accepts = (patch: Partial<LLMRequest.Input>) =>
        model.route.supportsPrewarm?.(LLMRequest.update(LLM.request({ model, prompt: "Hello" }), patch))
      expect(accepts({})).toBe(true)
      expect(accepts({ providerOptions: { thinking: { type: "adaptive" }, effort: "xhigh" } })).toBe(true)
      expect(accepts({ providerOptions: { thinking: { type: "enabled", budgetTokens: 4096 } } })).toBe(false)
      expect(accepts({ providerOptions: { output_config: { format: { type: "json_schema", schema: {} } } } })).toBe(false)
      expect(accepts({ toolChoice: { type: "required" } })).toBe(false)
      expect(accepts({ toolChoice: { type: "tool", name: "lookup" } })).toBe(false)

      // A route that frames only server-sent events cannot read the unstreamed reply.
      const framed = Route.make({
        id: "custom-anthropic-messages",
        provider: "custom-anthropic",
        protocol: AnthropicMessages.protocol,
        endpoint: Endpoint.path("/messages", { baseURL: "https://compatible.test/v1" }),
        auth: Auth.header("x-api-key", "test"),
        framing: AnthropicMessages.framing,
      })
      expect(framed.supportsPrewarm).toBeUndefined()
    }),
  )
})

describe("Anthropic dropped-thinking report", () => {
  it.effect("reports thinking blocks dropped before a streamed request was read", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "message_start", message: { usage, input_transformations: dropped } },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
              { type: "message_stop" },
            ),
          ),
        ),
      )
      expect(response.text).toBe("Hi")
      expect(response.usage?.droppedThinking).toEqual({
        blocks: 2,
        first: "messages.1.content.0",
        reasons: ["prefix_binding_mismatch"],
      })
      expect(response.usage?.observation("final").droppedThinking).toEqual(response.usage?.droppedThinking)
      expect(response.usage?.outputTokens).toBe(2)
    }),
  )

  it.effect("reports thinking blocks dropped before a pre-warm was read", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "ping", generation: { maxTokens: 0 } })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.sync(() =>
              json(input, {
                type: "message",
                content: [],
                stop_reason: "max_tokens",
                usage,
                input_transformations: [dropped[0], { type: "other_change", path: "system" }],
              }),
            ),
          ),
        ),
      )
      expect(response.usage?.droppedThinking).toEqual({
        blocks: 1,
        first: "messages.1.content.0",
        reasons: ["prefix_binding_mismatch"],
      })
    }),
  )

  it.effect("ignores a malformed report and a response without drops", () =>
    Effect.gen(function* () {
      for (const input_transformations of [undefined, [], "unexpected", [{ path: 3 }]]) {
        const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                { type: "message_start", message: { usage, input_transformations } },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
                { type: "message_stop" },
              ),
            ),
          ),
        )
        expect(response.usage?.droppedThinking).toBeUndefined()
        expect(response.usage?.cacheReadInputTokens).toBe(120_000)
      }
    }),
  )
})
