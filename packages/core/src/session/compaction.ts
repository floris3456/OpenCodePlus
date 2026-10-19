export * as SessionCompaction from "./compaction.js"
import { Config } from "../config.js"

import {
  AIError,
  type ContentPart,
  InvalidProviderOutputError,
  InvalidRequestError,
  isContextOverflowFailure,
  LLMClient,
  LLMEvent,
  LLMRequest,
  Message,
  type ToolEntry,
  UnknownProviderError,
  type Usage,
} from "@opencode/ai"
import type { SessionCompactionResult } from "@opencode/plugin/effect/session"
import type { CompactionObservation } from "@opencode/plugin/compaction-observation"
import type { SessionError } from "@opencode/schema/session-error"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, DateTime, Effect, Layer, Option, Result, Stream } from "effect"
import { PluginHooks } from "../plugin/hooks.js"
import { SessionRequestPrepare } from "./request-prepare.js"
import { compactionBoundary } from "./compaction-boundary.js"
import { Bus } from "../bus.js"
import { Agent } from "../agent.js"
import { Database } from "../database/database.js"
import { llmClient } from "../effect/app-node-platform.js"
import { Model } from "../model.js"
import { ModelResolver } from "../model-resolver.js"
import { State } from "../state.js"
import { Token } from "../util/token.js"
import type { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionModelObservation } from "./model-observation.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionRunnerRetry } from "./runner/retry.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import { contentFilterError, toSessionError } from "./to-session-error.js"
import { SessionUsage } from "./usage.js"

export type Settings = {
  auto: boolean
  /** Tokens kept free below the model's limits before compacting. Unset keeps 10% free. */
  buffer?: number
  /** Tokens of recent conversation kept verbatim beside the summary. */
  keep: number
}

export type Editor = {
  configure: (settings: Partial<Settings>) => void
}

export type Trigger =
  /** `overflow`: the provider just rejected this context as too long. */
  | { readonly reason: "auto" | "overflow"; readonly context: SessionContext.Loaded }
  /** `inputID` is the `/compact` inbox item, whose message shows the outcome. */
  | { readonly reason: "manual"; readonly context: SessionContext.Loaded; readonly inputID: SessionMessage.ID }

export type Outcome =
  /** Only `auto` skips: the context fits, or automatic compaction is off. */
  | { readonly status: "skipped" }
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: SessionError.Error }

export interface Interface extends State.Transformable<Editor> {
  readonly compact: (trigger: Trigger) => Effect.Effect<Outcome>
  /** Convert an incompatible native window with its owner before the selected model can execute. */
  readonly handoff: (trigger: Trigger) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

/** Both retain `recent`; a summary fills `text`, and a native compaction fills `providerContext`. */
type Result = {
  readonly text: string
  // todo: this should become a msg reference, we shouldnt be stringifying the recent history (confuses some models...)
  readonly recent: string
  // todo: consolidate these 2
  readonly providerState?: SessionMessage.ProviderState
  readonly providerContext?: SessionProviderContext.Info
  readonly metadata?: Record<string, unknown>
}

type Failure = {
  readonly error: SessionError.Error
  /** The model that tried this compaction, when one was selected. */
  readonly model?: Model.Ref
}

type Prepared = Effect.Success<ReturnType<SessionModelRequest.Interface["compaction"]>>

type Streamed = {
  readonly text: string
  readonly providerState?: SessionMessage.ProviderState
}

const NOTHING_TO_COMPACT: Failure = { error: { type: "compaction.unavailable", message: "Nothing to compact yet" } }
/** An account switch reissues the latest summary instead of writing a new one while less than this was added since. */
const SWITCH_REUSE_TOKENS = 10_000
/** After each "too long" rejection, the next attempt aims at this share of the first rejected request's size. */
const SHRINK_STEPS = [0.7, 0.5, 0.35]
// The least of the window kept free for the last reply before compaction and for the summary itself.
const RESERVE_MIN = 16_000
/** A common window size, assumed for the compaction request when the model's window is unknown. */
const UNKNOWN_WINDOW = 200_000
const TOOL_OUTPUT_MAX_CHARS = 1_250
const IMAGE_TOKEN_ESTIMATE = 1_500
const PDF_TOKEN_ESTIMATE = 2_000
/** Anthropic answered normally because the request sat below its compaction trigger. */
const NATIVE_NOT_TRIGGERED = "compaction.not-triggered"
const NATIVE_UNAVAILABLE = "compaction.native-unavailable"
const IMAGES_FULL_ERROR: SessionError.Error = {
  type: "images.full",
  message:
    "This chat's images fill what one request may carry, so the chat stopped instead of leaving new images out. Compact the chat (/compact) or start a new one; Instructions › the model › Images › When image context is full chooses what happens instead.",
}
const nonShrinkingError: SessionError.Error = {
  type: "compaction.failed",
  message: "Compaction did not reduce the next request below the context limit. The provider checkpoint or fixed instructions/tools remain too large; reduce that fixed context or select a compaction model/strategy that can compress it, then resume.",
}

const compactionUsageKind = (cause: unknown) =>
  cause instanceof AIError && cause.reason._tag === "InvalidProviderOutput" ? cause.reason.compaction : undefined

const compactionUsage = (cause: unknown) =>
  cause instanceof AIError && cause.reason._tag === "InvalidProviderOutput" ? cause.reason.usage : undefined

const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`

const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`

export const buildPrompt = (update: boolean, legacy = false) => {
  const shared = [
    "Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
    SUMMARY_TEMPLATE,
    SUMMARY_RULES,
    "Do not continue the task or call tools.",
    "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
  ]
  if (!update) {
    return [
      "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
      ...shared,
    ].join("\n\n")
  }
  return [
    "Update the existing checkpoint in the conversation above into one consolidated summary.",
    // Before #48058 (Sep 2026), summaries kept nearly everything: every file touched, per-edit changelogs,
    // restated AGENTS.md conventions, and an "Additional Context" section that grew on every update. The
    // preserve-first update prompt would carry that detail forward indefinitely, so a checkpoint from that
    // template is rewritten once at the current level of detail. The rewrite uses the new headings, so later
    // updates skip this. Remove once no session still in use has a latest checkpoint older than #48058.
    ...(legacy
      ? [
          "The existing checkpoint was written with an earlier format that recorded far more detail than this one asks for. Rewrite it at the level of detail described below rather than carrying its detail forward. Keep its requirements, decisions, and open questions; they came from earlier conversation with the user.",
        ]
      : []),
    "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to continuing the work, you may remove it.",
    "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.",
    "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.",
    ...shared,
  ].join("\n\n")
}

const NUDGE =
  "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template."

/** Summaries written with the previous template carry this catch-all heading. */
const LEGACY_HEADING = "## Additional Context"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const db = (yield* Database.Service).db
    const requests = yield* SessionModelRequest.Service
    const agents = yield* Agent.Service
    const modelCatalog = yield* Model.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const models = yield* SessionRunnerModel.Service

    const state = State.create<Settings, Editor>({
      name: "session-compaction",
      initial: () => ({ auto: true, keep: 15_000 }),
      editor: (settings) => ({
        configure: (update) => {
          Object.assign(settings, update)
        },
      }),
    })

