// Vendored from opencode-pacer@35cfeff (src/core/protocol.ts).
// Pacer's client protocol (pacer docs/client-protocol.md). Host-neutral: no
// opencode imports, so stock opencode 1.x, opencode 2.x and OpenCodePlus share it.

/** Sent on each model request by a client that knows Pacer. Never per API key. */
export const CLIENT_HEADER = "X-Pacer-Client"
/** On replies to declared requests: the serving account's quota windows. */
export const QUOTA_HEADER = "X-Pacer-Quota"

export interface Caps {
  /** The client reads X-Pacer-Quota from replies. */
  quota: boolean
}

/** The X-Pacer-Client value for these capabilities, or undefined for none. */
export function declaration(caps: Caps): string | undefined {
  const list = caps.quota ? ["quota"] : []
  return list.length ? `v=1; caps=${list.join(",")}` : undefined
}

/** One quota window. `left` is the % left; times are Unix milliseconds. */
export interface QuotaWindow {
  scope: string
  seconds: number
  left?: number
  reset_ms?: number
  /** "absolute" (the provider's timestamp) or "estimated" (from a countdown). */
  reset_quality?: string
  /**
   * current, estimated, stale, dormant, partial, unknown, awaiting-confirmation
   * (the reset passed and no reading confirmed it yet), ambiguous, conflicting.
   */
  state: string
  read_ms?: number
  source?: string
  applies: boolean
}

export interface QuotaReply {
  v: 1
  provider: string
  auth: string
  alias?: string
  at_ms: number
  windows: QuotaWindow[]
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

/** Validates one window from Pacer; anything malformed is dropped. */
export function parseWindow(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as Record<string, unknown>
  const scope = str(w.scope)
  const seconds = num(w.seconds)
  const state = str(w.state)
  if (!scope || !seconds || seconds <= 0 || !state) return undefined
  const left = num(w.left)
  if (left !== undefined && (left < 0 || left > 100)) return undefined
  return {
    scope,
    seconds,
    left,
    reset_ms: num(w.reset_ms) || undefined,
    reset_quality: str(w.reset_quality),
    state,
    read_ms: num(w.read_ms) || undefined,
    source: str(w.source),
    applies: w.applies !== false,
  }
}

function base64url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Decodes X-Pacer-Quota. Undefined when absent or not a version this client knows. */
export function decodeQuota(value: string | null | undefined): QuotaReply | undefined {
  if (!value || value.length > 16384) return undefined
  const text = base64url(value)
  if (text === undefined) return undefined
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  const provider = str(d.provider)
  const auth = str(d.auth)
  const at = num(d.at_ms)
  if (d.v !== 1 || !provider || !auth || !at || !Array.isArray(d.windows)) return undefined
  const windows = d.windows.map(parseWindow).filter((w): w is QuotaWindow => !!w)
  return { v: 1, provider, auth, alias: str(d.alias), at_ms: at, windows }
}

/** What GET /v0/resource/plugins/pacer/events (no key) says about the server. */
export interface Discovery {
  /** A Pacer that speaks the client protocol (X-Pacer-Client / X-Pacer-Quota). */
  pacer: boolean
  views: string[]
}

export function parseDiscovery(raw: unknown): Discovery {
  const none: Discovery = { pacer: false, views: [] }
  if (!raw || typeof raw !== "object") return none
  const d = raw as Record<string, unknown>
  const client = d.client as Record<string, unknown> | undefined
  if (d.pacer !== true || !client || client.version !== 1) return none
  const caps = Array.isArray(client.caps) ? client.caps : []
  if (client.request_header !== CLIENT_HEADER || client.quota_header !== QUOTA_HEADER || !caps.includes("quota")) return none
  const views = Array.isArray(client.views) ? client.views.filter((v): v is string => typeof v === "string") : []
  return { pacer: true, views }
}

/** One account in Pacer's usage view (view=usage&v=1). */
export interface UsageCredential {
  id: string
  alias: string
  provider: string
  shared_with: string[]
  windows: QuotaWindow[]
}

export interface UsageView {
  now_ms: number
  credentials: UsageCredential[]
}

export function parseUsage(raw: unknown): UsageView | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const d = raw as Record<string, unknown>
  if (d.view !== "usage" || !Array.isArray(d.credentials)) return undefined
  const now = num(d.now)
  const credentials: UsageCredential[] = []
  for (const item of d.credentials) {
    if (!item || typeof item !== "object") continue
    const c = item as Record<string, unknown>
    const id = str(c.id)
    const provider = str(c.provider)
    if (!id || !provider || !Array.isArray(c.windows)) continue
    credentials.push({
      id,
      alias: str(c.alias) || id,
      provider,
      shared_with: Array.isArray(c.shared_with) ? c.shared_with.filter((v): v is string => typeof v === "string") : [],
      windows: c.windows.map(parseWindow).filter((w): w is QuotaWindow => !!w),
    })
  }
  return { now_ms: now ? now * 1000 : Date.now(), credentials }
}

/** A model's price: USD per million tokens, as Pacer values usage. */
export interface Price {
  input: number
  output: number
  cache_read?: number
  /** The 5-minute cache write. */
  cache_write?: number
  context_tiers?: { above_tokens: number; price: Omit<Price, "context_tiers" | "fast" | "source"> }[]
  fast?: Omit<Price, "context_tiers" | "fast" | "source">
  /** manual, imported or models.dev */
  source: string
}

function parsePriceBody(raw: unknown): Omit<Price, "context_tiers" | "fast" | "source"> | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const p = raw as Record<string, unknown>
  const input = num(p.input)
  const output = num(p.output)
  if (input === undefined || output === undefined || input < 0 || output < 0) return undefined
  return { input, output, cache_read: num(p.cache_read), cache_write: num(p.cache_write) }
}

export function parsePrices(raw: unknown): Record<string, Price> | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const d = raw as Record<string, unknown>
  if (d.view !== "prices" || d.unit !== "usd_per_million_tokens" || !d.models || typeof d.models !== "object") return undefined
  const out: Record<string, Price> = {}
  for (const [id, value] of Object.entries(d.models as Record<string, unknown>)) {
    const body = parsePriceBody(value)
    if (!body) continue
    const v = value as Record<string, unknown>
    const price: Price = { ...body, source: str(v.source) || "unknown" }
    if (Array.isArray(v.context_tiers)) {
      const tiers = v.context_tiers
        .map((t) => {
          const above = num((t as Record<string, unknown>)?.above_tokens)
          const p = parsePriceBody((t as Record<string, unknown>)?.price)
          return above && p ? { above_tokens: above, price: p } : undefined
        })
        .filter((t): t is NonNullable<typeof t> => !!t)
      if (tiers.length) price.context_tiers = tiers
    }
    const fast = parsePriceBody(v.fast)
    if (fast) price.fast = fast
    out[id] = price
  }
  return out
}
