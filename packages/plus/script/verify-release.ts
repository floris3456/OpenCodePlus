import { join } from "node:path"
import {
  Release,
  type ReleaseManifest,
  type ArtifactIdentity,
} from "../src/release/identity.js"
import {
  parseArchive,
  validateArchiveSafety,
  CONTRACT_ARCHIVE_MEMBERS,
  BINARY_MEMBER_NAME,
  BINARY_MODE,
  DEFAULT_FILE_MODE,
} from "./release/archive.js"
import { parseSha256Sums } from "./release/manifest.js"

export type ReleaseVerificationRejectionReason =
  | "missing_manifest"
  | "invalid_manifest"
  | "unsupported_contract_version"
  | "missing_installer"
  | "installer_hash_mismatch"
  | "missing_checksums"
  | "checksums_cover_self"
  | "missing_asset"
  | "checksum_hash_mismatch"
  | "archive_byte_size_mismatch"
  | "archive_hash_mismatch"
  | "archive_parse_failed"
  | "archive_safety_violation"
  | "archive_members_not_sorted"
  | "archive_member_ownership_violation"
  | "archive_member_mode_violation"
  | "archive_missing_binary"
  | "binary_hash_mismatch"
  | "archive_missing_metadata"
  | "invalid_inner_metadata"
  | "inner_metadata_contains_own_hash"
  | "inner_metadata_contains_build_timestamp"
  | "inner_metadata_identity_mismatch"
  | "unknown_error"

export interface VerificationSuccess {
  readonly ok: true
  readonly version: string
  readonly manifest: ReleaseManifest
  readonly artifactsVerified: number
  readonly installerVerified: boolean
  readonly sumsVerified: boolean
}

export interface VerificationFailure {
  readonly ok: false
  readonly reason: ReleaseVerificationRejectionReason
  readonly message: string
  readonly detail?: unknown
}

export type VerificationResult = VerificationSuccess | VerificationFailure

export class ReleaseVerificationError extends Error {
  readonly reason: ReleaseVerificationRejectionReason
  readonly detail?: unknown

  constructor(reason: ReleaseVerificationRejectionReason, message: string, detail?: unknown) {
    super(message)
    this.name = "ReleaseVerificationError"
    this.reason = reason
    this.detail = detail
  }
}

function computeBufferSha256(buffer: Uint8Array | Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
}

