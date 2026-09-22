import { join } from "node:path"
import { readdir } from "node:fs/promises"
import { Release } from "../../src/release/identity.js"

export interface RecipeInputs {
  readonly version: string
  readonly channel: "plus"
  readonly targets: readonly string[]
  readonly lockfileSha256: string
  readonly patchesSha256: string
  readonly dependenciesSha256: string
  readonly toolchain: unknown
}

export function computeRecipeDigest(inputs: unknown): string {
  return Release.computeRecipeDigest(inputs)
}

function resolveRepoRoot(repoRoot?: string): string {
  if (repoRoot) return repoRoot
  return join(import.meta.dirname, "../../../..")
}

async function computeFileSha256(filePath: string): Promise<string> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return ""
  const buffer = await file.arrayBuffer()
  return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
}

async function computePatchesSha256(repoRoot: string): Promise<string> {
  const patchesDir = join(repoRoot, "patches")
  const dirFile = Bun.file(patchesDir)
  let entries: string[] = []
  try {
    entries = await readdir(patchesDir)
  } catch {
    return ""
  }

  const sortedEntries = entries.sort()
  const hasher = new Bun.CryptoHasher("sha256")
  for (const entry of sortedEntries) {
    const patchFile = join(patchesDir, entry)
    const file = Bun.file(patchFile)
    if (await file.exists()) {
      hasher.update(entry)
      hasher.update(":")
      const content = await file.arrayBuffer()
      hasher.update(content)
      hasher.update("\n")
    }
  }
  return hasher.digest("hex")
}

async function computeDependenciesSha256(repoRoot: string): Promise<string> {
  const rootPkgPath = join(repoRoot, "package.json")
  const rootPkgFile = Bun.file(rootPkgPath)
  if (!(await rootPkgFile.exists())) return ""
  const rootPkg = (await rootPkgFile.json()) as Record<string, unknown>

  const extracted = {
    dependencies: rootPkg.dependencies ?? {},
    devDependencies: rootPkg.devDependencies ?? {},
    peerDependencies: rootPkg.peerDependencies ?? {},
    optionalDependencies: rootPkg.optionalDependencies ?? {},
  }
  return new Bun.CryptoHasher("sha256")
    .update(Release.canonicalJson(extracted))
    .digest("hex")
}

export async function loadRecipeInputs(options?: {
  repoRoot?: string
  version?: string
}): Promise<RecipeInputs> {
  const repoRoot = resolveRepoRoot(options?.repoRoot)

  const toolchainFile = Bun.file(join(repoRoot, "release/toolchain.json"))
  const toolchain: unknown = (await toolchainFile.exists()) ? await toolchainFile.json() : {}

  const contractFile = Bun.file(join(repoRoot, "release/contract.json"))
  let targets: string[] = ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"]
  if (await contractFile.exists()) {
    const contract = (await contractFile.json()) as { targets?: string[] }
    if (Array.isArray(contract.targets)) {
      targets = contract.targets
    }
  }

  let version = options?.version ?? process.env.OPENCODE_VERSION ?? ""
  if (!version) {
    const versionFile = Bun.file(join(repoRoot, "release/version.json"))
    if (await versionFile.exists()) {
      const parsed = (await versionFile.json()) as { version?: string | null }
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        version = parsed.version
      }
    }
  }

  const [lockfileSha256, patchesSha256, dependenciesSha256] = await Promise.all([
    computeFileSha256(join(repoRoot, "bun.lock")),
    computePatchesSha256(repoRoot),
    computeDependenciesSha256(repoRoot),
  ])

  return {
    version,
    channel: "plus",
    targets,
    lockfileSha256,
    patchesSha256,
    dependenciesSha256,
    toolchain,
  }
}

export async function getRecipeDigest(options?: {
  repoRoot?: string
  version?: string
}): Promise<string> {
  const inputs = await loadRecipeInputs(options)
  return computeRecipeDigest(inputs)
}
