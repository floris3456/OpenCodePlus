import { join } from "node:path"

export class InventoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InventoryError"
  }
}

export class MissingRefError extends InventoryError {
  readonly ref: string

  constructor(ref: string, message?: string) {
    super(message ?? `Git reference '${ref}' not found or invalid`)
    this.name = "MissingRefError"
    this.ref = ref
  }
}

export interface CommitCounts {
  ahead: number
  behind: number
}

export interface UpstreamInventoryReport {
  baseRef: string
  compareRef: string
  mergeBase: string
  ahead: number
  behind: number
  commitCounts: CommitCounts
  forkFiles: string[]
  forkChangedFiles: string[]
  groupedByPackage: Record<string, string[]>
  byPackage: Record<string, string[]>
  coreTouch: string[]
  coreTouchFiles: string[]
  upstreamFiles: string[]
}

export interface UpstreamInventoryOptions {
  baseRef?: string
  base?: string
  compareRef?: string
  compare?: string
  comparisonRef?: string
  targetRef?: string
  repoDir?: string
  repositoryDirectory?: string
  outputPath?: string
  output?: string
}

interface GitCommandResult {
  code: number
  stdout: string
  stderr: string
}

async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  const envPath = [
    process.env.OCP_ROOT ? join(process.env.OCP_ROOT, "bin") : "",
    process.env.PATH,
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .join(":")

  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, PATH: envPath },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return {
    code,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  }
}

async function resolveCommit(cwd: string, ref: string, role: string): Promise<string> {
  if (!ref || ref.trim() === "") {
    throw new MissingRefError(ref, `${role} reference must not be empty`)
  }

  const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
  if (result.code !== 0 || !result.stdout) {
    throw new MissingRefError(ref, `${role} reference '${ref}' does not exist or does not resolve to a commit`)
  }

  return result.stdout
}

export function getPackageForFile(filePath: string, repoDir?: string): string {
  const normalized = filePath.replace(/\\/g, "/")
  const segments = normalized.split("/")

  if (segments.length <= 1 || segments[0].startsWith(".")) {
    return "root"
  }

  if (segments[0] === "packages" && (segments[1] === "console" || segments[1] === "stats") && segments.length > 2) {
    return `${segments[0]}/${segments[1]}/${segments[2]}`
  }

  if ((segments[0] === "packages" || segments[0] === "services") && segments.length > 1) {
    return `${segments[0]}/${segments[1]}`
  }

  if (repoDir && segments.length > 1) {
    for (let i = segments.length - 1; i >= 1; i--) {
      const candidateDir = segments.slice(0, i).join("/")
      const packageJsonPath = join(repoDir, candidateDir, "package.json")
      if (Bun.file(packageJsonPath).size > 0) {
        return candidateDir
      }
    }
  }

  if (segments[0] === "script" || segments[0] === "docs" || segments[0] === "infra" || segments[0] === "patches") {
    return "root"
  }

  return segments[0]
}

export function groupFilesByPackage(files: string[], repoDir?: string): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const file of files) {
    const pkg = getPackageForFile(file, repoDir)
    if (!grouped[pkg]) {
      grouped[pkg] = []
    }
    grouped[pkg].push(file)
  }

  for (const pkg of Object.keys(grouped)) {
    grouped[pkg].sort()
  }

  return grouped
}

function parseNullTerminatedPaths(stdout: string): string[] {
  if (!stdout) return []
  return stdout
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
}