    const compact = Effect.fn("SessionCompaction.compact")(function* (trigger: Trigger): Effect.fn.Return<Outcome> {
      const settings = state.get()
      const context = trigger.context

      const ceiling = calculateCeiling(context.model.limit, settings.buffer)
      // Bound only the decide hook, never the summary request or native compaction it may lead to.
      // A decide timeout fails the Step with the request-preparation error; a manual /compact still
      // records a failed compaction so its inbox item settles, while an auto/overflow Step does not.
      const decideTimeout = yield* SessionRequestPrepare.Timeout
      const decided = yield* hooks
        .trigger("session", "compaction.decide", {
          sessionID: context.session.id,
          agent: context.agent.id,
          model: context.model.ref,
          reason: trigger.reason,
          auto: settings.auto,
          due: due(context, ceiling),
          boundary: compactionBoundary(context.messages),
          metrics: thresholdMetrics(context),
        })
        .pipe(Effect.timeoutOption(decideTimeout))
      if (Option.isNone(decided)) {
        const error = {
          type: "session.step.prepare-timeout",
          message: SessionRequestPrepare.message(decideTimeout, yield* hooks.stage),
        }
        if (trigger.reason === "manual") return yield* publish(trigger, { error })
        return { status: "failed", error }
      }
      const decision = decided.value
      if (decision.refusal) return { status: "failed", error: decision.refusal }
      // Anthropic checkpoints already contain portable text. Converting an otherwise
      // unchanged checkpoint must never reload and re-summarize the archived epoch.
      const checkpoint = previousCompaction(context.messages)
      if (decision.portable && checkpoint && SessionProviderContext.isCheckpoint(checkpoint) &&
        !context.messages.slice(context.messages.indexOf(checkpoint) + 1).some((message) => message.type === "user" || message.type === "assistant")) {
        const text = SessionProviderContext.decode(checkpoint.providerContext).flatMap((message) =>
          message.content.flatMap((part) => part.type === "compaction" && part.text ? [part.text] : [])).join("\n")
        if (text.trim()) return yield* publish(trigger, { text, recent: checkpoint.recent, metadata: decision.metadata })
      }
      // CPA moves a chat to another account once it carries a newer checkpoint than the refused request. A
      // summary written moments ago already is that small context: summarizing it again only costs a request.
      const since = context.messages.slice(1)
      if (
        trigger.reason === "auto" &&
        decision.metadata?.["quota.switch"] === true &&
        checkpoint &&
        !SessionProviderContext.isCheckpoint(checkpoint) &&
        since.reduce((sum, message) => sum + Token.estimate(messageToText(message)), 0) < SWITCH_REUSE_TOKENS
      )
        return yield* publish(trigger, {
          text: checkpoint.summary,
          recent: [checkpoint.recent, ...since.map(messageToText)].filter(Boolean).join("\n\n"),
          metadata: { ...decision.metadata, "compaction.reused": true },
        })
      // Plugins may request earlier compaction, but cannot override this preference.
      // The next request would leave an image out. By default compact first; a plugin may instead leave the newest
      // images out or stop. Until agents can compact for themselves, this is what makes room; a failed compaction only
      // means the step goes out with the newest images left out.
      const images = trigger.reason === "auto" && decision.images !== "leave-out" && !decision.compact &&
        !due(context, ceiling) && imagesFull(context)
      if (images && decision.images === "error") return { status: "failed", error: IMAGES_FULL_ERROR }
      if (trigger.reason !== "manual" && !settings.auto) return { status: "skipped" }
      if (trigger.reason === "auto" && !due(context, ceiling) && !decision.compact && !images) return { status: "skipped" }
      // Opaque windows cannot be sized locally. The first primary request measures the rebuilt
      // checkpoint. If it was already full, do not keep recompressing it after every small tool call.
      // Oversized legacy readable tails get one repair; genuine subsequent growth gets a new attempt.
      const previous = previousCompaction(context.messages)
      const first = context.messages.slice(1).find((message) => message.type === "assistant")
      if (
        trigger.reason === "auto" && previous && Token.estimate(previous.recent) <= settings.keep &&
        !context.messages.slice(1).some((message) => message.type === "user") &&
        first?.type === "assistant" && hasMeasuredPrompt(first, context.model.ref) && first.tokens &&
        first.tokens.input + first.tokens.cache.read + first.tokens.cache.write >= ceiling &&
        context.messages.slice(1).reduce((sum, message) => sum + Token.estimate(messageToText(message)), 0) < Math.max(settings.keep, ceiling * 0.1)
      ) return { status: "failed", error: nonShrinkingError }
      // An unknown window never triggers auto compaction, but the compaction request still needs a size to aim for.
      const cap = Number.isFinite(ceiling)
        ? ceiling
        : calculateCeiling({ ...context.model.limit, context: UNKNOWN_WINDOW }, settings.buffer)
      // The provider just rejected this context, so the estimate ran low; the first attempt already aims below it.
      const budget =
        trigger.reason === "overflow" ? Math.min(cap, Math.floor(estimateContext(context) * SHRINK_STEPS[0])) : cap

      // Auto discovers native support from the executable route unless the model explicitly prefers a
      // summary. Local/remote force their respective strategy; the decision hook may override the agent.
      const configuredStrategy = decision.strategy ?? context.agent.info.compaction?.strategy ?? "auto"
      if (decision.portable && configuredStrategy === "remote")
        return {
          status: "failed",
          error: {
            type: "compaction.unavailable",
            message: "Credential handoff requires a local portable summary; this agent requires remote compaction",
          },
        }
      const strategy = decision.portable ? "local" : configuredStrategy
      // Native compaction cannot recover a context the provider already rejected: the replacement window
      // would come from the same rejected endpoint. Only auto or local may recover an overflow.
      if (trigger.reason === "overflow" && strategy === "remote")
        return yield* publish(trigger, {
          error: {
            type: "provider.unsupported-operation",
            message: "Remote compaction cannot recover an overflowing context; select auto or local compaction",
          },
        })
      // Native compaction cannot run below Anthropic's input-token trigger. The request is shrunk to `budget`
      // when the context exceeds it, so the effective size is the smaller of the estimate and that target.
      const operations = context.model.model.route.compact
      const native =
        strategy === "remote" ||
        (strategy === "auto" &&
          context.model.compaction?.type !== "summary" &&
          (operations?.trigger !== undefined || operations?.endpoint !== undefined))
      const observation: CompactionObservation = {
        version: 1,
        configurationWarnings: Option.isSome(config) ? config.value.compactionWarnings?.() : undefined,
        trigger:
          trigger.reason === "manual" || trigger.reason === "overflow"
            ? trigger.reason
            : decision.compact && decision.explanation?.trigger
              ? decision.explanation.trigger
              : decision.compact && decision.metadata?.["quota.switch"] === true
                ? "handoff"
                : due(context, ceiling)
                  ? "context-threshold"
                  : images
                    ? "image-limit"
                    : "hook-request",
        configuredStrategy,
        ...(decision.explanation?.threshold === undefined ? {} : { threshold: decision.explanation.threshold }),
        modelPolicy: context.model.compaction?.type,
        strategySource:
          decision.strategy !== undefined
            ? decision.explanation?.strategy?.value === decision.strategy
              ? decision.explanation.strategy.source
              : "decision-hook"
            : context.agent.info.compaction?.strategy !== undefined
              ? "agent-config"
              : "built-in",
        selectedStrategy: native ? "native" : "text-summary",
        selectionReason:
          decision.portable ? "portable-required"
            : strategy === "local" ? "explicit-local"
            : strategy === "remote" ? "explicit-remote"
            : native ? "auto-native"
             : "auto-text",
      }
      const completed = (owner: Trigger, result: Result) => {
        const checkpoint = SessionMessage.CompactionCompleted.make({
          id: SessionMessage.ID.create(), type: "compaction", status: "completed", reason: "auto",
          summary: result.text, recent: result.recent, providerContext: result.providerContext,
          time: { created: DateTime.nowUnsafe() },
        })
        // Include instructions, tools, provider replacement messages AND the separately replayed tail.
        // A successful provider operation is not necessarily a usable context reduction.
        if (trigger.reason !== "manual" && due(context, ceiling) &&
          estimateContext({ ...context, messages: [checkpoint] }) >= ceiling)
          return publish(owner, { error: nonShrinkingError })
        return publish(owner, {
          ...result,
          ...(decision.portable ? { providerState: undefined } : {}),
          metadata: { ...result.metadata, ...decision.metadata },
        })
      }
      // A failed compaction is recorded; an optional auto compaction then reports skipped so the runner
      // sends its step uncompacted. Manual and overflow ignore `optional`; an image-limit compaction is optional.
      const settle = (failure: Failure): Effect.Effect<Outcome> =>
        publish(trigger, failure).pipe(
          Effect.map((outcome) => ((decision.optional || images) && trigger.reason === "auto" ? { status: "skipped" } : outcome)),
        )
      let fallbackReason = observation.selectionReason
      if (native) {
        const attempt = yield* Effect.result(
          compactNatively(trigger, budget, settings.keep, strategy).pipe(
            Effect.provideService(SessionModelObservation.Compaction, { ...observation, modelSource: "active-model" }),
          ),
        )
        if (Result.isSuccess(attempt)) return yield* completed(trigger, attempt.success)
        const failure = attempt.failure
        if (failure.error.type !== NATIVE_NOT_TRIGGERED && failure.error.type !== NATIVE_UNAVAILABLE)
          return yield* settle(failure)
        // Anthropic capability/legacy-block refusals select the cache-safe local
        // path before a native POST. A billed no-summary result still fails.
        if (strategy === "remote" && failure.error.type !== NATIVE_UNAVAILABLE)
          return yield* settle({
            error: {
              type: "compaction.unavailable",
              message: "Anthropic compaction returned no summary; the existing history was retained",
            },
          })
        fallbackReason = failure.error.type === NATIVE_UNAVAILABLE ? "native-unavailable" : "native-not-triggered"
        // Close the automatic record first so the local fallback's own record is the one it completes. A
        // manual record is completed by the fallback itself.
        if (trigger.reason !== "manual") yield* publish(trigger, failure)
      }

      // A local summary resolves the compaction agent's overrides first, and the checkpoint belongs to the
      // context those overrides produce — its model and instructions, not the trigger's.
      const fallbackAgent = yield* agents.get(Agent.ID.make("compaction"))
      const local = (chosen: Agent.Compaction["model"]) =>
        localize(trigger, chosen, fallbackAgent, decision.system).pipe(
          // A model that cannot resolve records the ref it requested as the one that tried.
          Effect.catch((cause) =>
            Effect.fail<Failure>({
              error: toSessionError(cause),
              model: chosen ?? context.agent.info.compaction?.model ?? fallbackAgent?.model,
            }),
          ),
          Effect.flatMap(({ owner, instruction }) =>
            Effect.gen(function* () {
              // The summary model may have a smaller window than the active chat model.
              const ceiling = calculateCeiling(owner.context.model.limit, settings.buffer)
              const cap = Number.isFinite(ceiling)
                ? ceiling
                : calculateCeiling({ ...owner.context.model.limit, context: UNKNOWN_WINDOW }, settings.buffer)
              const localBudget = trigger.reason === "overflow"
                ? Math.min(cap, Math.floor(estimateContext(owner.context) * SHRINK_STEPS[0]))
                : cap
              // Re-expanding an opaque window for local/overflow recovery must not select a smaller tail
              // just because the summary input is now a full transcript rather than the native window.
              const retained = context.messages.some(SessionProviderContext.isCheckpoint)
                ? { older: owner.context.messages, recent: yield* retain(context, settings.keep) }
                : undefined
              const result = yield* summarize(owner, localBudget, settings.keep, instruction, retained).pipe(
                Effect.mapError((failure) => ({ ...failure, model: owner.context.model.ref })),
                Effect.provideService(SessionModelObservation.Compaction, {
                  ...observation,
                  selectedStrategy: "text-summary",
                  selectionReason: fallbackReason,
                  modelSource:
                    chosen ? chosen === decision.compactionModel ? "decision-hook" : "fallback-list"
                      : context.agent.info.compaction?.model ? "agent-config"
                      : fallbackAgent?.model ? "compaction-agent" : "active-model",
                }),
              )
              return { owner, result }
            }),
          ),
        )
      // `compactionFallbacks`, when present, is the whole list and replaces `compactionFallback`.
      const fallbacks =
        decision.compactionFallbacks ?? (decision.compactionFallback ? [decision.compactionFallback] : [])
      const choices: (Agent.Compaction["model"] | undefined)[] = [decision.compactionModel, ...fallbacks]
      const attempt = (index: number): Effect.Effect<{ owner: Trigger; result: Result }, Failure> =>
        local(choices[index]).pipe(
          // A summary the chosen model could not write is recorded as a failed compaction, then written by
          // the next model. Nothing to compact is not a model problem, so it does not fall back.
          Effect.catch((failure) =>
            failure.error.type === "compaction.unavailable" || index >= choices.length - 1
              ? Effect.fail(failure)
              : Effect.gen(function* () {
                  // A manual compaction owns one record (its /compact item); the last model completes it.
                  if (trigger.reason !== "manual") yield* publish(trigger, failure)
                  spent.delete(context.session.id)
                  return yield* attempt(index + 1)
                }),
          ),
        )
      return yield* attempt(0).pipe(
        Effect.matchEffect({
          onSuccess: ({ owner, result }) => completed(owner, result),
          onFailure: (failure) => settle(failure),
        }),
      )
    })

