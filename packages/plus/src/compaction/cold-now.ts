import type { Context } from "@opencode/plugin/effect/plugin"
import { currentSessionAgent, currentSessionModel } from "../session-model.js"
import { coldListOf, type RowsState } from "./rows.js"

// The chat's cold-cache list for a team followup to a stopped, cold child.

/** The chat's cold list, and its model ("provider/model") to compact with when the list is empty. */
export async function coldPlanOf(ctx: Context, state: RowsState, sessionID: string) {
  const agent = await currentSessionAgent(ctx, sessionID)
  const model = await currentSessionModel(ctx, sessionID)
  if (agent === undefined || model === undefined) return { models: [], model: undefined }
  const models = coldListOf(state, agent, {
    providerID: model.providerID,
    id: model.modelID,
    ...(model.variant === undefined ? {} : { variant: model.variant }),
  })
  return { models, model: `${model.providerID}/${model.modelID}` }
}
