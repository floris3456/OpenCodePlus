import type { SessionCompactionDecision } from "../compaction-decision.js"
import type { SessionApi } from "@opencode/client/effect/api"
import type { GenerationOptionsFields, Message, SystemPart } from "@opencode/ai"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { SessionError } from "@opencode/schema/session-error"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { Effect, JsonSchema, Types } from "effect"
import type { ModelHooks } from "./registration.js"
import type { SessionModelObserved } from "../model-observation.js"
export type { SessionModelObserved } from "../model-observation.js"

export interface SessionPrompt {
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  prompt: Types.DeepMutable<PromptInput.Prompt>
  metadata?: Record<string, unknown>
  delivery: SessionInbox.Delivery
}

/** Request overrides. Typed keys are generation settings; any other key is a provider option. */
export type SessionRequestOptions = Types.DeepMutable<GenerationOptionsFields> & Record<string, unknown>

export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly model: Model.Ref
  system: Array<SystemPart>
  messages: Array<Message>
  options: SessionRequestOptions
  /**
   * False for a throwaway request that never advances the Session: a warming ping or a
   * `/generate` side question. Content-changing hooks still run so the request matches
   * the next durable step's prefix, but hooks must not persist Session state for it.
   * Undefined means durable.
   */
  readonly durable?: boolean
}

export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
}

export interface SessionCompactionResult {
  summary: string
  providerState?: SessionMessage.ProviderState
  metadata?: Record<string, unknown>
  tokens?: TokenUsage.Info
}

export interface SessionCompaction extends SessionContext {
  /** Core is converting a native checkpoint on its original model, without a new compaction decision. */
  readonly checkpointHandoff?: true
  /** Set to use this compaction and skip the model request. */
  result?: SessionCompactionResult
}

export interface SessionGenerate extends SessionContext {}

export interface SessionGenerated {
  /** Dedicated model.observed owns this invocation's measurement; this remains an auxiliary notification. */
  readonly invocationID?: string
  readonly kind?: "generate" | "title"
  /** Epoch-ms request window, independent of when a subscriber observes the outcome. */
  readonly started?: number
  readonly ended?: number
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly usage?: TokenUsage.Info
  readonly cost?: number
  readonly error?: string
}

export interface SessionTitle extends SessionRequest {
  /** Set to use this title and skip the model request. */
  result?: string
}

/**
 * Why a Session request is being made. Auxiliary requests share the Session's
 * hook identity but need to be told apart from the agent loop.
 */
export type SessionRequestKind = "primary" | "compaction" | "title" | "generate"

export interface SessionModelRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  baseURL?: string
  headers: Record<string, string>
}

export interface SessionHttpRequest {
  readonly invocationID?: string
  /** Identity and start time of this physical transport attempt, shared by all hook observers. */
  readonly requestID?: string
  readonly started?: number
  /** Observers run after every request transform, immediately before transport. */
  observers?: Array<(request: Request) => Effect.Effect<void>>
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  request: Request
}

export interface SessionHttpResponse {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  readonly request: Request
  response: Response
}

/**
 * Connection a WebSocket-backed request opens or reuses. Runs once per model call before the
 * Session's socket is selected; changing `url` or `headers` reopens the socket. Experimental.
 */
export interface SessionWebSocketHandshake {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  url: string
  headers: Record<string, string>
}

/**
 * Outbound frame about to be written to the Session's socket, after the provider driver has built
 * it. Replacing `frame` sends the replacement verbatim; the driver still tracks state from the
 * provider's replies, so a rewrite that changes protocol meaning is on the plugin. Experimental.
 */
export interface SessionWebSocketSend {
  readonly invocationID?: string
  /** Identity and start time of this physical transport attempt, shared by all hook observers. */
  readonly requestID?: string
  readonly started?: number
  /** Observers run after every frame transform, immediately before transport. */
  observers?: Array<(frame: string) => Effect.Effect<void>>
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  frame: string
}

/**
 * Inbound frame read from the Session's socket, before the provider driver observes it. Replacing
 * `frame` hands the replacement to the driver verbatim. Experimental.
 */
export interface SessionWebSocketReceive {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  frame: string
}

export type SessionRetryDecision = { retry: false } | { retry: true; delay: number }

export interface SessionRetry {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly error: SessionError.Error
  readonly attempt: number
  decision: SessionRetryDecision
}

/** Warming settings in milliseconds. */
export interface SessionWarmingSettings {
  prompt: string
  interval: number
  duration: number
}

/**
 * Decides cache warming for one Session. Runs when a non-warming request (re)starts the warming
 * window (`activity`), when a window that outlived the host resumes (`resume`), and again before
 * each warming request (`warm`). `settings` starts as the configured value (for `warm`, the
 * settings in force); set it to undefined to stop warming, or change it. At `warm` and `resume` a
 * changed duration re-times the window from `since`.
 * `warmed` is an outcome notification only; changes to its settings are ignored.
 */
export interface SessionWarming {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly phase: "activity" | "resume" | "warm" | "warmed"
  /** At `activity`, the request that (re)started the window: an agent step, a compaction or a generate call. */
  readonly kind?: "primary" | "compaction" | "generate"
  /**
   * Epoch ms of the start of the warming window: the latest non-warming request, or the end of
   * the turn when that turn ended while the window still ran.
   */
  readonly since: number
  /** Epoch ms of this decision. */
  readonly now: number
  readonly error?: string
  settings: SessionWarmingSettings | undefined
}

/** Request-local tool exposure overrides, by registry tool id. Permissions still apply. */
export interface SessionTools {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  modes: Record<string, "direct" | "codemode">
}

export interface SessionCatalog {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  /**
   * Code Mode tools keyed by qualified dotted path, e.g. `browser.tabs.open`.
   * `input` is the tool's own input schema: replace it (never mutate it) to show
   * the model edited parameters in the catalog and in `search()`.
   */
  tools: Record<string, { description: string; pinned: boolean; input?: JsonSchema.JsonSchema }>
}

export interface SessionHooks {
  /** Destination-scoped, awaited after a committed folder move and before destination execution. */
  readonly moved: { readonly source: Session.Info; readonly destination: Session.Info }
  readonly tools: SessionTools
  readonly "model.observed": SessionModelObserved
  readonly prompt: SessionPrompt
  readonly context: SessionContext
  readonly "compaction.decide": SessionCompactionDecision
  readonly compaction: SessionCompaction
  readonly generate: SessionGenerate
  readonly generated: SessionGenerated
  readonly title: SessionTitle
  readonly catalog: SessionCatalog
  readonly "model.request": SessionModelRequest
  readonly "http.request": SessionHttpRequest
  readonly "http.response": SessionHttpResponse
  readonly "experimental.ws.handshake": SessionWebSocketHandshake
  readonly "experimental.ws.send": SessionWebSocketSend
  readonly "experimental.ws.receive": SessionWebSocketReceive
  readonly retry: SessionRetry
  readonly warming: SessionWarming
}

export type SessionDomain = Pick<
  SessionApi<unknown>,
  | "create"
  | "get"
  | "active"
  | "remove"
  | "switchAgent"
  | "switchModel"
  | "prompt"
  | "generate"
  | "command"
  | "compact"
  | "synthetic"
  | "interrupt"
  | "update"
  | "move"
  | "wait"
  | "context"
  | "compact"
> & {
  readonly hook: ModelHooks<SessionHooks>
}
