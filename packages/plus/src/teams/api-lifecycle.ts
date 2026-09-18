import path from "node:path"
import { readdir } from "node:fs/promises"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect, Option, Schema } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { gitRaw } from "./git.js"
import { put } from "./inbox.js"
import { io } from "./io.js"
import { loadRun, saveRun, transition, type RunRecord } from "./run.js"
import { RunID } from "./schema.js"
import { readJson } from "./store.js"
import { setState } from "./tasks.js"
import type { TeamApiResult, TeamCaller } from "./api.js"

const StopInput = Schema.Struct({
  run: RunID,
})

const SupersedeInput = Schema.Struct({
  run: RunID,
  reason: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(500)),
  waitMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(120000))),
})

const STOP_BUSY_MESSAGE = "Child is working; call shutdown_request then wait, or supersede."

function succeeded(value: unknown): TeamApiResult {
  return { ok: true, value }
}

function fail(code: string, message: string, accepted?: unknown): TeamApiResult {
  if (accepted === undefined) return { ok: false, error: { code, message } }
  return { ok: false, error: { code, message, accepted } }
}

function notChild(parent: RunRecord, runID: string): TeamApiResult {
  return fail(
    "E_NOT_CHILD",
    `Run ${runID} is not your direct child. Your children: [${parent.children.join(", ")}]. Use status to read others.`,
    parent.children,
  )
}

async function interruptSession(ctx: Context, sessionID: string | null): Promise<void> {
  if (sessionID === null) return
  const sessions = ctx.session
  await Effect.runPromise(Effect.ignore(sessions.interrupt({ sessionID: Session.ID.make(sessionID) })))
}

async function headInfo(record: RunRecord): Promise<{ hadUncommitted: boolean; head: string }> {
  const statusOpt = await Effect.runPromise(Effect.option(io(() => gitRaw(record.directory, ["status", "--porcelain"]))))
  const status = Option.getOrUndefined(statusOpt)
  const hadUncommitted = status !== undefined && status.code === 0 && status.out.trim().length > 0
  const headOpt = await Effect.runPromise(Effect.option(io(() => gitRaw(record.directory, ["rev-parse", "HEAD"]))))
  const headValue = Option.getOrUndefined(headOpt)
  const head = headValue !== undefined && headValue.code === 0 && headValue.out.length > 0 ? headValue.out : record.head
  return { hadUncommitted, head }
}

async function findPlanForTask(root: string, taskID: string): Promise<string | undefined> {
  const dir = path.join(root, "tasks")
  const entries = await readdir(dir).catch(() => [])
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue
    const graph = await readJson<{ tasks?: Record<string, unknown> }>(path.join(dir, name))
    if (graph?.tasks !== undefined && Object.hasOwn(graph.tasks, taskID)) return name.slice(0, -5)
  }
  return undefined
}

async function cancelTask(root: string, taskID: string | null, by: string): Promise<void> {
  if (taskID === null) return
  const planRun = await findPlanForTask(root, taskID)
  if (planRun === undefined) return
  await Effect.runPromise(Effect.ignore(io(() => setState(root, planRun, taskID, "cancelled", by))))
}

async function waitForNotWorking(root: string, runID: string, waitMs: number): Promise<RunRecord | undefined> {
  let current = await loadRun(root, runID)
  if (current === undefined) return undefined
  if (current.state !== "working") return current
  const deadline = Date.now() + waitMs
  while (current !== undefined && current.state === "working" && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
    current = await loadRun(root, runID)
  }
  return current
}

export async function stopHandler(ctx: Context, input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(StopInput)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid stop input.")
  const args = decoded.value
  const stored = await loadRun(root, caller.run.id)
  const parent = stored ?? caller.run
  const child = await loadRun(root, args.run)
  if (child === undefined || child.parent !== parent.id) return notChild(parent, args.run)
  if (child.state === "stopped") return succeeded({ run: child.id, state: "stopped" })
  if (child.state === "idle") {
    await interruptSession(ctx, child.sessionID)
    const stopping = transition(child, "stopping", "shutdown")
    const stopped = transition(stopping, "stopped", "exited")
    await saveRun(root, stopped)
    return succeeded({ run: child.id, state: "stopped" })
  }
  if (child.state === "dead") {
    const stopped = transition(child, "stopped", "reconcile")
    await saveRun(root, stopped)
    return succeeded({ run: child.id, state: "stopped" })
  }
  return fail("E_BUSY", STOP_BUSY_MESSAGE)
}

export async function supersedeHandler(ctx: Context, input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(SupersedeInput)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid supersede input.")
  const args = decoded.value
  const waitMs = args.waitMs ?? 30000
  const reason = args.reason
  const stored = await loadRun(root, caller.run.id)
  const parent = stored ?? caller.run
  const child = await loadRun(root, args.run)
  if (child === undefined || child.parent !== parent.id) return notChild(parent, args.run)
  if (child.state === "superseded" || child.state === "reaped") {
    const info = await headInfo(child)
    return succeeded({ run: child.id, state: child.state, hadUncommitted: info.hadUncommitted, head: info.head })
  }
  let base = child
  if (child.state === "working") {
    await put(root, child.id, { kind: "shutdown", from: parent.id, text: `Shutdown requested: ${reason}` })
    const settled = await waitForNotWorking(root, child.id, waitMs)
    const current = settled ?? child
    if (current.state === "working") {
      await interruptSession(ctx, current.sessionID)
      const stopping = transition(current, "stopping", "stop_force")
      const stopped = transition(stopping, "stopped", "exited")
      base = stopped
    } else {
      base = current
    }
  }
  let stoppedBase: RunRecord | undefined
  if (base.state === "idle") {
    const stopping = transition(base, "stopping", "shutdown")
    stoppedBase = transition(stopping, "stopped", "exited")
  } else if (base.state === "stopping") {
    stoppedBase = transition(base, "stopped", "exited")
  } else if (base.state === "stopped") {
    stoppedBase = base
  }
  const superseded =
    stoppedBase !== undefined
      ? transition(stoppedBase, "superseded", "supersede", { force: true, reason })
      : transition(base, "superseded", "supersede", { force: true, reason })
  await saveRun(root, superseded)
  await cancelTask(root, superseded.task, parent.id)
  const info = await headInfo(superseded)
  await put(root, parent.id, { kind: "notify", from: child.id, text: `Run ${child.id} superseded: ${reason}`.replace(/\r?\n/g, " ") })
  return succeeded({ run: child.id, state: "superseded", hadUncommitted: info.hadUncommitted, head: info.head })
}
