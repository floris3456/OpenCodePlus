import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Model } from "@opencode/schema/model"
import { cacheLifetime } from "../monitor/cache.js"
import type { RequestFingerprintData, RequestRow } from "../monitor/ledger.js"
import type { WarmingStatus } from "../warming.js"
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
// An armed list (a team `compactWith`, or `/compact-cold`; the in-memory
// consumeColdCompaction) takes priority over all of it: it is the user's
// explicit instruction for one chat, and it has no `optional`: a manual
// compaction reports its failure.

// "First step of a new prompt": core's decision boundary cannot say it (its
// `fresh` is only a brand-new epoch, which is never cold), so Plus's own
// `prompt` hook marks each admitted prompt here and the first `reason: "auto"`
// decision consumes the mark — whatever its outcome — so later steps of the
// same turn never consult cold.
const MAX_PROMPTS = 500
const prompted = new Set<string>()

/** A user prompt was admitted to this chat; its next auto decision may arm cold. */
export function markPromptAdmitted(sessionID: string): void {
  prompted.delete(sessionID)
  prompted.add(sessionID)
  for (const oldest of prompted) {
    if (prompted.size <= MAX_PROMPTS) break
    prompted.delete(oldest)
  }
}

/** True exactly once per admitted prompt: the first `reason: "auto"` decision consumes it. */
export function consumePromptAdmitted(sessionID: string): boolean {
  return prompted.delete(sessionID)
}

/** The per-chat cold-cache inputs at the decision. */
export interface ColdCompactionState {
  /** The chat is mid-turn: a running chat is never cold. Always false at a fresh prompt. */
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
  /** The models armed for this chat's next compaction (#1 writes, #2… fall back), when some were armed. */
  readonly armed?: readonly string[]
  /** Absent when cold compacting is not consulted for this decision. */
  readonly cold?: ColdCompactionState
}

/**
 * Mutate `event` for the chat's own model. An armed list wins outright; on
 * the CPA account-switch mark the chat model's cold list replaces CPA's own
 * models only when it is not empty.
 */
export function decideCompaction(event: SessionCompactionDecision, context: CompactionDecisionContext): void {
  if (context.armed !== undefined) {
    armModels(event, context.armed)
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
  if (event.metadata?.["quota.switch"] === true) {
    if (coldModels.length > 0) armModels(event, coldModels)
    return
  }
  if (!coldFires(effective.coldCompact.value, coldModels, context.cold)) return
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
 * Cold arming fires when the caller consulted cold for this decision — the
 * first step of a new prompt — with the setting on, a non-empty list and a
 * cold chat. `cold` is absent for every later step of the turn.
 */
function coldFires(
  coldCompact: boolean,
  coldModels: readonly string[],
  cold: ColdCompactionState | undefined,
): boolean {
  if (cold === undefined || !coldCompact || coldModels.length === 0) return false
  return isCold(cold)
}

/** A running, kept-warm or just-compacted chat is not cold; an unknown lifetime never is. */
export function isCold(cold: ColdCompactionState): boolean {
  if (cold.running || cold.compacted) return false
  if (cold.ready) return !cold.active
  if (cold.lifetime === undefined || cold.idleMs === undefined) return false
  return cold.idleMs > cold.lifetime
}

/** What cold arming reads: the chat's window, its last request and that request's fingerprint. */
export interface ColdInputs {
  readonly status: Pick<WarmingStatus, "active" | "compacted" | "source" | "expires">
  readonly last?: RequestRow
  readonly fingerprint?: RequestFingerprintData
  readonly now: number
}

/**
 * The cold-cache state at the first step of a new prompt. The last request
 * row's own fingerprint carries its cache TTL, so a 1h cache is not mistaken
 * for the 5-minute default; a missing row or fingerprint means unknown, and an
 * unknown lifetime is never cold.
 */
export function coldStateOf(input: ColdInputs): ColdCompactionState {
  const lifetime = input.last === undefined ? undefined : cacheLifetime(input.last, input.fingerprint)
  return {
    // This step's own execution is what runs the decision, so a fresh prompt
    // is not "running" here; the prompt mark keeps later steps out.
    running: false,
    ready: input.status.source !== undefined || input.status.expires !== undefined,
    active: input.status.active,
    compacted: input.status.compacted === true,
    ...(input.last === undefined ? {} : { idleMs: input.now - input.last.started }),
    ...(lifetime === undefined ? {} : { lifetime }),
  }
}