export async function verifyRelease(assetDir: string): Promise<VerificationResult> {
  const manifestPath = join(assetDir, "release.json")
  const manifestFile = Bun.file(manifestPath)
  if (!(await manifestFile.exists())) {
    return {
      ok: false,
      reason: "missing_manifest",
      message: `Release manifest not found at ${manifestPath}`,
    }
  }

  const manifestText = await manifestFile.text()
  let manifest: ReleaseManifest
  try {
    manifest = Release.decodeManifest(manifestText)
  } catch (err) {
    return {
      ok: false,
      reason: "invalid_manifest",
      message: `Failed to decode release.json: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (manifest.contractVersion !== 1) {
    return {
      ok: false,
      reason: "unsupported_contract_version",
      message: `Unsupported contractVersion: ${manifest.contractVersion}`,
    }
  }

  const installerPath = join(assetDir, "install.sh")
  const installerFile = Bun.file(installerPath)
  if (!(await installerFile.exists())) {
    return {
      ok: false,
      reason: "missing_asset",
      message: `Installer script not found at ${installerPath}`,
    }
  }
  const installerBuffer = Buffer.from(await installerFile.arrayBuffer())
  const installerSha = computeBufferSha256(installerBuffer)
  if (installerSha !== manifest.installerSha256) {
    return {
      ok: false,
      reason: "installer_hash_mismatch",
      message: `Installer SHA-256 mismatch: manifest expects ${manifest.installerSha256}, computed ${installerSha}`,
    }
  }

  let sumsVerified = false
  const sumsPath = join(assetDir, "SHA256SUMS")
  const sumsFile = Bun.file(sumsPath)
  if (await sumsFile.exists()) {
    const sumsText = await sumsFile.text()
    const lines = sumsText.split("\n")
    const listsSelf = lines.some((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) return false
      const parts = trimmed.split(/\s+/)
      const filename = parts[parts.length - 1]
      return filename === "SHA256SUMS" || filename.endsWith("/SHA256SUMS") || filename.endsWith("\\SHA256SUMS")
    })
    if (listsSelf) {
      return {
        ok: false,
        reason: "checksums_cover_self",
        message: "SHA256SUMS must not list itself",
      }
    }

    const sumsMap = parseSha256Sums(sumsText)
    for (const [filename, expectedHash] of sumsMap) {
      const filePath = join(assetDir, filename)
      const file = Bun.file(filePath)
      if (!(await file.exists())) {
        return {
          ok: false,
          reason: "missing_asset",
          message: `File '${filename}' in SHA256SUMS not found on disk`,
        }
      }
      const buffer = Buffer.from(await file.arrayBuffer())
      const actualHash = computeBufferSha256(buffer)
      if (actualHash !== expectedHash) {
        return {
          ok: false,
          reason: filename.endsWith(".tar.gz") ? "archive_hash_mismatch" : "checksum_hash_mismatch",
          message: `SHA256SUMS mismatch for '${filename}': expected ${expectedHash}, computed ${actualHash}`,
        }
      }
    }
    sumsVerified = true
  }

  for (const artifact of manifest.artifacts) {
    const artifactResult = await verifyArtifact(assetDir, artifact, manifest)
    if (!artifactResult.ok) {
      return artifactResult
    }
  }

  return {
    ok: true,
    version: manifest.release.version,
    manifest,
    artifactsVerified: manifest.artifacts.length,
    installerVerified: true,
    sumsVerified,
  }
}

async function verifyArtifact(
  assetDir: string,
  artifact: ArtifactIdentity,
  manifest: ReleaseManifest,
): Promise<VerificationResult> {
  const archivePath = join(assetDir, artifact.archiveName)
  const archiveFile = Bun.file(archivePath)
  if (!(await archiveFile.exists())) {
    return {
      ok: false,
      reason: "missing_asset",
      message: `Archive '${artifact.archiveName}' not found in ${assetDir}`,
    }
  }

  const archiveArrayBuffer = await archiveFile.arrayBuffer()
  const archiveBuffer = Buffer.from(archiveArrayBuffer)

  if (archiveBuffer.length !== artifact.bytes) {
    return {
      ok: false,
      reason: "archive_byte_size_mismatch",
      message: `Byte size mismatch for '${artifact.archiveName}': expected ${artifact.bytes}, got ${archiveBuffer.length}`,
    }
  }

  const computedArchiveSha = computeBufferSha256(archiveBuffer)
  if (computedArchiveSha !== artifact.archiveSha256) {
    return {
      ok: false,
      reason: "archive_hash_mismatch",
      message: `Archive SHA-256 mismatch for '${artifact.archiveName}': expected ${artifact.archiveSha256}, got ${computedArchiveSha}`,
    }
  }

  let entries
  try {
    entries = parseArchive(archiveBuffer)
  } catch (err) {
    return {
      ok: false,
      reason: "archive_parse_failed",
      message: `Failed to parse archive '${artifact.archiveName}': ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  try {
    validateArchiveSafety(entries, { whitelist: CONTRACT_ARCHIVE_MEMBERS })
  } catch (err) {
    return {
      ok: false,
      reason: "archive_safety_violation",
      message: `Archive safety check failed for '${artifact.archiveName}': ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  for (let i = 0; i < entries.length - 1; i += 1) {
    const current = entries[i].name
    const next = entries[i + 1].name
    if (current >= next) {
      return {
        ok: false,
        reason: "archive_members_not_sorted",
        message: `Archive '${artifact.archiveName}' members are not in sorted order: '${current}' before '${next}'`,
      }
    }
  }

  for (const entry of entries) {
    if (entry.uid !== 0 || entry.gid !== 0) {
      return {
        ok: false,
        reason: "archive_member_ownership_violation",
        message: `Archive member '${entry.name}' has non-zero ownership: uid=${entry.uid}, gid=${entry.gid}`,
      }
    }

    const expectedMode = entry.name === BINARY_MEMBER_NAME ? BINARY_MODE : DEFAULT_FILE_MODE
    if ((entry.mode & 0o777) !== expectedMode) {
      return {
        ok: false,
        reason: "archive_member_mode_violation",
        message: `Archive member '${entry.name}' mode mismatch: expected ${expectedMode.toString(8)}, got ${(entry.mode & 0o777).toString(8)}`,
      }
    }
  }

  const binaryEntry = entries.find((e) => e.name === BINARY_MEMBER_NAME)
  if (!binaryEntry) {
    return {
      ok: false,
      reason: "archive_missing_binary",
      message: `Missing binary member '${BINARY_MEMBER_NAME}' in '${artifact.archiveName}'`,
    }
  }
  const computedBinarySha = computeBufferSha256(binaryEntry.content)
  if (computedBinarySha !== artifact.binarySha256) {
    return {
      ok: false,
      reason: "binary_hash_mismatch",
      message: `Binary SHA-256 mismatch in '${artifact.archiveName}': expected ${artifact.binarySha256}, computed ${computedBinarySha}`,
    }
  }

  const metadataEntry = entries.find((e) => e.name === "metadata.json")
  if (!metadataEntry) {
    return {
      ok: false,
      reason: "archive_missing_metadata",
      message: `Missing metadata.json in '${artifact.archiveName}'`,
    }
  }

  let metadataObj: Record<string, unknown>
  try {
    metadataObj = JSON.parse(metadataEntry.content.toString("utf8")) as Record<string, unknown>
  } catch {
    return {
      ok: false,
      reason: "invalid_inner_metadata",
      message: `Invalid JSON in metadata.json in '${artifact.archiveName}'`,
    }
  }

  if ("metadataSha256" in metadataObj || "metadataHash" in metadataObj || "sha256" in metadataObj) {
    return {
      ok: false,
      reason: "inner_metadata_contains_own_hash",
      message: `Inner metadata in '${artifact.archiveName}' must exclude its own hash`,
    }
  }

  const forbiddenTimeKeys = ["builtAt", "timestamp", "now", "buildTime", "buildTimestamp", "date"]
  for (const key of forbiddenTimeKeys) {
    if (key in metadataObj) {
      return {
        ok: false,
        reason: "inner_metadata_contains_build_timestamp",
        message: `Inner metadata in '${artifact.archiveName}' contains forbidden build-job timestamp key '${key}'`,
      }
    }
  }

  if (
    metadataObj.binarySha256 !== artifact.binarySha256 ||
    metadataObj.target !== artifact.target ||
    metadataObj.version !== manifest.release.version ||
    metadataObj.sourceSha !== manifest.release.sourceSha ||
    metadataObj.recipeDigest !== manifest.release.recipeDigest ||
    metadataObj.toolchainDigest !== manifest.release.toolchainDigest ||
    metadataObj.product !== manifest.release.product ||
    metadataObj.channel !== manifest.release.channel
  ) {
    return {
      ok: false,
      reason: "inner_metadata_identity_mismatch",
      message: `metadata.json identity mismatch in '${artifact.archiveName}'`,
    }
  }

  return {
    ok: true,
    version: manifest.release.version,
    manifest,
    artifactsVerified: 1,
    installerVerified: true,
    sumsVerified: true,
  }
}

export async function verifyReleaseOrThrow(assetDir: string): Promise<VerificationSuccess> {
  const result = await verifyRelease(assetDir)
  if (!result.ok) {
    throw new ReleaseVerificationError(result.reason, result.message, result.detail)
  }
  return result
}
