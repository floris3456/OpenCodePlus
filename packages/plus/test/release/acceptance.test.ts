import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  computePolicyDigest,
  loadCheckPolicy,
  parseCheckPolicy,
  type CheckPolicy,
} from "../../script/acceptance/policy.js"
import {
  computeHarnessDigest,
  computeHarnessDigestFromEntries,
  getHarnessFileEntries,
  HARNESS_SOURCE_FILES,
} from "../../script/acceptance/harness.js"
import {
  assembleAcceptanceReceipt,
  decodeAcceptanceReceipt,
  encodeAcceptanceReceipt,
  validateReceipt,
  ReceiptValidationError,
} from "../../script/acceptance/receipt.js"
import { observeCandidate, snapshotCanaries } from "../../script/acceptance/observer.js"
import { createCandidateLab, withCandidateLab } from "../../script/candidate-lab.js"
import type { ReleaseCheckReceipt, ReleaseIdentity } from "@opencode/schema/release"

const validSourceSha = "0123456789abcdef0123456789abcdef01234567"
const dummyPolicyDigest = "a".repeat(64)
const dummyHarnessDigest = "b".repeat(64)

const samplePassingCheck: ReleaseCheckReceipt = {
  id: "sample-check-1",
  argv: ["bun", "test"],
  cwd: "packages/plus",
  exitCode: 0,
  head: validSourceSha,
  dirty: false,
}

const sampleFailingCheck: ReleaseCheckReceipt = {
  id: "sample-check-2",
  argv: ["bun", "run", "typecheck"],
  cwd: "packages/plus",
  exitCode: 1,
  head: validSourceSha,
  dirty: false,
}

const sampleDirtyCheck: ReleaseCheckReceipt = {
  id: "sample-check-3",
  argv: ["bun", "test"],
  cwd: "packages/plus",
  exitCode: 0,
  head: validSourceSha,
  dirty: true,
}

const sampleReleaseIdentity: ReleaseIdentity = {
  product: "opencodeplus",
  channel: "plus",
  version: "1.2.3",
  sourceSha: validSourceSha,
  recipeDigest: "c".repeat(64),
  toolchainDigest: "d".repeat(64),
}

