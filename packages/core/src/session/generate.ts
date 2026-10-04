export * as SessionGenerate from "./generate.js"

import { LLMClient, LLMRequest, Message, type AIError } from "@opencode/ai"
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
    const prepared = yield* context.request.primary({
      session: loaded.session,
      agent: loaded.agent.id,
      model: loaded.model,
      tools: loaded.tools,
      system: transcript.system,
      messages: transcript.messages,
      inputTokens: SessionCompaction.estimatePrompt(loaded),
    })
    // Run all primary content transforms first, then append the private prompt. Never
    // bind the durable runner's stateful WebSocket to this throwaway response.
    const request = LLMRequest.update(prepared.request, {
      messages: [...prepared.request.messages, Message.user(input.prompt)],
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: loaded.model.ref.providerID,
      modelID: loaded.model.ref.id,
    })
    const response = yield* llm.generate(request, prepared.options)
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    return response.text
  }).pipe(instances.provide(input.session))
})
