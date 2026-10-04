import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as OpenAIChat from "../src/protocols/openai-chat.js"
import { AIError, HttpContext, InvalidProviderOutputError, LLM } from "../src/index.js"
import { Anthropic } from "../src/providers.js"
import { Auth, Framing, HttpTransport, LLMClient, Route } from "../src/route.js"
import { fixedResponse, handlerLayer, runtimeLayer, truncatedStream } from "./lib/http.js"
import { sseEvents } from "./lib/sse.js"
import { it } from "./lib/effect.js"
import { isRetryable } from "../src/provider-error.js"

describe("Route.with", () => {
  test("merges endpoint query and header defaults while replacing auth and id", () => {
    const auth = Auth.headers({ "x-auth": "new" })
    const route = OpenAIChat.route
      .with({
        id: "base-chat",
        endpoint: {
          baseURL: "https://api.example.test/v1",
          query: { keep: "base", base: "1" },
        },
        headers: { "x-base": "base", "x-override": "base" },
        auth: Auth.headers({ "x-auth": "old" }),
      })
      .with({
        id: "patched-chat",
        endpoint: { query: { keep: "patch", patch: "1" } },
        headers: { "x-override": "patch", "x-patch": "patch" },
        auth,
      })

    expect(route.id).toBe("patched-chat")
    expect(route.auth).toBe(auth)
    expect(route.endpoint).toMatchObject({
      baseURL: "https://api.example.test/v1",
      path: "/chat/completions",
      query: { keep: "patch", base: "1", patch: "1" },
    })
    expect(route.defaults.headers).toEqual({
      "x-base": "base",
      "x-override": "patch",
      "x-patch": "patch",
    })
    expect(route.defaults.http?.headers).toEqual({
      "x-base": "base",
      "x-override": "patch",
      "x-patch": "patch",
    })
  })

  test("assigns metadata ownership to a replacement provider and preserves explicit overrides", () => {
    const route = OpenAIChat.route.with({ provider: "azure" })
    const overridden = route.with({ providerMetadataKey: "custom-azure" }).with({ headers: { "x-test": "value" } })

    expect(route.providerMetadataKey).toBe("azure")
    expect(overridden.providerMetadataKey).toBe("custom-azure")
    expect(overridden.defaults).not.toHaveProperty("providerMetadataKey")
  })
})

describe("Route diagnostics", () => {
  const route = OpenAIChat.route.with({ endpoint: { baseURL: "https://provider.test/v1" } })
  const request = LLM.request({ model: route.model({ id: "test" }), prompt: "Hello" })
  const headers = { "content-type": "text/event-stream", "x-request-id": "req_stream" }

  it.effect("retains an entire invalid event and its validation cause", () =>
    Effect.gen(function* () {
      const frame = '{ "choices": "invalid", "diagnostic": { "detail": "original" } }'
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents(frame), { headers })),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.reason.body).toBe(frame)
      expect(error.reason.cause).toMatchObject({ _tag: "SchemaError" })
      expect(error.reason.http).toEqual(
        new HttpContext({ url: "https://provider.test/v1/chat/completions", status: 200, headers }),
      )
    }),
  )

  it.effect("retains original provider error fields discarded by the event schema", () =>
    Effect.gen(function* () {
      const frame =
        '{ "error": { "message": "Rate limit exceeded", "code": "rate_limit_exceeded", "debug": { "trace": "original" } }, "request_id": "req_original" }'
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents(frame), { headers })),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("RateLimit")
      expect(error.message).toBe("Rate limit exceeded")
      expect(error.reason.body).toBe(frame)
      expect(error.reason.http?.headers["x-request-id"]).toBe("req_stream")
    }),
  )

  it.effect("preserves semantic parser bodies while replacing serialized event fallbacks", () =>
    Effect.forEach([undefined, '{"query": BROKEN}', ""], (body) =>
      Effect.gen(function* () {
        const cause = new Error("parser failure")
        const http = new HttpContext({
          url: "https://upstream.test/v1",
          status: 202,
          headers: { "x-trace": "precise" },
        })
        const frame = '{ "type": "failure", "debug": "not in schema" }'
        const failing = Route.make({
          id: "diagnostics",
          provider: "test",
          endpoint: route.endpoint,
          framing: Framing.sse,
          protocol: {
            ...OpenAIChat.protocol,
            stream: {
              event: Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
              initial: () => undefined,
              step: (_state, event) =>
                Effect.fail(
                  new AIError({
                    reason: new InvalidProviderOutputError({
                      message: "Parser failed",
                      body: body ?? JSON.stringify(event),
                      http,
                      cause,
                    }),
                  }),
                ),
            },
          },
        })
        const error = yield* LLMClient.generate(
          LLM.request({ model: failing.model({ id: "test" }), prompt: "Hello" }),
        ).pipe(Effect.provide(fixedResponse(sseEvents(frame), { headers })), Effect.flip)

        expect(error.message).toBe("Parser failed")
        expect(error.reason.body).toBe(body ?? frame)
        expect(error.reason.cause).toBe(cause)
        expect(error.reason.http).toBe(http)
      }),
    ),
  )

  it.effect("retains malformed assembled Anthropic hosted-tool arguments", () =>
    Effect.gen(function* () {
      const body = '{"query": BROKEN}'
      const error = yield* LLMClient.generate(
        LLM.request({
          model: Anthropic.configure({ apiKey: "test", baseURL: "https://provider.test" }).model("claude"),
          prompt: "Hello",
        }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "message_start", message: { usage: { input_tokens: 5 } } },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "server_tool_use", id: "srv1", name: "web_search" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"query": ' },
              },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "BROKEN}" } },
              { type: "content_block_stop", index: 0 },
            ),
            { headers },
          ),
        ),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.message).toContain("Invalid JSON input for anthropic-messages tool call web_search")
      expect(error.reason.body).toBe(body)
      expect(error.reason.cause).toBeInstanceOf(Error)
      expect(error.reason.http).toMatchObject({ status: 200, headers })
    }),
  )

  it.effect("adds successful HTTP metadata without replacing framing diagnostics", () =>
    Effect.gen(function* () {
      const cause = new Error("frame checksum mismatch")
      const failure = new AIError({
        reason: new InvalidProviderOutputError({
          message: "Invalid frame",
          body: "original frame representation",
          cause,
        }),
      })
      const failing = route.with({
        transport: HttpTransport.httpJson({ framing: { id: "failure", frame: () => Stream.fail(failure) } }),
      })
      const error = yield* LLMClient.generate(
        LLM.request({ model: failing.model({ id: "test" }), prompt: "Hello" }),
      ).pipe(Effect.provide(fixedResponse("wire bytes", { headers })), Effect.flip)

      expect(error.reason.body).toBe(failure.reason.body)
      expect(error.reason.cause).toBe(cause)
      expect(error.message).toBe(failure.message)
      expect(error.reason.http?.status).toBe(200)
      expect(error.reason.http?.headers).toEqual(headers)
    }),
  )

  it.effect("retains the original read error after successful response headers", () =>
    Effect.gen(function* () {
      const cause = new Error("socket disconnected")
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(truncatedStream([], cause)), Effect.flip)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "read" })
      expect(error.reason.cause).toBe(cause)
      expect(error.reason.http?.status).toBe(200)
      expect(error.reason.body).toBeUndefined()
    }),
  )

  it.effect("retains successful response headers on an incomplete stream", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse("", { headers })), Effect.flip)

      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput", classification: "incomplete-stream" })
      expect(error.reason.http?.headers).toEqual(headers)
      expect(error.reason.body).toBeUndefined()
    }),
  )
})

