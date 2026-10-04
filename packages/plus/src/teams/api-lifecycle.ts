import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { put } from "./inbox.js"
import { stopIdle } from "./lifecycle.js"
import { isTerminal, loadRun, saveRun, transition, type RunRecord } from "./run.js"
import { StopInput } from "./schema.js"
import type { PermissionTable } from "../instructions/permission-enforce.js"
import { mayReach, relationOf } from "./reach.js"
import type { TeamApiResult, TeamCaller } from "./api.js"

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

// A run the caller may stop: a direct child always, a deeper descendant or any
// other run only when the member's Runs rows allow it.
async function reachable(root: string, caller: RunRecord, target: RunRecord, agent: string, table?: PermissionTable): Promise<boolean> {
  const relation = await relationOf(root, caller, target)
  if (relation === "self") return false
  return mayReach(table, agent, "stop", relation)
}

async function interruptSession(ctx: Context, sessionID: string | null): Promise<void> {
  if (sessionID === null) return
  const sessions = ctx.session
  await Effect.runPromise(Effect.ignore(sessions.interrupt({ sessionID: Session.ID.make(sessionID) })))
}

export async function stopRun(ctx: Context, runID: string): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const run = await loadRun(root, runID)
  if (run === undefined) return fail("run.unknown", `Run ${runID} not found in this namespace.`)
  if (run.state === "working") return fail("E_BUSY", `Run ${runID} is working; interrupt it first.`)
  if (run.state === "stopped") return succeeded({ run: run.id, state: "stopped" })
  if (run.state === "stopping") return succeeded({ run: run.id, state: "stopping" })
  if (isTerminal(run.state)) return succeeded({ run: run.id, state: run.state })
  if (run.state === "idle") {
    await interruptSession(ctx, run.sessionID)
    await stopIdle(ctx, root, run)
    return succeeded({ run: run.id, state: "stopped" })
  }
  if (run.state === "dead") {
    const stopped = transition(run, "stopped", "reconcile")
    await saveRun(root, stopped)
    return succeeded({ run: run.id, state: "stopped" })
  }
  const updated: RunRecord = { ...run, stopRequested: true }
  await saveRun(root, updated)
  return succeeded({ run: run.id, state: updated.state })
}

export async function stopHandler(ctx: Context, args: StopInput, caller: TeamCaller, table?: PermissionTable): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const parent = stored ?? caller.run
  const found = await loadRun(root, args.run)
  if (found === undefined || !(await reachable(root, parent, found, caller.agent, table))) return notChild(parent, args.run)
  if (found.state === "stopped") return succeeded({ run: found.id, state: "stopped" })
  if (found.state === "stopping") return succeeded({ run: found.id, state: "stopping" })
  const child = args.reason === undefined ? found : { ...found, stopReason: args.reason }
  // Stopping a deeper descendant: the run's own parent learns why from its
  // next batch of messages, without being woken for it.
  if (args.reason !== undefined && child.parent !== null && child.parent !== parent.id)
    await put(root, child.parent, { kind: "notify", from: child.id, text: `${parent.id} stops run ${child.id}: ${args.reason}`.replace(/\r?\n/g, " ") })
  if (child.state === "idle") {
    await interruptSession(ctx, child.sessionID)
    await stopIdle(ctx, root, child, parent.id)
    return succeeded({ run: child.id, state: "stopped" })
  }
  if (child.state === "dead") {
    const stopped = transition(child, "stopped", "reconcile")
    await saveRun(root, stopped)
    return succeeded({ run: child.id, state: "stopped" })
  }
  const updated: RunRecord = { ...child, stopRequested: true, stopRequestedBy: parent.id }
  await saveRun(root, updated)
  if (args.force === true) {
    await interruptSession(ctx, child.sessionID)
  }
  return succeeded({ run: child.id, state: "stopping" })
}
