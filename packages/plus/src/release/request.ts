import { Option, Schema } from "effect"
import { createPublicKey, verify } from "node:crypto"
import {
  canonicalReleaseJson,
  ReleaseControllerPermit,
  releasePermitPayload,
  ReleaseRequest,
  type ReleasePermitBody,
  type ReleaseRequestStatus,
} from "@opencode/schema/release"

// The bounded release request surface. A caller may submit a promotion or build
// intent and read its status; that is the whole product-facing vocabulary. This
// module never builds, never promotes and never activates: `authorize` only
// records an external controller's decision and closes the admission fence, and
// `settle` only records the outcome the controller reports back. The product
// holds verification keys, so it can read a permit and refuse one, but it has no
// way to mint one — a candidate-written flag, a model-signed blob or an empty
// approval reference is not authority.

// The permit and the bytes it signs are wire contracts owned by @opencode/schema,
// re-exported here so the existing plugin-side callers keep one import site.
export type ControllerPermit = ReleaseControllerPermit
export type PermitBody = ReleasePermitBody

/** Trusted controller issuers, each mapped to an SPKI PEM verification key. */
export interface ControllerTrust {
  readonly issuers: Readonly<Record<string, string>>
}

/**
 * The host's admission fence, injected rather than imported: the plugin package
 * does not depend on Core. `engage` and `release` answer whether the host really
 * changed state, and a false answer keeps the transition unauthorized.
 */
export interface AdmissionFencePort {
  readonly engage: (hold: { readonly token: string; readonly reason: string }) => boolean
  readonly release: (token: string) => boolean
}

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

export interface AuthorizeInput {
  readonly requestID: string
  readonly permit: unknown
  readonly trust: ControllerTrust
  readonly fence: AdmissionFencePort
  /** The generation this process is actually running, observed by the caller. */
  readonly currentGeneration: number
  readonly now?: number
}

export interface SettleInput {
  readonly requestID: string
  readonly token: string
  readonly outcome: "completed" | "failed" | "rejected"
  readonly detail?: string
  readonly fence: AdmissionFencePort
  readonly now?: number
}

interface Stored {
  readonly request: ReleaseRequest
  readonly fingerprint: string
  status: ReleaseRequestStatus
  token: string | undefined
}

const requests = new Map<string, Stored>()
const consumed = new Map<string, string>()

export function resetReleaseStore(): void {
  requests.clear()
  consumed.clear()
}

/** The canonical digest a controller signs to bind a permit to one exact request body. */
export function releaseRequestDigest(request: ReleaseRequest): string {
  return new Bun.CryptoHasher("sha256").update(canonicalReleaseJson(request)).digest("hex")
}

/** The exact bytes a controller signs. Exported so an issuer and this verifier cannot drift. */
export function permitSigningPayload(body: PermitBody): string {
  return releasePermitPayload(body)
}

export function submitReleaseRequest(raw: unknown, options?: { readonly now?: number }): RequestResult {
  const decoded = Schema.decodeUnknownOption(ReleaseRequest)(raw)
  if (Option.isNone(decoded))
    return refuse("malformed_request", "Submitted value does not match the release request contract")
  const request = decoded.value
  const fingerprint = releaseRequestDigest(request)
  const existing = requests.get(request.requestID)
  if (existing !== undefined) {
    // A bounded retry reconciles the recorded request; only a changed body conflicts.
    if (existing.fingerprint === fingerprint) return { ok: true, status: existing.status, reconciled: true }
    return refuse(
      "request_conflict",
      `Release request ${request.requestID} is already recorded with a different body`,
    )
  }
  const stored: Stored = {
    request,
    fingerprint,
    status: {
      requestID: request.requestID,
      state: "accepted",
      // A build request replaces no running generation, so it records none.
      generation: request.kind === "promote" ? request.expectedCurrentGeneration : 0,
      detail: null,
      observedAt: observedAt(options?.now),
    },
    token: undefined,
  }
  requests.set(request.requestID, stored)
  return { ok: true, status: stored.status, reconciled: false }
}

