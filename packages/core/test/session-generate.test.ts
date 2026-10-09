import { expect } from "bun:test"
import {
  AIError,
  InvalidRequestError,
  LLMClient,
  LLMEvent,
  LLMResponse,
  LanguageModel,
  Message,
  SystemPart,
  ToolDefinition,
  type LLMRequest,
} from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import type { StreamOptions } from "@opencode/ai/route"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { EventTable } from "@opencode/core/event/sql"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Instance } from "@opencode/core/instance/service"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { ID, Ref } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionEvent } from "@opencode/core/session/event"
import { AgentNotFoundError } from "@opencode/core/session/error"
import { SessionContext } from "@opencode/core/session/context"
import { SessionGenerate } from "@opencode/core/session/generate"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import {
  InstructionBlobTable,
  InstructionStateTable,
  SessionMessageTable,
  SessionInboxTable,
  SessionTable,
} from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTitle } from "@opencode/core/session/title"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionModelObservation } from "@opencode/core/session/model-observation"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Tool } from "@opencode/core/tool"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { asc, eq } from "drizzle-orm"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"
import { createLedger } from "../../plus/src/monitor/ledger.js"
import { watchMonitor } from "../../plus/src/monitor/plugin.js"
import { context } from "../../plus/test/harness.js"

const requests: LLMRequest[] = []
const options: Array<StreamOptions | undefined> = []
const interceptors: SessionModelTransport.Interceptor[] = []
let instruction: string | Instructions.Unavailable = "Initial context"
let failGenerate: AIError | undefined
const sessionID = SessionSchema.ID.make("ses_generate_test")

const model = LanguageModel.make({ id: "generate-model", provider: "test", route: OpenAIChat.route })
const overrideModel = LanguageModel.make({ id: "override-model", provider: "test", route: OpenAIChat.route })
const client = Layer.mock(LLMClient.Service)({
  stream: () => failGenerate ? Stream.fail(failGenerate) : Stream.fromIterable([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textDelta({ id: "title", text: "A generated title" }),
    LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" }, usage: { inputTokens: 100, nonCachedInputTokens: 40, cacheReadInputTokens: 60, outputTokens: 10, provenance: { inputTokens: { source: "reported", completeness: "complete" }, cacheReadInputTokens: { source: "reported", completeness: "complete" } } } }),
    LLMEvent.finish({ reason: { normalized: "stop" } }),
  ]),
  generate: (request, requestOptions) =>
    Effect.gen(function* () {
      if (failGenerate) return yield* failGenerate
      requests.push(request)
      options.push(requestOptions)
      const response = LLMResponse.fromEvents([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "generate" }),
        LLMEvent.textDelta({ id: "generate", text: "Transient answer" }),
        LLMEvent.textEnd({ id: "generate" }),
        LLMEvent.stepFinish({
          index: 0,
          reason: { normalized: "stop" },
            usage: { inputTokens: 100, nonCachedInputTokens: 100, outputTokens: 10, provenance: { inputTokens: { source: "reported", completeness: "complete" } } },
        }),
        LLMEvent.finish({ reason: { normalized: "stop" } }),
      ])
      if (!response) throw new Error("Incomplete generate response")
      return response
    }),
})
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) =>
    Effect.succeed(
      SessionRunnerModel.resolved(session.model?.id === String(overrideModel.id) ? overrideModel : model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})
