import { expect } from "bun:test"
import { LLM, LLMClient } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Provider } from "@opencode/core/provider"
import { Document, Info } from "@opencode/schema/config"
import Pacer from "@opencodeplus/cliproxyapi/pacer"
import { Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("cliproxyapi")
const modelID = Model.ID.make("claude-opus-5-5")
const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))

it.live("shipped Pacer migrates legacy effort at the wire boundary across startup and reload", () =>
  Effect.gen(function* () {
    const requests: Record<string, unknown>[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/v1/models") return Response.json({
            object: "list",
            schema: "cliproxyapi.model-details/1",
            hash: "fixture",
            data: [{
              id: modelID, providers: ["claude"], kind: "chat",
              context_length: 1000000, max_completion_tokens: 128000,
              input_modalities: ["text"], output_modalities: ["text"],
              reasoning: { mode: "levels", levels: ["low", "high"] }, service_tiers: [],
            }],
          })
          if (url.pathname !== "/v1/messages") return new Response(null, { status: 404 })
          const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json())
          requests.push(body)
          if ("reasoning" in body) return Response.json({
            error: { type: "invalid_request_error", message: "reasoning: Extra inputs are not permitted" },
          }, { status: 400 })
          return new Response([
            { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: modelID, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const entries = [new Document({
      type: "document",
      info: Schema.decodeUnknownSync(Info)({ providers: { cliproxyapi: {
        models: {
          [modelID]: { variants: [
            {
              id: "high", headers: { "x-user": "retained" },
              // The label is not necessarily the requested effort.
              body: { reasoning: { effort: "low" }, metadata: { user_id: "fixture" } },
            },
            { id: "native", settings: { thinking: { type: "disabled" }, effort: "max" } },
            { id: "unknown", body: { reasoning: { effort: "high", summary: "concise" } } },
          ] },
          "legacy-model": {
            package: "@opencode/ai/providers/anthropic-compatible",
            modelID: "claude-3-7-sonnet", limit: { output: 64000 },
            body: { reasoning: { effort: "high" } },
          },
          "gpt-custom": {
            package: "@opencode/ai/providers/openai",
            variants: [{ id: "high", body: { reasoning: { effort: "high" } } }],
          },
          "claude-custom": {
            package: "@opencode/ai/providers/openai",
            variants: [{ id: "high", body: { reasoning: { effort: "high" } } }],
          },
        },
      } } }),
    })]
    const original = JSON.stringify(entries)
    const config = {
      ...ConfigProviderPlugin.Plugin,
      revision: "1",
      effect: (ctx: Parameters<typeof ConfigProviderPlugin.Plugin.effect>[0]) =>
        ConfigProviderPlugin.Plugin.effect(ctx).pipe(Effect.provide(Config.testLayer(entries))),
    }
    const plugins = yield* Plugin.Service
    const models = yield* Model.Service
    const providers = yield* Provider.Service
    const integrations = yield* Integration.Service
    const pacer = { ...PluginPromise.fromPromise(Pacer), revision: "1" }
    yield* plugins.activate([pacer, config])
    yield* integrations.connection.key({
      integrationID: Integration.ID.make("cliproxyapi"),
      key: "fixture-key", answer: { baseURL: `${server.url.origin}/v1` },
    })
    const loaded = yield* models.get(providerID, modelID).pipe(Effect.repeat({
      while: (model) => model?.package !== "@opencode/ai/providers/anthropic-compatible",
      times: 100, schedule: Schedule.spaced("20 millis"),
    }))
    expect(loaded?.package).toBe("@opencode/ai/providers/anthropic-compatible")
    for (const stage of ["startup", "config reload", "catalogue rebuild", "plugin restart"]) {
      if (stage === "config reload") yield* plugins.activate([pacer, { ...config, revision: "2" }])
      if (stage === "catalogue rebuild") yield* providers.reload()
      if (stage === "plugin restart") yield* plugins.activate([{ ...pacer, revision: "2" }, { ...config, revision: "2" }])
      const configured = yield* models.get(providerID, modelID)
      expect(configured?.package).toBe("@opencode/ai/providers/anthropic-compatible")
      if (!configured) return yield* Effect.die("Missing Claude model")
      const selected = yield* ModelResolver.withVariant(configured, Model.VariantID.make("high"))
      const native = yield* ModelResolver.fromCatalogModel(selected, {
        type: "key", key: "fixture-key", configuration: { baseURL: `${server.url.origin}/v1` },
      })
      const response = yield* LLMClient.generate(LLM.request({ model: native, prompt: "Reply OK" })).pipe(Effect.provide(client))
      expect(response.text).toBe("OK")
      expect(requests.at(-1)).not.toHaveProperty("reasoning")
      expect(requests.at(-1)).toMatchObject({
        thinking: { type: "adaptive" }, output_config: { effort: "low" }, metadata: { user_id: "fixture" },
      })
      expect(selected.headers?.["x-user"]).toBe("retained")
      expect(configured.variants.find((variant) => variant.id === "native")).toMatchObject({
        settings: { thinking: { type: "disabled" }, effort: "max" },
      })
      expect(configured.variants.find((variant) => variant.id === "unknown")?.body).toEqual({
        reasoning: { effort: "high", summary: "concise" },
      })
      const legacy = yield* models.get(providerID, Model.ID.make("legacy-model"))
      expect(legacy?.body).not.toHaveProperty("reasoning")
      expect(legacy?.settings?.thinking).toEqual({ type: "enabled", budgetTokens: 16000 })
      expect(legacy?.settings).not.toHaveProperty("effort")
      for (const id of ["gpt-custom", "claude-custom"]) {
        const other = yield* models.get(providerID, Model.ID.make(id))
        expect(other?.package).toBe("@opencode/ai/providers/openai")
        expect(other?.variants[0]?.body).toEqual({ reasoning: { effort: "high" } })
      }
      // Control: the same transport still receives a 400 for an unconverted raw
      // override. The fixture does not accept the bad payload or hide the error.
      const rejected = yield* LLMClient.generate(LLM.request({
        model: native, prompt: "Reply OK", http: { body: { reasoning: { effort: "low" } } },
      })).pipe(Effect.provide(client), Effect.flip)
      expect(rejected.message).toContain("reasoning: Extra inputs are not permitted")
    }
    expect(JSON.stringify(entries)).toBe(original)
  }),
)
