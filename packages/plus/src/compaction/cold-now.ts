import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { COLD_COMPACT_LABEL } from "../instructions/model-settings.js"
import { currentSessionAgent, currentSessionModel } from "../session-model.js"
import { armColdCompaction, consumeColdCompaction } from "../teams/cold-compaction.js"
import { coldListOf, type RowsState } from "./rows.js"

// The chat's cold-cache list for a manual compaction: `compaction.cold` (the
// `/compact-cold` command) and a team followup to a stopped, cold child.

/** The chat's cold list, and the Instructions row where the user adds one. */
export async function coldPlanOf(ctx: Context, state: RowsState, sessionID: string) {
  const agent = await currentSessionAgent(ctx, sessionID)
  const model = await currentSessionModel(ctx, sessionID)
  const where = `Instructions › ${agent ?? "the chat's agent"} › ${model === undefined ? "the chat's model" : `${model.providerID}/${model.modelID}`} › Warming › ${COLD_COMPACT_LABEL} (a adds one)`
  if (agent === undefined || model === undefined) return { models: [], where }
  const models = coldListOf(state, agent, {
    providerID: model.providerID,
    id: model.modelID,
    ...(model.variant === undefined ? {} : { variant: model.variant }),
  })
  return { models, where }
}

export type ColdNowResult =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly reason: "no-list"; readonly where: string }

/** Arms the chat's cold list for one manual compaction, then asks core for it; an empty list compacts nothing. */
export async function compactColdNow(ctx: Context, state: RowsState, sessionID: string): Promise<ColdNowResult> {
  const plan = await coldPlanOf(ctx, state, sessionID)
  if (plan.models.length === 0) return { ok: false, reason: "no-list", where: plan.where }
  armColdCompaction(sessionID, plan.models)
  await Effect.runPromise(
    ctx.session.compact({ sessionID: Session.ID.make(sessionID) }).pipe(
      Effect.onError(() => Effect.sync(() => consumeColdCompaction(sessionID))),
    ),
  )
  return { ok: true, models: plan.models }
}
