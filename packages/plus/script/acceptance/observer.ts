import { Schema } from "effect"
import { ReleaseHostIdentity } from "@opencode/schema/release"

export interface ObservedCanary {
  readonly path: string
  readonly initialDigest: string
  readonly currentDigest: string | null
  readonly unchanged: boolean
}

export interface ObservedCandidateState {
  readonly executablePath: string
  readonly executableSha256: string | null
  readonly pid: number | null
  readonly startedAt: string | null
  readonly alive: boolean
  readonly exitCode: number | null
  readonly hostIdentity: ReleaseHostIdentity | null
  readonly canaries: readonly ObservedCanary[]
  readonly canariesUnchanged: boolean
}

export interface ObserverConfig {
  readonly executablePath: string
  readonly pid?: number | null
  readonly startedAt?: string | null
  readonly exitCode?: number | null
  readonly serverUrl?: string | null
  readonly initialCanaries?: ReadonlyMap<string, string>
  readonly canaryPaths?: readonly string[]
  readonly probeHost?: () => Promise<ReleaseHostIdentity | null>
}

function computeBufferSha256(buffer: Uint8Array | Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
}

export async function snapshotCanaries(paths: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const path of paths) {
    const file = Bun.file(path)
    if (await file.exists()) {
      const buf = Buffer.from(await file.arrayBuffer())
      map.set(path, computeBufferSha256(buf))
    }
  }
  return map
}

const decodeHostIdentitySchema = Schema.decodeUnknownOption(ReleaseHostIdentity)

export async function observeCandidate(config: ObserverConfig): Promise<ObservedCandidateState> {
  const exeFile = Bun.file(config.executablePath)
  let executableSha256: string | null = null
  if (await exeFile.exists()) {
    const exeBuffer = Buffer.from(await exeFile.arrayBuffer())
    executableSha256 = computeBufferSha256(exeBuffer)
  }

  const pid = config.pid ?? null
  let alive = false
  if (pid !== null && pid > 0) {
    try {
      alive = process.kill(pid, 0)
    } catch {
      alive = false
    }
  }

  const startedAt = config.startedAt ?? null
  const exitCode = config.exitCode ?? null

  // Measure canaries
  const canaries: ObservedCanary[] = []
  let allCanariesUnchanged = true

  const canaryPaths = config.canaryPaths ?? []
  for (const path of canaryPaths) {
    const file = Bun.file(path)
    let currentDigest: string | null = null
    if (await file.exists()) {
      const buf = Buffer.from(await file.arrayBuffer())
      currentDigest = computeBufferSha256(buf)
    }

    const initialDigest = config.initialCanaries?.get(path) ?? ""
    const unchanged = initialDigest !== "" && currentDigest === initialDigest

    if (!unchanged) {
      allCanariesUnchanged = false
    }

    canaries.push({
      path,
      initialDigest,
      currentDigest,
      unchanged,
    })
  }

  // Host identity: measure from outside, unmeasured facts are null
  let hostIdentity: ReleaseHostIdentity | null = null
  if (config.probeHost) {
    try {
      hostIdentity = await config.probeHost()
    } catch {
      hostIdentity = null
    }
  } else if (config.serverUrl) {
    try {
      const response = await fetch(`${config.serverUrl}/api/host-identity`, {
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) {
        const body = await response.json()
        const opt = decodeHostIdentitySchema(body)
        if (opt._tag === "Some") {
          hostIdentity = opt.value
        }
      }
    } catch {
      hostIdentity = null
    }
  }

  return {
    executablePath: config.executablePath,
    executableSha256,
    pid,
    startedAt,
    alive,
    exitCode,
    hostIdentity,
    canaries,
    canariesUnchanged: allCanariesUnchanged,
  }
}
