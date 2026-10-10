import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHttpResponse, SessionModelRequest } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { Meter } from "../pacer/meter.js"
import { usage } from "../pacer/cpa.js"
import { CLIENT_HEADER, QUOTA_HEADER, declaration, decodeQuota, type QuotaReply } from "../pacer/protocol.js"
import { quotaEndpoint, type Config } from "./protocol.js"
import type { UsageInput, UsageResult, UsageSnapshot } from "./usage.js"

/** The same origin guard protects declarations and response data from unrelated providers. */
function matches(origin: string | undefined, url: string | undefined) {
  return (
    origin !== undefined &&
    quotaEndpoint(origin) !== undefined &&
    url !== undefined &&
    URL.canParse(url) &&
    new URL(url).origin === new URL(origin).origin
  )
}

export function pacerRequest(config: Config, event: SessionModelRequest) {
  if (!matches(config.routes[event.model.providerID], event.baseURL)) return
  event.headers[CLIENT_HEADER] = declaration({ quota: true })!
}

export async function pacerResponse(
  config: Config,
  event: SessionHttpResponse,
  io: { read(key: string): Promise<unknown>; write(key: string, value: string): Promise<void> },
) {
  if (!matches(config.routes[event.model.providerID], event.request.url)) return
  const value = event.response.headers.get(QUOTA_HEADER)
  const reply = decodeQuota(value)
  if (!reply || !value) return
  const key = `pacer/${event.sessionID}/${event.model.providerID}/${event.model.id}`
  const raw = await io.read(key)
  const previous = decodeQuota(typeof raw === "string" ? raw : undefined)
  if (previous && previous.at_ms > reply.at_ms) return
  await io.write(key, value)
}

export function registerPacer(ctx: Context, config: () => Config) {
  return Effect.gen(function* () {
    yield* ctx.session.hook("model.request", (event) => Effect.sync(() => pacerRequest(config(), event)))
    yield* ctx.session.hook("http.response", (event) =>
      Effect.promise(() =>
        pacerResponse(config(), event, {
          read: (key) => Effect.runPromise(ctx.storage.get(key)),
          write: (key, value) => Effect.runPromise(ctx.storage.set(key, value)),
        }),
      ),
    )
  })
}

/** Adapts the shared meter into the existing Usage RPC; no TUI-owned protocol parsing. */
export function pacerSnapshot(meter: Meter, input: UsageInput, now: number): UsageSnapshot {
  const served = input.sessionID ? meter.lastServed(input.sessionID) : undefined
  const rows = meter.rows()
  return {
    protocol: 1,
    view: "usage",
    now: now / 1000,
    max_age_seconds: 90,
    all: input.all || !served,
    provider: rows.find((c) => c.id === served?.auth)?.provider ?? "",
    model: input.modelID,
    current: served?.auth ?? "",
    active: [],
    last_used: (served?.at_ms ?? 0) / 1000,
    credentials: rows
      .filter((c) => input.all || !served || c.id === served.auth)
      .map((c) => ({
        id: c.id,
        alias: c.alias,
        provider: c.provider,
        shared_with: c.shared_with,
        // Missing readings are not invented as percentages or reset dates.
        windows: c.windows
          .filter((w) => w.left !== undefined && w.reset_ms !== undefined)
          .map((w) => ({
            scope: w.scope,
            seconds: w.seconds,
            remaining: w.left!,
            reset: w.reset_ms! / 1000,
            observed: ["current", "estimated", "partial"].includes(w.state) ? (w.read_ms ?? c.at_ms) / 1000 : 0,
            held: false,
            dormant: w.state === "dormant",
            not_applicable: !w.applies,
          })),
      })),
  }
}

export async function readPacerUsage(
  origin: string,
  io: {
    read(key: string): Promise<unknown>
    fetch: typeof fetch
    key?(input: UsageInput, origin: string): Promise<string | undefined>
  },
  input: UsageInput,
): Promise<UsageResult> {
  if (!quotaEndpoint(origin))
    return { status: "unavailable", message: "Pacer requires an HTTPS or loopback origin without credentials." }
  const raw = input.sessionID
    ? await io.read(`pacer/${input.sessionID}/${input.providerID}/${input.modelID}`)
    : undefined
  const reply: QuotaReply | undefined = decodeQuota(typeof raw === "string" ? raw : undefined)
  const meter = new Meter()
  const key = await io.key?.(input, origin).catch(() => undefined)
  const view = key ? await usage(io.fetch, { baseURL: origin, key }).catch(() => undefined) : undefined
  if (view) meter.applyView(view)
  if (reply) meter.applyReply(reply, input.sessionID)
  if (!view && !reply)
    return { status: "unavailable", message: "Pacer usage could not be retrieved. Retrying automatically." }
  const snapshot = pacerSnapshot(meter, input, view?.now_ms ?? reply!.at_ms)
  return { status: "ready", snapshot, ...(!reply ? { fallback: "fresh" as const } : {}) }
}
