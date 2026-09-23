import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { ReleaseTarget } from "@opencode/schema/release"
import {
  BINARY_MEMBER_NAME,
  CONTRACT_ARCHIVE_MEMBERS,
  packageRelease,
  packageTarget,
  parseArchive,
  parseSha256Sums,
} from "../../script/release.js"
import {
  BINARY_MODE,
  DEFAULT_FILE_MODE,
  MAX_BINARY_SIZE_BYTES,
  MAX_TEXT_SIZE_BYTES,
} from "../../script/release/archive.js"

const repoRoot = join(import.meta.dirname, "../../../..")

// release/contract.json is the placement policy, release/toolchain.json the
// normalization policy and install.sh the consumer of both. These tests bind
// those declarations to the packaging code the build actually runs; the broader
// policy parse lives next to them in identity.test.ts.
interface ContractJson {
  contractVersion: number
  product: "opencodeplus"
  channel: "plus"
  targets: string[]
  qualifiedTargets: ReleaseTarget[]
  unqualifiedTargets: string[]
  unqualifiedReason: string
  archiveMembers: string[]
  manifestFile: string
  sumsFile: string
  installerFile: string
}

interface VersionJson {
  scheme: string
  version: unknown
  upstreamBeta: unknown
  plusRevision: unknown
  provenance: { state: string; measuredBy: string; note: string }
  fallbackScheme: { scheme: string; note: string }
}

interface ToolchainJson {
  bun: {
    version: string
    executableSha256: string | null
    executablePlatform: string | null
    source: string | null
    measuredBy: string
  }
  builderImage: { ref: string | null; digest: string | null; measuredBy: string }
  fixedBuildPath: string
  locale: string
  timezone: string
  sourceDateEpochFrom: string
  archiveNormalization: {
    order: string
    uid: number
    gid: number
    modes: Record<string, string>
    mtime: string
  }
}

const SOURCE_DATE_EPOCH = 1700000000
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567"
const VERSION = "1.0.0"

async function loadJson<T>(relPath: string): Promise<T> {
  return (await Bun.file(join(repoRoot, relPath)).json()) as T
}

function dummyBinary(target: string): Buffer {
  return Buffer.from(`#!/bin/sh\necho ${target}\n`)
}

function packageDummy(target: ReleaseTarget): { packaged: ReturnType<typeof packageTarget>; binaryContent: Buffer } {
  const binaryContent = dummyBinary(target)
  const packaged = packageTarget({
    target,
    binaryContent,
    version: VERSION,
    sourceSha: SOURCE_SHA,
    recipeDigest: "a".repeat(64),
    toolchainDigest: "b".repeat(64),
    sourceDateEpoch: SOURCE_DATE_EPOCH,
  })
  return { packaged, binaryContent }
}

describe("release placement target policy", () => {
  test("contract builds exactly the qualified targets and never an unqualified one", async () => {
    const contract = await loadJson<ContractJson>("release/contract.json")

    expect(contract.contractVersion).toBe(1)
    expect(contract.product).toBe("opencodeplus")
    expect(contract.channel).toBe("plus")

    const decodeTarget = Schema.decodeUnknownSync(ReleaseTarget)
    const qualified = [...contract.qualifiedTargets].sort()
    expect(qualified).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
    expect(new Set(contract.qualifiedTargets).size).toBe(contract.qualifiedTargets.length)
    for (const target of contract.qualifiedTargets) {
      expect(() => decodeTarget(target)).not.toThrow()
    }

    // Every packaged archive carries a schema-valid ReleaseTarget, so the declared
    // build set may not contain a target the schema refuses.
    expect([...contract.targets].sort()).toEqual(qualified)
    for (const target of contract.unqualifiedTargets) {
      expect(contract.targets).not.toContain(target)
    }
  })

  test("unqualified targets stay outside the literal union with a written reason", async () => {
    const contract = await loadJson<ContractJson>("release/contract.json")
    const decodeTarget = Schema.decodeUnknownSync(ReleaseTarget)

    expect(contract.unqualifiedTargets).toEqual(["win32-x64", "win32-arm64"])
    expect(contract.unqualifiedReason.trim().length).toBeGreaterThan(0)

    for (const target of contract.unqualifiedTargets) {
      expect(() => decodeTarget(target)).toThrow()
      expect(contract.qualifiedTargets).not.toContain(target)
    }
  })
})

