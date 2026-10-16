import type { Context } from "@opencode/plugin/effect/plugin"
import { COLD_COMPACT_LABEL } from "../instructions/model-settings.js"
import { currentSessionAgent, currentSessionModel } from "../session-model.js"
import { coldListOf, type RowsState } from "./rows.js"

// The chat's cold-cache list for a team followup to a stopped, cold child.

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