    const due = (context: SessionContext.Loaded, ceiling: number) => {
      const messages = context.messages
      // A compaction just completed; let the runner rebuild the request from it first.
      const last = messages.at(-1)
      if (last?.type === "compaction" && last.status === "completed") return false
      // An encrypted native window estimates as nothing, so wait for a response to measure it.
      const measured = messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
      if (measured < messages.findLastIndex(SessionProviderContext.isCheckpoint)) return false
      return estimateContext(context) >= ceiling
    }

    const handoff = Effect.fn("SessionCompaction.handoff")(function* (trigger: Trigger): Effect.fn.Return<Outcome> {
      const context = trigger.context
      const previous = previousCompaction(context.messages)
      if (
        !previous ||
        !SessionProviderContext.isCheckpoint(previous) ||
        SessionProviderContext.compatible(
          previous.providerContext.provenance,
          SessionProviderContext.provenance(context.model),
        )
      )
        return { status: "skipped" }

      const portable = SessionProviderContext.decode(previous.providerContext).flatMap((message) =>
        message.content.flatMap((part) => part.type === "compaction" && part.text ? [part.text] : [])).join("\n")
      if (portable.trim()) return yield* publish(trigger, {
        text: portable,
        recent: [previous.recent, ...context.messages.slice(context.messages.indexOf(previous) + 1).map(messageToText)].filter(Boolean).join("\n\n"),
      })

      const attempt = yield* Effect.gen(function* () {
        if (!previous.model)
          return yield* Effect.fail<Failure>({
            error: {
              type: "compaction.unavailable",
              message: "The native checkpoint has no recorded model to write a portable summary",
            },
          })
        // Neither the target nor a maintenance override can consume this checkpoint. Resolve its owner
        // without changing the selected model, then verify the deployment before running request hooks.
        const model = yield* models
          .resolve({ ...context.session, model: previous.model }, modelCatalog.available)
          .pipe(Effect.mapError((cause): Failure => ({ error: toSessionError(cause), model: previous.model })))
        if (
          !SessionProviderContext.compatible(
            previous.providerContext.provenance,
            SessionProviderContext.provenance(model),
          )
        )
          return yield* Effect.fail<Failure>({
            model: model.ref,
            error: {
              type: "compaction.unavailable",
              message:
                "The native checkpoint's original model deployment is unavailable; cannot write a portable summary",
            },
          })
        const owner = { ...trigger, context: { ...context, model } }
        const budget = calculateCeiling(
          { ...model.limit, context: model.limit.context || UNKNOWN_WINDOW },
          state.get().buffer,
        )
        const recent = yield* retain(context, state.get().keep)
        const result = yield* summarize(owner, budget, state.get().keep, undefined, {
          older: context.messages,
          recent,
          checkpointHandoff: true,
        }).pipe(
          Effect.mapError((failure) => ({ ...failure, model: model.ref })),
          Effect.provideService(SessionModelObservation.Compaction, {
            version: 1,
            trigger: "handoff",
            configuredStrategy: context.agent.info.compaction?.strategy ?? "auto",
            modelPolicy: context.model.compaction?.type,
            strategySource: context.agent.info.compaction?.strategy !== undefined ? "agent-config" : "built-in",
            selectedStrategy: "text-summary",
            selectionReason: "checkpoint-handoff",
            modelSource: "checkpoint-owner",
          }),
        )
        // Only readable text crosses this boundary, never source-model continuation state.
        return { owner, result: { ...result, providerState: undefined } }
      }).pipe(Effect.result)
      return Result.isSuccess(attempt)
        ? yield* publish(attempt.success.owner, attempt.success.result)
        : yield* publish(trigger, attempt.failure)
    })

