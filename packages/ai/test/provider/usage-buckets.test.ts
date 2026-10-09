import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Usage } from "../../src/index.js"
import { Auth, LLMClient } from "../../src/route.js"
import { AnthropicMessages } from "../../src/protocols/anthropic-messages.js"
import { OpenAIChat } from "../../src/protocols/openai-chat.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { finishChunk, usageChunk } from "../lib/openai-chunks.js"
import { sseEvents } from "../lib/sse.js"

const request = LLM.request({
  model: AnthropicMessages.route
    .with({ endpoint: { baseURL: "https://fixture.test/v1" }, auth: Auth.header("x-api-key", "fixture") })
    .model({ id: "claude-sonnet-4-5" }),
  prompt: "fixture",
})
const complete = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 900 }
const parse = (start: object, final: object = { output_tokens: 2 }) =>
  LLMClient.generate(request).pipe(
    Effect.provide(
      fixedResponse(
        sseEvents(
          { type: "message_start", message: { usage: start } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: final },
          { type: "message_delta", delta: {}, usage: final },
          { type: "message_stop" },
        ),
      ),
    ),
  )

it.effect("reported TTL buckets survive output-only/repeated cumulative frames without changing totals", () =>
  Effect.gen(function* () {
    const usage = (yield* parse({
      ...complete,
      cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 200, private: "PRIVATE_BUCKET" },
    })).usage
    expect(usage?.cacheWriteInputTokensByTTL).toEqual({ "5m": 700, "1h": 200 })
    expect(usage?.observation("final").cacheWriteInputTokensByTTL).toEqual({ "5m": 700, "1h": 200 })
    expect(usage?.inputTokens).toBe(1005)
    expect(usage?.cacheWriteInputTokens).toBe(900)
    expect(usage?.outputTokens).toBe(2)
    expect(usage?.observation("final").inconsistent).toBe(false)
    expect(Object.isFrozen(usage?.observation("final").cacheWriteInputTokensByTTL)).toBe(true)
    expect(JSON.stringify(usage?.observation("final"))).not.toContain("PRIVATE")
  }),
)

it.effect(
  "final bucket object replaces earlier cumulative buckets; changed total without buckets invalidates stale detail",
  () =>
    Effect.gen(function* () {
      const start = { ...complete, cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 200 } }
      const changed = (yield* parse(start, {
        output_tokens: 2,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 1000 },
      })).usage
      expect(changed?.observation("final").cacheWriteInputTokensByTTL?.["5m"]).toBe(1000)
      expect(changed?.observation("final").cacheWriteInputTokensByTTL?.["1h"]).toBeUndefined()
      const missing = (yield* parse(start, { output_tokens: 2, cache_creation_input_tokens: 1000 })).usage
      expect(missing?.cacheWriteInputTokens).toBe(1000)
      expect(missing?.observation("final").cacheWriteInputTokensByTTL).toBeUndefined()
    }),
)

for (const [label, bucket, expected] of [
  ["explicit zero", 0, 0],
  ["missing", undefined, undefined],
  ["negative", -1, undefined],
  ["nonfinite", 1e999, undefined],
  ["invalid type", "PRIVATE_INVALID", undefined],
] as const) {
  it.effect(`TTL bucket ${label} is not inferred from its aggregate`, () =>
    Effect.gen(function* () {
      const usage = (yield* parse({ ...complete, cache_creation: { ephemeral_5m_input_tokens: bucket } })).usage
      expect(usage?.observation("final").cacheWriteInputTokensByTTL?.["5m"]).toBe(expected)
      expect(usage?.observation("final").cacheWriteInputTokensByTTL?.["1h"]).toBeUndefined()
      expect(usage?.cacheWriteInputTokens).toBe(900)
      expect(usage?.inputTokens).toBe(1005)
      expect(JSON.stringify(usage?.observation("final"))).not.toContain("PRIVATE")
    }),
  )
}

