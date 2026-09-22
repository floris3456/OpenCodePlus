import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Duration, Effect, Option, Schedule, Schema, type Scope } from "effect"
import { batchNotify, partition, put, take, type InboxItem } from "./inbox.js"
import { io } from "./io.js"
import { gitRaw, parsePorcelain } from "./git.js"
import type { MergeEntry } from "./merge.js"
import {
  attemptTransition,
  bySession,
  canTransition,
  isAttemptTerminal,
  isTerminal,
  loadRun,
  recordInboxDelivery,
  saveRun,
  startAttempt,
  toFinishing,
  transition,
  type AttemptRecord,
  type RunRecord,
} from "./run.js"
import { Policy, parseDuration } from "./schema.js"
import { lock, readJson } from "./store.js"
import { orphans, ownedRoot, remove, removeLocked } from "./worktree.js"

// Policy file loading lands later; the sweep tick reads the schema default
// (2000 ms), the same source api.ts reads its bounds from.
const policy = Schema.decodeUnknownSync(Policy)({})

function settledText(run: RunRecord, previous: string, attemptN: number): string {
  const task = run.task ?? "-"
  const session = run.sessionID ?? "-"
  return (
    `[team] ${run.id} (${run.role}, ${task}) settled: failed — host session gone; attempt ${attemptN} marked failed.\n` +
    `summary: session ${session} is no longer known to the host; the run was ${previous} and is now dead.\n` +
    `report: none\n` +
    `next: supersede + delegate fresh`
  )
}

function deadTrigger(state: RunRecord["state"]): string | undefined {
  if (state === "starting") return "start_failed"
  if (state === "idle" || state === "working") return "probe_failed"
  return undefined
}

const AttemptBoundary = Schema.Struct({
  state: Schema.String,
  n: Schema.Number,
})

const RecordBoundary = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  attempts: Schema.Array(AttemptBoundary),
})

async function loadRecordSafe(root: string, entry: string): Promise<RunRecord | undefined> {
  const maybe = await Effect.runPromise(
    io(() => readJson<RunRecord>(path.join(root, "runs", entry, "run.json"))).pipe(Effect.option),
  )
  if (Option.isNone(maybe)) return undefined
  const record = maybe.value
  if (record === undefined || record === null) return undefined
  if (Option.isNone(Schema.decodeUnknownOption(RecordBoundary)(record))) return undefined
  return record
}

async function sessionAlive(ctx: Context, sessionID: string): Promise<boolean> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const sid = yield* Effect.try({
        try: () => Session.ID.make(sessionID),
        catch: (error) => error,
      }).pipe(Effect.option)
      if (Option.isNone(sid)) return false
      const info = yield* ctx.session.get({ sessionID: sid.value }).pipe(Effect.option)
      if (Option.isNone(info)) return false
      return info.value !== undefined && info.value !== null
    }),
  )
}

async function moveToDead(record: RunRecord, trigger: string): Promise<RunRecord | undefined> {
  const moved = await Effect.runPromise(
    Effect.try({
      try: () => transition(record, "dead", trigger),
      catch: (error) => error,
    }).pipe(Effect.option),
  )
  if (Option.isNone(moved)) return undefined
  return moved.value
}

async function failOpenAttempt(record: RunRecord): Promise<RunRecord> {
  const last = record.attempts[record.attempts.length - 1]
  if (last === undefined || isAttemptTerminal(last.state)) return record
  const moved = await Effect.runPromise(
    Effect.try({
      try: () => attemptTransition(record, "failed", "failed"),
      catch: (error) => error,
    }).pipe(Effect.option),
  )
  if (Option.isNone(moved)) return record
  return moved.value
}

async function saveSafe(root: string, record: RunRecord): Promise<boolean> {
  const maybe = await Effect.runPromise(io(() => saveRun(root, record)).pipe(Effect.option))
  return Option.isSome(maybe)
}

async function notifySafe(root: string, parent: string, from: string, text: string): Promise<void> {
  await Effect.runPromise(io(() => put(root, parent, { kind: "notify", from, text })).pipe(Effect.ignore))
}

