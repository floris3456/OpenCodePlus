import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { atomicJson, lock, readJson, ulid } from "./store.js"
import { git, gitRaw } from "./git.js"
import { computePolicyDigest, execute, type Receipt } from "./checks.js"
import { reworkTask } from "./tasks.js"
import { loadRun } from "./run.js"
import { NO_REPOSITORY_PROGRAMS } from "./worktree.js"
import { isExpectedHead, toolError } from "./schema.js"
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

/** Tracked modifications only: ignore untracked (`??`) entries. */
async function trackedDirtyFiles(worktree: string): Promise<string[]> {
  const out = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain"])
  if (out === "") return []
  const files: string[] = []
  for (const line of out.split("\n")) {
    if (line === "") continue
    // NOTE: git() trims the whole output, so the first line loses a leading
    // status space (" M f" -> "M f"). Accept both the 3-char ("XY path")
    // and the trimmed 2-char ("X path") prefix.
    if (line.trimStart().startsWith("??")) continue
    let rest: string
    if (line.length >= 3 && line[2] === " ") rest = line.slice(3)
    else if (line.length >= 2 && line[1] === " ") rest = line.slice(2)
    else rest = line.split(" ").pop() ?? ""
    const file = rest.split(" -> ").pop()?.trim()
    if (file !== undefined && file !== "") files.push(file)
  }
  return files
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
    if (dirty.length > 0)
      throw toolError(
        "E_DIRTY",
        `Your worktree has tracked modifications [${dirty.join(", ")}]; commit or discard them; the merge queue is paused until clean.`,
        dirty,
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
      const groups = new Map<string, { check: Check; runID: string; own: boolean }>()
      for (const source of [{ runID: entry.parentRun, checks: ctx.checks }, ...sources]) {
        for (const check of source.checks) {
          const key = commandKey(check)
          const previous = groups.get(key)
          groups.set(key, {
            check: previous?.check ?? check,
            runID: previous?.runID ?? source.runID,
            own: previous?.own === true || source.runID === entry.childRun,
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
        const passed: Receipt[] = []
        const redChecks: Check[] = []
        const compare: { check: Check; runID: string }[] = []
        const stillRed: string[] = []
        for (const group of groups.values()) {
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
        let landedHead = ""
        yield* io(() =>
          withRepoLock(root, ctx, async () => {
            const current = await getHead(ctx.parentWorktree)
            if (current !== rebaseBase) {
              staleHead = current
              return
            }
            await git(ctx.parentWorktree, [...NO_REPOSITORY_PROGRAMS, "merge", "--ff-only", rebasedTip])
            landedHead = await getHead(ctx.parentWorktree)
          }),
        )
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
 * callers can never interleave entries. A dirty parent pauses the queue
 * without error; entries stay pending.
 */
export async function drain(root: string, parentRun: string, ctx: MergeContext): Promise<DrainResult> {
  return lock(root, "state", `merge:${parentRun}`, async () => {
    const all = await queue(root, parentRun)
    const todo = all.filter((e) => e.state === "pending" || e.state === "paused")
    if (todo.length === 0) return { processed: [], paused: false }
    const dirty = await trackedDirtyFiles(ctx.parentWorktree)
    if (dirty.length > 0) {
      await writeQueueMeta(root, parentRun, true)
      return { processed: [], paused: true }
    }
    await writeQueueMeta(root, parentRun, false)
    const processed: MergeEntry[] = []
    for (const item of todo) {
      const fresh = await readJson<MergeEntry>(entryPath(root, parentRun, item.id))
      const target = fresh ?? item
      if (target.state !== "pending" && target.state !== "paused") {
        processed.push(target)
        continue
      }
      const result = await process(root, target, ctx)
      processed.push(result)
    }
    return { processed, paused: false }
  })
}
