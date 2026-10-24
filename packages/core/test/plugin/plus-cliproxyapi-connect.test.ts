import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Document, Info, type Entry } from "@opencode/schema/config"
import cliproxyapi, { BASE_URL_PATTERN, ID, INTEGRATION_ID, PROVIDER_ID } from "@opencodeplus/cliproxyapi/server"
import { describe, expect, test } from "bun:test"
import { Effect, Queue, Schema, Stream } from "effect"
import { withEnv } from "../fixture/env"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make(INTEGRATION_ID)
const providerID = Provider.ID.make(PROVIDER_ID)
const decode = Schema.decodeUnknownSync(Info)

const details = (models: Array<{ id: string; name?: string; levels?: string[] }>) => {
  const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(models)).digest("hex")
  return {
    object: "list",
    schema: "cliproxyapi.model-details/1",
    hash,
    data: models.map((model) => ({
      id: model.id,
      display_name: model.name,
      kind: "chat",
      context_length: 200_000,
      max_completion_tokens: 64_000,
      input_modalities: ["text"],
      output_modalities: ["text"],
      reasoning: { mode: "levels", levels: model.levels ?? ["low", "high"] },
      service_tiers: [],
    })),
  }
}

function cpa(models: Array<{ id: string; name?: string; levels?: string[] }>) {
  const seen = { authorization: [] as string[], urls: [] as string[] }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      seen.authorization.push(request.headers.get("authorization") ?? "")
      seen.urls.push(`${url.pathname}${url.search}`)
      if (url.pathname !== "/v1/models") return new Response(null, { status: 404 })
      return Response.json(details(models))
    },
  })
  return { server, seen }
}

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* cliproxyapi.effect(host)
  return host
})

const connect = (origin: string, key = "cpa-key") =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    yield* integrations.connection.key({ integrationID, key, answer: { baseURL: `${origin}/v1` } })
  })

function withConfigDir<A, E, R>(body: (tmp: { path: string }) => Effect.Effect<A, E, R>) {
  return withTempDir((tmp) => withEnv({ OPENCODE_CONFIG_DIR: tmp.path }, () => body(tmp)))
}

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

// Keep the plugin ID stable: plugin storage is keyed by it.
test("exports the plus-era plugin id", () => {
  expect(ID).toBe("opencode.plus.cliproxyapi")
})

