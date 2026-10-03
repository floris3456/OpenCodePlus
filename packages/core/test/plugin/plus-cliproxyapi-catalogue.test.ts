import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { catalogueSync } from "@opencode/plus/cliproxyapi"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

// The OpenCodePlus CLIProxyAPI plugin registers before ConfigProviderPlugin (internal
// `pre` list): its discovered models are the base that providers.<id>.models refine.
const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Info)
const providerID = Provider.ID.make("cpa")

const details = (hash: string) => ({
  object: "list",
  schema: "cliproxyapi.model-details/1",
  hash,
  data: [
    {
      id: "claude-opus-5-5",
      display_name: "Claude Opus 5.5",
      kind: "chat",
      providers: ["claude"],
      context_length: 1_000_000,
      max_completion_tokens: 128_000,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      reasoning: { mode: "levels", levels: ["low", "medium", "high", "xhigh", "max"] },
      service_tiers: [],
    },
    {
      id: "gpt-6-astra",
      kind: "chat",
      providers: ["codex"],
      // Codex's 272k is the prompt budget; the 128k reply comes on top.
      context_length: 400_000,
      input_length: 272_000,
      max_completion_tokens: 128_000,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      reasoning: { mode: "levels", levels: ["low", "medium", "high", "xhigh", "max"] },
      service_tiers: ["priority"],
    },
    {
      id: "opencode-go/deepseek-v4.1-flash",
      kind: "chat",
      providers: ["opencode-go"],
      output_modalities: ["text"],
      reasoning: { mode: "passthrough" },
      service_tiers: [],
    },
    {
      id: "gpt-image-2",
      kind: "image",
      providers: ["codex"],
      input_modalities: ["text"],
      output_modalities: ["image"],
      reasoning: { mode: "none" },
      service_tiers: [],
    },
  ],
})

function cpa(mode: { details: boolean }) {
  const seen = { authorization: [] as string[], queries: [] as string[] }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      seen.authorization.push(request.headers.get("authorization") ?? "")
      seen.queries.push(url.search)
      if (url.pathname !== "/v1/models") return new Response(null, { status: 404 })
      if (url.searchParams.get("details") === "true" && mode.details) return Response.json(details("h1"))
      if (url.searchParams.has("client_version"))
        return Response.json({
          models: [
            {
              slug: "gpt-6-astra",
              display_name: "gpt-6-astra",
              context_window: 272_000,
              // Codex sends requests at context_window; max_context_window is an opt-in ceiling.
              max_context_window: 872_000,
              // CPA's max output; the window is the prompt budget, the reply comes on top.
              max_tokens: 128_000,
              supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }],
              service_tiers: [{ id: "priority", name: "Fast" }],
            },
            { slug: "gpt-image-2", context_window: 272_000, supported_reasoning_levels: [], visibility: "hide" },
          ],
        })
      // A CPA without the details catalogue ignores the parameter.
      return Response.json({ object: "list", data: [{ id: "gpt-6-astra", object: "model" }] })
    },
  })
  return { server, seen }
}

const entries = (origin: string): Entry[] => [
  new Document({
    type: "document",
    info: decode({
      providers: {
        cpa: {
          name: "CLIProxyAPI",
          package: "@opencode/ai/providers/openai",
          settings: { baseURL: `${origin}/v1`, apiKey: "fixture-key" },
          models: {
            // A user override without variants keeps the catalogue's variants.
            "claude-opus-5-5": { settings: { marker: "user" } },
            // A user alias that the catalogue also generates merges with it.
            "gpt-6-astra-fast": { limit: { context: 200_000 } },
            // A model CPA does not list stays configured.
            "config-only": { name: "Config only" },
          },
        },
      },
    }),
  }),
]

const start = Effect.fn(function* (origin: string) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* catalogueSync(host, { cpa: origin })
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries(origin))))
})

function eventually<A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  remaining = 3000,
): Effect.Effect<A, Error> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

const responses = (effort: string) => ({
  id: effort,
  settings: { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
})

describe("opencode.plus.cliproxyapi catalogue", () => {
  it.live(
    "adds every CPA model with CPA's reasoning levels, limits, image kind and Fast aliases under config overrides",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => cpa({ details: true })),
        ({ server, seen }) =>
          Effect.gen(function* () {
            const models = yield* Model.Service
            yield* start(server.url.origin)
            const opus = yield* eventually(
              models.get(providerID, Model.ID.make("claude-opus-5-5")),
              (item) => item?.name === "Claude Opus 5.5",
            )
            expect(seen.authorization[0]).toBe("Bearer fixture-key")
            expect(seen.queries[0]).toBe("?details=true")
            expect(opus).toMatchObject({
              settings: { marker: "user" },
              limit: { context: 1_000_000, output: 128_000 },
              capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            })
            // Exactly CPA's levels, spelled as Core spells Responses effort; not Core's generic none..xhigh.
            expect(opus?.variants as unknown).toEqual(["low", "medium", "high", "xhigh", "max"].map(responses))
            expect(opus?.limit.input).toBeUndefined()

            const astra = yield* models.get(providerID, Model.ID.make("gpt-6-astra"))
            expect(astra?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })

            const fast = yield* models.get(providerID, Model.ID.make("gpt-6-astra-fast"))
            expect(fast).toMatchObject({
              modelID: "gpt-6-astra",
              body: { service_tier: "priority" },
              limit: { context: 200_000, output: 128_000 },
            })
            // The user's smaller context cannot hold the catalogue's 272k prompt budget.
            expect(fast?.limit.input).toBeUndefined()
            expect(fast?.variants.map((variant) => String(variant.id))).toEqual([
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ])

            const deepseek = yield* models.get(providerID, Model.ID.make("opencode-go/deepseek-v4.1-flash"))
            expect(deepseek?.variants as unknown).toEqual([])

            const image = yield* models.get(providerID, Model.ID.make("gpt-image-2"))
            expect(image).toMatchObject({ capabilities: { tools: false, output: ["image"] }, variants: [] })
            expect(yield* models.get(providerID, Model.ID.make("gpt-image-2-fast"))).toBeUndefined()
            expect((yield* models.get(providerID, Model.ID.make("config-only")))?.name).toBe("Config only")
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ),
  )

  it.live("falls back to the Codex catalogue on a CPA without details, dropping levels Core has no effort for", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => cpa({ details: false })),
      ({ server, seen }) =>
        Effect.gen(function* () {
          const models = yield* Model.Service
          yield* start(server.url.origin)
          const astra = yield* eventually(
            models.get(providerID, Model.ID.make("gpt-6-astra")),
            (item) => (item?.variants.length ?? 0) > 0,
          )
          expect(seen.queries.slice(0, 2)).toEqual(["?details=true", "?client_version=0.300.0"])
          expect(astra?.variants.map((variant) => String(variant.id))).toEqual(["low", "high"])
          expect(astra?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
          expect((yield* models.get(providerID, Model.ID.make("gpt-6-astra-fast")))?.body).toEqual({
            service_tier: "priority",
          })
          const image = yield* models.get(providerID, Model.ID.make("gpt-image-2"))
          expect(image?.capabilities.output).toEqual(["image"])
          expect(image?.limit.context).not.toBe(272_000)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )
})
