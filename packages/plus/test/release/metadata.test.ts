import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  packageRelease,
  packageTarget,
  verifyReleaseDirectory,
  VerificationError,
  createInnerMetadata,
  serializeInnerMetadata,
  generateSha256Sums,
  parseSha256Sums,
} from "../../script/release.js"
import { Release, type ReleaseTarget } from "../../src/release/identity.js"
import { parseArchive, createDeterministicArchive } from "../../script/release/archive.js"

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "metadata-test-"))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe("metadata layering and exclusions", () => {
  test("inner metadata hashes binary, excludes its own hash, and excludes build-job timestamps", () => {
    const meta = createInnerMetadata({
      target: "linux-x64",
      version: "1.2.3",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      recipeDigest: "a".repeat(64),
      toolchainDigest: "b".repeat(64),
      binarySha256: "c".repeat(64),
      binaryBytes: 1024,
    })

    const serialized = serializeInnerMetadata(meta)
    const parsed = JSON.parse(serialized) as Record<string, unknown>

    // Must hash the binary
    expect(parsed.binarySha256).toBe("c".repeat(64))
    expect(parsed.binaryBytes).toBe(1024)

    // Must exclude its own hash
    expect(parsed.metadataSha256).toBeUndefined()
    expect(parsed.metadataHash).toBeUndefined()
    expect(parsed.sha256).toBeUndefined()

    // Must exclude any build-job timestamps
    expect(parsed.builtAt).toBeUndefined()
    expect(parsed.timestamp).toBeUndefined()
    expect(parsed.now).toBeUndefined()
    expect(parsed.buildTime).toBeUndefined()
    expect(parsed.date).toBeUndefined()
  })

  test("outer release.json hashes archives and installer, while inner metadata hashes binary", async () => {
    const dummyBinary = Buffer.from("dummy-binary-linux-x64\n")
    const installerContent = Buffer.from("#!/usr/bin/env bash\necho install\n")
    const installerPath = join(testDir, "src-install.sh")
    await writeFile(installerPath, installerContent)

    const binaries = new Map<ReleaseTarget, Buffer>([["linux-x64", dummyBinary]])
    const outDir = join(testDir, "out")

    const result = await packageRelease({
      version: "1.0.0",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      binaries,
      outDir,
      installerPath,
      sourceDateEpoch: 1700000000,
    })

    // Outer manifest hashes archives and installer
    expect(result.manifest.contractVersion).toBe(1)
    expect(result.manifest.release.version).toBe("1.0.0")
    expect(result.manifest.artifacts.length).toBe(1)

    const artifact = result.manifest.artifacts[0]
    expect(artifact.target).toBe("linux-x64")
    expect(artifact.archiveName).toBe("opencodeplus-linux-x64.tar.gz")

    // Outer manifest records archiveSha256 and binarySha256
    const expectedBinarySha = new Bun.CryptoHasher("sha256").update(dummyBinary).digest("hex")
    expect(artifact.binarySha256).toBe(expectedBinarySha)

    const archiveFile = Bun.file(join(outDir, artifact.archiveName))
    const archiveBuffer = Buffer.from(await archiveFile.arrayBuffer())
    const expectedArchiveSha = new Bun.CryptoHasher("sha256").update(archiveBuffer).digest("hex")
    expect(artifact.archiveSha256).toBe(expectedArchiveSha)

    // Inner metadata inside archive
    const entries = parseArchive(archiveBuffer)
    const metaEntry = entries.find((e) => e.name === "metadata.json")
    expect(metaEntry).toBeDefined()

    const innerMeta = JSON.parse(metaEntry!.content.toString("utf8")) as Record<string, unknown>
    expect(innerMeta.binarySha256).toBe(expectedBinarySha)
    expect(innerMeta.target).toBe("linux-x64")
    expect(innerMeta.metadataSha256).toBeUndefined()
    expect(innerMeta.builtAt).toBeUndefined()
  })
})

