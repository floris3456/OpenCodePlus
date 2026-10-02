import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"
import { endpoint, Stored, type Config } from "./protocol.js"

export const UsageWindow = Schema.Struct({
  scope: Schema.String,
  seconds: Schema.Number,
  remaining: Schema.Number,
  reset: Schema.Number,
  observed: Schema.Number,
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
  model: Schema.String,
  current: Schema.String,
  active: Schema.Array(Schema.String),
  last_used: Schema.Number,
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
  },
  events: {},
})

/** Reads only a persisted capability; opening /usage cannot enroll or wake a chat. */
export async function readUsage(
  config: Config | undefined,
  io: { read(key: string): Promise<unknown>; fetch: typeof fetch },
  input: UsageInput,
): Promise<UsageResult> {
  const origin = config?.routes[input.providerID]
  if (!origin)
    return {
      status: "disabled",
      message: "Enable this CPA provider in ~/.config/opencodeplus/quota-handoff.json to view credential usage.",
    }
  if (!input.sessionID)
    return {
      status: "unenrolled",
      message: "Open a chat that has made a request through this CPA model to view its credential quotas.",
    }
  const raw = await io.read(`quota/${input.sessionID}/${input.providerID}/${input.modelID}`)
  if (raw === undefined)
    return {
      status: "unenrolled",
      message:
        "This chat has not used this model through the quota bridge yet. Send a model request first; no credential is selected by /usage.",
    }
  const stored = Schema.decodeUnknownOption(Stored)(raw)
  if (stored._tag === "None")
    return {
      status: "unavailable",
      message: "This chat’s quota connection could not be read. Make a model request to reconnect the bridge.",
    }
  const url = new URL(endpoint(origin))
  url.searchParams.set("view", "usage")
  url.searchParams.set("model", `${input.providerID}/${input.modelID}`)
  url.searchParams.set("all", String(input.all))
  const response = await io
    .fetch(url, {
      headers: { Authorization: `Bearer ${stored.value.capability}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    })
    .catch(() => undefined)
  if (!response)
    return { status: "unavailable", message: "The CPA quota bridge could not be reached. Press r to retry." }
  if (response.status === 401)
    return {
      status: "unenrolled",
      message:
        "CPA has no matching credential binding for this chat and model. Make a model request to reconnect the bridge.",
    }
  if (!response.ok)
    return {
      status: "unavailable",
      message: `CPA could not retrieve credential usage (HTTP ${response.status}). Press r to retry.`,
    }
  const rawSnapshot: unknown = await response.json().catch(() => undefined)
  const parsed = Schema.decodeUnknownOption(UsageSnapshot)(rawSnapshot)
  if (parsed._tag === "None" || parsed.value.all !== input.all)
    return {
      status: "unsupported",
      message: "This CPA quota plugin does not support the usage view. Install quota-handoff 0.1.2 or newer on CPA.",
    }
  return { status: "ready", snapshot: parsed.value }
}
