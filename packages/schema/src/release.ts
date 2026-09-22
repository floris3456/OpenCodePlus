export * as Release from "./release.js"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema.js"

const Hex40 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)).annotate({
  identifier: "Release.Hex40",
  description: "40-character lowercase hexadecimal hash",
})

const Hex64 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
  identifier: "Release.Hex64",
  description: "64-character lowercase hexadecimal hash",
})

const Hex128 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/)).annotate({
  identifier: "Release.Hex128",
  description: "128-character lowercase hexadecimal Ed25519 signature",
})

export const ReleaseTarget = Schema.Literals(["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"]).annotate({
  identifier: "Release.Target",
})
export type ReleaseTarget = typeof ReleaseTarget.Type
export const Target = ReleaseTarget
export type Target = ReleaseTarget

export const ReleaseIdentity = Schema.Struct({
  product: Schema.Literal("opencodeplus"),
  channel: Schema.Literal("plus"),
  version: Schema.String,
  sourceSha: Hex40,
  recipeDigest: Hex64,
  toolchainDigest: Hex64,
}).annotate({ identifier: "Release.Identity" })
export interface ReleaseIdentity extends Schema.Schema.Type<typeof ReleaseIdentity> {}
export const Identity = ReleaseIdentity
export type Identity = ReleaseIdentity

export const ArtifactIdentity = Schema.Struct({
  target: ReleaseTarget,
  archiveName: Schema.String,
  archiveSha256: Hex64,
  binarySha256: Hex64,
  bytes: NonNegativeInt,
}).annotate({ identifier: "Release.ArtifactIdentity" })
export interface ArtifactIdentity extends Schema.Schema.Type<typeof ArtifactIdentity> {}
export const Artifact = ArtifactIdentity
export type Artifact = ArtifactIdentity

export const ReleaseManifest = Schema.Struct({
  contractVersion: Schema.Literal(1),
  release: ReleaseIdentity,
  artifacts: Schema.Array(ArtifactIdentity),
  unqualifiedTargets: Schema.Array(Schema.String),
  installerSha256: Hex64,
  generatedAt: Schema.String,
}).annotate({ identifier: "Release.Manifest" })
export interface ReleaseManifest extends Schema.Schema.Type<typeof ReleaseManifest> {}
export const Manifest = ReleaseManifest
export type Manifest = ReleaseManifest

export const ReleaseBuildRequest = Schema.Struct({
  requestID: Schema.String,
  kind: Schema.Literal("build"),
  sourceSha: Hex40,
  version: Schema.String,
  recipeDigest: Hex64,
  approvalRef: Schema.NullOr(Schema.String),
  requestedAt: Schema.String,
}).annotate({ identifier: "Release.BuildRequest" })
export interface ReleaseBuildRequest extends Schema.Schema.Type<typeof ReleaseBuildRequest> {}
export const BuildRequest = ReleaseBuildRequest
export type BuildRequest = ReleaseBuildRequest

export const ReleasePromotionRequest = Schema.Struct({
  requestID: Schema.String,
  kind: Schema.Literal("promote"),
  release: ReleaseIdentity,
  artifact: ArtifactIdentity,
  expectedCurrentGeneration: Schema.Int,
  approvalRef: Schema.NullOr(Schema.String),
  requestedAt: Schema.String,
}).annotate({ identifier: "Release.PromotionRequest" })
export interface ReleasePromotionRequest extends Schema.Schema.Type<typeof ReleasePromotionRequest> {}
export const PromotionRequest = ReleasePromotionRequest
export type PromotionRequest = ReleasePromotionRequest

export const ReleaseRequest = Schema.Union([ReleaseBuildRequest, ReleasePromotionRequest]).annotate({
  discriminator: "kind",
  identifier: "Release.Request",
})
export type ReleaseRequest = typeof ReleaseRequest.Type
export const Request = ReleaseRequest
export type Request = ReleaseRequest

/**
 * One controller decision, signed out of band and presented to a running product.
 * Every fact the authorized transition depends on is inside the signature: the
 * request it authorizes, the exact request body (`requestDigest`), the exact
 * artifact and the generation it replaces. A request therefore cannot widen what
 * it was authorized for after the permit was issued. The product verifies permits
 * against trusted issuer public keys and holds no key that can mint one.
 */
