import type { PlusState } from "../index.js"
import { runtimeScope, type Level } from "../instructions/model.js"
import { effectiveCompaction, everySettings, resolveModelCompactionFields, settingsFor } from "../instructions/model-settings.js"
import { dedupeAgents } from "../instructions/teams-apply.js"

// The (agent, model) resolution inputs that compaction and warming decisions
// walk: the agent's model rows down its runtime chain plus Defaults › Models.
// Kept out of index.ts so the team followup reads the same rows the decision
// hook does.

export type RowsState = Pick<PlusState, "cachedAgents" | "cachedModels" | "cachedModelSettings" | "cachedScopes">

export function scopeLevel(scope: "project" | "global" | "defaults"): Level {
  if (scope === "global") return "global"
  if (scope === "defaults") return "defaults"
  return "project"
}

export function modelRowContextOf(
  state: RowsState,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
) {
  const agent = dedupeAgents([
    ...state.cachedAgents.filter((entry) => entry.team !== undefined),
    ...state.cachedAgents.filter((entry) => entry.team === undefined),
  ]).find((entry) => entry.id === agentID)
  const team = agent?.team === undefined ? undefined : { level: scopeLevel(agent.scope), team: agent.team }
  const runtime =
    agent === undefined
      ? { level: "project" as const, scopes: state.cachedScopes }
      : runtimeScope({ id: agent.id, level: scopeLevel(agent.scope), ...(team === undefined ? {} : { team }) }, state.cachedScopes)
  const target = { providerID: model.providerID, modelID: model.id, ...(model.variant === undefined ? {} : { variant: model.variant }) }
  return {
    input: { models: state.cachedModels, scopes: runtime.scopes, level: runtime.level, agent: agentID, ...(team === undefined ? {} : { team }) },
    target,
    key: { providerID: model.providerID, modelID: model.id },
  }
}

/** The compaction fields the agent's model rows set for this chat's model. */
export function compactionRowsOf(
  state: RowsState,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
) {
  const context = modelRowContextOf(state, agentID, model)
  return resolveModelCompactionFields(context.input, context.target)
}

/**
 * The early input threshold (Compaction › Input token threshold) the agent
 * and model resolve: its model rows, then Defaults › Models › this model, then
 * Every model. Undefined when none sets one, or one turns it off.
 */
export function inputThresholdOf(
  state: RowsState,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
): number | undefined {
  const modelRow = settingsFor(state.cachedModelSettings, { providerID: model.providerID, modelID: model.id })
  const everyRow = everySettings(state.cachedModelSettings)
  const threshold = effectiveCompaction({
    row: compactionRowsOf(state, agentID, model),
    ...(modelRow === undefined ? {} : { model: modelRow }),
    ...(everyRow === undefined ? {} : { every: everyRow }),
  }).compactionInput.value
  // "off" resolves to 0, as the trigger reads it.
  return threshold !== undefined && threshold > 0 ? threshold : undefined
}

/**
 * The cold-cache list the agent and model resolve, whether or not the global
 * "Compact cold chats first" is on: a team followup to a stopped, cold child
 * uses it; the switch only decides the automatic cold arming.
 */
export function coldListOf(
  state: RowsState,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
): readonly string[] {
  const modelRow = settingsFor(state.cachedModelSettings, { providerID: model.providerID, modelID: model.id })
  const everyRow = everySettings(state.cachedModelSettings)
  return effectiveCompaction({
    row: compactionRowsOf(state, agentID, model),
    ...(modelRow === undefined ? {} : { model: modelRow }),
    ...(everyRow === undefined ? {} : { every: everyRow }),
  }).coldModels.value
}