    /** Native windows retain a separate readable tail, independent of what the provider compresses.
     * Legacy windows lack it; recover only the tail from the durable transcript, not summary input.
     */
    const retain = Effect.fnUntraced(function* (context: SessionContext.Loaded, keep: number) {
      const previous = previousCompaction(context.messages)
      // Legacy native checkpoints omitted the tail field's meaning. New checkpoints distinguish
      // intentionally empty bounded tails so repeated compaction cannot resurrect archived history.
      const messages =
        previous && SessionProviderContext.isCheckpoint(previous) && !previous.recent && previous.metadata?.["compaction.bounded-tail"] !== true
          ? yield* SessionHistory.load(db, context.session.id, "local").pipe(Effect.orDie)
          : context.messages
      return splitConversation(messages, keep, true)?.recent ?? ""
    })

    /**
     * The local summary path resolves the compaction agent's model and system overrides. The maintenance
     * `compaction` agent supplies defaults the active agent may partially override. A model or system chosen
     * by the compaction decision outranks both. A provider checkpoint hides the durable transcript it
     * replaced, so local summaries always read it back from history.
     *
     * A summary written by the chat's own model keeps the chat agent's system prompt so the request shares the
     * chat's cached prefix; the compaction system text then moves into the final user message (see `summarize`).
     * Any other model keeps the compaction system prompt as the request's system.
     */
    const localize = Effect.fn("SessionCompaction.localize")(function* (
      trigger: Trigger,
      chosen: Agent.Compaction["model"],
      fallback: Agent.Info | undefined,
      system: string | undefined,
    ) {
      const context = trigger.context
      const config = context.agent.info.compaction
      const ref = chosen ?? config?.model ?? fallback?.model
      const model = ref
        ? yield* models.resolve({ ...context.session, model: ref }, modelCatalog.available)
        : context.model
      const messages = context.messages
      // The decision may replace the agent's compaction system text for this compaction.
      const compactionSystem = system ?? config?.system ?? fallback?.system
      const sameModel =
        model.ref.providerID === context.model.ref.providerID &&
        model.ref.id === context.model.ref.id &&
        model.ref.variant === context.model.ref.variant
      return {
        owner: {
          ...trigger,
          context: {
            ...context,
            model,
            messages,
            agent: {
              ...context.agent,
              info: {
                ...context.agent.info,
                system: sameModel ? context.agent.info.system : (compactionSystem ?? context.agent.info.system),
              },
            },
          },
        },
        /** The chat's own model carries this at the head of the summary prompt instead of the system. */
        instruction: sameModel ? compactionSystem : undefined,
      }
    })

    /**
     *   first:  [E1 … E8][E9 E10]                  →  [S1 + "E9 E10"]
     *   same:   [S1 + "E9 E10"]                   →  [S2 + "E9 E10"]  while the tail fits the allowance
     *   small:  [S1 + "E9 E10"][E11]              →  [S2 + "E9 E10 E11"] when the combined tail fits
     *   again:  [S1 + "E9 E10"][E11 … E18][E19]    →  [S2 + "E19"]      S2 covers S1, E9 E10, and E11–E18
     *
     * The model is sent the whole history, then the summary prompt, so the request extends the prefix
     * the chat's last request cached instead of rewriting a shorter one:
     *
     *   [system][S1 + "E9 E10"][E11 … E18][E19][prompt]    plus one nudge if the reply skips the template
     *
     * On the chat's own model the compaction system text, when one exists, leads the final user message:
     *
     *   [chat system][S1 + "E9 E10"][E11 … E19][compaction system + prompt]
     *
     * Later requests open with the checkpoint as one user message:
     *
     *   <conversation-checkpoint>
     *     <summary>S2</summary>
     *     <recent-context>E19</recent-context>
     *   </conversation-checkpoint>
     *   [new messages…]
     *
     * E = one whole projected message (an assistant includes its tool results). S = a summary.
     * [S + "…"] = one checkpoint: a summary plus at most `keep` tokens of readable messages.
     */
    const summarize = Effect.fnUntraced(function* (
      trigger: Trigger,
      budget: number,
      keep: number,
      instruction: string | undefined,
      retained?: {
        readonly older: ReadonlyArray<SessionMessage.Info>
        readonly recent: string
        readonly checkpointHandoff?: true
      },
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      const split = retained ?? splitConversation(context.messages, keep)
      if (!split) return yield* Effect.fail(NOTHING_TO_COMPACT)

      const previous = previousCompaction(context.messages)
      const summaryPrompt = buildPrompt(previous !== undefined, previous?.summary.includes(LEGACY_HEADING) ?? false)
      // The chat's own model has no compaction system prompt ahead of the history, so any compaction system
      // text travels with the summary prompt as one ordinary user message.
      const prompt = instruction === undefined ? summaryPrompt : `${instruction}\n\n${summaryPrompt}`
      const headings = SUMMARY_TEMPLATE.split("\n").filter((line) => line.startsWith("##"))
      const filled = (text: string) => text.split("\n").some((line) => headings.includes(line.trim()))
      const prepared = yield* prepare(context, context.messages, budget, undefined, retained?.checkpointHandoff)

      // Hooks saw the request without the summary prompt, so it is appended here. A reply that ignores the
      // template gets one reminder before it counts as a failure.
      const send = (request: LLMRequest) =>
        Effect.gen(function* () {
          const prompted = LLMRequest.update(request, { cache: { tools: true, system: true, messages: { tail: 2 } }, messages: [...request.messages, Message.user(prompt)] })
          const reply = yield* stream(context, prompted, prepared)
          if (filled(reply.text)) return { ...reply, recent: split.recent }

          const nudged = LLMRequest.update(prompted, { messages: [...prompted.messages, Message.user(NUDGE)] })
          const retry = yield* stream(context, nudged, prepared)
          if (filled(retry.text)) return { ...retry, recent: split.recent }
          return yield* Effect.fail<Failure>({
            error: {
              type: "compaction.failed",
              message: retry.text.trim()
                ? "Compaction summary did not match the required template"
                : "Compaction produced no summary",
            },
          })
        })

      const overhead = Token.estimate(prompt) + Token.estimate(NUDGE)
      return yield* deliver(trigger, prepared, split.recent, budget - overhead, send)
    })

