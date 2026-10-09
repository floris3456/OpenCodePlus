import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Usage } from "../../src/index.js"
import { Auth, LLMClient } from "../../src/route.js"
import { AnthropicMessages } from "../../src/protocols/anthropic-messages.js"
import { OpenResponses } from "../../src/protocols/open-responses.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

test("Responses missing cache counts stay unknown; explicit zero and complete totals survive", () => {
  const missing = OpenResponses.mapUsage({ input_tokens: 100, output_tokens: 5 }, "test")
  expect(missing?.observation("final")).toMatchObject({ inputTokens: 100, outputTokens: 5 })
  expect(missing?.observation("final").cacheReadInputTokens).toBeUndefined()
  expect(missing?.observation("final").nonCachedInputTokens).toBeUndefined()
  const explicit = OpenResponses.mapUsage(
    { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
    "test",
  )
  expect(explicit?.observation("final")).toMatchObject({
    inputTokens: 100,
    cacheReadInputTokens: 0,
    nonCachedInputTokens: 100,
  })
  expect(OpenResponses.mapUsage(undefined, "test")).toBeUndefined()
  expect(OpenResponses.mapUsage(null, "test")).toBeUndefined()
})

test("accounting remains unchanged but invalid numeric observations are flagged and secrets excluded", () => {
  const usage = new Usage({
    inputTokens: 5,
    cacheReadInputTokens: 8,
    cacheWriteInputTokens: 0,
    outputTokens: Infinity,
    providerMetadata: { test: { body: "PRIVATE SENTINEL" } },
    provenance: {
      inputTokens: { source: "reported", completeness: "complete" },
      outputTokens: { source: "reported", completeness: "complete" },
    },
  })
  expect(usage.inputTokens).toBe(5)
  expect(usage.outputTokens).toBe(Infinity)
  expect(usage.observation("partial").inconsistent).toBe(true)
  expect(usage.observation("partial").outputTokens).toBeUndefined()
  expect(JSON.stringify(usage.observation("partial"))).not.toContain("PRIVATE")
  expect(new Usage({ inputTokens: 50 }).observation("final").inputTokens).toBeUndefined()
})

const request = LLM.request({
  model: AnthropicMessages.route
    .with({ endpoint: { baseURL: "https://anthropic.test/v1" }, auth: Auth.header("x-api-key", "fixture") })
    .model({ id: "claude-sonnet-4-5" }),
  prompt: "fixture",
})

;[false, true].forEach((complete) => {
  it.effect(
    `Anthropic cumulative frames preserve ${complete ? "complete" : "partial"} input without summing repeats`,
    () =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(request).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                {
                  type: "message_start",
                  message: {
                    usage: {
                      input_tokens: 5,
                      cache_read_input_tokens: 100,
                      ...(complete ? { cache_creation_input_tokens: 900 } : {}),
                    },
                  },
                },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
                { type: "message_delta", delta: {}, usage: { output_tokens: 2 } },
                { type: "message_stop" },
              ),
            ),
          ),
        )
        // The billing compatibility projection intentionally retains its old partial sum.
        expect(response.usage?.inputTokens).toBe(complete ? 1005 : 105)
        expect(response.usage?.outputTokens).toBe(2)
        expect(response.usage?.observation("final").inputTokens).toBe(complete ? 1005 : undefined)
        expect(response.usage?.observation("final").cacheReadInputTokens).toBe(100)
        expect(response.usage?.observation("final").provenance?.inputTokens?.completeness).toBe(
          complete ? "complete" : "partial",
        )
      }),
  )
})
