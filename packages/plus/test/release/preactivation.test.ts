import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDeterministicArchive,
  createReleaseManifest,
  generateSha256Sums,
  packageTarget,
  serializeInnerMetadata,
  serializeReleaseManifest,
} from "../../script/release.js"
import { verifyRelease } from "../../script/verify-release.js"
import { runAcceptancePass, verifyAcceptanceOffline } from "../../script/acceptance.js"
import { getPolicyDigest, loadCheckPolicy } from "../../script/acceptance/policy.js"
import { computeHarnessDigest } from "../../script/acceptance/harness.js"
import type { ReleaseTarget, ArtifactIdentity, ReleaseIdentity, ReleaseCheckReceipt } from "@opencode/schema/release"

let testDir: string
const repoRoot = join(import.meta.dirname, "../../../..")
const sourceSha = "0123456789abcdef0123456789abcdef01234567"
const recipeDigest = "0".repeat(64)
const toolchainDigest = "1".repeat(64)

function computeSha256(buffer: Uint8Array | Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "preactivation-test-"))
})

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

async function setupFixtureAssets(
  assetDir: string,
  options?: {
    version?: string
    target?: ReleaseTarget
    binaryContent?: Buffer
  },
): Promise<{
  version: string
  target: ReleaseTarget
  archiveName: string
  archiveSha256: string
  binarySha256: string
  manifest: any
}> {
  await mkdir(assetDir, { recursive: true })
  const version = options?.version ?? "1.0.0"
  const target: ReleaseTarget = options?.target ?? "linux-x64"
  const binaryContent =
    options?.binaryContent ?? Buffer.from(`#!/bin/sh\necho "opencodeplus-${version}"\n`)

  const packaged = packageTarget({
    target,
    binaryContent,
    version,
    sourceSha,
    recipeDigest,
    toolchainDigest,
    sourceDateEpoch: 1700000000,
  })

  const archiveName = packaged.artifact.archiveName
  const archivePath = join(assetDir, archiveName)
  await writeFile(archivePath, packaged.archiveBuffer)

  // Copy or create installer
  const installerFile = Bun.file(join(repoRoot, "install.sh"))
  const installerBuffer = (await installerFile.exists())
    ? Buffer.from(await installerFile.arrayBuffer())
    : Buffer.from("#!/bin/sh\necho install\n")
  const installerSha256 = computeSha256(installerBuffer)
  await writeFile(join(assetDir, "install.sh"), installerBuffer, { mode: 0o755 })

  const releaseIdentity: ReleaseIdentity = {
    product: "opencodeplus",
    channel: "plus",
    version,
    sourceSha,
    recipeDigest,
    toolchainDigest,
  }

  const manifest = createReleaseManifest({
    release: releaseIdentity,
    artifacts: [packaged.artifact],
    installerSha256,
  })

  const manifestJson = serializeReleaseManifest(manifest)
  await writeFile(join(assetDir, "release.json"), manifestJson)

  const checksums = generateSha256Sums([
    { filename: archiveName, sha256: packaged.artifact.archiveSha256 },
    { filename: "install.sh", sha256: installerSha256 },
    { filename: "release.json", sha256: computeSha256(Buffer.from(manifestJson)) },
  ])
  await writeFile(join(assetDir, "SHA256SUMS"), checksums)

  return {
    version,
    target,
    archiveName,
    archiveSha256: packaged.artifact.archiveSha256,
    binarySha256: packaged.artifact.binarySha256,
    manifest,
  }
}

