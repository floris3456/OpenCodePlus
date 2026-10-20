import { expect } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, type LLMRequest } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Database } from "@opencode/core/database/database"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { SessionCompaction } from "@opencode/core/session/compaction"
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
import { Agent } from "@opencode/core/agent"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { Model } from "@opencode/core/model"
import { Location } from "@opencode/core/location"
import { DateTime, Effect, Layer, Stream } from "effect"
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
    // A model the provider refuses (for example an alias CPA no longer serves).
    if (request.model.id === "broken-summary")
      return Stream.make(LLMEvent.providerError({ message: "unknown provider for model broken-summary" }))
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
// A separate, cheaper model a compaction decision can choose for the summary.
const cheap = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "cheap-summary", provider: "cheap", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost,
    limit: { context: 1_000_000, output: 32_000 },
  },
)
const broken = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "broken-summary", provider: "broken", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost,
    limit: { context: 1_000_000, output: 32_000 },
  },
)
const agents = Layer.mock(Agent.Service, { get: () => Effect.succeed(undefined) })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: ({ model }) =>
    model?.providerID === "missing" && model?.id === "summary"
      ? Effect.fail(new SessionRunnerModel.ModelUnavailableError({ providerID: model.providerID, modelID: model.id }))
      : Effect.succeed(model?.providerID === "cheap" ? cheap : model?.providerID === "broken" ? broken : resolved),
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
        Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
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
for (const chosen of [true, false])
  it.effect(
    `a decision's compaction model ${chosen ? "writes" : "is absent:"} the summary; the session keeps its model`,
    () =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.Service
        const compaction = yield* SessionCompaction.Service
        const store = yield* SessionStore.Service
        const session = yield* insertSession(Session.ID.make(`ses_quota_summary_model_${chosen}`))
        yield* compaction.transform((editor) => editor.configure({ auto: true, keep: 0 }))
        const messages: SessionMessage.Info[] = [
          {
            id: SessionMessage.ID.create(),
            type: "user",
            text: "Keep this task",
            time: { created: DateTime.makeUnsafe(0) },
          },
        ]
        yield* hooks.register("session", "compaction.decide", (event) =>
          Effect.sync(() => {
            event.compact = true
            event.portable = true
            if (chosen) event.compactionModel = cheap.ref
          }),
        )
        requests = []
        const context = loaded(session, messages)
        const outcome = yield* compaction.compact({ reason: "auto", context })
        expect(outcome.status).toBe("completed")
        // The summary request went to the chosen model; without a choice it stays on the session model.
        expect(requests.map((request) => String(request.model.id))).toEqual([
          chosen ? "cheap-summary" : "summary-model",
        ])
        const durable = yield* store.context(session.id)
        expect(durable[0]).toMatchObject({
          type: "compaction",
          status: "completed",
          model: chosen ? { providerID: "cheap", id: "cheap-summary" } : { providerID: "test", id: "summary-model" },
        })
        // The trigger's context, and so the model of the next step, is untouched.
        expect(context.model.ref).toEqual(resolved.ref)
      }),
  )
