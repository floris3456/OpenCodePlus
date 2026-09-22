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
