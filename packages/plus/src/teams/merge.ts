import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { atomicJson, lock, readJson, ulid } from "./store.js"
import { git, gitPlain, gitRaw } from "./git.js"
import { computePolicyDigest, execute, passingReceipt, reuseReceipt, type Receipt } from "./checks.js"
import { reworkTask } from "./tasks.js"
import { loadRun } from "./run.js"
import { NO_REPOSITORY_PROGRAMS } from "./worktree.js"
import { isExpectedHead, PATH_LIST_LIMIT, pathList, toolError } from "./schema.js"
import type { Check, MergeState } from "./schema.js"
import { errCode, io } from "./io.js"

export interface MergeEntry {
  id: string
  parentRun: string
  childRun: string
  childBranch: string
  childHead: string
  expectedParentHead: string
  state: MergeState
  conflictFiles?: string[]
  redChecks?: string[]
  /** Historical entries used this flag when pre-existing failures blocked landing. */
  redAtParent?: boolean
  /** Other assigned checks that already fail without this landing. */
  stillRed?: string[]
  reusedChecks?: { id: string; reused: true; at: number }[]
  landedHead?: string
  reworkTask?: string
  at: string
  updatedAt: string
}

export interface EnqueueInput {
  parentRun: string
  parentWorktree: string
  childRun: string
  childBranch: string
  childHead: string
  /** Omitted or "HEAD": whatever the parent's HEAD is; otherwise a full or short commit it must be. */
  expectedParentHead?: string
}

// Typed seam for the tools layer: the merge queue never spawns sessions or
// reaches for a host/MCP client. Check verification runs through checks.ts
// and rework creation through tasks.ts; the caller supplies repo placement
// here.
export interface MergeContext {
  repoRoot: string
  repoKey: string
  workspaceRoot: string
  parentWorktree: string
  checks: Check[]
}

export interface DrainResult {
  processed: MergeEntry[]
  paused: boolean
}

