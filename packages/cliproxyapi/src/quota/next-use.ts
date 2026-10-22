import { originOf, parseNextUse, type NextUse } from "opencode-pacer/core"
import { Option, Schema } from "effect"
import type { PacerCache, PacerUsedUp } from "../pacer-cache.js"
import { Stored } from "./protocol.js"

type IO = { read(key: string): Promise<unknown>; fetch: typeof fetch; now(): number }
type Chat = { readonly sessionID?: string; readonly providerID: string; readonly modelID: string }

/** One read of the chat's own usage view, and this process's clock when it arrived. */
export interface ChatRead {
  readonly at: number
  readonly view: unknown
}

const COALESCE_MS = 15_000
const TIMEOUT_MS = 3_000

/**
 * The chat's usage view (`view=usage&v=1`), read with Plus's own claim capability; stock switch handling
 * is disabled. Reads are coalesced for 15 seconds per chat and model, so the sidebar's preview and the
 * cache check share one request; a caller that needs an answer newer than `after` reads again. Reads
 * never enroll or wake a chat.
 */
export function createChatView(io: IO) {
  const cache = new Map<string, { at: number; result: Promise<ChatRead | undefined> }>()
  return (origin: string | undefined, input: Chat, after = 0): Promise<ChatRead | undefined> => {
    if (!origin || !input.sessionID) return Promise.resolve(undefined)
    const key = JSON.stringify([origin, input.sessionID, input.providerID, input.modelID])
    const previous = cache.get(key)
    if (previous && io.now() - previous.at < COALESCE_MS && previous.at >= after) return previous.result
    cache.delete(key)
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    const result = (async () => {
      const stored = Schema.decodeUnknownOption(Stored)(
        await io.read(`quota/${input.sessionID}/${input.providerID}/${input.modelID}`),
      )
      if (Option.isNone(stored)) return
      const url = new URL(originOf(origin) + "/v0/resource/plugins/pacer/events")
      url.search = new URLSearchParams({ view: "usage", v: "1", model: `${input.providerID}/${input.modelID}` }).toString()
      const response = await io.fetch(url.href, {
        headers: { Accept: "application/json", Authorization: `Bearer ${stored.value.capability}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      })
      if (!response.ok) return
      const view: unknown = await response.json()
      return { at: io.now(), view }
    })().catch(() => undefined)
    cache.set(key, { at: io.now(), result })
    return result
  }
}

/** Pacer's per-chat next-use preview, for the sidebar: dropped once expired or for another model. */
export function nextUseOf(read: ChatRead | undefined, modelID: string, now: number): NextUse | undefined {
  const next = parseNextUse((read?.view as { next_use?: unknown } | undefined)?.next_use)
  if (next?.model !== modelID || next.expires_ms <= now) return
  // Pacer's parser retains absent keys as undefined; the public RPC requires JSON.
  return {
    v: next.v,
    at_ms: next.at_ms,
    expires_ms: next.expires_ms,
    mode: next.mode,
    provider: next.provider,
    model: next.model,
    reason: next.reason,
    forced: next.forced,
    ...(next.candidates_at_ms === undefined ? {} : { candidates_at_ms: next.candidates_at_ms }),
    ...(next.auth === undefined ? {} : { auth: next.auth }),
    ...(next.alias === undefined ? {} : { alias: next.alias }),
    ...(next.warm === undefined ? {} : { warm: next.warm }),
    ...(next.force_auth === undefined ? {} : { force_auth: next.force_auth, force_reason: next.force_reason }),
    ...(next.force_alias === undefined ? {} : { force_alias: next.force_alias }),
  }
}

// Pacer's client library drops fields it does not know, so `serves_at_ms` is read from the view itself.
const ForcedNow = Schema.Struct({
  next_use: Schema.Struct({ at_ms: Schema.Number, serves_at_ms: Schema.optional(Schema.Number) }),
})

/**
 * Pacer's preview says the chat's next step is a forced move off its account now (`force_reason` "now":
 * the account cannot serve), with when the account serves again (`serves_at_ms`, moved from Pacer's clock
 * at `at_ms` onto this one), when Pacer says. "soon" (a meter near its floor) still serves the next step.
 */
export function usedUpOf(read: ChatRead | undefined, modelID: string, now: number): PacerUsedUp | undefined {
  if (read === undefined || nextUseOf(read, modelID, now)?.force_reason !== "now") return
  const next = Option.getOrUndefined(Schema.decodeUnknownOption(ForcedNow)(read.view))?.next_use
  return next?.serves_at_ms === undefined ? {} : { servesAt: next.serves_at_ms - next.at_ms + read.at }
}

const CacheView = Schema.Struct({
  now_ms: Schema.Number,
  cache: Schema.Struct({
    v: Schema.Literal(1),
    model: Schema.String,
    warm: Schema.Boolean,
    evidence: Schema.Literals(["active", "confirmed", "assumed"]),
    until_ms: Schema.optional(Schema.Number),
  }),
})

/**
 * Pacer's view of the chat's prompt cache, on this process's clock. Older Pacers send no `cache`; an
 * answer about another model (the chat moved model since its last request) says nothing about this one.
 */
export function cacheOf(read: ChatRead | undefined, modelID: string): PacerCache | undefined {
  const decoded = Schema.decodeUnknownOption(CacheView)(read?.view)
  if (read === undefined || Option.isNone(decoded) || decoded.value.cache.model !== modelID) return
  const cache = decoded.value.cache
  return {
    warm: cache.warm,
    evidence: cache.evidence,
    at: read.at,
    ...(cache.until_ms === undefined ? {} : { until: cache.until_ms - decoded.value.now_ms + read.at }),
  }
}

/** The sidebar's preview on its own view reader (tests; the adapter shares one reader with the cache check). */
export function createNextUse(io: IO) {
  const view = createChatView(io)
  return (origin: string | undefined, input: Chat) => view(origin, input).then((read) => nextUseOf(read, input.modelID, io.now()))
}
