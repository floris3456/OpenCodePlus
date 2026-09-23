import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  packageTarget,
  createDeterministicArchive,
  parseArchive,
  computeRecipeDigest,
  type RecipeInputs,
} from "../../script/release.js"
import {
  CANONICALIZER,
  deriveRecordHash,
  parseBuildStructure,
} from "../../script/release/canonicalize.js"
import { verifyRebuildEquivalence } from "../../script/release/verify.js"

describe("release reproducibility and normalisation", () => {
  test("archive determinism is raw byte equality: two packaging runs produce byte-identical archives", () => {
    const binaryContent = Buffer.from("#!/bin/sh\necho reproducible\n")
    const options = {
      target: "linux-x64" as const,
      binaryContent,
      version: "1.0.0",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      recipeDigest: "a".repeat(64),
      toolchainDigest: "b".repeat(64),
      licenseContent: "MIT License\n",
      noticeContent: "Copyright Notice\n",
      sourceDateEpoch: 1700000000,
    }

    const run1 = packageTarget(options)
    const run2 = packageTarget(options)

    expect(run1.artifact.archiveSha256).toBe(run2.artifact.archiveSha256)
    expect(run1.artifact.bytes).toBe(run2.artifact.bytes)
    expect(run1.archiveBuffer.equals(run2.archiveBuffer)).toBe(true)
  })

  test("changing any declared recipe input changes the recipe digest", () => {
    const base: RecipeInputs = {
      version: "1.0.0",
      channel: "plus",
      targets: ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"],
      lockfileSha256: "1".repeat(64),
      patchesSha256: "2".repeat(64),
      dependenciesSha256: "3".repeat(64),
      toolchain: { bun: { version: "1.4.2" } },
    }

    const baseDigest = computeRecipeDigest(base)
    expect(baseDigest.length).toBe(64)

    // 1. Changing version
    expect(computeRecipeDigest({ ...base, version: "1.0.1" })).not.toBe(baseDigest)

    // 2. Changing channel
    expect(computeRecipeDigest({ ...base, channel: "other" as "plus" })).not.toBe(baseDigest)

    // 3. Changing targets
    expect(
      computeRecipeDigest({
        ...base,
        targets: ["linux-x64", "darwin-x64"],
      }),
    ).not.toBe(baseDigest)

    // 4. Changing lockfile
    expect(computeRecipeDigest({ ...base, lockfileSha256: "9".repeat(64) })).not.toBe(baseDigest)

    // 5. Changing patches
    expect(computeRecipeDigest({ ...base, patchesSha256: "9".repeat(64) })).not.toBe(baseDigest)

    // 6. Changing dependencies
    expect(computeRecipeDigest({ ...base, dependenciesSha256: "9".repeat(64) })).not.toBe(baseDigest)

    // 7. Changing toolchain
    expect(
      computeRecipeDigest({
        ...base,
        toolchain: { bun: { version: "1.4.3" } },
      }),
    ).not.toBe(baseDigest)
  })

  test("mtime, uid, gid, mode, and member order normalisation holds", () => {
    const epoch = 1712345678
    const members = [
      { name: "metadata.json", content: '{"status":"ok"}\n' },
      { name: "bin/opencodeplus", content: "echo hello\n" },
      { name: "NOTICE", content: "Notice\n" },
      { name: "LICENSE", content: "License\n" },
    ]

    const archive = createDeterministicArchive(members, { sourceDateEpoch: epoch })
    const entries = parseArchive(archive)

    // Check sorted member order: LICENSE, NOTICE, bin/opencodeplus, metadata.json
    expect(entries.map((e) => e.name)).toEqual([
      "LICENSE",
      "NOTICE",
      "bin/opencodeplus",
      "metadata.json",
    ])

    // Check normalisation for each entry
    for (const entry of entries) {
      // Ownership normalisation: uid = 0, gid = 0
      expect(entry.uid).toBe(0)
      expect(entry.gid).toBe(0)

      // Timestamp normalisation: mtime = SOURCE_DATE_EPOCH
      expect(entry.mtime).toBe(epoch)

      // Regular file type
      expect(entry.typeflag).toBe("0")
      expect(entry.linkname).toBe("")

      // Mode normalisation: 0755 for binary, 0644 for others
      if (entry.name === "bin/opencodeplus") {
        expect(entry.mode & 0o777).toBe(0o755)
      } else {
        expect(entry.mode & 0o777).toBe(0o644)
      }
    }
  })
})

