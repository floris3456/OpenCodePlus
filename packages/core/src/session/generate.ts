export * as SessionGenerate from "./generate.js"

import { LLMClient, LLMRequest, Message, type AIError, type Usage } from "@opencode/ai"
import type { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import { AgentNotFoundError } from "./error.js"
import { SessionCompaction } from "./compaction.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionUsage } from "./usage.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"

export type Error = AgentNotFoundError | Instructions.InitializationBlocked | SessionRunnerModel.Error | AIError

/** Generates text from current Session context without mutating the Session. */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
  /** Pins the request to an earlier selection; used by warming to reuse the last real request's agent. */
  agent?: Agent.ID
  /** Pins the request to an earlier selection; used by warming to reuse the last real request's model. */
  model?: Model.Ref
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
      messages: transcript.messages,
      inputTokens: SessionCompaction.estimatePrompt(loaded),
      // This request will not advance the Session: hooks still shape its content, but
      // must not persist anything, and the warming loop must not treat it as activity.
      durable: false,
    })
    // Run all primary content transforms first, then append the private prompt. Never
    // bind the durable runner's stateful WebSocket to this throwaway response. The
    // cache policy keeps the last history boundary marked so the provider caches the
    // prefix just before the prompt; a real step after a pause then reads it, instead
    // of only the previous turn's boundary.
    const request = LLMRequest.update(prepared.request, {
      cache: { tools: true, system: true, messages: { tail: 2 } },
      messages: [...prepared.request.messages, Message.user(input.prompt)],
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: loaded.model.ref.providerID,
      modelID: loaded.model.ref.id,
    })
    const notifySuccess = (res: { usage?: Usage }) => {
      const usage = res.usage ? SessionUsage.tokens(res.usage) : undefined
      const cost = usage && loaded.model.cost ? SessionUsage.calculateCost(loaded.model.cost, usage) : undefined
      return context.hooks
        .trigger("session", "generated", {
          kind: "generate",
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
          started,
          ended: Date.now(),
          sessionID: selection.session.id,
          agent: loaded.agent.id,
          model: loaded.model.ref,
          error,
        })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("session generated hook error failed", { cause })))
    }
    const response = yield* llm.generate(request, prepared.options).pipe(
      Effect.tap(notifySuccess),
      Effect.tapError(notifyFailure),
    )
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    return response.text
  }).pipe(instances.provide(input.session))
})
