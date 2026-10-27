import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Duration, Effect, Fiber, Option, Schedule, Schema, Semaphore, type Scope } from "effect"
import { batchNotify, partition, peek, put, take, type InboxItem } from "./inbox.js"
import { io, errCode } from "./io.js"
import { gitRaw, parsePorcelain } from "./git.js"
import type { MergeEntry } from "./merge.js"
import {
  attemptTransition,
  bySession,
  canTransition,
  isAttemptTerminal,
  isTerminal,
  loadRun,
  openChildren,
  recordInboxDelivery,
  saveRun,
  startAttempt,
  toFinishing,
  transition,
  updateRun,
  type AttemptError,
  type AttemptRecord,
  type RunRecord,
} from "./run.js"
import { Policy, budgetDimensions, budgetExhaustion, parseDuration, pathList } from "./schema.js"
import { sessionTokens } from "./usage.js"
import { bound } from "./reach.js"
import type { PermissionTable } from "../instructions/permission-enforce.js"
import { RETRY_SCHEDULED, SessionOutcomes, type SessionOutcome } from "./session-events.js"
import { lock, readJson } from "./store.js"
import { NO_REPOSITORY_PROGRAMS, orphans, ownedRoot, remove, removeLocked } from "./worktree.js"
import { removeLeftoverSnapshotStores } from "./snapshots.js"

// Policy file loading lands later; the sweep tick reads the schema default
// (2000 ms), the same source api.ts reads its bounds from.
const policy = Schema.decodeUnknownSync(Policy)({})

// One sweep pass at a time per process. The module is imported once, so this
// state is process-wide; each loaded workspace forks its own loop, and
// whichever loop gets the permit runs the pass while the others skip. Passes
// are spaced at least one tick apart, and gc runs at most once per reconcile
// interval. Without the pacing, loops for workspaces loaded at different times
// interleave passes arbitrarily close together.
const sweepPermit = Semaphore.makeUnsafe(1)
let lastPassAt = 0
let lastGcAt = 0

/** Test-only: reset the process-wide sweep pacing between isolated roots. */
export function resetSweepState(): void {
  lastPassAt = 0
  lastGcAt = 0
}

