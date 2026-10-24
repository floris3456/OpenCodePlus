import { expect } from "bun:test"
import { LLM, LLMClient } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Database } from "@opencode/core/database/database"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Provider } from "@opencode/core/provider"
import { SessionTable } from "@opencode/core/session/sql"
import { Agent } from "@opencode/schema/agent"
import { Document, Info } from "@opencode/schema/config"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import Pacer from "@opencodeplus/cliproxyapi/pacer"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("cliproxyapi")
const modelID = Model.ID.make("gpt-6.1-sol")
const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))

const chunk = (delta: object, finish: string | null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", model: modelID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

it.live("shipped Pacer sends each CPA chat's own prompt cache key, a fork its source's", () =>
  Effect.gen(function* () {
    const bodies: Record<string, unknown>[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url)
            if (url.pathname === "/v1/models")
              return Response.json({
                object: "list",
                schema: "cliproxyapi.model-details/1",
                hash: "fixture",
                data: [
                  {
                    id: modelID,
                    providers: ["codex"],
                    kind: "chat",
                    context_length: 400000,
                    max_completion_tokens: 128000,
                    input_modalities: ["text"],
                    output_modalities: ["text"],
                    reasoning: { mode: "levels", levels: ["low", "high"] },
                    service_tiers: [],
                  },
                ],
              })
            if (url.pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
            bodies.push(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json()))
            return new Response(
              `${chunk({ role: "assistant", content: "OK" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
              {
                headers: { "content-type": "text/event-stream" },
              },
            )
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const config = (providers: object, revision: string) => ({
      ...ConfigProviderPlugin.Plugin,
      revision,
      effect: (ctx: Parameters<typeof ConfigProviderPlugin.Plugin.effect>[0]) =>
        ConfigProviderPlugin.Plugin.effect(ctx).pipe(
          Effect.provide(
            Config.testLayer([new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ providers }) })]),
          ),
        ),
    })
    const plugins = yield* Plugin.Service
    const models = yield* Model.Service
    const integrations = yield* Integration.Service
    const hooks = yield* PluginHooks.Service
    const database = yield* Database.Service
    const host = yield* PluginHost.make(plugins)
    const pacer = { ...PluginPromise.fromPromise(Pacer), revision: "1" }
    yield* plugins.activate([pacer, config({}, "1")])
    yield* integrations.connection.key({
      integrationID: Integration.ID.make("cliproxyapi"),
      key: "fixture-key",
      answer: { baseURL: `${server.url.origin}/v1` },
    })
    const loaded = yield* models
      .get(providerID, modelID)
      .pipe(
        Effect.repeat({ while: (model) => model === undefined, times: 100, schedule: Schedule.spaced("20 millis") }),
      )
    expect(loaded?.package).toBe("@opencode/ai/providers/openai-compatible")
    expect(loaded?.compatibility?.supportsPromptCacheKey).toBe(true)

    const parent = yield* host.session.create({ title: "Parent" })
    const child = yield* host.session.create({ parentID: parent.id })
    const fork = yield* host.session.create({ title: "Parent (fork #1)" })
    yield* database.db
      .update(SessionTable)
      .set({
        fork_session_id: parent.id,
        fork_boundary: { type: "through", messageID: SessionMessage.ID.make("msg_fork_boundary") },
      })
      .where(eq(SessionTable.id, fork.id))
      .run()
      .pipe(Effect.orDie)
    const requestKey = (sessionID: Session.ID, provider = providerID) =>
      hooks
        .trigger("session", "model.request", {
          sessionID,
          agent: Agent.ID.make("build"),
          model: Model.Ref.make({ providerID: provider, id: modelID }),
          kind: "primary",
          headers: {},
          promptCacheKey: parent.id,
        })
        .pipe(Effect.map((event) => event.promptCacheKey))
    expect(yield* requestKey(child.id)).toBe(child.id)
    expect(yield* requestKey(fork.id)).toBe(parent.id)
    expect(yield* requestKey(parent.id)).toBe(parent.id)
    expect(yield* requestKey(child.id, Provider.ID.make("openai"))).toBe(parent.id)

    // The key reaches CPA in the Chat Completions body, until the provider's config turns it off.
    const send = Effect.gen(function* () {
      const model = yield* models.get(providerID, modelID)
      if (!model) return yield* Effect.die("Missing CPA model")
      const native = yield* ModelResolver.fromCatalogModel(model, {
        type: "key",
        key: "fixture-key",
        configuration: { baseURL: `${server.url.origin}/v1` },
      })
      const response = yield* LLMClient.generate(
        LLM.request({ model: native, prompt: "Reply OK", promptCacheKey: child.id }),
      ).pipe(Effect.provide(client))
      expect(response.text).toBe("OK")
      return bodies.at(-1)
    })
    expect((yield* send)?.prompt_cache_key).toBe(child.id)
    yield* plugins.activate([pacer, config({ cliproxyapi: { compatibility: { supportsPromptCacheKey: false } } }, "2")])
    expect((yield* models.get(providerID, modelID))?.compatibility?.supportsPromptCacheKey).toBe(false)
    expect(yield* send).not.toHaveProperty("prompt_cache_key")
  }),
)
