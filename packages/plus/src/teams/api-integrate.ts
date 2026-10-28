import path from "node:path"
import { readdir } from "node:fs/promises"
import type { Context } from "@opencode/plugin/effect/plugin"
import { warmingStore } from "../warming.js"
import { Session } from "@opencode/schema/session"
import { Effect, Option } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { drain, enqueue, queue } from "./merge.js"
import type { MergeContext, MergeEntry } from "./merge.js"
import { gitRaw } from "./git.js"
import { loadRun, updateRun, type RunRecord } from "./run.js"
import { IntegrateInput } from "./schema.js"
import { pathList, type Check } from "./schema.js"
import { readJson } from "./store.js"
import { remove } from "./worktree.js"
import { evictRunFolder } from "./lifecycle.js"
import { rowState, type PermissionTable } from "../instructions/permission-enforce.js"
import { wildcardMatch } from "../instructions/permission-catalog.js"
import { allows } from "./reach.js"
import type { TeamApiResult, TeamCaller } from "./api.js"

function succeeded(value: unknown): TeamApiResult {
  return { ok: true, value }
}

function fail(code: string, message: string, accepted?: unknown): TeamApiResult {
  if (accepted === undefined) return { ok: false, error: { code, message } }
  return { ok: false, error: { code, message, accepted } }
}

function thrownError(error: unknown): { code: string; message: string; accepted?: unknown } {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>
    if (typeof record.code === "string" && typeof record.message === "string") {
      if (record.accepted === undefined) return { code: record.code, message: record.message }
      return { code: record.code, message: record.message, accepted: record.accepted }
    }
    if (error instanceof Error) return { code: "E_INTERNAL", message: error.message }
  }
  return { code: "E_INTERNAL", message: String(error) }
}

async function latestReport(root: string, runID: string): Promise<{ n: number; status: string } | undefined> {
  const dir = path.join(root, "runs", runID)
  const entries = await readdir(dir).catch(() => [] as string[])
  let best: { n: number; status: string } | undefined
  for (const name of entries) {
    const match = /^report-([0-9]+)\.json$/.exec(name)
    if (match === null) continue
    const data = await readJson<Record<string, unknown>>(path.join(dir, name))
    if (data === undefined) continue
    const n = Number(match[1])
    const status = typeof data.status === "string" ? data.status : "unknown"
    if (best === undefined || n > best.n) best = { n, status }
  }
  return best
}

