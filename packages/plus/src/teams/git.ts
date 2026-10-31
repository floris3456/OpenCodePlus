import { mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { io } from "./io.js"

// Always include the standard system bin dirs so a spawned `git` resolves
// regardless of the caller's ambient PATH (stripped PATHs caused
// `posix_spawn 'git'` failures). Nothing machine-specific is assumed, so an
// installed release carries no workspace directory.
export function systemPath(): string {
  return [process.env.PATH, "/usr/bin", "/bin"].filter(Boolean).join(":")
}

// Team worktrees share one repository, so a task executor can write the
// repository-local git config — hooks, `core.fsmonitor`, `commit.gpgSign` — and a
// later host-plane git command would run that program as the host, outside every
// placement boundary. `-c` outranks repository config, and each value cannot be
// redirected by the executor: `/dev/null` can never be a directory, and `false`
// disables the feature outright. Add a key here only once a canary proves git
// spawns it for one of our subcommands; `packages/core/src/git.ts` carries the
// same list as its own copy because it cannot import plugin code.
export const NO_REPOSITORY_PROGRAMS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
]

export interface GitResult {
  code: number
  out: string
  err: string
}

// Non-throwing variant: captures exit code, trimmed stdout and trimmed stderr.
export async function gitRaw(dir: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
  const r = await spawnGit(dir, args, env)
  return { code: r.code, out: r.out.trim(), err: r.err.trim() }
}

// Throwing variant with stdout untrimmed: a -z list is NUL-terminated, and
// trimming would eat the first record's status space and a path's own
// leading or trailing spaces.
export async function gitPlain(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await spawnGit(dir, args, env)
  if (r.code !== 0) throw new Error(r.err.trim() || r.out.trim() || `git ${args.join(" ")} exited ${r.code}`)
  return r.out
}

// Untrimmed stdout with its exit code: patch text ends in content lines whose
// trailing spaces and newline are part of the patch.
export async function gitBytes(dir: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
  const r = await spawnGit(dir, args, env)
  return { code: r.code, out: r.out, err: r.err.trim() }
}

async function spawnGit(dir: string, args: string[], env: Record<string, string>): Promise<GitResult> {
  const p = Bun.spawn(["git", ...args], {
    cwd: dir,
    env: { ...process.env, PATH: systemPath(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}

// Throwing variant: rejects with the stderr text on non-zero exit,
// resolves with trimmed stdout otherwise.
export async function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await gitRaw(dir, args, env)
  if (r.code !== 0) throw new Error(r.err || r.out || `git ${args.join(" ")} exited ${r.code}`)
  return r.out
}

export const PLUS_PROJECT_FILE = ".opencodeplus/project.json"

export interface SavedPatch {
  file: string
  files: number
  bytes: number
  skipped: string[]
}

// A patch is a convenience for a parent whose child stopped without a report,
// not an archive: one large vendored tree must not fill the data directory.
const PATCH_MAX_BYTES = 50 * 1024 * 1024
const PATCH_FILE_MAX_BYTES = 5 * 1024 * 1024

/**
 * Writes the uncommitted work of a worktree into one binary patch: the tracked
 * changes (`git diff HEAD`, staged or not) and each untracked file through
 * `--no-index /dev/null <path>`. The index and the worktree are read only, so
 * the child's state is exactly what it was. Undefined for a clean worktree.
 * Untracked files under `node_modules/` or over 5 MB are skipped, and the patch
 * stops adding files at 50 MB; both are named in `skipped`.
 */
export async function savePatch(directory: string, file: string): Promise<SavedPatch | undefined> {
  const status = await gitRaw(directory, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"])
  if (status.code !== 0) throw new Error(status.err || `git status exited ${status.code}`)
  if (parsePorcelain(status.out).length === 0) return undefined

  const tracked = await gitPlain(directory, [...NO_REPOSITORY_PROGRAMS, "diff", "--binary", "HEAD"])
  const trackedFiles =
    tracked === ""
      ? []
      : (await gitPlain(directory, [...NO_REPOSITORY_PROGRAMS, "diff", "--name-only", "--no-renames", "-z", "HEAD"]))
          .split("\0")
          .filter(Boolean)
  const untracked = (await gitPlain(directory, [...NO_REPOSITORY_PROGRAMS, "ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)

  // Every piece ends in its own newline; the next header must start a line.
  const pieces = tracked === "" ? [] : [tracked.endsWith("\n") ? tracked : `${tracked}\n`]
  const skipped: string[] = []
  let bytes = pieces.reduce((total, piece) => total + Buffer.byteLength(piece, "utf8"), 0)
  let files = trackedFiles.length
  for (const name of untracked) {
    if (name.split("/").includes("node_modules") || (await patchTooLarge(directory, name))) {
      skipped.push(name)
      continue
    }
    const piece = await gitBytes(directory, [...NO_REPOSITORY_PROGRAMS, "diff", "--binary", "--no-index", "--", "/dev/null", name])
    // --no-index reports a difference as exit 1, which is the normal case here.
    if (piece.code !== 0 && piece.code !== 1) throw new Error(piece.err || `git diff --no-index ${name} exited ${piece.code}`)
    const text = piece.out.endsWith("\n") ? piece.out : `${piece.out}\n`
    const size = Buffer.byteLength(text, "utf8")
    if (bytes + size > PATCH_MAX_BYTES) {
      skipped.push(name)
      continue
    }
    pieces.push(text)
    bytes += size
    files++
  }

  const content = pieces.join("")
  await Effect.runPromise(
    io(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content, { mode: 0o600 })
    }),
  )
  return { file, files, bytes, skipped }
}

async function patchTooLarge(directory: string, name: string): Promise<boolean> {
  return Effect.runPromise(
    io(() => stat(path.join(directory, name))).pipe(
      Effect.map((info) => info.size > PATCH_FILE_MAX_BYTES),
      Effect.catchIf(() => true, () => Effect.succeed(false)),
    ),
  )
}

export function parsePorcelain(out: string): string[] {
  const trimmed = out.trim()
  if (trimmed === "") return []
  const files: string[] = []
  for (const line of trimmed.split("\n")) {
    if (line.trim() === "") continue
    const match = /^(.{1,2}) (.+)$/.exec(line)
    if (match === null) continue
    const raw = match[2]?.trim() ?? ""
    if (raw === "") continue
    const arrow = raw.indexOf(" -> ")
    const picked = arrow < 0 ? raw : raw.slice(arrow + 4).trim()
    if (picked === "") continue
    const file = picked.length >= 2 && picked.startsWith('"') && picked.endsWith('"') ? picked.slice(1, -1) : picked
    if (match[1]?.trim() === "??" && file === PLUS_PROJECT_FILE) continue
    files.push(file)
  }
  files.sort()
  return files
}