export function getReleaseRequestStatus(requestID: string): RequestResult {
  const stored = requests.get(requestID)
  if (stored === undefined) return refuse("unknown_request", `Release request ${requestID} was never submitted`)
  return { ok: true, status: stored.status, reconciled: true }
}

/**
 * Records an external controller's authorization and fences session admission for
 * the transition it authorizes. Nothing here promotes or rebuilds anything: the
 * request moves to `running` only because the controller decided it would, and the
 * fence closes so no new work enters a session that is about to be replaced.
 */
export function authorizeReleaseRequest(input: AuthorizeInput): RequestResult {
  const stored = requests.get(input.requestID)
  if (stored === undefined) return refuse("unknown_request", `Release request ${input.requestID} was never submitted`)

  const approvalRef = stored.request.approvalRef
  if (approvalRef === null || approvalRef.length === 0)
    return refuse("no_authority", `Release request ${input.requestID} carries no approval reference`)
  if (input.permit === undefined || input.permit === null)
    return refuse("no_authority", `Release request ${input.requestID} was presented without a controller permit`)

  const decoded = Schema.decodeUnknownOption(ReleaseControllerPermit)(input.permit)
  if (Option.isNone(decoded))
    return refuse("malformed_permit", "Presented value is not a controller permit")
  const permit = decoded.value

  if (approvalRef !== permit.permitID)
    return refuse(
      "no_authority",
      `Release request ${input.requestID} names approval ${approvalRef}, not ${permit.permitID}`,
    )

  const key = input.trust.issuers[permit.issuer]
  if (key === undefined) return refuse("unknown_issuer", `Permit issuer ${permit.issuer} is not a trusted controller`)
  if (!verifyPermit(permit, key))
    return refuse("bad_signature", `Permit ${permit.permitID} is not signed by ${permit.issuer}`)

  const validity = validityWindow(permit)
  if (validity === undefined)
    return refuse("malformed_permit", `Permit ${permit.permitID} has an unreadable validity window`)
  const now = input.now ?? Date.now()
  if (now < validity.from || now >= validity.until)
    return refuse("expired_permit", `Permit ${permit.permitID} is not valid at ${new Date(now).toISOString()}`)

  if (permit.requestID !== input.requestID)
    return refuse("request_mismatch", `Permit ${permit.permitID} authorizes ${permit.requestID}, not ${input.requestID}`)
  if (permit.requestDigest !== stored.fingerprint)
    return refuse(
      "scope_widened",
      `Release request ${input.requestID} no longer matches the body permit ${permit.permitID} authorized`,
    )

  // The permit is authentic and bound to this exact request, so a repeat is a
  // retry of a decided transition, never a second one.
  const replay = replayOf(stored, permit)
  if (replay !== undefined) return replay

  const request = stored.request
  if (request.kind !== "promote")
    return refuse("unsupported_request", `Release request ${input.requestID} is a build intent and activates nothing`)
  if (permit.artifactSha256 !== request.artifact.binarySha256)
    return refuse(
      "artifact_mismatch",
      `Permit ${permit.permitID} authorizes artifact ${permit.artifactSha256}, not ${request.artifact.binarySha256}`,
    )
  if (permit.expectedGeneration !== request.expectedCurrentGeneration)
    return refuse(
      "generation_mismatch",
      `Permit ${permit.permitID} expects generation ${permit.expectedGeneration}, request expects ${request.expectedCurrentGeneration}`,
    )
  if (request.expectedCurrentGeneration !== input.currentGeneration)
    return refuse(
      "generation_mismatch",
      `Release request ${input.requestID} expects generation ${request.expectedCurrentGeneration}, running generation is ${input.currentGeneration}`,
    )

  // Fence first: an authorized transition that cannot close admission is not
  // authorized at all, so nothing is consumed and the retry stays available.
  const fenced = input.fence.engage({
    token: permit.permitID,
    reason: `release promotion ${input.requestID}`,
  })
  if (!fenced)
    return refuse("fence_unavailable", `Session admission could not be fenced for release request ${input.requestID}`)

  consumed.set(permit.permitID, input.requestID)
  stored.token = permit.permitID
  stored.status = {
    requestID: input.requestID,
    state: "running",
    generation: permit.expectedGeneration,
    detail: `authorized by ${permit.issuer}`,
    observedAt: observedAt(input.now),
  }
  return { ok: true, status: stored.status, reconciled: false }
}