function settledText(run: RunRecord, previous: string, attemptN: number): string {
  const task = run.task ?? "-"
  const session = run.sessionID ?? "-"
  return (
    `[team] ${run.id} (${run.role}, ${task}) settled: failed — host session gone; attempt ${attemptN} marked failed.\n` +
    `summary: session ${session} is no longer known to the host; the run was ${previous} and is now dead.\n` +
    `report: none\n` +
    `next: team_stop + delegate fresh`
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

async function notifySafe(root: string, parent: string, from: string, text: string, dedupeKey?: string): Promise<void> {
  await Effect.runPromise(io(() => put(root, parent, { kind: "notify", from, text, dedupeKey })).pipe(Effect.ignore))
}

async function reconcileOne(ctx: Context, root: string, entry: string): Promise<string | undefined> {
  if (entry.startsWith(".")) return undefined
  const record = await loadRecordSafe(root, entry)
  if (record === undefined) return undefined
  if (isTerminal(record.state)) return undefined
  if (record.parent && record.parent !== record.id && record.state !== "stopped") {
    const parent = await loadRecordSafe(root, record.parent)
    if (parent === undefined || isTerminal(parent.state) || parent.state === "dead") {
      // Stop admission before interrupting: the execution-end event must not
      // deliver a queued followup and start this orphan again.
      const stopping = await updateRun(root, entry, (current) => {
        if (isTerminal(current.state) || current.state === "stopped" || current.state === "stopping") return current
        return transition(current, "stopping", "parent_gone")
      })
      if (stopping?.state !== "stopping") return undefined
      if (stopping.sessionID && await sessionAlive(ctx, stopping.sessionID))
        await Effect.runPromise(ctx.session.interrupt({ sessionID: Session.ID.make(stopping.sessionID) }))
      const stopped = await updateRun(root, entry, (current) => {
        if (current.state !== "stopping") return current
        return transition(interruptOpenAttempt(withoutRetrying(current)), "stopped", "exited")
      })
      if (stopped?.state === "stopped") await evictRunFolder(ctx, stopped)
      return undefined
    }
  }
  if (record.sessionID === null || record.sessionID === undefined) return undefined
  const sessionID = record.sessionID
  const alive = await sessionAlive(ctx, sessionID)
  if (alive) return undefined
  if (deadTrigger(record.state) === undefined) return undefined
  // The transition runs against the record as it is at write time, in one
  // state-lock hold: this pass must not write the worktree state it read back
  // over a removal that landed in between.
  const applied = { changed: false, previous: record.state }
  const saved = await updateRun(root, entry, async (current) => {
    if (isTerminal(current.state)) return current
    const trigger = deadTrigger(current.state)
    if (trigger === undefined) return current
    const dead = await moveToDead(current, trigger)
    if (dead === undefined) return current
    applied.changed = true
    applied.previous = current.state
    return await failOpenAttempt(dead)
  })
  if (saved === undefined || !applied.changed) return undefined
  const last = saved.attempts[saved.attempts.length - 1]
  const attemptN = last?.n ?? 0
  if (saved.parent !== null && saved.parent !== undefined)
    await notifySafe(root, saved.parent, saved.id, settledText(saved, applied.previous, attemptN))
  return saved.id
}

// A stop requested while a run was executing is satisfied by the stop that
// produced its stopped/dead state, but the record still carries the flag.
// Resuming the session must not stop the next turn too, and the stop's reason
// no longer describes the run. A run that has not stopped yet (idle, starting)
// keeps its intent.
export function consumeStopIntent(run: RunRecord): RunRecord {
  if (run.stopRequested !== true && run.stopRequestedBy === undefined && run.stopReason === undefined) return run
  const next: RunRecord = { ...run }
  delete next.stopRequested
  delete next.stopRequestedBy
  delete next.stopReason
  return next
}

/** Maps one host session event onto its run, if any. Sessions without a run are ignored. */
export async function onSessionEvent(
  ctx: Context,
  root: string,
  event: { type: string; properties?: Record<string, unknown>; data?: unknown; created?: number },
): Promise<RunRecord | undefined> {
  const payload = (event.properties ?? event.data ?? {}) as Record<string, unknown>
  const sessionID = payload.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined
  const run = await bySession(root, sessionID)
  if (run === undefined) {
    await onSubagentEvent(ctx, sessionID, event.type, payload)
    return undefined
  }
  if ((event.type === "session.execution.started" || SessionOutcomes[event.type] !== undefined) && movedRun(run, event.created)) return undefined

  if (event.type === "session.execution.started") {
    const applied = { changed: false }
    const working = await updateRun(root, run.id, (record) => {
      const resuming = record.state === "stopped" || record.state === "dead"
      if (record.state !== "idle" && record.state !== "starting" && !resuming) {
        if (record.retrying === undefined) return record
        applied.changed = true
        return withoutRetrying(record)
      }
      const trigger = record.state === "idle" ? "prompt" : "resume"
      applied.changed = true
      const last = record.attempts.at(-1)
      const admitted = last === undefined || isAttemptTerminal(last.state)
        ? attemptTransition(startAttempt(record, { trigger }), "admitted", "admit")
        : record
      // deliverInbox moves a run to working before it prompts, so an idle or
      // stopped run starting here was started from outside: a held run resumes.
      return withoutHold(withoutRetrying(transition(resuming ? consumeStopIntent(admitted) : admitted, "working", trigger)))
    })
    if (working === undefined || !applied.changed) return undefined
    return working
  }

  if (event.type === RETRY_SCHEDULED) {
    const at = typeof payload.at === "number" ? payload.at : Date.now()
    const attemptNum = typeof payload.attempt === "number" ? payload.attempt : 1
    const parsedError = Option.getOrUndefined(Schema.decodeUnknownOption(FailedError)(payload.error))
    const errorObj = { type: parsedError?.type ?? "error", message: parsedError?.message ?? "" }
    const retrying = { until: new Date(at).toISOString(), attempt: attemptNum, error: errorObj }

    const notify: { action?: { text: string; parentID: string } } = {}

    const updated = await updateRun(root, run.id, (record) => {
      const lastIndex = record.attempts.length - 1
      const lastAttempt = lastIndex >= 0 ? record.attempts[lastIndex] : undefined

      const alreadyNotified = (lastAttempt?.notifiedErrors ?? []).includes(errorObj.type)
      const shouldNotify = !alreadyNotified && at - Date.now() >= 10 * 60_000

      let nextAttempts = record.attempts
      if (shouldNotify && lastAttempt !== undefined) {
        const updatedAttempt: AttemptRecord = {
          ...lastAttempt,
          notifiedErrors: [...(lastAttempt.notifiedErrors ?? []), errorObj.type],
        }
        nextAttempts = [...record.attempts.slice(0, lastIndex), updatedAttempt]

        if (record.parent !== null && record.parent !== undefined) {
          const modelObj = lastAttempt.resolvedModel ?? record.resolvedModel
          const providerModel = modelObj ? `${modelObj.providerID}/${modelObj.modelID}` : "unknown"
          const text = `Run ${record.id} (${record.role}, ${providerModel}) got ${retryReason(parsedError ?? errorObj)}. It retries at ${utcTime(at)} UTC, attempt ${attemptNum}. Wait, or stop it with team_stop force and delegate the Brief to another worker.`
          notify.action = { text, parentID: record.parent }
        }
      }

      return {
        ...record,
        retrying,
        attempts: nextAttempts,
      }
    })

    if (notify.action !== undefined) {
      const parentRecord = await loadRun(root, notify.action.parentID)
      if (parentRecord !== undefined && !isTerminal(parentRecord.state)) {
        await notifySafe(root, notify.action.parentID, run.id, notify.action.text)
        await deliverInbox(ctx, root, parentRecord)
      }
    }

    return updated
  }

  if (event.type === "session.moved") {
    return onSessionMoved(root, run, payload)
  }

  const outcome = SessionOutcomes[event.type]
  if (outcome === undefined) return undefined
  return onSessionIdle(
    ctx,
    root,
    run,
    outcome,
    Option.getOrUndefined(Schema.decodeUnknownOption(FailedError)(payload.error)),
    outcome === "interrupted" && payload.reason === "inactivity",
  )
}

// A reopened child's chat moves to its new worktree before its follow-up
// (api-followup reopenChild), and the move wakes it into an empty run. That
// run's events come after the reopen and before the follow-up's attempt
// starts, which waits it out: they are no turn of the run, and settling one
// would end the follow-up as a turn without a report.
function movedRun(run: RunRecord, created: number | undefined): boolean {
  if (created === undefined) return false
  const reopened = run.history.findLast((entry) => "trigger" in entry && entry.trigger === "reopened")
  if (reopened === undefined || created < Date.parse(reopened.at)) return false
  const next = run.attempts.find((attempt) => Date.parse(attempt.startedAt) >= Date.parse(reopened.at))
  return next === undefined || created < Date.parse(next.startedAt)
}

// A chat may move between checkouts. A root run with no open children follows
// its chat: the run takes the new folder's directory, branch, base and head,
// and one history entry records the move. A root run with an open child stays
// where it is — the child's worktree and the landing both belong to the old
// checkout — and remembers where the chat went so its next team call says so.
// A delegated run is tied to its own worktree and never follows the chat.
async function onSessionMoved(root: string, run: RunRecord, payload: Record<string, unknown>): Promise<RunRecord | undefined> {
  const location = payload.location as { readonly directory?: unknown } | undefined
  const directory = typeof location?.directory === "string" ? location.directory : undefined
  if (directory === undefined || directory.length === 0) return undefined
  if (run.parent !== null && run.parent !== undefined) return undefined
  const open = await openChildren(root, run.id)
  if (open.length > 0) {
    // The chat returning to the run's own folder clears any pending notice.
    const target = directory === run.directory ? undefined : directory
    if (run.movedTo === target) return undefined
    return updateRun(root, run.id, (record) => {
      const next: RunRecord = { ...record, lastUsed: new Date().toISOString() }
      if (target === undefined) delete next.movedTo
      else next.movedTo = target
      return next
    })
  }
  const headOut = await gitRaw(directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
  if (headOut.code !== 0) return undefined
  const branchOut = await gitRaw(directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--abbrev-ref", "HEAD"])
  const branch = branchOut.code === 0 && branchOut.out.length > 0 ? branchOut.out : "HEAD"
  const topOut = await gitRaw(directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--show-toplevel"])
  const repoKey = topOut.code === 0 && topOut.out.length > 0 ? path.basename(topOut.out) : run.repoKey
  const now = new Date().toISOString()
  return updateRun(root, run.id, (record) => {
    if (record.directory === directory && record.head === headOut.out) return record
    const next: RunRecord = {
      ...record,
      directory,
      projectDirectory: directory,
      repo: repoKey,
      repoKey,
      branch,
      base: headOut.out,
      head: headOut.out,
      lastUsed: now,
      history: [...record.history, { at: now, from: record.state, to: record.state, trigger: "session_moved" }],
    }
    delete next.movedTo
    return next
  })
}

// A plain subagent (no team run) gets the parent the same notice: core retries
// a provider error up to 10 times, honouring the provider's retry-after up to
// 15 minutes each, and the subagent tool reports only when the child ends, so
// an out-of-quota child would otherwise leave its parent waiting for hours.
// Once per error type per busy period, under the team thresholds. Shared by
// every Plus instance in the process, so one event notifies once.
const subagentNotices = new Map<string, Set<string>>()

async function onSubagentEvent(ctx: Context, sessionID: string, type: string, payload: Record<string, unknown>) {
  if (type === "session.execution.started") {
    subagentNotices.delete(sessionID)
    return
  }
  if (type !== RETRY_SCHEDULED) return
  const error = Option.getOrUndefined(Schema.decodeUnknownOption(FailedError)(payload.error)) ?? { type: "error", message: "" }
  const at = typeof payload.at === "number" ? payload.at : Date.now()
  const attempt = typeof payload.attempt === "number" ? payload.attempt : 1
  const notified = subagentNotices.get(sessionID) ?? new Set<string>()
  if (notified.has(error.type) || at - Date.now() < 10 * 60_000) return
  // Claimed before any await: concurrent deliveries of the same event see it.
  subagentNotices.set(sessionID, notified.add(error.type))
  for (const key of [...subagentNotices.keys()].slice(0, Math.max(0, subagentNotices.size - 500))) subagentNotices.delete(key)
  const child = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(() => undefined)
  if (child?.parentID === undefined) return
  const model = child.model === undefined ? "" : ` on ${child.model.providerID}/${child.model.id}`
  const text = `Subagent ${sessionID}${model} got ${retryReason(error)}. It retries at ${utcTime(at)} UTC, attempt ${attempt}, and keeps retrying until the provider answers or it gives up. Wait for it, or give its task to a subagent on another model; this one cannot be stopped from here (the user can stop it).`
  await Effect.runPromise(ctx.session.prompt({ sessionID: Session.ID.make(child.parentID), text })).catch(() => undefined)
}

// "HttpError (HTTP 429): message"; an error with an empty body still names its status.
function retryReason(error: { readonly type: string; readonly message: string; readonly status?: number }) {
  const status = error.status === undefined ? "" : ` (HTTP ${error.status})`
  const message = error.message.slice(0, 200)
  return `${error.type}${status}${message === "" ? "" : `: ${message}`}`
}

function utcTime(at: number) {
  const date = new Date(at)
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`
}

// The host's reason for a failed execution (core's SessionError.Error): what
// the parent needs to tell a provider that is out of quota from a broken run.
const FailedError = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
})

// Order matters: settle the attempt that just ended, move the run to idle,
// tell the parent once, then drain the inbox. Draining last means a followup
// queued mid-turn starts a NEW attempt instead of reopening the one that
// ended, and the parent sees the settlement before the next attempt begins.
export async function onSessionIdle(
  ctx: Context,
  root: string,
  run: RunRecord,
  outcome: SessionOutcome = "idle",
  error?: AttemptError,
  inactive = false,
): Promise<RunRecord> {
  // The settle, the notify bookkeeping and a pending stop transition in one
  // state-lock hold: this pass must not save a record it read before a
  // concurrent removal, and it must not open a second read-modify-write window
  // between settling and stopping.
  const settled: { attempt?: AttemptRecord; stopped: boolean; nudged: boolean } = { stopped: false, nudged: false }
  const marked = await updateRun(root, run.id, async (current) => {
    if (isTerminal(current.state)) return current
    const ended = await settleAttempt(root, current, outcome, error)
    settled.nudged = ended.attempts.at(-1)?.finishNudged === true && current.attempts.at(-1)?.finishNudged !== true
    // A stop ends a waiting attempt too: nobody will continue it.
    const settledIdle = toIdle(current.stopRequested === true ? interruptOpenAttempt(ended) : ended)
    // A turn the host stopped after an hour of silence most likely hung; the
    // next team news would prompt it straight back into the same hang.
    const idle = inactive ? { ...settledIdle, held: { at: new Date().toISOString(), reason: "inactivity" as const } } : settledIdle
    const attempt = idle.attempts[idle.attempts.length - 1]
    const announce =
      idle.parent !== null &&
      idle.parent !== undefined &&
      attempt !== undefined &&
      isAttemptTerminal(attempt.state) &&
      attempt.notified !== true
    const next = announce ? markNotified(idle) : idle
    if (announce && attempt !== undefined) settled.attempt = attempt
    // A stopped run's session can still end a turn (a prompt admitted before
    // the stop): it is stopped already.
    if (!next.stopRequested || next.state === "stopping" || next.state === "stopped") return next
    settled.stopped = true
    const stopped = transition(transition(next, "stopping", "shutdown"), "stopped", "exited")
    return next.stopRequestedBy !== undefined ? { ...stopped, stoppedBy: next.stopRequestedBy } : stopped
  })
  if (marked === undefined) return (await loadRun(root, run.id)) ?? run
  if (settled.nudged) await put(root, marked.id, { kind: "system", from: "plus", text: FINISH_NUDGE })
  if (settled.attempt !== undefined) await notifyParent(ctx, root, marked, settled.attempt)
  if (settled.stopped) {
    await evictRunFolder(ctx, marked)
    return marked
  }
  return deliverInbox(ctx, root, marked)
}

async function settleAttempt(root: string, run: RunRecord, outcome: SessionOutcome, error?: AttemptError): Promise<RunRecord> {
  const current = withoutRetrying(run)
  const last = current.attempts[current.attempts.length - 1]
  if (last === undefined || isAttemptTerminal(last.state)) return current
  if (outcome === "failed") {
    const failed = attemptTransition(current, "failed", "failed")
    if (error === undefined) return failed
    const attempt = failed.attempts.at(-1)
    if (attempt === undefined) return failed
    return { ...failed, attempts: [...failed.attempts.slice(0, -1), { ...attempt, error }] }
  }
  if (outcome === "interrupted") return attemptTransition(current, "interrupted", "interrupt")
  // finish wrote this attempt's report and owns its terminal state.
  const reported = await readJson<unknown>(path.join(root, "runs", current.id, `report-${last.n}.json`))
  if (reported !== undefined) return current
  // A turn that ends without a report while a child can still settle — or
  // while a child's settlement waits undelivered in the inbox — is a run
  // waiting on its children, not one that stopped: the attempt stays open,
  // the run goes idle, its parent hears nothing, and the child's settlement
  // continues this same attempt (deliverInbox). Only a run with no open child
  // and no pending child news ended its attempt without a report.
  if (await waitingOnChildren(root, current)) return current
  // A delegated run whose turn ended without team_finish is asked once to
  // report (b8-s5: an orchestrator ended on a summary text, and its parent
  // spent four calls finding out and asking). The attempt stays open and the
  // request continues it; a second turn without a report ends it.
  if (current.parent !== null && current.parent !== undefined && current.stopRequested !== true && last.finishNudged !== true)
    return { ...current, attempts: [...current.attempts.slice(0, -1), { ...last, finishNudged: true }] }
  return attemptTransition(toFinishing(current), "no_report", "validated")
}

const FINISH_NUDGE =
  "Your turn ended without team_finish, so your parent has heard nothing. Report now with team_finish: done when the Brief's work is committed, otherwise done_with_concerns or blocked, saying what is left."

/** A retry wait ends when the step settles or a new execution starts. */
function withoutRetrying(run: RunRecord): RunRecord {
  if (run.retrying === undefined) return run
  const next = { ...run }
  delete next.retrying
  return next
}

/** A hold ends when someone resumes the run: a prompt in its chat or its parent's team_followup. */
export function withoutHold(run: RunRecord): RunRecord {
  if (run.held === undefined) return run
  const next = { ...run }
  delete next.held
  return next
}

/** True while a child of `run` can still settle or its settlement is not yet delivered. */
export async function waitingOnChildren(root: string, run: RunRecord): Promise<boolean> {
  if ((await openChildren(root, run.id)).length > 0) return true
  const delivered = new Set(run.attempts.flatMap((attempt) => attempt.inbox ?? []))
  const children = new Set(run.children)
  const pending = await peek(root, run.id)
  return pending.some((item) => !delivered.has(item.id) && (item.kind === "child.settled" || children.has(item.from)))
}

/** Marks a still-open last attempt interrupted; a terminal one is left as it is. */
export function interruptOpenAttempt(run: RunRecord): RunRecord {
  const last = run.attempts.at(-1)
  if (last === undefined || isAttemptTerminal(last.state)) return run
  return attemptTransition(run, "interrupted", "interrupt")
}

// 02 §1: working reaches idle on turn_ended; a still-starting run (the normal
// freshly delegated child) reaches the same idle on connected.
function toIdle(run: RunRecord): RunRecord {
  if (run.state === "working") return transition(run, "idle", "turn_ended")
  if (run.state === "starting") return transition(run, "idle", "connected")
  return run
}

/**
 * Stops an idle run now. A run waiting on its children is idle with its
 * attempt still open; that attempt ends interrupted, and the run's parent is
 * told once — unless `by`, the run that asked for the stop, is that parent.
 */
export async function stopIdle(ctx: Context, root: string, run: RunRecord, by?: string): Promise<RunRecord> {
  const open = run.attempts.at(-1)
  const waiting = open !== undefined && !isAttemptTerminal(open.state)
  const ended = interruptOpenAttempt(run)
  const stoppedTransition = transition(transition(ended, "stopping", "shutdown"), "stopped", "exited")
  const stopped = by !== undefined ? { ...stoppedTransition, stoppedBy: by } : stoppedTransition
  const attempt = stopped.attempts.at(-1)
  const toSave = waiting ? markNotified(stopped) : stopped
  await saveRun(root, toSave)
  await evictRunFolder(ctx, toSave)
  if (waiting && attempt !== undefined && stopped.parent !== null && stopped.parent !== by)
    await notifyParent(ctx, root, stopped, attempt)
  return toSave
}

/**
 * Releases a stopped run's worker folder now, so its MCP servers and plugin
 * loops go with it instead of waiting for the 60-minute idle timeout. A folder
 * with another active Session is left to the timeout (LocationActivity.evict
 * checks that). A plugin context without the seam, or a run with no directory,
 * is a no-op.
 */
export async function evictRunFolder(ctx: Context, run: RunRecord): Promise<void> {
  if (run.directory === undefined || run.directory === "") return
  await Effect.runPromise(
    ctx.locations.evict(Location.Ref.make({ directory: AbsolutePath.make(run.directory) })).pipe(Effect.ignore),
  )
}

function markNotified(run: RunRecord): RunRecord {
  const last = run.attempts[run.attempts.length - 1]
  if (last === undefined) return run
  const updated: AttemptRecord = { ...last, notified: true }
  return { ...run, attempts: [...run.attempts.slice(0, -1), updated] }
}

// The settlement is the parent's whole view of the attempt: the report in
// full (a parent knows only the report, team_status and team_diff), and one
// next: line for what the outcome calls for. The report file stays on disk
// for the record; nobody needs a call to read it.
interface SettledReport {
  readonly status?: unknown
  readonly summary?: unknown
  readonly concerns?: unknown
  readonly needs?: unknown
  readonly findings?: unknown
  readonly deferred?: unknown
  readonly commits?: unknown
  readonly checks?: unknown
  readonly head?: unknown
  readonly dirtyFiles?: unknown
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export function childSettledText(
  run: RunRecord,
  attempt: AttemptRecord,
  report: SettledReport | undefined,
  _reportPath?: string,
): string {
  const task = run.task ?? "-"
  const status = typeof report?.status === "string" ? report.status : attempt.state
  const lines = [`[team] ${run.id} (${run.role}, ${task}) settled: ${status} — attempt ${attempt.n} ${attempt.state}.`]
  if (report === undefined) {
    lines.push(`No report: attempt ${attempt.n} ended ${attempt.state} without team_finish.`)
    if (run.parent !== null && run.state === "stopped" && (run.stopRequestedBy ?? run.stoppedBy) === run.parent) {
      lines.push("next: nothing is needed; you stopped this child. team_followup resumes it with its context.")
      return lines.join("\n")
    }
    if (run.held !== undefined) {
      lines.push(
        "No session activity for an hour, so the host stopped it; it is held and nothing resumes it on its own. It most likely hung (a permission ask nobody answers, a stuck tool or a silent model).",
      )
      lines.push(`next: read team_status and team_diff with run: "${run.id}", then team_followup to resume it or team_stop.`)
      return lines.join("\n")
    }
    // The host says why: a provider or quota error is the member's model being
    // unavailable, not the Brief going wrong, so another member can take it.
    const error = attempt.error
    if (error !== undefined) {
      lines.push(`Error: ${error.type}${error.status === undefined ? "" : ` (${error.status})`}: ${error.message}`)
      lines.push(
        `next: if the member's model is unavailable (quota, rate limit, provider down), team_stop it and delegate the same Brief to another member; otherwise read team_status and team_diff with run: "${run.id}", then team_followup or team_stop.`,
      )
      return lines.join("\n")
    }
    lines.push(`next: read team_status and team_diff with run: "${run.id}", then team_followup or team_stop.`)
    return lines.join("\n")
  }
  if (typeof report.summary === "string" && report.summary.trim() !== "") lines.push(report.summary.trim())
  const commits = list<{ sha?: string; subject?: string }>(report.commits)
  if (commits.length > 0)
    lines.push(`Commits: ${commits.map((commit) => `${String(commit.sha ?? "").slice(0, 7)} ${commit.subject ?? ""}`.trim()).join("; ")}`)
  const checks = list<{ id?: string; passed?: boolean }>(report.checks)
  if (checks.length > 0) lines.push(`Checks: ${checks.map((check) => `${check.id} ${check.passed ? "pass" : "FAIL"}`).join(", ")}`)
  const dirty = list<string>(report.dirtyFiles)
  if (dirty.length > 0) lines.push(`Uncommitted: ${pathList(dirty)}`)
  const block = (title: string, items: string[]) => {
    if (items.length > 0) lines.push(`${title}:\n${items.map((item) => `- ${item}`).join("\n")}`)
  }
  block("Needs", list<{ kind?: string; detail?: string }>(report.needs).map((need) => `${need.kind}: ${need.detail}`))
  block("Concerns", list<string>(report.concerns))
  block("Deferred", list<string>(report.deferred))
  block("Findings", list<{ severity?: string; path?: string; detail?: string }>(report.findings).map((f) => `${f.severity} ${f.path}: ${f.detail}`))
  lines.push(`next: ${nextStep(run.id, status, commits.length > 0)}`)
  return lines.join("\n")
}

// The run id is named: a parent told only "team_diff" diffed its own run.
function nextStep(id: string, status: string, committed: boolean): string {
  if (status === "done") return committed ? landStep(id) : "use the result; there is nothing to land."
  if (status === "done_with_concerns") {
    // A parent that landed the partial work delegated the rest to a new,
    // cold run although the landed child resumes with its context.
    const rest = "Work a concern leaves undone goes to this run with team_followup (paths: for files outside its scope), also once it has landed: it keeps its context."
    return committed ? `weigh the concerns, then ${landStep(id)} ${rest}` : `weigh the concerns and use the result; there is nothing to land. ${rest}`
  }
  if (status === "rejected") return "re-scope: team_stop it and delegate a Brief that fits."
  return "answer the needs with team_followup (paths for a path need), or team_stop it and delegate afresh."
}

function landStep(id: string): string {
  return `check the change with team_diff run: "${id}", then land it with team_integrate run: "${id}".`
}

// One settlement, one inbox item. An idle parent is prompted with it now;
// a working parent gets it through its own idle drain.
async function notifyParent(ctx: Context, root: string, child: RunRecord, attempt: AttemptRecord): Promise<void> {
  const parentID = child.parent
  if (parentID === null || parentID === undefined || parentID === child.id) return
  const parent = await loadRun(root, parentID)
  if (parent === undefined || isTerminal(parent.state) || parent.state === "dead") return
  const reportPath = path.join(root, "runs", child.id, `report-${attempt.n}.json`)
  const report = await readJson<SettledReport>(reportPath)
  const displayPath = report === undefined ? undefined : path.join(root, "runs", child.id, `report-${attempt.n}.md`)
  await Effect.runPromise(
    io(() =>
      put(root, parentID, { kind: "child.settled", from: child.id, text: childSettledText(child, attempt, report, displayPath) }),
    ).pipe(Effect.ignore),
  )
  await deliverInbox(ctx, root, parent)
}

// The idle handoff: everything pending becomes ONE prompt. A run whose last
// attempt ended gets a new attempt for it; a run waiting on its children (its
// attempt still open, see settleAttempt) continues that same attempt, so a
// child's settlement wakes the parent mid-task instead of opening a new task.
// Items already delivered as an earlier prompt are consumed without being
// prompted again, so an immediately delivered followup is not repeated.
export async function deliverInbox(ctx: Context, root: string, run: RunRecord): Promise<RunRecord> {
  const sessionID = run.sessionID
  if (sessionID === null || sessionID === undefined) return run
  const delivery: { text: string; items: InboxItem[]; previous?: RunRecord } = { text: "", items: [] }
  const working = await updateRun(root, run.id, async (current) => {
    // A held run keeps its inbox; it is delivered once someone resumes the run.
    if (current.state !== "idle" || current.worktree === "removed" || current.held !== undefined) return current
    // Only the last attempt may be open (run.ts attemptTransition).
    if (current.attempts.slice(0, -1).some((attempt) => !isAttemptTerminal(attempt.state))) return current
    const items = await peek(root, run.id)
    const delivered = new Set(current.attempts.flatMap((attempt) => attempt.inbox ?? []))
    const fresh = items.filter((item) => !delivered.has(item.id))
    const text = renderInbox(fresh)
    delivery.items = items
    if (text === "") return current
    delivery.text = text
    delivery.previous = current
    const last = current.attempts.at(-1)
    const waiting = last !== undefined && !isAttemptTerminal(last.state)
    const admitted = waiting
      ? current
      : attemptTransition(startAttempt(current, { trigger: "followup", prompt: text }), "admitted", "admit")
    return recordInboxDelivery(
      transition(admitted, "working", "prompt"),
      fresh.map((item) => item.id),
    )
  })
  if (working === undefined || delivery.text === "") {
    if (delivery.items.length > 0) await take(root, run.id, delivery.items.map((item) => item.id))
    return working ?? run
  }
  const previous = delivery.previous ?? run
  await Effect.runPromise(
    ctx.session
      .prompt({ sessionID: Session.ID.make(sessionID), text: delivery.text })
      .pipe(
        // Admission normally takes milliseconds; a hang leaves the run working
        // with its inbox undelivered, so say so in the log while it lasts.
        slowWarning("team inbox prompt", { run: run.id, sessionID }),
        Effect.onError(() =>
          Effect.ignore(
            io(() =>
              updateRun(root, run.id, (current) => {
                if (isTerminal(current.state)) return current
                return {
                  ...current,
                   state: previous.state,
                   attempts: previous.attempts,
                   history: previous.history,
                }
              }),
            ),
          ),
        ),
      ),
  )
  await take(root, run.id, delivery.items.map((item) => item.id))
  return working
}

/** Logs a warning every 30 s while `effect` runs, and once more when a slow one ends. */
export function slowWarning(label: string, fields: Record<string, string>, detail?: () => Record<string, string>) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const started = Date.now()
      const warn = yield* Effect.forkDetach(
        Effect.sleep(Duration.seconds(30)).pipe(
          Effect.andThen(Effect.suspend(() => Effect.logWarning(`${label} is slow`, { ...fields, ...detail?.(), waitedMs: Date.now() - started }))),
          Effect.repeat(Schedule.spaced(Duration.seconds(30))),
        ),
      )
      return yield* effect.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Fiber.interrupt(warn)
            const waited = Date.now() - started
            if (waited >= 30_000) yield* Effect.logWarning(`${label} ended`, { ...fields, waitedMs: waited })
          }),
        ),
      )
    })
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
// function; nothing else schedules periodic team work. gc is expensive and
// mostly unnecessary, so it runs at most every policy.sweep.reconcileMs even
// though a pass runs every tick.
export async function sweep(ctx: Context, root: string): Promise<SweepResult> {
  const dead = await reconcile(ctx, root)
  const now = Date.now()
  if (now - lastGcAt < policy.sweep.reconcileMs)
    return { dead, gc: { reaped: [], skippedDirty: [], orphansRemoved: [], removeFailed: [] } }
  lastGcAt = now
  return { dead, gc: await gc(root, policy, { background: true }) }
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

export interface GcOptions {
  /** The periodic sweep's background pass: try the repository lock once and
   * skip the orphan sweep when it is busy, instead of waiting for it. */
  background?: boolean
}

export async function gc(root: string, customPolicy?: Policy, opts?: GcOptions): Promise<GcResult> {
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
          const porcelain = await gitRaw(record.directory, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"])
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
  //
  // The lock is only worth taking when the cheap unlocked scan already found a
  // candidate: most passes have none, and taking the repository lock on every
  // one of them starved the rare real operation. The unlocked scan is advisory
  // — the in-lock re-list is what decides — so a candidate that is really a
  // worktree registered after the opening snapshot is kept. A background pass
  // (`opts.background`) tries the lock once: a busy lock means another
  // operation is mid-flight, and the next pass re-scans rather than waiting
  // behind it, quietly and without a "sweep failed" log. An explicit call
  // waits for the lock, as it always has.
  const orphansRemoved: string[] = []
  for (const [repoKey, repoRoot] of repoRoots.entries()) {
    const snapshotKnownDirs = allRuns
      .filter((record) => record.repoKey === repoKey && record.worktree !== "removed")
      .map((record) => record.directory)
    const candidates = await orphans(repoRoot, ownedRoot(root, repoKey), snapshotKnownDirs, {
      minAgeMs: pol.timeouts.startMs,
    }).catch(() => [] as string[])
    if (candidates.length === 0) continue
    const removed = await lock(
      root,
      "repo",
      repoKey,
      async () => {
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
        const done: string[] = []
        for (const orphanPath of orphanList) {
          try {
            await removeLocked(orphanPath, { repoRoot, repoKey, force: true })
            done.push(orphanPath)
          } catch {
            // ignore
          }
        }
        return done
      },
      { timeoutMs: opts?.background === true ? 0 : undefined, op: "gc-orphans" },
    ).catch((error: unknown) => {
      if (opts?.background === true && errCode(error) === "E_LOCKED") return [] as string[]
      throw error
    })
    orphansRemoved.push(...removed)
  }

  // A worktree removed with `git worktree remove` outside `removeLocked` (or
  // by an older Plus) leaves its snapshot store behind; the orphan scan cannot
  // see the store, so the same pass sweeps those.
  await removeLeftoverSnapshotStores(root)

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

/**
 * Runs one sweep pass at a time per process, then every tickMs until the
 * plugin scope closes. Each loaded workspace forks its own loop, but the
 * module-level permit lets only one of them run a pass; the rest skip this
 * tick and try again. `lastPassAt` keeps the winning loop from running passes
 * back to back when its own tick fires while another workspace's pass is still
 * in flight.
 */
export function startSweep(ctx: Context, root: string, tickMs = policy.sweep.tickMs): Effect.Effect<void, never, Scope.Scope> {
  const pass = Effect.suspend(() => {
    const now = Date.now()
    if (now - lastPassAt < tickMs) return Effect.void
    return sweepPermit.withPermitsIfAvailable(1)(
      Effect.suspend(() => {
        lastPassAt = Date.now()
        return Effect.promise(() => sweep(ctx, root))
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("plus team sweep failed", { cause }))),
    ).pipe(Effect.asVoid)
  })
  return pass.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(tickMs))),
    Effect.forkScoped,
    Effect.asVoid,
  )
}