    /**
     *   endpoint:  [window]                      →  [U U][item]    the provider picks which messages to keep
     *   trigger:   [window][compaction_trigger]  →  [item]
     *                                            →  [U U][item]    we add the newest user messages within `keep`
     *
     * Later requests open with that replacement window in place of the history it covers:
     *
     *   [U U][item][retained readable tail][new messages…]
     *
     * window = the previous compaction and everything since. item = one encrypted compaction item, which only
     * replays on the endpoint that made it. U = a user message as typed. The separate readable tail remains
     * outside the opaque checkpoint while it fits `keep`; aged-out material enters the next checkpoint.
     */
    const compactNatively = Effect.fnUntraced(function* (
      trigger: Trigger,
      budget: number,
      keep: number,
      strategy: "auto" | "local" | "remote",
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      if (!previousCompaction(context.messages) && !context.messages.some(messageToText))
        return yield* Effect.fail(NOTHING_TO_COMPACT)
      const recent = yield* retain(context, keep)
      const unsupported = (message: string) =>
        Effect.fail<Failure>({ error: { type: "provider.unsupported-operation", message } })
      // A tail still retained beside the new window need not be compacted into it. Otherwise endpoints
      // which preserve user messages would echo its wrapper, adding a copy on every compaction with no
      // new conversation. A tail aged out by newer messages MUST enter the checkpoint instead.
      const prepared = yield* prepare(
        context,
        context.messages,
        budget,
        "session",
      )

      // An explicit remote strategy must fail honestly when the route cannot compact natively: it may not
      // silently fall back to a local summary the caller did not ask for.
      const request = prepared.request
      if (
        strategy === "remote" &&
        !LLMClient.canCompact(request, { mechanism: "trigger" }) &&
        !LLMClient.canCompact(request)
      )
        return yield* Effect.fail<Failure>({
          error: toSessionError(
            new ModelResolver.UnsupportedCompactionError({
              providerID: context.model.ref.providerID,
              modelID: context.model.ref.id,
              route: request.model.route.id,
            }),
          ),
        })
      // Remote compaction owns the replacement window. A hook-supplied local summary cannot honor that
      // contract, so it is refused rather than silently installed as local state.
      if (prepared.event.result && strategy === "remote")
        return yield* unsupported("Remote compaction requires a provider checkpoint, not a hook-supplied local summary")

      // History is selected before request hooks, so a hook that reroutes the request cannot be honored here.
      const provenance = SessionProviderContext.provenance(context.model)
      if (!provenance) return yield* unsupported("Provider compaction requires a stable, configured endpoint")
      const routed = SessionProviderContext.provenance({ model: prepared.request.model, ref: context.model.ref })
      if (!SessionProviderContext.compatible(provenance, routed)) {
        return yield* unsupported(
          "Provider compaction requires the endpoint in provider/model settings, not a model.request rewrite",
        )
      }

      const toResult = (window: ReadonlyArray<Message>, usage: Usage | undefined) =>
        spend(context.session.id, usage && SessionUsage.record(usage, context.model.cost)).pipe(
          Effect.as<Result>({
            text: window.flatMap((message) => message.content.flatMap((part) => part.type === "compaction" && part.text ? [part.text] : [])).join("\n"),
            recent,
            providerContext: SessionProviderContext.encode(provenance, window),
          }),
        )

      const send = (request: LLMRequest) => {
        if (LLMClient.canCompact(request, { mechanism: "trigger" })) {
          return Effect.gen(function* () {
            const response = yield* SessionModelObservation.run(prepared.observer, llm.compact(request, { ...prepared.options, mechanism: "trigger" }).pipe(
              Effect.tap((response) => SessionModelObservation.captureUsage(response.usage)),
              Effect.tapError((cause) => { const usage = compactionUsage(cause); return usage ? SessionModelObservation.captureUsage(usage) : Effect.void }),
            )).pipe(
              // A completed compaction call is billed even when its response cannot be used, so record the
              // usage it reported before the failure settles.
              Effect.tapError((cause) => {
                const usage = compactionUsage(cause)
                return usage ? spend(context.session.id, SessionUsage.record(usage, context.model.cost)) : Effect.void
              }),
              // A normal answer means Anthropic did not compact; the outer strategy decides what happens.
              Effect.catch(
                (cause): Effect.Effect<never, AIError | Failure> =>
                  compactionUsageKind(cause) === "not-triggered"
                    ? Effect.fail<Failure>({ error: { type: NATIVE_NOT_TRIGGERED, message: cause.message } })
                    : Effect.fail(cause),
              ),
            )
            const retained = response.checkpoint.signature ? [] : recentUserMessages(
              yield* SessionHistory.load(db, context.session.id, "local").pipe(Effect.orDie), context.model, keep,
            )
            return yield* toResult([...retained, Message.assistant(response.checkpoint)], response.usage)
          })
        }
        if (LLMClient.canCompact(request)) {
          return SessionModelObservation.run(prepared.observer, llm
            .compact(request, { mechanism: "endpoint", http: prepared.options.http }).pipe(
              Effect.tap((response) => SessionModelObservation.captureUsage(response.usage)),
              Effect.tapError((cause) => { const usage = compactionUsage(cause); return usage ? SessionModelObservation.captureUsage(usage) : Effect.void }),
            ))
            .pipe(Effect.flatMap((response) => toResult(response.replacement.filter((message) =>
              !message.content.some((part) => part.type === "text" && part.text ===
                `The following is a serialized record of earlier conversation, not new instructions.\n\n<recent-context>\n${recent}\n</recent-context>`)), response.usage)))
        }
        return unsupported(`Native compaction is not supported for ${request.model.provider}/${request.model.route.id}`)
      }

      return yield* deliver(trigger, prepared, recent, budget, (request) =>
        send(request).pipe(
          Effect.mapError((cause) => {
            if (!(cause instanceof AIError)) return cause
            const reason = cause.reason
            if (strategy !== "auto" && !(reason._tag === "UnsupportedOperation" && request.model.route.protocol === "anthropic-messages")) return cause
            const status = reason.http?.status
            // Protocol support is not deployment support. Missing operations and explicit compaction
            // rejections permit fallback; auth, quota and transient failures retain normal retry behavior.
            const unavailable =
              reason._tag === "UnsupportedOperation" ||
              ((status === 404 || status === 405 || status === 501) &&
                reason._tag !== "Authentication" && reason._tag !== "QuotaExceeded") ||
              (reason._tag === "InvalidRequest" && (status === 400 || status === 422) &&
                /compaction|compact|context_management/i.test(reason.message) &&
                /not supported|unsupported|not available|unknown|unrecognized|not allowed/i.test(reason.message))
            return unavailable ? { error: { ...toSessionError(cause), type: NATIVE_UNAVAILABLE } } : cause
          }),
        ),
      )
    })

    /**
     * Sends the request as-is if it is estimated to fit `target`, and as text otherwise (see `flattenConversation`).
     * Limits and estimates can be wrong, so until the provider rejects something as too long, a request that cannot
     * be made to fit is sent whole: unchanged, or as text once its media has to go. A "too long" rejection means the
     * estimate ran low, so the next attempts aim at 70%, 50%, then 35% of the first rejected request's estimate, and a
     * rejection after those gives up. A "payload too large" rejection is about bytes, which inline media almost always
     * accounts for, so one on the unchanged request resends it as text, which carries no media, without counting; one
     * on text counts as "too long". Other provider errors resend the same request under the session's retry policy. A
     * `Failure` from `send` is a reply that cannot be used, and is never retried.
     */
    const deliver = Effect.fnUntraced(function* (
      trigger: Trigger,
      prepared: Prepared,
      recent: string,
      target: number,
      send: (request: LLMRequest) => Effect.Effect<Result, AIError | Failure>,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      // The runner opened the manual compaction's message when it delivered the `/compact` item.
      if (trigger.reason !== "manual") {
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID: context.session.id, reason: "auto", recent })
      }
      if (prepared.event.result) return yield* fromHook(context, prepared.event.result, recent)

