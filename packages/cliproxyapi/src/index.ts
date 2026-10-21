import { Plugin } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Form } from "@opencode/schema/form"
import { Provider } from "@opencode/schema/provider"
import { Effect, Queue, Ref, Schema, Stream } from "effect"
import { probeCPA } from "./quota/probe.js"
import { discover, prices } from "./pacer/cpa.js"
import { quotaEndpoint } from "./quota/protocol.js"
import { registerQuota } from "./quota/register.js"
import {
  applyCatalogue,
  applyRelayToExistingModels,
  applyRelayToModels,
  CODEX_CLIENT_VERSION,
  parseCodexCatalogue,
  parseDetails,
  parsePlainList,
  type Catalogue,
  withCataloguePrices,
} from "./catalog.js"
import { cliproxyapiConfig } from "./config.js"
import { imageToolRegistration, type ImageTarget } from "./image.js"
import { migratingStorage } from "./legacy.js"

export { applyCatalogue, applyRelayToExistingModels, applyRelayToModels } from "./catalog.js"
export { onQuotaFact, type QuotaFact } from "./facts.js"
export { pacerCache, type PacerCache, type PacerCacheQuery } from "./pacer-cache.js"
export { provideLegacyQuotaStorage, legacyRead, migratingStorage } from "./legacy.js"

export const ID = "opencode.plus.cliproxyapi"
/** Integration and provider ID the /connect entry and routes are keyed by. */
export const INTEGRATION_ID = "cliproxyapi"
export const PROVIDER_ID = "cliproxyapi"
const DEFAULT_PACKAGE = "@opencode/ai/providers/openai"
const REFRESH = "5 minutes"
const RETRY = "15 seconds"

/** HTTPS anywhere, or HTTP only to a loopback host, then an optional path, ending in `/v1`. */
export const BASE_URL_PATTERN = String.raw`^(https://[^/\s]+|http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?)(/[^/\s]+)*/v1$`

const Stored = Schema.Struct({
  catalogue: Schema.Unknown,
  pkg: Schema.optional(Schema.String),
  /** Present for a catalogue bound to a connection: `<type>:<id>` of the connection that produced it. */
  connectionKey: Schema.optional(Schema.String),
})

const Switched = Schema.Struct({ integrationID: Schema.String })

interface Loaded {
  catalogue: Catalogue
  pkg: string | undefined
  connectionKey: string | undefined
}

type Connection = NonNullable<Effect.Success<ReturnType<Context["integration"]["connection"]["active"]>>>

export interface ConnectionRoute {
  readonly providerID: string
  readonly origin: string
  readonly key: string
  readonly info: Connection
}

/**
 * OpenCodePlus features for CLIProxyAPI (CPA), in one plugin that can be turned
 * off with `"plugins": ["-opencode.plus.cliproxyapi"]`:
 * - `/connect` entry: connect once with the CPA URL and key; models sync without
 *   any cliproxyapi.json or provider in opencode.json;
 * - model catalogue sync (all CPA models, reasoning levels, limits, Fast aliases);
 * - quota coordination and the usage views, on by themselves for a CPA that runs
 *   its quota-handoff plugin;
 * The file (~/.config/opencodeplus/cliproxyapi.json, or legacy
 * quota-handoff.json) is the advanced route: a route there overrides the
 * connection-derived one and keeps the old behaviour.
 */
