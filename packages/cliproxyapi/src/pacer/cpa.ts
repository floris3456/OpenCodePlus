// Vendored from opencode-pacer@35cfeff (src/core/cpa.ts).
// Reads from a CLIProxyAPI (CPA) and the Pacer plugin inside it. The API key is
// only ever sent to the origin of the base URL it was entered with.

import { parseDiscovery, parsePrices, parseUsage, type Discovery, type Price, type UsageView } from "./protocol.js"

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface Connection {
  /** The CPA OpenAI-compatible base URL, ending in /v1. */
  baseURL: string
  key: string
}

/** Normalises what a user typed: http(s), no credentials or query, ending in /v1. */
export function normaliseBaseURL(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  let path = url.pathname.replace(/\/+$/, "")
  if (!path.endsWith("/v1")) path += "/v1"
  return url.origin + path
}

export function originOf(baseURL: string): string {
  return new URL(baseURL).origin
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function getJSON(fetchFn: Fetch, url: string, key: string | undefined, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (key) headers.Authorization = `Bearer ${key}`
    const res = await fetchFn(url, { headers, signal: controller.signal, redirect: "error" })
    if (!res.ok) throw new HttpError(res.status, `${new URL(url).pathname} answered HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

const EVENTS = "/v0/resource/plugins/pacer/events"

/** Whether this CPA runs a Pacer that speaks the client protocol. Sends no key. */
export async function discover(fetchFn: Fetch, baseURL: string, timeoutMs = 5000): Promise<Discovery> {
  try {
    return parseDiscovery(await getJSON(fetchFn, originOf(baseURL) + EVENTS, undefined, timeoutMs))
  } catch {
    return { pacer: false, views: [] }
  }
}

/** Every account with a quota meter. Served from Pacer's copy: no provider is asked. */
export async function usage(fetchFn: Fetch, conn: Connection, timeoutMs = 5000): Promise<UsageView> {
  const url = `${originOf(conn.baseURL)}${EVENTS}?view=usage&auth=api-key&all=true&v=1`
  const view = parseUsage(await getJSON(fetchFn, url, conn.key, timeoutMs))
  if (!view) throw new Error("Pacer's usage view was not understood")
  return view
}

/** Pacer's price for each model this key can use (USD per million tokens). */
export async function prices(fetchFn: Fetch, conn: Connection, timeoutMs = 10000): Promise<Record<string, Price>> {
  const url = `${originOf(conn.baseURL)}${EVENTS}?view=prices&auth=api-key`
  const out = parsePrices(await getJSON(fetchFn, url, conn.key, timeoutMs))
  if (!out) throw new Error("Pacer's prices were not understood")
  return out
}

/** CPA's model catalogue: `GET /v1/models?details=true`, else the plain list. */
export async function models(fetchFn: Fetch, conn: Connection, timeoutMs = 10000): Promise<{ details: boolean; data: unknown[] }> {
  const body = (await getJSON(fetchFn, `${conn.baseURL}/models?details=true`, conn.key, timeoutMs)) as Record<string, unknown>
  if (!body || !Array.isArray(body.data)) throw new Error("CPA's model list was not understood")
  return { details: body.schema === "cliproxyapi.model-details/1", data: body.data }
}