it.effect("iteration bucket partial sums stay partial rather than complete aggregate measurements", () =>
  Effect.gen(function* () {
    const usage = (yield* parse({
      iterations: [
        { ...complete, cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 } },
        { ...complete, cache_creation: { ephemeral_5m_input_tokens: 900 } },
      ],
    })).usage
    expect(usage?.cacheWriteInputTokensByTTL).toEqual({ "5m": 1800, "1h": 0 })
    expect(usage?.observation("final").cacheWriteInputTokensByTTL?.["5m"]).toBe(1800)
    expect(usage?.observation("final").cacheWriteInputTokensByTTL?.["1h"]).toBeUndefined()
    expect(usage?.observation("final").provenance?.cacheWriteInputTokensByTTL?.["1h"]?.completeness).toBe("partial")
    expect(usage?.inputTokens).toBe(2010)
  }),
)

it.effect("nonfinite JSON numeric bucket is ignored by the real parser without failing model work", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(request).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents(
            '{"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":900,"cache_creation":{"ephemeral_5m_input_tokens":1e999,"ephemeral_1h_input_tokens":0}}}}',
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ),
        ),
      ),
    )
    expect(response.usage?.inputTokens).toBe(1005)
    expect(response.usage?.observation("final").cacheWriteInputTokensByTTL?.["5m"]).toBeUndefined()
    expect(response.usage?.observation("final").cacheWriteInputTokensByTTL?.["1h"]).toBe(0)
    expect(response.usage?.observation("final").provenance?.cacheWriteInputTokensByTTL?.["5m"]?.completeness).toBe(
      "partial",
    )
  }),
)

it.effect("malformed optional TTL detail cannot fail model work or supply buckets", () =>
  Effect.gen(function* () {
    const usage = (yield* parse({ ...complete, cache_creation: "PRIVATE_MALFORMED" })).usage
    expect(usage?.inputTokens).toBe(1005)
    expect(usage?.cacheWriteInputTokens).toBe(900)
    expect(usage?.observation("final").cacheWriteInputTokensByTTL).toBeUndefined()
    expect(JSON.stringify(usage?.observation("final"))).not.toContain("PRIVATE")
  }),
)

it.effect("reported buckets cannot manufacture missing write totals or change compatibility accounting", () =>
  Effect.gen(function* () {
    const usage = (yield* parse({
      input_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 200 },
    })).usage
    expect(usage?.cacheWriteInputTokens).toBeUndefined()
    expect(usage?.inputTokens).toBe(105)
    expect(usage?.observation("final").inputTokens).toBeUndefined()
    expect(usage?.observation("final").cacheWriteInputTokensByTTL).toEqual({ "5m": 700, "1h": 200 })
  }),
)

test("inconsistent/invalid buckets do not alter accounting and unavailable observations cannot expose buckets", () => {
  for (const bucket of [-1, Infinity, 901, 899]) {
    const usage = new Usage({
      cacheWriteInputTokens: 900,
      cacheWriteInputTokensByTTL: { "5m": bucket, "1h": 0 },
      provenance: {
        cacheWriteInputTokensByTTL: {
          "5m": { source: "reported", completeness: "complete" },
          "1h": { source: "reported", completeness: "complete" },
        },
      },
    })
    expect(usage.observation("final").inconsistent).toBe(true)
    expect(usage.cacheWriteInputTokens).toBe(900)
    expect(usage.observation("unavailable").cacheWriteInputTokensByTTL).toBeUndefined()
  }
})

for (const cached of [undefined, 0, 50]) {
  it.effect(`OpenAI Chat local mapper reports sparse provenance for cache read ${cached}`, () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          model: OpenAIChat.route
            .with({ endpoint: { baseURL: "https://fixture.test/v1" }, auth: Auth.bearer("fixture") })
            .model({ id: "fixture" }),
          prompt: "fixture",
        }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              finishChunk("stop"),
              usageChunk({
                prompt_tokens: 100,
                completion_tokens: 5,
                prompt_tokens_details: { cached_tokens: cached },
              }),
              "[DONE]",
            ),
          ),
        ),
      )
      expect(response.usage?.observation("final").inputTokens).toBe(100)
      expect(response.usage?.observation("final").cacheReadInputTokens).toBe(cached)
      expect(response.usage?.observation("final").cacheWriteInputTokens).toBeUndefined()
      expect(response.usage?.observation("final").nonCachedInputTokens).toBeUndefined()
      expect(response.usage?.inputTokens).toBe(100)
    }),
  )
}
