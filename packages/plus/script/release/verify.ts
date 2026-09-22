import { join } from "node:path"
import {
  Release,
  type ReleaseManifest,
  type ArtifactIdentity,
} from "../../src/release/identity.js"
import {
  parseArchive,
  validateArchiveSafety,
  CONTRACT_ARCHIVE_MEMBERS,
  BINARY_MEMBER_NAME,
  BINARY_MODE,
  DEFAULT_FILE_MODE,
} from "./archive.js"
import { parseSha256Sums, type InnerReleaseMetadata } from "./manifest.js"

export class VerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VerificationError"
  }
}

export interface VerificationReport {
  readonly ok: true
  readonly version: string
  readonly artifactsVerified: number
  readonly installerVerified: boolean
  readonly sumsVerified: boolean
}

function computeBufferSha256(buffer: Uint8Array | Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
}

export async function verifyReleaseDirectory(assetDir: string): Promise<VerificationReport> {
  const manifestPath = join(assetDir, "release.json")
  const manifestFile = Bun.file(manifestPath)
  if (!(await manifestFile.exists())) {
    throw new VerificationError(`Release manifest not found at ${manifestPath}`)
  }

  const manifestText = await manifestFile.text()
  let manifest: ReleaseManifest
  try {
    manifest = Release.decodeManifest(manifestText)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new VerificationError(`Failed to decode release.json: ${detail}`)
  }

  if (manifest.contractVersion !== 1) {
    throw new VerificationError(`Unsupported contractVersion: ${manifest.contractVersion}`)
  }

  // 1. Verify installer
  const installerPath = join(assetDir, "install.sh")
  const installerFile = Bun.file(installerPath)
  if (!(await installerFile.exists())) {
    throw new VerificationError(`Installer script not found at ${installerPath}`)
  }
  const installerBuffer = Buffer.from(await installerFile.arrayBuffer())
  const installerSha = computeBufferSha256(installerBuffer)
  if (installerSha !== manifest.installerSha256) {
    throw new VerificationError(
      `Installer SHA-256 mismatch: manifest expects ${manifest.installerSha256}, computed ${installerSha}`,
    )
  }

  // 2. Verify SHA256SUMS if present
  let sumsVerified = false
  const sumsPath = join(assetDir, "SHA256SUMS")
  const sumsFile = Bun.file(sumsPath)
  if (await sumsFile.exists()) {
    const sumsText = await sumsFile.text()
    if (sumsText.includes("SHA256SUMS")) {
      throw new VerificationError("SHA256SUMS must not list itself")
    }
    const sumsMap = parseSha256Sums(sumsText)

    for (const [filename, expectedHash] of sumsMap) {
      const filePath = join(assetDir, filename)
      const file = Bun.file(filePath)
      if (!(await file.exists())) {
        throw new VerificationError(`File '${filename}' in SHA256SUMS not found on disk`)
      }
      const buffer = Buffer.from(await file.arrayBuffer())
      const actualHash = computeBufferSha256(buffer)
      if (actualHash !== expectedHash) {
        throw new VerificationError(
          `SHA256SUMS mismatch for '${filename}': expected ${expectedHash}, computed ${actualHash}`,
        )
      }
    }
    sumsVerified = true
  }

  // 3. Verify each artifact
  let artifactsVerified = 0
  for (const artifact of manifest.artifacts) {
    await verifyArtifact(assetDir, artifact, manifest)
    artifactsVerified += 1
  }

  return {
    ok: true,
    version: manifest.release.version,
    artifactsVerified,
    installerVerified: true,
    sumsVerified,
  }
}