it.effect("a compaction model that does not resolve fails the compaction without a checkpoint", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    const session = yield* insertSession(Session.ID.make("ses_quota_summary_model_missing"))
    yield* compaction.transform((editor) => editor.configure({ auto: true, keep: 0 }))
    yield* hooks.register("session", "compaction.decide", (event) =>
      Effect.sync(() => {
        event.compact = true
        event.portable = true
        event.compactionModel = Model.Ref.make({
          providerID: Provider.ID.make("missing"),
          id: Model.ID.make("summary"),
        })
      }),
    )
    requests = []
    const messages: SessionMessage.Info[] = [
      {
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Keep this task",
        time: { created: DateTime.makeUnsafe(0) },
      },
    ]
    const outcome = yield* compaction.compact({ reason: "auto", context: loaded(session, messages) })
    expect(outcome.status).toBe("failed")
    expect(requests).toEqual([])
    expect(compactionBoundary(yield* store.context(session.id)).checkpoint).toBeUndefined()
  }),
)
const missingModel = Model.Ref.make({ providerID: Provider.ID.make("missing"), id: Model.ID.make("summary") })
for (const [first, why] of [
  [missingModel, "does not resolve"],
  [broken.ref, "is refused by the provider"],
] as const)
  it.effect(`a compaction model that ${why} falls back within the same compaction`, () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const compaction = yield* SessionCompaction.Service
      const store = yield* SessionStore.Service
      const session = yield* insertSession(Session.ID.make(`ses_quota_fallback_${first.providerID}`))
      yield* compaction.transform((editor) => editor.configure({ auto: true, keep: 0 }))
      yield* hooks.register("session", "compaction.decide", (event) =>
        Effect.sync(() => {
          event.compact = true
          event.portable = true
          event.compactionModel = first
          event.compactionFallback = cheap.ref
        }),
      )
      requests = []
      const messages: SessionMessage.Info[] = [
        {
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Keep this task",
          time: { created: DateTime.makeUnsafe(0) },
        },
      ]
      const outcome = yield* compaction.compact({ reason: "auto", context: loaded(session, messages) })
      expect(outcome.status).toBe("completed")
      // Only the fallback wrote the summary (a refused model is asked once, then the fallback).
      expect(requests.map((request) => String(request.model.id))).toEqual(
        first === broken.ref ? ["broken-summary", "cheap-summary"] : ["cheap-summary"],
      )
      const durable = yield* store.context(session.id)
      // The failure stays visible as its own record; the checkpoint is the fallback's.
      const records = yield* store.messages({ sessionID: session.id, order: "asc", type: "compaction" })
      expect(records.map((record) => record.type === "compaction" && record.status)).toEqual(["failed", "completed"])
      expect(durable[0]).toMatchObject({ type: "compaction", status: "completed", model: { id: "cheap-summary" } })
      expect(compactionBoundary(durable).checkpoint).toBe(durable[0]?.id)
    }),
  )
it.effect("the fallback stays unused when the compaction model works or there is nothing to compact", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    yield* compaction.transform((editor) => editor.configure({ auto: true, keep: 0 }))
    yield* hooks.register("session", "compaction.decide", (event) =>
      Effect.sync(() => {
        event.compact = true
        event.portable = true
        event.compactionModel = cheap.ref
        event.compactionFallback = broken.ref
      }),
    )
    requests = []
    const working = yield* insertSession(Session.ID.make("ses_quota_fallback_unused"))
    const messages: SessionMessage.Info[] = [
      {
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Keep this task",
        time: { created: DateTime.makeUnsafe(0) },
      },
    ]
    expect((yield* compaction.compact({ reason: "auto", context: loaded(working, messages) })).status).toBe("completed")
    expect(requests.map((request) => String(request.model.id))).toEqual(["cheap-summary"])
    expect(
      (yield* store.messages({ sessionID: working.id, order: "asc", type: "compaction" })).map(
        (m) => m.type === "compaction" && m.status,
      ),
    ).toEqual(["completed"])
    requests = []
    const empty = yield* insertSession(Session.ID.make("ses_quota_fallback_empty"))
    expect((yield* compaction.compact({ reason: "auto", context: loaded(empty, []) })).status).toBe("failed")
    expect(requests).toEqual([])
  }),
)

it.effect("compactionFallbacks are tried in order and each failure records its model", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    const session = yield* insertSession(Session.ID.make("ses_quota_fallback_order"))
    yield* compaction.transform((editor) => editor.configure({ auto: true, keep: 0 }))
    yield* hooks.register("session", "compaction.decide", (event) =>
      Effect.sync(() => {
        event.compact = true
        event.portable = true
        event.compactionModel = broken.ref
        event.compactionFallbacks = [missingModel, cheap.ref]
      }),
    )
    requests = []
    const messages: SessionMessage.Info[] = [
      {
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Keep this task",
        time: { created: DateTime.makeUnsafe(0) },
      },
    ]
    const outcome = yield* compaction.compact({ reason: "auto", context: loaded(session, messages) })
    expect(outcome.status).toBe("completed")
    // A refused model is asked once; a model that does not resolve is skipped; the third writes the summary.
    expect(requests.map((request) => String(request.model.id))).toEqual(["broken-summary", "cheap-summary"])
    const records = (yield* store.messages({ sessionID: session.id, order: "asc" })).filter(
      (record) => record.type === "compaction",
    )
    expect(
      records.map((record) => [
        record.status,
        "model" in record ? `${record.model?.providerID}/${record.model?.id}` : undefined,
      ]),
    ).toEqual([
      ["failed", "broken/broken-summary"],
      ["failed", "missing/summary"],
      ["completed", "cheap/cheap-summary"],
    ])
  }),
)