/** Records the controller's reported outcome and releases the fence it engaged. */
export function settleReleaseRequest(input: SettleInput): RequestResult {
  const stored = requests.get(input.requestID)
  if (stored === undefined) return refuse("unknown_request", `Release request ${input.requestID} was never submitted`)
  if (isTerminal(stored.status.state)) {
    if (stored.token === input.token && stored.status.state === input.outcome)
      return { ok: true, status: stored.status, reconciled: true }
    return refuse("already_settled", `Release request ${input.requestID} already settled as ${stored.status.state}`)
  }
  if (stored.status.state !== "running")
    return refuse("no_authority", `Release request ${input.requestID} has no authorized transition to settle`)
  if (stored.token !== input.token)
    return refuse("authority_conflict", `Release request ${input.requestID} was authorized by another permit`)
  if (!input.fence.release(input.token))
    return refuse("fence_unavailable", `Session admission could not be released for release request ${input.requestID}`)

  stored.status = {
    requestID: input.requestID,
    state: input.outcome,
    generation: stored.status.generation,
    detail: input.detail ?? null,
    observedAt: observedAt(input.now),
  }
  return { ok: true, status: stored.status, reconciled: false }
}

// A permit presented against the request that already consumed it never
// re-executes: the recorded outcome is returned as-is. A permit already spent on
// a different request is a replay, and a second permit on a live or decided
// transition is a conflict.
function replayOf(stored: Stored, permit: ControllerPermit): RequestResult | undefined {
  const owner = consumed.get(permit.permitID)
  if (owner !== undefined && owner !== stored.status.requestID)
    return refuse("replayed_permit", `Permit ${permit.permitID} was already consumed by ${owner}`)
  if (isTerminal(stored.status.state)) {
    if (stored.token === permit.permitID) return { ok: true, status: stored.status, reconciled: true }
    return refuse(
      "already_settled",
      `Release request ${stored.status.requestID} already settled as ${stored.status.state}`,
    )
  }
  if (stored.status.state === "running") {
    if (stored.token === permit.permitID) return { ok: true, status: stored.status, reconciled: true }
    return refuse(
      "authority_conflict",
      `Release request ${stored.status.requestID} is already running under another permit`,
    )
  }
  if (owner !== undefined) return refuse("replayed_permit", `Permit ${permit.permitID} was already consumed`)
  return undefined
}

function isTerminal(state: ReleaseRequestStatus["state"]): boolean {
  return state === "completed" || state === "failed" || state === "rejected"
}

// A malformed key or a signature over the wrong curve throws rather than
// returning false, and an unverifiable permit must never authorize anything.
function verifyPermit(permit: ControllerPermit, key: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(releasePermitPayload(permit), "utf8"),
      createPublicKey(key),
      Buffer.from(permit.signature, "hex"),
    )
  } catch {
    return false
  }
}

function validityWindow(permit: ControllerPermit): { readonly from: number; readonly until: number } | undefined {
  const from = Date.parse(permit.issuedAt)
  const until = Date.parse(permit.expiresAt)
  if (Number.isNaN(from) || Number.isNaN(until) || until <= from) return undefined
  return { from, until }
}

function observedAt(now: number | undefined): string {
  return new Date(now ?? Date.now()).toISOString()
}

function refuse(reason: RefusalReason, message: string): Refusal {
  return { ok: false, reason, message }
}