      const policy = yield* SessionRunnerRetry.policy(context.session.id)
      let rejections = 0
      let rejected: number | undefined
      let asText = false

      while (true) {
        // A local estimate must never rewrite warm history before the provider rejects it.
        const fits = !asText && (rejections === 0 || estimateRequest(prepared.request) <= target)
        const request = fits
          ? prepared.request
          : (flattenConversation(prepared.request, context, target) ??
            (rejections > 0
              ? undefined
              : asText
                ? flattenConversation(prepared.request, context, Number.POSITIVE_INFINITY)
                : prepared.request))
        if (!request) {
          return yield* Effect.fail<Failure>({
            error: {
              type: "compaction.failed",
              message:
                "The compaction request cannot be reduced further without losing unsummarized conversation or its checkpoint",
            },
          })
        }

        const attempt = yield* Effect.result(send(request))
        if (Result.isSuccess(attempt)) return attempt.success
        const cause = attempt.failure
        if (!(cause instanceof AIError)) return yield* Effect.fail(cause)
        const error = toSessionError(cause)
        const tooLarge = cause.reason._tag === "InvalidRequest" && cause.reason.classification === "payload-too-large"

        if (tooLarge && request === prepared.request) {
          asText = true
          continue
        }

        if (tooLarge || isContextOverflowFailure(cause)) {
          const step = SHRINK_STEPS[rejections]
          if (step === undefined) return yield* Effect.fail<Failure>({ error })
          rejected ??= estimateRequest(request)
          target = Math.floor(rejected * step)
          rejections++
          continue
        }

        const decision = yield* policy({
          cause,
          error,
          agent: context.agent.id,
          model: context.model.ref,
          hook: prepared.retry,
          retry: SessionRunnerRetry.isRetryable(cause),
        })
        if (!decision.retry) return yield* Effect.fail<Failure>({ error })
        yield* Effect.sleep(decision.delay)
      }
    })

    /**
     * History that has to change is sent as text rather than as edited messages: `[previous compaction][transcript]`,
     * the conversation since that compaction as one text message. A previous summary always stays in front, while
     * its verbatim recent part becomes the oldest transcript entry; a previous native window stays exactly as the
     * provider made it. The transcript leaves out reasoning, media, and instruction updates, and cuts long tool
     * outputs. Undefined when the transcript still does not fit: exchanges being summarized are not disposable.
     */
    const flattenConversation = (request: LLMRequest, context: SessionContext.Loaded, target: number) => {
      const previous = previousCompaction(context.messages)
      const end =
        request.messages.findLastIndex(
          (message) =>
            (previous !== undefined && message.id === previous.id) ||
            message.content.some((part) => part.type === "compaction"),
        ) + 1
      const summary = previous !== undefined && !SessionProviderContext.isCheckpoint(previous) ? previous : undefined
      // TODO: Read the previous summary from the hooked request once it no longer merges summary and recent into one
      // message. Until then it is rebuilt from storage, which drops a compaction hook's edits to that message.
      const lead = summary
        ? toLLMMessages([{ ...summary, recent: "" }], context.model.ref)
        : request.messages.slice(0, end)

      // Preserve real message boundaries without interpreting labels in user text.
      const exchanges = request.messages.slice(end).reduce<string[]>(
        (groups, message) => {
          const text = flattenMessage(message)
          if (!text) return groups
          if (message.role === "user" || groups.length === 0) groups.push(text)
          else groups[groups.length - 1] += `\n${text}`
          return groups
        },
        summary?.recent ? [summary.recent] : [],
      )

      // These exchanges are the source of the new checkpoint, not disposable replay. Omitting one
      // would commit a successful compaction that silently forgot unsummarized conversation.
      const messages = [...lead, ...(exchanges.length ? [Message.user(exchanges.join("\n\n"))] : [])]
      if (estimateRequest({ ...request, messages }) > target) return undefined
      return LLMRequest.update(request, { messages })
    }

    const stream = (context: SessionContext.Loaded, request: LLMRequest, prepared: Prepared) => {
      const sessionID = context.session.id
      const metadataKey = context.model.model.route.providerMetadataKey ?? context.model.model.provider
      const unusable = (error: SessionError.Error) => Effect.fail<Failure>({ error })

      return SessionModelObservation.run(prepared.observer, llm.stream(request, prepared.options).pipe(
        Stream.tap(SessionModelObservation.capture),
        Stream.runFoldEffect(
          (): Streamed => ({ text: "" }),
          (streamed, event): Effect.Effect<Streamed, AIError | Failure> => {
            if (LLMEvent.is.providerError(event)) {
              if (event.classification === undefined)
                return unusable({ type: "provider.error", message: event.message })
              return Effect.fail(
                new AIError({
                  reason: new InvalidRequestError({ message: event.message, classification: event.classification }),
                }),
              )
            }

            if (LLMEvent.is.textDelta(event)) {
              return bus
                .publish(SessionEvent.Compaction.Delta, { sessionID, text: event.text })
                .pipe(Effect.as({ ...streamed, text: streamed.text + event.text }))
            }

            if (LLMEvent.is.stepFinish(event)) {
              return spend(sessionID, SessionUsage.record(event.usage, context.model.cost)).pipe(
                Effect.as({ ...streamed, providerState: event.providerMetadata?.[metadataKey] }),
              )
            }

            if (!LLMEvent.is.finish(event)) return Effect.succeed(streamed)
            switch (event.reason.normalized) {
              case "unknown":
                return Effect.fail(
                  new AIError({
                    reason: new InvalidProviderOutputError({
                      message: "The provider response ended with an unknown finish reason.",
                      classification: "incomplete-stream",
                    }),
                  }),
                )
              case "error":
                return Effect.fail(
                  new AIError({ reason: new UnknownProviderError({ message: "Compaction generation failed" }) }),
                )
              case "length":
                return unusable({
                  type: "compaction.failed",
                  message: "Compaction summary reached the output token limit",
                })
              case "content-filter":
                return unusable(contentFilterError("Compaction summary was blocked by the provider", event.reason))
              default:
                return Effect.succeed(streamed)
            }
          },
        ),
      ))
    }

    /**
     * The conversation as the runner would send it, after request hooks.
     *
     * The output limit leaves room for `budget`, the most `deliver` sends. The request prepared here can be larger
     * when the conversation overshot the threshold, and is only shrunk to fit after hooks have seen it, so sizing the
     * output to it would leave next to no room. A prompt the estimate undersells is rejected and shrunk like any
     * other.
     */
    const prepare = (
      context: SessionContext.Loaded,
      messages: ReadonlyArray<SessionMessage.Info>,
      budget: number,
      webSocket?: "session",
      checkpointHandoff?: true,
    ) => {
      const base = transcript(context, messages)
      return requests.compaction({
        session: context.session,
        agent: context.agent.id,
        model: context.model,
        tools: context.tools,
        system: base.system,
        historyEpoch: context.messages.findLast((message) => message.type === "compaction" && message.status === "completed")?.id ?? "initial",
        messages: base.messages,
        webSocket,
        checkpointHandoff,
        inputTokens: { measured: budget, estimated: 0 },
      })
    }

    /** A request hook supplied the summary itself, so no model call happens. */
    const fromHook = (context: SessionContext.Loaded, supplied: SessionCompactionResult, recent: string) => {
      const usage = supplied.tokens && {
        tokens: supplied.tokens,
        cost: SessionUsage.calculateCost(context.model.cost, supplied.tokens),
      }
      return spend(context.session.id, usage).pipe(
        Effect.as<Result>({
          text: supplied.summary,
          recent,
          providerState: supplied.providerState,
          metadata: supplied.metadata,
        }),
      )
    }

    /**
     * Each model call is billed as soon as it finishes, so failed and interrupted compactions are billed too. The
     * compaction's message shows the total across all of its calls. A session never runs two compactions at once.
     */
    const spent = new Map<SessionContext.Loaded["session"]["id"], SessionUsage.Recorded>()
    const spend = (sessionID: SessionContext.Loaded["session"]["id"], usage: SessionUsage.Recorded | undefined) =>
      Effect.gen(function* () {
        if (!usage) return
        const total = spent.get(sessionID)
        spent.set(sessionID, total ? SessionUsage.add(total, usage) : usage)
        yield* bus.publish(SessionEvent.UsageRecorded, { sessionID, source: "compaction", ...usage })
      })

    const publish = Effect.fnUntraced(function* (
      trigger: Trigger,
      outcome: Result | Failure,
    ): Effect.fn.Return<Outcome> {
      const context = trigger.context
      const sessionID = context.session.id
      const reason = trigger.reason === "manual" ? "manual" : "auto"
      const usage = spent.get(sessionID)

      if ("error" in outcome) {
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason,
          model: outcome.model ?? context.model.ref,
          inputID: trigger.reason === "manual" ? trigger.inputID : undefined,
          error: outcome.error,
          ...usage,
        })
        return { status: "failed", error: outcome.error }
      }

      yield* bus.publish(
        SessionEvent.Compaction.Ended,
        {
          sessionID,
          reason,
          model: context.model.ref,
          providerState: outcome.providerState,
          providerContext: outcome.providerContext,
          text: outcome.text,
          recent: outcome.recent,
          ...usage,
        },
        { metadata: { ...outcome.metadata, "compaction.bounded-tail": true } },
      )
      return { status: "completed" }
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      handoff: (trigger) =>
        SessionModelObservation.operation(handoff(trigger), trigger.reason === "manual" ? trigger.inputID : undefined).pipe(
          Effect.onInterrupt(() =>
            trigger.reason === "manual"
              ? Effect.void
              : publish(trigger, {
                  model: previousCompaction(trigger.context.messages)?.model,
                  error: { type: "compaction.interrupted", message: "Checkpoint conversion was interrupted" },
                }),
          ),
          Effect.ensuring(Effect.sync(() => spent.delete(trigger.context.session.id))),
        ),
      // A manual compaction settles through its `/compact` inbox item, which the runner owns.
      compact: (trigger) =>
        SessionModelObservation.operation(compact(trigger), trigger.reason === "manual" ? trigger.inputID : undefined).pipe(
          Effect.onInterrupt(() =>
            trigger.reason === "manual"
              ? Effect.void
              : publish(trigger, { error: { type: "compaction.interrupted", message: "Compaction was interrupted" } }),
          ),
          Effect.ensuring(Effect.sync(() => spent.delete(trigger.context.session.id))),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    PluginHooks.node,
    Config.node,
    Bus.node,
    Database.node,
    llmClient,
    Agent.node,
    Model.node,
    SessionRequestPrepare.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
  ],
})