export default Plugin.define({
  id: ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(() => cliproxyapiConfig()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("cliproxyapi.json could not be read; CLIProxyAPI file options are off", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      const storage = migratingStorage(ctx.storage)
      const scoped: Context = { ...ctx, storage }
      const fileRoutes = config?.routes ?? {}
      const fileCatalog = config?.catalog ?? {}
      const anthropicRelay = config?.anthropicRelay
      const connectionRoute: { current: ConnectionRoute | undefined } = { current: undefined }
      // Relay over every route, file or connection. A file route for a provider
      // ID wins over the connection-derived route for the same ID.
      const routes = () => {
        const current = connectionRoute.current
        return current ? { [current.providerID]: current.origin, ...fileRoutes } : fileRoutes
      }
      // Catalogue only for routes that opted in: file routes follow `catalog`,
      // a connection route always syncs. A file route for the id wins its origin.
      const catalogRoutes = () => {
        const current = connectionRoute.current
        if (!current || fileRoutes[current.providerID] !== undefined) return fileCatalog
        return { ...fileCatalog, [current.providerID]: current.origin }
      }
      const connectionSource = () => (fileCatalog[PROVIDER_ID] ? undefined : connectionRoute.current)

      // Quota follows what each CPA runs: on while its quota-handoff plugin
      // answers, unless cliproxyapi.json forces it on or off for every route.
      // Forced routes apply at once; probed ones after the first probe.
      const quotaOn = (origin: string) => {
        if (config?.quota === false) return Promise.resolve({ quota: false, pacer: false })
        return probeCPA(origin, { fetch }).then((result) => ({
          ...result,
          quota: config?.quota === true ? quotaEndpoint(origin) !== undefined : result.quota,
        }))
      }
      const pacerProviders: { current: string[] } = { current: [] }
      const quotaRoutes: { current: Readonly<Record<string, string>> } = {
        current:
          config?.quota === true
            ? Object.fromEntries(Object.entries(fileRoutes).filter(([, origin]) => quotaEndpoint(origin) !== undefined))
            : {},
      }
      const probeQuotaRoutes = Effect.fn("Cliproxyapi.probeQuota")(function* () {
        const checked = yield* Effect.forEach(
          Object.entries(routes()),
          ([providerID, origin]) => Effect.promise(async () => ({ providerID, origin, on: await quotaOn(origin) })),
          { concurrency: "unbounded" },
        )
        const next = Object.fromEntries(
          checked.filter((route) => route.on.quota).map((route) => [route.providerID, route.origin]),
        )
        if (JSON.stringify(next) !== JSON.stringify(quotaRoutes.current))
          yield* Effect.logInfo("CPA quota coordination", { routes: Object.keys(next) })
        quotaRoutes.current = next
        pacerProviders.current = checked.filter((route) => route.on.pacer).map((route) => route.providerID)
      })
      yield* registerQuota(scoped, () => ({
        routes: quotaRoutes.current,
        pacer: pacerProviders.current,
        ...(config?.compactionModel ? { compactionModel: config.compactionModel } : {}),
        ...(config?.compactionFallback ? { compactionFallback: config.compactionFallback } : {}),
      }))

      // Resolve the active `cliproxyapi` connection into an origin. The
      // credential's form answer (`configuration.baseURL`) is the URL requests
      // use; it is validated at connect time, so here it only needs to parse.
      const resolveConnectionRoute = Effect.fnUntraced(function* () {
        const active = yield* ctx.integration.connection.active(INTEGRATION_ID)
        if (!active || active.type !== "credential") {
          connectionRoute.current = undefined
          return
        }
        const credential = yield* ctx.integration.connection.resolve(active).pipe(Effect.orElseSucceed(() => undefined))
        const configuration = credential?.type === "key" ? credential.configuration : undefined
        const baseURL = configuration?.baseURL
        if (typeof baseURL !== "string" || !URL.canParse(baseURL)) {
          connectionRoute.current = undefined
          return
        }
        connectionRoute.current = {
          providerID: PROVIDER_ID,
          origin: new URL(baseURL).origin,
          key: `credential:${active.id}`,
          info: active,
        }
      })

      // The /connect entry: connect once with the CPA URL and an API key.
      yield* ctx.integration.transform((editor) => {
        editor.update(INTEGRATION_ID, (integration) => {
          integration.name = "CLIProxyAPI"
        })
        editor.method.update({
          integrationID: INTEGRATION_ID,
          method: {
            type: "key",
            label: "CLIProxyAPI API key",
            form: Form.Fields.make([
              Form.StringField.make({
                type: "string",
                key: "baseURL",
                title: "CLIProxyAPI URL",
                description: "The URL must end in /v1 and use HTTPS (plain HTTP is allowed only for localhost).",
                placeholder: "https://cpa.example.com/v1",
                required: true,
                pattern: BASE_URL_PATTERN,
              }),
            ]),
          },
        })
      })
      // The provider is always registered. Activation is `auto`: core makes it
      // available only while the `cliproxyapi` integration has a connection.
      yield* ctx.provider.transform((providers) => {
        providers.update(PROVIDER_ID, (provider) => {
          provider.name = "CLIProxyAPI"
          if (!provider.package) provider.package = DEFAULT_PACKAGE
        })
      })
      // The model transform runs after provider transforms, so it reaches models
      // that config creates later (legacy quota-handoff routes, catalogue off).
      yield* ctx.model.transform((models) => {
        applyRelayToModels(models, routes(), anthropicRelay)
      })
      yield* ctx.provider.transform((providers) => {
        applyRelayToExistingModels(providers, routes(), anthropicRelay)
      })
      // Config applies its own per-model settings and variants in a later model
      // transform, so the relay re-registers a final pass on every plugin update.
      // Re-registering (instead of once) keeps that pass last when config
      // re-activates and appends its transform again, and it is the only pass
      // that sets compaction: by then the package is final, so a model
      // repackaged away from the relay never carries a relay-owned native
      // compaction, and a user's own compaction is never removed.
      const relayDispose = yield* Ref.make<Effect.Effect<void> | undefined>(undefined)
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "plugin.updated"),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const previous = yield* Ref.get(relayDispose)
            if (previous) yield* previous
            const registration = yield* ctx.model.transform((models) => {
              applyRelayToModels(models, routes(), anthropicRelay, { compaction: true })
            })
            yield* Ref.set(relayDispose, registration.dispose)
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      // A connect refreshes immediately. The catalogue loop wakes on this queue
      // instead of waiting for its next poll.
      const wake = yield* Queue.unbounded<void>()
      yield* resolveConnectionRoute()
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "credential.switched"),
        Stream.runForEach((event) => {
          const data = Schema.decodeUnknownOption(Switched)(event.data)
          if (data._tag === "None" || data.value.integrationID !== INTEGRATION_ID) return Effect.void
          return resolveConnectionRoute().pipe(Effect.andThen(Queue.offer(wake, undefined)))
        }),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* catalogueSync(scoped, catalogRoutes, anthropicRelay, connectionSource, wake, probeQuotaRoutes())
    }),
})