const builtins = Layer.mock(InstructionBuiltIns.Service, {
  load: () =>
    Effect.succeed(
      Instructions.make({
        key: Instructions.Key.make("test/context"),
        codec: Schema.toCodecJson(Schema.String),
        read: Effect.sync(() => instruction),
        render: {
          initial: String,
          changed: (_previous, current) => current,
        },
      }),
    ),
})
const discovery = Layer.mock(InstructionDiscovery.Service, {
  project: true,
  global: true,
  load: () => Effect.succeed(Instructions.empty),
})
const skills = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const references = Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const mcp = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const tools = Layer.mock(Tool.Service, {
  // Mirrors the real snapshot: the agent's merged permissions determine which tools exist.
  snapshot: (permissions) => {
    const plan = permissions?.some((rule) => rule.resource === "plan-only") ?? false
    return Effect.succeed({
      codeModeCatalog: {
        tools: [
          {
            type: "tool",
            name: "captured.lookup",
            description: "Captured Code Mode catalog",
            signature: "tools.captured.lookup(): Promise<string>",
          },
        ],
      },
      definitions: [
        plan
          ? ToolDefinition.make({ name: "plan-tool", description: "Plan tool", inputSchema: { type: "object" } })
          : ToolDefinition.make({ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }),
      ],
      execute: () => Effect.die(new Error("unused")),
    })
  },
  transform: () => Effect.die(new Error("unused")),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      SessionTitle.node,
      Agent.node,
      InstructionBuiltIns.node,
      SessionContext.node,
      PluginHooks.node,
      llmClient,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      SessionRunnerModel.node.replace(models),
      SessionModelTransport.node.replace(Layer.mock(SessionModelTransport.Service, {
        bind: (_sessionID, interceptor) => {
          if (interceptor) interceptors.push(interceptor)
          return { execute: () => Effect.die("unused WebSocket exchange") }
        },
      })),
      InstructionBuiltIns.node.replace(builtins),
      InstructionDiscovery.node.replace(discovery),
      SkillInstructions.node.replace(skills),
      ReferenceInstructions.node.replace(references),
      McpInstructions.node.replace(mcp),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(tools),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const durableState = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  Effect.all({
    sequence: Bus.latestSequence(db, sessionID),
    bus: db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie),
    messages: db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie),
    pending: db
      .select()
      .from(SessionInboxTable)
      .where(eq(SessionInboxTable.session_id, sessionID))
      .orderBy(asc(SessionInboxTable.enqueued_seq))
      .all()
      .pipe(Effect.orDie),
    instructions: db
      .select()
      .from(InstructionStateTable)
      .where(eq(InstructionStateTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie),
    blobs: db.select().from(InstructionBlobTable).orderBy(asc(InstructionBlobTable.hash)).all().pipe(Effect.orDie),
    session: db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
  })

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const agents = yield* Agent.Service
  const projects = yield* Project.Service
  const instructionBuiltIns = yield* InstructionBuiltIns.Service
  const context = yield* SessionContext.Service
  const store = yield* SessionStore.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
    editor.update(Agent.ID.make("plan"), (agent) => {
      agent.mode = "primary"
      agent.system = "Plan system prompt"
      // A distinct permission proves the pinned agent's whole selection drives tools and instructions.
      agent.permissions = [{ action: "read", resource: "plan-only", effect: "allow" }]
    })
  })
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
      slug: "generate-test",
      directory: "/project",
      title: "Generate test",
      version: "test",
      agent: Agent.ID.make("build"),
    })
    .run()
    .pipe(Effect.orDie)
  const session = yield* store.get(sessionID)
  if (!session) return yield* Effect.die("Session fixture missing")
  return {
    db,
    bus,
    session,
    instructions: yield* instructionBuiltIns.load(sessionID),
    instances: Instance.Service.of({
      // Generation only exercises the Location's model context.
      provide: () =>
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SessionContext.Service, context),
            Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
          ) as Layer.Layer<Instance.Services>,
        ),
    }),
  }
})

