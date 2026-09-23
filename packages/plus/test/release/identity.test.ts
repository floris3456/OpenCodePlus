import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import {
  Release,
  canonicalJson,
  digest,
  computeRecipeDigest,
  computeToolchainDigest,
  identityMatches,
  artifactMatches,
  decodeManifest,
  encodeManifest,
} from "../../src/release/identity.js"
import {
  ReleaseTarget,
  type ReleaseIdentity,
  type ArtifactIdentity,
  type ReleaseManifest,
} from "@opencode/schema/release"

const sampleIdentity: ReleaseIdentity = {
  product: "opencodeplus",
  channel: "plus",
  version: "1.0.0",
  sourceSha: "0123456789abcdef0123456789abcdef01234567",
  recipeDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  toolchainDigest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
}

const sampleArtifact: ArtifactIdentity = {
  target: "linux-x64",
  archiveName: "opencodeplus-linux-x64.tar.gz",
  archiveSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  binarySha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  bytes: 42000,
}

const sampleManifest: ReleaseManifest = {
  contractVersion: 1,
  release: sampleIdentity,
  artifacts: [sampleArtifact],
  unqualifiedTargets: ["win32-x64", "win32-arm64"],
  installerSha256: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  generatedAt: "2026-09-22T00:00:00.000Z",
}

describe("canonicalJson", () => {
  test("is key-order independent and stable", () => {
    const objA = {
      z: 1,
      a: "hello",
      m: {
        y: true,
        b: [3, 2, 1],
        x: null,
      },
    }
    const objB = {
      a: "hello",
      m: {
        x: null,
        b: [3, 2, 1],
        y: true,
      },
      z: 1,
    }

    const jsonA = canonicalJson(objA)
    const jsonB = canonicalJson(objB)
    expect(jsonA).toBe(jsonB)
    expect(Release.canonicalJson(objA)).toBe(jsonA)
    expect(jsonA.endsWith("\n")).toBe(false)
    expect(jsonA).toBe('{"a":"hello","m":{"b":[3,2,1],"x":null,"y":true},"z":1}')
  })

  test("omits undefined properties in objects and normalizes undefined in arrays", () => {
    const withUndef = {
      b: undefined,
      a: 1,
      c: [1, undefined, 3],
    }
    expect(canonicalJson(withUndef)).toBe('{"a":1,"c":[1,null,3]}')
  })
})

describe("digests", () => {
  test("is stable regardless of object key order", () => {
    const a = { first: 1, second: 2 }
    const b = { second: 2, first: 1 }
    expect(digest(a)).toBe(digest(b))
    expect(Release.digest(a)).toBe(digest(a))
  })

  test("changes when any input changes", () => {
    const base = { a: 1, b: "value", c: [1, 2] }
    const initialDigest = digest(base)

    expect(digest({ ...base, a: 2 })).not.toBe(initialDigest)
    expect(digest({ ...base, b: "changed" })).not.toBe(initialDigest)
    expect(digest({ ...base, c: [1, 3] })).not.toBe(initialDigest)
    expect(digest({ ...base, extra: true })).not.toBe(initialDigest)
  })

  test("computes recipe and toolchain digests with 64 hex characters", () => {
    const recipeA = { command: "build", target: "linux-x64" }
    const recipeB = { command: "build", target: "linux-arm64" }
    const recipeDigestA = computeRecipeDigest(recipeA)
    const recipeDigestB = computeRecipeDigest(recipeB)

    expect(recipeDigestA).toMatch(/^[a-f0-9]{64}$/)
    expect(recipeDigestB).toMatch(/^[a-f0-9]{64}$/)
    expect(recipeDigestA).not.toBe(recipeDigestB)

    const toolchainA = { bunVersion: "1.4.2" }
    const toolchainB = { bunVersion: "1.4.3" }
    const toolchainDigestA = computeToolchainDigest(toolchainA)
    const toolchainDigestB = computeToolchainDigest(toolchainB)

    expect(toolchainDigestA).toMatch(/^[a-f0-9]{64}$/)
    expect(toolchainDigestB).toMatch(/^[a-f0-9]{64}$/)
    expect(toolchainDigestA).not.toBe(toolchainDigestB)
  })
})

