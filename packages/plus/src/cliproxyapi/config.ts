import path from "node:path"
import { Schema } from "effect"
import { globalConfigDir } from "../instructions/paths.js"
import type { Config as QuotaConfig } from "../quota/protocol.js"

/**
 * ~/.config/opencodeplus/cliproxyapi.json — host-owned, never project config.
 *
 *   { "routes": { "<providerID>": "https://cpa.example" }, "quota": true, "catalog": true,
 *     "compactionModel": "<providerID>/<modelID>" }
 *
 * `routes` maps OpenCode provider IDs to the CPA origin that serves them (the
 * provider's baseURL must have the same origin). `quota` enables quota
 * coordination and the usage views; `catalog` syncs CPA's model catalogue into
 * those providers. Both default to true. `compactionModel` writes the summary
 * when CPA moves a chat to another account (default: the agent's compaction
 * model). A legacy quota-handoff.json (routes only) still enables quota and
 * usage, without the catalogue.
 */
export const CliproxyapiFile = Schema.Struct({
  routes: Schema.Record(Schema.String, Schema.String),
  quota: Schema.optional(Schema.Boolean),
  catalog: Schema.optional(Schema.Boolean),
  compactionModel: Schema.optional(Schema.String),
})
export type CliproxyapiFile = typeof CliproxyapiFile.Type

export interface CliproxyapiConfig {
  readonly source: "cliproxyapi.json" | "quota-handoff.json"
  readonly routes: Readonly<Record<string, string>>
  readonly quota: QuotaConfig | undefined
  readonly catalog: Readonly<Record<string, string>>
}

export async function cliproxyapiConfig(directory = globalConfigDir()): Promise<CliproxyapiConfig | undefined> {
  const file = Bun.file(path.join(directory, "cliproxyapi.json"))
  if (await file.exists()) {
    const value = Schema.decodeUnknownSync(Schema.fromJsonString(CliproxyapiFile))(await file.text())
    return {
      source: "cliproxyapi.json",
      routes: value.routes,
      quota:
        value.quota === false
          ? undefined
          : { routes: value.routes, ...(value.compactionModel ? { compactionModel: value.compactionModel } : {}) },
      catalog: value.catalog === false ? {} : value.routes,
    }
  }
  const legacy = Bun.file(path.join(directory, "quota-handoff.json"))
  if (!(await legacy.exists())) return undefined
  const value = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ routes: Schema.Record(Schema.String, Schema.String) })),
  )(await legacy.text())
  return { source: "quota-handoff.json", routes: value.routes, quota: { routes: value.routes }, catalog: {} }
}