export async function integrateHandler(ctx: Context, args: IntegrateInput, caller: TeamCaller, table?: PermissionTable): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const parent = stored ?? caller.run
  const child = await loadRun(root, args.run)
  if (child === undefined || child.parent !== parent.id)
    return fail(
      "E_NOT_CHILD",
      `Run ${args.run} is not your direct child. Your children: [${parent.children.join(", ")}]. Use status to read others.`,
      parent.children,
    )
  const entries = await queue(root, parent.id)
  // Per worktree generation: a child reopened after landing has a new branch.
  const landed = entries.find((item) => item.childRun === child.id && item.childBranch === child.branch && item.state === "landed")
  if (landed !== undefined) {
    // The merge is already a fact. Retry only cleanup, using its saved entry,
    // regardless of subsequent parent commits, dirt, checks or report changes.
    const cleanup = await retryCleanup(ctx, root, parent, child, landed)
    return succeeded({ ...landedValue(landed, [cleanup]), alreadyLanded: true })
  }
  if (child.state === "working") return fail("E_BUSY", "Child is working; integrate after its settlement wakes you.")
  // drain also processes older pending/paused entries. Establish actual Session
  // idleness for every child it can land, within one bounded wait budget.
  const queued = entries.filter((item) => item.state === "pending" || item.state === "paused")
  const deadline = Date.now() + 1000
  for (const id of new Set([child.id, ...queued.map((item) => item.childRun)])) {
    const target = id === child.id ? child : await loadRun(root, id)
    const refusal = await waitForChild(ctx, target, id, deadline)
    if (refusal !== undefined) return refusal
  }
  const report = await latestReport(root, child.id)
  const status = report?.status ?? "none"
  const lastAttempt = child.attempts[child.attempts.length - 1]?.n ?? 0
  const attempt = report?.n ?? lastAttempt
  if (status !== "done" && status !== "done_with_concerns")
    return fail(
      "E_NOT_DONE",
      `Child ${child.id} last report is "${status}" (attempt ${attempt}). Only done/done_with_concerns can be integrated. Send a followup, or team_stop it and delegate afresh.`,
    )
  // Outcomes it lands (Permissions of team_integrate).
  const outcome = status === "done" ? "outcomes.done" : "outcomes.concerns"
  if (!allows(table, caller.agent, "integrate", outcome))
    return fail(
      "E_NOT_DONE",
      `Child ${child.id} reported "${status}", which ${caller.agent} may not land (Permissions → Outcomes it lands). Send a followup, or team_stop it and delegate afresh.`,
    )
  const top = await gitRaw(parent.directory, ["rev-parse", "--show-toplevel"])
  if (top.code !== 0) return fail("E_INTERNAL", top.err || top.out || `Cannot resolve repository from ${parent.directory}.`)
  // Branches it lands on: the parent's current branch against the protected
  // branch row.
  const protectedRow = rowState(table, caller.agent, "team_integrate", "branches.protected")
  if (protectedRow !== undefined && !protectedRow.on) {
    const branchOut = await gitRaw(parent.directory, ["rev-parse", "--abbrev-ref", "HEAD"])
    const branch = branchOut.code === 0 ? branchOut.out : ""
    if ((protectedRow.item.patterns ?? []).some((pattern) => wildcardMatch(branch, pattern)))
      return fail("E_BRANCH", `${protectedRow.item.message ?? "landing on this branch is not allowed here"} (branch "${branch}").`, "a task branch")
  }
  const repoRoot = top.out
  const checks = (await readJson<{ checks: Check[] }>(path.join(root, "runs", parent.id, "brief.json")))?.checks ?? []
  const mergeCtx: MergeContext = {
    repoRoot,
    repoKey: parent.repoKey,
    workspaceRoot: root,
    parentWorktree: parent.directory,
    checks,
  }
  let childHead = child.head
  if (child.worktree !== "removed") {
    try {
      const live = await gitRaw(child.directory, ["rev-parse", "HEAD"])
      if (live.code === 0 && live.out.length > 0) childHead = live.out
    } catch {
      childHead = child.head
    }
  }
  const enqueued = await enqueue(root, {
    parentRun: parent.id,
    parentWorktree: parent.directory,
    childRun: child.id,
    childBranch: child.branch,
    childHead,
    ...(args.expectedParentHead === undefined ? {} : { expectedParentHead: args.expectedParentHead }),
  }).then(
    (entry) => ({ ok: true as const, entry }),
    (error) => ({ ok: false as const, error: thrownError(error) }),
  )
  if (!enqueued.ok) return { ok: false, error: enqueued.error }
  const entry = enqueued.entry
  const drained = await drain(root, parent.id, mergeCtx).then(
    (result) => ({ ok: true as const, result }),
    (error) => ({ ok: false as const, error: thrownError(error) }),
  )
  if (!drained.ok) return { ok: false, error: drained.error }
  const cleanup: Cleanup[] = []
  for (const item of drained.result.processed) {
    if (item.state !== "landed") continue
    cleanup.push(await cleanupLanded(ctx, root, item.childRun, item.childHead, repoRoot, parent.repoKey))
  }
  const ours = drained.result.processed.find((item) => item.id === entry.id)
  if (ours !== undefined && ours.state === "landed") return succeeded(landedValue(ours, cleanup))
  if (ours !== undefined && (ours.state === "conflict" || ours.state === "red")) return succeeded(reworkValue(ours, cleanup))
  return succeeded({ entry: entry.id, state: drained.result.paused ? "paused" : "pending", head: null, cleanup })
}

