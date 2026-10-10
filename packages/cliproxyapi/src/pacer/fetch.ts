// Vendored from opencode-pacer@35cfeff (src/core/fetch.ts).
// A fetch wrapper for model requests to CPA: declares the client to Pacer on
// each request and hands the quota on each reply to the meter.

import { CLIENT_HEADER, QUOTA_HEADER, declaration, decodeQuota, type QuotaReply } from "./protocol.js"

export interface PacerFetchOptions {
  /** The CPA origin; requests elsewhere pass through untouched. */
  origin: string
  /** Whether that CPA runs Pacer (only then is the declaration sent). */
  pacer: () => boolean
  onQuota: (reply: QuotaReply, session: string | undefined) => void
  base?: typeof fetch
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

export function pacerFetch(opts: PacerFetchOptions): typeof fetch {
  const base = opts.base ?? fetch
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let same = false
    try {
      same = new URL(urlOf(input)).origin === opts.origin
    } catch {}
    if (!same) return base(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const value = opts.pacer() ? declaration({ quota: true }) : undefined
    if (value) headers.set(CLIENT_HEADER, value)
    else headers.delete(CLIENT_HEADER)
    const session = headers.get("x-session-id") ?? headers.get("x-session-affinity") ?? undefined
    const res = await base(input, { ...init, headers })
    const reply = decodeQuota(res.headers.get(QUOTA_HEADER))
    if (reply) {
      try {
        opts.onQuota(reply, session)
      } catch {}
    }
    return res
  }
  return Object.assign(wrapped, { preconnect: (base as { preconnect?: unknown }).preconnect }) as typeof fetch
}
