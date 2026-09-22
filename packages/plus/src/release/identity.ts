import { Schema } from "effect"
import {
  ReleaseTarget,
  ReleaseIdentity,
  ArtifactIdentity,
  ReleaseManifest,
  ReleaseBuildRequest,
  ReleasePromotionRequest,
  ReleaseRequest,
  ReleaseRequestStatus,
  ReleaseHostIdentity,
  ReleaseCheckReceipt,
  ReleaseAcceptanceReceipt,
} from "@opencode/schema/release"

export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") {
    return "null"
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === undefined || typeof item === "symbol" || typeof item === "function") {
        return "null"
      }
      return canonicalJson(item)
    })
    return `[${items.join(",")}]`
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const entries: string[] = []
    for (const key of keys) {
      const val = record[key]
      if (val !== undefined && typeof val !== "function" && typeof val !== "symbol") {
        entries.push(`${JSON.stringify(key)}:${canonicalJson(val)}`)
      }
    }
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

export function digest(value: unknown): string {
  const serialized = canonicalJson(value)
  return new Bun.CryptoHasher("sha256").update(serialized).digest("hex")
}

export function computeRecipeDigest(inputs: unknown): string {
  return digest(inputs)
}

export function computeToolchainDigest(toolchain: unknown): string {
  return digest(toolchain)
}

export function identityMatches(a: ReleaseIdentity, b: ReleaseIdentity): boolean {
  if (a.product !== b.product) return false
  if (a.channel !== b.channel) return false
  if (a.version !== b.version) return false
  if (a.sourceSha !== b.sourceSha) return false
  if (a.recipeDigest !== b.recipeDigest) return false
  if (a.toolchainDigest !== b.toolchainDigest) return false
  return true
}

export function artifactMatches(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  if (a.target !== b.target) return false
  if (a.archiveName !== b.archiveName) return false
  if (a.archiveSha256 !== b.archiveSha256) return false
  if (a.binarySha256 !== b.binarySha256) return false
  if (a.bytes !== b.bytes) return false
  return true
}

const decodeManifestSchema = Schema.decodeUnknownSync(Schema.fromJsonString(ReleaseManifest))
const encodeManifestSchema = Schema.encodeUnknownSync(ReleaseManifest)

export function decodeManifest(text: string): ReleaseManifest {
  return decodeManifestSchema(text)
}

export function encodeManifest(manifest: ReleaseManifest): string {
  const encoded = encodeManifestSchema(manifest)
  return canonicalJson(encoded)
}

export const Release = {
  canonicalJson,
  digest,
  computeRecipeDigest,
  computeToolchainDigest,
  identityMatches,
  artifactMatches,
  decodeManifest,
  encodeManifest,
}

export namespace Release {
  export type Target = ReleaseTarget
  export type Identity = ReleaseIdentity
  export type Artifact = ArtifactIdentity
  export type Manifest = ReleaseManifest
  export type BuildRequest = ReleaseBuildRequest
  export type PromotionRequest = ReleasePromotionRequest
  export type Request = ReleaseRequest
  export type RequestStatus = ReleaseRequestStatus
  export type HostIdentity = ReleaseHostIdentity
  export type CheckReceipt = ReleaseCheckReceipt
  export type AcceptanceReceipt = ReleaseAcceptanceReceipt
}

export {
  ReleaseTarget,
  ReleaseIdentity,
  ArtifactIdentity,
  ReleaseManifest,
  ReleaseBuildRequest,
  ReleasePromotionRequest,
  ReleaseRequest,
  ReleaseRequestStatus,
  ReleaseHostIdentity,
  ReleaseCheckReceipt,
  ReleaseAcceptanceReceipt,
}