/** History loads from the latest completed compaction, so a previous one is always the first message. */
const previousCompaction = (messages: ReadonlyArray<SessionMessage.Info>) => {
  const [first] = messages
  return first?.type === "compaction" && first.status === "completed" ? first : undefined
}

const transcript = (context: SessionContext.Loaded, messages: ReadonlyArray<SessionMessage.Info>) =>
  SessionModelRequest.baseTranscript({
    agent: context.agent.info,
    model: context.model,
    tools: context.tools,
    initial: context.initial,
    messages,
  })

/**
 * `older` gets summarized; `recent`, the newest messages within `keep` tokens, is kept verbatim as text beside
 * the summary. Undefined when there is nothing to compact.
 */
const splitConversation = (messages: ReadonlyArray<SessionMessage.Info>, keep: number, summarized = false) => {
  const previous = previousCompaction(messages)
  const entries = messages.flatMap((message, index) => {
    // The serialized tail is one indivisible segment. User-authored labels are not message boundaries.
    const text = message === previous ? previous.recent : messageToText(message)
    return text ? [{ message, text, index }] : []
  })
  if (entries.length === 0) return previous ? { older: messages, recent: "" } : undefined

  const recent = entries.slice(recentStart(entries, keep, previous !== undefined || summarized))
  const retained = recent[0]?.message === previous
  return {
    older: retained && previous ? [previous] : messages.slice(0, recent[0]?.index ?? messages.length),
    recent: recent.map((entry) => entry.text).join("\n\n"),
  }
}

const recentStart = (
  entries: ReadonlyArray<{ readonly message: SessionMessage.Info; readonly text: string }>,
  keep: number,
  summarized: boolean,
) => {
  // A projected assistant message owns both its calls and their settled results. It is a safe
  // boundary even without another user prompt. Never split serialized legacy tails on text labels:
  // an oversized entry instead goes into the checkpoint whole, including a single huge exchange.
  const dropped = oldestToDrop(entries, (entry) => Token.estimate(entry.text) + Token.estimate("\n\n"), keep)
  if (dropped > 0) return dropped

  // A fitting checkpoint tail survives repeated compaction unchanged.
  if (summarized) return 0

  // Everything fits. Keep only the latest exchange so there is an older part left to summarize.
  const latestUser = entries.findLastIndex((entry) => entry.message.type === "user")
  if (latestUser > 0) return latestUser

  // One exchange with no previous checkpoint. Summarize it all and keep nothing.
  return entries.length
}

const oldestToDrop = <T>(items: ReadonlyArray<T>, size: (item: T) => number, budget: number) => {
  let total = 0
  let start = items.length
  while (start > 0) {
    const next = total + size(items[start - 1])
    if (next > budget) break
    total = next
    start--
  }
  return start
}

/** One message as the recent, verbatim part of a summary shows it. Empty for messages that part leaves out. */
const messageToText = (message: SessionMessage.Info): string => {
  switch (message.type) {
    // Earlier summaries and instruction updates are handled outside the recent part.
    case "compaction":
    case "system":
      return ""

    case "user": {
      const skills =
        message.skills?.flatMap((skill) =>
          skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`],
        ) ?? []
      const files =
        message.files?.map((file) => {
          const name = file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")
          return `[Attached ${file.mime}: ${name}]`
        }) ?? []
      return [...skills, `[User]: ${message.text}`, ...files].join("\n")
    }

    case "location-switched":
      return `[User]: The working directory has been changed to ${message.location.directory}.`

    case "assistant":
      return message.content
        .flatMap((part) => {
          if (part.type === "text") return [`[Assistant]: ${part.text}`]
          if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []

          const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
          const call = `[Assistant tool call]: ${part.name}(${input})`
          if (part.state.status === "completed") {
            return [call, `[Tool result]: ${truncateToolOutput(serializeToolContent(part.state.content))}`]
          }
          if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error.message}`]
          return [call]
        })
        .join("\n")

    case "synthetic":
      return `[Synthetic context]: ${message.text}`

    case "skill":
      return `[Skill activated: ${message.name}]\n${message.text}`

    case "shell":
      if (message.metadata?.background === true) return ""
      return `[Shell]: ${message.command}\n${truncateToolOutput(message.output?.output ?? "")}`

    default:
      return ""
  }
}