export const ReleaseControllerPermit = Schema.Struct({
  permitID: Schema.String,
  requestID: Schema.String,
  requestDigest: Hex64,
  artifactSha256: Hex64,
  expectedGeneration: Schema.Int,
  issuer: Schema.String,
  issuedAt: Schema.String,
  expiresAt: Schema.String,
  signature: Hex128,
}).annotate({ identifier: "Release.ControllerPermit" })
export interface ReleaseControllerPermit extends Schema.Schema.Type<typeof ReleaseControllerPermit> {}
export const ControllerPermit = ReleaseControllerPermit
export type ControllerPermit = ReleaseControllerPermit

export type ReleasePermitBody = Omit<ReleaseControllerPermit, "signature">
export type PermitBody = ReleasePermitBody

/**
 * The exact bytes a controller signs for one permit. Issuer and verifier read the
 * signed span from here so they cannot drift apart; the signature covers every
 * permit field except itself.
 */
export function releasePermitPayload(body: ReleasePermitBody): string {
  return JSON.stringify([
    body.permitID,
    body.requestID,
    body.requestDigest,
    body.artifactSha256,
    body.expectedGeneration,
    body.issuer,
    body.issuedAt,
    body.expiresAt,
  ])
}

/**
 * The exact bytes a request body is digested from for `ControllerPermit.requestDigest`.
 * Deterministic by construction: object keys sort and absent values are omitted, so a
 * permit issuer and a verifier in another process agree byte for byte. This is part of
 * the wire contract, not a convenience, so it lives with the contract it binds.
 */
export function canonicalReleaseJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") return "null"
  if (Array.isArray(value)) return `[${value.map((item) => canonicalReleaseJson(item)).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .filter((key) => {
        const item = record[key]
        return item !== undefined && typeof item !== "function" && typeof item !== "symbol"
      })
      .map((key) => `${JSON.stringify(key)}:${canonicalReleaseJson(record[key])}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

export const ReleaseRequestState = Schema.Literals(["accepted", "rejected", "running", "completed", "failed"]).annotate({
  identifier: "Release.RequestState",
})
export type ReleaseRequestState = typeof ReleaseRequestState.Type

export const ReleaseRequestStatus = Schema.Struct({
  requestID: Schema.String,
  state: ReleaseRequestState,
  generation: Schema.Int,
  detail: Schema.NullOr(Schema.String),
  observedAt: Schema.String,
}).annotate({ identifier: "Release.RequestStatus" })
export interface ReleaseRequestStatus extends Schema.Schema.Type<typeof ReleaseRequestStatus> {}
export const RequestStatus = ReleaseRequestStatus
export type RequestStatus = ReleaseRequestStatus

export const ReleaseHostIdentity = Schema.Struct({
  generation: Schema.Int,
  releaseVersion: Schema.String,
  executableSha256: Hex64,
  serverEpoch: Schema.String,
  pid: Schema.Int,
  startedAt: Schema.String,
}).annotate({ identifier: "Release.HostIdentity" })
export interface ReleaseHostIdentity extends Schema.Schema.Type<typeof ReleaseHostIdentity> {}
export const HostIdentity = ReleaseHostIdentity
export type HostIdentity = ReleaseHostIdentity

export const ReleaseCheckReceipt = Schema.Struct({
  id: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.Int,
  head: Hex40,
  dirty: Schema.Boolean,
}).annotate({ identifier: "Release.CheckReceipt" })
export interface ReleaseCheckReceipt extends Schema.Schema.Type<typeof ReleaseCheckReceipt> {}
export const CheckReceipt = ReleaseCheckReceipt
export type CheckReceipt = ReleaseCheckReceipt

export const ReleaseVerdict = Schema.Literals(["pass", "fail"]).annotate({
  identifier: "Release.Verdict",
})
export type ReleaseVerdict = typeof ReleaseVerdict.Type

export const ReleaseAcceptanceReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  kind: Schema.String,
  sourceSha: Hex40,
  release: Schema.NullOr(ReleaseIdentity),
  artifact: Schema.NullOr(ArtifactIdentity),
  policyDigest: Hex64,
  harnessDigest: Hex64,
  checks: Schema.Array(ReleaseCheckReceipt),
  verdict: ReleaseVerdict,
  producedAt: Schema.String,
}).annotate({ identifier: "Release.AcceptanceReceipt" })
export interface ReleaseAcceptanceReceipt extends Schema.Schema.Type<typeof ReleaseAcceptanceReceipt> {}
export const AcceptanceReceipt = ReleaseAcceptanceReceipt
export type AcceptanceReceipt = ReleaseAcceptanceReceipt
