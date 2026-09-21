import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { Effect } from "effect"
import { read, type ProjectConfig } from "../project.js"
import { git, gitRaw } from "./git.js"
import { toolError } from "./schema.js"
import { lock } from "./store.js"
import { io } from "./io.js"

function exists(p: string): Promise<boolean> {
  return Effect.runPromise(
    io(() => stat(p)).pipe(
      Effect.as(true),
      Effect.catchIf(() => true, () => Effect.succeed(false)),
    ),
  )
}

function real(p: string): Promise<string> {
  return Effect.runPromise(io(() => realpath(p)).pipe(Effect.catchIf(() => true, () => Effect.succeed(p))))
}

// 3–10 lowercase alphanumerics: up to 6 chars from the hint plus the first
// 4 hex chars of the run id (`T1-probe` + `w-3f2a…` → `t1prob3f2a`).
export function slug(nameHint: string, runID: string): string {
  const base = nameHint.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "run"
  const hex = runID
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, 4)
    .padEnd(4, "0")
  return `${base}${hex}`
}

// `YYYYMMDD-HHMM` in local time.
export function stamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export interface CreateOptions {
  repoRoot: string
  repoKey: string
  role: string
  name: string
  base: string
  workspaceRoot: string
  projectDirectory: string
}

export interface Created {
  dir: string
  branch: string
  head: string
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return String(error)
}

// The child's worktree must be a Plus project or Plus never activates there
// and core cannot resolve the child's own role agent. When the checkout
// already carries `.opencodeplus/project.json` (the repository tracks it)
// the file is left alone; otherwise the parent's config is copied so the
// child inherits the user-controlled `protectedAgents` list verbatim,
// falling back to the default when the parent has none.
function ensureProjectConfig(dir: string, projectDirectory: string): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const target = join(dir, ".opencodeplus", "project.json")
      const present = yield* io(() => stat(target)).pipe(
        Effect.as(true),
        Effect.catchIf(() => true, () => Effect.succeed(false)),
      )
      if (present) return
      const parent = yield* io(() => read(projectDirectory)).pipe(
        Effect.catchIf(() => true, () => Effect.succeed(undefined)),
      )
      const config: ProjectConfig = parent ?? { version: 1, protectedAgents: [] }
      const payload = `${JSON.stringify(config, null, 2)}\n`
      yield* io(() => mkdir(join(dir, ".opencodeplus"), { recursive: true })).pipe(
        Effect.mapError((error) => toolError("E_PROJECT", `Cannot write Plus project config: ${messageOf(error)}`)),
      )
      yield* io(() => writeFile(target, payload, "utf8")).pipe(
        Effect.mapError((error) => toolError("E_PROJECT", `Cannot write Plus project config: ${messageOf(error)}`)),
      )
    }),
  )
}

// The one directory the team owns for a repository: every worktree `create`
// makes lives under it, and it is the only area `orphans` may report.
export function ownedRoot(workspaceRoot: string, repoKey: string): string {
  return join(workspaceRoot, "worktrees", repoKey)
}

export async function create(root: string, opts: CreateOptions): Promise<Created> {
  const ts = stamp()
  const dir = join(ownedRoot(opts.workspaceRoot, opts.repoKey), opts.role, `${opts.name}-${ts}`)
  const branch = `team/${opts.role}/${opts.name}-${ts}`
  return lock(root, "repo", opts.repoKey, async () => {
    const verify = await gitRaw(opts.repoRoot, ["rev-parse", "--verify", `${opts.base}^{commit}`])
    if (verify.code !== 0)
      throw toolError("E_BASE", `Unknown base "${opts.base}": ${verify.err || verify.out}`, "ocp-main")
    if (await exists(dir)) throw toolError("E_WT_EXISTS", `Worktree directory already exists: ${dir}`)
    await git(opts.repoRoot, ["worktree", "add", "-b", branch, dir, verify.out])
    const head = await git(dir, ["rev-parse", "HEAD"])
    await ensureProjectConfig(dir, opts.projectDirectory)
    return { dir, branch, head }
  })
}

export interface RemoveOptions {
  repoRoot: string
  repoKey: string
  force?: boolean
}

export async function remove(root: string, dir: string, opts: RemoveOptions): Promise<void> {
  if (!(await exists(dir))) return
  await lock(root, "repo", opts.repoKey, async () => {
    if (!(await exists(dir))) return
    await removeUntrackedPlusConfig(dir)
    const extra = opts.force === true ? ["--force"] : []
    await git(opts.repoRoot, ["worktree", "remove", ...extra, dir])
  })
}

// The Plus-written `.opencodeplus/project.json` is untracked and outside the
// worker's scope, so it would block a non-force `git worktree remove`.
// Delete it when untracked (a tracked copy is left alone) before removing.
function removeUntrackedPlusConfig(dir: string): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const tracked = yield* io(() => gitRaw(dir, ["ls-files", "--error-unmatch", "--", ".opencodeplus/project.json"]))
      if (tracked.code === 0) return
      yield* io(() => rm(join(dir, ".opencodeplus", "project.json"), { force: true })).pipe(Effect.ignore)
      yield* io(() => rm(join(dir, ".opencodeplus"), { recursive: false })).pipe(Effect.ignore)
    }).pipe(Effect.ignore),
  )
}

export interface WorktreeEntry {
  path: string
  head: string
  branch: string
  bare: boolean
  detached: boolean
  prunable: boolean
}

// Parse `git worktree list --porcelain`. Branch refs are shortened
// (`refs/heads/team/…` → `team/…`) to match the names `create` returns.
export async function list(repoRoot: string): Promise<WorktreeEntry[]> {
  const out = await git(repoRoot, ["worktree", "list", "--porcelain"])
  const entries: WorktreeEntry[] = []
  let cur: WorktreeEntry | undefined
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = {
        path: line.slice("worktree ".length),
        head: "",
        branch: "",
        bare: false,
        detached: false,
        prunable: false,
      }
      entries.push(cur)
      continue
    }
    if (cur === undefined) continue
    if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim()
      continue
    }
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim()
      cur.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
      continue
    }
    if (line === "bare") {
      cur.bare = true
      continue
    }
    if (line === "detached") {
      cur.detached = true
      continue
    }
    if (line.startsWith("prunable")) cur.prunable = true
  }
  return entries
}

// Listed worktree paths under `owned` (never the main checkout) that are not
// in `knownDirs`, compared by `realpath`. The boundary is taken as an argument
// rather than left to the caller because GC force-removes what this returns:
// a repository's other worktrees — a developer's own checkouts of it — are
// not the team's to delete.
export async function orphans(repoRoot: string, owned: string, knownDirs: string[]): Promise<string[]> {
  const entries = await list(repoRoot)
  const mainReal = await real(repoRoot)
  const ownedReal = await real(owned)
  const known = new Set<string>()
  for (const d of knownDirs) known.add(await real(d))
  const result: string[] = []
  for (const e of entries) {
    const key = await real(e.path)
    if (key === mainReal) continue
    if (!under(ownedReal, key)) continue
    if (!known.has(key)) result.push(e.path)
  }
  return result
}

function under(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}