describe("archive member placement", () => {
  test("contract, packaging code and installer agree on one member set", async () => {
    const contract = await loadJson<ContractJson>("release/contract.json")
    const installerText = await Bun.file(join(repoRoot, "install.sh")).text()

    expect(contract.archiveMembers).toEqual(["bin/opencodeplus", "metadata.json", "LICENSE", "NOTICE"])
    expect([...CONTRACT_ARCHIVE_MEMBERS]).toEqual(contract.archiveMembers)
    expect(BINARY_MEMBER_NAME).toBe("bin/opencodeplus")

    const whitelist = installerText.match(/allowed_contract_members="([^"]+)"/)
    expect(whitelist).not.toBeNull()
    expect(whitelist![1].trim().split(/\s+/)).toEqual(contract.archiveMembers)
  })

  test("packaged archive places the binary under bin/ and metadata plus licences at the root", () => {
    const { packaged, binaryContent } = packageDummy("linux-x64")
    const entries = parseArchive(packaged.archiveBuffer)

    // Sorted order is part of the placement contract: verify.ts rejects an archive
    // whose members are not strictly ascending.
    expect(entries.map((entry) => entry.name)).toEqual([...CONTRACT_ARCHIVE_MEMBERS].sort())
    expect(
      entries.filter((entry) => entry.name.includes("/")).map((entry) => entry.name),
    ).toEqual([BINARY_MEMBER_NAME])

    for (const entry of entries) {
      expect(entry.uid).toBe(0)
      expect(entry.gid).toBe(0)
      expect(entry.typeflag).toBe("0")
      expect(entry.linkname).toBe("")
      expect(entry.mtime).toBe(SOURCE_DATE_EPOCH)
      const expectedMode = entry.name === BINARY_MEMBER_NAME ? BINARY_MODE : DEFAULT_FILE_MODE
      expect(entry.mode & 0o777).toBe(expectedMode)
    }

    const binary = entries.find((entry) => entry.name === BINARY_MEMBER_NAME)
    expect(binary).toBeDefined()
    expect(binary!.content.equals(binaryContent)).toBe(true)

    const metadata = entries.find((entry) => entry.name === "metadata.json")
    expect(metadata).toBeDefined()
    expect(metadata!.mode & 0o777).toBe(DEFAULT_FILE_MODE)

    const placed = JSON.parse(metadata!.content.toString("utf8")) as Record<string, unknown>
    expect(placed.target).toBe("linux-x64")
    expect(placed.version).toBe(VERSION)
    expect(placed.sourceSha).toBe(SOURCE_SHA)
    expect(placed.binaryBytes).toBe(binaryContent.byteLength)
    expect(placed.binarySha256).toBe(packaged.artifact.binarySha256)

    for (const name of ["LICENSE", "NOTICE"]) {
      const licence = entries.find((entry) => entry.name === name)
      expect(licence).toBeDefined()
      expect(licence!.content.length).toBeGreaterThan(0)
    }

    expect(packaged.artifact.archiveName).toBe("opencodeplus-linux-x64.tar.gz")
    expect(packaged.artifact.bytes).toBe(packaged.archiveBuffer.byteLength)
  })
})

describe("install prefix and layout", () => {
  test("installer extracts the archive into releases/<version> and activates through bin", async () => {
    const installerText = await Bun.file(join(repoRoot, "install.sh")).text()

    expect(installerText).toContain('prefix="${PREFIX:-$HOME/.opencodeplus}"')
    expect(installerText).toContain('release_dir="$prefix/releases/$version"')
    expect(installerText).toContain('bin_dir="$prefix/bin"')
    expect(installerText).toContain('mv "$sandbox" "$release_dir"')
    expect(installerText).toContain('ln -sf "../releases/$version/bin/opencodeplus" "$bin_dir/opencodeplus"')

    // The archive member 'bin/opencodeplus' is therefore placed at
    // $prefix/releases/<version>/bin/opencodeplus and reachable as $prefix/bin/opencodeplus.
    expect(installerText).toContain('compute_sha256 "$sandbox/bin/opencodeplus"')
  })

  test("installer accepts exactly the qualified targets and refuses Windows with the contract reason", async () => {
    const contract = await loadJson<ContractJson>("release/contract.json")
    const installerText = await Bun.file(join(repoRoot, "install.sh")).text()

    expect(installerText).toContain('target="$os-$arch"')
    expect(installerText).toContain(`${contract.qualifiedTargets.join("|")})`)
    expect(installerText).toContain(contract.unqualifiedReason)
  })

  test("installer size bounds match the archive safety bounds", async () => {
    const installerText = await Bun.file(join(repoRoot, "install.sh")).text()

    expect(installerText).toContain(`max_binary_bytes=${MAX_BINARY_SIZE_BYTES}`)
    expect(installerText).toContain(`max_text_bytes=${MAX_TEXT_SIZE_BYTES}`)
  })
})

