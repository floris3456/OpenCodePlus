import { expect, test } from "bun:test"
import { LLMClient, LanguageModel, Message, ToolDefinition } from "@opencode/ai"
import { Anthropic, AnthropicCompatible, OpenAI } from "@opencode/ai/providers"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Instructions } from "@opencode/core/instructions/index"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionInbox } from "@opencode/core/session/inbox"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionProviderContext } from "@opencode/core/session/provider-context"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { Model } from "@opencode/core/model"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Cause, Context, DateTime, Deferred, Effect, Fiber, Layer, Logger, Schema, Scope } from "effect"
import { testEffect } from "./lib/effect"
import { registerQuota } from "../../cliproxyapi/src/quota/register.js"
import { context } from "../../plus/test/harness.js"
import type { SessionModelObserved } from "@opencode/plugin/effect/session"
import { createLedger } from "../../plus/src/monitor/ledger.js"
import { watchMonitor } from "../../plus/src/monitor/plugin.js"
import { decideCompaction } from "../../plus/src/compaction/decide.js"
import { decideCompactionTriggers } from "../../plus/src/compaction/triggers.js"

const agents = Layer.mock(Agent.Service, { get: () => Effect.succeed(undefined) })
class NativeModels extends Context.Service<NativeModels, Map<string, SessionRunnerModel.Resolved>>()(
  "test/NativeModels",
) {}
const fixtureModels = Layer.sync(NativeModels, () => new Map())
const models = Layer.effect(
  SessionRunnerModel.Service,
  Effect.gen(function* () {
    const available = yield* NativeModels
    return SessionRunnerModel.Service.of({
      resolve: (session) => {
        if (!session.model) return Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id }))
        const model = available.get(`${session.model.providerID}/${session.model.id}`)
        return model
          ? Effect.succeed(model)
          : Effect.fail(
              new SessionRunnerModel.ModelUnavailableError({
                providerID: session.model.providerID,
                modelID: session.model.id,
              }),
            )
      },
    })
  }),
).pipe(Layer.provide(fixtureModels))
const catalog = Layer.mock(Model.Service, { available: () => Effect.succeed([]) })
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionInbox.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
      llmClient,
    ]),
    {
      replacements: [
        Bus.node.replace(Bus.configured({ persist: true })),
        Agent.node.replace(agents),
        Model.node.replace(catalog),
        SessionRunnerModel.node.replace(models),
      ],
    },
  ).pipe(Layer.provideMerge(fixtureModels)),
)