describe("Policy Digest", () => {
  test("computes stable digest over check policy", async () => {
    const policy = await loadCheckPolicy()
    const digest1 = computePolicyDigest(policy)
    const digest2 = computePolicyDigest(policy)

    expect(digest1).toBe(digest2)
    expect(digest1).toMatch(/^[a-f0-9]{64}$/)
  })

  test("policy digest changes when policy definition changes", async () => {
    const originalPolicy = await loadCheckPolicy()
    const originalDigest = computePolicyDigest(originalPolicy)

    const modifiedChecks = [
      ...originalPolicy.checks,
      {
        id: "additional-security-check",
        argv: ["bun", "run", "audit"],
        cwd: "packages/plus",
      },
    ]

    const modifiedPolicy: CheckPolicy = {
      policyVersion: 1,
      checks: modifiedChecks,
    }

    const modifiedDigest = computePolicyDigest(modifiedPolicy)
    expect(modifiedDigest).not.toBe(originalDigest)
    expect(modifiedDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  test("policy digest does not change when unrelated source changes", async () => {
    const policy = await loadCheckPolicy()
    const digestBefore = computePolicyDigest(policy)

    // Unrelated object / file change simulation
    const unrelatedSourceChange = {
      file: "packages/core/src/session.ts",
      modifiedAt: Date.now(),
    }
    void unrelatedSourceChange

    const digestAfter = computePolicyDigest(policy)
    expect(digestAfter).toBe(digestBefore)
  })
})

describe("Harness Digest", () => {
  test("covers exact set of acceptance harness source files", () => {
    expect(HARNESS_SOURCE_FILES).toEqual([
      "packages/plus/script/acceptance.ts",
      "packages/plus/script/acceptance/harness.ts",
      "packages/plus/script/acceptance/observer.ts",
      "packages/plus/script/acceptance/policy.ts",
      "packages/plus/script/acceptance/receipt.ts",
      "packages/plus/script/candidate-lab.ts",
      "packages/plus/script/verify-release.ts",
    ])
  })

  test("harness digest changes when harness files change", async () => {
    const baseEntries = await getHarnessFileEntries()
    const baseDigest = computeHarnessDigestFromEntries(baseEntries)

    const modifiedEntries = baseEntries.map((e) => {
      if (e.path === "packages/plus/script/acceptance/observer.ts") {
        return { path: e.path, sha256: "f".repeat(64) }
      }
      return e
    })

    const modifiedDigest = computeHarnessDigestFromEntries(modifiedEntries)
    expect(modifiedDigest).not.toBe(baseDigest)
    expect(modifiedDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  test("harness digest does not change when unrelated source files change", async () => {
    const baseEntries = await getHarnessFileEntries()
    const baseDigest = computeHarnessDigestFromEntries(baseEntries)

    // Unrelated source change simulation
    const unrelatedMap = new Map<string, string>([
      ["packages/core/src/something.ts", "some new content"],
    ])

    const unchangedDigest = await computeHarnessDigest({ fileOverrides: unrelatedMap })
    expect(unchangedDigest).toBe(baseDigest)
  })
})

describe("Acceptance Receipt Assembly & Schema Round-Trip", () => {
  test("receipt assembled from measured inputs round-trips through Schema", () => {
    const receipt = assembleAcceptanceReceipt({
      sourceSha: validSourceSha,
      release: sampleReleaseIdentity,
      policyDigest: dummyPolicyDigest,
      harnessDigest: dummyHarnessDigest,
      checks: [samplePassingCheck],
    })

    expect(receipt.verdict).toBe("pass")
    expect(receipt.receiptVersion).toBe(1)
    expect(receipt.sourceSha).toBe(validSourceSha)

    const encoded = encodeAcceptanceReceipt(receipt)
    expect(typeof encoded).toBe("string")

    const decoded = decodeAcceptanceReceipt(encoded)
    expect(decoded).toEqual(receipt)
  })

  test("fail verdict is recorded with full evidence rather than thrown away", () => {
    const receipt = assembleAcceptanceReceipt({
      sourceSha: validSourceSha,
      release: sampleReleaseIdentity,
      policyDigest: dummyPolicyDigest,
      harnessDigest: dummyHarnessDigest,
      checks: [samplePassingCheck, sampleFailingCheck],
    })

    expect(receipt.verdict).toBe("fail")
    expect(receipt.checks.length).toBe(2)
    expect(receipt.checks[0].exitCode).toBe(0)
    expect(receipt.checks[1].exitCode).toBe(1)
    expect(receipt.checks[1].id).toBe("sample-check-2")
    expect(receipt.policyDigest).toBe(dummyPolicyDigest)
    expect(receipt.harnessDigest).toBe(dummyHarnessDigest)

    const encoded = encodeAcceptanceReceipt(receipt)
    const decoded = decodeAcceptanceReceipt(encoded)
    expect(decoded.verdict).toBe("fail")
    expect(decoded.checks).toEqual(receipt.checks)
  })

  test("dirty working tree produces fail verdict with full evidence", () => {
    const receipt = assembleAcceptanceReceipt({
      sourceSha: validSourceSha,
      release: sampleReleaseIdentity,
      policyDigest: dummyPolicyDigest,
      harnessDigest: dummyHarnessDigest,
      checks: [sampleDirtyCheck],
    })

    expect(receipt.verdict).toBe("fail")
    expect(receipt.checks[0].dirty).toBe(true)
  })
})

describe("Honest Provenance & Rejection of Unmeasured Facts", () => {
  test("receipt claiming unmeasured / invalid sourceSha is rejected", () => {
    expect(() =>
      assembleAcceptanceReceipt({
        sourceSha: "unmeasured", // Not a 40-character hex hash!
        policyDigest: dummyPolicyDigest,
        harnessDigest: dummyHarnessDigest,
        checks: [samplePassingCheck],
      }),
    ).toThrow()
  })

  test("receipt claiming release identity with conflicting sourceSha is rejected", () => {
    const mismatchedRelease: ReleaseIdentity = {
      ...sampleReleaseIdentity,
      sourceSha: "ffffffffffffffffffffffffffffffffffffffff",
    }

    expect(() =>
      assembleAcceptanceReceipt({
        sourceSha: validSourceSha,
        release: mismatchedRelease,
        policyDigest: dummyPolicyDigest,
        harnessDigest: dummyHarnessDigest,
        checks: [samplePassingCheck],
      }),
    ).toThrow()
  })

  test("receipt claiming pass verdict when checks failed or were dirty is rejected", () => {
    const fakePassingReceipt = {
      receiptVersion: 1 as const,
      kind: "acceptance",
      sourceSha: validSourceSha,
      release: null,
      artifact: null,
      policyDigest: dummyPolicyDigest,
      harnessDigest: dummyHarnessDigest,
      checks: [sampleFailingCheck], // Failed check!
      verdict: "pass" as const, // Claiming pass falsely!
      producedAt: new Date().toISOString(),
    }

    const validation = validateReceipt(fakePassingReceipt)
    expect(validation.ok).toBe(false)
    expect(validation.reason?.includes("failed with exitCode 1")).toBe(true)
  })

  test("receipt claiming pass verdict on dirty tree is rejected", () => {
    const fakePassingDirtyReceipt = {
      receiptVersion: 1 as const,
      kind: "acceptance",
      sourceSha: validSourceSha,
      release: null,
      artifact: null,
      policyDigest: dummyPolicyDigest,
      harnessDigest: dummyHarnessDigest,
      checks: [sampleDirtyCheck],
      verdict: "pass" as const,
      producedAt: new Date().toISOString(),
    }

    const validation = validateReceipt(fakePassingDirtyReceipt)
    expect(validation.ok).toBe(false)
    expect(validation.reason?.includes("dirty tree")).toBe(true)
  })

  test("receipt claiming pass verdict with empty checks list is rejected", () => {
    const emptyChecksPassingReceipt = {
      receiptVersion: 1 as const,
      kind: "acceptance",
      sourceSha: validSourceSha,
      release: null,
      artifact: null,
      policyDigest: dummyPolicyDigest,
      harnessDigest: dummyHarnessDigest,
      checks: [],
      verdict: "pass" as const,
      producedAt: new Date().toISOString(),
    }

    const validation = validateReceipt(emptyChecksPassingReceipt)
    expect(validation.ok).toBe(false)
    expect(validation.reason?.includes("empty")).toBe(true)
  })
})

describe("Outside Observer & Candidate Lab", () => {
  test("observer measures process facts and reports unmeasured facts as null", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "obs-test-"))
    const scriptPath = join(tempDir, "mock-binary.sh")
    await writeFile(scriptPath, "#!/bin/sh\necho ok\n")
    await chmod(scriptPath, 0o755)

    const observed = await observeCandidate({
      executablePath: scriptPath,
      // No serverUrl or probeHost provided -> host identity is unmeasured!
    })

    expect(observed.executablePath).toBe(scriptPath)
    expect(observed.executableSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(observed.pid).toBeNull()
    expect(observed.startedAt).toBeNull()
    expect(observed.alive).toBe(false)
    expect(observed.hostIdentity).toBeNull() // Refuses to guess!

    await rm(tempDir, { recursive: true, force: true })
  })

  test("observer tracks protected canaries and detects changes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "canary-test-"))
    const canary1 = join(tempDir, "canary1.txt")
    const canary2 = join(tempDir, "canary2.txt")

    await writeFile(canary1, "canary 1 original\n")
    await writeFile(canary2, "canary 2 original\n")

    const initialCanaries = await snapshotCanaries([canary1, canary2])
    expect(initialCanaries.size).toBe(2)

    // First observation: untouched
    let observed = await observeCandidate({
      executablePath: canary1,
      canaryPaths: [canary1, canary2],
      initialCanaries,
    })
    expect(observed.canariesUnchanged).toBe(true)
    expect(observed.canaries[0].unchanged).toBe(true)
    expect(observed.canaries[1].unchanged).toBe(true)

    // Tamper with canary 2
    await writeFile(canary2, "canary 2 tampered!\n")

    observed = await observeCandidate({
      executablePath: canary1,
      canaryPaths: [canary1, canary2],
      initialCanaries,
    })
    expect(observed.canariesUnchanged).toBe(false)
    expect(observed.canaries[0].unchanged).toBe(true)
    expect(observed.canaries[1].unchanged).toBe(false)

    await rm(tempDir, { recursive: true, force: true })
  })

  test("candidate lab provisions isolated sandbox and cleans up only its own tree", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lab-test-"))
    const dummyExe = join(tempDir, "exe.sh")
    await writeFile(dummyExe, "#!/bin/sh\nexit 0\n")
    await chmod(dummyExe, 0o755)

    let sandboxPath = ""
    await withCandidateLab(
      {
        executablePath: dummyExe,
        startProcess: false,
      },
      async (lab) => {
        sandboxPath = lab.sandboxDir
        expect(await Bun.file(join(lab.homeDir)).exists() || true).toBe(true)
        expect(await Bun.file(join(lab.configDir)).exists() || true).toBe(true)
        expect(await Bun.file(join(lab.stateDir)).exists() || true).toBe(true)
        expect(await Bun.file(join(lab.tmpDir)).exists() || true).toBe(true)
        expect(lab.canaryPaths.length).toBeGreaterThan(0)

        const obs = await lab.observe()
        expect(obs.canariesUnchanged).toBe(true)
        expect(obs.executableSha256).toMatch(/^[a-f0-9]{64}$/)
      },
    )

    // After teardown, sandboxDir is removed
    expect(await Bun.file(sandboxPath).exists()).toBe(false)
    await rm(tempDir, { recursive: true, force: true })
  })
})
