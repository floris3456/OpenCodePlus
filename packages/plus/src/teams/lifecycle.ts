import { readdir } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Duration, Effect, Option, Schedule, Schema, type Scope } from "effect"
import { batchNotify, partition, put, take, type InboxItem } from "./inbox.js"
import { io } from "./io.js"
import {
  attemptTransition,
  bySession,
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
import { Policy } from "./schema.js"
import { readJson } from "./store.js"

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
const OUTCOMES: Record<string, SessionOutcome> = {
  "session.idle": "idle",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
}

export const SessionRunEvents: ReadonlySet<string> = new Set(Object.keys(OUTCOMES))

/** Maps one host session event onto its run, if any. Sessions without a run are ignored. */
export async function onSessionEvent(
  ctx: Context,
  root: string,
  event: { type: string; properties?: Record<string, unknown>; data?: unknown },
): Promise<RunRecord | undefined> {
  const outcome = OUTCOMES[event.type]
  if (outcome === undefined) return undefined
  const payload = (event.properties ?? event.data ?? {}) as Record<string, unknown>
  const sessionID = payload.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined
  const run = await bySession(root, sessionID)
  if (run === undefined) return undefined
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
export async function sweep(ctx: Context, root: string): Promise<string[]> {
  return reconcile(ctx, root)
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