it.effect("compactionFallbacks replaces compactionFallback when both are set", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_quota_fallbacks_replace"))
    yield* compaction.transform((editor) => editor.configure({ auto: true, keep: 0 }))
    yield* hooks.register("session", "compaction.decide", (event) =>
      Effect.sync(() => {
        event.compact = true
        event.portable = true
        event.compactionModel = missingModel
        // The single fallback would fail; the list must win and complete the compaction.
        event.compactionFallback = broken.ref
        event.compactionFallbacks = [cheap.ref]
      }),
    )
    requests = []
    const messages: SessionMessage.Info[] = [
      {
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Keep this task",
        time: { created: DateTime.makeUnsafe(0) },
      },
    ]
    expect((yield* compaction.compact({ reason: "auto", context: loaded(session, messages) })).status).toBe("completed")
    expect(requests.map((request) => String(request.model.id))).toEqual(["cheap-summary"])
  }),
)

for (const [trigger, optional] of [
    ["overflow", true],
    ["manual", true],
    ["auto", false],
  ] as const)
    it.effect(`optional:${optional} on a ${trigger} compaction does not skip`, () =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.Service
        const compaction = yield* SessionCompaction.Service
        const store = yield* SessionStore.Service
        const session = yield* insertSession(Session.ID.make(`ses_quota_optional_${trigger}_${optional}`))
        yield* compaction.transform((editor) => editor.configure({ auto: true, keep: 0 }))
        yield* hooks.register("session", "compaction.decide", (event) =>
          Effect.sync(() => {
            event.compact = true
            event.portable = true
            event.compactionModel = broken.ref
            event.optional = optional
          }),
        )
        requests = []
        const messages: SessionMessage.Info[] = [
          {
            id: SessionMessage.ID.create(),
            type: "user",
            text: "Keep this task",
            time: { created: DateTime.makeUnsafe(0) },
          },
        ]
        const context = loaded(session, messages)
        const outcome = yield* compaction.compact(
          trigger === "manual"
            ? { reason: "manual", context, inputID: SessionMessage.ID.create() }
            : { reason: trigger, context },
        )
        expect(outcome.status).toBe("failed")
        // The failed model is still recorded even though the step may continue.
        const records = yield* store.messages({ sessionID: session.id, order: "asc", type: "compaction" })
        expect(records.map((record) => record.type === "compaction" && record.status)).toEqual(["failed"])
      }),
    )

it.effect("optional skips an auto compaction whose every model failed, recording the failures", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    const session = yield* insertSession(Session.ID.make("ses_quota_optional_skip"))
    yield* compaction.transform((editor) => editor.configure({ auto: true, keep: 0 }))
    yield* hooks.register("session", "compaction.decide", (event) =>
      Effect.sync(() => {
        event.compact = true
        event.portable = true
        event.compactionModel = broken.ref
        event.compactionFallbacks = [missingModel]
        event.optional = true
      }),
    )
    requests = []
    const messages: SessionMessage.Info[] = [
      {
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Keep this task",
        time: { created: DateTime.makeUnsafe(0) },
      },
    ]
    const outcome = yield* compaction.compact({ reason: "auto", context: loaded(session, messages) })
    expect(outcome).toEqual({ status: "skipped" })
    const records = (yield* store.messages({ sessionID: session.id, order: "asc" })).filter(
      (record) => record.type === "compaction",
    )
    expect(
      records.map((record) => [
        record.status,
        "model" in record ? `${record.model?.providerID}/${record.model?.id}` : undefined,
      ]),
    ).toEqual([
      ["failed", "broken/broken-summary"],
      ["failed", "missing/summary"],
    ])
  }),
)