const setup = Effect.fnUntraced(function* (options: {
  endpoint?: boolean
  config?: Agent.Compaction
  policy?: boolean
  anthropic?: "direct" | "compatible"
  quota?: boolean
} = {}) {
  const endpoint = options.endpoint ?? false
  const db = (yield* Database.Service).db
  const bus = yield* Bus.Service
  const inbox = yield* SessionInbox.Service
  const store = yield* SessionStore.Service
  const compaction = yield* SessionCompaction.Service
  const requests = yield* SessionModelRequest.Service
  const hooks = yield* PluginHooks.Service
  const observations: SessionModelObserved[] = []
  yield* hooks.register("session", "model.observed", (event) => Effect.sync(() => { observations.push(event) }))
  const blocked = Deferred.makeUnsafe<void>()
  const hanging = Promise.withResolvers<Response>()
  const state = {
    failure: false,
    flaky: false,
    hang: false,
    overflow: false,
    unusable: false,
    notTriggered: false,
    summary: false,
    echo: false,
    pending: new Set<string>(),
    calls: 0,
    config: options.config,
  }
  const bodies: Record<string, unknown>[] = []
  const headers: Headers[] = []
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (options.quota && request.method === "GET")
            return Response.json({
              protocol: 1,
              primary_used: true,
              consumed: "",
              cursor: 0,
              generation: 1,
              alias: "Fixture",
              intent: state.pending.has(new URL(request.url).searchParams.get("model") ?? "") ? "pending-handoff" : "",
              available: true,
              windows: [],
              events: [],
            })
          state.calls++
          headers.push(request.headers)
          bodies.push(
            Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
              await request.text(),
            ),
          )
          if (state.hang) {
            Deferred.doneUnsafe(blocked, Effect.void)
            return hanging.promise
          }
          // Persistent failures opt out of retries so the schedule's backoff stays out of these tests.
          if (state.failure || state.flaky) {
            const retry = state.flaky
            state.flaky = false
            return Response.json(
              { error: { message: "fixture rate limit", type: "rate_limit_error" } },
              { status: 429, headers: retry ? {} : { "x-should-retry": "false" } },
            )
          }
          if (options.anthropic) {
            const native = bodies.at(-1)?.context_management !== undefined
            // A not-triggered request is a native attempt that Anthropic answered normally, so it returns
            // ordinary text even though the body carried the compaction trigger.
            const compacting = native && !state.notTriggered
            const events = [
              { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } },
              { type: "content_block_start", index: 0, content_block: compacting ? { type: "compaction", content: null } : { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: compacting ? { type: "compaction_delta", content: state.unusable ? null : "Native summary" } : { type: "text_delta", text: "## Objective\n- Local summary" } },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: compacting ? "compaction" : "end_turn" },
                // A completed-but-unusable compaction reports iteration usage the failed record must keep.
                usage: compacting
                  ? {
                      input_tokens: 0,
                      output_tokens: 0,
                      iterations: [
                        {
                          type: "compaction",
                          input_tokens: state.unusable ? 51000 : 55000,
                          output_tokens: 400,
                          ...(state.unusable ? { cache_read_input_tokens: 2000 } : {}),
                        },
                      ],
                    }
                  : { input_tokens: 200, output_tokens: 40 },
              },
              { type: "message_stop" },
            ]
            return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
              headers: { "content-type": "text/event-stream" },
            })
          }
          const trigger = JSON.stringify(bodies.at(-1)).includes("compaction_trigger")
          if (state.overflow && trigger)
            return Response.json(
              {
                error: {
                  message: "Your input exceeds the context window",
                  code: "context_length_exceeded",
                  type: "invalid_request_error",
                },
              },
              { status: 400 },
            )
          const checkpoint = {
            type: "compaction",
            id: `cmp_${state.calls}`,
            encrypted_content: `encrypted_${state.calls}`,
          }
          const binding = options.quota
            ? {
                "X-Quota-Protocol": "1",
                "X-Quota-Binding": Buffer.from(
                  JSON.stringify({ protocol: 1, generation: 1, alias: "Fixture" }),
                ).toString("base64url"),
              }
            : undefined
          if (new URL(request.url).pathname.endsWith("/compact"))
            return Response.json(
              {
                id: "compact_endpoint",
                object: "response.compaction",
                output: [
                  ...(state.echo
                    ? Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))(
                        bodies.at(-1)?.input,
                      ).filter((message) => message.type === "message" && message.role === "user")
                    : [
                        { type: "message", role: "user", content: [{ type: "input_text", text: "endpoint retained" }] },
                      ]),
                  checkpoint,
                ],
                usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
              },
              { headers: binding },
            )
          const summary = state.overflow || state.summary
            ? [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { type: "message", id: "summary", role: "assistant", content: [] },
                },
                {
                  type: "response.output_text.delta",
                  item_id: "summary",
                  output_index: 0,
                  content_index: 0,
                  delta: "## Objective\n- Recovered locally",
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join("")
            : ""
          const output = trigger ? [checkpoint] : []
          return new Response(
            `${summary}data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: `resp_${state.calls}`,
                status: "completed",
                output,
                usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
              },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream", ...binding } },
          )
        },
      }),
    ),
    (server) =>
      Effect.sync(() => {
        hanging.resolve(new Response("cancelled"))
        void server.stop(true)
      }),
  )
  const native = OpenAI.configure({ apiKey: "fixture", baseURL: server.url.toString() }).responses("gpt-5.4-mini")
  const model = SessionRunnerModel.resolved(
    options.anthropic
      ? (options.anthropic === "direct"
          ? Anthropic.configure({ apiKey: "fixture", baseURL: server.url.toString() })
          : AnthropicCompatible.configure({ baseURL: server.url.toString(), provider: "relay" })
        ).model("claude-opus-4-6")
      : endpoint
      ? LanguageModel.update(native, {
          route: native.route.with({ compact: { endpoint: native.route.compact.endpoint } }),
        })
      : native,
    {
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      cost: [],
      limit: { context: 200_000, output: 32_000 },
compaction: options.policy === false ? undefined : { type: "native" },
    },
  )
  const available = yield* NativeModels
  available.set(`${model.ref.providerID}/${model.ref.id}`, model)
  const sessionID = SessionSchema.ID.create()
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* bus.publish(SessionEvent.Created, {
    sessionID,
    projectID: Project.ID.global,
    location: { directory: AbsolutePath.make("/project") },
    slug: "native-compaction",
    version: "test",
  })
  const session = yield* store.get(sessionID)
  if (!session) return yield* Effect.die("Missing fixture session")
  const instructions = Instructions.make({
    key: Instructions.Key.make("test/native"),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed("Current instructions"),
    render: { initial: String, changed: (_previous, value) => value, removed: () => "removed" },
  })
  yield* InstructionState.prepare(db, bus, instructions, sessionID)
  yield* hooks.register("session", "model.request", (event) =>
    Effect.sync(() => {
      event.headers["x-test-hook"] = event.kind
    }),
  )
  yield* hooks.register("session", "http.request", (event) =>
    Effect.sync(() => event.request.headers.set("x-http-hook", event.kind)),
  )
  const prompt = Effect.fnUntraced(function* (text: string, synthetic = false) {
    const id = SessionMessage.ID.create()
    yield* inbox.admit({
      id,
      sessionID,
      item: { type: synthetic ? "synthetic" : "user", payload: { text }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
  })
  const load = Effect.gen(function* () {
    const history = yield* SessionHistory.preview(
      db,
      sessionID,
      instructions,
      SessionProviderContext.provenance(model) ?? "local",
    )
    return {
      session,
      model,
      initial: history.initial,
      messages: history.messages,
agent: { id: Agent.defaultID, info: { ...Agent.Info.default(Agent.defaultID), compaction: state.config } },
      tools: {
        definitions: [
          ToolDefinition.make({ name: "read", description: "Read a file", inputSchema: { type: "object" } }),
        ],
        execute: () => Effect.die("Compaction must never dispatch tools"),
      },
    }
  })
  // Opens the compaction's message as the runner does when it delivers `/compact`.
  const compact = Effect.gen(function* () {
    const inputID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID })
    return yield* compaction.compact({ reason: "manual", context: yield* load, inputID })
  })
  const checkpoint = Effect.gen(function* () {
    const messages = (yield* load).messages
    const last = messages.findLast((message) => message.type === "compaction" && message.status === "completed")
    if (last?.type !== "compaction" || last.status !== "completed" || !last.providerContext)
      return yield* Effect.die("Missing native checkpoint")
    expect(last.summary).toBe("")
    expect(last.recent).toContain("[User]:")
    // Provider compaction has no summary, so the request usage is the only visible cost of the operation.
    expect(last.tokens).toMatchObject({ input: 20, output: 4 })
    return last.providerContext
  })
  return {
    observations,
    compact,
    // An automatic compaction that skips the "is it due" check, which a context this small never passes.
    overflow: Effect.gen(function* () {
      return yield* compaction.compact({ reason: "overflow", context: yield* load })
    }),
    checkpoint,
    prompt,
    load,
    requests,
    bodies,
    headers,
    state,
    blocked,
    sessionID,
    store,
    hooks,
    model,
    compaction,
    available,
  }
})

for (const mode of ["endpoint", "trigger", "summary", "retry", "nudge"] as const) {
  it.live(`compaction observations capture each ${mode} invocation before aggregate settlement`, () => Effect.gen(function* () {
    const fixture = yield* setup({ endpoint: mode === "endpoint", config: mode === "summary" || mode === "nudge" ? { strategy: "local" } : undefined })
    const ledger = yield* Effect.acquireRelease(Effect.sync(() => createLedger(":memory:")), (ledger) => Effect.sync(() => ledger.close()))
    yield* watchMonitor(context({ session: { hook: (name, callback, options) => fixture.hooks.register("session", name, callback, options) } }), () => undefined, () => ledger)
    fixture.state.summary = mode === "summary"
    fixture.state.flaky = mode === "retry"
    yield* fixture.prompt("Conversation to compact")
    const outcome = yield* fixture.compact
    expect(outcome.status).toBe(mode === "nudge" ? "failed" : "completed")
    expect(fixture.observations).toHaveLength(mode === "retry" || mode === "nudge" ? 2 : 1)
    expect(new Set(fixture.observations.map((event) => event.operationID)).size).toBe(1)
    expect(new Set(fixture.observations.map((event) => event.invocationID)).size).toBe(fixture.observations.length)
    expect(fixture.observations.every((event) => Object.isFrozen(event.compaction))).toBe(true)
    expect(fixture.observations.every((event) => event.compaction?.trigger === "manual")).toBe(true)
    expect(fixture.observations[0]?.compaction).toMatchObject({
      configuredStrategy: mode === "summary" || mode === "nudge" ? "local" : "auto",
      strategySource: mode === "summary" || mode === "nudge" ? "agent-config" : "built-in",
      selectedStrategy: mode === "summary" || mode === "nudge" ? "text-summary" : "native",
      selectionReason: mode === "summary" || mode === "nudge" ? "explicit-local" : "auto-native",
    })
    expect(ledger.getRequests(fixture.sessionID).filter((row) => row.observation?.scope === "invocation").map((row) => row.observation?.compaction))
      .toEqual(fixture.observations.map((event) => event.compaction))
    const measured = fixture.observations.filter((event) => event.usage.inputTokens !== undefined)
    expect(measured.map((event) => event.usage.inputTokens)).toEqual(mode === "nudge" ? [20, 20] : [20])
    expect(ledger.getRequests(fixture.sessionID).filter((row) => row.observation?.inputTokens !== undefined).map((row) => row.observation?.inputTokens)).toEqual(mode === "nudge" ? [20, 20] : [20])
    if (mode === "nudge") {
      expect(fixture.observations[0]?.outcome).toBe("completed")
      const last = (yield* fixture.load).messages.at(-1)
      expect(last).toMatchObject({ status: "failed", tokens: { input: 40, output: 8 } })
    }
  }))
}

for (const origin of ["threshold", "overflow", "cold", "armed", "handoff"] as const) {
  it.live(`compaction execution observation preserves the actual ${origin} origin`, () => Effect.gen(function* () {
    const fixture = yield* setup({ endpoint: true })
    yield* fixture.prompt("Conversation to compact")
    if (origin !== "threshold" && origin !== "overflow") {
      fixture.state.summary = true
      yield* fixture.hooks.register("session", "compaction.decide", (event) => Effect.sync(() => {
        if (origin === "cold") decideCompaction(event, {
          every: { type: "modelSettings", level: "defaults", updated: "fixture", coldCompact: "on", coldModels: ["openai/gpt-5.4-mini"] },
          cold: { running: false, ready: true, active: false, compacted: false },
        })
        if (origin === "armed") decideCompaction(event, { armed: ["openai/gpt-5.4-mini"] })
        if (origin === "handoff") {
          event.compact = true
          event.portable = true
          event.metadata = { "quota.switch": true, private: "SECRET DECISION METADATA" }
        }
      }))
    }
    const loaded = yield* fixture.load
    const outcome = yield* fixture.compaction.compact({
      reason: origin === "overflow" ? "overflow" : "auto",
      context: origin === "threshold" ? { ...loaded, model: { ...loaded.model, limit: { ...loaded.model.limit, context: 1 } } } : loaded,
    })
    expect(outcome).toEqual({ status: "completed" })
    expect(fixture.observations).toHaveLength(1)
    expect(fixture.observations[0]?.compaction).toMatchObject({
      trigger: origin === "threshold" ? "context-threshold" : origin,
      selectedStrategy: origin === "threshold" || origin === "overflow" ? "native" : "text-summary",
      selectionReason: origin === "threshold" || origin === "overflow" ? "auto-native" : "portable-required",
    })
    expect(JSON.stringify(fixture.observations[0]?.compaction)).not.toContain("SECRET")
    expect(fixture.state.calls).toBe(1)
  }))
}

it.live("Auto without native policy records a provider-backed text summary, not a local-only operation", () => Effect.gen(function* () {
  const fixture = yield* setup({ endpoint: true, policy: false })
  fixture.state.summary = true
  yield* fixture.prompt("Conversation to compact")
  expect(yield* fixture.compact).toEqual({ status: "completed" })
  expect(fixture.state.calls).toBe(1)
  expect(fixture.observations[0]?.compaction).toMatchObject({ configuredStrategy: "auto", strategySource: "built-in", selectedStrategy: "text-summary", selectionReason: "auto-text", modelSource: "active-model" })
  expect(fixture.observations[0]?.compaction?.modelPolicy).toBeUndefined()
  expect(fixture.observations[0]?.exchanges[0]?.transport).toBe("http")
}))

it.live("an explanation hint alone cannot arm compaction or override auto:false", () => Effect.gen(function* () {
  const fixture = yield* setup({ endpoint: true })
  yield* fixture.prompt("Conversation to compact")
  yield* fixture.hooks.register("session", "compaction.decide", (event) => Effect.sync(() => {
    event.explanation = { trigger: "cold", strategy: { value: "remote", source: "project" } }
  }))
  expect(yield* fixture.compaction.compact({ reason: "auto", context: yield* fixture.load })).toEqual({ status: "skipped" })
  yield* fixture.compaction.transform((editor) => editor.configure({ auto: false }))
  yield* fixture.hooks.register("session", "compaction.decide", (event) => Effect.sync(() => { event.compact = true }))
  expect(yield* fixture.compaction.compact({ reason: "auto", context: yield* fixture.load })).toEqual({ status: "skipped" })
  expect(fixture.state.calls).toBe(0)
  expect(fixture.observations).toHaveLength(0)
}))

it.live("a low input threshold selects normal native Auto once, then waits for primary history after the checkpoint", () => Effect.gen(function* () {
  const fixture = yield* setup({ endpoint: true })
  yield* fixture.prompt("Synthetic native threshold fixture")
  const thresholds: { input?: number; output?: number } = { input: 1 }
  yield* fixture.hooks.register("session", "compaction.decide", (event) => Effect.sync(() => {
    decideCompactionTriggers(event, { sessionID: event.sessionID, ...thresholds })
  }))
  expect(yield* fixture.compaction.compact({ reason: "auto", context: yield* fixture.load })).toEqual({ status: "completed" })
  expect(fixture.observations[0]?.compaction).toMatchObject({ trigger: "input-threshold", threshold: 1, configuredStrategy: "auto", selectedStrategy: "native" })
  expect(SessionCompaction.thresholdMetrics(yield* fixture.load)).toMatchObject({ output: 0, advanced: false })
  expect(yield* fixture.compaction.compact({ reason: "auto", context: yield* fixture.load })).toEqual({ status: "skipped" })
  yield* fixture.prompt("Additional user input is not primary assistant advancement")
  expect(yield* fixture.compaction.compact({ reason: "auto", context: yield* fixture.load })).toEqual({ status: "skipped" })
  expect(fixture.observations).toHaveLength(1)
  const loaded = yield* fixture.load
  const primary = Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: "msg_native_primary", type: "assistant", agent: Agent.defaultID, model: fixture.model.ref,
    content: [{ type: "text", text: "New primary response" }],
    tokens: { input: 100, output: 8, reasoning: 2, cache: { read: 0, write: 0 } }, time: { created: 0, completed: 1 },
  })
  expect(SessionCompaction.thresholdMetrics({ ...loaded, messages: [...loaded.messages, primary] })).toMatchObject({ output: 10, advanced: true })
  delete thresholds.input
  thresholds.output = 10
  expect(yield* fixture.compaction.compact({ reason: "auto", context: { ...loaded, messages: [...loaded.messages, primary] } })).toEqual({ status: "completed" })
  expect(fixture.observations).toHaveLength(2)
  expect(fixture.observations[1]?.compaction).toMatchObject({ trigger: "output-threshold", threshold: 10, configuredStrategy: "auto", selectedStrategy: "native" })
}))

it.live("the executed summary fallback records its model source without fabricating a failed invocation", () => Effect.gen(function* () {
  const fixture = yield* setup({ endpoint: true })
  fixture.state.summary = true
  yield* fixture.hooks.register("session", "compaction.decide", (event) => Effect.sync(() => {
    event.strategy = "local"
    event.compactionModel = Model.Ref.parse("unavailable/summary")
    event.compactionFallbacks = [fixture.model.ref]
  }))
  yield* fixture.prompt("Conversation to compact")
  expect(yield* fixture.compact).toEqual({ status: "completed" })
  expect(fixture.state.calls).toBe(1)
  expect(fixture.observations).toHaveLength(1)
  expect(fixture.observations[0]?.compaction).toMatchObject({ configuredStrategy: "local", strategySource: "decision-hook", selectedStrategy: "text-summary", modelSource: "fallback-list" })
  expect(fixture.observations[0]?.model).toEqual(fixture.model.ref)
}))

it.live("execution decision survives hot strategy changes and distrusts overwritten source hints", () => Effect.gen(function* () {
  const fixture = yield* setup({ endpoint: true })
  const ledger = yield* Effect.acquireRelease(Effect.sync(() => createLedger(":memory:")), (ledger) => Effect.sync(() => ledger.close()))
  yield* watchMonitor(context({ session: { hook: (name, callback, options) => fixture.hooks.register("session", name, callback, options) } }), () => undefined, () => ledger)
  yield* fixture.hooks.register("session", "compaction.decide", (event) => Effect.sync(() => {
    decideCompaction(event, { rows: { compactionStrategy: { value: "remote", level: "project" } } })
    if (fixture.state.config?.strategy) event.strategy = fixture.state.config.strategy
  }))
  yield* fixture.prompt("Original conversation")
  expect(yield* fixture.compact).toEqual({ status: "completed" })
  const first = fixture.observations[0]?.compaction
  expect(first).toMatchObject({ configuredStrategy: "remote", strategySource: "project", selectedStrategy: "native", selectionReason: "explicit-remote" })
  fixture.state.config = { strategy: "local", system: "PRIVATE CONFIG TEXT" }
  fixture.state.summary = true
  expect(yield* fixture.compact).toEqual({ status: "completed" })
  expect(fixture.observations[1]?.compaction).toMatchObject({ configuredStrategy: "local", strategySource: "decision-hook", selectedStrategy: "text-summary", selectionReason: "explicit-local" })
  expect(fixture.observations[0]?.compaction).toEqual(first)
  expect(ledger.getRequests(fixture.sessionID)[0]?.observation?.compaction).toEqual(first)
  expect(JSON.stringify(ledger.getRequests(fixture.sessionID).map((row) => row.observation))).not.toContain("PRIVATE CONFIG TEXT")
}))

it.live("a throwing compaction decision observer cannot mutate the snapshot or retry model work", () => {
  const logs: unknown[] = []
  return Effect.gen(function* () {
    const fixture = yield* setup({ endpoint: true })
    yield* fixture.hooks.register("session", "model.observed", (event) => Effect.sync(() => {
      expect(() => Object.assign(event.compaction ?? {}, { selectedStrategy: "text-summary" })).toThrow()
      throw new Error("PRIVATE_COMPACTION_OBSERVER_ERROR")
    }))
    yield* fixture.prompt("Conversation to compact")
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    expect(fixture.state.calls).toBe(1)
    expect(fixture.observations[0]?.compaction).toMatchObject({ selectedStrategy: "native", selectionReason: "auto-native" })
    expect(logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_COMPACTION_OBSERVER_ERROR")
  }).pipe(Effect.provide(Logger.layer([Logger.make((entry) => { logs.push(entry.message) })])))
})

for (const anthropic of ["direct", "compatible"] as const) {
  it.live(`Anthropic ${anthropic}: Auto persists a native checkpoint and compaction iteration usage`, () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ anthropic })
      yield* fixture.prompt("Conversation ".repeat(20_000))
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      const last = (yield* fixture.load).messages.at(-1)
      expect(last).toMatchObject({ status: "completed", summary: "", tokens: { input: 55000, output: 400 } })
      if (last?.type !== "compaction" || last.status !== "completed" || !last.providerContext)
        return yield* Effect.die("Missing persisted Anthropic checkpoint")
      expect(last.providerContext.messages).toContainEqual({
        role: "assistant",
        content: [{ type: "compaction", provider: fixture.model.model.provider, text: "Native summary" }],
      })
      expect(fixture.bodies).toHaveLength(1)
      expect(fixture.headers[0].get("anthropic-beta")).toContain("compact-2026-01-12")
      expect(fixture.bodies[0]).toMatchObject({ context_management: { edits: [{ trigger: { value: 50000 }, pause_after_compaction: true }] } })
    }),
  )

  it.live(`Anthropic ${anthropic}: Auto below 50 000 tokens uses a local summary`, () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ anthropic })
      yield* fixture.prompt("Short conversation")
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      expect(fixture.bodies).toHaveLength(1)
      expect(fixture.bodies[0].context_management).toBeUndefined()
      expect(fixture.observations[0]?.compaction).toMatchObject({ selectedStrategy: "text-summary", selectionReason: "anthropic-below-minimum" })
      const last = (yield* fixture.load).messages.at(-1)
      expect(last).toMatchObject({ status: "completed", summary: "## Objective\n- Local summary" })
      expect(last).not.toHaveProperty("providerContext", expect.anything())
    }),
  )

  it.live(`Anthropic ${anthropic}: Remote below 50 000 tokens fails without sending HTTP`, () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ anthropic, config: { strategy: "remote" } })
      yield* fixture.prompt("Short conversation")
      expect(yield* fixture.compact).toMatchObject({ status: "failed", error: { type: "compaction.unavailable", message: expect.stringContaining("at least 50 000 input tokens") } })
      expect(fixture.bodies).toHaveLength(0)
      expect((yield* fixture.load).messages.at(-1)).toMatchObject({ status: "failed" })
    }),
  )
}

it.live("Anthropic records a completed but unusable compaction's usage on the failed record", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ anthropic: "direct" })
    fixture.state.unusable = true
    yield* fixture.prompt("Conversation ".repeat(20_000))
    expect(yield* fixture.compact).toMatchObject({
      status: "failed",
      error: { type: "provider.invalid-output", message: expect.stringContaining("no usable summary checkpoint") },
    })
    expect(fixture.state.calls).toBe(1)
    expect(fixture.observations).toHaveLength(1)
    expect(fixture.observations[0]).toMatchObject({ outcome: "failed", usage: { completeness: "final", cacheReadInputTokens: 2000, outputTokens: 400 } })
    expect(fixture.observations[0]?.usage.inputTokens).toBeUndefined()
    expect((yield* fixture.load).messages.at(-1)).toMatchObject({
      type: "compaction",
      status: "failed",
      tokens: { input: 51000, output: 400, cache: { read: 2000 } },
    })
  }),
)

it.live("Anthropic Auto falls back to a local summary when it does not trigger compaction", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ anthropic: "direct" })
    fixture.state.notTriggered = true
    yield* fixture.prompt("Conversation ".repeat(20_000))
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    // The native attempt is billed, then the local fallback summarizes in a second, non-trigger request.
    expect(fixture.state.calls).toBe(2)
    expect(fixture.observations).toHaveLength(2)
    expect(new Set(fixture.observations.map((event) => event.operationID)).size).toBe(1)
    expect(fixture.observations.map((event) => event.usage.outputTokens)).toEqual([40, 40])
    expect(fixture.observations.map((event) => event.compaction?.selectionReason)).toEqual(["auto-native", "native-not-triggered"])
    expect(fixture.observations.map((event) => event.compaction?.selectedStrategy)).toEqual(["native", "text-summary"])
    expect(fixture.bodies[0]).toHaveProperty("context_management")
    expect(fixture.bodies[1]).not.toHaveProperty("context_management")
    const last = (yield* fixture.load).messages.at(-1)
    expect(last).toMatchObject({ status: "completed", summary: "## Objective\n- Local summary" })
    expect(last).not.toHaveProperty("providerContext", expect.anything())
  }),
)

it.live("Anthropic Remote fails with the minimum message when it does not trigger compaction", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ anthropic: "direct", config: { strategy: "remote" } })
    fixture.state.notTriggered = true
    yield* fixture.prompt("Conversation ".repeat(20_000))
    expect(yield* fixture.compact).toMatchObject({
      status: "failed",
      error: { type: "compaction.unavailable", message: expect.stringContaining("at least 50 000 input tokens") },
    })
    expect(fixture.state.calls).toBe(1)
    expect((yield* fixture.load).messages.at(-1)).toMatchObject({
      type: "compaction",
      status: "failed",
      tokens: { input: 200, output: 40 },
    })
  }),
)

for (const endpoint of [false, true]) {
  it.live(
    `explicit remote agent strategy uses ${endpoint ? "endpoint" : "trigger"} capability without provider policy or local overrides`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({
          endpoint,
          config: {
            strategy: "remote",
            model: Model.Ref.parse("unavailable/local-model"),
            system: "LOCAL CUSTOMIZATION MUST NOT BE SENT",
          },
          policy: false,
        })
        yield* fixture.prompt("Original user")
        expect(yield* fixture.compact).toEqual({ status: "completed" })
        expect(yield* fixture.checkpoint).toHaveProperty("messages")
        expect(fixture.bodies).toHaveLength(1)
         expect(fixture.bodies[0].model).toBe("gpt-5.4-mini")
         expect(fixture.observations[0]?.compaction).toMatchObject({ configuredStrategy: "remote", strategySource: "agent-config", selectedStrategy: "native", selectionReason: "explicit-remote" })
      expect(JSON.stringify(fixture.bodies[0])).not.toContain("LOCAL CUSTOMIZATION")
        expect(fixture.state.config).toEqual({
          strategy: "remote",
          model: Model.Ref.parse("unavailable/local-model"),
          system: "LOCAL CUSTOMIZATION MUST NOT BE SENT",
        })
        yield* fixture.prompt("Continue with remote compaction")
        expect(yield* fixture.compact).toEqual({ status: "completed" })
        expect(fixture.bodies).toHaveLength(2)
        expect(fixture.bodies[1].model).toBe("gpt-5.4-mini")
        expect(JSON.stringify(fixture.bodies[1])).not.toContain("LOCAL CUSTOMIZATION")
      }),
  )
}

for (const endpoint of [false, true]) {
  it.live(
    `native ${endpoint ? "endpoint" : "trigger"} handoff summarizes with the owner and preserves the tail across consecutive compactions`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({
          endpoint,
          config: { strategy: "remote", model: Model.Ref.parse("unavailable/override") },
        })
        yield* fixture.prompt("Durable original, not present in the endpoint replacement ".repeat(2_000))
        yield* fixture.prompt("Exact recent question 🦉")
        expect(yield* fixture.compact).toEqual({ status: "completed" })
        const first = (yield* fixture.load).messages[0]
        if (first?.type !== "compaction" || first.status !== "completed") return yield* Effect.die("Missing checkpoint")
        expect(first.recent).toContain("Exact recent question 🦉")
        expect(yield* fixture.compact).toEqual({ status: "completed" })
        expect((yield* fixture.load).messages[0]).toMatchObject({ recent: first.recent })
        const target = { ...fixture.model, ref: Model.Ref.parse("openai/target"), model: OpenAI.responses("target") }
        fixture.state.summary = true
        const marked: Array<true | undefined> = []
        yield *
          fixture.hooks.register("session", "compaction", (event) =>
            Effect.sync(() => {
              marked.push(event.checkpointHandoff)
            }),
          )
        const loaded = yield* fixture.load
        expect(yield* fixture.compaction.handoff({ reason: "auto", context: loaded })).toEqual({ status: "skipped" })
        expect(fixture.bodies).toHaveLength(2)
        expect(yield* fixture.compaction.handoff({ reason: "auto", context: { ...loaded, model: target } })).toEqual({
          status: "completed",
        })
         expect(marked).toEqual([true])
         expect(fixture.observations.at(-1)?.compaction).toMatchObject({ trigger: "handoff", configuredStrategy: "remote", selectedStrategy: "text-summary", selectionReason: "checkpoint-handoff", modelSource: "checkpoint-owner" })
        const sent = JSON.stringify(fixture.bodies[2])
        expect(fixture.bodies[2].model).toBe("gpt-5.4-mini")
        expect(sent).toContain("encrypted_2")
        expect(sent).not.toContain("compaction_trigger")
        if (endpoint) expect(sent).not.toContain("Durable original")
        const portable = (yield* fixture.load).messages[0]
        expect(portable).toMatchObject({
          status: "completed",
          summary: "## Objective\n- Recovered locally",
          recent: first.recent,
          model: fixture.model.ref,
        })
        expect(portable).not.toHaveProperty("providerContext", expect.anything())
        expect(portable).not.toHaveProperty("providerState", expect.anything())
        const transcript = SessionModelRequest.baseTranscript({
          ...loaded,
          messages: [portable],
          model: target,
          agent: loaded.agent.info,
        })
        expect(JSON.stringify(transcript)).not.toContain("encrypted_")
        expect(JSON.stringify(transcript)).toContain("Exact recent question 🦉")
        fixture.state.config = { strategy: "local" }
        expect(yield* fixture.compact).toEqual({ status: "completed" })
        expect(marked).toEqual([true, undefined])
        expect((yield* fixture.load).messages[0]).toMatchObject({ recent: first.recent })
      }),
  )
}

for (const pending of [false, true]) {
  it.live(
    `core checkpoint handoff uses the source quota guard with stale target portability (source pending: ${pending})`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({ endpoint: true, quota: true })
        yield* fixture.prompt("Retained source conversation")
        expect(yield* fixture.compact).toEqual({ status: "completed" })
        const installed = yield* fixture.checkpoint
        const storage = new Map<string, Schema.Json>()
        const base = context()
        const scope = yield* Scope.Scope
        const endpoint = fixture.model.model.route.endpoint.baseURL
        if (!endpoint) return yield* Effect.die("Missing fixture endpoint")
        yield* registerQuota(
          context({
            rpc: Object.assign(base.rpc, {
              register: () => Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } }),
            }),
            storage: {
              ...base.storage,
              get: (key) => Effect.succeed(storage.get(key)),
              set: (key, value) =>
                Effect.sync(() => {
                  storage.set(key, value)
                }),
            },
            session: {
              hook: (name, callback) =>
                fixture.hooks.register("session", name, callback).pipe(Effect.provideService(Scope.Scope, scope)),
            },
          }),
          () => ({ routes: { openai: endpoint }, compactionModel: "openai/gpt-5.4-mini" }),
        )
        if (pending) fixture.state.pending.add("openai/gpt-5.4-mini")
        const target = { ...fixture.model, ref: Model.Ref.parse("openai/target"), model: OpenAI.responses("target") }
        for (const model of [fixture.model.ref, target.ref]) {
          if (model === target.ref) fixture.state.pending.add("openai/target")
          yield* fixture.hooks.trigger("session", "compaction.decide", {
            sessionID: fixture.sessionID,
            agent: Agent.defaultID,
            model,
            reason: "auto",
            auto: true,
            due: false,
            boundary: { fresh: false, portable: false },
          })
        }
        fixture.state.summary = true
        const loaded = yield* fixture.load
        const outcome = yield* fixture.compaction
          .handoff({ reason: "auto", context: { ...loaded, model: target } })
          .pipe(Effect.exit)
        if (pending) {
          expect(outcome._tag).toBe("Failure")
          if (outcome._tag === "Failure") expect(Cause.pretty(outcome.cause)).toContain("opaque checkpoint")
          expect(fixture.bodies).toHaveLength(1)
          expect(yield* fixture.checkpoint).toEqual(installed)
          return
        }
        expect(outcome).toMatchObject({ _tag: "Success", value: { status: "completed" } })
        expect(fixture.bodies).toHaveLength(2)
        expect(JSON.stringify(fixture.bodies[1].input)).toContain("encrypted_1")
        expect(
          JSON.parse(Buffer.from(fixture.headers[1].get("X-Quota-Handoff") ?? "", "base64url").toString()),
        ).toMatchObject({
          kind: "compaction",
          route: "openai/gpt-5.4-mini",
          fresh: false,
          portable: false,
          checkpoint: "",
        })
        expect((yield* fixture.load).messages[0]).toMatchObject({
          summary: "## Objective\n- Recovered locally",
          recent: "[User]: Retained source conversation",
        })
      }),
  )
}

it.live("repeated endpoints which retain user messages do not accumulate tail wrappers", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ endpoint: true })
    fixture.state.echo = true
    yield* fixture.prompt("Exact retained request")
    for (let index = 0; index < 3; index++) {
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      const context = yield* fixture.load
      expect(context.messages[0]).toMatchObject({ recent: "[User]: Exact retained request" })
      expect(JSON.stringify(yield* fixture.checkpoint)).not.toContain("<recent-context>")
      const replay = SessionModelRequest.baseTranscript({ ...context, agent: context.agent.info })
      expect(JSON.stringify(replay.messages).match(/<recent-context>/g)).toHaveLength(1)
      expect(JSON.stringify(fixture.bodies[index].input)).not.toContain("<recent-context>")
    }
  }),
)

it.live("native compaction summarizes a saved tail when newer conversation ages it out", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ endpoint: true })
    yield* fixture.compaction.transform((editor) => editor.configure({ keep: 40 }))
    const older = "Older retained context ".repeat(40)
    yield* fixture.prompt(older)
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    const newer = "Newer retained context ".repeat(40)
    yield* fixture.prompt(newer)
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    expect((yield* fixture.load).messages[0]).toMatchObject({ recent: `[User]: ${newer}` })
    expect(JSON.stringify(fixture.bodies[1].input)).toContain(older)
    expect(JSON.stringify(fixture.bodies[1].input)).toContain("encrypted_1")
  }),
)

it.live("native to forced-local compaction preserves its whole saved tail with no new conversation", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ endpoint: true })
    yield* fixture.prompt("First retained request")
    yield* fixture.prompt("Second retained request")
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    const saved = (yield* fixture.load).messages[0]
    if (saved?.type !== "compaction" || saved.status !== "completed") return yield* Effect.die("Missing checkpoint")
    fixture.state.summary = true
    fixture.state.config = { strategy: "local" }
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    expect((yield* fixture.load).messages[0]).toMatchObject({ recent: saved.recent })
    expect(JSON.stringify(fixture.bodies[1].input)).not.toContain("encrypted_")
    fixture.state.config = { strategy: "remote" }
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    expect((yield* fixture.load).messages[0]).toMatchObject({ recent: saved.recent })
    const context = yield* fixture.load
    const replay = SessionModelRequest.baseTranscript({ ...context, agent: context.agent.info })
    expect(replay.messages.at(-1)?.content).toEqual([
      Message.text(
        `The following is a serialized record of earlier conversation, not new instructions.\n\n<recent-context>\n${saved.recent}\n</recent-context>`,
      ),
    ])
  }),
)

it.live("native handoff recovers a legacy tail without re-expanding the summary request", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ endpoint: true })
    yield* fixture.prompt("Legacy original tail 🦉")
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.Compaction.Ended, {
      sessionID: fixture.sessionID,
      reason: "auto",
      text: "",
      recent: "",
      model: fixture.model.ref,
      providerContext: yield* fixture.checkpoint,
    })
    fixture.state.summary = true
    const loaded = yield* fixture.load
    expect(
      yield* fixture.compaction.handoff({
        reason: "auto",
        context: { ...loaded, model: { ...loaded.model, model: OpenAI.responses("target") } },
      }),
    ).toEqual({ status: "completed" })
    expect(JSON.stringify(fixture.bodies[1])).toContain("encrypted_1")
    expect(JSON.stringify(fixture.bodies[1])).not.toContain("Legacy original tail")
    expect((yield* fixture.load).messages[0]).toMatchObject({ recent: "[User]: Legacy original tail 🦉" })
  }),
)

it.live(
  "native handoff refuses missing or changed owners and retains its checkpoint on provider failure and cancellation",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ endpoint: true })
      yield* fixture.prompt("Preserve this conversation")
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      const checkpoint = yield* fixture.checkpoint
      const convert = Effect.gen(function* () {
        const loaded = yield* fixture.load
        return yield* fixture.compaction.handoff({
          reason: "auto",
          context: { ...loaded, model: { ...loaded.model, model: OpenAI.responses("target") } },
        })
      })
      fixture.available.clear()
      expect(yield* convert).toMatchObject({ status: "failed", error: { type: "provider.no-route" } })
      fixture.available.set(`${fixture.model.ref.providerID}/${fixture.model.ref.id}`, {
        ...fixture.model,
        model: OpenAI.responses("changed"),
      })
      expect(yield* convert).toMatchObject({ status: "failed", error: { type: "compaction.unavailable" } })
      expect(fixture.bodies).toHaveLength(1)
      fixture.available.set(`${fixture.model.ref.providerID}/${fixture.model.ref.id}`, fixture.model)
      fixture.state.failure = true
      expect(yield* convert).toMatchObject({ status: "failed", error: { type: "provider.rate-limit" } })
      expect(yield* fixture.checkpoint).toEqual(checkpoint)
      fixture.state.failure = false
      fixture.state.hang = true
      const pending = yield* convert.pipe(Effect.forkScoped)
      yield* Deferred.await(fixture.blocked)
      yield* Fiber.interrupt(pending)
      expect(yield* fixture.checkpoint).toEqual(checkpoint)
      expect((yield* fixture.load).messages.at(-1)).toMatchObject({
        status: "failed",
        error: { type: "compaction.interrupted" },
      })
      expect(fixture.bodies.every((body) => body.model === "gpt-5.4-mini")).toBe(true)
    }),
)

it.live("forced local agent compaction bypasses remote and re-expands existing provider checkpoints", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.prompt("Original durable request")
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    yield* fixture.prompt("Recent request")
    fixture.state.config = { strategy: "local", system: "Custom local instructions" }
    fixture.state.overflow = true
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    expect(fixture.bodies).toHaveLength(2)
    expect(JSON.stringify(fixture.bodies[1])).toContain("Original durable request")
    expect(JSON.stringify(fixture.bodies[1])).toContain("Custom local instructions")
    expect(JSON.stringify(fixture.bodies[1])).not.toContain("compaction_trigger")
    expect(JSON.stringify(fixture.bodies[1])).not.toContain("encrypted_1")
    expect((yield* fixture.load).messages.at(-1)).toMatchObject({
      status: "completed",
      summary: "## Objective\n- Recovered locally",
    })
  }),
)

it.live("explicit remote agent overflow fails without automatic local fallback", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ config: { strategy: "remote" } })
    yield* fixture.prompt("Original durable request")
    expect(yield* fixture.overflow).toMatchObject({
      status: "failed",
      error: {
        type: "provider.unsupported-operation",
        message: expect.stringContaining("Remote compaction cannot recover"),
      },
    })
    expect(fixture.bodies).toHaveLength(0)
    expect(
      (yield* fixture.load).messages.some((message) => message.type === "compaction" && message.status === "completed"),
    ).toBe(false)
  }),
)

it.live("explicit remote agent strategy rejects hook-supplied local summaries", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ config: { strategy: "remote" } })
    yield* fixture.prompt("Original user")
    yield* fixture.hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.result = { summary: "Local summary" }
      }),
    )
    expect(yield* fixture.compact).toMatchObject({
      status: "failed",
      error: { type: "provider.unsupported-operation" },
    })
    expect(fixture.bodies).toHaveLength(0)
  }),
)

it.live(
  "manual trigger persists and continues, retains earlier users repeatedly, and preserves context on failure/cancellation",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      yield* fixture.prompt("First real user request")
      yield* fixture.prompt("Synthetic context, not a user request", true)
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      const first = yield* fixture.checkpoint
      expect(SessionProviderContext.decode(first).map((message) => message.role)).toEqual(["user", "assistant"])
      expect(JSON.stringify(first.messages)).not.toContain("Synthetic context")
      expect(fixture.bodies[0]).toMatchObject({
        input: expect.arrayContaining([{ type: "compaction_trigger" }]),
        tools: [expect.objectContaining({ name: "read" })],
      })
      expect(fixture.bodies[0]).not.toHaveProperty("context_management")
      expect(fixture.headers[0]?.get("x-test-hook")).toBe("compaction")
      expect(fixture.headers[0]?.get("x-http-hook")).toBe("compaction")
      yield* fixture.prompt("Second real user request")
      const context = yield* fixture.load
      const prepared = yield* fixture.requests.primary({
        session: context.session,
        agent: context.agent.id,
        model: context.model,
        tools: context.tools,
        ...SessionModelRequest.baseTranscript({ ...context, agent: context.agent.info }),
      })
      const client = yield* LLMClient.Service
      yield* client.generate(prepared.request, prepared.options)
      expect(JSON.stringify(fixture.bodies[1])).toContain("encrypted_1")
      expect(JSON.stringify(fixture.bodies[1])).toContain("Current instructions")
      expect(JSON.stringify(fixture.bodies[1])).toContain("Second real user request")
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      const second = yield* fixture.checkpoint
      expect(
        SessionProviderContext.decode(second)
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[Message.text("First real user request")], [Message.text("Second real user request")]])
      expect(JSON.stringify(second.messages)).not.toContain("encrypted_1")
      expect(yield* fixture.store.get(fixture.sessionID)).toMatchObject({ tokens: { input: 40, output: 8 } })
      yield* fixture.prompt("Third real user request")
      fixture.state.failure = true
      expect(yield* fixture.compact).toMatchObject({ status: "failed", error: { type: "provider.rate-limit" } })
      expect(fixture.state.calls).toBe(4)
      expect(yield* fixture.checkpoint).toEqual(second)
      fixture.state.failure = false
      fixture.state.hang = true
      const pending = yield* fixture.compact.pipe(Effect.forkScoped)
      yield* Deferred.await(fixture.blocked)
      yield* Fiber.interrupt(pending)
      expect(fixture.state.calls).toBe(5)
      expect(yield* fixture.checkpoint).toEqual(second)
      // A transient provider failure retries under the shared session policy and its plugin hook.
      fixture.state.hang = false
      const retries: PluginHooks.Domains["session"]["retry"][] = []
      yield* fixture.hooks.register("session", "retry", (event) =>
        Effect.sync(() => {
          retries.push(event)
          event.decision = { retry: true, delay: 0 }
        }),
      )
      fixture.state.flaky = true
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      expect(fixture.state.calls).toBe(7)
      expect(retries).toMatchObject([
        {
          agent: "build",
          attempt: 2,
          error: { type: "provider.rate-limit" },
          decision: { retry: true, delay: 0 },
        },
      ])
      expect(
        SessionProviderContext.decode(yield* fixture.checkpoint).filter((message) => message.role === "user"),
      ).toHaveLength(3)
    }),
  15000,
)

it.live("manual and automatic endpoint compaction keep the provider replacement unchanged", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ endpoint: true })
    yield* fixture.prompt("Original user")
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    yield* fixture.prompt("Later user")
    expect(yield* fixture.overflow).toEqual({ status: "completed" })
    const replacement = SessionProviderContext.decode(yield* fixture.checkpoint)
    expect(replacement[0]?.content).toEqual([Message.text("endpoint retained")])
    expect(JSON.stringify(replacement)).not.toContain("Original user")
    expect(fixture.state.calls).toBe(2)
    expect(fixture.headers[0]?.get("x-http-hook")).toBe("compaction")
    expect(fixture.bodies[0]).toMatchObject({ tools: [expect.objectContaining({ name: "read" })] })
    expect(fixture.bodies[0]).not.toHaveProperty("context_management")
  }),
)

it.live("automatic native failures, interruptions, and overflows retain the checkpoint", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.prompt("Original durable request")
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    const installed = yield* fixture.checkpoint
    yield* fixture.prompt("Recent request")
    fixture.state.failure = true
    expect(yield* fixture.overflow).toMatchObject({ status: "failed", error: { type: "provider.rate-limit" } })
    expect(fixture.state.calls).toBe(2)
    expect(yield* fixture.checkpoint).toEqual(installed)
    fixture.state.failure = false
    fixture.state.hang = true
    const pending = yield* fixture.overflow.pipe(Effect.forkScoped)
    yield* Deferred.await(fixture.blocked)
    yield* Fiber.interrupt(pending)
    expect((yield* fixture.load).messages.at(-1)).toMatchObject({
      type: "compaction",
      status: "failed",
      error: { type: "compaction.interrupted" },
    })
    expect(yield* fixture.checkpoint).toEqual(installed)
    fixture.state.hang = false
    // Overflow retries natively, with the provider's window, and gives up once nothing is left to shrink.
    fixture.state.overflow = true
    expect(yield* fixture.overflow).toMatchObject({ status: "failed", error: { type: "compaction.failed" } })
    expect(fixture.state.calls).toBe(4)
    expect(JSON.stringify(fixture.bodies[3])).toContain("encrypted_1")
    expect(yield* fixture.checkpoint).toEqual(installed)
  }),
)

it.live("compaction hooks supply the summary instead of provider compaction", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.prompt("Original user")
    yield* fixture.hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.result = {
          summary: "## Objective\n- hooked summary",
          providerState: { responseId: "plugin" },
          metadata: { plugin: "custom" },
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        }
      }),
    )
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    expect(fixture.state.calls).toBe(0)
    expect((yield* fixture.load).messages.at(-1)).toMatchObject({
      type: "compaction",
      status: "completed",
      summary: "## Objective\n- hooked summary",
      recent: "[User]: Original user",
      providerState: { responseId: "plugin" },
      metadata: { plugin: "custom" },
      tokens: { input: 10, output: 5 },
    })
  }),
)

it.live("rejects request-hook route rewrites before provider compaction", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.prompt("Original user")
    yield* fixture.hooks.register("session", "model.request", (event) =>
      Effect.sync(() => {
        event.baseURL = "https://another.example/v1"
      }),
    )
    expect(yield* fixture.compact).toMatchObject({
      status: "failed",
      error: { type: "provider.unsupported-operation" },
    })
    expect(fixture.state.calls).toBe(0)
  }),
)

test("retained user budget counts attachments and drops whole oldest messages", () => {
  const model = SessionRunnerModel.resolved(OpenAI.responses("gpt-5.4-mini"), {
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
  const user = (text: string) =>
    SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text,
      time: { created: DateTime.makeUnsafe(0) },
    })
  const newest = {
    ...user("x".repeat(63_000 * 4)),
    files: [{ mime: "image/png", data: "aGVsbG8=", source: { type: "inline" as const } }],
  }
  expect(SessionCompaction.recentUserMessages([user("old"), newest], model, 64_000)).toEqual([])
  expect(
    SessionCompaction.recentUserMessages([user("x".repeat(63_000 * 4)), { ...newest, text: "new" }], model, 64_000),
  ).toHaveLength(1)
})
