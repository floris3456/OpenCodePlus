import { Plugin } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Provider } from "@opencode/schema/provider"
import { Effect, Schema } from "effect"
import { registerQuota } from "../quota/register.js"
import { applyCatalogue, CODEX_CLIENT_VERSION, parseCodexCatalogue, parseDetails, type Catalogue } from "./catalog.js"
import { cliproxyapiConfig } from "./config.js"
import { imageToolRegistration, type ImageTarget } from "./image.js"
import { migratingStorage } from "./legacy.js"

export const ID = "opencode.plus.cliproxyapi"
const REFRESH = "5 minutes"
const RETRY = "15 seconds"

const Stored = Schema.Struct({ catalogue: Schema.Unknown, pkg: Schema.optional(Schema.String) })

interface Loaded {
  catalogue: Catalogue
  pkg: string | undefined
}

/**
 * OpenCodePlus features for CLIProxyAPI (CPA), in one plugin that can be turned
 * off with `"plugins": ["-opencode.plus.cliproxyapi"]`:
 * - model catalogue sync (all CPA models, reasoning levels, limits, Fast aliases);
 * - quota coordination with CPA's quota-handoff plugin and the usage views.
 * Inert without ~/.config/opencodeplus/cliproxyapi.json (or legacy quota-handoff.json).
 */
export default Plugin.define({
  id: ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(() => cliproxyapiConfig()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("cliproxyapi.json could not be read; CLIProxyAPI features are off", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      const storage = migratingStorage(ctx.storage)
      const scoped: Context = { ...ctx, storage }
      yield* registerQuota(scoped, config?.quota)
      if (!config || Object.keys(config.catalog).length === 0) return
      yield* catalogueSync(scoped, config.catalog)
    }),
})

export function catalogueSync(ctx: Context, routes: Readonly<Record<string, string>>) {
  return Effect.gen(function* () {
    const loaded = new Map<string, Loaded>()
    // The last good catalogue survives restarts and CPA outages.
    for (const providerID of Object.keys(routes)) {
      const raw = yield* ctx.storage.get(`catalog/${providerID}`)
      const stored = Schema.decodeUnknownOption(Stored)(raw)
      const catalogue = stored._tag === "Some" ? restore(stored.value.catalogue) : undefined
      if (stored._tag === "Some" && catalogue) loaded.set(providerID, { catalogue, pkg: stored.value.pkg })
    }
    yield* ctx.provider.transform((providers) => {
      for (const [providerID, entry] of loaded) applyCatalogue(providers, providerID, entry.catalogue, entry.pkg)
    })
    // Image models only work on CPA's images endpoint; the image tool makes them usable.
    yield* imageToolRegistration(ctx, () =>
      Effect.forEach([...loaded], ([providerID, entry]) =>
        connection(ctx, providerID, routes[providerID]!).pipe(
          Effect.map((target): ImageTarget[] =>
            target ? [{ providerID, baseURL: target.baseURL, key: target.key, catalogue: entry.catalogue }] : [],
          ),
          Effect.catchCause(() => Effect.succeed([] as ImageTarget[])),
        ),
      ).pipe(Effect.map((items) => items.flat())),
    )

    /** Returns whether every route answered; failed routes keep their last catalogue. */
    const refresh = Effect.fn("CliproxyapiCatalogue.refresh")(function* () {
      let changed = false
      let complete = true
      for (const [providerID, origin] of Object.entries(routes)) {
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
        const previous = loaded.get(providerID)
        if (previous && previous.catalogue.hash === next.catalogue.hash && previous.pkg === next.pkg) continue
        loaded.set(providerID, next)
        yield* ctx.storage.set(`catalog/${providerID}`, JSON.parse(JSON.stringify(next)))
        changed = true
      }
      if (changed) yield* ctx.provider.reload()
      return complete
    })
    // Retry quickly until every route answered (the provider may still be settling at
    // startup), then refresh every five minutes.
    yield* Effect.forever(
      refresh().pipe(
        Effect.catchCause(() => Effect.succeed(false)),
        Effect.flatMap((complete) => Effect.sleep(complete ? REFRESH : RETRY)),
      ),
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
    const get = (query: string) =>
      Effect.promise(async () => {
        const response = await fetch(`${target.baseURL}/models?${query}`, {
          headers: { Authorization: `Bearer ${target.key}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        })
        if (!response.ok) throw new Error(`CPA model catalogue HTTP ${response.status}`)
        const text = await response.text()
        return { text, json: JSON.parse(text) as unknown }
      })
    const details = parseDetails((yield* get("details=true")).json)
    if (details) return { catalogue: details, pkg: target.pkg } satisfies Loaded
    const codex = yield* get(`client_version=${CODEX_CLIENT_VERSION}`)
    const hash = new Bun.CryptoHasher("sha256").update(codex.text).digest("hex")
    const catalogue = parseCodexCatalogue(codex.json, hash)
    return catalogue ? ({ catalogue, pkg: target.pkg } satisfies Loaded) : undefined
  })
}
