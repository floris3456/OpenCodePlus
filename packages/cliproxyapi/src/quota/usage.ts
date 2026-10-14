import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"
import { endpoint, Stored, type Config } from "./protocol.js"
import { readPacerUsage } from "./pacer.js"

export const UsageWindow = Schema.Struct({
  scope: Schema.String,
  seconds: Schema.Number,
  remaining: Schema.Number,
  reset: Schema.Number,
  observed: Schema.Number,
  /** Pacer evaluates provider observation freshness; updated is the last meter confirmation. */
  state: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.Number),
  held: Schema.Boolean,
  dormant: Schema.optional(Schema.Boolean),
  not_applicable: Schema.optional(Schema.Boolean),
})
export type UsageWindow = typeof UsageWindow.Type
export const UsageSnapshot = Schema.Struct({
  protocol: Schema.Literal(1),
  view: Schema.Literal("usage"),
  now: Schema.Number,
  max_age_seconds: Schema.Number,
  all: Schema.Boolean,
  provider: Schema.String,
  /** Providers serving the selected model, from Pacer's cached catalogue. */
  providers: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.String,
  current: Schema.String,
  active: Schema.Array(Schema.String),
  last_used: Schema.Number,
  next_use: Schema.optional(
    Schema.Struct({
      v: Schema.Literal(1),
      at_ms: Schema.Number,
      expires_ms: Schema.Number,
      candidates_at_ms: Schema.optional(Schema.Number),
      mode: Schema.Literals(["off", "dry-run", "active"]),
      provider: Schema.String,
      model: Schema.String,
      reason: Schema.String,
      /** Pacer's view of the chat's cache: NEXT USE takes over once it is cold. */
      warm: Schema.optional(Schema.Boolean),
      /** NEXT USE: where the chat moves once its cache is cold. */
      auth: Schema.optional(Schema.String),
      alias: Schema.optional(Schema.String),
      forced: Schema.Boolean,
      /** FORCE USE: where a forced move sends the chat, now or soon (a meter near its floor). */
      force_auth: Schema.optional(Schema.String),
      force_alias: Schema.optional(Schema.String),
      force_reason: Schema.optional(Schema.Literals(["now", "soon"])),
    }),
  ),
  credentials: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      alias: Schema.String,
      provider: Schema.String,
      shared_with: Schema.Array(Schema.String),
      windows: Schema.Array(UsageWindow),
    }),
  ),
})
export type UsageSnapshot = typeof UsageSnapshot.Type
export const UsageInput = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
  providerID: Schema.String,
  modelID: Schema.String,
  all: Schema.Boolean,
})
export type UsageInput = typeof UsageInput.Type
export const UsageResult = Schema.Struct({
  status: Schema.Literals(["ready", "disabled", "unenrolled", "unavailable", "unsupported"]),
  message: Schema.optional(Schema.String),
  snapshot: Schema.optional(UsageSnapshot),
  /** Why an all-credentials view replaced the chat view: no request yet, or CPA has no binding for this chat. */
  fallback: Schema.optional(Schema.Literals(["fresh", "untracked"])),
})
export type UsageResult = typeof UsageResult.Type
export const UsageDefinition = Rpc.define({
  id: "opencode.plus.quota.usage",
  methods: {
    read: {
      input: Schema.toStandardSchemaV1(UsageInput),
      output: Schema.toStandardSchemaV1(UsageResult),
      errors: {},
    },
    /** Whether quota coordination is on for any provider now; the TUI shows nothing until it is. */
    enabled: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Struct({ enabled: Schema.Boolean })),
      errors: {},
    },
  },
  events: {},
})

/** Reads an existing capability or uses the CPA API key for the all-credentials fallback. Never enrolls or wakes a chat. */
export async function readUsage(
  config: Config | undefined,
  io: {
    read(key: string): Promise<unknown>
    fetch: typeof fetch
    key?(input: UsageInput, origin: string): Promise<string | undefined>
  },
  input: UsageInput,
): Promise<UsageResult> {
  const origin = config?.routes[input.providerID]
  if (!origin)
    return {
      status: "disabled",
      message:
        'Credential usage needs the quota-handoff plugin on this provider\'s CLIProxyAPI (and no "quota": false in ~/.config/opencodeplus/cliproxyapi.json).',
    }
  if (config?.pacer?.includes(input.providerID)) return readPacerUsage(origin, io, input)
  const raw = input.sessionID
    ? await io.read(`quota/${input.sessionID}/${input.providerID}/${input.modelID}`)
    : undefined
  const stored = raw === undefined ? undefined : Schema.decodeUnknownOption(Stored)(raw)
  if (stored?._tag === "None")
    return {
      status: "unavailable",
      message: "This chat’s quota connection could not be read. Make a model request to reconnect the bridge.",
    }
  const url = new URL(endpoint(origin))
  url.searchParams.set("view", "usage")
  url.searchParams.set("model", `${input.providerID}/${input.modelID}`)
  url.searchParams.set("all", String(input.all))
  const request = (key: string) =>
    io
      .fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      })
      .catch(() => undefined)
  const bound = stored?._tag === "Some" ? await request(stored.value.capability) : undefined
  const fallback = stored === undefined || bound?.status === 401
  const response = await (async () => {
    if (!fallback) return bound
    const key = await io.key?.(input, origin).catch(() => undefined)
    if (!key) return undefined
    url.searchParams.set("auth", "api-key")
    url.searchParams.set("all", "true")
    return request(key)
  })()
  if (!response)
    return {
      status: "unavailable",
      message: fallback
        ? "Could not read usage with this provider’s CPA API key. Check the provider connection and quota bridge address; usage retries automatically."
        : "The CPA quota bridge could not be reached; usage retries automatically.",
    }
  if (response.status === 401)
    return {
      status: "unavailable",
      message:
        "CPA rejected the usage request. Check this provider’s API key and that CPA has quota-handoff 0.1.2 or newer.",
    }
  if (!response.ok)
    return {
      status: "unavailable",
      message: `CPA could not retrieve credential usage (HTTP ${response.status}); usage retries automatically.`,
    }
  const rawSnapshot: unknown = await response.json().catch(() => undefined)
  const parsed = Schema.decodeUnknownOption(UsageSnapshot)(rawSnapshot)
  if (parsed._tag === "None" || parsed.value.all !== (fallback || input.all))
    return {
      status: "unsupported",
      message: "This CPA quota plugin does not support the usage view. Install quota-handoff 0.1.2 or newer on CPA.",
    }
  if (!fallback) return { status: "ready", snapshot: parsed.value }
  return { status: "ready", snapshot: parsed.value, fallback: stored === undefined ? "fresh" : "untracked" }
}
