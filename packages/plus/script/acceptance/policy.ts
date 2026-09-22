import { join } from "node:path"
import { Schema } from "effect"
import { Release } from "../../src/release/identity.js"

export const PolicyCheckDefinition = Schema.Struct({
  id: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
})
export interface PolicyCheckDefinition extends Schema.Schema.Type<typeof PolicyCheckDefinition> {}

export const CheckPolicy = Schema.Struct({
  policyVersion: Schema.Literal(1),
  checks: Schema.Array(PolicyCheckDefinition),
})
export interface CheckPolicy extends Schema.Schema.Type<typeof CheckPolicy> {}

const decodePolicy = Schema.decodeUnknownSync(CheckPolicy)

export function parseCheckPolicy(text: string): CheckPolicy {
  const raw = JSON.parse(text)
  return decodePolicy(raw)
}

export function computePolicyDigest(policy: CheckPolicy | unknown): string {
  return Release.digest(policy)
}

function resolvePolicyPath(policyPathOrRepoRoot?: string): string {
  if (!policyPathOrRepoRoot) {
    return join(import.meta.dirname, "../../../../release/checks.json")
  }
  if (policyPathOrRepoRoot.endsWith(".json")) {
    return policyPathOrRepoRoot
  }
  return join(policyPathOrRepoRoot, "release/checks.json")
}

export async function loadCheckPolicy(policyPathOrRepoRoot?: string): Promise<CheckPolicy> {
  const filePath = resolvePolicyPath(policyPathOrRepoRoot)
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    throw new Error(`Policy file not found at ${filePath}`)
  }
  const text = await file.text()
  return parseCheckPolicy(text)
}

export async function getPolicyDigest(policyPathOrRepoRoot?: string): Promise<string> {
  const policy = await loadCheckPolicy(policyPathOrRepoRoot)
  return computePolicyDigest(policy)
}
