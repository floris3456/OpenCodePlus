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
// CPA cannot stop a read the client gave up on, so a short timeout only piles reads up on a slow Pacer.
const TIMEOUT_MS = 10_000
const BACKOFF_MS = 15_000
const BACKOFF_MAX_MS = 120_000
const RETRY_AFTER_MAX_MS = 15 * 60_000

interface Entry {
  readonly at: number
  readonly result: Promise<ChatRead | undefined>
  pending: boolean
  /** Failed reads in a row; the next read waits until `retryAt`. */
  failures: number
  retryAt: number
}

/**
 * The chat's usage view (`view=usage&v=1`), read with Plus's own claim capability; stock switch handling
 * is disabled. Reads are coalesced for 15 seconds per chat and model, so the sidebar's preview and the
 * cache check share one request; a caller that needs an answer newer than `after` reads again. At most
 * one read per chat and model is in flight: a caller joins it, as its answer arrives after the caller
 * asked. A failed read (an error status, a timeout, no connection) is not repeated for 15 seconds,
 * doubling to 2 minutes, nor before the answer's `Retry-After`. Reads never enroll or wake a chat.
 */
export function createChatView(io: IO) {
  const reads = new Map<string, Entry>()
  return (origin: string | undefined, input: Chat, after = 0): Promise<ChatRead | undefined> => {
    if (!origin || !input.sessionID) return Promise.resolve(undefined)
    const key = JSON.stringify([origin, input.sessionID, input.providerID, input.modelID])
    const previous = reads.get(key)
    if (previous?.pending || (previous && io.now() < previous.retryAt)) return previous.result
    if (previous && io.now() - previous.at < COALESCE_MS && previous.at >= after) return previous.result
    reads.delete(key)
    if (reads.size >= 256) reads.delete(reads.keys().next().value!)
    const entry: Entry = {
      at: io.now(),
      pending: true,
      failures: previous?.failures ?? 0,
      retryAt: 0,
      result: readView(io, origin, input)
        .catch(() => ({ failed: true as const, retryAfter: undefined }))
        .then((outcome) => {
          entry.pending = false
          if (outcome.failed === false) {
            entry.failures = 0
            return outcome.read
          }
          entry.failures++
          entry.retryAt =
            io.now() +
            Math.max(
              Math.min(BACKOFF_MS * 2 ** (entry.failures - 1), BACKOFF_MAX_MS),
              Math.min(outcome.retryAfter ?? 0, RETRY_AFTER_MAX_MS),
            )
          return undefined
        }),
    }
    reads.set(key, entry)
    return entry.result
  }
}

async function readView(
  io: IO,
  origin: string,
  input: Chat,
): Promise<{ failed: false; read?: ChatRead } | { failed: true; retryAfter?: number }> {
  const stored = Schema.decodeUnknownOption(Stored)(
    await io.read(`quota/${input.sessionID}/${input.providerID}/${input.modelID}`),
  )
  if (Option.isNone(stored)) return { failed: false }
  const url = new URL(originOf(origin) + "/v0/resource/plugins/pacer/events")
  url.search = new URLSearchParams({ view: "usage", v: "1", model: `${input.providerID}/${input.modelID}` }).toString()
  const response = await io.fetch(url.href, {
    headers: { Accept: "application/json", Authorization: `Bearer ${stored.value.capability}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
  })
  if (!response.ok) return { failed: true, retryAfter: retryAfterOf(response.headers.get("retry-after"), io.now()) }
  const view: unknown = await response.json()
  return { failed: false, read: { at: io.now(), view } }
}

/** `Retry-After` as delay-seconds or an HTTP date, in milliseconds from `now`. */
function retryAfterOf(value: string | null, now: number) {
  const text = value?.trim()
  if (!text) return undefined
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
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
  return (origin: string | undefined, input: Chat) =>
    view(origin, input).then((read) => nextUseOf(read, input.modelID, io.now()))
}