export async function upstreamInventory(
  baseOrOptions: string | UpstreamInventoryOptions,
  compareRefArg?: string,
  repoDirArg?: string,
  outputPathArg?: string,
): Promise<UpstreamInventoryReport> {
  const options: UpstreamInventoryOptions =
    typeof baseOrOptions === "string"
      ? {
          baseRef: baseOrOptions,
          compareRef: compareRefArg,
          repoDir: repoDirArg,
          outputPath: outputPathArg,
        }
      : baseOrOptions

  const baseRef = options.baseRef ?? options.base
  const compareRef = options.compareRef ?? options.compare ?? options.comparisonRef ?? options.targetRef
  const repoDir = options.repoDir ?? options.repositoryDirectory ?? process.cwd()
  const outputPath = options.outputPath ?? options.output

  if (!baseRef) {
    throw new MissingRefError(baseRef ?? "", "Base reference is required")
  }
  if (!compareRef) {
    throw new MissingRefError(compareRef ?? "", "Comparison reference is required")
  }

  const baseSha = await resolveCommit(repoDir, baseRef, "Base")
  const compareSha = await resolveCommit(repoDir, compareRef, "Comparison")

  const mbResult = await runGit(repoDir, ["merge-base", baseSha, compareSha])
  if (mbResult.code !== 0 || !mbResult.stdout) {
    throw new InventoryError(`No merge base found between '${baseRef}' (${baseSha}) and '${compareRef}' (${compareSha})`)
  }
  const mergeBase = mbResult.stdout

  const countResult = await runGit(repoDir, ["rev-list", "--left-right", "--count", `${baseSha}...${compareSha}`])
  if (countResult.code !== 0) {
    throw new InventoryError(`Failed to count commits between '${baseRef}' and '${compareRef}': ${countResult.stderr}`)
  }
  const countParts = countResult.stdout.split(/\s+/)
  const behind = Number.parseInt(countParts[0] ?? "0", 10)
  const ahead = Number.parseInt(countParts[1] ?? "0", 10)

  const forkDiffResult = await runGit(repoDir, ["diff", "--name-only", "-z", mergeBase, compareSha])
  if (forkDiffResult.code !== 0) {
    throw new InventoryError(`Failed to list changed files for '${compareRef}': ${forkDiffResult.stderr}`)
  }
  const forkFiles = parseNullTerminatedPaths(forkDiffResult.stdout)

  const upstreamDiffResult = await runGit(repoDir, ["diff", "--name-only", "-z", mergeBase, baseSha])
  if (upstreamDiffResult.code !== 0) {
    throw new InventoryError(`Failed to list changed files for '${baseRef}': ${upstreamDiffResult.stderr}`)
  }
  const upstreamFiles = parseNullTerminatedPaths(upstreamDiffResult.stdout)

  const upstreamSet = new Set(upstreamFiles)
  const coreTouch = forkFiles.filter((file) => upstreamSet.has(file)).sort()

  const groupedByPackage = groupFilesByPackage(forkFiles, repoDir)

  const report: UpstreamInventoryReport = {
    baseRef,
    compareRef,
    mergeBase,
    ahead,
    behind,
    commitCounts: { ahead, behind },
    forkFiles,
    forkChangedFiles: forkFiles,
    groupedByPackage,
    byPackage: groupedByPackage,
    coreTouch,
    coreTouchFiles: coreTouch,
    upstreamFiles,
  }

  if (outputPath) {
    await Bun.write(outputPath, JSON.stringify(report, null, 2) + "\n")
  }

  return report
}

function parseCliArgs(args: string[]): {
  baseRef?: string
  compareRef?: string
  repoDir?: string
  outputPath?: string
} {
  const result: {
    baseRef?: string
    compareRef?: string
    repoDir?: string
    outputPath?: string
  } = {}

  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--base" || arg === "-b") {
      result.baseRef = args[++i]
      continue
    }
    if (arg.startsWith("--base=")) {
      result.baseRef = arg.slice(7)
      continue
    }
    if (arg === "--compare" || arg === "--comparison" || arg === "-c") {
      result.compareRef = args[++i]
      continue
    }
    if (arg.startsWith("--compare=")) {
      result.compareRef = arg.slice(10)
      continue
    }
    if (arg.startsWith("--comparison=")) {
      result.compareRef = arg.slice(13)
      continue
    }
    if (arg === "--repo" || arg === "-r") {
      result.repoDir = args[++i]
      continue
    }
    if (arg.startsWith("--repo=")) {
      result.repoDir = arg.slice(7)
      continue
    }
    if (arg === "--output" || arg === "-o") {
      result.outputPath = args[++i]
      continue
    }
    if (arg.startsWith("--output=")) {
      result.outputPath = arg.slice(9)
      continue
    }
    if (!arg.startsWith("-")) {
      positional.push(arg)
    }
  }

  if (!result.baseRef && positional.length > 0) {
    result.baseRef = positional[0]
  }
  if (!result.compareRef && positional.length > 1) {
    result.compareRef = positional[1]
  }
  if (!result.repoDir && positional.length > 2) {
    result.repoDir = positional[2]
  }
  if (!result.outputPath && positional.length > 3) {
    result.outputPath = positional[3]
  }

  return result
}

if (import.meta.main) {
  const rawArgs = process.argv.slice(2)
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(`Usage: bun upstream-inventory.ts [options] [baseRef] [compareRef] [repoDir] [outputPath]

Read-only upstream divergence and core-touch inventory tool.

Options:
  --base, -b <ref>       Base / upstream reference (required)
  --compare, -c <ref>    Comparison / fork reference (required)
  --repo, -r <dir>       Repository directory (defaults to current working directory)
  --output, -o <file>    Output JSON destination path
  --help, -h             Show help message
`)
    process.exit(0)
  }

  const parsed = parseCliArgs(rawArgs)
  if (!parsed.baseRef || !parsed.compareRef) {
    console.error("Error: both baseRef and compareRef are required")
    process.exit(1)
  }

  const report = await upstreamInventory({
    baseRef: parsed.baseRef,
    compareRef: parsed.compareRef,
    repoDir: parsed.repoDir ?? process.cwd(),
    outputPath: parsed.outputPath,
  }).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })

  console.log(JSON.stringify(report, null, 2))
}