interface QueueMeta {
  paused: boolean
  updatedAt: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function mergeDir(root: string, parentRun: string): string {
  return join(root, "runs", parentRun, "merge")
}

function entryPath(root: string, parentRun: string, id: string): string {
  return join(mergeDir(root, parentRun), `${id}.json`)
}

function queueMetaPath(root: string, parentRun: string): string {
  return join(mergeDir(root, parentRun), "_queue.json")
}

function saveEntry(root: string, entry: MergeEntry): Promise<void> {
  return atomicJson(entryPath(root, entry.parentRun, entry.id), entry)
}

function writeQueueMeta(root: string, parentRun: string, paused: boolean): Promise<void> {
  const meta: QueueMeta = { paused, updatedAt: nowIso() }
  return atomicJson(queueMetaPath(root, parentRun), meta)
}

export function readQueueMeta(root: string, parentRun: string): Promise<QueueMeta | undefined> {
  return readJson<QueueMeta>(queueMetaPath(root, parentRun))
}

function getHead(dir: string): Promise<string> {
  return git(dir, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
}

/**
 * Tracked modifications only: ignore untracked (`??`) entries. Read with -z
 * so paths arrive unquoted, matching changedPaths; a rename or copy record is
 * `XY new\0old\0` and names both sides.
 */
async function trackedDirtyFiles(worktree: string): Promise<string[]> {
  const out = await gitPlain(worktree, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-z"])
  const records = out.split("\0")
  const files: string[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? ""
    if (record.length < 4) continue
    const status = record.slice(0, 2)
    if (status.trim() === "??") continue
    const path = record.slice(3)
    // A rename or copy carries the source path in the next record.
    const sides = status.includes("R") || status.includes("C") ? [path, records[++i] ?? ""] : [path]
    for (const file of sides) if (file !== "" && !files.includes(file)) files.push(file)
  }
  return files
}

/** Paths a landing from `from` to `to` would change; with --no-renames a rename is both paths. */
async function changedPaths(worktree: string, from: string, to: string): Promise<string[]> {
  const out = await gitPlain(worktree, [...NO_REPOSITORY_PROGRAMS, "diff", "--name-only", "--no-renames", "-z", from, to])
  return out.split("\0").filter(Boolean)
}

/** The parent's uncommitted files that a landing of `from`..`to` would touch. */
function overlap(dirty: readonly string[], changed: readonly string[]): string[] {
  const landing = new Set(changed)
  return dirty.filter((file) => landing.has(file))
}

/**
 * Uncommitted files in the parent's checkout that landing `childHead` onto
 * `parentHead` would touch: exactly the ones git refuses to fast-forward over.
 */
async function landingOverlap(
  worktree: string,
  parentHead: string,
  childHead: string,
  dirty: readonly string[],
): Promise<string[]> {
  if (dirty.length === 0) return []
  const base = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "merge-base", parentHead, childHead])
  return overlap(dirty, await changedPaths(worktree, base, childHead))
}

/**
 * Untracked files in the parent's checkout that a landing from `from` to `to`
 * would write, which git refuses to fast-forward over. One whose exact content
 * the landing's own commits hold is safe to replace: live, a planner's
 * uncommitted plan, attached to its Brief, was saved and committed by the
 * child as it was. Any other is the parent's own work.
 */
async function untrackedCollisions(worktree: string, from: string, to: string): Promise<{ safe: string[]; unsafe: string[] }> {
  const top = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--show-toplevel"])
  const added = (await git(top, [...NO_REPOSITORY_PROGRAMS, "diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", from, to])).split("\0").filter(Boolean)
  if (added.length === 0) return { safe: [], unsafe: [] }
  const untracked = new Set(
    (await git(top, [...NO_REPOSITORY_PROGRAMS, "--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ...added])).split("\0").filter(Boolean),
  )
  const colliding = added.filter((file) => untracked.has(file))
  if (colliding.length === 0) return { safe: [], unsafe: [] }
  const raw = await git(top, [...NO_REPOSITORY_PROGRAMS, "--literal-pathspecs", "log", "--format=", "--raw", "--no-abbrev", "--no-renames", `${from}..${to}`, "--", ...colliding])
  const held = new Set(raw.split("\n").flatMap((line) => (line.startsWith(":") ? [line.split(/\s+/)[3] ?? ""] : [])))
  const hashes = await Promise.all(colliding.map((file) => git(top, [...NO_REPOSITORY_PROGRAMS, "hash-object", "--", join(top, file)])))
  return {
    safe: colliding.filter((_, index) => held.has(hashes[index] ?? "")),
    unsafe: colliding.filter((_, index) => !held.has(hashes[index] ?? "")),
  }
}

function withRepoLock<T>(root: string, ctx: MergeContext, fn: () => Promise<T>): Promise<T> {
  return lock(root, "repo", ctx.repoKey, fn)
}

function tempDirFor(ctx: MergeContext, parentRun: string, entryID: string): string {
  const base = `${parentRun}-${Date.now()}`
  return join(ctx.workspaceRoot, "worktrees", ctx.repoKey, "merge", base + `-${entryID.slice(-4)}`)
}

async function removeTemp(root: string, ctx: MergeContext, dir: string): Promise<void> {
  await withRepoLock(root, ctx, async () => {
    const r = await gitRaw(ctx.repoRoot, [...NO_REPOSITORY_PROGRAMS, "worktree", "remove", "--force", dir])
    if (r.code !== 0) {
      await Effect.runPromise(Effect.ignore(io(() => rm(dir, { recursive: true, force: true }))))
      await Effect.runPromise(
        Effect.ignore(io(() => gitRaw(ctx.repoRoot, [...NO_REPOSITORY_PROGRAMS, "worktree", "prune"]).then(() => undefined))),
      )
    }
  })
}

async function copyReceipts(
  root: string,
  runID: string,
  checks: Check[],
  passed: Receipt[],
  toHead: string,
): Promise<void> {
  const dir = join(root, "runs", runID, "receipts")
  for (const check of checks) {
    const receipt = passed.find((item) => commandKey(item) === commandKey(check))
    if (receipt === undefined) continue
    const toStem = `${check.id}-${toHead.slice(0, 7)}`
    const outputPath = join(dir, `${toStem}.log`)
    await Effect.runPromise(io(() => mkdir(dir, { recursive: true })))
    await atomicJson(join(dir, `${toStem}.json`), { ...receipt, id: check.id, head: toHead, policyDigest: computePolicyDigest(check), outputPath })
    if (receipt.outputPath !== outputPath) await copyFile(receipt.outputPath, outputPath)
  }
}

function commandKey(check: { readonly argv: readonly string[]; readonly cwd?: string }): string {
  return JSON.stringify([check.cwd ?? "", check.argv])
}

function listMergeFiles(root: string, parentRun: string): Promise<string[] | undefined> {
  return Effect.runPromise(
    io(() => readdir(mergeDir(root, parentRun))).pipe(
      Effect.catchIf((error) => errCode(error) === "ENOENT", () => Effect.succeed(undefined)),
    ),
  )
}

/** All entries for a parent, oldest first. */
export async function queue(root: string, parentRun: string): Promise<MergeEntry[]> {
  const files = await listMergeFiles(root, parentRun)
  if (files === undefined) return []
  const out: MergeEntry[] = []
  for (const f of files) {
    if (!f.endsWith(".json")) continue
    if (f.startsWith("_")) continue
    const e = await readJson<MergeEntry>(join(mergeDir(root, parentRun), f))
    if (e !== undefined) out.push(e)
  }
  out.sort((a, b) => {
    if (a.at < b.at) return -1
    if (a.at > b.at) return 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return out
}

/** Entries still waiting to be processed. */
export async function pending(root: string, parentRun: string): Promise<MergeEntry[]> {
  return (await queue(root, parentRun)).filter((e) => e.state === "pending")
}

export async function enqueue(root: string, input: EnqueueInput): Promise<MergeEntry> {
  return lock(root, "state", `merge:${input.parentRun}`, async () => {
    const parentHead = await getHead(input.parentWorktree)
    if (!isExpectedHead(parentHead, input.expectedParentHead))
      throw toolError(
        "E_STALE_PARENT",
        `Your HEAD is ${parentHead}; pass it as expectedParentHead or omit it (never the child's commit).`,
        parentHead,
      )
    const dirty = await trackedDirtyFiles(input.parentWorktree)
    // Only uncommitted files the child's own commits change would make git
    // refuse the fast-forward; the rest of the parent's work stays as it is.
    const touched = await landingOverlap(input.parentWorktree, parentHead, input.childHead, dirty)
    if (touched.length > 0)
      throw toolError(
        "E_DIRTY",
        `Your worktree has uncommitted changes to [${pathList(touched)}], which ${input.childRun}'s commits also change; commit or discard them, then integrate again. Your other uncommitted files stay as they are.`,
        touched.slice(0, PATH_LIST_LIMIT),
      )
    const collisions = await untrackedCollisions(input.parentWorktree, parentHead, input.childHead)
    if (collisions.unsafe.length > 0)
      throw toolError(
        "E_DIRTY",
        `Untracked [${pathList(collisions.unsafe)}] in your worktree would be overwritten: ${input.childRun}'s commits add another version. Remove yours if the child's replaces it, or commit it with team_checkpoint to keep it (the child's version then conflicts), then integrate again.`,
        collisions.unsafe.slice(0, PATH_LIST_LIMIT),
      )
    const existing = await queue(root, input.parentRun)
    const landed = existing.find((e) => e.childRun === input.childRun && e.childBranch === input.childBranch && e.state === "landed")
    if (landed !== undefined) {
      const sha = landed.landedHead ?? landed.childHead
      throw toolError("E_ALREADY", `Child ${input.childRun} is already landed at ${sha}.`, sha)
    }
    const now = nowIso()
    const entry: MergeEntry = {
      id: ulid(),
      parentRun: input.parentRun,
      childRun: input.childRun,
      childBranch: input.childBranch,
      childHead: input.childHead,
      expectedParentHead: parentHead,
      state: "pending",
      at: now,
      updatedAt: now,
    }
    await saveEntry(root, entry)
    await writeQueueMeta(root, input.parentRun, false)
    return entry
  })
}

function conflictEntry(cur: MergeEntry, conflictFiles: string[], reworkId: string): MergeEntry {
  return { ...cur, state: "conflict", conflictFiles, reworkTask: reworkId, updatedAt: nowIso() }
}

function redEntry(cur: MergeEntry, redIds: string[], reworkId: string): MergeEntry {
  return { ...cur, state: "red", redChecks: redIds, reworkTask: reworkId, updatedAt: nowIso() }
}

async function findPlanForTask(root: string, taskID: string): Promise<string | undefined> {
  const dir = join(root, "tasks")
  const entries = await readdir(dir).catch(() => [] as string[])
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue
    const graph = await readJson<{ tasks?: Record<string, unknown> }>(join(dir, name))
    if (graph?.tasks !== undefined && Object.hasOwn(graph.tasks, taskID)) return name.slice(0, -5)
  }
  return undefined
}

async function resolveTaskIdentity(
  root: string,
  childRunID: string,
): Promise<{ planRun: string; taskID: string }> {
  const child = await loadRun(root, childRunID).catch(() => undefined)
  if (child === undefined || child.task === null) {
    return { planRun: childRunID, taskID: childRunID }
  }
  const found = await findPlanForTask(root, child.task)
  return {
    planRun: found ?? childRunID,
    taskID: child.task,
  }
}

/**
 * Walk 02 §4 for a single entry. Never touches the parent worktree on the
 * conflict or red paths; only the landing step runs `merge --ff-only` there.
 * The temp worktree is removed on every path via an Effect ensuring clause.
 */
export async function process(root: string, entry: MergeEntry, ctx: MergeContext): Promise<MergeEntry> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const taskIdentity = yield* io(() => resolveTaskIdentity(root, entry.childRun))
      const rebaseBase = yield* io(() => getHead(ctx.parentWorktree))
      // The queue already records which children landed; checks need no second
      // registry. Group by command AND directory, retaining child ownership.
      const landed = yield* io(() => queue(root, entry.parentRun))
      const sources = yield* io(() =>
        Promise.all(
          [...new Set([entry.childRun, ...landed.filter((item) => item.state === "landed").map((item) => item.childRun)])].map(async (runID) => ({
            runID,
            checks: (await readJson<Check[]>(join(root, "runs", runID, "checks.json"))) ?? [],
          })),
        ),
      )
      const groups = new Map<string, { check: Check; runID: string; own: boolean; bindings: { check: Check; runID: string }[] }>()
      for (const source of [{ runID: entry.parentRun, checks: ctx.checks }, ...sources]) {
        for (const check of source.checks) {
          const key = commandKey(check)
          const previous = groups.get(key)
          groups.set(key, {
            check: previous?.check ?? check,
            runID: previous?.runID ?? source.runID,
            own: previous?.own === true || source.runID === entry.childRun,
            bindings: [...(previous?.bindings ?? []), { check, runID: source.runID }],
          })
        }
      }
      let cur: MergeEntry = { ...entry, state: "rebasing", updatedAt: nowIso() }
      yield* io(() => saveEntry(root, cur))
      const tempDir = tempDirFor(ctx, entry.parentRun, entry.id)
      yield* io(() => withRepoLock(root, ctx, () => git(ctx.repoRoot, [...NO_REPOSITORY_PROGRAMS, "worktree", "add", "--detach", tempDir, entry.childHead])))
      const inner = Effect.gen(function* () {
        // 1. rebasing
        const rb = yield* io(() => gitRaw(tempDir, [...NO_REPOSITORY_PROGRAMS, "rebase", rebaseBase]))
        if (rb.code !== 0) {
          const diff = yield* io(() => gitRaw(tempDir, [...NO_REPOSITORY_PROGRAMS, "diff", "--name-only", "--diff-filter=U"]))
          const conflictFiles = diff.out
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s !== "")
          yield* io(() => gitRaw(tempDir, [...NO_REPOSITORY_PROGRAMS, "rebase", "--abort"]).then(() => undefined))
          const reworkId = yield* io(() => reworkTask(root, taskIdentity.planRun, taskIdentity.taskID, conflictFiles, sources.find((source) => source.runID === entry.childRun)?.checks ?? []))
          cur = conflictEntry(cur, conflictFiles, reworkId)
          yield* io(() => saveEntry(root, cur))
          return cur
        }
        // 2. Verify the combined change, then compare only other red checks
        // against the parent. The landing child's own checks must always pass.
        cur = { ...cur, state: "verifying", updatedAt: nowIso() }
        yield* io(() => saveEntry(root, cur))
        const rebasedTip = yield* io(() => getHead(tempDir))
        const tree = yield* io(() => git(tempDir, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD^{tree}"]))
        const passed: Receipt[] = []
        const redChecks: Check[] = []
        const compare: { check: Check; runID: string }[] = []
        const stillRed: string[] = []
        const reusedChecks: NonNullable<MergeEntry["reusedChecks"]> = []
        for (const group of groups.values()) {
          // Validate the original definition before mapping command aliases,
          // just as copyReceipts maps one executed command to parent aliases.
          const receipts = yield* io(() => Promise.all(group.bindings.map((binding) =>
            passingReceipt(root, [entry.childRun, entry.parentRun, binding.runID], binding.check, { head: rebasedTip, tree }),
          )))
          const receipt = receipts.find((item) => item !== undefined)
          if (receipt !== undefined) {
            passed.push(yield* io(() => reuseReceipt(root, group.runID, { ...receipt, id: group.check.id, policyDigest: computePolicyDigest(group.check) }, { head: rebasedTip, tree })))
            reusedChecks.push({ id: group.check.id, reused: true, at: receipt.at })
            continue
          }
          const res = yield* io(() => execute(root, { runID: group.runID, check: group.check, worktree: tempDir }))
          if (res.passed) {
            passed.push(res)
            continue
          }
          if (group.own) {
            redChecks.push(group.check)
            continue
          }
          compare.push(group)
        }
        if (reusedChecks.length > 0) cur = { ...cur, reusedChecks }
        if (compare.length > 0) {
          yield* io(() => git(tempDir, [...NO_REPOSITORY_PROGRAMS, "checkout", "--quiet", "--detach", "--force", rebaseBase]))
          for (const group of compare) {
            const baseline = yield* io(() => execute(root, { runID: group.runID, check: group.check, worktree: tempDir }))
            if (baseline.passed) {
              redChecks.push(group.check)
              continue
            }
            stillRed.push(group.check.id)
          }
        }
        if (stillRed.length > 0) cur = { ...cur, stillRed }
        if (redChecks.length > 0) {
          const reworkId = yield* io(() => reworkTask(root, taskIdentity.planRun, taskIdentity.taskID, [], redChecks))
          cur = redEntry(cur, redChecks.map((check) => check.id), reworkId)
          yield* io(() => saveEntry(root, cur))
          return cur
        }
        // 3. landing: re-read the parent HEAD under the repo lock.
        cur = { ...cur, state: "landing", updatedAt: nowIso() }
        yield* io(() => saveEntry(root, cur))
        let staleHead: string | undefined
        let dirtyOverlap: string[] | undefined
        let landedHead = ""
        yield* io(() =>
          withRepoLock(root, ctx, async () => {
            const current = await getHead(ctx.parentWorktree)
            if (current !== rebaseBase) {
              staleHead = current
              return
            }
            // The parent may have changed a file since enqueue: git would refuse
            // this fast-forward, so leave the entry pending instead of failing
            // later with git's own words.
            const dirty = await trackedDirtyFiles(ctx.parentWorktree)
            const touched = overlap(dirty, await changedPaths(ctx.parentWorktree, rebaseBase, rebasedTip))
            if (touched.length > 0) {
              dirtyOverlap = touched
              return
            }
            const collisions = await untrackedCollisions(ctx.parentWorktree, rebaseBase, rebasedTip)
            const top = await git(ctx.parentWorktree, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--show-toplevel"])
            await Promise.all(collisions.safe.map((file) => rm(join(top, file), { force: true })))
            await git(ctx.parentWorktree, [...NO_REPOSITORY_PROGRAMS, "merge", "--ff-only", rebasedTip])
            landedHead = await getHead(ctx.parentWorktree)
          }),
        )
        if (dirtyOverlap !== undefined) {
          const touched = dirtyOverlap as string[]
          cur = { ...cur, state: "pending", updatedAt: nowIso() }
          yield* io(() => saveEntry(root, cur))
          return yield* Effect.fail(
            toolError(
              "E_DIRTY",
              `Your worktree has uncommitted changes to [${pathList(touched)}], which ${entry.childRun}'s commits also change; commit or discard them, then integrate again. Your other uncommitted files stay as they are.`,
              touched.slice(0, PATH_LIST_LIMIT),
            ),
          )
        }
        if (staleHead !== undefined) {
          const current = staleHead as string
          cur = { ...cur, state: "stale_parent", updatedAt: nowIso() }
          yield* io(() => saveEntry(root, cur))
          const now = nowIso()
          const requeued: MergeEntry = {
            id: ulid(),
            parentRun: entry.parentRun,
            childRun: entry.childRun,
            childBranch: entry.childBranch,
            childHead: entry.childHead,
            expectedParentHead: current,
            state: "pending",
            at: now,
            updatedAt: now,
          }
          yield* io(() => saveEntry(root, requeued))
          return yield* Effect.fail(toolError("E_STALE_PARENT", `Your HEAD is ${current}; pass it as expectedParentHead (never the child's commit).`, current))
        }
        // 4. Parent finish needs every assigned id, including command aliases
        // deduplicated above. Never turn a pre-existing red into a green receipt.
        yield* io(() => copyReceipts(root, entry.parentRun, ctx.checks, passed, landedHead))
        cur = { ...cur, state: "landed", landedHead, updatedAt: nowIso() }
        yield* io(() => saveEntry(root, cur))
        return cur
      })
      return yield* inner.pipe(Effect.ensuring(Effect.ignore(io(() => removeTemp(root, ctx, tempDir)))))
    }),
  )
}

/**
 * Drain every pending (or paused-now-clean) entry strictly one at a time.
 * Holds `lock("state", "merge:" + parentRun)` for the whole sweep so two
 * callers can never interleave entries. Entries land past the parent's
 * uncommitted files unless one of them is a path the entry's commits change;
 * at the first such entry the queue pauses there, leaving it and later entries
 * pending. That is not an error.
 */
export async function drain(root: string, parentRun: string, ctx: MergeContext): Promise<DrainResult> {
  return lock(root, "state", `merge:${parentRun}`, async () => {
    const all = await queue(root, parentRun)
    const todo = all.filter((e) => e.state === "pending" || e.state === "paused")
    if (todo.length === 0) return { processed: [], paused: false }
    const processed: MergeEntry[] = []
    for (const item of todo) {
      const fresh = await readJson<MergeEntry>(entryPath(root, parentRun, item.id))
      const target = fresh ?? item
      if (target.state !== "pending" && target.state !== "paused") {
        processed.push(target)
        continue
      }
      const dirty = await trackedDirtyFiles(ctx.parentWorktree)
      if ((await landingOverlap(ctx.parentWorktree, await getHead(ctx.parentWorktree), target.childHead, dirty)).length > 0) {
        await writeQueueMeta(root, parentRun, true)
        return { processed, paused: true }
      }
      await writeQueueMeta(root, parentRun, false)
      processed.push(await process(root, target, ctx))
    }
    return { processed, paused: false }
  })
}
