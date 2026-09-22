import { mkdir, writeFile, copyFile } from "node:fs/promises"
import { join } from "node:path"
import {
  Release,
  type ReleaseIdentity,
  type ArtifactIdentity,
} from "../src/release/identity.js"
import type {
  ReleaseAcceptanceReceipt,
  ReleaseCheckReceipt,
  ReleaseVerdict,
} from "@opencode/schema/release"
import {
  assembleAcceptanceReceipt,
  decodeAcceptanceReceipt,
  encodeAcceptanceReceipt,
} from "./acceptance/receipt.js"
import {
  getPolicyDigest,
  loadCheckPolicy,
  computePolicyDigest,
} from "./acceptance/policy.js"
import { computeHarnessDigest } from "./acceptance/harness.js"
import { verifyRelease } from "./verify-release.js"

export type OfflineVerificationRejectionReason =
  | "missing_receipt"
  | "invalid_receipt"
  | "source_sha_mismatch"
  | "release_identity_mismatch"
  | "artifact_identity_mismatch"
  | "policy_digest_mismatch"
  | "harness_digest_mismatch"
  | "check_receipt_invalid"
  | "check_head_mismatch"
  | "check_failed_in_pass_verdict"
  | "check_dirty_in_pass_verdict"
  | "missing_required_policy_check"
  | "asset_verification_failed"

export interface OfflineVerificationSuccess {
  readonly ok: true
  readonly sourceSha: string
  readonly verdict: ReleaseVerdict
  readonly checksVerified: number
  readonly releaseVerified: boolean
}

export interface OfflineVerificationFailure {
  readonly ok: false
  readonly reason: OfflineVerificationRejectionReason
  readonly message: string
  readonly detail?: unknown
}

export type OfflineVerificationResult = OfflineVerificationSuccess | OfflineVerificationFailure

export class OfflineVerificationError extends Error {
  readonly reason: OfflineVerificationRejectionReason
  readonly detail?: unknown

  constructor(reason: OfflineVerificationRejectionReason, message: string, detail?: unknown) {
    super(message)
    this.name = "OfflineVerificationError"
    this.reason = reason
    this.detail = detail
  }
}

export interface AcceptancePassOptions {
  readonly sourceSha: string
  readonly checks: readonly ReleaseCheckReceipt[]
  readonly release?: ReleaseIdentity | null
  readonly artifact?: ArtifactIdentity | null
  readonly outDir?: string
  readonly repoRoot?: string
  readonly policyPath?: string
  readonly requiredPolicyCheckIds?: readonly string[]
  readonly overrideVerdict?: ReleaseVerdict
}

export async function runAcceptancePass(options: AcceptancePassOptions): Promise<ReleaseAcceptanceReceipt> {
  const policyDigest = await getPolicyDigest(options.policyPath ?? options.repoRoot)
  const harnessDigest = await computeHarnessDigest({ repoRoot: options.repoRoot })

  const receipt = assembleAcceptanceReceipt({
    sourceSha: options.sourceSha,
    release: options.release,
    artifact: options.artifact,
    policyDigest,
    harnessDigest,
    checks: options.checks,
    requiredPolicyCheckIds: options.requiredPolicyCheckIds,
    overrideVerdict: options.overrideVerdict,
  })

  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true })
    const receiptPath = join(options.outDir, "acceptance-receipt.json")
    await writeFile(receiptPath, encodeAcceptanceReceipt(receipt))
  }

  return receipt
}

export interface OfflineVerificationOptions {
  readonly exportDir: string
  readonly expectedSourceSha?: string
  readonly expectedPolicyDigest?: string
  readonly expectedHarnessDigest?: string
  readonly policyPath?: string
}

