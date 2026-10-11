import { expect, test } from "bun:test"
import { GenerationOptions, LLMClient, LLMEvent, LanguageModel, ToolDefinition, type LLMRequest } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Database } from "@opencode/core/database/database"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
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
import { DateTime, Effect, Fiber, FileSystem, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { KV } from "@opencode/core/kv"
import { PluginHost } from "@opencode/core/plugin/host"
import { createHandlers, createState, decideCompactionFor } from "../../plus/src/index.js"
import { getCompactionTriggers, setCompactionTriggers } from "../../plus/src/compaction/triggers.js"
import { fullContext } from "../../plus/test/harness.js"

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
  // A requested ref keeps its identity so compaction can compare it with the chat's own model; without one the
  // session model stands in.
  resolve: ({ model }) =>
    model?.providerID === "missing" && model?.id === "summary"
      ? Effect.fail(new SessionRunnerModel.ModelUnavailableError({ providerID: model.providerID, modelID: model.id }))
      : Effect.succeed(model ? { ...resolved, ref: model } : resolved),
})
const catalog = Layer.mock(Model.Service, { available: () => Effect.succeed([]) })
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      KV.node,
      LayerNodePlatform.filesystem,
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

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt(false)

  expect(prompt).toContain("## Work State")
  expect(prompt).toContain("### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

it.effect("hot triggers persist in plugin storage and change the same production boundary without changing history or instructions", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const store = yield* SessionStore.Service
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_hot_triggers"))
    const other = yield* insertSession(Session.ID.make("ses_hot_other"))
    const ctx = { ...fullContext({
      directory: "/project",
      session: { get: ({ sessionID }) => store.get(sessionID).pipe(Effect.flatMap((value) => value ? Effect.succeed(value) : Effect.die("Unknown Session"))) },
    }), storage: PluginHost.storage(kv, "opencode.plus") }
    const state = createState()
    const handlers = createHandlers(ctx, state)
    const rpc = { error: (type: string, message: string, data?: unknown): never => { throw new Error(`${type}: ${message} ${JSON.stringify(data)}`) } }
    const history = [SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text: "Synthetic history", time: { created: DateTime.makeUnsafe(0) } })]
    const context = loaded(session, history)
    const before = JSON.stringify(context)
    const storedBefore = yield* store.messages({ sessionID: session.id, order: "asc" })
    const db = (yield* Database.Service).db
    const eventsBefore = yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)
    const instructions = JSON.stringify(state.cachedModelSettings)
    const estimate = SessionCompaction.estimateContext(context)
    yield* hooks.register("session", "compaction.decide", (event) => decideCompactionFor(ctx, state, event))
    requests = []
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "skipped" })
    expect(yield* handlers["compaction.triggers.set"]({ sessionID: session.id, input: estimate + 1, output: 30 }, rpc)).toEqual({ sessionID: session.id, input: estimate + 1, output: 30 })
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "skipped" })
    // Inclusive threshold; exactly the same Session/context between the two decisions.
    expect(yield* handlers["compaction.triggers.set"]({ sessionID: session.id, input: estimate }, rpc)).toEqual({ sessionID: session.id, input: estimate, output: 30 })
    expect(JSON.stringify(context)).toBe(before)
    expect(JSON.stringify(state.cachedModelSettings)).toBe(instructions)
    expect(yield* store.messages({ sessionID: session.id, order: "asc" })).toEqual(storedBefore)
    expect(yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)).toEqual(eventsBefore)
    expect(yield* handlers["compaction.triggers"]({ sessionID: other.id }, rpc)).toEqual({ sessionID: other.id })
    const reopened = { ...fullContext({ directory: "/project" }), storage: PluginHost.storage(kv, "opencode.plus") }
    expect(yield* getCompactionTriggers(reopened, session.id)).toEqual({ sessionID: session.id, input: estimate, output: 30 })
    expect(yield* getCompactionTriggers({ ...reopened, storage: PluginHost.storage(kv, "other.plugin") }, session.id)).toEqual({ sessionID: session.id })
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    const checkpoints = yield* store.messages({ sessionID: session.id, order: "asc", type: "compaction" })
    const checkpoint = checkpoints.at(-1)
    if (!checkpoint) return yield* Effect.die("Missing completed checkpoint")
    const reset = loaded(session, [...history, checkpoint])
    expect(SessionCompaction.thresholdMetrics(reset)).toMatchObject({ output: 0, advanced: false })
    expect(yield* compaction.compact({ reason: "auto", context: reset })).toEqual({ status: "skipped" })
    const user = SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text: "New user input", time: { created: DateTime.makeUnsafe(1) } })
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, [...reset.messages, user]) })).toEqual({ status: "skipped" })
    expect(yield* handlers["compaction.triggers.set"]({ sessionID: session.id, input: null }, rpc)).toEqual({ sessionID: session.id, output: 30 })
    expect(yield* handlers["compaction.triggers.set"]({ sessionID: session.id, output: null }, rpc)).toEqual({ sessionID: session.id })
    expect(yield* handlers["compaction.triggers.set"]({ sessionID: session.id }, rpc)).toEqual({ sessionID: session.id })
    const failing = createHandlers({ ...ctx, storage: { ...ctx.storage, set: () => Effect.die("Synthetic storage failure") } }, state)
    expect((yield* Effect.exit(failing["compaction.triggers.set"]({ sessionID: session.id, input: 1 }, rpc)))._tag).toBe("Failure")
    expect(yield* handlers["compaction.triggers"]({ sessionID: session.id }, rpc)).toEqual({ sessionID: session.id })
    const absent = Session.ID.make("ses_hot_absent")
    expect((yield* Effect.exit(handlers["compaction.triggers"]({ sessionID: absent }, rpc)))._tag).toBe("Failure")
    expect((yield* Effect.exit(handlers["compaction.triggers.set"]({ sessionID: absent, input: 1 }, rpc)))._tag).toBe("Failure")
    expect(yield* getCompactionTriggers(ctx, absent)).toEqual({ sessionID: absent })
  }),
)

