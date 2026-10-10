import { Schema } from "effect"
import { quotaEndpoint } from "./protocol.js"
import { discover } from "../pacer/cpa.js"

const Health = Schema.Struct({ protocol: Schema.Literal(1) })

/**
 * Whether the CPA at `origin` runs the quota-handoff plugin. Its events
 * endpoint answers an unauthenticated GET with `{ "protocol": 1 }`; a CPA
 * without it answers 404, or a login redirect when a proxy guards unknown
 * paths. No key is sent, so the answer can never leak one.
 */
export async function probeQuota(origin: string, io: { fetch: typeof fetch; timeout?: number }) {
  return (await probeCPA(origin, io)).quota
}

/** Pacer first; the legacy endpoint remains the coordination fallback. No credentials are sent. */
export async function probeCPA(origin: string, io: { fetch: typeof fetch; timeout?: number }) {
  const url = quotaEndpoint(origin)
  if (!url) return { quota: false, pacer: false }
  const pacer = await discover(io.fetch, origin, io.timeout)
  if (pacer.pacer) return { quota: true, pacer: true }
  const response = await io
    .fetch(url, { signal: AbortSignal.timeout(io.timeout ?? 5_000), redirect: "error" })
    .catch(() => undefined)
  if (response?.status !== 200) return { quota: false, pacer: false }
  return {
    quota: Schema.decodeUnknownOption(Health)(await response.json().catch(() => undefined))._tag === "Some",
    pacer: false,
  }
}