export async function verifyAcceptanceOffline(
  options: OfflineVerificationOptions,
): Promise<OfflineVerificationResult> {
  const receiptPath = join(options.exportDir, "acceptance-receipt.json")
  const receiptFile = Bun.file(receiptPath)
  if (!(await receiptFile.exists())) {
    return {
      ok: false,
      reason: "missing_receipt",
      message: `Acceptance receipt not found at ${receiptPath}`,
    }
  }

  let receipt: ReleaseAcceptanceReceipt
  try {
    const text = await receiptFile.text()
    receipt = decodeAcceptanceReceipt(text)
  } catch (err) {
    return {
      ok: false,
      reason: "invalid_receipt",
      message: `Failed to decode receipt: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (options.expectedSourceSha && receipt.sourceSha !== options.expectedSourceSha) {
    return {
      ok: false,
      reason: "source_sha_mismatch",
      message: `Receipt sourceSha (${receipt.sourceSha}) does not match expected (${options.expectedSourceSha})`,
    }
  }

  if (receipt.release && receipt.release.sourceSha !== receipt.sourceSha) {
    return {
      ok: false,
      reason: "source_sha_mismatch",
      message: `Release sourceSha (${receipt.release.sourceSha}) does not match receipt sourceSha (${receipt.sourceSha})`,
    }
  }

  const manifestPath = join(options.exportDir, "release.json")
  const manifestFile = Bun.file(manifestPath)
  let releaseVerified = false
  if (await manifestFile.exists()) {
    let manifest
    try {
      manifest = Release.decodeManifest(await manifestFile.text())
    } catch (err) {
      return {
        ok: false,
        reason: "asset_verification_failed",
        message: `Failed to decode release.json in export dir: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    if (manifest.release.sourceSha !== receipt.sourceSha) {
      return {
        ok: false,
        reason: "source_sha_mismatch",
        message: `Manifest release sourceSha (${manifest.release.sourceSha}) does not match receipt sourceSha (${receipt.sourceSha})`,
      }
    }

    if (receipt.release && !Release.identityMatches(manifest.release, receipt.release)) {
      return {
        ok: false,
        reason: "release_identity_mismatch",
        message: "Manifest release identity does not match receipt release identity",
      }
    }

    if (receipt.artifact) {
      const match = manifest.artifacts.some((a) => Release.artifactMatches(a, receipt.artifact!))
      if (!match) {
        return {
          ok: false,
          reason: "artifact_identity_mismatch",
          message: "Receipt artifact identity not found in manifest artifacts",
        }
      }
    }

    const assetResult = await verifyRelease(options.exportDir)
    if (!assetResult.ok) {
      return {
        ok: false,
        reason: "asset_verification_failed",
        message: `Asset verification failed: ${assetResult.reason}: ${assetResult.message}`,
      }
    }
    releaseVerified = true
  }

  if (options.expectedPolicyDigest && receipt.policyDigest !== options.expectedPolicyDigest) {
    return {
      ok: false,
      reason: "policy_digest_mismatch",
      message: `Policy digest mismatch: expected ${options.expectedPolicyDigest}, got ${receipt.policyDigest}`,
    }
  }

  const exportedPolicyFile = options.policyPath
    ? Bun.file(options.policyPath)
    : Bun.file(join(options.exportDir, "checks.json"))
  if (await exportedPolicyFile.exists()) {
    try {
      const policy = await loadCheckPolicy(exportedPolicyFile.name)
      const computed = computePolicyDigest(policy)
      if (computed !== receipt.policyDigest) {
        return {
          ok: false,
          reason: "policy_digest_mismatch",
          message: `Policy digest mismatch against export checks.json: computed ${computed}, receipt has ${receipt.policyDigest}`,
        }
      }

      const receiptCheckIds = new Set(receipt.checks.map((c) => c.id))
      for (const req of policy.checks) {
        if (!receiptCheckIds.has(req.id)) {
          return {
            ok: false,
            reason: "missing_required_policy_check",
            message: `Required policy check '${req.id}' is missing from acceptance receipt`,
          }
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: "policy_digest_mismatch",
        message: `Error checking policy: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  if (options.expectedHarnessDigest && receipt.harnessDigest !== options.expectedHarnessDigest) {
    return {
      ok: false,
      reason: "harness_digest_mismatch",
      message: `Harness digest mismatch: expected ${options.expectedHarnessDigest}, got ${receipt.harnessDigest}`,
    }
  }

  for (const check of receipt.checks) {
    if (!check.id || !Array.isArray(check.argv) || typeof check.exitCode !== "number") {
      return {
        ok: false,
        reason: "check_receipt_invalid",
        message: `Invalid check receipt structure for '${check.id ?? "unknown"}'`,
      }
    }

    if (check.head !== receipt.sourceSha) {
      return {
        ok: false,
        reason: "check_head_mismatch",
        message: `Check '${check.id}' head (${check.head}) does not match receipt sourceSha (${receipt.sourceSha})`,
      }
    }

    if (receipt.verdict === "pass") {
      if (check.exitCode !== 0) {
        return {
          ok: false,
          reason: "check_failed_in_pass_verdict",
          message: `Check '${check.id}' failed with exitCode ${check.exitCode} in passing receipt`,
        }
      }
      if (check.dirty) {
        return {
          ok: false,
          reason: "check_dirty_in_pass_verdict",
          message: `Check '${check.id}' was executed on dirty tree in passing receipt`,
        }
      }
    }
  }

  return {
    ok: true,
    sourceSha: receipt.sourceSha,
    verdict: receipt.verdict,
    checksVerified: receipt.checks.length,
    releaseVerified,
  }
}

export async function verifyAcceptanceOfflineOrThrow(
  options: OfflineVerificationOptions,
): Promise<OfflineVerificationSuccess> {
  const result = await verifyAcceptanceOffline(options)
  if (!result.ok) {
    throw new OfflineVerificationError(result.reason, result.message, result.detail)
  }
  return result
}