it.live("compaction trigger preferences survive closing and reopening the production database and plugin storage", () =>
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem
    const directory = yield* files.makeTempDirectoryScoped()
    const fresh = LayerNode.compile(LayerNode.group([Database.node, KV.node, SessionStore.node]), {
      replacements: [Database.node.replace(Database.configured({ path: `${directory}/triggers.sqlite` }))],
    })
    const sessionID = Session.ID.make("ses_hot_reopen")
    yield* Effect.gen(function* () {
      const session = yield* insertSession(sessionID)
      const kv = yield* KV.Service
      const ctx = { ...fullContext({ directory: "/project", session: { get: () => Effect.succeed(session) } }), storage: PluginHost.storage(kv, "opencode.plus") }
      expect(yield* setCompactionTriggers(ctx, { sessionID, input: 500, output: 250 })).toEqual({ sessionID, input: 500, output: 250 })
    }).pipe(Effect.provide(Layer.fresh(fresh)), Effect.scoped)
    // The first layer's SQLite connection and plugin context have now been released.
    yield* Effect.gen(function* () {
      const kv = yield* KV.Service
      const store = yield* SessionStore.Service
      expect(yield* store.get(sessionID)).toBeDefined()
      const reopened = { ...fullContext({ directory: "/project" }), storage: PluginHost.storage(kv, "opencode.plus") }
      expect(yield* getCompactionTriggers(reopened, sessionID)).toEqual({ sessionID, input: 500, output: 250 })
      expect(yield* getCompactionTriggers(reopened, "ses_other_reopen")).toEqual({ sessionID: "ses_other_reopen" })
    }).pipe(Effect.provide(Layer.fresh(fresh)), Effect.scoped)
  }),
)

it.effect("inherited model thresholds drive production compaction, update live, and yield to chat overrides", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_inherited_triggers"))
    const ctx = { ...fullContext({ directory: "/project", session: { get: () => Effect.succeed(session) } }), storage: PluginHost.storage(kv, "opencode.plus") }
    const state = createState()
    const history = [SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text: "Synthetic history", time: { created: DateTime.makeUnsafe(0) } })]
    const context = loaded(session, history)
    const estimate = SessionCompaction.estimateContext(context)
    const settings = { type: "modelSettings" as const, level: "defaults" as const, updated: "2026-10-11" }
    state.cachedModelSettings = [{ ...settings, compactionInput: String(estimate) }]
    yield* hooks.register("session", "compaction.decide", (event) => decideCompactionFor(ctx, state, event))
    requests = []
    // An explicit chat threshold postpones the early trigger, not the safety threshold.
    yield* setCompactionTriggers(ctx, { sessionID: session.id, input: estimate + 1 })
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "skipped" })
    yield* setCompactionTriggers(ctx, { sessionID: session.id, input: null })
    // The specific model can suppress Every model, and another model cannot affect this one.
    state.cachedModelSettings = [...state.cachedModelSettings, { ...settings, providerID: context.model.ref.providerID, modelID: context.model.ref.id, compactionInput: "off" }]
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "skipped" })
    state.cachedModelSettings = [{ ...settings, providerID: "other", modelID: "other", compactionInput: "1" }]
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "skipped" })
    // Updating the same live state is observed without changing the session or history.
    state.cachedModelSettings = [{ ...settings, providerID: context.model.ref.providerID, modelID: context.model.ref.id, compactionInput: String(estimate) }]
    yield* compaction.transform((editor) => editor.configure({ auto: false }))
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "skipped" })
    expect(requests).toHaveLength(0)
    yield* compaction.transform((editor) => editor.configure({ auto: true }))
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    const store = yield* SessionStore.Service
    const checkpoints = yield* store.messages({ sessionID: session.id, order: "asc", type: "compaction" })
    expect(checkpoints.at(-1)).toMatchObject({ type: "compaction", status: "completed" })
    expect(yield* compaction.compact({ reason: "auto", context: loaded(session, [...history, ...checkpoints]) })).toEqual({ status: "skipped" })
  }),
)

