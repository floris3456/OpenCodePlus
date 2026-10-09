import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LLMClient } from "@opencode/ai"
import { Anthropic } from "@opencode/ai/providers"
import { RequestExecutor } from "@opencode/ai/route"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import type { SessionModelObserved } from "@opencode/plugin/effect/session"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelObservation } from "@opencode/core/session/model-observation"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createLedger } from "../../plus/src/monitor/ledger.js"
import { watchMonitor } from "../../plus/src/monitor/plugin.js"
import { context } from "../../plus/test/harness.js"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))

it.live("Anthropic reported TTL buckets reach the Core observer and reopened ledger without changing accounting", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp("/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus/usage-buckets-")),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    )
    const ledger = yield* Effect.acquireRelease(
      Effect.sync(() => createLedger(path.join(directory, "monitor.db"))),
      (ledger) => Effect.sync(() => ledger.close()),
    )
    const received: string[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            received.push(await request.text())
            const events = [
              {
                type: "message_start",
                message: {
                  usage: {
                    input_tokens: 5,
                    cache_read_input_tokens: 100,
                    cache_creation_input_tokens: 900,
                    cache_creation: {
                      ephemeral_5m_input_tokens: 700,
                      ephemeral_1h_input_tokens: 200,
                      auth: "PRIVATE_BUCKET_AUTH",
                    },
                  },
                },
              },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
              { type: "message_stop" },
            ]
            return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
              headers: { "content-type": "text/event-stream" },
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
    yield* hooks.register("session", "model.observed", (event) => Effect.sync(() => observed.push(event)))
    yield* watchMonitor(
      context({ session: { hook: (name, callback, options) => hooks.register("session", name, callback, options) } }),
      () => undefined,
      () => ledger,
    )
    const session = Session.Info.make({
      id: Session.ID.make("ses_usage_buckets"),
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
    })
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    const prepared = yield* requests.primary({
      session,
      agent: Agent.ID.make("build"),
      system: [],
      messages: [],
      model: SessionRunnerModel.resolved(
        Anthropic.configure({ apiKey: "PRIVATE_AUTH", baseURL: server.url.toString() }).model("claude-sonnet-4-5"),
        {
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200000, output: 1000 },
        },
      ),
    })
    const response = yield* SessionModelObservation.run(
      prepared.observer,
      LLMClient.generate(prepared.request, prepared.options).pipe(
        Effect.tap((response) => SessionModelObservation.captureUsage(response.usage)),
      ),
    )
    expect(received).toHaveLength(1)
    expect(received[0]).not.toContain('"ttl"')
    expect(observed).toHaveLength(1)
    expect(response.usage?.inputTokens).toBe(1005)
    expect(observed[0]?.accounting?.tokens).toEqual({
      input: 5,
      output: 2,
      reasoning: 0,
      cache: { read: 100, write: 900 },
    })
    expect(observed[0]?.usage.cacheWriteInputTokensByTTL).toEqual({ "5m": 700, "1h": 200 })
    expect(Object.isFrozen(observed[0]?.usage.cacheWriteInputTokensByTTL)).toBe(true)
    expect(Object.isFrozen(observed[0]?.usage.provenance?.cacheWriteInputTokensByTTL?.["5m"])).toBe(true)
    expect(JSON.stringify(observed[0]?.usage)).not.toContain("PRIVATE")
    const reopened = yield* Effect.acquireRelease(
      Effect.sync(() => createLedger(ledger.path)),
      (ledger) => Effect.sync(() => ledger.close()),
    )
    const row = reopened.getRequests(session.id)[0]
    expect(row?.observation?.cacheWriteInputTokensByTTL).toEqual({ "5m": 700, "1h": 200 })
    expect(row?.inputTokens).toBe(5)
    expect(row?.cacheWriteTokens).toBe(900)
    expect(JSON.stringify(reopened.db.query("select observation from request").all())).not.toContain("PRIVATE")
  }).pipe(
    Effect.provide(SessionModelTransport.makeLayer({ open: () => Effect.die("Unexpected WebSocket") })),
    Effect.provide(client),
  ),
)
