import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import {
  Release,
  type ReleaseTarget,
  type ReleaseIdentity,
  type ArtifactIdentity,
  type ReleaseManifest,
} from "../src/release/identity.js"
import {
  createDeterministicArchive,
  createDeterministicTar,
  createTarHeader,
  compressGzip,
  parseArchive,
  validateArchiveSafety,
  CONTRACT_ARCHIVE_MEMBERS,
  BINARY_MEMBER_NAME,
  type ArchiveMemberInput,
} from "./release/archive.js"
import {
  createInnerMetadata,
  serializeInnerMetadata,
  createReleaseManifest,
  serializeReleaseManifest,
  generateSha256Sums,
  parseSha256Sums,
  type InnerReleaseMetadata,
  type ChecksumEntry,
} from "./release/manifest.js"
import {
  loadRecipeInputs,
  computeRecipeDigest,
  getRecipeDigest,
  type RecipeInputs,
} from "./release/recipe.js"
import {
  verifyReleaseDirectory,
  VerificationError,
  type VerificationReport,
} from "./release/verify.js"

export interface PackageTargetOptions {
  readonly target: ReleaseTarget
  readonly binaryContent: Uint8Array | Buffer
  readonly version: string
  readonly sourceSha: string
  readonly recipeDigest: string
  readonly toolchainDigest: string
  readonly licenseContent?: string | Uint8Array
  readonly noticeContent?: string | Uint8Array
  readonly sourceDateEpoch?: number
}

export interface PackagedArtifact {
  readonly artifact: ArtifactIdentity
  readonly archiveBuffer: Buffer
  readonly innerMetadata: InnerReleaseMetadata
}

function computeSha256(buffer: Uint8Array | Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
}

export function packageTarget(options: PackageTargetOptions): PackagedArtifact {
  const binarySha256 = computeSha256(options.binaryContent)
  const binaryBytes = options.binaryContent.byteLength

  const innerMetadata = createInnerMetadata({
    target: options.target,
    version: options.version,
    sourceSha: options.sourceSha,
    recipeDigest: options.recipeDigest,
    toolchainDigest: options.toolchainDigest,
    binarySha256,
    binaryBytes,
  })

  const metadataJson = serializeInnerMetadata(innerMetadata)

  const licenseContent =
    options.licenseContent ?? "MIT License\n\nCopyright (c) 2026 OpenCode Authors\n"
  const noticeContent =
    options.noticeContent ?? "OpenCode Plus\nCopyright 2026 Anomaly Innovations / OpenCode Team\n"

  const members: ArchiveMemberInput[] = [
    {
      name: "bin/opencodeplus",
      content: options.binaryContent,
      mode: 0o755,
      uid: 0,
      gid: 0,
    },
    {
      name: "metadata.json",
      content: metadataJson,
      mode: 0o644,
      uid: 0,
      gid: 0,
    },
    {
      name: "LICENSE",
      content: licenseContent,
      mode: 0o644,
      uid: 0,
      gid: 0,
    },
    {
      name: "NOTICE",
      content: noticeContent,
      mode: 0o644,
      uid: 0,
      gid: 0,
    },
  ]

  const archiveBuffer = createDeterministicArchive(members, {
    sourceDateEpoch: options.sourceDateEpoch,
  })

  const archiveSha256 = computeSha256(archiveBuffer)
  const archiveName = `opencodeplus-${options.target}.tar.gz`

  const artifact: ArtifactIdentity = {
    target: options.target,
    archiveName,
    archiveSha256,
    binarySha256,
    bytes: archiveBuffer.byteLength,
  }

  return {
    artifact,
    archiveBuffer,
    innerMetadata,
  }
}

export interface PackageReleaseOptions {
  readonly version: string
  readonly sourceSha: string
  readonly binaries: ReadonlyMap<ReleaseTarget, Uint8Array | Buffer>
  readonly outDir: string
  readonly repoRoot?: string
  readonly installerPath?: string
  readonly licensePath?: string
  readonly noticePath?: string
  readonly sourceDateEpoch?: number
  readonly generatedAt?: string
}