describe("equality helpers", () => {
  test("identityMatches returns true for matching identities", () => {
    expect(identityMatches(sampleIdentity, { ...sampleIdentity })).toBe(true)
    expect(Release.identityMatches(sampleIdentity, { ...sampleIdentity })).toBe(true)
  })

  test("identityMatches rejects a single changed field", () => {
    expect(identityMatches(sampleIdentity, { ...sampleIdentity, product: "other" as "opencodeplus" })).toBe(false)
    expect(identityMatches(sampleIdentity, { ...sampleIdentity, channel: "other" as "plus" })).toBe(false)
    expect(identityMatches(sampleIdentity, { ...sampleIdentity, version: "2.0.0" })).toBe(false)
    expect(
      identityMatches(sampleIdentity, {
        ...sampleIdentity,
        sourceSha: "ffffffffffffffffffffffffffffffffffffffff",
      }),
    ).toBe(false)
    expect(
      identityMatches(sampleIdentity, {
        ...sampleIdentity,
        recipeDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      }),
    ).toBe(false)
    expect(
      identityMatches(sampleIdentity, {
        ...sampleIdentity,
        toolchainDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      }),
    ).toBe(false)
  })

  test("artifactMatches returns true for matching artifacts", () => {
    expect(artifactMatches(sampleArtifact, { ...sampleArtifact })).toBe(true)
    expect(Release.artifactMatches(sampleArtifact, { ...sampleArtifact })).toBe(true)
  })

  test("artifactMatches rejects a single changed field", () => {
    expect(artifactMatches(sampleArtifact, { ...sampleArtifact, target: "darwin-arm64" })).toBe(false)
    expect(artifactMatches(sampleArtifact, { ...sampleArtifact, archiveName: "other.tar.gz" })).toBe(false)
    expect(
      artifactMatches(sampleArtifact, {
        ...sampleArtifact,
        archiveSha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      }),
    ).toBe(false)
    expect(
      artifactMatches(sampleArtifact, {
        ...sampleArtifact,
        binarySha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      }),
    ).toBe(false)
    expect(artifactMatches(sampleArtifact, { ...sampleArtifact, bytes: 99999 })).toBe(false)
  })
})

describe("manifest decode and encode", () => {
  test("round-trips encode and decode", () => {
    const encoded = encodeManifest(sampleManifest)
    expect(encoded).toBe(canonicalJson(sampleManifest))
    expect(Release.encodeManifest(sampleManifest)).toBe(encoded)

    const decoded = decodeManifest(encoded)
    expect(decoded).toEqual(sampleManifest)
    expect(Release.decodeManifest(encoded)).toEqual(sampleManifest)
  })

  test("manifest decoding rejects a bad hash length", () => {
    const badHash63 = {
      ...sampleManifest,
      installerSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde", // 63 chars
    }
    expect(() => decodeManifest(JSON.stringify(badHash63))).toThrow()

    const badHash65 = {
      ...sampleManifest,
      installerSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0", // 65 chars
    }
    expect(() => decodeManifest(JSON.stringify(badHash65))).toThrow()

    const badSourceSha39 = {
      ...sampleManifest,
      release: {
        ...sampleManifest.release,
        sourceSha: "0123456789abcdef0123456789abcdef0123456", // 39 chars
      },
    }
    expect(() => decodeManifest(JSON.stringify(badSourceSha39))).toThrow()
  })

  test("manifest decoding rejects a bad target", () => {
    const badTarget = {
      ...sampleManifest,
      artifacts: [
        {
          ...sampleArtifact,
          target: "win32-x64",
        },
      ],
    }
    expect(() => decodeManifest(JSON.stringify(badTarget))).toThrow()
  })

  test("manifest decoding rejects a missing field", () => {
    const missingInstaller = { ...sampleManifest } as Record<string, unknown>
    delete missingInstaller.installerSha256
    expect(() => decodeManifest(JSON.stringify(missingInstaller))).toThrow()

    const missingRelease = { ...sampleManifest } as Record<string, unknown>
    delete missingRelease.release
    expect(() => decodeManifest(JSON.stringify(missingRelease))).toThrow()

    const missingArtifacts = { ...sampleManifest } as Record<string, unknown>
    delete missingArtifacts.artifacts
    expect(() => decodeManifest(JSON.stringify(missingArtifacts))).toThrow()

    const missingContractVersion = { ...sampleManifest } as Record<string, unknown>
    delete missingContractVersion.contractVersion
    expect(() => decodeManifest(JSON.stringify(missingContractVersion))).toThrow()
  })
})

