import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Model } from "@opencode/schema/model"
import type { WarmingStatus } from "../warming.js"
import { decideCompactionTriggers } from "./triggers.js"
import { teamInputThreshold } from "./rows.js"
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
//   2. cold-cache arming: before any step of a chat whose cache is cold (a
//      new message after a long pause, or a running agent whose cache went
//      cold while it waited on a tool or a subagent, or whose keep-alives did
//      not go through), while "Compact cold chats first" is on for the chat's
//      model and that model resolves a non-empty cold-cache list, arm a
//      portable summary written by #1 with #2… as fallbacks and `optional` so
//      the step continues uncompacted when every model fails. The agent then
//      carries on from the summary;
//   3. the CPA account-switch case: CPA has already armed a summary with its
//      own models and marked the decision `metadata["quota.switch"]`; when the
//      chat model's cold list is not empty, its models replace CPA's.
//   4. early input/output thresholds: agent model row chain → Defaults ›
//      Models › this model → Every model. Cold/armed/quota decisions and
//      core's automatic-compaction preference retain precedence.
//
// An armed list (a team `compactWith`; the in-memory consumeColdCompaction)
// takes priority over all of it: it is an explicit instruction for one chat,
// and it has no `optional`: a manual compaction reports its failure.
//
// Cold, armed and account-switch summaries are written locally by those cheap
// models, whatever the per-model strategy says. Every other compaction keeps
// the chat's strategy, so `auto` and `remote` compact natively when they can.

/** The per-chat cold-cache inputs at the decision. */
export interface ColdCompactionState {
  /**
   * Nothing to summarize: a compaction completed since the chat's last real request, or core's
   * boundary is a checkpoint no primary output followed yet (a step retried after its cold summary).
   */
  readonly compacted: boolean
  /** When the chat's cache goes or went cold; absent while a window keeps it warm, or when unknown. */
  readonly coldAt?: number
  readonly now: number
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
  /**
   * The chat's agent is a team member: with no threshold row it condenses at
   * TEAM_CONTEXT_TOKENS instead of core's window.
   */
  readonly team?: boolean
  /** The models armed for this chat's next compaction (#1 writes, #2… fall back), when some were armed. */
  readonly armed?: readonly string[]
  /** Absent when cold compacting is not consulted: Compact cold chats first is off for the chat's model. */
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
    event.explanation = { ...event.explanation, trigger: "armed" }
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
  if (effective.strategy.from !== "built-in") {
    event.strategy = effective.strategy.value
    event.explanation = { ...event.explanation, strategy: { value: effective.strategy.value, source: effective.strategy.from } }
  }
  if (effective.model.from !== "built-in" && effective.model.value !== undefined)
    event.compactionModel = Model.Ref.parse(effective.model.value)
  if (effective.instructions.from !== "built-in" && effective.instructions.value !== undefined)
    event.system = effective.instructions.value
  const coldModels = effective.coldModels.value
  if (event.metadata?.["quota.switch"] === true) {
    // The account is used up: its summary is written locally, never natively on that account.
    event.strategy = "local"
    if (coldModels.length > 0) armModels(event, coldModels)
    event.explanation = { ...event.explanation, trigger: "handoff" }
    return
  }
  if (context.cold !== undefined && coldModels.length > 0 && isCold(context.cold)) {
    armModels(event, coldModels)
    event.optional = true
    event.metadata = { ...event.metadata, "plus.cold": { models: [...coldModels] } }
    event.explanation = { ...event.explanation, trigger: "cold" }
  }
  decideCompactionTriggers(event, {
    input: teamInputThreshold(effective.compactionInput.value, context.team === true),
    output: effective.compactionOutput.value,
  })
}

/** #1 writes the summary locally, over any remote strategy; #2… are its fallbacks, replacing CPA's single one. */
function armModels(event: SessionCompactionDecision, models: readonly string[]): void {
  event.compact = true
  event.portable = true
  event.strategy = "local"
  event.compactionModel = Model.Ref.parse(models[0]!)
  if (models.length > 1) event.compactionFallbacks = models.slice(1).map((model) => Model.Ref.parse(model))
  delete event.compactionFallback
}

/** Cold once its cold moment passed; a just-compacted chat, or one whose moment is unknown, never is. */
export function isCold(cold: ColdCompactionState): boolean {
  return !cold.compacted && cold.coldAt !== undefined && cold.now >= cold.coldAt
}

/**
 * The cold-cache state before a step, from the status the footer shows
 * (`warmingStatusFor`): a running window keeps the chat warm (a window whose
 * keep-alives failed was already cut where its cache went cold), a window that
 * ended is cold from its end, and a chat warming does not keep warm is cold
 * from its cold moment. Without either (no request since Plus started), when
 * its latest request's cache lifetime ends. Otherwise nothing is known, and an
 * unknown chat is never cold.
 */
export function coldStateOf(input: {
  readonly status: Pick<WarmingStatus, "active" | "compacted" | "expires" | "coldAt" | "warmUntil">
  /** Core's boundary at a compaction decision; absent elsewhere. */
  readonly boundary?: SessionCompactionDecision["boundary"]
  readonly now: number
}): ColdCompactionState {
  const coldAt = input.status.active ? undefined : (input.status.coldAt ?? input.status.expires ?? input.status.warmUntil)
  return {
    compacted: input.status.compacted === true || input.boundary?.checkpoint !== undefined,
    ...(coldAt === undefined ? {} : { coldAt }),
    now: input.now,
  }
}