describe("opencode.plus.cliproxyapi /connect", () => {
  it.effect("registers the CLIProxyAPI integration and an unavailable provider with no config file", () =>
    withConfigDir(() =>
      Effect.gen(function* () {
        yield* addPlugin()
        const integrations = yield* Integration.Service
        const providers = yield* Provider.Service
        const integration = yield* integrations.get(integrationID)
        expect(integration?.name).toBe("CLIProxyAPI")
        expect(integration?.methods).toEqual([expect.objectContaining({ type: "key", label: "CLIProxyAPI API key" })])
        const method = integration?.methods[0]
        const field = method?.type === "key" ? method.form?.[0] : undefined
        expect(field).toMatchObject({
          type: "string",
          key: "baseURL",
          title: "CLIProxyAPI URL",
          placeholder: "https://cpa.example.com/v1",
          required: true,
          pattern: BASE_URL_PATTERN,
        })
        expect((yield* providers.available()).map((provider) => provider.id)).not.toContain(providerID)
      }),
    ),
  )

  it.live("syncs the stub's models and relays Claude after connecting with a URL and key", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => cpa([{ id: "claude-opus-4-5", levels: ["high", "max"] }, { id: "gpt-5" }])),
      ({ server, seen }) =>
        withConfigDir(() =>
          Effect.gen(function* () {
            yield* addPlugin()
            const integrations = yield* Integration.Service
            const providers = yield* Provider.Service
            const models = yield* Model.Service
            yield* connect(server.url.origin)
            expect((yield* integrations.connection.active(integrationID))?.type).toBe("credential")
            const claude = yield* eventually(
              models.get(providerID, Model.ID.make("claude-opus-4-5")),
              (model) => model !== undefined,
            )
            expect((yield* models.get(providerID, Model.ID.make("gpt-5")))?.name).toBe("gpt-5")
            expect(claude?.package).toBe("@opencode/ai/providers/anthropic-compatible")
            expect(claude?.variants.map((variant) => String(variant.id))).toEqual(["high", "max"])
            // The unauthenticated quota probe races the catalogue request.
            const catalogue = seen.urls.indexOf("/v1/models?details=true")
            expect(catalogue).toBeGreaterThanOrEqual(0)
            expect(seen.authorization[catalogue]).toBe("Bearer cpa-key")
            expect(
              seen.authorization.filter((_, index) => seen.urls[index] !== "/v1/models?details=true"),
            ).not.toContain("Bearer cpa-key")
            expect((yield* providers.available()).map((provider) => provider.id)).toContain(providerID)
          }),
        ),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("reconnecting to a second stub leaves only the second stub's models", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => ({ first: cpa([{ id: "model-first" }]), second: cpa([{ id: "model-second" }]) })),
      ({ first, second }) =>
        withConfigDir(() =>
          Effect.gen(function* () {
            yield* addPlugin()
            const models = yield* Model.Service
            yield* connect(first.server.url.origin)
            yield* eventually(models.get(providerID, Model.ID.make("model-first")), (model) => model !== undefined)
            yield* connect(second.server.url.origin, "second-key")
            yield* eventually(models.get(providerID, Model.ID.make("model-second")), (model) => model !== undefined)
            expect(yield* models.get(providerID, Model.ID.make("model-first"))).toBeUndefined()
          }),
        ),
      ({ first, second }) =>
        Effect.sync(() => {
          first.server.stop(true)
          second.server.stop(true)
        }),
    ),
  )

  it.effect("rejects a baseURL the pattern refuses", () =>
    withConfigDir(() =>
      Effect.gen(function* () {
        yield* addPlugin()
        const integrations = yield* Integration.Service
        for (const baseURL of ["http://example.com/v1", "https://cpa.example.com", "https://cpa.example.com/v1/"]) {
          const message = yield* integrations.connection.key({ integrationID, key: "k", answer: { baseURL } }).pipe(
            Effect.flip,
            Effect.map((error) => (error.cause instanceof Error ? error.cause.message : String(error.cause))),
          )
          expect(message).toContain("pattern")
        }
        expect(yield* integrations.connection.active(integrationID)).toBeUndefined()
      }),
    ),
  )

  it.live("existing file setup keeps working, has no sourceConnection, and beats a connection route", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => ({ file: cpa([{ id: "file-model" }]), connected: cpa([{ id: "connection-model" }]) })),
      ({ file, connected }) =>
        withConfigDir((tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                `${tmp.path}/cliproxyapi.json`,
                JSON.stringify({ routes: { [PROVIDER_ID]: file.server.url.origin } }),
              ),
            )
            const entries = (origin: string): Entry[] => [
              new Document({
                type: "document",
                info: decode({
                  providers: {
                    [PROVIDER_ID]: {
                      name: "CLIProxyAPI",
                      package: "@opencode/ai/providers/openai",
                      settings: { baseURL: `${origin}/v1`, apiKey: "fixture-key" },
                    },
                  },
                }),
              }),
            ]
            yield* addPlugin()
            const plugin = yield* Plugin.Service
            const host = yield* PluginHost.make(plugin)
            yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
              Effect.provide(Config.testLayer(entries(file.server.url.origin))),
            )
            const providers = yield* Provider.Service
            const models = yield* Model.Service
            yield* eventually(models.get(providerID, Model.ID.make("file-model")), (model) => model !== undefined)
            // The /connect integration exists now, but a config-defined provider stays available without it.
            expect((yield* providers.available()).map((provider) => provider.id)).toContain(providerID)
            // Connecting to another origin must not replace the file route's
            // models, and must never bind the file-routed provider to the connection.
            const fetched = file.seen.urls.length
            yield* connect(connected.server.url.origin, "connected-key")
            // The connect wakes a refresh; it fetches the file route again and never the connected CPA.
            yield* eventually(
              Effect.sync(() => file.seen.urls.length),
              (count) => count > fetched,
            )
            expect(connected.seen.urls).toEqual([])
            expect(yield* models.get(providerID, Model.ID.make("connection-model"))).toBeUndefined()
            expect((yield* models.get(providerID, Model.ID.make("file-model")))?.name).toBe("file-model")
            expect((yield* providers.available()).map((provider) => provider.id)).toContain(providerID)
            const definition = (yield* providers.snapshot()).records.get(providerID)
            expect(definition?.sourceConnection).toBeUndefined()
          }),
        ),
      ({ file, connected }) =>
        Effect.sync(() => {
          file.server.stop(true)
          connected.server.stop(true)
        }),
    ),
  )

  it.effect("without the plugin there is no cliproxyapi integration", () =>
    withConfigDir(() =>
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        expect(yield* integrations.get(integrationID)).toBeUndefined()
      }),
    ),
  )

  it.effect("ctx.event.subscribe delivers credential.switched to a plugin", () =>
    withConfigDir(() =>
      Effect.gen(function* () {
        const host = yield* addPlugin()
        const seen = yield* Queue.unbounded<unknown>()
        yield* host.event.subscribe().pipe(
          Stream.filter((event) => event.type === "credential.switched"),
          Stream.runForEach((event) => Queue.offer(seen, event.data)),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Effect.yieldNow
        yield* connect("https://cpa.invalid")
        const data = yield* Queue.take(seen).pipe(Effect.timeout("2 seconds"))
        expect(data).toMatchObject({ integrationID: INTEGRATION_ID })
      }),
    ),
  )
})