it.effect("output triggers count primary output including reasoning, reset only on completed compaction, and respect auto:false", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_hot_output"))
    const store = yield* SessionStore.Service
    const ctx = { ...fullContext({ directory: "/project", session: { get: () => Effect.succeed(session) } }), storage: PluginHost.storage(kv, "opencode.plus") }
    const state = createState()
    yield* hooks.register("session", "compaction.decide", (event) => decideCompactionFor(ctx, state, event))
    const assistant = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: "msg_hot_output", type: "assistant", agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" }, content: [{ type: "text", text: "Primary output" }],
      tokens: { input: 100, output: 10, reasoning: 20, cache: { read: 0, write: 0 } }, time: { created: 0, completed: 1 },
    })
    const failed = Schema.decodeUnknownSync(SessionMessage.CompactionFailed)({
      id: "msg_failed_summary", type: "compaction", status: "failed", reason: "auto", error: { type: "compaction.unavailable", message: "failed" },
      tokens: { input: 100, output: 1000, reasoning: 1000, cache: { read: 0, write: 0 } }, time: { created: 0 },
    })
    const context = loaded(session, [assistant, failed])
    expect(SessionCompaction.thresholdMetrics(context)).toMatchObject({ output: 30, advanced: true })
    const second = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      ...Schema.encodeSync(SessionMessage.Assistant)(assistant), id: "msg_hot_second",
      tokens: { input: 200, output: 6, reasoning: 9, cache: { read: 0, write: 0 } },
    })
    expect(SessionCompaction.thresholdMetrics(loaded(session, [assistant, failed, second]))).toMatchObject({ output: 45, advanced: true })
    yield* setCompactionTriggers(ctx, { sessionID: session.id, output: 31 })
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "skipped" })
    yield* setCompactionTriggers(ctx, { sessionID: session.id, output: 30 })
    yield* compaction.transform((editor) => editor.configure({ auto: false }))
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "skipped" })
    expect(yield* compaction.compact({ reason: "overflow", context })).toEqual({ status: "skipped" })
    // Manual admission is still the same production path even while automatic compaction is off.
    expect(yield* compactContext(context)).toEqual({ status: "completed" })
    yield* compaction.transform((editor) => editor.configure({ auto: true }))
    expect(yield* compaction.compact({ reason: "auto", context })).toEqual({ status: "completed" })
    const checkpoints = yield* store.messages({ sessionID: session.id, order: "asc", type: "compaction" })
    expect(SessionCompaction.thresholdMetrics(loaded(session, [...context.messages, ...checkpoints]))).toMatchObject({ output: 0, advanced: false })
  }),
)

it.effect("compaction describes tool media without embedding base64", () =>
  Effect.gen(function* () {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
    const recent = yield* recentWithToolOutput(Session.ID.make("ses_tool_media"), [
      { type: "text", text: "Image read successfully" },
      {
        type: "file",
        uri: `data:image/png;base64,${base64}`,
        mime: "image/png",
        name: "pixel.png",
      },
    ])

    expect(recent).toContain("[Tool result]: Image read successfully\n[Attached image/png: pixel.png]")
    expect(recent).not.toContain(base64)
  }),
)

it.effect("compaction truncation does not split surrogate pairs", () =>
  Effect.gen(function* () {
    const prefix = "a".repeat(1_249)
    const split = yield* recentWithToolOutput(Session.ID.make("ses_truncate_split"), [
      { type: "text", text: `${prefix}😀suffix` },
    ])
    const whole = yield* recentWithToolOutput(Session.ID.make("ses_truncate_whole"), [
      { type: "text", text: "😀".repeat(1_250) },
    ])

    expect(split).toEndWith(`[Tool result]: ${prefix}😀\n[truncated]`)
    expect(whole).toEndWith(`[Tool result]: ${"😀".repeat(1_250)}`)
  }),
)

test("compaction prompt requires the checkpoint headings in order", () => {
  const prompt = SessionCompaction.buildPrompt(false)
  expect(prompt.match(/^#{2,3} .+$/gm)).toEqual([
    "## Objective",
    "## Requirements",
    "## Decisions",
    "## Work State",
    "### Completed",
    "### Active",
    "### Blocked",
    "## Next Move",
    "## Relevant Files",
    "## Important Context",
  ])
})

test("compaction update prompt rewrites legacy checkpoints only when asked", () => {
  const rewrite = "The existing checkpoint was written with an earlier format"
  expect(SessionCompaction.buildPrompt(true, true)).toContain(rewrite)
  expect(SessionCompaction.buildPrompt(true)).not.toContain(rewrite)
  expect(SessionCompaction.buildPrompt(false, true)).not.toContain(rewrite)
})

