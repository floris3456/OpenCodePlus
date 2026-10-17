import { expect } from "bun:test"
import { GenerationOptions, LanguageModel, Message, SystemPart, ToolDefinition, type LLMRequest } from "@opencode/ai"
import { AnthropicMessages, OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { EventTable } from "@opencode/core/event/sql"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Instance } from "@opencode/core/instance/service"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionContext } from "@opencode/core/session/context"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionGenerate } from "@opencode/core/session/generate"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import {
  InstructionBlobTable,
  InstructionStateTable,
  SessionInboxTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { asc } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

class Fixture extends Context.Service<Fixture, { instruction: string }>()("test/WarmingPrefix") {}
const fixtureLayer = Layer.sync(Fixture, () => ({ instruction: "Initial instructions" }))
const models = {
  openai: LanguageModel.make({ id: "warming-model", provider: "fake", route: OpenAIChat.route }),
  // The Anthropic route accepts a zero-token pre-warm.
  anthropic: LanguageModel.make({ id: "claude-opus-5-5", provider: "fake", route: AnthropicMessages.route }),
}
const selected = { model: models.openai }
const scripted = TestLLM.layer({ fallback: [] })
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      Agent.node,
      SessionProjector.node,
      SessionStore.node,
      SessionContext.node,
      SessionRunnerLLM.node,
      PluginHooks.node,
      llmClient,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(TestLLM.clientLayer.pipe(Layer.provide(scripted))),
      SessionRunnerModel.node.replace(
        Layer.mock(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(selected.model, {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                cost: [],
                limit: { context: 200_000, output: 32_000 },
              }),
            ),
        }),
      ),
      InstructionBuiltIns.node.replace(
        Layer.effect(
          InstructionBuiltIns.Service,
          Effect.gen(function* () {
            const fixture = yield* Fixture
            return InstructionBuiltIns.Service.of({
              load: () =>
                Effect.succeed(
                  Instructions.make({
                    key: Instructions.Key.make("test/warming"),
                    codec: Schema.toCodecJson(Schema.String),
                    read: Effect.sync(() => fixture.instruction),
                    render: { initial: String, changed: (_previous, current) => current },
                  }),
                ),
            })
          }),
        ).pipe(Layer.provide(fixtureLayer)),
      ),
      InstructionDiscovery.node.replace(
        Layer.mock(InstructionDiscovery.Service, {
          project: true,
          global: true,
          load: () => Effect.succeed(Instructions.empty),
        }),
      ),
      SkillInstructions.node.replace(
        Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      ReferenceInstructions.node.replace(
        Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      McpInstructions.node.replace(
        Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      Snapshot.node.replace(Snapshot.noopLayer),
      PluginSupervisor.node.replace(Layer.empty),
      Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
      Tool.node.replace(
        Layer.mock(Tool.Service, {
          snapshot: () =>
            Effect.succeed({
              definitions: [
                ToolDefinition.make({ name: "echo", description: "Echo", inputSchema: { type: "object" } }),
              ],
              execute: () => Effect.succeed({ content: [{ type: "text", text: "tool result" }], metadata: {} }),
            }),
        }),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ).pipe(Layer.provideMerge(fixtureLayer), Layer.provideMerge(scripted)),
)

// Compare in wire-prefix order and name the first differing part, not just the whole request.
function expectPrefix(ping: LLMRequest, primary: LLMRequest, prewarmed: boolean) {
  expect(ping.tools, "tools (first prefix section)").toEqual(primary.tools)
  expect(ping.system, "system parts").toEqual(primary.system)
  const history = ping.messages.slice(0, -1)
  const next = primary.messages.slice(0, -1)
  expect(history.length, "history message count").toBe(next.length)
  history.forEach((message, index) =>
    expect(message, `history message ${index}: role, parts, metadata and text`).toEqual(next[index]),
  )
  expect(ping.messages.at(-1), "ping is appended after preparation").toEqual(Message.user("Keep this cache warm."))
  expect(primary.messages.at(-1)?.content).toEqual([Message.text("Primary: Continue with a new user message")])
  if (prewarmed)
    expect(ping.generation, "a pre-warm asks for no output").toEqual(
      GenerationOptions.make({ ...primary.generation, maxTokens: 0 }),
    )
  else expect(ping.generation, "primary output budgeting").toEqual(primary.generation)
}

for (const scenario of ["plain", "compaction checkpoint", "instruction update", "anthropic pre-warm"] as const) {
  it.effect(
    `warming preserves the next primary prefix: ${scenario}`,
    () =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const bus = yield* Bus.Service
        const projects = yield* Project.Service
        const agents = yield* Agent.Service
        const context = yield* SessionContext.Service
        const store = yield* SessionStore.Service
        const runner = yield* SessionRunner.Service
        const llm = yield* TestLLM.Service
        const fixture = yield* Fixture
        const hooks = yield* PluginHooks.Service
        selected.model = scenario === "anthropic pre-warm" ? models.anthropic : models.openai
        const sessionID = SessionSchema.ID.create()
        yield* agents.transform((editor) =>
          editor.update(Agent.ID.make("build"), (agent) => {
            agent.mode = "primary"
          }),
        )
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
            slug: "warming",
            directory: "/project",
            title: "Warming prefix",
            version: "test",
            agent: Agent.ID.make("build"),
          })
          .run()
          .pipe(Effect.orDie)
        // Content-changing hooks must run for warming too. A generate-only hook is a negative control.
        const durables: Array<boolean | undefined> = []
        yield* hooks.register("session", "context", (event) =>
          Effect.sync(() => {
            durables.push(event.durable)
            event.tools.echo.description = "Primary echo description"
            event.system.push(SystemPart.make("Primary system suffix"))
            event.messages = event.messages.map((message) =>
              Message.make({
                ...message,
                content: message.content.map((part) =>
                  part.type === "text" ? { ...part, text: `Primary: ${part.text}` } : part,
                ),
              }),
            )
          }),
        )
        let generates = 0
        yield* hooks.register("session", "generate", () =>
          Effect.sync(() => {
            generates++
          }),
        )
        const prompt = (text: string) =>
          Effect.gen(function* () {
            yield* bus.publish(SessionEvent.InboxEnqueued, {
              sessionID,
              inboxID: SessionMessage.ID.create(),
              item: { type: "user", payload: { text }, delivery: "steer" },
            })
            expect((yield* runner.drain({ sessionID, force: false }))._tag).toBe("Complete")
          })
        yield* llm.push(TestLLM.tool("echo-call", "echo", {}), TestLLM.text("Answer after tool", "answer"))
        yield* prompt("Call the tool, then answer")
        expect(llm.requests).toHaveLength(2)
        if (scenario === "compaction checkpoint") {
          const inputID = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, inputID, reason: "manual", recent: "" })
          yield* bus.publish(SessionEvent.Compaction.Ended, {
            sessionID,
            text: "The tool returned a result.",
            recent: "",
            reason: "manual",
          })
        }
        if (scenario === "instruction update") {
          fixture.instruction = "Previously committed instruction update"
          yield* InstructionState.prepare(db, bus, (yield* context.select(sessionID)).instructions, sessionID)
          fixture.instruction = "Changed instructions before warming"
        }
        const durable = () =>
          Effect.all({
            events: db.select().from(EventTable).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie),
            messages: db
              .select()
              .from(SessionMessageTable)
              .orderBy(asc(SessionMessageTable.seq))
              .all()
              .pipe(Effect.orDie),
            inbox: db.select().from(SessionInboxTable).all().pipe(Effect.orDie),
            instructions: db.select().from(InstructionStateTable).all().pipe(Effect.orDie),
            blobs: db.select().from(InstructionBlobTable).all().pipe(Effect.orDie),
            sessions: db.select().from(SessionTable).all().pipe(Effect.orDie),
          })
        const before = yield* durable()
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die("Missing test session")
        yield* llm.push(TestLLM.text("Warm", "warm"), TestLLM.text("Next answer", "next"))
        // The plain scenario asks for a pre-warm on a route without one: the request stays as it is.
        yield* SessionGenerate.generate({
          session,
          prompt: "Keep this cache warm.",
          prewarm: scenario === "plain" || scenario === "anthropic pre-warm",
        }).pipe(
          Effect.provideService(
            Instance.Service,
            Instance.Service.of({
              provide: () =>
                Effect.provide(
                  Layer.mergeAll(
                    Layer.succeed(SessionContext.Service, context),
                    Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
                  ) as Layer.Layer<Instance.Services>,
                ),
            }),
          ),
        )
        expect(yield* durable(), "warming must not mutate any durable state").toEqual(before)
        yield* prompt("Continue with a new user message")
        expect(llm.requests).toHaveLength(4)
        expectPrefix(llm.requests[2], llm.requests[3], scenario === "anthropic pre-warm")
        expect(generates, "warming must not use a different content hook").toBe(0)
        expect(
          llm.requests[2].cache,
          "warming marks the history boundary so the next real step can read it",
        ).toEqual({ tools: true, system: true, messages: { tail: 2 } })
        expect(llm.requests[3].cache, "a real step keeps the default cache policy").toBeUndefined()
        expect(durables, "only the warming request is non-durable").toEqual([undefined, undefined, false, undefined])
        if (scenario === "plain") {
          expect(llm.requests[2].messages.some((message) => message.role === "tool")).toBe(true)
          expect(JSON.stringify(llm.requests[2].messages)).toContain("tool result")
        }
        if (scenario === "compaction checkpoint")
          expect(JSON.stringify(llm.requests[2].messages)).toContain("The tool returned a result.")
        if (scenario === "instruction update") {
          expect(JSON.stringify(llm.requests[2].messages)).toContain("Previously committed instruction update")
          expect(JSON.stringify(llm.requests[2].messages)).toContain("Changed instructions before warming")
        }
      }),
    { timeout: 15_000 },
  )
}
