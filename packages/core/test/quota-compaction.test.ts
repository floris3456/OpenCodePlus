import { expect, test } from "bun:test"
import { GenerationOptions, LLMClient, LLMEvent, LanguageModel, ToolDefinition, type LLMRequest } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Database } from "@opencode/core/database/database"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { EventTable } from "@opencode/core/event/sql"
import { SessionCompaction } from "@opencode/core/session/compaction"
import type { SessionContext } from "@opencode/core/session/context"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Session } from "@opencode/core/session"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { App } from "@opencode/core/app"
import { Agent } from "@opencode/core/agent"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { Model } from "@opencode/core/model"
import { Skill } from "@opencode/schema/skill"
import { Shell } from "@opencode/schema/shell"
import { DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
const model = LanguageModel.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route,
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "## Objective\n- manual summary" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: { normalized: "stop" },
        usage: {
          inputTokens: 15,
          outputTokens: 6,
          nonCachedInputTokens: 10,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
          reasoningTokens: 2,
        },
      }),
      LLMEvent.finish({
        reason: { normalized: "stop" },
      }),
    )
  },
  generate: () => Effect.die("unused"),
})
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  cost,
  limit: { context: 200_000, output: 32_000 },
})
const agents = Layer.mock(Agent.Service, { get: () => Effect.succeed(undefined) })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: ({ model }) =>
    model?.providerID === "missing" && model?.id === "summary"
      ? Effect.fail(new SessionRunnerModel.ModelUnavailableError({ providerID: model.providerID, modelID: model.id }))
      : Effect.succeed(resolved),
})
const catalog = Layer.mock(Model.Service, { available: () => Effect.succeed([]) })
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    {
      replacements: [
        Bus.node.replace(Bus.configured({ persist: true })),
        llmClient.replace(client),
        Agent.node.replace(agents),
        Model.node.replace(catalog),
        SessionRunnerModel.node.replace(models),
      ],
    },
  ),
)

import { compactionBoundary } from "../src/session/compaction-boundary.js"
const insertSession = (id: Session.ID, overrides?: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        ...overrides,
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    return yield* store
      .get(id)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die(`session missing: ${id}`))))
  })

const loaded = (session: Session.Info, messages: readonly SessionMessage.Info[]) => ({
  session,
  messages,
  model: resolved,
  agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
  initial: ["Session instructions"],
  tools: { definitions: [], execute: () => Effect.die("Compaction must not execute tools") },
})

for (const auto of [true, false])
  it.effect(`decision hook respects auto:${auto} and persists completion`, () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const compaction = yield* SessionCompaction.Service
      const store = yield* SessionStore.Service
      const session = yield* insertSession(Session.ID.make(`ses_quota_${auto}`))
      yield* compaction.transform((editor) => editor.configure({ auto, keep: 0 }))
      const messages: SessionMessage.Info[] = [
        {
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Keep this task",
          time: { created: DateTime.makeUnsafe(0) },
        },
      ]
      let seen = false
      yield* hooks.register("session", "compaction.decide", (event) =>
        Effect.sync(() => {
          expect(event.auto).toBe(auto)
          expect(event.due).toBe(false)
          event.compact = true
          event.portable = true
          seen = true
        }),
      )
      yield* hooks.register("session", "compaction", (event) =>
        Effect.sync(() => {
          event.result = { summary: "## Objective\n- Keep this task", providerState: { opaque: "must-not-survive" } }
        }),
      )
      const outcome = yield* compaction.compact({ reason: "auto", context: loaded(session, messages) })
      expect(seen).toBe(true)
      expect(outcome.status).toBe(auto ? "completed" : "skipped")
      const durable = yield* store.context(session.id)
      if (!auto) {
        expect(durable).toEqual([])
        return
      }
      expect(durable[0]).toMatchObject({
        type: "compaction",
        status: "completed",
        summary: "## Objective\n- Keep this task",
      })
      expect(durable[0]).not.toHaveProperty("providerState")
      expect(compactionBoundary(durable).checkpoint).toBe(durable[0]?.id)
    }),
  )
it.effect("typed refusal and failed compaction cannot fabricate a checkpoint", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    const session = yield* insertSession(Session.ID.make("ses_quota_refused"))
    yield* hooks.register("session", "compaction.decide", (event) =>
      Effect.sync(() => {
        event.refusal = { type: "quota.no-capacity", message: "No replacement" }
      }),
    )
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, []) })).toMatchObject({
      status: "failed",
    })
    expect(compactionBoundary(yield* store.context(session.id)).checkpoint).toBeUndefined()
  }),
)