test("compaction prompts prohibit task execution", () => {
  for (const update of [false, true])
    expect(SessionCompaction.buildPrompt(update)).toContain("Do not continue the task or call tools")
})

it.effect("auto compaction estimates current content against the buffered prompt ceiling", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_input_limit"))
    const input = (tokens: number, limit: { context: number; input?: number; output: number }) => ({
      session,
      model: SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
        cost: [],
        limit,
      }),
      messages: [
        Schema.decodeUnknownSync(SessionMessage.Assistant)({
          id: SessionMessage.ID.make("msg_assistant"),
          type: "assistant",
          agent: Agent.defaultID,
          model: { id: "summary-model", providerID: "test" },
          content: [{ type: "text", text: "Done" }],
          tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, completed: 0 },
        }),
],
      agent: {
        id: Agent.defaultID,
        info: { ...Agent.Info.default(Agent.defaultID), system: "You are a helpful assistant." },
      },
      initial: ["Project instructions."],
      tools: {
        definitions: [
          ToolDefinition.make({ name: "read", description: "Read files", inputSchema: { type: "object" } }),
        ],
        execute: () => Effect.die("unused"),
      },
    })
    // An automatic compaction that is not due is skipped.
    const due = (context: SessionContext.Loaded) =>
      compaction.compact({ reason: "auto", context }).pipe(Effect.map((outcome) => outcome.status !== "skipped"))

    // 90% of the input limit, which takes precedence over the context window.
    const inputLimited = { context: 400_000, input: 272_000, output: 128_000 }
    expect(yield* due(input(244_799, inputLimited))).toBe(false)
    expect(yield* due(input(244_800, inputLimited))).toBe(true)
    const native = (tokens: number, limit: { context: number; input?: number; output: number } = inputLimited) => {
      const selected = input(tokens, limit)
      return { ...selected, model: { ...selected.model, compaction: { type: "native" as const } } }
    }
expect(yield* due(native(244_799))).toBe(false)
    expect(yield* due(native(244_800))).toBe(true)
    expect(yield* due(native(1_000_000, { context: 0, input: undefined, output: 0 }))).toBe(false)

    // The summary's 16k output limit is more than 10% of a 100k window, so it sets the ceiling.
    const contextLimited = { context: 100_000, output: 10_000 }
    expect(yield* due(input(83_999, contextLimited))).toBe(false)
    expect(yield* due(input(84_000, contextLimited))).toBe(true)

    // The reply limit does not lower the ceiling.
    const outputLimited = { context: 100_000, output: 30_000 }
    expect(yield* due(input(83_999, outputLimited))).toBe(false)
    expect(yield* due(input(84_000, outputLimited))).toBe(true)

    const assistant = input(89_000, contextLimited).messages[0]
    const tool = SessionMessage.AssistantTool.make({
      type: "tool",
      id: "call_read",
      name: "read",
      state: { status: "completed", input: {}, content: [{ type: "text", text: "x".repeat(4_000) }] },
      time: { created: DateTime.makeUnsafe(0) },
    })
    const grown = { ...input(89_000, contextLimited), messages: [{ ...assistant, content: [tool] }] }
    expect(SessionCompaction.estimateContext(grown)).toBe(90_000)
    expect(yield* due(grown)).toBe(true)

    const interrupted = { ...assistant, id: SessionMessage.ID.create(), tokens: undefined }
    expect(SessionCompaction.estimateContext({ ...grown, messages: [...grown.messages, interrupted] })).toBe(90_001)
    // Without provider usage, include 20 tokens for the system prompt, instructions, and tool definition.
    expect(SessionCompaction.estimateContext({ ...grown, messages: [interrupted] })).toBe(21)
    // Another provider's usage is not trusted either.
    const foreign = { ...assistant, model: { ...assistant.model, providerID: Provider.ID.make("other") } }
    expect(SessionCompaction.estimateContext({ ...grown, messages: [foreign] })).toBe(21)
    expect(
      SessionCompaction.estimateContext({
        ...grown,
        messages: [{ ...interrupted, tokens: input(0, contextLimited).messages[0].tokens }],
      }),
    ).toBe(21)

    const media = [
      { type: "file", mime: "image/png", uri: `data:image/png;base64,${"a".repeat(100_000)}` },
      { type: "file", mime: "application/pdf", uri: `data:application/pdf;base64,${"a".repeat(100_000)}` },
    ] as const
    const messages = [
      { ...assistant, content: [{ ...tool, state: { status: "completed" as const, input: {}, content: media } }] },
    ]
    expect(SessionCompaction.estimateContext({ ...grown, messages })).toBe(92_500)
    const user = Schema.decodeUnknownSync(SessionMessage.User)({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "",
      files: media.map((file) => ({ mime: file.mime, data: "a".repeat(100_000), source: { type: "inline" } })),
      time: { created: 0 },
    })
    expect(SessionCompaction.estimateContext({ ...grown, messages: [...messages, user] })).toBe(96_000)
    for (const [modalities, tokens, fallback] of [
      [["text", "image"], 92_040, 1_520],
      [["text", "pdf"], 93_042, 2_021],
      [["text"], 89_082, 41],
    ] as const) {
      const selected = {
        ...grown,
        model: { ...grown.model, capabilities: { ...grown.model.capabilities, input: modalities } },
      }
      expect(SessionCompaction.estimateContext({ ...selected, messages: [...messages, user] })).toBe(tokens)
      expect(SessionCompaction.estimateContext({ ...selected, messages: [user] })).toBe(fallback + 20)
    }

    const checkpoint = Schema.decodeUnknownSync(SessionMessage.CompactionCompleted)({
      id: SessionMessage.ID.create(),
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "x".repeat(400_000),
      recent: "",
      time: { created: 0, completed: 0 },
    })
    expect(yield* due({ ...grown, messages: [checkpoint] })).toBe(false)
  }),
)