// A merge that did not land says why and what to do: the rework task it
// opened is what a fresh child's Brief claims (task), so the caller never has
// to find the id elsewhere.
function reworkValue(entry: MergeEntry, cleanup: Cleanup[]) {
  const task = entry.reworkTask
  const red = (entry.redChecks ?? []).join(", ")
  const note = skippedNote(entry)
  const fresh = `a fresh implementer${task === undefined ? "" : ` with task "${task}"`} to redo the change on your current HEAD (attach this child's team_diff as a briefFile), then team_stop this child`
  const next =
    entry.state === "conflict"
      ? `Not landed: the child's commits conflict with your HEAD in [${pathList(entry.conflictFiles ?? [])}]. Send it team_followup with rebase: true: it resolves the conflict in its own worktree and keeps its context. Only if it cannot resume, delegate ${fresh}.`
      : `Not landed: checks [${red}] fail on the combined change (the child's own checks or new failures against your HEAD). Send the child a team_followup with rebase: true and what fails (it keeps its context), or delegate ${fresh}.`
  return {
    entry: entry.id,
    state: entry.state,
    head: null,
    ...(entry.conflictFiles === undefined ? {} : { conflictFiles: entry.conflictFiles }),
    ...(entry.redChecks === undefined ? {} : { redChecks: entry.redChecks }),
    ...(entry.redAtParent === true ? { redAtParent: true } : {}),
    ...(entry.stillRed === undefined ? {} : { stillRed: entry.stillRed }),
    ...skippedChecks(entry),
    ...(note === undefined ? {} : { note }),
    ...verifiedChecks(entry),
    ...(task === undefined ? {} : { reworkTask: task }),
    next,
    cleanup,
  }
}

async function waitForChild(
  ctx: Context,
  child: RunRecord | undefined,
  id: string,
  deadline: number,
): Promise<TeamApiResult | undefined> {
  if (child === undefined || child.sessionID === null)
    return fail("E_NO_SESSION", `Cannot verify child ${id} is idle: no Session is recorded. Delegate fresh from the current parent.`)
  const sessionID = Session.ID.make(child.sessionID)
  // Timing out interrupts only our wait subscription, never the child drain.
  return Effect.runPromise(
    Effect.suspend(() => ctx.session.wait({ sessionID })).pipe(Effect.timeoutOption(Math.max(0, deadline - Date.now()))),
  ).then(
    (idle) => Option.isSome(idle)
      ? undefined
      : fail("E_BUSY", `Child ${id} Session did not become idle within 1000ms; wait for it to settle, then retry integration.`),
    () => fail("E_SESSION", `Cannot verify child ${id} Session is idle; check its Session, then retry integration.`),
  )
}

interface Cleanup {
  run: string
  worktree: "retained" | "removed"
  reason?: string
  code?: string
}

function landedValue(entry: MergeEntry, cleanup: Cleanup[]) {
  const removal = cleanup.find((item) => item.run === entry.childRun)
  const note = [stillRedNote(entry), skippedNote(entry)].filter((line) => line !== undefined).join(" ")
  return {
    entry: entry.id,
    state: "landed",
    head: entry.landedHead ?? entry.childHead,
    worktree: removal?.worktree,
    reason: removal?.reason,
    ...(entry.stillRed === undefined ? {} : { stillRed: entry.stillRed }),
    ...skippedChecks(entry),
    ...(note === "" ? {} : { note }),
    ...verifiedChecks(entry),
    cleanup,
  }
}

/** The checks this landing did not run, named on the answer; absent when none. */
function skippedChecks(entry: MergeEntry) {
  if (entry.skippedChecks === undefined || entry.skippedChecks.length === 0) return {}
  return { skippedChecks: entry.skippedChecks }
}

function stillRedNote(entry: MergeEntry): string | undefined {
  if (entry.stillRed === undefined) return undefined
  return `Checks [${entry.stillRed.join(", ")}] already fail at the parent's HEAD; they did not block this landing.`
}

/**
 * The checks this landing did not run because they judge their own run's
 * change: a size, budget or anti-mess gate says nothing about another run.
 */
