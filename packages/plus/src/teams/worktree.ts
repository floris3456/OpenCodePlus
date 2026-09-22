import { mkdir, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect } from "effect"
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
}

export interface Created {
  dir: string
  branch: string
  head: string
}

// The child's worktree carries no copied `.opencodeplus/project.json`: project
// mode resolves upward from the parent directory the run records as its
// `projectDirectory`, so the child inherits the parent's project while no
// second copy can drift. See project.ts and run.ts.
//
// The one directory the team owns for a repository: every worktree `create`
// makes lives under it, and it is the only area `orphans` may report.
export function ownedRoot(workspaceRoot: string, repoKey: string): string {
  return join(workspaceRoot, "worktrees", repoKey)
}

// The merge worktree area under ownedRoot: temporary worktrees created during
// merge operations live here (tempDirFor in merge.ts).
export function mergeArea(owned: string): string {
  return join(owned, "merge")
}

export async function create(root: string, opts: CreateOptions): Promise<Created> {
  return lock(root, "repo", opts.repoKey, () => createLocked(opts))
}

async function createLocked(opts: CreateOptions): Promise<Created> {
  const ts = stamp()
  // Resolve once, absolutely: the run record, the host's Location and git must
  // all name one directory even when the caller's workspace root is relative.
  const dir = resolve(ownedRoot(opts.workspaceRoot, opts.repoKey), opts.role, `${opts.name}-${ts}`)
  const branch = `team/${opts.role}/${opts.name}-${ts}`
  const verify = await gitRaw(opts.repoRoot, ["rev-parse", "--verify", `${opts.base}^{commit}`])
  if (verify.code !== 0)
    throw toolError("E_BASE", `Unknown base "${opts.base}": ${verify.err || verify.out}`, "ocp-main")
  if (await exists(dir)) throw toolError("E_WT_EXISTS", `Worktree directory already exists: ${dir}`)
  // A brand-new data root has no worktrees/ yet. Creating the parent chain
  // before git runs means the first delegate's directory exists as named, so
  // nothing that resolves it (the host's FileSystem.realPath, the writes
  // below) can miss it.
  await mkdir(dirname(dir), { recursive: true })
  await git(opts.repoRoot, ["worktree", "add", "-b", branch, dir, verify.out])
  const head = await git(dir, ["rev-parse", "HEAD"])
  // Hand back the canonical directory: the host realpaths the location it is
  // given, and a data root reached through a symlink would otherwise yield two
  // names for one worktree.
  return { dir: await real(dir), branch, head }
}

export interface Provisioned<T> {
  created: Created
  value: T
}

// `create` plus the caller's run registration in ONE repository-lock hold.
// The orphan sweep decides what it may remove under the same lock, so a
// worktree provisioning is still registering can never be observed without
// its run record and force-removed, and the host's `FileSystem.realPath` of
// the returned directory cannot fail. A caller that only calls `create`
// leaves that window open; `delegate` uses this.
export async function provision<T>(
  root: string,
  opts: CreateOptions,
  register: (created: Created) => Promise<T>,
): Promise<Provisioned<T>> {
  return lock(root, "repo", opts.repoKey, async () => {
    const created = await createLocked(opts)
    return { created, value: await register(created) }
  })
}

export interface RemoveOptions {
  repoRoot: string
  repoKey: string
  force?: boolean
}

// A plain `git worktree remove`: the child carries no Plus-written file, so
// there is nothing to delete first and nothing to special-case.
export async function remove(root: string, dir: string, opts: RemoveOptions): Promise<void> {
  if (!(await exists(dir))) return
  await lock(root, "repo", opts.repoKey, () => removeLocked(dir, opts))
}

// The body of `remove` without its repository lock. GC's orphan sweep already
// holds that lock while it decides and removes, so taking it again there would
// deadlock; every other caller goes through `remove`.
export async function removeLocked(dir: string, opts: RemoveOptions): Promise<void> {
  if (!(await exists(dir))) return
  const extra = opts.force === true ? ["--force"] : []
  await git(opts.repoRoot, ["worktree", "remove", ...extra, dir])
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

export interface OrphanOptions {
  /** Worktrees younger than this are treated as owned. A directory mid-
   * provision has no run record yet — `create` finished but the caller has not
   * registered the run — so the sweep must not judge it an orphan. */
  minAgeMs?: number
}

// Listed worktree paths under `owned` (never the main checkout) that are not
// in `knownDirs`, compared by `realpath`. The boundary is taken as an argument
// rather than left to the caller because GC force-removes what this returns:
// a repository's other worktrees — a developer's own checkouts of it — are
// not the team's to delete.
export async function orphans(
  repoRoot: string,
  owned: string,
  knownDirs: string[],
  opts?: OrphanOptions,
): Promise<string[]> {
  const entries = await list(repoRoot)
  const mainReal = await real(repoRoot)
  const ownedReal = await real(owned)
  const mergeReal = await real(mergeArea(ownedReal))
  const known = new Set<string>()
  for (const d of knownDirs) known.add(await real(d))
  const result: string[] = []
  for (const e of entries) {
    const key = await real(e.path)
    if (key === mainReal) continue
    if (!under(ownedReal, key)) continue
    // A live merge worktree is owned by the merge in flight, not by a run record.
    if (key === mergeReal || under(mergeReal, key)) continue
    if (known.has(key)) continue
    if (opts?.minAgeMs !== undefined && (await youngerThan(e.path, opts.minAgeMs))) continue
    result.push(e.path)
  }
  return result
}

function youngerThan(dir: string, minAgeMs: number): Promise<boolean> {
  return Effect.runPromise(
    io(() => stat(dir)).pipe(
      Effect.map((info) => Date.now() - info.mtimeMs < minAgeMs),
      Effect.catchIf(() => true, () => Effect.succeed(false)),
    ),
  )
}

function under(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}
