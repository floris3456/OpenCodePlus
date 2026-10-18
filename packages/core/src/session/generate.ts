export * as SessionGenerate from "./generate.js"

import { CacheHint, GenerationOptions, LLMClient, LLMRequest, Message, type AIError, type Usage } from "@opencode/ai"
import { markMessage } from "@opencode/ai/cache-policy"
import type { Model } from "@opencode/schema/model"
import type { FileSystem } from "../filesystem.js"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import { AgentNotFoundError } from "./error.js"
import { SessionCompaction } from "./compaction.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionModelObservation } from "./model-observation.js"
import { SessionUsage } from "./usage.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

/** Generates text from current Session context without mutating the Session. */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
  /** Pins the request to an earlier selection; used by warming to reuse the last real request's agent. */
  agent?: Agent.ID
  /** Pins the request to an earlier selection; used by warming to reuse the last real request's model. */
  model?: Model.Ref
  /** Only refresh the prompt cache: where the route supports a zero-token request, nothing is generated. */
  prewarm?: boolean
}) {
  const instances = yield* Instance.Service
  const llm = yield* LLMClient.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id, input.agent)
    const loaded = yield* context.load(
      input.model === undefined ? selection : { ...selection, session: { ...selection.session, model: input.model } },
      "preview",
    )
    const transcript = SessionModelRequest.baseTranscript({
      agent: loaded.agent.info,
      model: loaded.model,
      tools: loaded.tools,
      initial: loaded.initial,
      messages: loaded.messages,
    })
    const started = Date.now()
    const prepared = yield* context.request.primary({
      session: loaded.session,
      agent: loaded.agent.id,
      model: loaded.model,
      tools: loaded.tools,
      system: transcript.system,
      historyEpoch: transcript.historyEpoch,
      messages: transcript.messages,
      inputTokens: SessionCompaction.estimatePrompt(loaded),
      // Transport hooks must see this wire request as auxiliary generate so Monitor
      // joins it to the `generated` outcome and the warming relabel. The content hook
      // stays primary on purpose: its transforms make this request's cache prefix
      // identical to the next real step.
      transportKind: "generate",
      // This request will not advance the Session: hooks still shape its content, but
      // must not persist anything, and the warming loop must not treat it as activity.
      durable: false,
    })
    // Run all primary content transforms first, then append the private prompt. Never
    // bind the durable runner's stateful WebSocket to this throwaway response.
    // The only message breakpoint sits on the last history message the next real step
    // shares at the same place, so that step reads what this request writes. Never on
    // the prompt, which the step does not contain, nor on a trailing system update:
    // Anthropic accepts a system message only after a user turn, so it moves behind the
    // prompt here and behind the next user message in the step.
    // The output limit is not part of the cached prefix, so a pre-warm reads and writes the same cache.
    const shared = prepared.request.messages.findLastIndex((message) => message.role !== "system")
    const request = LLMRequest.update(prepared.request, {
      cache: { tools: true, system: true },
      messages: [
        ...prepared.request.messages.map((message, index) =>
          index === shared ? markMessage(message, new CacheHint({ type: "ephemeral" })) : message,
        ),
        Message.user(input.prompt),
      ],
      ...(input.prewarm && prepared.request.model.route.supportsPrewarm?.(prepared.request)
        ? { generation: GenerationOptions.make({ ...prepared.request.generation, maxTokens: 0 }) }
        : {}),
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: loaded.model.ref.providerID,
      modelID: loaded.model.ref.id,
    })
    const notification: { invocationID?: string } = {}
    const notifySuccess = (res: { usage?: Usage }) => {
      const usage = res.usage ? SessionUsage.tokens(res.usage) : undefined
      const cost = usage && loaded.model.cost ? SessionUsage.calculateCost(loaded.model.cost, usage) : undefined
      return context.hooks
        .trigger("session", "generated", {
          kind: "generate",
          invocationID: notification.invocationID,
          started,
          ended: Date.now(),
          sessionID: selection.session.id,
          agent: loaded.agent.id,
          model: loaded.model.ref,
          usage,
          cost,
        })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("session generated hook failed", { cause })))
    }
    const notifyFailure = (err: unknown) => {
      const error = String((err as Error)?.message ?? err)
      return context.hooks
        .trigger("session", "generated", {
          kind: "generate",
          invocationID: notification.invocationID,
          started,
          ended: Date.now(),
          sessionID: selection.session.id,
          agent: loaded.agent.id,
          model: loaded.model.ref,
          error,
        })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("session generated hook error failed", { cause })))
    }
    const response = yield* SessionModelObservation.run(
      prepared.observer,
      llm
        .generate(request, prepared.options)
        .pipe(Effect.tap((response) => SessionModelObservation.captureUsage(response.usage))),
      {
        onStart: (id) => {
          notification.invocationID = id
        },
      },
    ).pipe(Effect.tap(notifySuccess), Effect.tapError(notifyFailure))
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    return response.text
  }).pipe(instances.provide(input.session))
})
