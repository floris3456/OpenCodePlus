import { Schema } from "effect"
import { quotaEndpoint } from "./protocol.js"

const Health = Schema.Struct({ protocol: Schema.Literal(1) })

/**
 * Whether the CPA at `origin` runs the quota-handoff plugin. Its events
 * endpoint answers an unauthenticated GET with `{ "protocol": 1 }`; a CPA
 * without it answers 404, or a login redirect when a proxy guards unknown
 * paths. No key is sent, so the answer can never leak one.
 */
export async function probeQuota(origin: string, io: { fetch: typeof fetch; timeout?: number }) {
  const url = quotaEndpoint(origin)
  if (!url) return false
  const response = await io
    .fetch(url, { signal: AbortSignal.timeout(io.timeout ?? 5_000), redirect: "error" })
    .catch(() => undefined)
  if (response?.status !== 200) return false
  return Schema.decodeUnknownOption(Health)(await response.json().catch(() => undefined))._tag === "Some"
}
