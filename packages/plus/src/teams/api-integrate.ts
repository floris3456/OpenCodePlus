import path from "node:path"
import { readdir } from "node:fs/promises"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect, Option } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { drain, enqueue, queue } from "./merge.js"
import type { MergeContext, MergeEntry } from "./merge.js"
import { gitRaw } from "./git.js"
import { loadRun, updateRun, type RunRecord } from "./run.js"
import { IntegrateInput } from "./schema.js"
import type { Check } from "./schema.js"
import { readJson } from "./store.js"
import { remove } from "./worktree.js"
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
  const landed = entries.find((item) => item.childRun === child.id && item.state === "landed")
  if (landed !== undefined) {
    // The merge is already a fact. Retry only cleanup, using its saved entry,
    // regardless of subsequent parent commits, dirt, checks or report changes.
    const cleanup = await retryCleanup(ctx, root, parent, child, landed)
    return succeeded({ ...landedValue(landed, [cleanup]), alreadyLanded: true })
  }
  if (child.state === "working") return fail("E_BUSY", "Child is working; wait first.")
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
      `Child ${child.id} last report is "${status}" (attempt ${attempt}). Only done/done_with_concerns can be integrated. Send a followup or supersede.`,
    )
  // Outcomes it lands (Permissions of team_integrate).
  const outcome = status === "done" ? "outcomes.done" : "outcomes.concerns"
  if (!allows(table, caller.agent, "integrate", outcome))
    return fail(
      "E_NOT_DONE",
      `Child ${child.id} reported "${status}", which ${caller.agent} may not land (Permissions → Outcomes it lands). Send a followup or supersede.`,
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
  const checks = (await readJson<Check[]>(path.join(root, "runs", parent.id, "checks.json"))) ?? []
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
    expectedParentHead: args.expectedParentHead,
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
    cleanup.push(await cleanupLanded(root, item.childRun, item.childHead, repoRoot, parent.repoKey))
  }
  const ours = drained.result.processed.find((item) => item.id === entry.id)
  if (ours !== undefined && ours.state === "landed") return succeeded(landedValue(ours, cleanup))
  return succeeded({ entry: entry.id, state: "pending", head: null, cleanup })
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
  return {
    entry: entry.id,
    state: "landed",
    head: entry.landedHead ?? entry.childHead,
    worktree: removal?.worktree,
    reason: removal?.reason,
    cleanup,
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
    return cleanupLanded(root, child.id, entry.childHead, top.out, parent.repoKey)
  })().catch((error: unknown): Cleanup => {
    const failure = thrownError(error)
    return { run: child.id, worktree: "retained", reason: failure.message, code: failure.code }
  })
}

async function cleanupLanded(root: string, run: string, head: string, repoRoot: string, repoKey: string): Promise<Cleanup> {
  const removal = await (async () => {
    // Preserve the original child tip, not the possibly rebased parent tip,
    // before retiring the checkout needed for historical diff reads.
    const child = await updateRun(root, run, (fresh) => ({ ...fresh, head }))
    if (child === undefined || !child.directory) throw new Error("Child record/directory unavailable; cleanup not attempted.")
    await remove(root, child.directory, { repoRoot, repoKey })
  })().then(() => undefined, thrownError)
  if (removal !== undefined) return { run, worktree: "retained", reason: removal.message, code: removal.code }
  // Only successful, verified removal owns this field. A cleanup/persistence
  // problem after landing must never turn the successful merge into a refusal.
  const saved = await updateRun(root, run, (fresh) => ({ ...fresh, worktree: "removed" })).then(() => undefined, thrownError)
  return saved === undefined
    ? { run, worktree: "removed" }
    : { run, worktree: "removed", reason: `Directory removed, but run record update failed: ${saved.message}`, code: saved.code }
}
