import { Schema } from "effect"
import {
  ReleaseAcceptanceReceipt,
  ReleaseCheckReceipt,
  type ReleaseVerdict,
  type ReleaseIdentity,
  type ArtifactIdentity,
} from "@opencode/schema/release"
import { Release } from "../../src/release/identity.js"

export interface AssembleReceiptInput {
  readonly kind?: string
  readonly sourceSha: string
  readonly release?: ReleaseIdentity | null
  readonly artifact?: ArtifactIdentity | null
  readonly policyDigest: string
  readonly harnessDigest: string
  readonly checks: readonly ReleaseCheckReceipt[]
  readonly producedAt?: string
  readonly overrideVerdict?: ReleaseVerdict
  readonly requiredPolicyCheckIds?: readonly string[]
}

export function evaluateVerdict(
  sourceSha: string,
  checks: readonly ReleaseCheckReceipt[],
  requiredPolicyCheckIds?: readonly string[],
): ReleaseVerdict {
  if (checks.length === 0) return "fail"

  if (requiredPolicyCheckIds && requiredPolicyCheckIds.length > 0) {
    const presentIds = new Set(checks.map((c) => c.id))
    for (const requiredId of requiredPolicyCheckIds) {
      if (!presentIds.has(requiredId)) return "fail"
    }
  }

  for (const check of checks) {
    if (check.exitCode !== 0) return "fail"
    if (check.dirty) return "fail"
    if (check.head !== sourceSha) return "fail"
  }

  return "pass"
}

export function assembleAcceptanceReceipt(input: AssembleReceiptInput): ReleaseAcceptanceReceipt {
  const verdict =
    input.overrideVerdict ??
    evaluateVerdict(input.sourceSha, input.checks, input.requiredPolicyCheckIds)

  const receipt: ReleaseAcceptanceReceipt = {
    receiptVersion: 1,
    kind: input.kind ?? "acceptance",
    sourceSha: input.sourceSha,
    release: input.release ?? null,
    artifact: input.artifact ?? null,
    policyDigest: input.policyDigest,
    harnessDigest: input.harnessDigest,
    checks: [...input.checks],
    verdict,
    producedAt: input.producedAt ?? new Date().toISOString(),
  }

  validateReceiptOrThrow(receipt)
  return receipt
}

const decodeReceiptSchema = Schema.decodeUnknownSync(ReleaseAcceptanceReceipt)
const encodeReceiptSchema = Schema.encodeUnknownSync(ReleaseAcceptanceReceipt)

export function decodeAcceptanceReceipt(raw: unknown): ReleaseAcceptanceReceipt {
  if (typeof raw === "string") {
    const parsed = JSON.parse(raw)
    return decodeReceiptSchema(parsed)
  }
  return decodeReceiptSchema(raw)
}

export function encodeAcceptanceReceipt(receipt: ReleaseAcceptanceReceipt): string {
  const encoded = encodeReceiptSchema(receipt)
  return Release.canonicalJson(encoded)
}

export class ReceiptValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReceiptValidationError"
  }
}

export function validateReceipt(receipt: unknown): { ok: boolean; reason?: string } {
  let decoded: ReleaseAcceptanceReceipt
  try {
    decoded = decodeAcceptanceReceipt(receipt)
  } catch (err) {
    return {
      ok: false,
      reason: `Schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (decoded.release && decoded.release.sourceSha !== decoded.sourceSha) {
    return {
      ok: false,
      reason: `Release sourceSha (${decoded.release.sourceSha}) does not match receipt sourceSha (${decoded.sourceSha})`,
    }
  }

  if (decoded.verdict === "pass") {
    if (decoded.checks.length === 0) {
      return {
        ok: false,
        reason: "Verdict is pass but checks list is empty",
      }
    }
    for (const check of decoded.checks) {
      if (check.exitCode !== 0) {
        return {
          ok: false,
          reason: `Verdict is pass but check '${check.id}' failed with exitCode ${check.exitCode}`,
        }
      }
      if (check.dirty) {
        return {
          ok: false,
          reason: `Verdict is pass but check '${check.id}' was run on dirty tree`,
        }
      }
      if (check.head !== decoded.sourceSha) {
        return {
          ok: false,
          reason: `Verdict is pass but check '${check.id}' head (${check.head}) does not match receipt sourceSha (${decoded.sourceSha})`,
        }
      }
    }
  }

  return { ok: true }
}

export function validateReceiptOrThrow(receipt: unknown): ReleaseAcceptanceReceipt {
  const res = validateReceipt(receipt)
  if (!res.ok) {
    throw new ReceiptValidationError(res.reason ?? "Invalid receipt")
  }
  return decodeAcceptanceReceipt(receipt)
}
