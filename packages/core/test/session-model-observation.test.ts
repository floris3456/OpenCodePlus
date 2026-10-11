import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AIError, LLMClient, TransportError } from "@opencode/ai"
import { OpenAI } from "@opencode/ai/providers"
import { RequestExecutor } from "@opencode/ai/route"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import type { SessionModelObserved } from "@opencode/plugin/effect/session"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Project } from "@opencode/core/project"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelObservation } from "@opencode/core/session/model-observation"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect, Exit, Layer, Logger, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { createLedger } from "../../plus/src/monitor/ledger.js"
import { watchMonitor } from "../../plus/src/monitor/plugin.js"
import { queryMonitor } from "../../plus/src/monitor/query.js"
import { context } from "../../plus/test/harness.js"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const session = Session.Info.make({
  id: Session.ID.make("ses_observation"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))

for (const mode of [
  "single",
  "retry",
  "fallback",
  "partial-stream",
  "duplicate-usage",
  "observer-failure",
  "wire-observer-failure",
  "promise-failure",
  "observer-timeout",
  "open-refusal",
  "write-refusal",
  "ws-write-refusal",
  "final-refusal",
  "native-hit",
  "native-miss",
  "native-expired",
  "native-unavailable",
  "native-unknown-reason",
  "native-unknown-outcome",
] as const) {
  it.live(`automatic monitor capture: ${mode}`, () => {
    const logs: unknown[] = []
    return Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          fs.mkdtemp(
            path.join(
              process.env.TMPDIR ?? "/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus",
              "observation-fixture-",
            ),
          ),
        ),
        (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
      )
      const ledger = yield* Effect.acquireRelease(
        Effect.sync(() => createLedger(path.join(directory, "monitor.db"))),
        (ledger) => Effect.sync(() => ledger.close()),
      )
      const received: string[] = []
      const native = mode === "native-hit" ? { type: "cache_hit" }
        : mode === "native-miss" ? { type: "cache_miss", reason: "tools_changed", comparison_reusable_tokens: 9000, cache_missed_tokens: 8000 }
        : mode === "native-expired" ? { type: "comparison_response_not_found" }
        : mode === "native-unavailable" ? { type: "unavailable" }
        : mode === "native-unknown-reason" ? { type: "cache_miss", reason: "PRIVATE_UNKNOWN_REASON" }
        : mode === "native-unknown-outcome" ? { type: "PRIVATE_UNKNOWN_OUTCOME" }
        : undefined
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              received.push(await request.text())
              if (mode === "retry" && received.length === 1)
                return Response.json(
                  { error: { message: "fixture refusal", type: "rate_limit_error" } },
                  { status: 429 },
                )
              if (mode === "partial-stream")
                return new Response('data: {"type":"response.created","response":{"id":"fixture"}}\n\n', {
                  headers: { "content-type": "text/event-stream" },
                })
              const terminal = `data: ${JSON.stringify({ type: "response.completed", response: { id: "PRIVATE_RESPONSE_ID", status: "completed", output: [], ...(native ? { prompt_cache_diagnostics: { ...native, prompt: "PRIVATE_DIAGNOSTIC_PROMPT", schema: "PRIVATE_DIAGNOSTIC_SCHEMA", auth: "PRIVATE_DIAGNOSTIC_AUTH", error: "PRIVATE_DIAGNOSTIC_ERROR" } } : {}), usage: { input_tokens: 1005, output_tokens: 5, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 900 }, private_metadata: "PRIVATE_USAGE_METADATA" } } })}\n\n`
              return new Response(mode === "duplicate-usage" ? terminal + terminal : terminal, {
                headers: { "content-type": "text/event-stream", "x-private": "PRIVATE_RESPONSE_HEADER" },
              })
            },
          }),
        ),
        (server) =>
          Effect.sync(() => {
            void server.stop(true)
          }),
      )
      const hooks = yield* PluginHooks.Service
      const observed: SessionModelObserved[] = []
      const promiseObserved: SessionModelObserved[] = []
      if (mode === "promise-failure") {
        const plugins = yield* Plugin.Service
        const host = yield* PluginHost.make(plugins)
        yield* PluginPromise.fromPromise({
          id: "observation-promise",
          async setup(ctx) {
            await ctx.session.hook("model.observed", async () => {
              throw new Error("PRIVATE_PROMISE_OBSERVER_ERROR")
            })
            await ctx.session.hook("model.observed", async (event) => {
              promiseObserved.push(event)
            })
          },
        }).effect(host)
      }
      if (mode === "observer-failure")
        yield* hooks.register("session", "model.observed", (event) =>
          Effect.sync(() => {
            expect(() => Object.assign(event.usage, { inputTokens: 7 })).toThrow()
            throw new Error("PRIVATE_OBSERVER_ERROR")
          }),
        )
      if (mode === "wire-observer-failure")
        yield* hooks.register("session", "http.request", (event) =>
          Effect.sync(() => {
            event.observers ??= []
            event.observers.push(() => Effect.die("PRIVATE_WIRE_OBSERVER_ERROR"))
          }),
        )
      if (mode === "observer-timeout") yield* hooks.register("session", "model.observed", () => Effect.never)
      if (mode === "final-refusal")
        yield* hooks.register("session", "model.observed", () =>
          Effect.sync(() => ledger.db.exec("pragma query_only = true")),
        )
      yield* hooks.register("session", "model.observed", (event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
      )
      const ctx = context({
        session: { hook: (name, callback, options) => hooks.register("session", name, callback, options) },
      })
      yield* watchMonitor(
        ctx,
        () => undefined,
        () => {
          if (mode === "open-refusal") throw new Error("PRIVATE_STORAGE_ERROR")
          return ledger
        },
      )
      if (mode === "fallback")
        yield* hooks.register("session", "experimental.ws.send", (event) =>
          Effect.sync(() => {
            if (!event.requestID) return
            ledger.requestEnded(event.requestID, {
              ended: Date.now(),
              status: "completed",
              usage: { input: 77, output: 3, reasoning: 0, cacheRead: 5, cacheWrite: 0, cost: 1 },
            })
          }),
        )
      if (mode === "write-refusal" || mode === "ws-write-refusal") ledger.db.exec("pragma query_only = true")
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const model = SessionRunnerModel.resolved(
        OpenAI.configure({ apiKey: "PRIVATE_AUTH_SENTINEL", baseURL: server.url.toString() }).responses("fixture"),
        {
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200000, output: 1000 },
          transport: mode === "fallback" || mode === "ws-write-refusal" ? "websocket" : undefined,
        },
      )
      const prepared = yield* requests.primary({
        session,
        model,
        agent: Agent.ID.make("build"),
        system: [],
        messages: [],
        webSocket: "session",
      })
      const call = SessionModelObservation.run(
        prepared.observer,
        LLMClient.generate(prepared.request, prepared.options).pipe(
          Effect.tap((response) => SessionModelObservation.captureUsage(response.usage)),
        ),
        { messageID: "A", operationID: "A" },
      )
      if (mode === "retry") expect(Exit.isFailure(yield* call.pipe(Effect.exit))).toBe(true)
      if (mode === "partial-stream") {
        expect(Exit.isFailure(yield* call.pipe(Effect.exit))).toBe(true)
        expect(received).toHaveLength(1)
        expect(observed).toHaveLength(1)
        expect(observed[0]).toMatchObject({ outcome: "failed", usage: { completeness: "unavailable" } })
        expect(ledger.getRequests(session.id)[0]?.observation?.inputTokens).toBeUndefined()
        return
      }
      const result = yield* call
      expect(result.usage?.inputTokens).toBe(1005)
      expect(received).toHaveLength(mode === "retry" ? 2 : 1)
      expect(observed).toHaveLength(mode === "retry" ? 2 : 1)
      const last = observed.at(-1)
      expect(last).toMatchObject({
        outcome: "completed",
        usage: { completeness: "final", inputTokens: 1005, cacheReadInputTokens: 100, cacheWriteInputTokens: 900 },
      })
      expect(Object.isFrozen(last)).toBe(true)
      if (native) {
        const diagnostic = last?.usage.promptCacheDiagnostic
        if (!diagnostic) throw new Error("Missing passive diagnostic")
        expect(diagnostic?.outcome).toBe(mode === "native-hit" ? "cache_hit" : mode === "native-miss" ? "cache_miss" : "unknown")
        expect(diagnostic?.source).toBe("provider-reported")
        expect(Object.isFrozen(diagnostic)).toBe(true)
        expect(() => Object.assign(diagnostic, { outcome: "cache_miss" })).toThrow()
        expect(JSON.stringify(last?.usage)).not.toContain("PRIVATE")
        expect(received[0]).not.toContain("comparison_response_id")
        expect(received[0]).not.toContain("prompt_cache_options")
        const stored = ledger.getRequests(session.id)[0]
        if (!stored) throw new Error("Missing observed request")
        expect(stored.observation?.promptCacheDiagnostic).toEqual(diagnostic)
        const reopened = yield* Effect.acquireRelease(
          Effect.sync(() => createLedger(ledger.path)),
          (ledger) => Effect.sync(() => ledger.close()),
        )
        expect(reopened.getRequest(stored.id)?.observation?.promptCacheDiagnostic).toEqual(diagnostic)
        expect(JSON.stringify(reopened.db.query("select observation from request").all())).not.toContain("PRIVATE")
        const detail = queryMonitor(reopened, { scope: "session", sessionID: session.id, view: "cache", id: stored.id })
        expect(detail.detail?.request.promptCacheDiagnostic).toEqual(diagnostic)
        expect(detail.detail?.request.measurement?.read).toBe(100)
        expect(detail.detail?.lines.join("\n")).toContain("Provider-reported cache diagnostic")
        expect(detail.detail?.lines.join("\n")).toContain("not actual usage or billing")
        expect(JSON.stringify(detail)).not.toContain("PRIVATE_DIAGNOSTIC")
      }
      if (mode === "retry") {
        expect(observed[0]?.outcome).toBe("failed")
        expect(observed[0]?.usage.completeness).toBe("unavailable")
        expect(observed[0]?.invocationID).not.toBe(last?.invocationID)
        expect(observed[0]?.exchanges[0]?.requestID).not.toBe(last?.exchanges[0]?.requestID)
        expect(observed[0]?.operationID).toBe("A")
      }
      if (mode === "fallback") {
        expect(last?.exchanges.map((exchange) => exchange.transport)).toEqual(["websocket", "http"])
        expect(new Set(last?.exchanges.map((exchange) => exchange.requestID)).size).toBe(2)
        const rows = ledger.getRequests(session.id)
        expect(rows).toHaveLength(3)
        expect(rows.filter((row) => row.observation?.inputTokens !== undefined)).toHaveLength(1)
        expect(rows.find((row) => row.id === last?.invocationID)?.observation).toMatchObject({
          scope: "invocation",
          inputTokens: 1005,
        })
        expect(
          rows.filter((row) => row.observation?.scope === "exchange").map((row) => row.observation?.completeness),
        ).toEqual(["unavailable", "unavailable"])
        expect(rows.reduce((sum, row) => sum + row.cacheReadTokens, 0)).toBe(100)
        expect(
          rows
            .filter((row) => row.observation?.scope === "exchange")
            .every((row) => row.inputTokens === 0 && row.cost === 0),
        ).toBe(true)
      }
      if (
        [
          "single",
          "retry",
          "duplicate-usage",
          "observer-failure",
          "wire-observer-failure",
          "promise-failure",
          "observer-timeout",
        ].includes(mode)
      ) {
        expect(ledger.getRequest(last?.exchanges[0]?.requestID ?? "")?.observation).toMatchObject({
          invocationID: last?.invocationID,
          scope: "invocation",
          inputTokens: 1005,
        })
      }
      if (
        [
          "observer-failure",
          "wire-observer-failure",
          "promise-failure",
          "observer-timeout",
          "open-refusal",
          "write-refusal",
          "ws-write-refusal",
          "final-refusal",
        ].includes(mode)
      )
        expect(logs.length).toBeGreaterThan(0)
      if (mode === "promise-failure") expect(promiseObserved).toHaveLength(1)
      if (mode === "duplicate-usage" && last) {
        const rows = ledger.getRequests(session.id)
        yield* hooks.trigger("session", "model.observed", last)
        yield* hooks.trigger("session", "model.observed", {
          ...last,
          kind: "title",
          messageID: "changed",
          usage: { ...last.usage, inputTokens: 999 },
        })
        expect(ledger.getRequests(session.id)).toEqual(rows)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.cacheReadTokens).toBe(100)
      }
      if (mode === "final-refusal" && last) {
        const count = logs.length
        yield* hooks.trigger("session", "model.observed", last)
        expect(logs).toHaveLength(count)
      }
      expect(JSON.stringify(logs)).not.toContain("PRIVATE_")
      expect(JSON.stringify(ledger.db.query("select * from request").all())).not.toContain("PRIVATE_")
      expect(JSON.stringify(ledger.db.query("select * from request_fingerprint").all())).not.toContain("PRIVATE_")
      expect(JSON.stringify(ledger.db.query("select * from context_fact").all())).not.toContain("PRIVATE_")
      if (["write-refusal", "ws-write-refusal", "open-refusal"].includes(mode))
        expect(ledger.getRequests(session.id)).toHaveLength(0)
      if (mode === "final-refusal") expect(ledger.getRequests(session.id)[0]?.observation).toBeUndefined()
    }).pipe(
      Effect.provide(
        SessionModelTransport.makeLayer({
          open: () =>
            Effect.succeed({
              sendText: () =>
                Effect.fail(
                  new AIError({
                    reason: new TransportError({
                      message: "fixture not sent",
                      transport: "websocket",
                      operation: "write",
                      phase: "send",
                      delivery: "not-sent",
                    }),
                  }),
                ),
              messages: Stream.never,
              close: Effect.void,
            }),
        }),
      ),
      Effect.provide(client),
      Effect.provide(
        Logger.layer([
          Logger.make((entry) => {
            logs.push(entry.message)
          }),
        ]),
      ),
    )
  })
}