async function reconcileOne(ctx: Context, root: string, entry: string): Promise<string | undefined> {
  if (entry.startsWith(".")) return undefined
  const record = await loadRecordSafe(root, entry)
  if (record === undefined) return undefined
  if (isTerminal(record.state)) return undefined
  if (record.sessionID === null || record.sessionID === undefined) return undefined
  const sessionID = record.sessionID
  const alive = await sessionAlive(ctx, sessionID)
  if (alive) return undefined
  const trigger = deadTrigger(record.state)
  if (trigger === undefined) return undefined
  const previous = record.state
  const dead = await moveToDead(record, trigger)
  if (dead === undefined) return undefined
  const last = dead.attempts[dead.attempts.length - 1]
  const attemptN = last?.n ?? 0
  const withAttempt = await failOpenAttempt(dead)
  const saved = await saveSafe(root, withAttempt)
  if (!saved) return undefined
  if (withAttempt.parent !== null && withAttempt.parent !== undefined)
    await notifySafe(root, withAttempt.parent, withAttempt.id, settledText(withAttempt, previous, attemptN))
  return withAttempt.id
}

export type SessionOutcome = "idle" | "failed" | "interrupted"

// The host's session lifecycle is the only authority on whether a run's model
// turn is over. A child that never called finish still ends its turn, so no
// tool call from the child is needed for its parent to see it idle.
// `session.execution.succeeded` is the canonical host success event
// (`SessionEvent.Execution.Succeeded`, published by core's SessionExecution at
// the end of every busy period); `session.idle` is a deprecated ephemeral event
// the host no longer publishes, kept so older harnesses still settle.
const OUTCOMES: Record<string, SessionOutcome> = {
  "session.execution.succeeded": "idle",
  "session.idle": "idle",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
}

export const SessionRunEvents: ReadonlySet<string> = new Set([
  ...Object.keys(OUTCOMES),
  "session.execution.started",
])

// A stop requested while a run was executing is satisfied by the stop that
// produced its stopped/dead state, but the record still carries the flag.
// Resuming the session must not stop the next turn too. A run that has not
// stopped yet (idle, starting) keeps its intent.
function consumeStopIntent(run: RunRecord): RunRecord {
  if (run.stopRequested !== true) return run
  const next: RunRecord = { ...run }
  delete next.stopRequested
  return next
}

/** Maps one host session event onto its run, if any. Sessions without a run are ignored. */
export async function onSessionEvent(
  ctx: Context,
  root: string,
  event: { type: string; properties?: Record<string, unknown>; data?: unknown },
): Promise<RunRecord | undefined> {
  const payload = (event.properties ?? event.data ?? {}) as Record<string, unknown>
  const sessionID = payload.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined
  const run = await bySession(root, sessionID)
  if (run === undefined) return undefined

  if (event.type === "session.execution.started") {
    const resuming = run.state === "stopped" || run.state === "dead"
    if (run.state === "idle" || run.state === "starting" || resuming) {
      const trigger = run.state === "idle" ? "prompt" : "resume"
      const working = transition(resuming ? consumeStopIntent(run) : run, "working", trigger)
      await saveRun(root, working)
      return working
    }
    return undefined
  }

  const outcome = OUTCOMES[event.type]
  if (outcome === undefined) return undefined
  return onSessionIdle(ctx, root, run, outcome)
}

// Order matters: settle the attempt that just ended, move the run to idle,
// tell the parent once, then drain the inbox. Draining last means a followup
// queued mid-turn starts a NEW attempt instead of reopening the one that
// ended, and the parent sees the settlement before the next attempt begins.
export async function onSessionIdle(
  ctx: Context,
  root: string,
  run: RunRecord,
  outcome: SessionOutcome = "idle",
): Promise<RunRecord> {
  const current = (await loadRun(root, run.id)) ?? run
  if (isTerminal(current.state)) return current
  const idle = toIdle(await settleAttempt(root, current, outcome))
  const attempt = idle.attempts[idle.attempts.length - 1]
  const announce =
    idle.parent !== null &&
    idle.parent !== undefined &&
    attempt !== undefined &&
    isAttemptTerminal(attempt.state) &&
    attempt.notified !== true
  const marked = announce ? markNotified(idle) : idle
  if (marked !== current) await saveRun(root, marked)
  if (announce && attempt !== undefined) await notifyParent(ctx, root, marked, attempt)
  if (marked.stopRequested) {
    const stopping = transition(marked, "stopping", "shutdown")
    const stopped = transition(stopping, "stopped", "exited")
    await saveRun(root, stopped)
    return stopped
  }
  return deliverInbox(ctx, root, marked)
}

