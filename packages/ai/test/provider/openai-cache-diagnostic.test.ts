import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../../src/index.js"
import { Auth, LLMClient } from "../../src/route.js"
import { OpenAIResponses } from "../../src/protocols/openai-responses.js"
import { OpenAICompatibleResponses } from "../../src/protocols/openai-compatible-responses.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const request = LLM.request({
  model: OpenAIResponses.route
    .with({
      endpoint: { baseURL: "https://fixture.test/v1" },
      auth: Auth.bearer("PRIVATE_AUTH"),
    })
    .model({ id: "fixture" }),
  prompt: "PRIVATE_PROMPT",
})

const cases = [
  { type: "cache_hit", outcome: "cache_hit" },
  ...[
    "model_changed",
    "prompt_cache_key_changed",
    "service_tier_changed",
    "tools_changed",
    "text_format_changed",
    "reasoning_effort_changed",
    "verbosity_changed",
    "context_compacted",
    "input_changed",
  ].map((reason) => ({ type: "cache_miss", reason, outcome: "cache_miss" })),
  { type: "comparison_response_not_found", outcome: "unknown" },
  { type: "unavailable", outcome: "unknown" },
  { type: "PRIVATE_FUTURE_OUTCOME", outcome: "unknown" },
  { type: "cache_miss", reason: "PRIVATE_FUTURE_REASON", outcome: "unknown" },
  { type: "cache_miss", outcome: "unknown" },
]

cases.forEach((fixture, index) =>
  it.effect(`passive diagnostic ${index}: ${fixture.type} ${fixture.reason ?? ""}`, () =>
    Effect.gen(function* () {
      const sent: string[] = []
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          dynamicResponse((input) => {
            sent.push(input.text)
            const terminal = {
              type: "response.completed",
              response: {
                id: "PRIVATE_RESPONSE",
                output: [],
                prompt_cache_diagnostics: {
                  ...fixture,
                  comparison_reusable_tokens: 9000,
                  cache_missed_tokens: 8000,
                  error: "PRIVATE_ERROR",
                  prompt: "PRIVATE_PROMPT",
                  schema: "PRIVATE_SCHEMA",
                  auth: "PRIVATE_AUTH",
                },
                usage: {
                  input_tokens: 100,
                  output_tokens: 5,
                  input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
                },
              },
            }
            return Effect.succeed(
              input.respond(sseEvents(terminal, terminal), { headers: { "content-type": "text/event-stream" } }),
            )
          }),
        ),
      )
      const observation = response.usage?.observation("final")
      expect(observation).toMatchObject({ inputTokens: 100, cacheReadInputTokens: 10 })
      expect(observation?.promptCacheDiagnostic).toMatchObject({
        version: 1,
        source: "provider-reported",
        protocol: "openai-responses",
        outcome: fixture.outcome,
        reportedOutcome: fixture.type === "PRIVATE_FUTURE_OUTCOME" ? "unknown" : fixture.type,
      })
      expect(observation?.promptCacheDiagnostic?.reason).toBe(
        fixture.outcome === "cache_miss" ? fixture.reason : undefined,
      )
      expect(observation?.promptCacheDiagnostic?.cacheMissedTokens).toBe(
        fixture.type === "cache_miss" ? 8000 : undefined,
      )
      expect(JSON.stringify(observation)).not.toContain("PRIVATE")
      expect(sent).toHaveLength(1)
      // Exact control: receiving diagnostics never enables comparison, cache options, probes, or baseline persistence.
      expect(JSON.parse(sent[0]!)).toEqual({
        model: "fixture",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE_PROMPT" }] }],
        store: false,
        include: ["reasoning.encrypted_content"],
        stream: true,
      })
    }),
  ),
)
;[
  undefined,
  null,
  "PRIVATE_MALFORMED",
  {
    type: "cache_miss",
    reason: "tools_changed",
    comparison_reusable_tokens: -1,
    cache_missed_tokens: "PRIVATE_NUMBER",
  },
].forEach((diagnostic, index) =>
  it.effect(`absent/malformed diagnostic ${index} does not fail ordinary generation`, () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "response.completed",
              response: { output: [], prompt_cache_diagnostics: diagnostic },
            }),
          ),
        ),
      )
      expect(response.usage?.inputTokens).toBeUndefined()
      expect(response.usage?.observation("final").inputTokens).toBeUndefined()
      expect(response.usage?.promptCacheDiagnostic?.comparisonReusableTokens).toBeUndefined()
      expect(response.usage?.promptCacheDiagnostic?.cacheMissedTokens).toBeUndefined()
      expect(response.usage?.promptCacheDiagnostic?.outcome).toBe(
        index < 2 ? undefined : index === 2 ? "unknown" : "cache_miss",
      )
      expect(JSON.stringify(response.usage?.observation("final")) ?? "").not.toContain("PRIVATE")
    }),
  ),
)

it.effect("compatible Responses routes and incomplete responses do not acquire native diagnostics", () =>
  Effect.gen(function* () {
    const diagnostic = { type: "cache_miss", reason: "tools_changed", cache_missed_tokens: 10 }
    const compatible = LLM.request({
      model: OpenAICompatibleResponses.route
        .with({ endpoint: { baseURL: "https://proxy.test/v1" }, auth: Auth.none })
        .model({ id: "fixture", provider: "fixture" }),
      prompt: "fixture",
    })
    const response = yield* LLMClient.generate(compatible).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents({
            type: "response.completed",
            response: { output: [], usage: { input_tokens: 10 }, prompt_cache_diagnostics: diagnostic },
          }),
        ),
      ),
    )
    expect(response.usage?.promptCacheDiagnostic).toBeUndefined()
    const incomplete = yield* LLMClient.generate(request).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents({
            type: "response.incomplete",
            response: { output: [], usage: { input_tokens: 10 }, prompt_cache_diagnostics: diagnostic },
          }),
        ),
      ),
    )
    expect(incomplete.usage?.promptCacheDiagnostic).toBeUndefined()
  }),
)