export async function packageRelease(options: PackageReleaseOptions): Promise<{
  readonly manifest: ReleaseManifest
  readonly checksums: string
}> {
  const repoRoot = options.repoRoot ?? join(import.meta.dirname, "../../..")
  await mkdir(options.outDir, { recursive: true })

  // 1. Toolchain & recipe digests
  const toolchainFile = Bun.file(join(repoRoot, "release/toolchain.json"))
  const toolchain: unknown = (await toolchainFile.exists()) ? await toolchainFile.json() : {}
  const toolchainDigest = Release.computeToolchainDigest(toolchain)

  const recipeInputs = await loadRecipeInputs({
    repoRoot,
    version: options.version,
  })
  const recipeDigest = computeRecipeDigest(recipeInputs)

  // 2. Read License & Notice
  let licenseContent: string | undefined
  const licPath = options.licensePath ?? join(repoRoot, "LICENSE")
  const licFile = Bun.file(licPath)
  if (await licFile.exists()) {
    licenseContent = await licFile.text()
  }

  let noticeContent: string | undefined
  const notPath = options.noticePath ?? join(repoRoot, "NOTICE")
  const notFile = Bun.file(notPath)
  if (await notFile.exists()) {
    noticeContent = await notFile.text()
  }

  // 3. Package each target
  const artifacts: ArtifactIdentity[] = []
  const checksumEntries: ChecksumEntry[] = []

  for (const [target, binaryContent] of options.binaries) {
    const packaged = packageTarget({
      target,
      binaryContent,
      version: options.version,
      sourceSha: options.sourceSha,
      recipeDigest,
      toolchainDigest,
      licenseContent,
      noticeContent,
      sourceDateEpoch: options.sourceDateEpoch,
    })

    const archiveFilePath = join(options.outDir, packaged.artifact.archiveName)
    await writeFile(archiveFilePath, packaged.archiveBuffer)

    artifacts.push(packaged.artifact)
    checksumEntries.push({
      filename: packaged.artifact.archiveName,
      sha256: packaged.artifact.archiveSha256,
    })
  }

  // 4. Installer
  const installerSrc = options.installerPath ?? join(repoRoot, "install.sh")
  const installerFile = Bun.file(installerSrc)
  let installerSha256 = ""
  if (await installerFile.exists()) {
    const installerBuffer = Buffer.from(await installerFile.arrayBuffer())
    installerSha256 = computeSha256(installerBuffer)
    const installerDest = join(options.outDir, "install.sh")
    await writeFile(installerDest, installerBuffer, { mode: 0o755 })
    checksumEntries.push({
      filename: "install.sh",
      sha256: installerSha256,
    })
  } else {
    throw new Error(`Installer file not found at ${installerSrc}`)
  }

  // 5. Release Manifest
  const releaseIdentity: ReleaseIdentity = {
    product: "opencodeplus",
    channel: "plus",
    version: options.version,
    sourceSha: options.sourceSha,
    recipeDigest,
    toolchainDigest,
  }

  const manifest = createReleaseManifest({
    release: releaseIdentity,
    artifacts,
    unqualifiedTargets: ["win32-x64", "win32-arm64"],
    installerSha256,
    generatedAt: options.generatedAt ?? new Date(0).toISOString(),
  })

  const manifestJson = serializeReleaseManifest(manifest)
  const manifestDest = join(options.outDir, "release.json")
  await writeFile(manifestDest, manifestJson)

  const manifestSha256 = computeSha256(Buffer.from(manifestJson, "utf8"))
  checksumEntries.push({
    filename: "release.json",
    sha256: manifestSha256,
  })

  // 6. SHA256SUMS (excludes itself)
  const checksums = generateSha256Sums(checksumEntries)
  const sumsDest = join(options.outDir, "SHA256SUMS")
  await writeFile(sumsDest, checksums)

  return { manifest, checksums }
}

export {
  createDeterministicArchive,
  createDeterministicTar,
  createTarHeader,
  compressGzip,
  parseArchive,
  validateArchiveSafety,
  CONTRACT_ARCHIVE_MEMBERS,
  BINARY_MEMBER_NAME,
  createInnerMetadata,
  serializeInnerMetadata,
  createReleaseManifest,
  serializeReleaseManifest,
  generateSha256Sums,
  parseSha256Sums,
  loadRecipeInputs,
  computeRecipeDigest,
  getRecipeDigest,
  type RecipeInputs,
  verifyReleaseDirectory,
  VerificationError,
}
