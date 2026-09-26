import { stat } from "node:fs/promises"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect, Option } from "effect"
import type { RunRecord } from "./run.js"
import { toolError } from "./schema.js"

export async function requireWorktree(run: RunRecord): Promise<void> {
  if (run.worktree !== "removed" && await stat(run.directory).then((info) => info.isDirectory(), () => false)) return
  throw toolError("E_WORKTREE_REMOVED", `Run ${run.id}'s worktree is unavailable; delegate fresh from the current parent.`, "delegate fresh from current parent")
}

export async function requireSession(ctx: Context, run: RunRecord): Promise<void> {
  if (run.sessionID !== null) {
    const info = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(run.sessionID) }).pipe(Effect.option))
    if (Option.isSome(info) && info.value !== undefined && info.value !== null) return
  }
  throw toolError("E_SESSION_GONE", `Run ${run.id} has no available Session; delegate fresh from the current parent.`, "delegate fresh from current parent")
}