async function settleAttempt(root: string, run: RunRecord, outcome: SessionOutcome): Promise<RunRecord> {
  const last = run.attempts[run.attempts.length - 1]
  if (last === undefined || isAttemptTerminal(last.state)) return run
  if (outcome === "failed") return attemptTransition(run, "failed", "failed")
  if (outcome === "interrupted") return attemptTransition(run, "interrupted", "interrupt")
  // finish wrote this attempt's report and owns its terminal state.
  const reported = await readJson<unknown>(path.join(root, "runs", run.id, `report-${last.n}.json`))
  if (reported !== undefined) return run
  return attemptTransition(toFinishing(run), "no_report", "validated")
}

// 02 §1: working reaches idle on turn_ended; a still-starting run (the normal
// freshly delegated child) reaches the same idle on connected.
function toIdle(run: RunRecord): RunRecord {
  if (run.state === "working") return transition(run, "idle", "turn_ended")
  if (run.state === "starting") return transition(run, "idle", "connected")
  return run
}

function markNotified(run: RunRecord): RunRecord {
  const last = run.attempts[run.attempts.length - 1]
  if (last === undefined) return run
  const updated: AttemptRecord = { ...last, notified: true }
  return { ...run, attempts: [...run.attempts.slice(0, -1), updated] }
}

function childSettledText(
  run: RunRecord,
  attempt: AttemptRecord,
  report: Record<string, unknown> | undefined,
  reportPath: string | undefined,
): string {
  const task = run.task ?? "-"
  const status = typeof report?.status === "string" ? report.status : attempt.state
  const summary = typeof report?.summary === "string" ? report.summary.split("\n")[0] ?? "" : ""
  return (
    `[team] ${run.id} (${run.role}, ${task}) settled: ${status} — attempt ${attempt.n} ${attempt.state}.\n` +
    `summary: ${summary === "" ? `attempt ${attempt.n} ended ${attempt.state} with no report` : summary}\n` +
    `report: ${reportPath ?? "none"}\n` +
    `next: ${reportPath === undefined ? "read status/diff, then followup or supersede" : "read the report, then integrate or followup"}`
  )
}

// One settlement, one inbox item. An idle parent is prompted with it now;
// a working parent gets it through its own idle drain.
async function notifyParent(ctx: Context, root: string, child: RunRecord, attempt: AttemptRecord): Promise<void> {
  const parentID = child.parent
  if (parentID === null || parentID === undefined || parentID === child.id) return
  const parent = await loadRun(root, parentID)
  if (parent === undefined || isTerminal(parent.state)) return
  const reportPath = path.join(root, "runs", child.id, `report-${attempt.n}.json`)
  const report = await readJson<Record<string, unknown>>(reportPath)
  const displayPath = report === undefined ? undefined : path.join(root, "runs", child.id, `report-${attempt.n}.md`)
  await Effect.runPromise(
    io(() =>
      put(root, parentID, { kind: "child.settled", from: child.id, text: childSettledText(child, attempt, report, displayPath) }),
    ).pipe(Effect.ignore),
  )
  await deliverInbox(ctx, root, parent)
}

// The idle handoff: everything pending becomes ONE new attempt's prompt.
// Items already delivered as an earlier attempt's prompt are consumed without
// being prompted again, so an immediately delivered followup is not repeated.
async function deliverInbox(ctx: Context, root: string, run: RunRecord): Promise<RunRecord> {
  const sessionID = run.sessionID
  if (run.state !== "idle" || sessionID === null || sessionID === undefined) return run
  // startAttempt's precondition, checked before take so a run that cannot
  // take a new attempt keeps its inbox pending instead of losing it.
  if (run.attempts.some((attempt) => !isAttemptTerminal(attempt.state))) return run
  const items = await take(root, run.id)
  if (items.length === 0) return run
  const delivered = new Set(run.attempts.flatMap((attempt) => attempt.inbox ?? []))
  const fresh = items.filter((item) => !delivered.has(item.id))
  const text = renderInbox(fresh)
  if (text === "") return run
  const started = startAttempt(run, { trigger: "followup", prompt: text })
  const admitted = attemptTransition(started, "admitted", "admit")
  const working = recordInboxDelivery(
    transition(admitted, "working", "prompt"),
    fresh.map((item) => item.id),
  )
  await saveRun(root, working)
  await Effect.runPromise(
    ctx.session
      .prompt({ sessionID: Session.ID.make(sessionID), text })
      .pipe(Effect.onError(() => Effect.ignore(io(() => saveRun(root, run))))),
  )
  return working
}

function renderInbox(items: readonly InboxItem[]): string {
  const split = partition([...items])
  const blocks = [
    batchNotify([...items]).text,
    ...[...split.prompts, ...split.shutdown].map((item) => item.text.replace(/\r?\n$/, "")),
  ]
  return blocks.filter((block) => block.trim().length > 0).join("\n\n")
}

