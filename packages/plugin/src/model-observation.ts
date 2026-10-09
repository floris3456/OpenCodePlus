import type { Usage } from "@opencode/ai"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Session } from "@opencode/schema/session"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { CompactionObservation } from "./compaction-observation.js"

/** Read-only per AI invocation, never a Session accounting aggregate or a response-body hook. */
export interface SessionModelObserved {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: "primary" | "compaction" | "title" | "generate"
  readonly purpose?: "warming"
  readonly compaction?: CompactionObservation
  readonly invocationID: string
  readonly operationID: string
  readonly messageID?: string
  readonly started: number
  readonly ended: number
  readonly outcome: "completed" | "failed" | "cancelled"
  /** Sparse allow-listed measurements, including reported TTL write buckets when available. */
  readonly usage: Readonly<ReturnType<Usage["observation"]>>
  /** Compatibility accounting for this invocation only; never evidence of sparse field presence. */
  readonly accounting?: { readonly tokens: TokenUsage.Info; readonly cost?: number }
  readonly exchanges: readonly {
    readonly requestID: string
    readonly transport: "http" | "websocket"
    readonly started: number
    /** HTTP response receipt is not full stream completion; WS preparation is not proof of delivery. */
    readonly outcome: "prepared" | "response" | "failed"
  }[]
  readonly exchangeCount: number
}