it.effect(
  "generates from fresh settled Session context without durable mutation",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      options.length = 0
      instruction = "Initial context"
      const { db, bus, instructions, session, instances } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, sessionID)
      const existing = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: existing,
        item: { type: "user", payload: { text: "Existing durable context" }, delivery: "steer" },
      })
      yield* bus.publish(SessionEvent.InboxDelivered, {
        sessionID,
        inboxID: existing,
      })
      const settledAssistant = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: settledAssistant,
        agent: Agent.ID.make("build"),
        model: { id: ID.make("generate-model"), providerID: Provider.ID.make("test") },
        started: 0,
      })
      yield* bus.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: settledAssistant,
        ordinal: 0,
      })
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID: settledAssistant,
        ordinal: 0,
        text: "Settled partial answer",
      })
      const activeAssistant = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: activeAssistant,
        agent: Agent.ID.make("build"),
        model: { id: ID.make("generate-model"), providerID: Provider.ID.make("test") },
        started: 0,
      })
      yield* bus.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID: activeAssistant,
        id: "active-call",
        name: "echo",
      })
      yield* bus.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID: activeAssistant,
        id: "active-call",
        text: "{}",
      })
      yield* bus.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID: activeAssistant,
        id: "active-call",
        input: {},
        executed: false,
      })
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: SessionMessage.ID.create(),
        item: { type: "user", payload: { text: "Queued input must remain invisible" }, delivery: "queue" },
      })
      instruction = "Changed context"
      const before = yield* durableState(db, sessionID)

      const result = yield* SessionGenerate.generate({ session, prompt: "Summarize privately" }).pipe(
        Effect.provideService(Instance.Service, instances),
      )

      expect(result).toBe("Transient answer")
      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.system.map((part) => part.text)).toContain("Initial context")
      expect(requests[0]?.http?.headers).toMatchObject({ "X-Session-Id": sessionID })
      expect(requests[0]?.promptCacheKey).toBe(sessionID)
      const instructionUpdates = requests[0]?.messages.flatMap((message) =>
        message.role === "system"
          ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
          : [],
      )
      expect(instructionUpdates).toHaveLength(1)
      expect(instructionUpdates?.[0]).toContain("Changed context")
      expect(instructionUpdates?.[0]).toContain("tools.captured.lookup(): Promise<string>")
      expect(userTexts(requests[0])).toEqual(["Existing durable context", "Summarize privately"])
      expect(
        requests[0]?.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
            : [],
        ),
      ).toEqual(["Settled partial answer"])
      expect(requests[0]?.tools).toMatchObject([{ name: "lookup", description: "Lookup" }])
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(options[0]?.webSocket).toBeUndefined()
      expect(yield* durableState(db, sessionID)).toEqual(before)
    }),
  { timeout: 15_000 },
)

it.effect(
  "runs primary context hooks before appending the private prompt",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      instruction = "Initial context"
      const { db, bus, instructions, session, instances } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, sessionID)
      const hooks = yield* PluginHooks.Service
      let generates = 0
      yield* hooks.register("session", "generate", () => Effect.sync(() => generates++))
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          expect(event.sessionID).toBe(sessionID)
          expect(event.agent).toBe(Agent.ID.make("build"))
          expect(Object.keys(event.tools)).toEqual(["lookup"])
          event.system.push(SystemPart.make("Answer briefly."))
          event.messages = [Message.user("[redacted]")]
          event.options.maxTokens = 32
          event.options.reasoningEffort = "low"
        }),
      )

      yield* SessionGenerate.generate({ session, prompt: "Summarize privately" }).pipe(
        Effect.provideService(Instance.Service, instances),
      )

      expect(generates).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.system.map((part) => part.text)).toContain("Answer briefly.")
      expect(userTexts(requests[0])).toEqual(["[redacted]", "Summarize privately"])
      expect(requests[0]?.generation).toEqual(expect.objectContaining({ maxTokens: 32 }))
      expect(requests[0]?.providerOptions).toEqual({ reasoningEffort: "low" })
    }),
  { timeout: 15_000 },
)

it.effect(
  "pins the request to an overridden agent and model",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      options.length = 0
      instruction = "Initial context"
      const { db, bus, instructions, session, instances } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, sessionID)
      const hooks = yield* PluginHooks.Service
      const seen: Array<{ readonly agent: Agent.ID; readonly model: string }> = []
      yield* hooks.register("session", "model.request", (event) =>
        Effect.sync(() => seen.push({ agent: event.agent, model: event.model.id })),
      )
      const pinned = Ref.make({ providerID: Provider.ID.make("test"), id: ID.make("override-model") })

      const result = yield* SessionGenerate.generate({
        session,
        prompt: "Pinned private summary",
        agent: Agent.ID.make("plan"),
        model: pinned,
      }).pipe(Effect.provideService(Instance.Service, instances))

      expect(result).toBe("Transient answer")
      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(overrideModel)
      expect(requests[0]?.system.map((part) => part.text)).toContain("Plan system prompt")
      // The pinned agent's permissions shape the tool snapshot, not the stored agent's.
      expect(requests[0]?.tools).toMatchObject([{ name: "plan-tool" }])
      expect(seen).toEqual([{ agent: Agent.ID.make("plan"), model: ID.make("override-model") }])

      // Control: without overrides the request follows the stored Session selection.
      requests.length = 0
      seen.length = 0
      yield* SessionGenerate.generate({ session, prompt: "Stored" }).pipe(
        Effect.provideService(Instance.Service, instances),
      )
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools).toMatchObject([{ name: "lookup" }])
      expect(seen).toEqual([{ agent: Agent.ID.make("build"), model: ID.make("generate-model") }])
    }),
  { timeout: 15_000 },
)