describe("SHA256SUMS exclusion", () => {
  test("excludes itself from checksum list", () => {
    const entries = [
      { filename: "opencodeplus-linux-x64.tar.gz", sha256: "1".repeat(64) },
      { filename: "release.json", sha256: "2".repeat(64) },
      { filename: "install.sh", sha256: "3".repeat(64) },
      { filename: "SHA256SUMS", sha256: "4".repeat(64) },
      { filename: "./SHA256SUMS", sha256: "5".repeat(64) },
    ]

    const sums = generateSha256Sums(entries)
    expect(sums.includes("SHA256SUMS")).toBe(false)

    const parsed = parseSha256Sums(sums)
    expect(parsed.has("SHA256SUMS")).toBe(false)
    expect(parsed.size).toBe(3)
    expect(parsed.get("opencodeplus-linux-x64.tar.gz")).toBe("1".repeat(64))
  })
})

describe("verification against recomputed hashes", () => {
  test("confirms manifest matches recomputed hashes for built assets", async () => {
    const dummyBinary = Buffer.from("deterministic-binary-content\n")
    const installerContent = Buffer.from("#!/usr/bin/env bash\necho installer\n")
    const installerPath = join(testDir, "install.sh")
    await writeFile(installerPath, installerContent)

    const binaries = new Map<ReleaseTarget, Buffer>([["linux-x64", dummyBinary]])
    const outDir = join(testDir, "release-dist")

    await packageRelease({
      version: "2.0.0",
      sourceSha: "abcdef0123456789abcdef0123456789abcdef01",
      binaries,
      outDir,
      installerPath,
      sourceDateEpoch: 1700000000,
    })

    const report = await verifyReleaseDirectory(outDir)
    expect(report.ok).toBe(true)
    expect(report.version).toBe("2.0.0")
    expect(report.artifactsVerified).toBe(1)
    expect(report.installerVerified).toBe(true)
    expect(report.sumsVerified).toBe(true)
  })

  test("rejects a tampered byte in an archive", async () => {
    const dummyBinary = Buffer.from("real-binary\n")
    const installerPath = join(testDir, "install.sh")
    await writeFile(installerPath, "#!/usr/bin/env bash\n")

    const outDir = join(testDir, "release-tampered")
    await packageRelease({
      version: "2.0.0",
      sourceSha: "abcdef0123456789abcdef0123456789abcdef01",
      binaries: new Map<ReleaseTarget, Buffer>([["linux-x64", dummyBinary]]),
      outDir,
      installerPath,
      sourceDateEpoch: 1700000000,
    })

    // Tamper one byte in the archive
    const archivePath = join(outDir, "opencodeplus-linux-x64.tar.gz")
    const archiveBytes = Buffer.from(await Bun.file(archivePath).arrayBuffer())
    archiveBytes[archiveBytes.length - 1] ^= 0xff
    await writeFile(archivePath, archiveBytes)

    expect(verifyReleaseDirectory(outDir)).rejects.toThrow(VerificationError)
  })

  test("rejects a tampered installer", async () => {
    const dummyBinary = Buffer.from("real-binary\n")
    const installerPath = join(testDir, "install.sh")
    await writeFile(installerPath, "#!/usr/bin/env bash\n")

    const outDir = join(testDir, "release-tampered-installer")
    await packageRelease({
      version: "2.0.0",
      sourceSha: "abcdef0123456789abcdef0123456789abcdef01",
      binaries: new Map<ReleaseTarget, Buffer>([["linux-x64", dummyBinary]]),
      outDir,
      installerPath,
      sourceDateEpoch: 1700000000,
    })

    // Tamper install.sh
    await writeFile(join(outDir, "install.sh"), "#!/usr/bin/env bash\necho evil\n")

    expect(verifyReleaseDirectory(outDir)).rejects.toThrow(VerificationError)
  })
})