export function catalogueSync(
  ctx: Context,
  routes: () => Readonly<Record<string, string>>,
  anthropicRelay?: Readonly<Record<string, boolean>>,
  connectionSource?: () => ConnectionRoute | undefined,
  wake?: Queue.Queue<void>,
  /** Runs alongside every refresh: the quota probe follows the catalogue's schedule. */
  alongside: Effect.Effect<void> = Effect.void,
) {
  return Effect.gen(function* () {
    const loaded = new Map<string, Loaded>()
    const activeConnectionKey = (providerID: string) => {
      const current = connectionSource?.()
      return current?.providerID === providerID ? current.key : undefined
    }
    // The last good catalogue survives restarts and CPA outages. A catalogue
    // that was bound to a connection is only restored while that same
    // connection is still active, so an old account's models never reappear.
    for (const providerID of Object.keys(routes())) {
      const raw = yield* ctx.storage.get(`catalog/${providerID}`)
      const stored = Schema.decodeUnknownOption(Stored)(raw)
      if (stored._tag === "None") continue
      const catalogue = restore(stored.value.catalogue)
      if (!catalogue) continue
      if (stored.value.connectionKey !== undefined && stored.value.connectionKey !== activeConnectionKey(providerID))
        continue
      loaded.set(providerID, { catalogue, pkg: stored.value.pkg, connectionKey: stored.value.connectionKey })
    }
    yield* ctx.provider.transform((providers) => {
      const current = connectionSource?.()
      for (const [providerID, entry] of loaded) {
        // Rebind the provider to the connection that produced its catalogue and
        // replace its model map with that catalogue, so an old connection's
        // models never linger. Core hides the models once another connection is
        // active, until the next refresh rebinds them.
        if (entry.connectionKey !== undefined && current?.providerID === providerID) {
          const record = providers.get(providerID)
          if (record) providers.add({ info: record.provider, models: [], sourceConnection: current.info })
        }
        const relay = anthropicRelay?.[providerID] !== false
        applyCatalogue(providers, providerID, entry.catalogue, entry.pkg, { anthropicRelay: relay })
      }
    })
    // Image models only work on CPA's images endpoint; the image tool makes them usable.
    yield* imageToolRegistration(ctx, () =>
      Effect.forEach([...loaded], ([providerID, entry]) => {
        const origin = routes()[providerID]
        if (!origin) return Effect.succeed([] as ImageTarget[])
        return connection(ctx, providerID, origin).pipe(
          Effect.map((target): ImageTarget[] =>
            target ? [{ providerID, baseURL: target.baseURL, key: target.key, catalogue: entry.catalogue }] : [],
          ),
          Effect.catchCause(() => Effect.succeed([] as ImageTarget[])),
        )
      }).pipe(Effect.map((items) => items.flat())),
    )

    /** Returns whether every route answered; failed routes keep their last catalogue. */
    const refresh = Effect.fn("CliproxyapiCatalogue.refresh")(function* () {
      const origins = routes()
      let changed = false
      // Drop routes that disappeared, and connection-bound catalogues whose
      // connection changed, before re-fetching.
      for (const providerID of [...loaded.keys()]) {
        if (!(providerID in origins)) {
          loaded.delete(providerID)
          changed = true
          continue
        }
        const entry = loaded.get(providerID)!
        if (entry.connectionKey !== undefined && entry.connectionKey !== activeConnectionKey(providerID)) {
          loaded.delete(providerID)
          changed = true
        }
      }
      let complete = true
      for (const [providerID, origin] of Object.entries(origins)) {
        const connectionKey = activeConnectionKey(providerID)
        const next = yield* fetchCatalogue(ctx, providerID, origin).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("CPA catalogue refresh failed; keeping the last catalogue", { providerID, cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        )
        if (!next) {
          complete = false
          continue
        }
        const value = { ...next, connectionKey }
        const previous = loaded.get(providerID)
        if (
          previous &&
          previous.catalogue.hash === value.catalogue.hash &&
          previous.pkg === value.pkg &&
          previous.connectionKey === value.connectionKey
        )
          continue
        loaded.set(providerID, value)
        yield* ctx.storage.set(`catalog/${providerID}`, JSON.parse(JSON.stringify(value)))
        yield* Effect.logInfo("CPA catalogue loaded", {
          providerID,
          source: value.catalogue.source,
          models: value.catalogue.models.length,
        })
        changed = true
      }
      if (changed) yield* ctx.provider.reload()
      return complete
    })
    // Retry quickly until every route answered (the provider may still be settling at
    // startup), then refresh every five minutes. A connection change wakes the loop.
    yield* Effect.forever(
      Effect.gen(function* () {
        const [complete] = yield* Effect.all(
          [
            refresh().pipe(Effect.catchCause(() => Effect.succeed(false))),
            alongside.pipe(Effect.catchCause((cause) => Effect.logWarning("CPA quota probe failed", { cause }))),
          ],
          { concurrency: 2 },
        )
        const delay = complete ? REFRESH : RETRY
        if (wake) yield* Effect.race(Effect.sleep(delay), Queue.take(wake))
        else yield* Effect.sleep(delay)
      }),
    ).pipe(Effect.forkScoped)
  })
}

function restore(raw: unknown): Catalogue | undefined {
  if (typeof raw !== "object" || raw === null) return
  const value = raw as Catalogue
  if (!Array.isArray(value.models) || typeof value.hash !== "string") return
  return value
}

/** Resolves the provider's own connection; the key never leaves the host and only goes to the route origin. */
function connection(ctx: Context, providerID: string, origin: string) {
  return Effect.gen(function* () {
    const provider = (yield* ctx.provider.get({ providerID: Provider.ID.make(providerID) })).data
    const active = yield* ctx.integration.connection.active(provider.integrationID ?? provider.id)
    const credential = active ? yield* ctx.integration.connection.resolve(active) : undefined
    const configuration = credential?.type === "key" ? credential.configuration : undefined
    const settings = { ...provider.settings, ...credential?.metadata, ...configuration }
    const baseURL = settings.baseURL
    if (typeof baseURL !== "string" || new URL(baseURL).origin !== new URL(origin).origin) return
    const key = credential?.type === "key" ? credential.key : settings.apiKey
    if (typeof key !== "string" || key.length === 0) return
    return { baseURL: baseURL.replace(/\/+$/, ""), key, pkg: provider.package }
  })
}

function fetchCatalogue(ctx: Context, providerID: string, origin: string) {
  return Effect.gen(function* () {
    const target = yield* connection(ctx, providerID, origin)
    if (!target)
      return yield* Effect.die(
        new Error(
          `Provider ${providerID} has no API key, or its baseURL origin is not the configured CPA route ${origin}`,
        ),
      )
    const get = async (query: string) => {
      const response = await fetch(`${target.baseURL}/models?${query}`, {
        headers: { Authorization: `Bearer ${target.key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      })
      if (!response.ok) throw new Error(`CPA model catalogue HTTP ${response.status}`)
      const text = await response.text()
      return { json: JSON.parse(text) as unknown, hash: new Bun.CryptoHasher("sha256").update(text).digest("hex") }
    }
    const first = yield* Effect.promise(() => get("details=true"))
    const pricing = yield* Effect.promise(async () => {
      const pacer = quotaEndpoint(origin) ? await discover(fetch, origin) : undefined
      return pacer?.pacer && pacer.views.includes("prices") ? prices(fetch, target).catch(() => undefined) : undefined
    })
    const details = parseDetails(first.json)
    if (details)
      return { catalogue: withCataloguePrices(details, pricing), pkg: target.pkg } satisfies Omit<
        Loaded,
        "connectionKey"
      >
    // A failed Codex request fails the refresh, which keeps the last catalogue.
    const codex = yield* Effect.promise(() => get(`client_version=${CODEX_CLIENT_VERSION}`))
    // A CPA without either catalogue ignores both parameters and answers with
    // its plain model list: the last resort, so a connected CPA never shows none.
    const catalogue = parseCodexCatalogue(codex.json, codex.hash) ?? parsePlainList(first.json, first.hash)
    return catalogue
      ? ({ catalogue: withCataloguePrices(catalogue, pricing), pkg: target.pkg } satisfies Omit<
          Loaded,
          "connectionKey"
        >)
      : undefined
  })
}
