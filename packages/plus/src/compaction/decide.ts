import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Model } from "@opencode/schema/model"
import {
  effectiveCompaction,
  type CompactionDefaults,
  type ModelSettingsRecord,
  type ResolvedCompactionFields,
} from "../instructions/model-settings.js"

// Plus's `compaction.decide` (plus-1.2.0 B34 / plus-1.1.18 §2 and §4). Core
// already carries the agent's own compaction; this hook adds, for the chat's
// (agent, model):
//
//   1. the per-model settings Plus owns (strategy, summary model and system
//      text), resolved agent model row → agent-wide `compaction:*` rows →
//      Defaults › Models › this model → Every model;
//   2. cold-cache arming: at the first step of a new prompt in a cold chat
//      whose model has "Compact cold caches with another model" on and a
//      non-empty list, arm a portable summary written by #1 with #2… as
//      fallbacks and `optional` so the step continues uncompacted when every
//      model fails;
//   3. the CPA account-switch case: CPA has already armed a summary with its
//      own models and marked the decision `metadata["quota.switch"]`; when the
//      chat model's cold list is not empty, its models replace CPA's.
//
// A team `compactWith` arming (the in-memory consumeColdCompaction) takes
// priority over all of it: it is the user's explicit instruction for one chat.

/** The per-chat cold-cache inputs at the decision. */
export interface ColdCompactionState {
  /** The host runs this chat now; a running chat is never cold. */
  readonly running: boolean
  /** A Plus warming window was recorded for this chat. */
  readonly ready: boolean
  /** That window has not ended (the chat is being kept warm). */
  readonly active: boolean
  /** A compaction completed since the chat's last real request: skip. */
  readonly compacted: boolean
  /** Epoch ms since the chat's last request; absent when unknown. */
  readonly idleMs?: number
  /** The Monitor's cache lifetime for this model; absent (unknown) is never cold. */
  readonly lifetime?: number
}

export interface CompactionDecisionContext {
  /** The agent's model rows for this chat's model, each field with its level. */
  readonly rows?: ResolvedCompactionFields
  /** Defaults › Models › this model. */
  readonly model?: ModelSettingsRecord
  /** Defaults › Models › Every model. */
  readonly every?: ModelSettingsRecord
  /** The agent's old agent-wide `compaction:*` rows, as core resolved them. */
  readonly agent?: CompactionDefaults
  /** The shared Defaults `compaction:*` rows for every agent. */
  readonly agents?: CompactionDefaults
  /** The team `compactWith` model for this chat, when it armed one. */
  readonly teamModel?: string
  /** Absent when cold compacting is not consulted for this decision. */
  readonly cold?: ColdCompactionState
}

/**
 * Mutate `event` for the chat's own model. The team arming wins outright; on
 * the CPA account-switch mark the chat model's cold list replaces CPA's own
 * models only when it is not empty.
 */
export function decideCompaction(event: SessionCompactionDecision, context: CompactionDecisionContext): void {
  if (context.teamModel !== undefined) {
    event.compact = true
    event.portable = true
    event.compactionModel = Model.Ref.parse(context.teamModel)
    return
  }
  const effective = effectiveCompaction({
    ...(context.rows === undefined ? {} : { row: context.rows }),
    ...(context.model === undefined ? {} : { model: context.model }),
    ...(context.every === undefined ? {} : { every: context.every }),
    ...(context.agent === undefined ? {} : { agent: context.agent }),
    ...(context.agents === undefined ? {} : { agents: context.agents }),
  })
  // Built-in/inherit leaves the field untouched, so core keeps today's behaviour.
  if (effective.strategy.from !== "built-in") event.strategy = effective.strategy.value
  if (effective.model.from !== "built-in" && effective.model.value !== undefined)
    event.compactionModel = Model.Ref.parse(effective.model.value)
  if (effective.instructions.from !== "built-in" && effective.instructions.value !== undefined)
    event.system = effective.instructions.value
  const coldModels = effective.coldModels.value
  // The cold-cache list is the one core cannot see; only a Plus level (a list
  // longer than the built-in empty one) makes it usable.
  if (event.metadata?.["quota.switch"] === true) {
    if (coldModels.length > 0) armModels(event, coldModels)
    return
  }
  if (!coldFires(event, effective.coldCompact.value, coldModels, context.cold)) return
  armModels(event, coldModels)
  event.optional = true
  event.metadata = { ...event.metadata, "plus.cold": { models: [...coldModels] } }
}

/** #1 writes the summary; #2… are its fallbacks, replacing CPA's single one. */
function armModels(event: SessionCompactionDecision, models: readonly string[]): void {
  event.compact = true
  event.portable = true
  event.compactionModel = Model.Ref.parse(models[0]!)
  if (models.length > 1) event.compactionFallbacks = models.slice(1).map((model) => Model.Ref.parse(model))
  delete event.compactionFallback
}

/**
 * Cold arming fires only at the first step of a new prompt (`reason: auto`
 * with a fresh boundary), when the setting is on and the list is not empty,
 * and the chat is cold.
 */
function coldFires(
  event: SessionCompactionDecision,
  coldCompact: boolean,
  coldModels: readonly string[],
  cold: ColdCompactionState | undefined,
): boolean {
  if (cold === undefined || !coldCompact || coldModels.length === 0) return false
  if (event.reason !== "auto" || event.boundary.fresh !== true) return false
  return isCold(cold)
}

/** A running, kept-warm or just-compacted chat is not cold; an unknown lifetime never is. */
export function isCold(cold: ColdCompactionState): boolean {
  if (cold.running || cold.compacted) return false
  if (cold.ready) return !cold.active
  if (cold.lifetime === undefined || cold.idleMs === undefined) return false
  return cold.idleMs > cold.lifetime
}