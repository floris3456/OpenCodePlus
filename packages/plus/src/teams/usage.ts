import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { TokenUsage } from "@opencode/schema/token-usage"
import { Effect } from "effect"
import type { RunRecord } from "./run.js"

export async function sessionTokens(ctx: Context, run: RunRecord): Promise<number | undefined> {
  if (run.sessionID === null) return undefined
  return Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(run.sessionID) }).pipe(
    Effect.map((info) => TokenUsage.total(info.tokens)),
    Effect.catchCause(() => Effect.succeed(undefined)),
  ))
}
