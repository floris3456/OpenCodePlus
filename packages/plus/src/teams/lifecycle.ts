import { readdir } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect, Option } from "effect"
import { put } from "./inbox.js"
import { io } from "./io.js"
import { attemptTransition, isAttemptTerminal, isTerminal, saveRun, transition, type RunRecord } from "./run.js"
import { readJson } from "./store.js"

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

async function loadRecordSafe(root: string, entry: string): Promise<RunRecord | undefined> {
  const maybe = await Effect.runPromise(
    io(() => readJson<RunRecord>(path.join(root, "runs", entry, "run.json"))).pipe(Effect.option),
  )
  if (Option.isNone(maybe)) return undefined
  const record = maybe.value
  if (record === undefined || record === null) return undefined
  if (typeof record.id !== "string") return undefined
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

export async function reconcile(ctx: Context, root: string): Promise<string[]> {
  const entries = await Effect.runPromise(
    io(() => readdir(path.join(root, "runs"))).pipe(
      Effect.map((names) => [...names]),
      Effect.catchCause(() => Effect.succeed([] as string[])),
    ),
  )
  const dead: string[] = []
  for (const entry of entries) {
    const id = await reconcileOne(ctx, root, entry)
    if (id !== undefined) dead.push(id)
  }
  return dead.toSorted()
}