/** Seeds the global project plus one session row, returning the projected session. */
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

/** Opens the compaction's message as the runner does when it delivers `/compact`, then compacts. */
const compactManually = (
  session: Session.Info,
  messages: readonly SessionMessage.Info[],
  inputID = SessionMessage.ID.create(),
) =>
  compactContext(loaded(session, messages), inputID)

const compactContext = (context: SessionContext.Loaded, inputID = SessionMessage.ID.create()) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const compaction = yield* SessionCompaction.Service
    yield* bus.publish(SessionEvent.Compaction.Started, {
      sessionID: context.session.id,
      reason: "manual",
      recent: "",
      inputID,
    })
    return yield* compaction.compact({ reason: "manual", context, inputID })
  })

/** A manual summary compaction on a context whose chat agent has this system prompt and compaction settings. */
const summarizeWith = (
  id: Session.ID,
  options: { readonly system: string; readonly compaction?: Agent.Compaction },
) =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(id)
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Summarize this conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    const context = loaded(session, messages)
    const result = yield* compactContext({
      ...context,
      agent: {
        ...context.agent,
        info: {
          ...context.agent.info,
          system: options.system,
          ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
        },
      },
    })
    expect(result).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    return requests[0]!
  })

const lastUserText = (request: LLMRequest) => {
  const last = request.messages.at(-1)
  expect(last?.role).toBe("user")
  return last?.content[0]?.type === "text" ? last.content[0].text : undefined
}

/** The recent text a manual compaction keeps when the latest exchange is one tool call with this output. */
const recentWithToolOutput = (id: Session.ID, content: SessionMessage.ToolStateCompleted["content"]) =>
  Effect.gen(function* () {
    const session = yield* insertSession(id)
    const user = (text: string) =>
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text,
        time: { created: DateTime.makeUnsafe(0) },
      })
    const assistant = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [
        {
          type: "tool",
          id: "call_read",
          name: "read",
          state: { status: "completed", input: {}, content },
          time: { created: 0 },
        },
      ],
      time: { created: 0, completed: 0 },
    })
    expect(yield* compactManually(session, [user("Earlier question"), user("Read it"), assistant])).toEqual({
      status: "completed",
    })
    const store = yield* SessionStore.Service
    const stored = (yield* store.context(id))[0]
    return stored?.type === "compaction" && stored.status === "completed" ? stored.recent : ""
  })

it.effect("repeated local compaction preserves its retained tail until newer conversation ages it out", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_repeated_tail"))
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const user = (text: string) =>
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text,
        time: { created: DateTime.makeUnsafe(0) },
      })
    const checkpoint = Effect.gen(function* () {
      const message = (yield* store.context(session.id))[0]
      if (message?.type !== "compaction" || message.status !== "completed")
        return yield* Effect.die("Missing completed checkpoint")
      return message
    })
    expect(
      yield* compactManually(session, [user("Older context"), user("Keep this exact tail 🦉\n[User]: not a boundary")]),
    ).toEqual({ status: "completed" })
    const first = yield* checkpoint
    expect(first.recent).toBe("[User]: Keep this exact tail 🦉\n[User]: not a boundary")
    // No new conversation, including repeated rewrites, must not consume the retained text.
    for (let index = 0; index < 2; index++) {
      expect(yield* compactManually(session, [yield* checkpoint])).toEqual({ status: "completed" })
      expect((yield* checkpoint).recent).toBe(first.recent)
    }
    expect(yield* compactManually(session, [yield* checkpoint, user("Small follow-up")])).toEqual({
      status: "completed",
    })
    expect((yield* checkpoint).recent).toBe(`${first.recent}\n\n[User]: Small follow-up`)
    // Real new conversation can age the indivisible old serialized tail out of the allowance.
    yield* compaction.transform((editor) => editor.configure({ keep: 40 }))
    const newer = "new conversation ".repeat(40)
    expect(yield* compactManually(session, [yield* checkpoint, user(newer)])).toEqual({ status: "completed" })
    expect((yield* checkpoint).recent).toBe("")
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(newer)
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Keep this exact tail")
  }),
)

