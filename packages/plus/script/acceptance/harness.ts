import { join } from "node:path"
import { Release } from "../../src/release/identity.js"

export const HARNESS_SOURCE_FILES: readonly string[] = [
  "packages/plus/script/acceptance.ts",
  "packages/plus/script/acceptance/harness.ts",
  "packages/plus/script/acceptance/observer.ts",
  "packages/plus/script/acceptance/policy.ts",
  "packages/plus/script/acceptance/receipt.ts",
  "packages/plus/script/candidate-lab.ts",
  "packages/plus/script/verify-release.ts",
]

function resolveRepoRoot(repoRoot?: string): string {
  if (repoRoot) return repoRoot
  return join(import.meta.dirname, "../../../..")
}

export interface HarnessFileEntry {
  readonly path: string
  readonly sha256: string
}

export async function getHarnessFileEntries(options?: {
  repoRoot?: string
  fileOverrides?: ReadonlyMap<string, string | Uint8Array>
}): Promise<readonly HarnessFileEntry[]> {
  const root = resolveRepoRoot(options?.repoRoot)
  const entries: HarnessFileEntry[] = []

  for (const relativePath of HARNESS_SOURCE_FILES) {
    if (options?.fileOverrides && options.fileOverrides.has(relativePath)) {
      const content = options.fileOverrides.get(relativePath)!
      const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content)
      const sha256 = new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
      entries.push({ path: relativePath, sha256 })
      continue
    }

    const fullPath = join(root, relativePath)
    const file = Bun.file(fullPath)
    if (await file.exists()) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const sha256 = new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
      entries.push({ path: relativePath, sha256 })
      continue
    }

    entries.push({ path: relativePath, sha256: "" })
  }

  return entries
}

export function computeHarnessDigestFromEntries(entries: readonly HarnessFileEntry[]): string {
  return Release.digest(entries)
}

export async function computeHarnessDigest(options?: {
  repoRoot?: string
  fileOverrides?: ReadonlyMap<string, string | Uint8Array>
}): Promise<string> {
  const entries = await getHarnessFileEntries(options)
  return computeHarnessDigestFromEntries(entries)
}
