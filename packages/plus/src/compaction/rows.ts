import type { PlusState } from "../index.js"
import { runtimeScope, type Level } from "../instructions/model.js"
import { effectiveCompaction, everySettings, resolveModelCompactionFields, settingsFor } from "../instructions/model-settings.js"
import { dedupeAgents } from "../instructions/teams-apply.js"
import { TEAM_CONTEXT_TOKENS } from "../teams/schema.js"

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
 *
 * A team member whose rows set none condenses at TEAM_CONTEXT_TOKENS; an
 * explicit row at any level, and "off", still decide.
 */
export function inputThresholdOf(
  state: RowsState,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
): number | undefined {
  return teamInputThreshold(modelCompactionOf(state, agentID, model).compactionInput.value, isTeamMember(state, agentID))
}

/**
 * The early input threshold a decision uses, from the resolved value and
 * whether the chat's agent is a team member: an unset value is the team's own
 * context budget, "off" (0) and a set value pass through.
 */
export function teamInputThreshold(threshold: number | undefined, team: boolean): number | undefined {
  if (threshold !== undefined) return threshold > 0 ? threshold : undefined
  return team ? TEAM_CONTEXT_TOKENS : undefined
}

/** Whether the agent is a member of an enabled team (its cached source carries one). */
export function isTeamMember(state: RowsState, agentID: string): boolean {
  return state.cachedAgents.some((entry) => entry.id === agentID && entry.team !== undefined)
}

/**
 * The cold-cache list the agent and model resolve, whether or not "Compact
 * cold chats first" is on: a team followup to a stopped, cold child uses it;
 * the switch only decides the automatic cold arming.
 */
export function coldListOf(
  state: RowsState,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
): readonly string[] {
  return modelCompactionOf(state, agentID, model).coldModels.value
}

/**
 * The models automatic cold arming compacts with for the agent and model:
 * its cold-cache list while "Compact cold chats first" is on for that model
 * (its model rows, Defaults › Models › this model, Every model, else the
 * global Settings switch `global`), else none.
 */
export function armedColdListOf(
  state: RowsState,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
  global: boolean,
): readonly string[] {
  const effective = modelCompactionOf(state, agentID, model)
  return (effective.coldFirst.value ?? global) ? effective.coldModels.value : []
}

// The per-model compaction fields: model rows, then Defaults › Models › this model, then Every model.
function modelCompactionOf(
  state: RowsState,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
) {
  const modelRow = settingsFor(state.cachedModelSettings, { providerID: model.providerID, modelID: model.id })
  const everyRow = everySettings(state.cachedModelSettings)
  return effectiveCompaction({
    row: compactionRowsOf(state, agentID, model),
    ...(modelRow === undefined ? {} : { model: modelRow }),
    ...(everyRow === undefined ? {} : { every: everyRow }),
  })
}