it.effect(
  "keeps a pinned request working when the stored Session agent is missing",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      instruction = "Initial context"
      const { db, bus, instructions, session, instances } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, sessionID)
      yield* bus.publish(SessionEvent.AgentSelected, {
        sessionID,
        agent: Agent.ID.make("ghost"),
        previous: session.agent,
      })

      const result = yield* SessionGenerate.generate({
        session,
        prompt: "Pinned despite missing stored agent",
        agent: Agent.ID.make("plan"),
      }).pipe(Effect.provideService(Instance.Service, instances))

      expect(result).toBe("Transient answer")
      expect(requests[0]?.system.map((part) => part.text)).toContain("Plan system prompt")
      expect(requests[0]?.tools).toMatchObject([{ name: "plan-tool" }])

      // Control: without an override the missing stored agent still fails.
      requests.length = 0
      const error = yield* SessionGenerate.generate({ session, prompt: "Stored" }).pipe(
        Effect.provideService(Instance.Service, instances),
        Effect.flip,
      )
      expect(error).toBeInstanceOf(AgentNotFoundError)
      expect(requests).toEqual([])
    }),
  { timeout: 15_000 },
)

it.effect(
  "blocks unavailable initial instructions before generation",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      instruction = Instructions.unavailable
      const { db, session, instances } = yield* setup
      const before = yield* durableState(db, sessionID)

      const error = yield* SessionGenerate.generate({ session, prompt: "Summarize privately" }).pipe(
        Effect.provideService(Instance.Service, instances),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(Instructions.InitializationBlocked)
      expect(requests).toEqual([])
      expect(yield* durableState(db, sessionID)).toEqual(before)
    }),
  { timeout: 15_000 },
)

it.effect(
  "fires the generated session hook once with usage, and once with error on a failing LLM call",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      options.length = 0
      failGenerate = undefined
      instruction = "Initial context"
      const { db, bus, instructions, session, instances } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, sessionID)
      const hooks = yield* PluginHooks.Service

      const events: Array<SessionHooks["generated"]> = []
      const observed: SessionHooks["model.observed"][] = []
      yield* hooks.register("session", "model.observed", (event) => Effect.sync(() => { observed.push(event) }))
      const ledger = yield* Effect.acquireRelease(Effect.sync(() => createLedger(":memory:")), (ledger) => Effect.sync(() => ledger.close()))
      yield* watchMonitor(context({ session: { hook: (name, callback, options) => hooks.register("session", name, callback, options) } }), () => undefined, () => ledger)
      yield* hooks.register("session", "generated", (event) =>
        Effect.sync(() => {
          events.push({ ...event })
        }),
      )

      // 1. Success case: fires generated hook with usage
      const result = yield* SessionGenerate.generate({ session, prompt: "Ping prompt" }).pipe(
        Effect.provideService(SessionModelObservation.Purpose, "warming"),
        Effect.provideService(Instance.Service, instances),
      )
      expect(result).toBe("Transient answer")
      expect(events).toHaveLength(1)
      expect(observed).toHaveLength(1)
      expect(observed[0]).toMatchObject({ kind: "generate", purpose: "warming", usage: { inputTokens: 100, completeness: "final" } })
      expect(ledger.getRequests(sessionID)).toHaveLength(1)
      expect(ledger.getRequests(sessionID)[0]?.kind).toBe("ping")
      expect(events[0]?.sessionID).toBe(sessionID)
      expect(events[0]?.agent).toBe(Agent.ID.make("build"))
      expect(events[0]?.model).toEqual(
        Ref.make({
          id: ID.make("generate-model"),
          providerID: Provider.ID.make("test"),
        }),
      )
      expect(events[0]?.usage).toEqual({
        input: 100,
        output: 10,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })
      expect(events[0]?.error).toBeUndefined()
      expect(events[0]?.kind).toBe("generate")
      expect(events[0]?.ended).toBeGreaterThanOrEqual(events[0]!.started!)

      // 2. Failing case: fires generated hook with error
      failGenerate = new AIError({
        reason: new InvalidRequestError({ message: "LLM failure" }),
      })
      const error = yield* SessionGenerate.generate({ session, prompt: "Ping prompt fail" }).pipe(
        Effect.provideService(Instance.Service, instances),
        Effect.flip,
      )
      expect(error).toEqual(failGenerate)
      expect(events).toHaveLength(2)
      expect(observed).toHaveLength(2)
      expect(observed[1]).toMatchObject({ outcome: "failed", usage: { completeness: "unavailable" } })
      expect(ledger.getRequests(sessionID)).toHaveLength(2)
      expect(events[1]?.sessionID).toBe(sessionID)
      expect(events[1]?.agent).toBe(Agent.ID.make("build"))
      expect(events[1]?.model).toEqual(
        Ref.make({
          id: ID.make("generate-model"),
          providerID: Provider.ID.make("test"),
        }),
      )
      expect(events[1]?.error).toBe("LLM failure")
      expect(events[1]?.usage).toBeUndefined()
    }),
  { timeout: 15_000 },
)

