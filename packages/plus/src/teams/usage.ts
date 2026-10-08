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

// A session's context size is the prompt size of its latest completed step:
// input + cache read + cache write of the most recent assistant message that
// carries token usage. Cache reads count here because they are part of what
// the model re-reads, unlike the cumulative budget count that leaves them out.
// A session with no completed step has no context size.
export async function sessionContextTokens(ctx: Context, run: RunRecord): Promise<number | undefined> {
  const sessionID = run.sessionID
  if (sessionID === null) return undefined
  const messages = await Effect.runPromise(
    Effect.suspend(() => ctx.session.context({ sessionID: Session.ID.make(sessionID) })),
  ).catch(() => undefined)
  const step = messages?.findLast((message) => message.type === "assistant" && message.tokens !== undefined)
  if (step?.type !== "assistant" || step.tokens === undefined) return undefined
  return step.tokens.input + step.tokens.cache.read + step.tokens.cache.write
}