function skippedNote(entry: MergeEntry): string | undefined {
  if (entry.skippedChecks === undefined || entry.skippedChecks.length === 0) return undefined
  const list = entry.skippedChecks.map((check) => `${check.id} (${check.runID})`).join(", ")
  return `Not run at this landing: ${list}: they judge their own run's change.`
}

function verifiedChecks(entry: MergeEntry) {
  if (entry.reusedChecks === undefined || entry.reusedChecks.length === 0) return {}
  return {
    verified: `Checks [${entry.reusedChecks.map((check) => check.id).join(", ")}] passed on this exact tree with the same commands. The verified tree matches the rebased tree exactly, so these checks were not run again.`,
    checks: entry.reusedChecks,
  }
}

async function retryCleanup(ctx: Context, root: string, parent: RunRecord, child: RunRecord, entry: MergeEntry): Promise<Cleanup> {
  if (child.worktree === "removed") return { run: child.id, worktree: "removed" }
  const refusal = await waitForChild(ctx, child, child.id, Date.now() + 1000)
  if (refusal !== undefined && !refusal.ok)
    return { run: child.id, worktree: "retained", reason: refusal.error.message, code: refusal.error.code }
  // Even repository-resolution failure is only a cleanup problem now.
  return (async () => {
    const top = await gitRaw(parent.directory, ["rev-parse", "--show-toplevel"])
    if (top.code !== 0) throw new Error(top.err || top.out || `Cannot resolve repository from ${parent.directory}.`)
    return cleanupLanded(ctx, root, child.id, entry.childHead, top.out, parent.repoKey)
  })().catch((error: unknown): Cleanup => {
    const failure = thrownError(error)
    return { run: child.id, worktree: "retained", reason: failure.message, code: failure.code }
  })
}

async function cleanupLanded(ctx: Context, root: string, run: string, head: string, repoRoot: string, repoKey: string): Promise<Cleanup> {
  const removal = await (async () => {
    const current = await loadRun(root, run)
    if (current === undefined || !current.directory) throw new Error("Child record/directory unavailable; cleanup not attempted.")
    const tip = await gitRaw(current.directory, ["rev-parse", "HEAD"])
    if (tip.code !== 0 || tip.out !== head)
      throw { code: "E_CHILD_HEAD", message: "Child tip differs from its landed tip or cannot be read; retaining checkout and recorded head. Delegate fresh from current parent." }
    // Preserve the original child tip, not the possibly rebased parent tip,
    // before retiring the checkout needed for historical diff reads.
    const child = await updateRun(root, run, (fresh) => ({ ...fresh, head }))
    if (child === undefined || !child.directory) throw new Error("Child record/directory unavailable; cleanup not attempted.")
    // The landed child's folder still has its services loaded (its MCP servers
    // run there), which would keep the checkout in use for the 60-minute idle
    // timeout: release them first.
    await evictRunFolder(ctx, child)
    await removeReleased(root, child.directory, { repoRoot, repoKey })
    if (child.sessionID !== null) warmingStore.stop(child.sessionID)
  })().then(() => undefined, thrownError)
  if (removal !== undefined) return { run, worktree: "retained", reason: removal.message, code: removal.code }
  // Only successful, verified removal owns this field. A cleanup/persistence
  // problem after landing must never turn the successful merge into a refusal.
  const saved = await updateRun(root, run, (fresh) => ({ ...fresh, worktree: "removed" })).then(() => undefined, thrownError)
  return saved === undefined
    ? { run, worktree: "removed" }
    : { run, worktree: "removed", reason: `Directory removed, but run record update failed: ${saved.message}`, code: saved.code }
}

// An evicted folder's processes exit shortly after; until then they still
// reference it, so a removal they block is retried for about a second and a half.
async function removeReleased(root: string, dir: string, opts: { repoRoot: string; repoKey: string }, attempt = 0): Promise<void> {
  const failure = await remove(root, dir, opts).then(() => undefined, (error: unknown) => error)
  if (failure === undefined) return
  if (attempt >= 5 || thrownError(failure).code !== "E_WT_IN_USE") throw failure
  await Bun.sleep(250)
  return removeReleased(root, dir, opts, attempt + 1)
}
