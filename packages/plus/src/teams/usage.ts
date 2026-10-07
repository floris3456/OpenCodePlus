import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import type { TokenUsage } from "@opencode/schema/token-usage"
import { Effect } from "effect"
import type { RunRecord } from "./run.js"

export interface SessionTokenDetails {
  used: number
  cacheRead: number
}

export function countUsedTokens(tokens: TokenUsage.Info): number {
  return tokens.input + tokens.cache.write + tokens.output + tokens.reasoning
}

export async function sessionTokenUsage(ctx: Context, run: RunRecord): Promise<SessionTokenDetails | undefined> {
  if (run.sessionID === null) return undefined
  return Effect.runPromise(
    ctx.session.get({ sessionID: Session.ID.make(run.sessionID) }).pipe(
      Effect.map((info) => ({
        used: countUsedTokens(info.tokens),
        cacheRead: info.tokens.cache.read,
      })),
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
  )
}

export async function sessionTokens(ctx: Context, run: RunRecord): Promise<number | undefined> {
  const usage = await sessionTokenUsage(ctx, run)
  return usage?.used
}