// `bun build --compile` is measurably NOT byte-reproducible for this product
// graph: the bundler draws a random unique key per build and stamps it, plus a
// hash derived from it, into the shared bytecode string table of the standalone
// payload. The binary half of the reproducibility gate is therefore equivalence
// under the named canonicalizer in script/release/canonicalize.ts, which only
// accepts records it can derive from a parsed ELF/Mach-O Bun payload. That is
// strictly weaker than the raw byte equality the archive half achieves, and
// these tests state that plainly.
describe("compiled binary reproducibility is rebuild equivalence, weaker than raw byte equality", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ocp-reproducibility-"))
  const SOURCE_DIR = join(scratch, "src")
  const OUT_ONE = join(scratch, "one")
  const OUT_TWO = join(scratch, "two")
  let left: Buffer
  let right: Buffer

  beforeAll(() => {
    mkdirSync(SOURCE_DIR, { recursive: true })
    writeFileSync(join(SOURCE_DIR, "shared.ts"), "export const shared = 42\n")
    writeFileSync(
      join(SOURCE_DIR, "alpha.ts"),
      "import { shared } from './shared.ts'\nexport const alpha = shared + 1\n",
    )
    writeFileSync(
      join(SOURCE_DIR, "beta.ts"),
      "import { shared } from './shared.ts'\nexport const beta = shared + 2\n",
    )
    writeFileSync(
      join(SOURCE_DIR, "entry.ts"),
      "async function main() {\n  const [alpha, beta] = await Promise.all([import('./alpha.ts'), import('./beta.ts')])\n  console.log(alpha.alpha, beta.beta)\n}\nmain()\n",
    )

    // Same output basename in both rebuilds, so the only difference Bun is
    // allowed to introduce is the per-build bundler key.
    left = compile(OUT_ONE)
    right = compile(OUT_TWO)
  }, 120000)

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  function compile(outDir: string): Buffer {
    mkdirSync(outDir, { recursive: true })
    const outfile = join(outDir, "app")
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        join(SOURCE_DIR, "entry.ts"),
        "--compile",
        "--bytecode",
        "--format=esm",
        "--splitting",
        "--outfile",
        outfile,
      ],
      cwd: SOURCE_DIR,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
    if (result.exitCode !== 0) {
      throw new Error(`bun build --compile failed for ${outfile}: ${result.stderr.toString()}`)
    }
    return readFileSync(outfile)
  }

  function sha256(buffer: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
  }

  function legacyFillerBinary(key: string): Buffer {
    const binary = Buffer.alloc(320)
    for (let index = 0; index < binary.length; index += 1) binary[index] = (index * 31 + 7) & 0xff
    ;[64, 192].forEach((offset, position) => {
      const token = `${key}C${String(position).padStart(8, "0")}`
      binary.writeUInt32LE(0x80000019, offset)
      binary.writeUInt32LE(deriveRecordHash(token), offset + 4)
      binary.write(token, offset + 8, 25, "latin1")
      binary.fill(0, offset + 33, offset + 36)
    })
    return binary
  }

  test("equivalent rebuilds are not raw-equal, and the report says so", () => {
    const report = verifyRebuildEquivalence({
      bunVersion: CANONICALIZER.bunVersion,
      left,
      right,
    })

    expect(report.kind).toBe("rebuild-equivalence")
    expect(report.weakerThanRawReproducibility).toBe(true)
    expect(report.canonicalizerId).toBe(CANONICALIZER.id)
    expect(report.canonicalizerBunVersion).toBe("1.4.2")
    expect(report.container).toBe("elf")

    expect(report.equivalent).toBe(true)
    // The weakening, stated explicitly: equivalence does not imply raw equality.
    expect(report.rawIdentical).toBe(false)
    expect(report.leftRawSha256).not.toBe(report.rightRawSha256)
    expect(report.rawDifferingBytes).toBeGreaterThan(0)
    expect(report.recordsRewritten).toBeGreaterThanOrEqual(1)

    // Both raw identities are retained; the canonical one is a third digest
    // that exists only for this comparison.
    expect(report.leftRawSha256).toBe(sha256(left))
    expect(report.rightRawSha256).toBe(sha256(right))
    expect(report.canonicalSha256).not.toBe(report.leftRawSha256)
    expect(report.canonicalSha256).not.toBe(report.rightRawSha256)
  })

  test("the equivalence gate still rejects any byte it cannot derive", () => {
    const parsed = parseBuildStructure({ bunVersion: CANONICALIZER.bunVersion, bytes: left })
    if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.rejection.detail}`)
    const range = parsed.structure.moduleRanges.find((item) => item.end - item.start >= 8)
    if (!range) throw new Error("fixture has no module subrange to tamper with")
    const tamperAt = range.start + 4

    const tampered = Buffer.from(right)
    tampered[tamperAt] = tampered[tamperAt] ^ 0xff

    const report = verifyRebuildEquivalence({
      bunVersion: CANONICALIZER.bunVersion,
      left,
      right: tampered,
    })

    expect(report.equivalent).toBe(false)
    expect(report.rejection?.code).toBe("residual-difference")
    expect(report.rejection?.offset).toBe(tamperAt)
    expect(report.canonicalSha256).toBeNull()
  })

  test("the gate no longer accepts record-shaped data outside a parsed payload", () => {
    const report = verifyRebuildEquivalence({
      bunVersion: CANONICALIZER.bunVersion,
      left: legacyFillerBinary("a1b2c3d4e5f60718"),
      right: legacyFillerBinary("b0b0b0b0b0b0b0b0"),
    })

    expect(report.equivalent).toBe(false)
    expect(report.rejection?.code).toBe("unsupported-executable-format")
    expect(report.canonicalSha256).toBeNull()
  })

  test("the canonical digest never replaces the raw binary identity in the manifest", () => {
    const binaryContent = left
    const report = verifyRebuildEquivalence({
      bunVersion: CANONICALIZER.bunVersion,
      left: binaryContent,
      right,
    })

    const packaged = packageTarget({
      target: "linux-arm64",
      binaryContent,
      version: "1.0.0",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      recipeDigest: "a".repeat(64),
      toolchainDigest: "b".repeat(64),
      sourceDateEpoch: 1700000000,
    })

    expect(packaged.artifact.binarySha256).toBe(sha256(binaryContent))
    expect(packaged.artifact.binarySha256).not.toBe(report.canonicalSha256)
    expect(packaged.innerMetadata.binarySha256).toBe(sha256(binaryContent))

    const binaryEntry = parseArchive(packaged.archiveBuffer).find(
      (entry) => entry.name === "bin/opencodeplus",
    )
    expect(binaryEntry?.content.equals(binaryContent)).toBe(true)
  })
})