// The one periodic tick of the team runtime: everything that must happen
// without a tool call runs from here. T6 adds gc(root, policy) to this
// function; nothing else schedules periodic team work.
export async function sweep(ctx: Context, root: string): Promise<SweepResult> {
  const dead = await reconcile(ctx, root)
  return { dead, gc: await gc(root, policy) }
}

export interface SweepResult {
  dead: string[]
  gc: GcResult
}

export interface GcResult {
  reaped: string[]
  skippedDirty: string[]
  orphansRemoved: string[]
  /** Runs whose worktree removal failed; they keep their state and worktree. */
  removeFailed: string[]
}

export async function gc(root: string, customPolicy?: Policy): Promise<GcResult> {
  const pol = customPolicy ?? policy
  const reapAfterMs = parseDuration(pol.gc.reapAfter)
  const now = Date.now()

  const runEntries = await Effect.runPromise(
    io(() => readdir(path.join(root, "runs"))).pipe(
      Effect.map((names) => [...names]),
      Effect.catchCause(() => Effect.succeed([] as string[])),
    ),
  )

  const allRuns: RunRecord[] = []
  for (const entry of runEntries) {
    if (entry.startsWith(".")) continue
    const record = await loadRecordSafe(root, entry)
    if (record !== undefined) allRuns.push(record)
  }

  // 1. Identify runs referenced by open (non-terminal) merge entries
  const openMergeRunIDs = new Set<string>()
  for (const parent of allRuns) {
    const mergeFiles = await Effect.runPromise(
      io(() => readdir(path.join(root, "runs", parent.id, "merge"))).pipe(
        Effect.map((names) => [...names]),
        Effect.catchCause(() => Effect.succeed([] as string[])),
      ),
    )
    for (const file of mergeFiles) {
      if (!file.endsWith(".json") || file.startsWith("_") || file.startsWith(".")) continue
      const entry = await Effect.runPromise(
        io(() => readJson<MergeEntry>(path.join(root, "runs", parent.id, "merge", file))).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      )
      if (entry !== undefined && entry.state !== "landed" && entry.state !== "conflict" && entry.state !== "red") {
        if (entry.childRun) openMergeRunIDs.add(entry.childRun)
        if (entry.parentRun) openMergeRunIDs.add(entry.parentRun)
      }
    }
  }

  // 2. Identify promotedFrom runs
  const promotedFromSet = new Set<string>()
  if (pol.gc.keepPromotedFrom) {
    for (const r of allRuns) {
      if (r.promotedFrom) promotedFromSet.add(r.promotedFrom)
    }
  }

  // 3. Resolve repoRoot for each repoKey
  const repoRoots = new Map<string, string>()
  for (const r of allRuns) {
    if (r.repoKey && !repoRoots.has(r.repoKey) && r.directory) {
      const top = await gitRaw(r.directory, ["rev-parse", "--show-toplevel"]).catch(() => ({ code: 1, out: "" }))
      if (top.code === 0 && top.out.length > 0) {
        repoRoots.set(r.repoKey, top.out)
      }
    }
  }

  const reaped: string[] = []
  const skippedDirty: string[] = []
  const removeFailed: string[] = []

  // 4. Reap stale stopped / superseded runs
  for (const record of allRuns) {
    if (record.state !== "stopped" && record.state !== "superseded") continue

    const lastUsedMs = Date.parse(record.lastUsed)
    if (Number.isNaN(lastUsedMs) || now - lastUsedMs < reapAfterMs) continue

    if (openMergeRunIDs.has(record.id)) continue

    if (pol.gc.keepPromotedFrom) {
      const isPromoted = promotedFromSet.has(record.id) || Boolean(record.promotedFrom)
      if (isPromoted) continue
    }

    const repoRoot = repoRoots.get(record.repoKey)
    const isSuperseded = record.state === "superseded"

    if (!isSuperseded) {
      // Stopped run: check dirty
      let isDirty = false
      if (record.directory) {
        try {
          const porcelain = await gitRaw(record.directory, ["status", "--porcelain", "-uall"])
          if (porcelain.code === 0) {
            const dirtyFiles = parsePorcelain(porcelain.out)
            isDirty = dirtyFiles.length > 0
          }
        } catch {
          // If git status fails (e.g. dir gone), not dirty
        }
      }

      if (isDirty) {
        if (record.worktree !== "dirty") {
          record.worktree = "dirty"
          await saveSafe(root, record)
        }
        skippedDirty.push(record.id)
        continue
      }
    }

    // A run is only reaped once its directory is verifiably gone: `git
    // worktree remove` fails on a locked worktree, and a record saved as
    // reaped/removed would both lie and drop out of the orphan scan's
    // knownDirs below.
    if (!(await removeWorktree(root, record, repoRoot, isSuperseded))) {
      removeFailed.push(record.id)
      continue
    }

    const cleared: RunRecord = { ...record, worktree: "removed" }
    await saveSafe(
      root,
      canTransition(cleared.state, "reaped", "gc") ? transition(cleared, "reaped", "gc") : { ...cleared, state: "reaped" },
    )
    reaped.push(record.id)
  }

  // 5. Remove orphans for each repoKey. Provisioning (`worktree.provision`)
  // holds the repository lock across create + run registration, so the sweep
  // takes the same lock here and re-lists the run records inside it: a
  // worktree can never be judged an orphan while its record is still being
  // written, no matter when this pass read its opening snapshot. The age guard
  // covers a worktree created outside that path — `create` finished, nothing
  // registered it yet — which is exactly what `policy.timeouts.startMs` is a
  // generous bound for.
  const orphansRemoved: string[] = []
  for (const [repoKey, repoRoot] of repoRoots.entries()) {
    await lock(root, "repo", repoKey, async () => {
      const knownDirs: string[] = []
      const entries = await Effect.runPromise(
        io(() => readdir(path.join(root, "runs"))).pipe(
          Effect.map((names) => [...names]),
          Effect.catchCause(() => Effect.succeed([] as string[])),
        ),
      )
      for (const entry of entries) {
        if (entry.startsWith(".")) continue
        const record = await loadRecordSafe(root, entry)
        if (record === undefined || record.repoKey !== repoKey) continue
        if (record.worktree !== "removed") knownDirs.push(record.directory)
      }
      const orphanList = await orphans(repoRoot, ownedRoot(root, repoKey), knownDirs, {
        minAgeMs: pol.timeouts.startMs,
      }).catch(() => [] as string[])
      for (const orphanPath of orphanList) {
        try {
          await removeLocked(orphanPath, { repoRoot, repoKey, force: true })
          orphansRemoved.push(orphanPath)
        } catch {
          // ignore
        }
      }
    })
  }

  return { reaped, skippedDirty, orphansRemoved, removeFailed }
}