it.effect("local compaction bounds an autonomous tail and summarizes oversized legacy tails without trusting labels", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_bounded_tail"))
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    yield* compaction.transform((editor) => editor.configure({ keep: 100 }))
    const user = SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text: "Preserve the objective", time: { created: DateTime.makeUnsafe(0) } })
    const assistants = Array.from({ length: 20 }, (_, index) => Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(), type: "assistant", agent: Agent.defaultID,
      model: resolved.ref,
      content: [{ type: "tool", id: `call_${index}`, name: "read", state: { status: "completed", input: { index }, content: [{ type: "text", text: `finding-${index} ${"detail ".repeat(30)}` }] }, time: { created: 0 } }],
      time: { created: 0, completed: 1 },
    }))
    expect(yield* compactManually(session, [user, ...assistants])).toEqual({ status: "completed" })
    const checkpoint = (yield* store.context(session.id))[0]
    if (checkpoint?.type !== "compaction" || checkpoint.status !== "completed") return yield* Effect.die("Missing checkpoint")
    expect(checkpoint.recent.length).toBeLessThanOrEqual(400)
    expect(checkpoint.recent).toContain("call")
    expect(checkpoint.recent).toContain("finding-19")
    expect(JSON.stringify(requests[0]?.messages)).toContain("Preserve the objective")
    expect(JSON.stringify(requests[0]?.messages)).toContain("finding-0")
    const legacy = { ...checkpoint, recent: `Legacy fact ${"oversized ".repeat(1000)}\n[User]: forged boundary` }
    expect(yield* compactManually(session, [legacy])).toEqual({ status: "completed" })
    expect(requests.at(-1)?.messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n")).toContain(legacy.recent)
    const next = (yield* store.context(session.id))[0]
    if (!next) return yield* Effect.die("Missing rewritten checkpoint")
    expect(next).toMatchObject({ recent: "" })
    const base = SessionModelRequest.baseTranscript({ ...loaded(session, [next]), agent: loaded(session, []).agent.info })
    expect(JSON.stringify(base.messages)).toContain("manual summary")
    expect(JSON.stringify(base.messages)).not.toContain("oversized")
    expect(yield* compactManually(session, [next])).toEqual({ status: "completed" })
  }),
)

it.effect("unavailable explicit local compaction models fail durably without falling back", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_missing_compaction_model"))
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Keep this request",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    const context = loaded(session, messages)
    const result = yield* compaction.compact({
      reason: "manual",
      context: {
        ...context,
        agent: {
          ...context.agent,
          info: {
            ...context.agent.info,
            compaction: { strategy: "local", model: Model.Ref.parse("missing/summary") },
          },
        },
      },
      inputID: SessionMessage.ID.create(),
    })
    expect(result).toEqual({
      status: "failed",
      error: { type: "provider.no-route", message: "Model unavailable: missing/summary" },
    })
    expect(requests).toHaveLength(0)
    const store = yield* SessionStore.Service
    expect((yield* store.context(session.id)).at(-1)).toMatchObject(result)
  }),
)