it.effect("a decision strategy overrides the agent's, locally and remotely", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    const native = { ...resolved, compaction: { type: "native" as const } }
    const agent = {
      id: Agent.defaultID,
      info: {
        ...Agent.Info.default(Agent.defaultID),
        compaction: { strategy: "auto" as const },
      },
    }
    const messages: SessionMessage.Info[] = [
      {
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Keep this task",
        time: { created: DateTime.makeUnsafe(0) },
      },
    ]
    yield* compaction.transform((editor) => editor.configure({ auto: true, keep: 0 }))

    // The agent's auto strategy would take the native path and fail on this route.
    const local = yield* insertSession(Session.ID.make("ses_quota_strategy_local"))
    yield* hooks.register("session", "compaction.decide", (event) =>
      Effect.sync(() => {
        event.compact = true
        event.strategy = "local"
      }),
    )
    requests = []
    expect(
      (yield* compaction.compact({ reason: "auto", context: { ...loaded(local, messages), model: native, agent } }))
        .status,
    ).toBe("completed")
    expect(requests.map((request) => String(request.model.id))).toEqual(["summary-model"])
    expect((yield* store.messages({ sessionID: local.id, order: "asc", type: "compaction" }))[0]).toMatchObject({
      status: "completed",
    })

    // A portable decision under a remote strategy writes a local summary: with the model it names, and with
    // the chat's own model when it names none, since this route has no readable native checkpoint.
    for (const named of [true, false]) {
      const remote = yield* insertSession(Session.ID.make(`ses_quota_strategy_remote_${named}`))
      yield* hooks.register("session", "compaction.decide", (event) =>
        Effect.sync(() => {
          event.compact = true
          event.portable = true
          event.strategy = "remote"
          if (named) event.compactionModel = cheap.ref
          else delete event.compactionModel
        }),
      )
      requests = []
      expect(
        (yield* compaction.compact({ reason: "auto", context: { ...loaded(remote, messages), model: native, agent } }))
          .status,
      ).toBe("completed")
      expect(requests.map((request) => String(request.model.id))).toEqual([named ? "cheap-summary" : "summary-model"])
      const [checkpoint] = yield* store.context(remote.id)
      expect(checkpoint).toMatchObject({ type: "compaction", status: "completed", summary: "## Objective\n- manual summary" })
      expect(checkpoint).not.toHaveProperty("providerContext", expect.anything())
    }
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

const summarized = (recent = "") =>
  SessionMessage.CompactionCompleted.make({
    id: SessionMessage.ID.create(),
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "## Objective\n- Keep this task",
    recent,
    time: { created: DateTime.makeUnsafe(0) },
  })
const said = (text: string): SessionMessage.Info => ({
  id: SessionMessage.ID.create(),
  type: "user",
  text,
  time: { created: DateTime.makeUnsafe(0) },
})

it.effect("an empty assistant held for a retry does not move the chat past its checkpoint", () =>
  Effect.sync(() => {
    const checkpoint = summarized()
    const replied = (fields: { error?: boolean; completed?: boolean }): SessionMessage.Info => ({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: resolved.ref,
      content: [],
      ...(fields.error ? { error: { type: "provider.internal", message: "CPA moves this chat" } } : {}),
      time: { created: DateTime.makeUnsafe(0), ...(fields.completed ? { completed: DateTime.makeUnsafe(1) } : {}) },
    })
    // A refused request, and the placeholder of the retry after it, leave the checkpoint unconsumed.
    expect(compactionBoundary([checkpoint, said("continue"), replied({ error: true, completed: true })]).checkpoint).toBe(
      checkpoint.id,
    )
    expect(compactionBoundary([checkpoint, said("continue"), replied({})]).checkpoint).toBe(checkpoint.id)
    // A reply that finished consumed it.
    expect(compactionBoundary([checkpoint, said("continue"), replied({ completed: true })]).checkpoint).toBeUndefined()
  }),
)

it.effect("an account switch reissues a recent summary instead of writing another", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    yield* hooks.register("session", "compaction.decide", (event) =>
      Effect.sync(() => {
        event.compact = true
        event.portable = true
        event.compactionModel = cheap.ref
        event.metadata = { ...event.metadata, "quota.switch": true }
      }),
    )
    const checkpoint = summarized("Earlier exchange")
    const recent = yield* insertSession(Session.ID.make("ses_quota_switch_recent"))
    requests = []
    const outcome = yield* compaction.compact({
      reason: "auto",
      context: loaded(recent, [checkpoint, said("continue")]),
    })
    expect(outcome.status).toBe("completed")
    expect(requests).toEqual([])
    const [reissued] = yield* store.context(recent.id)
    expect(reissued).toMatchObject({
      type: "compaction",
      status: "completed",
      summary: checkpoint.summary,
      metadata: { "quota.switch": true, "compaction.reused": true },
    })
    expect(reissued?.id).not.toBe(checkpoint.id)
    const tail = reissued?.type === "compaction" && reissued.status === "completed" ? reissued.recent : undefined
    expect(tail).toContain("Earlier exchange")
    expect(tail).toContain("continue")
    // More than 10k tokens since the summary: the switch writes a new one.
    const grown = yield* insertSession(Session.ID.make("ses_quota_switch_grown"))
    requests = []
    yield* compaction.compact({
      reason: "auto",
      context: loaded(grown, [checkpoint, said("long paste ".repeat(5_000))]),
    })
    expect(requests.map((request) => String(request.model.id))).toEqual(["cheap-summary"])
  }),
)