it.effect("title generation reports usage and failure through generated with kind title", () => Effect.gen(function* () {
  failGenerate = undefined
  const fixture = yield* setup
  const hooks = yield* PluginHooks.Service
  const title = yield* SessionTitle.Service
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => editor.update(Agent.ID.make("title"), (agent) => { agent.mode = "primary" }))
  const events: SessionHooks["generated"][] = []
  const observed: SessionHooks["model.observed"][] = []
  yield* hooks.register("session", "model.observed", (event) => Effect.sync(() => { observed.push(event) }))
  yield* hooks.register("session", "generated", (event) => Effect.sync(() => { events.push(event) }))
  const id = SessionMessage.ID.create()
  yield* fixture.bus.publish(SessionEvent.InboxEnqueued, { sessionID, inboxID: id, item: { type: "user", payload: { text: "Please name this session" }, delivery: "steer" } })
  yield* fixture.bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
  yield* title.generate(sessionID)
  expect(events).toHaveLength(1)
  expect(observed).toHaveLength(1)
  expect(observed[0]).toMatchObject({ kind: "title", outcome: "completed", usage: { inputTokens: 100, cacheReadInputTokens: 60, completeness: "final" } })
  expect(events[0]).toMatchObject({ kind: "title", sessionID, usage: { input: 40, output: 10, cache: { read: 60, write: 0 } }, cost: 0 })
  expect(events[0]?.ended).toBeGreaterThanOrEqual(events[0]!.started!)
  failGenerate = new AIError({ reason: new InvalidRequestError({ message: "private title failure" }) })
  yield* title.generate(sessionID)
  expect(events).toHaveLength(2)
  expect(observed).toHaveLength(2)
  expect(observed[1]).toMatchObject({ kind: "title", outcome: "failed", usage: { completeness: "unavailable" } })
  expect(events[1]).toMatchObject({ kind: "title", error: "private title failure" })
  failGenerate = undefined
}), { timeout: 15_000 })

it.effect("HTTP wire observers run after later plugin transforms and see exactly the transport body", () => Effect.gen(function* () {
  failGenerate = undefined
  options.length = 0
  const fixture = yield* setup
  yield* InstructionState.prepare(fixture.db, fixture.bus, fixture.instructions, sessionID)
  const hooks = yield* PluginHooks.Service
  const observed: string[] = []
  const transported: string[] = []
  yield* hooks.register("session", "http.request", (event) => Effect.sync(() => {
    expect(event.requestID).toBeString()
    expect(event.started).toBeNumber()
    event.observers = [(request) => Effect.promise(async () => { observed.push(await request.clone().text()) })]
  }))
  yield* hooks.register("session", "http.request", (event) => Effect.sync(() => {
    event.request = new Request(event.request.url, { method: "POST", body: '{"messages":[],"tool_choice":"none"}' })
  }))
  yield* SessionGenerate.generate({ session: fixture.session, prompt: "ping" }).pipe(Effect.provideService(Instance.Service, fixture.instances))
  const middleware = options[0]?.http
  if (!middleware) return yield* Effect.die("Missing HTTP middleware")
  yield* middleware(HttpClientRequest.post("https://example.test/chat/completions").pipe(HttpClientRequest.bodyText('{"messages":[]}')), (sent) => Effect.gen(function* () {
    const web = yield* HttpClientRequest.toWeb(sent)
    transported.push(yield* Effect.promise(() => web.text()))
    return HttpClientResponse.fromWeb(sent, new Response("{}"))
  }))
  expect(observed).toEqual(['{"messages":[],"tool_choice":"none"}'])
  expect(transported).toEqual(observed)
}), { timeout: 15_000 })

