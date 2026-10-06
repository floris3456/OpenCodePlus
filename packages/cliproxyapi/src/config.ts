import path from "node:path"
import { Schema } from "effect"
import { globalConfigDir } from "./paths.js"

/**
 * ~/.config/opencodeplus/cliproxyapi.json — host-owned, never project config.
 *
 *   { "routes": { "<providerID>": "https://cpa.example" }, "quota": true, "catalog": true,
 *     "compactionModel": "<providerID>/<modelID>", "compactionFallback": "<providerID>/<modelID>" }
 *
 * `routes` maps OpenCode provider IDs to the CPA origin that serves them (the
 * provider's baseURL must have the same origin). Quota coordination and the
 * usage views turn on by themselves for a CPA that runs the quota-handoff
 * plugin; `quota` forces them on (`true`) or off (`false`) for every route.
 * `catalog` syncs CPA's model catalogue into those providers (default true).
 * `compactionModel` writes the summary when CPA moves a chat to another account
 * (default: the agent's compaction model); `compactionFallback` writes it when
 * that model fails. A legacy quota-handoff.json (routes only) forces quota on,
 * without the catalogue.
 */
const RouteEntry = Schema.Union([
  Schema.String,
  Schema.Struct({
    url: Schema.optional(Schema.String),
    origin: Schema.optional(Schema.String),
    anthropicRelay: Schema.optional(Schema.Boolean),
  }),
])

export const CliproxyapiFile = Schema.Struct({
  routes: Schema.Record(Schema.String, RouteEntry),
  quota: Schema.optional(Schema.Boolean),
  catalog: Schema.optional(Schema.Boolean),
  anthropicRelay: Schema.optional(
    Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Schema.Boolean)]),
  ),
  compactionModel: Schema.optional(Schema.String),
  compactionFallback: Schema.optional(Schema.String),
})
export type CliproxyapiFile = typeof CliproxyapiFile.Type

const LegacyFile = Schema.Struct({
  routes: Schema.Record(Schema.String, RouteEntry),
  anthropicRelay: Schema.optional(
    Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Schema.Boolean)]),
  ),
})

export interface CliproxyapiConfig {
  readonly source: "cliproxyapi.json" | "quota-handoff.json"
  readonly routes: Readonly<Record<string, string>>
  /** Forces quota on or off; undefined follows whether the CPA runs quota-handoff. */
  readonly quota: boolean | undefined
  readonly compactionModel?: string
  readonly compactionFallback?: string
  readonly catalog: Readonly<Record<string, string>>
  readonly anthropicRelay?: Readonly<Record<string, boolean>>
}

export function isAnthropicRelay(config: CliproxyapiConfig | undefined, providerID: string): boolean {
  return config?.anthropicRelay?.[providerID] ?? true
}

function extractRoutesAndRelay(
  rawRoutes: Record<string, string | { url?: string; origin?: string; anthropicRelay?: boolean }>,
  topRelay?: boolean | Record<string, boolean>,
): {
  routes: Record<string, string>
  anthropicRelay: Record<string, boolean> | undefined
} {
  const routes: Record<string, string> = {}
  let relayMap: Record<string, boolean> | undefined = undefined

  for (const [providerID, entry] of Object.entries(rawRoutes)) {
    const origin = typeof entry === "string" ? entry : (entry.url ?? entry.origin ?? "")
    routes[providerID] = origin

    let relay: boolean | undefined = undefined
    if (typeof entry === "object" && entry.anthropicRelay !== undefined) {
      relay = entry.anthropicRelay
    } else if (typeof topRelay === "boolean") {
      relay = topRelay
    } else if (typeof topRelay === "object" && topRelay !== null && topRelay[providerID] !== undefined) {
      relay = topRelay[providerID]
    }

    if (relay !== undefined) {
      relayMap ??= {}
      relayMap[providerID] = relay
    }
  }

  return { routes, anthropicRelay: relayMap }
}

export async function cliproxyapiConfig(directory = globalConfigDir()): Promise<CliproxyapiConfig | undefined> {
  const file = Bun.file(path.join(directory, "cliproxyapi.json"))
  if (await file.exists()) {
    const value = Schema.decodeUnknownSync(Schema.fromJsonString(CliproxyapiFile))(await file.text())
    const { routes, anthropicRelay } = extractRoutesAndRelay(value.routes, value.anthropicRelay)
    return {
      source: "cliproxyapi.json",
      routes,
      quota: value.quota,
      ...(value.compactionModel ? { compactionModel: value.compactionModel } : {}),
      ...(value.compactionFallback ? { compactionFallback: value.compactionFallback } : {}),
      catalog: value.catalog === false ? {} : routes,
      ...(anthropicRelay ? { anthropicRelay } : {}),
    }
  }
  const legacy = Bun.file(path.join(directory, "quota-handoff.json"))
  if (!(await legacy.exists())) return undefined
  const value = Schema.decodeUnknownSync(Schema.fromJsonString(LegacyFile))(await legacy.text())
  const { routes, anthropicRelay } = extractRoutesAndRelay(value.routes, value.anthropicRelay)
  return {
    source: "quota-handoff.json",
    routes,
    quota: true,
    catalog: {},
    ...(anthropicRelay ? { anthropicRelay } : {}),
  }
}