describe("release bundle placement", () => {
  let bundleDir = ""

  beforeEach(async () => {
    bundleDir = await mkdtemp(join(tmpdir(), "placement-bundle-"))
  })

  afterEach(async () => {
    await rm(bundleDir, { recursive: true, force: true })
  })

  test("bundle places one archive per qualified target beside manifest, sums and installer", async () => {
    const contract = await loadJson<ContractJson>("release/contract.json")

    const binaries = new Map<ReleaseTarget, Buffer>(
      contract.qualifiedTargets.map((target) => [target, dummyBinary(target)] as const),
    )

    const { manifest } = await packageRelease({
      version: VERSION,
      sourceSha: SOURCE_SHA,
      binaries,
      outDir: bundleDir,
      repoRoot,
      installerPath: join(repoRoot, "install.sh"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    })

    const archiveNames = contract.qualifiedTargets.map((target) => `opencodeplus-${target}.tar.gz`)
    expect((await readdir(bundleDir)).sort()).toEqual(
      [...archiveNames, contract.installerFile, contract.manifestFile, contract.sumsFile].sort(),
    )

    expect(manifest.contractVersion).toBe(1)
    expect(manifest.release.product).toBe(contract.product)
    expect(manifest.release.channel).toBe(contract.channel)
    expect(manifest.artifacts.map((artifact) => artifact.target)).toEqual(contract.qualifiedTargets.slice().sort())
    expect(manifest.unqualifiedTargets).toEqual(contract.unqualifiedTargets)
    for (const artifact of manifest.artifacts) {
      expect(artifact.archiveName).toBe(`opencodeplus-${artifact.target}.tar.gz`)
    }

    const sums = parseSha256Sums(await Bun.file(join(bundleDir, contract.sumsFile)).text())
    expect([...sums.keys()].sort()).toEqual([...archiveNames, contract.installerFile, contract.manifestFile].sort())
    expect(sums.has(contract.sumsFile)).toBe(false)
    expect(await Bun.file(join(bundleDir, contract.manifestFile)).exists()).toBe(true)
    expect(await Bun.file(join(bundleDir, contract.installerFile)).exists()).toBe(true)
  })
})

describe("unmeasured placement facts stay null", () => {
  test("version association remains null until the build seat measures it", async () => {
    const version = await loadJson<VersionJson>("release/version.json")

    expect(version.scheme).toBe("beta-revision")
    expect(version.version).toBeNull()
    expect(version.upstreamBeta).toBeNull()
    expect(version.plusRevision).toBeNull()
    expect(version.provenance.state).toBe("unmeasured")
    expect(version.provenance.measuredBy.length).toBeGreaterThan(0)
    expect(version.fallbackScheme.scheme).toBe("commit-labelled")
  })

  test("toolchain pins measured facts and leaves the unmeasured builder image null", async () => {
    const toolchain = await loadJson<ToolchainJson>("release/toolchain.json")

    expect(toolchain.bun.version).toBe("1.4.2")
    // A Bun executable hash is platform-specific, so it may only be recorded
    // together with the platform it was measured on.
    expect(toolchain.bun.executableSha256 === null).toBe(toolchain.bun.executablePlatform === null)
    if (toolchain.bun.executableSha256 !== null) {
      expect(toolchain.bun.executableSha256).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(toolchain.bun.source).toBeNull()
    expect(toolchain.bun.measuredBy.length).toBeGreaterThan(0)

    // No Docker daemon is reachable from the build seat, so the builder image
    // digest is genuinely unmeasured and must not be invented.
    expect(toolchain.builderImage.ref).toBeNull()
    expect(toolchain.builderImage.digest).toBeNull()
    expect(toolchain.builderImage.measuredBy.length).toBeGreaterThan(0)

    expect(toolchain.fixedBuildPath).toBe("/build/opencodeplus")
    expect(toolchain.locale).toBe("C.UTF-8")
    expect(toolchain.timezone).toBe("UTC")
    expect(toolchain.sourceDateEpochFrom).toBe("source-commit-timestamp")

    // The normalization policy is the one packaging applies to archive members.
    expect(toolchain.archiveNormalization.order).toBe("sorted")
    expect(toolchain.archiveNormalization.uid).toBe(0)
    expect(toolchain.archiveNormalization.gid).toBe(0)
    expect(toolchain.archiveNormalization.modes[BINARY_MEMBER_NAME]).toBe(`0${BINARY_MODE.toString(8)}`)
    expect(toolchain.archiveNormalization.modes.default).toBe(`0${DEFAULT_FILE_MODE.toString(8)}`)
    expect(toolchain.archiveNormalization.mtime).toBe("SOURCE_DATE_EPOCH")
  })

  test("placed metadata carries only measured digests and byte counts", () => {
    const { packaged, binaryContent } = packageDummy("darwin-arm64")
    const entries = parseArchive(packaged.archiveBuffer)
    const metadata = entries.find((entry) => entry.name === "metadata.json")
    expect(metadata).toBeDefined()

    const placed = JSON.parse(metadata!.content.toString("utf8")) as Record<string, unknown>
    expect(placed.binaryBytes).toBe(binaryContent.byteLength)
    expect(placed.binarySha256).toBe(packaged.artifact.binarySha256)
    expect(placed.binarySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.values(placed).filter((value) => value === null)).toEqual([])
  })
})