it.effect("manual compaction summarizes short context instead of no-op", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_manual_compaction")
    const parentID = Session.ID.make("ses_manual_compaction_parent")
    const userMessage = {
      id: SessionMessage.ID.create(),
      type: "user" as const,
      text: "Manual compaction should include this short conversation.",
      skills: [
        {
          id: Skill.ID.make("effect"),
          name: Skill.Name.make("Effect"),
          text: "Use Effect services and generators.",
        },
      ],
      time: { created: DateTime.makeUnsafe(0) },
    }
    const session = yield* insertSession(sessionID, { parent_id: parentID })
    const hooks = yield* PluginHooks.Service
    let hooked = 0
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        hooked = event.messages.length
        expect(JSON.stringify(event.messages)).not.toContain("Summarize only what")
      }),
    )
    const messages = [
      userMessage,
      SessionMessage.Shell.make({
        id: SessionMessage.ID.create(),
        type: "shell",
        shellID: Shell.ID.make("sh_background"),
        status: "exited",
        command: "pwd",
        metadata: { background: true },
        output: { output: "display-only-output", cursor: 19, size: 19, truncated: false },
        time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
      }),
      SessionMessage.Synthetic.make({
        id: SessionMessage.ID.create(),
        type: "synthetic",
        text: "User shell pwd completed: /project",
        time: { created: DateTime.makeUnsafe(2) },
      }),
    ]

    const delta = yield* bus
      .subscribe(SessionEvent.Compaction.Delta)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    expect(yield* compactManually(session, messages, SessionMessage.ID.make("msg_manual_compaction"))).toEqual({
      status: "completed",
    })
    expect(Array.from(yield* Fiber.join(delta)).map((event) => event.data.text)).toEqual([
      "## Objective\n- manual summary",
    ])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(parentID)
    expect(requests[0]?.http?.headers).toEqual({
      "x-opencode-session-id": session.id,
      "x-opencode-parent-session-id": parentID,
      "x-session-affinity": parentID,
      "X-Session-Id": parentID,
      "x-parent-session-id": parentID,
      "User-Agent": App.useragent(App.make()),
      "x-opencode-project": Project.ID.global,
      "x-opencode-session": parentID,
      "x-opencode-client": "opencode",
    })
    expect(requests[0]?.generation).toEqual(GenerationOptions.make({ maxTokens: 20_000 }))
    expect(JSON.stringify(requests[0]?.messages)).toContain("Manual compaction should include this short conversation.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("Use Effect services and generators.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("User shell pwd completed: /project")
    expect(requests[0]?.messages).toHaveLength(hooked + 1)
    expect(JSON.stringify(requests[0]?.messages.at(-1))).toContain("Summarize only what")
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("display-only-output")
    // The compaction message carries its own request usage so clients can show what compacting cost.
    expect(yield* store.context(sessionID)).toMatchObject([
      {
        type: "compaction",
        reason: "manual",
        summary: "## Objective\n- manual summary",
        recent: "",
        cost: 0.0000233,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
      },
    ])
    expect(yield* store.get(sessionID)).toMatchObject({
      cost: 0.0000233,
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
    })
    expect(
      yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { type: Bus.versionedType(SessionEvent.Compaction.Started.type, 1) },
      { type: Bus.versionedType(SessionEvent.UsageRecorded.type, 1) },
      { type: Bus.versionedType(SessionEvent.Compaction.Ended.type, 1) },
    ])
  }),
)

it.effect("compaction hooks can supply the summary instead of the model", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const hooks = yield* PluginHooks.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_hooked_compaction")
    const session = yield* insertSession(sessionID)
    const messages = [
      {
        id: SessionMessage.ID.create(),
        type: "user" as const,
        text: "Hooked compaction should see this conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      },
    ]
    let contexts = 0
    yield* hooks.register("session", "context", () => Effect.sync(() => contexts++))
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        expect(event.sessionID).toBe(sessionID)
        expect(event.agent).toBe(Agent.defaultID)
        expect(JSON.stringify(event.messages)).toContain("Hooked compaction should see this conversation.")
        event.result = { summary: "## Objective\n- hooked summary" }
      }),
    )

    expect(yield* compactManually(session, messages, SessionMessage.ID.make("msg_hooked_compaction"))).toEqual({
      status: "completed",
    })

    expect(contexts).toBe(0)
    expect(requests).toEqual([])
    expect(yield* store.context(sessionID)).toMatchObject([
      { type: "compaction", reason: "manual", summary: "## Objective\n- hooked summary", recent: "" },
    ])
    expect(
      yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { type: Bus.versionedType(SessionEvent.Compaction.Started.type, 1) },
      { type: Bus.versionedType(SessionEvent.Compaction.Ended.type, 1) },
    ])
  }),
)

it.effect("Auto falls back from a native model policy when the route cannot compact", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_native_unsupported"))
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Compact this natively.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    expect(
      yield* compaction.compact({
        reason: "manual",
        context: { ...loaded(session, messages), model: { ...resolved, compaction: { type: "native" } } },
        inputID: SessionMessage.ID.create(),
      }),
    ).toEqual({
      status: "completed",
    })
    expect(requests).toHaveLength(1)
  }),
)

it.effect("forked session compaction reuses the fork root prompt cache key", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_fork_compaction")
    const rootID = Session.ID.make("ses_fork_compaction_root")
    const session = yield* insertSession(sessionID, {
      fork_session_id: rootID,
      fork_boundary: { type: "before", messageID: SessionMessage.ID.create() },
    })
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Summarize the forked conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    expect(yield* compactManually(session, messages, SessionMessage.ID.make("msg_fork_compaction"))).toEqual({
      status: "completed",
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(rootID)
  }),
)

it.effect("same-model summary keeps the chat system prompt and moves the compaction prompt into the user message", () =>
  Effect.gen(function* () {
    const chatSystem = "You are the chat agent."
    const compactionSystem = "You write conversation checkpoints."
    const request = yield* summarizeWith(Session.ID.make("ses_compaction_same_model"), {
      system: chatSystem,
      compaction: { strategy: "local", system: compactionSystem },
    })

    expect(request.system.map((part) => part.text)[0]).toBe(chatSystem)
    // The compaction prompt is no longer the start of the cached prefix.
    expect(request.system.some((part) => part.text.includes(compactionSystem))).toBe(false)
    expect(lastUserText(request)).toBe(`${compactionSystem}\n\n${SessionCompaction.buildPrompt(false)}`)
    // The history is still serialized ahead of the prompt.
    expect(JSON.stringify(request.messages)).toContain("Summarize this conversation.")
  }),
)