const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value

  // Count code points so a surrogate pair is never split.
  let end = 0
  let kept = 0
  for (const char of value) {
    if (kept === TOOL_OUTPUT_MAX_CHARS) break
    end += char.length
    kept++
  }
  if (end === value.length) return value
  return `${value.slice(0, end)}\n[truncated]`
}

/** One request message as a flattened transcript line. Empty for what the transcript leaves out. */
const flattenMessage = (message: Message) => {
  if (message.role === "system") return ""
  return message.content
    .flatMap((part) => {
      if (part.type === "text")
        return part.text ? [`[${message.role === "user" ? "User" : "Assistant"}]: ${part.text}`] : []
      if (part.type === "media") return [`[${part.media.mediaType} omitted]`]
      if (part.type === "tool-call") return [`[Assistant tool call]: ${part.name}(${JSON.stringify(part.input) ?? ""})`]
      if (part.type !== "tool-result") return []
      const result = part.result
      const output =
        result.type === "content"
          ? serializeToolContent(result.value)
          : typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value) ?? "")
      const label = result.type === "error" ? "Tool error" : "Tool result"
      return [`[${label}]: ${truncateToolOutput(output)}`]
    })
    .join("\n")
}

const serializeToolContent = (content: ReadonlyArray<SessionMessage.ToolStateCompleted["content"][number]>) =>
  content
    .map((item) => {
      if (item.type === "text") return item.text
      return `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`
    })
    .join("\n")

/** The newest whole, real user messages within `keep` tokens: no synthetic guidance, no half of an attachment. */
export const recentUserMessages = (
  messages: ReadonlyArray<SessionMessage.Info>,
  model: Pick<SessionContext.Loaded["model"], "ref" | "capabilities">,
  keep: number,
) => {
  const users = messages
    .filter((message) => message.type === "user")
    .map((message) => ({ ...message, skills: undefined }))
  const sendable = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(toLLMMessages(users, model.ref), model.capabilities),
  )
  return sendable.slice(oldestToDrop(sendable, estimateMessage, keep))
}

export const estimateContext = (context: SessionContext.Loaded) => {
  const prompt = estimatePrompt(context)
  return prompt.measured + prompt.estimated
}

/**
 * The next request would leave an image out: its images exceed what one request may carry. Only when an image arrived
 * since the last compaction, since compacting cannot shrink what that compaction kept, so it never repeats on its own.
 */
export const imagesFull = (context: SessionContext.Loaded) => {
  const sendable = (messages: ReadonlyArray<SessionMessage.Info>) =>
    SessionModelRequest.unsupportedParts(toLLMMessages(messages, context.model.ref), context.model.capabilities, context.model.model.provider)
  const checkpoint = context.messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  return (
    SessionModelRequest.imageLoad(sendable(context.messages.slice(checkpoint + 1))).count > 0 &&
    SessionModelRequest.imagesExceed(sendable(context.messages), SessionModelRequest.imageLimits(context.model))
  )
}

/** Only projected assistant usage counts: maintenance and rebilled physical attempts are not history. */
export const thresholdMetrics = (context: SessionContext.Loaded) => {
  const checkpoint = context.messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  const primary = context.messages.slice(checkpoint + 1).filter((message) => message.type === "assistant")
  return {
    input: estimateContext(context),
    output: primary.reduce((sum, message) => sum + (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0), 0),
    // Native checkpoints may keep a replayable tail, but that tail precedes the checkpoint, not new output.
    advanced: checkpoint < 0 || primary.some((message) => !message.error || message.content.length > 0),
  }
}

/** The prompt size: `measured` is what the provider reported at the latest response, `estimated` is the text since. */
export const estimatePrompt = (context: SessionContext.Loaded) => {
  const anchorIndex = context.messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
  const anchor = context.messages[anchorIndex]
  const base = transcript(context, context.messages.slice(Math.max(0, anchorIndex)))
  // TODO: Pass compaction history the runner has already shaped. This and `recentUserMessages` repeat the
  // runner's unsupported-media and image-budget passes; here the image budget only sees images since the anchor,
  // so image-heavy sessions can estimate high.
  const sent = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(base.messages, context.model.capabilities),
  )
  // The anchor's usage covers its own output, but not its local tool results, which the provider never saw.
  const unmeasured = sent.filter((message) => message.role !== "assistant" || message.id !== anchor?.id)

  if (anchor?.type !== "assistant" || !anchor.tokens)
    return {
      measured: 0,
      estimated: estimateRequest({ system: base.system, tools: context.tools.definitions, messages: unmeasured }),
    }

  const tokens = anchor.tokens
  return {
    measured: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning,
    estimated: unmeasured.reduce((sum, message) => sum + estimateMessage(message), 0),
  }
}

/**
 * The largest request the model takes while leaving room for its reply: 10% of the window, or `RESERVE_MIN` when that
 * is more. The summary request is capped at the same size, so its output limit is whatever the reserve leaves. A window
 * too small to give up `RESERVE_MIN` keeps 10%.
 */
const calculateCeiling = (limit: SessionContext.Loaded["model"]["limit"], buffer: number | undefined) => {
  // Unknown limits are reported as 0. An unknown input limit falls back to the context window; with no window at
  // all, only a provider rejection can limit the request.
  const window = limit.input || limit.context
  if (window <= 0) return Number.POSITIVE_INFINITY
  if (buffer !== undefined) return window - buffer
  return window - Math.max(Math.floor(window * 0.1), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
}

/**
 * Another provider's count may describe a native window this model cannot replay. History then holds the original
 * messages that window stood for, which the count leaves out, so only the current provider's counts are trusted.
 */
const hasMeasuredPrompt = (message: SessionMessage.Info, model: SessionContext.Loaded["model"]["ref"]) =>
  message.type === "assistant" &&
  message.model.providerID === model.providerID &&
  !message.error &&
  message.tokens !== undefined &&
  message.tokens.input + message.tokens.cache.read + message.tokens.cache.write > 0

const estimateRequest = (request: Pick<LLMRequest, "system" | "tools" | "messages">) =>
  request.system.reduce((sum, part) => sum + Token.estimate(part.text), 0) +
  request.tools.reduce((sum, tool) => sum + estimateTool(tool), 0) +
  request.messages.reduce((sum, message) => sum + estimateMessage(message), 0)

/** Only what providers receive; `metadata` and `native` stay local. */
const estimateTool = (tool: ToolEntry): number => {
  if (tool.type === "tool") return Token.estimate(tool.name + tool.description + JSON.stringify(tool.inputSchema))
  return (
    Token.estimate(tool.name + (tool.description ?? "")) +
    tool.tools.reduce((sum, entry) => sum + estimateTool(entry), 0)
  )
}

const estimateMessage = (message: Message) => message.content.reduce((sum, part) => sum + estimatePart(part), 0)

const estimatePart = (part: ContentPart): number => {
  // An encrypted native compaction has no locally measurable size.
  if (part.type === "compaction") return Token.estimate(part.text ?? "")
  if (part.type === "effort") return 0
  if (part.type === "text" || part.type === "reasoning") return Token.estimate(part.text)
  if (part.type === "media") return estimateMedia(part.media.mediaType)
  if (part.type === "tool-call") return Token.estimate(part.name + (JSON.stringify(part.input) ?? ""))

  if (part.result.type === "content")
    return part.result.value.reduce(
      (sum, content) => sum + (content.type === "text" ? Token.estimate(content.text) : estimateMedia(content.mime)),
      0,
    )
  const value = part.result.value
  return Token.estimate(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
}

const estimateMedia = (mime: string) => {
  const type = mime.toLowerCase()
  if (type.startsWith("image/")) return IMAGE_TOKEN_ESTIMATE
  if (type === "application/pdf") return PDF_TOKEN_ESTIMATE
  return 0
}
