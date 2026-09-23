import {
  canonicalReleaseJson,
  releasePermitPayload,
  type ReleaseControllerPermit,
  type ReleasePermitBody,
  type ReleaseRequest,
  type ReleaseRequestStatus,
} from "@opencode/schema/release"

// Plus owns the permit helpers the external controller tooling signs with, and
// the refusal vocabulary callers switch on. Request state does not live here:
// the plugin submits and reads through the host's in-process release seam
// (`Plugin.Context.release`), which is backed by the durable store the HTTP
// release routes serve. A second, process-local store would answer like the
// real one while being invisible to those routes and lost on restart.

// The permit and the bytes it signs are wire contracts owned by @opencode/schema,
// re-exported here so the existing plugin-side callers keep one import site.
export type ControllerPermit = ReleaseControllerPermit
export type PermitBody = ReleasePermitBody

export type RefusalReason =
  | "malformed_request"
  | "request_conflict"
  | "unknown_request"
  | "no_authority"
  | "malformed_permit"
  | "unknown_issuer"
  | "bad_signature"
  | "expired_permit"
  | "replayed_permit"
  | "request_mismatch"
  | "scope_widened"
  | "unsupported_request"
  | "artifact_mismatch"
  | "generation_mismatch"
  | "already_settled"
  | "authority_conflict"
  | "fence_unavailable"

export interface Refusal {
  readonly ok: false
  readonly reason: RefusalReason
  readonly message: string
}

export interface Settled {
  readonly ok: true
  readonly status: ReleaseRequestStatus
  /** True when this call found the recorded outcome instead of producing a new one. */
  readonly reconciled: boolean
}

export type RequestResult = Settled | Refusal

/** The canonical digest a controller signs to bind a permit to one exact request body. */
export function releaseRequestDigest(request: ReleaseRequest): string {
  return new Bun.CryptoHasher("sha256").update(canonicalReleaseJson(request)).digest("hex")
}

/** The exact bytes a controller signs. Exported so an issuer and this verifier cannot drift. */
export function permitSigningPayload(body: PermitBody): string {
  return releasePermitPayload(body)
}
