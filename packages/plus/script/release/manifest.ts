import {
  Release,
  type ReleaseIdentity,
  type ArtifactIdentity,
  type ReleaseManifest,
  type ReleaseTarget,
} from "../../src/release/identity.js"

export interface InnerReleaseMetadata {
  readonly product: "opencodeplus"
  readonly channel: "plus"
  readonly version: string
  readonly target: ReleaseTarget
  readonly sourceSha: string
  readonly recipeDigest: string
  readonly toolchainDigest: string
  readonly binarySha256: string
  readonly binaryBytes: number
}

export function createInnerMetadata(input: {
  readonly target: ReleaseTarget
  readonly version: string
  readonly sourceSha: string
  readonly recipeDigest: string
  readonly toolchainDigest: string
  readonly binarySha256: string
  readonly binaryBytes: number
}): InnerReleaseMetadata {
  return {
    product: "opencodeplus",
    channel: "plus",
    version: input.version,
    target: input.target,
    sourceSha: input.sourceSha,
    recipeDigest: input.recipeDigest,
    toolchainDigest: input.toolchainDigest,
    binarySha256: input.binarySha256,
    binaryBytes: input.binaryBytes,
  }
}

export function serializeInnerMetadata(metadata: InnerReleaseMetadata): string {
  // Inner metadata excludes any build-job timestamps and excludes its own hash
  return Release.canonicalJson(metadata)
}

export function createReleaseManifest(input: {
  readonly release: ReleaseIdentity
  readonly artifacts: readonly ArtifactIdentity[]
  readonly unqualifiedTargets?: readonly string[]
  readonly installerSha256: string
  readonly generatedAt?: string
}): ReleaseManifest {
  const generatedAt = input.generatedAt ?? new Date(0).toISOString()
  const unqualifiedTargets = input.unqualifiedTargets ?? ["win32-x64", "win32-arm64"]

  const sortedArtifacts = [...input.artifacts].sort((a, b) => {
    if (a.target < b.target) return -1
    if (a.target > b.target) return 1
    return 0
  })

  return {
    contractVersion: 1,
    release: input.release,
    artifacts: sortedArtifacts,
    unqualifiedTargets: [...unqualifiedTargets],
    installerSha256: input.installerSha256,
    generatedAt,
  }
}

export function serializeReleaseManifest(manifest: ReleaseManifest): string {
  return Release.encodeManifest(manifest)
}

export interface ChecksumEntry {
  readonly filename: string
  readonly sha256: string
}

export function generateSha256Sums(entries: readonly ChecksumEntry[]): string {
  // SHA256SUMS covers other assets but NEVER itself
  const filtered = entries.filter((e) => {
    const base = e.filename.replace(/^.*[/\\]/, "")
    return base !== "SHA256SUMS"
  })

  const sorted = [...filtered].sort((a, b) => {
    if (a.filename < b.filename) return -1
    if (a.filename > b.filename) return 1
    return 0
  })

  const lines = sorted.map((entry) => `${entry.sha256}  ${entry.filename}`)
  return `${lines.join("\n")}\n`
}

export function parseSha256Sums(content: string): Map<string, string> {
  const map = new Map<string, string>()
  const lines = content.split("\n")

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    // Standard format: <hash><space><space><filename> or <hash><space><filename>
    const match = line.match(/^([a-f0-9]{64})\s+[* ]?(.+)$/)
    if (!match) continue

    const hash = match[1]
    const filename = match[2].trim()
    map.set(filename, hash)
  }

  return map
}
