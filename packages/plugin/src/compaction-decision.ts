import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Session } from "@opencode/schema/session"
import type { SessionError } from "@opencode/schema/session-error"
import type { CompactionObservation } from "./compaction-observation.js"

/** Runs at the native runner's safe boundary, including when automatic compaction is off. */
export interface SessionCompactionDecision {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly reason: "auto" | "overflow" | "manual"
  readonly auto: boolean
  readonly due: boolean
  readonly boundary: {
    readonly fresh: boolean
    readonly portable: boolean
    /** Only a persisted completed checkpoint with no subsequent primary output. */
    readonly checkpoint?: string
  }
  /** Request compaction below the context threshold; never overrides auto:false. */
  compact?: boolean
  /** Require a local text checkpoint without account-bound provider state. */
  portable?: boolean
  /**
   * Override the agent's compaction strategy for this compaction. A portable decision with `remote`,
   * from either this field or the agent, is refused.
   */
  strategy?: "auto" | "local" | "remote"
  /** Read-only attribution hints for monitoring; these never select or request compaction. */
  explanation?: {
    readonly trigger?: "cold" | "handoff" | "armed"
    readonly strategy?: {
      readonly value: "auto" | "local" | "remote"
      readonly source: CompactionObservation["strategySource"]
    }
  }
  /**
   * Replace the agent's compaction system text (`config?.system ?? fallback?.system`) for this
   * compaction. On the chat's own model it travels in the final user message; on another model it is
   * the request's system.
   */
  system?: string
  /**
   * Write the local summary with this model instead of the agent's compaction model. The session keeps
   * its own model. Remote (provider-native) compaction ignores it.
   */
  compactionModel?: Model.Ref
  /**
   * The whole fallback list, tried in order after `compactionModel` (or the agent's compaction model)
   * fails. When present it replaces `compactionFallback`, which otherwise means a list of one. Each
   * failed model is recorded as its own failed compaction before the next is tried.
   */
  compactionFallbacks?: Model.Ref[]
  /**
   * When the local summary fails with `compactionModel` (or the agent's compaction model), record that
   * failure and write the summary with this model instead, within the same compaction.
   */
  compactionFallback?: Model.Ref
  /**
   * When every model failed, an `auto` trigger reports `skipped` so the step runs uncompacted (failures
   * are still recorded). `manual` and `overflow` ignore it.
   */
  optional?: boolean
  metadata?: Record<string, unknown>
  refusal?: SessionError.Error
}