// True when the run's worktree directory is gone afterwards, whether it was
// already absent or this call removed it. `remove` rejecting is not enough to
// report a removal, and succeeding is not required if the directory is absent.
async function removeWorktree(
  root: string,
  record: RunRecord,
  repoRoot: string | undefined,
  force: boolean,
): Promise<boolean> {
  if (record.directory === "" || !(await onDisk(record.directory))) return true
  if (repoRoot === undefined) return false
  await Effect.runPromise(
    io(() => remove(root, record.directory, { repoRoot, repoKey: record.repoKey, force })).pipe(Effect.ignore),
  )
  return !(await onDisk(record.directory))
}

function onDisk(dir: string): Promise<boolean> {
  return Effect.runPromise(
    io(() => stat(dir)).pipe(
      Effect.as(true),
      Effect.catchIf(() => true, () => Effect.succeed(false)),
    ),
  )
}

/** Runs sweep now and then every tickMs until the plugin scope closes. */
export function startSweep(ctx: Context, root: string, tickMs = policy.sweep.tickMs): Effect.Effect<void, never, Scope.Scope> {
  return Effect.promise(() => sweep(ctx, root)).pipe(
    Effect.catchCause((cause) => Effect.logWarning("plus team sweep failed", { cause })),
    Effect.repeat(Schedule.spaced(Duration.millis(tickMs))),
    Effect.forkScoped,
    Effect.asVoid,
  )
}

export async function reconcile(ctx: Context, root: string): Promise<string[]> {
  const entries = await Effect.runPromise(
    io(() => readdir(path.join(root, "runs"))).pipe(
      Effect.map((names) => [...names]),
      Effect.catchCause(() => Effect.succeed([] as string[])),
    ),
  )
  const dead: string[] = []
  for (const entry of entries) {
    const id = await Effect.runPromise(
      Effect.promise(() => reconcileOne(ctx, root, entry)).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      ),
    )
    if (id !== undefined) dead.push(id)
  }
  return dead.toSorted()
}
