import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  observeCandidate,
  snapshotCanaries,
  type ObservedCandidateState,
} from "./acceptance/observer.js"
import type { ReleaseHostIdentity } from "@opencode/schema/release"

export interface CandidateLabOptions {
  readonly executablePath: string
  readonly baseDir?: string
  readonly port?: number
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly canaryFileNames?: readonly string[]
  readonly startProcess?: boolean
  readonly probeHost?: () => Promise<ReleaseHostIdentity | null>
}

export interface CandidateLab {
  readonly sandboxDir: string
  readonly homeDir: string
  readonly configDir: string
  readonly stateDir: string
  readonly cacheDir: string
  readonly tmpDir: string
  readonly port: number
  readonly canaryPaths: readonly string[]
  readonly childProcess: ReturnType<typeof Bun.spawn> | null
  readonly pid: number | null
  readonly startedAt: string | null
  readonly observe: () => Promise<ObservedCandidateState>
  readonly teardown: () => Promise<void>
}

export async function createCandidateLab(options: CandidateLabOptions): Promise<CandidateLab> {
  const baseTmp = options.baseDir ?? tmpdir()
  const sandboxDir = await mkdtemp(join(baseTmp, "candidate-lab-"))

  const homeDir = join(sandboxDir, "home")
  const configDir = join(sandboxDir, "config")
  const stateDir = join(sandboxDir, "state")
  const cacheDir = join(sandboxDir, "cache")
  const tmpDir = join(sandboxDir, "tmp")
  const canaryDir = join(sandboxDir, "canaries")

  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(tmpDir, { recursive: true }),
    mkdir(canaryDir, { recursive: true }),
  ])

  const canaryFileNames = options.canaryFileNames ?? ["protected-canary.txt"]
  const canaryPaths: string[] = []

  for (const name of canaryFileNames) {
    const canaryPath = join(canaryDir, name)
    await writeFile(canaryPath, `canary content for ${name}\n`)
    canaryPaths.push(canaryPath)
  }

  const initialCanaries = await snapshotCanaries(canaryPaths)
  const port = options.port ?? 40123

  const isolatedEnv: Record<string, string> = {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: stateDir,
    XDG_STATE_HOME: stateDir,
    XDG_CACHE_HOME: cacheDir,
    TMPDIR: tmpDir,
    PORT: String(port),
    ...options.env,
  }

  let childProcess: ReturnType<typeof Bun.spawn> | null = null
  let pid: number | null = null
  let startedAt: string | null = null

  const exeFile = Bun.file(options.executablePath)
  if (options.startProcess !== false && (await exeFile.exists())) {
    childProcess = Bun.spawn([options.executablePath, ...(options.args ?? [])], {
      cwd: sandboxDir,
      env: isolatedEnv,
      stdout: "pipe",
      stderr: "pipe",
    })
    pid = childProcess.pid
    startedAt = new Date().toISOString()
  }

  const observe = async (): Promise<ObservedCandidateState> => {
    return observeCandidate({
      executablePath: options.executablePath,
      pid,
      startedAt,
      serverUrl: `http://127.0.0.1:${port}`,
      initialCanaries,
      canaryPaths,
      probeHost: options.probeHost,
    })
  }

  const teardown = async (): Promise<void> => {
    if (childProcess) {
      try {
        childProcess.kill()
      } catch {
        // process may have already exited
      }
    }
    await rm(sandboxDir, { recursive: true, force: true })
  }

  return {
    sandboxDir,
    homeDir,
    configDir,
    stateDir,
    cacheDir,
    tmpDir,
    port,
    canaryPaths,
    childProcess,
    pid,
    startedAt,
    observe,
    teardown,
  }
}

export async function withCandidateLab<T>(
  options: CandidateLabOptions,
  fn: (lab: CandidateLab) => Promise<T>,
): Promise<T> {
  const lab = await createCandidateLab(options)
  try {
    return await fn(lab)
  } finally {
    await lab.teardown()
  }
}
