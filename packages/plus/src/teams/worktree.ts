import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Effect } from "effect"
import { read, type ProjectConfig } from "../project.js"
import { git, gitRaw } from "./git.js"
import { toolError } from "./schema.js"
import { lock } from "./store.js"
import { errCode, io } from "./io.js"

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

const EXCLUDE_LINE = "/.opencodeplus/"

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

// Keep the copied project.json invisible to git in that worktree, or every
// implementer's `team_finish` with status `done` fails `E_DIRTY` on the
// untracked file. The per-worktree exclude file lives under the linked
// worktree's own git dir (`<repo>/.git/worktrees/<name>/info/exclude`), never
// the repository `.gitignore` nor the main checkout's exclude. Failures are
// ignored: the worktree is still returned.
//
// git 2.47 reads `info/exclude` from the common dir (`rev-parse --git-path
// info/exclude` resolves to `<repo>/.git/info/exclude`) and ignores the
// per-worktree file, so the per-worktree file alone leaves `git status`
// dirty. Pointing the worktree's own `core.excludesFile` at it (via
// `extensions.worktreeConfig`) makes the same file effective without touching
// the shared exclude.
function ensureExclude(dir: string): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const gitDirRaw = yield* io(() => git(dir, ["rev-parse", "--git-dir"]))
      const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(dir, gitDirRaw)
      const infoDir = join(gitDir, "info")
      const excludePath = join(infoDir, "exclude")
      yield* io(() => mkdir(infoDir, { recursive: true }))
      const existing = yield* io(() => readFile(excludePath, "utf8")).pipe(
        Effect.catchIf((error) => errCode(error) === "ENOENT", () => Effect.succeed("")),
      )
      const lines = existing === "" ? [] : existing.split("\n")
      const present = lines.some((line) => line === EXCLUDE_LINE)
      if (!present) {
        const next =
          existing === ""
            ? `${EXCLUDE_LINE}\n`
            : existing.endsWith("\n")
              ? `${existing}${EXCLUDE_LINE}\n`
              : `${existing}\n${EXCLUDE_LINE}\n`
        yield* io(() => writeFile(excludePath, next, "utf8"))
      }
      yield* io(() => gitRaw(dir, ["config", "extensions.worktreeConfig", "true"])).pipe(Effect.asVoid)
      yield* io(() => gitRaw(dir, ["config", "--worktree", "core.excludesFile", excludePath])).pipe(Effect.asVoid)
    }).pipe(Effect.ignore),
  )
}

export async function create(root: string, opts: CreateOptions): Promise<Created> {
  const ts = stamp()
  const dir = join(opts.workspaceRoot, "worktrees", opts.repoKey, opts.role, `${opts.name}-${ts}`)
  const branch = `team/${opts.role}/${opts.name}-${ts}`
  return lock(root, "repo", opts.repoKey, async () => {
    const verify = await gitRaw(opts.repoRoot, ["rev-parse", "--verify", `${opts.base}^{commit}`])
    if (verify.code !== 0)
      throw toolError("E_BASE", `Unknown base "${opts.base}": ${verify.err || verify.out}`, "ocp-main")
    if (await exists(dir)) throw toolError("E_WT_EXISTS", `Worktree directory already exists: ${dir}`)
    await git(opts.repoRoot, ["worktree", "add", "-b", branch, dir, verify.out])
    const head = await git(dir, ["rev-parse", "HEAD"])
    await ensureProjectConfig(dir, opts.projectDirectory)
    await ensureExclude(dir)
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
    const extra = opts.force === true ? ["--force"] : []
    await git(opts.repoRoot, ["worktree", "remove", ...extra, dir])
  })
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

// Listed worktree paths (excluding the main checkout) not in `knownDirs`,
// compared by `realpath`.
export async function orphans(repoRoot: string, knownDirs: string[]): Promise<string[]> {
  const entries = await list(repoRoot)
  const mainReal = await real(repoRoot)
  const known = new Set<string>()
  for (const d of knownDirs) known.add(await real(d))
  const result: string[] = []
  let mainSkipped = false
  for (const [i, e] of entries.entries()) {
    const key = await real(e.path)
    if (!mainSkipped && (key === mainReal || i === 0)) {
      mainSkipped = true
      continue
    }
    if (!known.has(key)) result.push(e.path)
  }
  return result
}