describe("release policy and scheme JSON files", () => {
  const rootDir = path.resolve(import.meta.dir, "../../../../")

  test("release/contract.json parses and qualified targets equal ReleaseTarget literal union", async () => {
    const contractPath = path.join(rootDir, "release/contract.json")
    const contract = (await Bun.file(contractPath).json()) as {
      contractVersion: number
      product: string
      channel: string
      targets: string[]
      qualifiedTargets: string[]
      unqualifiedTargets: string[]
      unqualifiedReason: string
      archiveMembers: string[]
      manifestFile: string
      sumsFile: string
      installerFile: string
    }

    expect(contract.contractVersion).toBe(1)
    expect(contract.product).toBe("opencodeplus")
    expect(contract.channel).toBe("plus")

    const expectedQualifiedTargets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
    const sortedTargets = [...contract.qualifiedTargets].sort()
    expect(sortedTargets).toEqual(expectedQualifiedTargets)

    const decodeTarget = Schema.decodeUnknownSync(ReleaseTarget)
    for (const t of contract.qualifiedTargets) {
      expect(() => decodeTarget(t)).not.toThrow()
    }

    expect(contract.unqualifiedTargets).toEqual(["win32-x64", "win32-arm64"])
    expect(typeof contract.unqualifiedReason).toBe("string")
    expect(contract.archiveMembers).toEqual(["bin/opencodeplus", "metadata.json", "LICENSE", "NOTICE"])
    expect(contract.manifestFile).toBe("release.json")
    expect(contract.sumsFile).toBe("SHA256SUMS")
    expect(contract.installerFile).toBe("install.sh")
  })

  test("release/version.json parses and still carries null unmeasured values", async () => {
    const versionPath = path.join(rootDir, "release/version.json")
    const version = (await Bun.file(versionPath).json()) as {
      scheme: string
      version: unknown
      upstreamBeta: unknown
      plusRevision: unknown
      provenance: { state: string; measuredBy: string; note: string }
      fallbackScheme: { scheme: string; note: string }
    }

    expect(version.scheme).toBe("beta-revision")
    expect(version.version).toBeNull()
    expect(version.upstreamBeta).toBeNull()
    expect(version.plusRevision).toBeNull()
    expect(version.provenance.state).toBe("unmeasured")
    expect(version.provenance.measuredBy).toBe("build-seat")
    expect(typeof version.provenance.note).toBe("string")
    expect(version.fallbackScheme.scheme).toBe("commit-labelled")
  })

  test("release/toolchain.json pins the measured Bun hash to its platform and keeps unmeasured external facts null", async () => {
    const toolchainPath = path.join(rootDir, "release/toolchain.json")
    const toolchain = (await Bun.file(toolchainPath).json()) as {
      bun: {
        version: string
        executableSha256: unknown
        executablePlatform: unknown
        source: unknown
        measuredBy: string
      }
      builderImage: { ref: unknown; digest: unknown; measuredBy: string }
      fixedBuildPath: string
      locale: string
      timezone: string
      sourceDateEpochFrom: string
      archiveNormalization: {
        order: string
        uid: number
        gid: number
        modes: { "bin/opencodeplus": string; default: string }
        mtime: string
      }
    }

    expect(toolchain.bun.version).toBe("1.4.2")
    // Bun ships a different executable per platform, so this hash is only meaningful
    // alongside the platform it was measured on. builderImage stays null: no Docker
    // daemon is reachable from the build seat, so its digest is genuinely unmeasured.
    expect(toolchain.bun.executableSha256).toBe("616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1")
    expect(toolchain.bun.executablePlatform).toBe("linux-arm64")
    expect(toolchain.bun.source).toBeNull()
    expect(toolchain.bun.measuredBy).toBe("build-seat")
    expect(toolchain.builderImage.ref).toBeNull()
    expect(toolchain.builderImage.digest).toBeNull()
    expect(toolchain.builderImage.measuredBy).toBe("build-seat")
    expect(toolchain.fixedBuildPath).toBe("/build/opencodeplus")
    expect(toolchain.locale).toBe("C.UTF-8")
    expect(toolchain.timezone).toBe("UTC")
    expect(toolchain.sourceDateEpochFrom).toBe("source-commit-timestamp")
    expect(toolchain.archiveNormalization.order).toBe("sorted")
    expect(toolchain.archiveNormalization.uid).toBe(0)
    expect(toolchain.archiveNormalization.gid).toBe(0)
    expect(toolchain.archiveNormalization.modes["bin/opencodeplus"]).toBe("0755")
    expect(toolchain.archiveNormalization.modes.default).toBe("0644")
    expect(toolchain.archiveNormalization.mtime).toBe("SOURCE_DATE_EPOCH")
  })

  test("release/checks.json parses and contains exactly twelve policy checks", async () => {
    const checksPath = path.join(rootDir, "release/checks.json")
    const checksDoc = (await Bun.file(checksPath).json()) as {
      policyVersion: number
      checks: Array<{ id: string; argv: string[]; cwd: string }>
    }

    expect(checksDoc.policyVersion).toBe(1)
    expect(checksDoc.checks.length).toBe(12)

    const ids = checksDoc.checks.map((c) => c.id)
    const expectedIds = [
      "plus-typecheck",
      "soak-regressions",
      "release-unit",
      "release-bindings",
      "service-clients",
      "cli-release",
      "core-contracts",
      "product-roots",
      "release-server",
      "affected-typechecks",
      "generated-client",
      "tui-regressions",
    ]
    expect(ids).toEqual(expectedIds)
  })
})