describe("HTTP idle timeout", () => {
  const route = OpenAIChat.route.with({ endpoint: { baseURL: "https://provider.test/v1" } })
  const request = LLM.request({ model: route.model({ id: "test" }), prompt: "Hello" })
  const headers = { "content-type": "text/event-stream" }

  it.effect("a body that sends one SSE chunk and then nothing fails with Transport idle-timeout, and isRetryable is true", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const chunk = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      const hangingStream = Stream.make(chunk).pipe(Stream.concat(Stream.never))
      const layer = runtimeLayer(
        handlerLayer((input) => {
          const res = input.respond(null, { headers })
          Object.defineProperty(res, "stream", { get: () => hangingStream })
          return Deferred.succeed(started, undefined).pipe(Effect.as(res))
        }),
      )

      const fiber = yield* LLMClient.generate(request, { idleTimeout: "5 seconds" }).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      yield* Effect.yieldNow
      yield* TestClock.adjust("5 seconds")
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)

      expect(error.reason).toMatchObject({
        _tag: "Transport",
        code: "idle-timeout",
        operation: "read",
        phase: "receive",
        delivery: "accepted",
      })
      expect(isRetryable(error)).toBe(true)
    }),
  )

  it.effect("headers that never arrive fail with operation: request", () =>
    Effect.gen(function* () {
      const layer = runtimeLayer(handlerLayer(() => Effect.never))

      const fiber = yield* LLMClient.generate(request, { idleTimeout: "5 seconds" }).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("5 seconds")
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)

      expect(error.reason).toMatchObject({
        _tag: "Transport",
        code: "idle-timeout",
        operation: "request",
        phase: "receive",
        delivery: "ambiguous",
      })
      expect(isRetryable(error)).toBe(true)
    }),
  )

  it.effect("a body that keeps sending : ping lines never times out", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const ping = new TextEncoder().encode(": ping\n\n")
      const done = new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"completed"},"finish_reason":"stop"}]}\n\n',
      )
      const stream = Stream.concat(
        Stream.fromEffect(Effect.sleep("2 seconds").pipe(Effect.as(ping))),
        Stream.fromEffect(Effect.sleep("2 seconds").pipe(Effect.as(ping))),
      ).pipe(
        Stream.concat(Stream.fromEffect(Effect.sleep("2 seconds").pipe(Effect.as(ping)))),
        Stream.concat(Stream.fromEffect(Effect.sleep("2 seconds").pipe(Effect.as(done)))),
      )
      const layer = runtimeLayer(
        handlerLayer((input) => {
          const res = input.respond(null, { headers })
          Object.defineProperty(res, "stream", { get: () => stream })
          return Deferred.succeed(started, undefined).pipe(Effect.as(res))
        }),
      )

      const fiber = yield* LLMClient.generate(request, { idleTimeout: "5 seconds" }).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      for (let i = 0; i < 4; i++) {
        yield* Effect.yieldNow
        yield* TestClock.adjust("2 seconds")
      }
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("completed")
    }),
  )
})