it.effect("labels the generate transport as generate while the primary content hook still runs", () =>
  Effect.gen(function* () {
    failGenerate = undefined
    requests.length = 0
    options.length = 0
    instruction = "Initial context"
    const fixture = yield* setup
    yield* InstructionState.prepare(fixture.db, fixture.bus, fixture.instructions, sessionID)
    const hooks = yield* PluginHooks.Service
    let contexts = 0
    let generates = 0
    const transportKinds: Array<{ hook: string; kind: string }> = []
    yield* hooks.register("session", "context", (event) =>
      Effect.sync(() => {
        contexts++
        // The content hook that shapes the cache prefix is the primary one, non-durable.
        expect(event.durable).toBe(false)
      }),
    )
    yield* hooks.register("session", "generate", () => Effect.sync(() => void generates++))
    yield* hooks.register("session", "model.request", (event) =>
      Effect.sync(() => void transportKinds.push({ hook: "model.request", kind: event.kind })),
    )
    yield* hooks.register("session", "http.request", (event) =>
      Effect.sync(() => void transportKinds.push({ hook: "http.request", kind: event.kind })),
    )

    yield* SessionGenerate.generate({ session: fixture.session, prompt: "ping" }).pipe(
      Effect.provideService(Instance.Service, fixture.instances),
    )

    // The mocked client never sends; run the middleware the way transport would.
    const middleware = options[0]?.http
    if (!middleware) return yield* Effect.die("Missing HTTP middleware")
    yield* middleware(
      HttpClientRequest.post("https://example.test/chat/completions").pipe(
        HttpClientRequest.bodyText('{"messages":[]}'),
      ),
      (sent) => Effect.succeed(HttpClientResponse.fromWeb(sent, new Response("{}"))),
    )

    // Primary content transform ran; the auxiliary generate content hook did not.
    expect(contexts).toBe(1)
    expect(generates).toBe(0)
    // Both transport hook families identify the auxiliary wire request as generate.
    expect(transportKinds).toEqual([
      { hook: "model.request", kind: "generate" },
      { hook: "http.request", kind: "generate" },
    ])
  }),
  { timeout: 15_000 },
)

it.effect("WebSocket wire observers run after later plugin transforms before transport", () => Effect.gen(function* () {
  interceptors.length = 0
  const fixture = yield* setup
  const context = yield* SessionContext.Service
  const hooks = yield* PluginHooks.Service
  const observed: string[] = []
  yield* hooks.register("session", "experimental.ws.send", (event) => Effect.sync(() => {
    expect(event.requestID).toBeString()
    event.observers = [(frame) => Effect.sync(() => { observed.push(frame) })]
  }))
  yield* hooks.register("session", "experimental.ws.send", (event) => Effect.sync(() => {
    event.frame = '{"type":"response.create","input":[],"tool_choice":"none"}'
  }))
  yield* context.request.primary({
    session: fixture.session, agent: Agent.ID.make("build"), system: [], messages: [], webSocket: "session",
    model: SessionRunnerModel.resolved(model, { transport: "websocket", capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200_000, output: 32_000 } }),
  })
  const send = interceptors[0]?.send
  if (!send) return yield* Effect.die("Missing WebSocket send interceptor")
  const sent = yield* send('{"input":[]}')
  expect(observed).toEqual([sent])
  expect(sent).toBe('{"type":"response.create","input":[],"tool_choice":"none"}')
}), { timeout: 15_000 })