describe("verify-release", () => {
  test("accepts genuinely well-formed asset set built by real packaging pipeline", async () => {
    const assetDir = join(testDir, "well-formed-assets")
    await setupFixtureAssets(assetDir)

    const result = await verifyRelease(assetDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.artifactsVerified).toBe(1)
      expect(result.installerVerified).toBe(true)
      expect(result.sumsVerified).toBe(true)
      expect(result.version).toBe("1.0.0")
    }
  })

  test("rejects tampered archive byte with 'archive_hash_mismatch'", async () => {
    const assetDir = join(testDir, "tampered-archive")
    const fixture = await setupFixtureAssets(assetDir)

    // Tamper with one byte of the archive file
    const archivePath = join(assetDir, fixture.archiveName)
    const buffer = Buffer.from(await Bun.file(archivePath).arrayBuffer())
    buffer[buffer.length - 20] ^= 0xff
    await writeFile(archivePath, buffer)

    const result = await verifyRelease(assetDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("archive_hash_mismatch")
    }
  })

  test("rejects tampered binary inside an archive with 'binary_hash_mismatch'", async () => {
    const assetDir = join(testDir, "tampered-binary-in-archive")
    const target: ReleaseTarget = "linux-x64"
    const originalBinary = Buffer.from("#!/bin/sh\necho original\n")
    const tamperedBinary = Buffer.from("#!/bin/sh\necho evil\n")

    // Package inner metadata that expects originalBinary hash
    const innerMetadata = {
      product: "opencodeplus" as const,
      channel: "plus" as const,
      version: "1.0.0",
      target,
      sourceSha,
      recipeDigest,
      toolchainDigest,
      binarySha256: computeSha256(originalBinary),
      binaryBytes: originalBinary.length,
    }

    // Build archive containing the tampered binary instead
    const archiveBuffer = createDeterministicArchive(
      [
        { name: "bin/opencodeplus", content: tamperedBinary, mode: 0o755 },
        { name: "metadata.json", content: serializeInnerMetadata(innerMetadata), mode: 0o644 },
        { name: "LICENSE", content: "MIT\n", mode: 0o644 },
        { name: "NOTICE", content: "Notice\n", mode: 0o644 },
      ],
      { sourceDateEpoch: 1700000000 },
    )

    const archiveName = `opencodeplus-${target}.tar.gz`
    await mkdir(assetDir, { recursive: true })
    await writeFile(join(assetDir, archiveName), archiveBuffer)

    const installerBuffer = Buffer.from("#!/bin/sh\necho install\n")
    const installerSha256 = computeSha256(installerBuffer)
    await writeFile(join(assetDir, "install.sh"), installerBuffer, { mode: 0o755 })

    const artifact: ArtifactIdentity = {
      target,
      archiveName,
      archiveSha256: computeSha256(archiveBuffer),
      binarySha256: innerMetadata.binarySha256, // Manifest expects original binary hash!
      bytes: archiveBuffer.byteLength,
    }

    const manifest = createReleaseManifest({
      release: {
        product: "opencodeplus",
        channel: "plus",
        version: "1.0.0",
        sourceSha,
        recipeDigest,
        toolchainDigest,
      },
      artifacts: [artifact],
      installerSha256,
    })

    const manifestJson = serializeReleaseManifest(manifest)
    await writeFile(join(assetDir, "release.json"), manifestJson)

    const sums = generateSha256Sums([
      { filename: archiveName, sha256: artifact.archiveSha256 },
      { filename: "install.sh", sha256: installerSha256 },
      { filename: "release.json", sha256: computeSha256(Buffer.from(manifestJson)) },
    ])
    await writeFile(join(assetDir, "SHA256SUMS"), sums)

    const result = await verifyRelease(assetDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("binary_hash_mismatch")
    }
  })

  test("rejects SHA256SUMS that covers itself with 'checksums_cover_self'", async () => {
    const assetDir = join(testDir, "self-covering-sums")
    await setupFixtureAssets(assetDir)

    const sumsPath = join(assetDir, "SHA256SUMS")
    const existingSums = await Bun.file(sumsPath).text()
    const selfHash = "0".repeat(64)
    await writeFile(sumsPath, `${existingSums}${selfHash}  SHA256SUMS\n`)

    const result = await verifyRelease(assetDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("checksums_cover_self")
    }
  })

  test("rejects manifest whose identity disagrees with inner metadata with 'inner_metadata_identity_mismatch'", async () => {
    const assetDir = join(testDir, "metadata-identity-mismatch")
    const fixture = await setupFixtureAssets(assetDir)

    // Tamper with release.json version (inner metadata has "1.0.0")
    const modifiedManifest = {
      ...fixture.manifest,
      release: {
        ...fixture.manifest.release,
        version: "2.0.0",
      },
    }
    const modifiedManifestJson = serializeReleaseManifest(modifiedManifest)
    await writeFile(join(assetDir, "release.json"), modifiedManifestJson)

    // Re-generate SHA256SUMS so the file checksums match disk, isolating the metadata identity mismatch
    const installerBuffer = Buffer.from(await Bun.file(join(assetDir, "install.sh")).arrayBuffer())
    const sums = generateSha256Sums([
      { filename: fixture.archiveName, sha256: fixture.archiveSha256 },
      { filename: "install.sh", sha256: computeSha256(installerBuffer) },
      { filename: "release.json", sha256: computeSha256(Buffer.from(modifiedManifestJson)) },
    ])
    await writeFile(join(assetDir, "SHA256SUMS"), sums)

    const result = await verifyRelease(assetDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("inner_metadata_identity_mismatch")
    }
  })

  test("rejects missing asset with 'missing_asset'", async () => {
    const assetDir = join(testDir, "missing-archive-asset")
    const fixture = await setupFixtureAssets(assetDir)

    // Remove the archive file from disk
    await rm(join(assetDir, fixture.archiveName))

    const result = await verifyRelease(assetDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("missing_asset")
    }
  })
})

