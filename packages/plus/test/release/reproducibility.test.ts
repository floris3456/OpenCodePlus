import { describe, expect, test } from "bun:test"
import {
  packageTarget,
  createDeterministicArchive,
  parseArchive,
  computeRecipeDigest,
  type RecipeInputs,
} from "../../script/release.js"

describe("release reproducibility and normalisation", () => {
  test("two packaging runs over identical inputs produce byte-identical archives", () => {
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
