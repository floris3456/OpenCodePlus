import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHttpResponse, SessionModelRequest } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { Meter } from "../pacer/meter.js"
import { usage } from "../pacer/cpa.js"
import { CLIENT_HEADER, QUOTA_HEADER, declaration, decodeQuota, type QuotaReply } from "../pacer/protocol.js"
import { quotaEndpoint, type Config } from "./protocol.js"
import type { UsageInput, UsageResult } from "./usage.js"
import { pacerSnapshot } from "./pacer-snapshot.js"
export { pacerSnapshot } from "./pacer-snapshot.js"

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
  // A cached reply is an observation, not a clock: failed polls must not keep
  // resetting the sidebar clock to the time that reply was produced.
  const snapshot = pacerSnapshot(meter, input, Math.max(view?.now_ms ?? Date.now(), reply?.at_ms ?? 0))
  return { status: "ready", snapshot, ...(!reply ? { fallback: "fresh" as const } : {}) }
}
