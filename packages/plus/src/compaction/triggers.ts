import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { Plus } from "../rpc.js"

/** Plugin-owned per-Session preferences; never model settings or agent instructions. */
export const getCompactionTriggers = Effect.fn("Plus.getCompactionTriggers")(function* (
  ctx: Context,
  sessionID: string,
) {
  const stored = yield* ctx.storage.get(`compaction.triggers:${sessionID}`)
  const result: Plus.CompactionTriggers =
    stored === undefined ? { sessionID } : Schema.decodeUnknownSync(Plus.CompactionTriggers)(stored)
  return result
})

export const setCompactionTriggers = Effect.fn("Plus.setCompactionTriggers")(function* (
  ctx: Context,
  input: typeof Plus.CompactionTriggersSetInput.Type,
) {
  yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })
  const previous = yield* getCompactionTriggers(ctx, input.sessionID)
  const next = {
    sessionID: input.sessionID,
    ...(input.input === null
      ? {}
      : input.input === undefined
        ? previous.input === undefined
          ? {}
          : { input: previous.input }
        : { input: input.input }),
    ...(input.output === null
      ? {}
      : input.output === undefined
        ? previous.output === undefined
          ? {}
          : { output: previous.output }
        : { output: input.output }),
  }
  yield* ctx.storage.set(`compaction.triggers:${input.sessionID}`, next)
  return next
})

/** Adds only an early request, after armed/cold/quota decisions have had their precedence. */
export function decideCompactionTriggers(event: SessionCompactionDecision, triggers: Plus.CompactionTriggers) {
  if (event.reason !== "auto" || !event.auto || event.due || event.compact || event.refusal || !event.metrics?.advanced)
    return
  const trigger =
    triggers.input !== undefined && event.metrics.input >= triggers.input
      ? "input-threshold"
      : triggers.output !== undefined && event.metrics.output >= triggers.output
        ? "output-threshold"
        : undefined
  if (trigger === undefined) return
  event.compact = true
  event.explanation = {
    ...event.explanation,
    trigger,
    threshold: trigger === "input-threshold" ? triggers.input : triggers.output,
  }
}