async function verifyArtifact(
  assetDir: string,
  artifact: ArtifactIdentity,
  manifest: ReleaseManifest,
): Promise<void> {
  const archivePath = join(assetDir, artifact.archiveName)
  const archiveFile = Bun.file(archivePath)
  if (!(await archiveFile.exists())) {
    throw new VerificationError(`Archive '${artifact.archiveName}' not found in ${assetDir}`)
  }

  const archiveArrayBuffer = await archiveFile.arrayBuffer()
  const archiveBuffer = Buffer.from(archiveArrayBuffer)

  // Verify byte length
  if (archiveBuffer.length !== artifact.bytes) {
    throw new VerificationError(
      `Byte size mismatch for '${artifact.archiveName}': expected ${artifact.bytes}, got ${archiveBuffer.length}`,
    )
  }

  // Verify archive SHA-256
  const computedArchiveSha = computeBufferSha256(archiveBuffer)
  if (computedArchiveSha !== artifact.archiveSha256) {
    throw new VerificationError(
      `Archive SHA-256 mismatch for '${artifact.archiveName}': expected ${artifact.archiveSha256}, got ${computedArchiveSha}`,
    )
  }

  // Parse archive and verify safety + contract members
  let entries
  try {
    entries = parseArchive(archiveBuffer)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new VerificationError(`Failed to parse archive '${artifact.archiveName}': ${detail}`)
  }

  try {
    validateArchiveSafety(entries, { whitelist: CONTRACT_ARCHIVE_MEMBERS })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new VerificationError(`Archive safety check failed for '${artifact.archiveName}': ${detail}`)
  }

  // Verify member ordering is sorted
  for (let i = 0; i < entries.length - 1; i += 1) {
    const current = entries[i].name
    const next = entries[i + 1].name
    if (current >= next) {
      throw new VerificationError(
        `Archive '${artifact.archiveName}' members are not in sorted order: '${current}' before '${next}'`,
      )
    }
  }

  // Verify permissions, uid, gid
  for (const entry of entries) {
    if (entry.uid !== 0 || entry.gid !== 0) {
      throw new VerificationError(
        `Archive member '${entry.name}' has non-zero ownership: uid=${entry.uid}, gid=${entry.gid}`,
      )
    }

    const expectedMode = entry.name === BINARY_MEMBER_NAME ? BINARY_MODE : DEFAULT_FILE_MODE
    if ((entry.mode & 0o777) !== expectedMode) {
      throw new VerificationError(
        `Archive member '${entry.name}' mode mismatch: expected ${expectedMode.toString(8)}, got ${(entry.mode & 0o777).toString(8)}`,
      )
    }
  }

  // Verify binary hash
  const binaryEntry = entries.find((e) => e.name === BINARY_MEMBER_NAME)
  if (!binaryEntry) {
    throw new VerificationError(`Missing binary member '${BINARY_MEMBER_NAME}' in '${artifact.archiveName}'`)
  }
  const computedBinarySha = computeBufferSha256(binaryEntry.content)
  if (computedBinarySha !== artifact.binarySha256) {
    throw new VerificationError(
      `Binary SHA-256 mismatch in '${artifact.archiveName}': expected ${artifact.binarySha256}, computed ${computedBinarySha}`,
    )
  }

  // Verify metadata layering and exclusions
  const metadataEntry = entries.find((e) => e.name === "metadata.json")
  if (!metadataEntry) {
    throw new VerificationError(`Missing metadata.json in '${artifact.archiveName}'`)
  }

  let metadataObj: Record<string, unknown>
  try {
    metadataObj = JSON.parse(metadataEntry.content.toString("utf8")) as Record<string, unknown>
  } catch {
    throw new VerificationError(`Invalid JSON in metadata.json in '${artifact.archiveName}'`)
  }

  // Inner metadata MUST exclude its own hash
  if ("metadataSha256" in metadataObj || "metadataHash" in metadataObj || "sha256" in metadataObj) {
    throw new VerificationError(
      `Inner metadata in '${artifact.archiveName}' must exclude its own hash`,
    )
  }

  // Inner metadata MUST exclude any build-job timestamps
  const forbiddenTimeKeys = ["builtAt", "timestamp", "now", "buildTime", "buildTimestamp", "date"]
  for (const key of forbiddenTimeKeys) {
    if (key in metadataObj) {
      throw new VerificationError(
        `Inner metadata in '${artifact.archiveName}' contains forbidden build-job timestamp key '${key}'`,
      )
    }
  }

  // Inner metadata fields must match release identity & artifact
  if (metadataObj.binarySha256 !== artifact.binarySha256) {
    throw new VerificationError(
      `metadata.json binarySha256 mismatch in '${artifact.archiveName}': expected ${artifact.binarySha256}, got ${metadataObj.binarySha256}`,
    )
  }
  if (metadataObj.target !== artifact.target) {
    throw new VerificationError(
      `metadata.json target mismatch in '${artifact.archiveName}': expected ${artifact.target}, got ${metadataObj.target}`,
    )
  }
  if (metadataObj.version !== manifest.release.version) {
    throw new VerificationError(
      `metadata.json version mismatch in '${artifact.archiveName}': expected ${manifest.release.version}, got ${metadataObj.version}`,
    )
  }
  if (metadataObj.recipeDigest !== manifest.release.recipeDigest) {
    throw new VerificationError(
      `metadata.json recipeDigest mismatch in '${artifact.archiveName}': expected ${manifest.release.recipeDigest}, got ${metadataObj.recipeDigest}`,
    )
  }
  if (metadataObj.toolchainDigest !== manifest.release.toolchainDigest) {
    throw new VerificationError(
      `metadata.json toolchainDigest mismatch in '${artifact.archiveName}': expected ${manifest.release.toolchainDigest}, got ${metadataObj.toolchainDigest}`,
    )
  }
}