export interface OverBudgetChildInfo {
  id: string
  role: string
  minutesOver: number
  dims: Array<{ name: string; used: number; budget: number }>
}

export async function checkBudgets(
  ctx: Context,
  root: string,
  table?: PermissionTable,
  now = Date.now(),
): Promise<void> {
  const entries = await Effect.runPromise(
    io(() => readdir(path.join(root, "runs"))).pipe(
      Effect.map((names) => [...names]),
      Effect.catchCause(() => Effect.succeed([] as string[])),
    ),
  )

  const parentDueMap = new Map<string, OverBudgetChildInfo[]>()
  const dueChildIds: string[] = []

  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const record = await loadRecordSafe(root, entry)
    if (record === undefined || isTerminal(record.state)) continue
    if (record.state !== "working" || !record.parent) continue
    const parentRecord = await loadRecordSafe(root, record.parent)
    if (parentRecord === undefined || isTerminal(parentRecord.state) || parentRecord.state === "dead") continue

    const hasConfiguredBudget =
      typeof record.budget.turns === "number" ||
      typeof record.budget.tokens === "number" ||
      typeof record.budget.wallMs === "number"
    if (!hasConfiguredBudget) continue

    const tokensUsed = await sessionTokens(ctx, record)
    const exhaustion = budgetExhaustion(record, { tokensUsed, now })

    if (exhaustion.exhausted) {
      let exceededAt = record.budgetExceededAt
      if (exceededAt === undefined) {
        exceededAt = new Date(now).toISOString()
        await updateRun(root, record.id, (fresh) => ({ ...fresh, budgetExceededAt: exceededAt }))
      }

      const exceededMs = Date.parse(exceededAt)
      const minutesOver = Number.isFinite(exceededMs) ? Math.max(0, Math.floor((now - exceededMs) / 60_000)) : 0

      const pingRow =
        parentRecord !== undefined && table !== undefined
          ? bound(table, parentRecord.role, "followup", "limits.budget-ping")
          : undefined
      const pingIntervalMs = (pingRow ?? 15) * 60_000

      const lastPing = record.lastBudgetPingAt ? Date.parse(record.lastBudgetPingAt) : undefined
      const isDue = lastPing === undefined || now - lastPing >= pingIntervalMs

      if (isDue) {
        const dims = budgetDimensions(record, { tokensUsed, now })
          .filter((d) => d.used >= d.budget)
          .map((d) => ({ name: d.name, used: Math.round(d.used), budget: Math.round(d.budget) }))
        const info: OverBudgetChildInfo = {
          id: record.id,
          role: record.role,
          minutesOver,
          dims,
        }
        const list = parentDueMap.get(record.parent) ?? []
        list.push(info)
        parentDueMap.set(record.parent, list)
        dueChildIds.push(record.id)
      }
      continue
    }

    if (record.budgetExceededAt !== undefined || record.lastBudgetPingAt !== undefined) {
      await updateRun(root, record.id, (fresh) => {
        delete fresh.budgetExceededAt
        delete fresh.lastBudgetPingAt
        return fresh
      })
    }
  }

  for (const [parentId, children] of parentDueMap) {
    // Store one pending notice per child; delivery still batches all notices
    // into one prompt. An unread ping must not grow the inbox every interval.
    for (const c of children) {
      const dimsText = c.dims.map((d) => `${d.name} ${d.used}/${d.budget}`).join(", ")
      const text = `Budget exceeded for child run:\n- Run ${c.id} (${c.role}): ${dimsText}, ${c.minutesOver} min over\nFollow up with team_followup to raise budget (with reason), nudge, or stop with team_stop.`
      await notifySafe(root, parentId, c.id, text, `budget:${c.id}`)
    }
  }

  for (const childId of dueChildIds) {
    await updateRun(root, childId, (fresh) => ({
      ...fresh,
      lastBudgetPingAt: new Date(now).toISOString(),
    }))
  }
}

export async function reconcile(ctx: Context, root: string): Promise<string[]> {
  await checkBudgets(ctx, root).catch(() => {})
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