describe("Offline Acceptance Verifier", () => {
  test("reaches same passing verdict from exported files alone with original build directory deleted", async () => {
    const buildDir = join(testDir, "build-original")
    const exportDir = join(testDir, "export-offline")
    await mkdir(exportDir, { recursive: true })

    const fixture = await setupFixtureAssets(join(buildDir, "assets"))

    const checkReceipt: ReleaseCheckReceipt = {
      id: "plus-typecheck",
      argv: ["bun", "run", "typecheck"],
      cwd: "packages/plus",
      exitCode: 0,
      head: sourceSha,
      dirty: false,
    }

    // Run acceptance pass and write receipt directly into exportDir
    await runAcceptancePass({
      sourceSha,
      release: fixture.manifest.release,
      artifact: fixture.manifest.artifacts[0],
      checks: [checkReceipt],
      outDir: exportDir,
      repoRoot,
    })

    // Copy release assets into exportDir
    await cp(join(buildDir, "assets"), exportDir, { recursive: true })

    // DELETE original build directory completely!
    await rm(buildDir, { recursive: true, force: true })
    expect(await Bun.file(buildDir).exists()).toBe(false)

    // Run offline verification from exportDir alone
    const offlineResult = await verifyAcceptanceOffline({ exportDir })
    expect(offlineResult.ok).toBe(true)
    if (offlineResult.ok) {
      expect(offlineResult.verdict).toBe("pass")
      expect(offlineResult.sourceSha).toBe(sourceSha)
      expect(offlineResult.checksVerified).toBe(1)
      expect(offlineResult.releaseVerified).toBe(true)
    }
  })

  test("offline verifier rejects tampered sourceSha in receipt with 'source_sha_mismatch'", async () => {
    const buildDir = join(testDir, "build-tamper")
    const exportDir = join(testDir, "export-tamper")
    await mkdir(exportDir, { recursive: true })

    const fixture = await setupFixtureAssets(join(buildDir, "assets"))

    const checkReceipt: ReleaseCheckReceipt = {
      id: "plus-typecheck",
      argv: ["bun", "run", "typecheck"],
      cwd: "packages/plus",
      exitCode: 0,
      head: sourceSha,
      dirty: false,
    }

    await runAcceptancePass({
      sourceSha,
      release: fixture.manifest.release,
      artifact: fixture.manifest.artifacts[0],
      checks: [checkReceipt],
      outDir: exportDir,
      repoRoot,
    })

    await cp(join(buildDir, "assets"), exportDir, { recursive: true })
    await rm(buildDir, { recursive: true, force: true })

    // Expecting a different sourceSha
    const wrongSha = "f".repeat(40)
    const result = await verifyAcceptanceOffline({
      exportDir,
      expectedSourceSha: wrongSha,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("source_sha_mismatch")
    }
  })
})
