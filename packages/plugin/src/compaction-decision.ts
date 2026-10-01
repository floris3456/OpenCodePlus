import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Session } from "@opencode/schema/session"
import type { SessionError } from "@opencode/schema/session-error"

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
  metadata?: Record<string, unknown>
  refusal?: SessionError.Error
}