it.effect("another compaction model keeps the compaction system prompt and the summary prompt alone", () =>
  Effect.gen(function* () {
    const compactionSystem = "You write conversation checkpoints."
    const request = yield* summarizeWith(Session.ID.make("ses_compaction_other_model"), {
      system: "You are the chat agent.",
      compaction: {
        strategy: "local",
        model: Model.Ref.parse("other/other-model"),
        system: compactionSystem,
      },
    })

    expect(request.system.map((part) => part.text)[0]).toBe(compactionSystem)
    expect(lastUserText(request)).toBe(SessionCompaction.buildPrompt(false))
  }),
)

it.effect("same-model summary without compaction system text sends the summary prompt alone", () =>
  Effect.gen(function* () {
    const chatSystem = "You are the chat agent."
    const request = yield* summarizeWith(Session.ID.make("ses_compaction_no_system"), {
      system: chatSystem,
      compaction: { strategy: "local" },
    })

    expect(request.system.map((part) => part.text)[0]).toBe(chatSystem)
    expect(lastUserText(request)).toBe(SessionCompaction.buildPrompt(false))
  }),
)

it.effect("a decision system replaces the agent's compaction system text", () =>
  Effect.gen(function* () {
    const chatSystem = "You are the chat agent."
    const agentSystem = "You write conversation checkpoints."
    const decisionSystem = "You write short checkpoints."
    const request = yield* summarizeWith(Session.ID.make("ses_compaction_decision_system_same"), {
      system: chatSystem,
      compaction: { strategy: "local", system: agentSystem },
    })
    // The agent's compaction system is genuinely in play for this shape.
    expect(lastUserText(request)).toBe(`${agentSystem}\n\n${SessionCompaction.buildPrompt(false)}`)

    const decided = yield* summarizeManualWithDecision(
      Session.ID.make("ses_compaction_decision_system_same_decision"),
      { system: chatSystem, compaction: { strategy: "local", system: agentSystem } },
      (event) => {
        event.system = decisionSystem
      },
    )
    expect(decided.request.system.map((part) => part.text)[0]).toBe(chatSystem)
    expect(decided.request.system.some((part) => part.text.includes(agentSystem))).toBe(false)
    expect(lastUserText(decided.request)).toBe(`${decisionSystem}\n\n${SessionCompaction.buildPrompt(false)}`)
  }),
)

it.effect("a decision system is the request system on another compaction model", () =>
  Effect.gen(function* () {
    const decisionSystem = "You write short checkpoints."
    const decided = yield* summarizeManualWithDecision(
      Session.ID.make("ses_compaction_decision_system_other"),
      {
        system: "You are the chat agent.",
        compaction: {
          strategy: "local",
          model: Model.Ref.parse("other/other-model"),
          system: "You write conversation checkpoints.",
        },
      },
      (event) => {
        event.system = decisionSystem
      },
    )
    expect(decided.request.system.map((part) => part.text)[0]).toBe(decisionSystem)
    expect(lastUserText(decided.request)).toBe(SessionCompaction.buildPrompt(false))
  }),
)

it.effect("a failed manual compaction records the model that tried it", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    const session = yield* insertSession(Session.ID.make("ses_compaction_failed_model"))
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Summarize this conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    const context = loaded(session, messages)
    const outcome = yield* compaction.compact({
      reason: "manual",
      context: {
        ...context,
        agent: {
          ...context.agent,
          info: {
            ...Agent.Info.default(Agent.defaultID),
            compaction: { strategy: "local", model: Model.Ref.parse("missing/summary") },
          },
        },
      },
      inputID: SessionMessage.ID.create(),
    })
    expect(outcome.status).toBe("failed")
    const records = yield* store.messages({ sessionID: session.id, order: "asc", type: "compaction" })
    expect(records[0]).toMatchObject({
      type: "compaction",
      status: "failed",
      model: { providerID: "missing", id: "summary" },
    })
  }),
)

/** A manual summary compaction whose decision hook can override the decision fields. */
const summarizeManualWithDecision = (
  id: Session.ID,
  options: { readonly system: string; readonly compaction?: Agent.Compaction },
  decide: (event: PluginHooks.Domains["session"]["compaction.decide"]) => void,
) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    requests = []
    const session = yield* insertSession(id)
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Summarize this conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    yield* hooks.register("session", "compaction.decide", (event) =>
      Effect.sync(() => {
        decide(event)
      }),
    )
    const context = loaded(session, messages)
    const result = yield* compactContext({
      ...context,
      agent: {
        ...context.agent,
        info: {
          ...context.agent.info,
          system: options.system,
          ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
        },
      },
    })
    expect(result).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    return { request: requests[0]! }
  })
