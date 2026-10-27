import { expect } from "bun:test"
import { LanguageModel, LLM, LLMEvent } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStep } from "@opencode/core/session/runner/step"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { ToolOutput } from "@opencode/core/tool-output"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionModelObservation } from "@opencode/core/session/model-observation"
import type { SessionModelObserved } from "@opencode/plugin/effect/session"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { createLedger } from "../../plus/src/monitor/ledger.js"
import { watchMonitor } from "../../plus/src/monitor/plugin.js"
import { context } from "../../plus/test/harness.js"

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node, PluginHooks.node]), [
      Bus.node.replace(Bus.configured({ persist: true })),
    ]),
    TestLLM.testLayer(),
  ),
)

for (const fixture of [
  { finish: "stop", toolChoice: undefined },
  { finish: "content-filter", toolChoice: undefined },
  { finish: "stop", toolChoice: "none" },
] as const) {
  it.effect(`settles ${fixture.finish} with tool choice ${fixture.toolChoice ?? "default"}`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const llm = yield* TestLLM.Test
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      const start = Snapshot.ID.make("before")
      const end = Snapshot.ID.make("after")
      const files = [RelativePath.make("changed.ts")]
      let captures = 0
      let executions = 0
      const steps = yield* SessionStep.make.pipe(
        Effect.provide(
          Layer.mock(Snapshot.Service)({
            capture: () => Effect.sync(() => (captures++ === 0 ? start : end)),
            files: (input) => {
              expect(input).toEqual({ from: start, to: end })
              return Effect.succeed(files)
            },
          }),
        ),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
        .run()
      const model = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 100_000, output: 1_000 },
          cost: [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(2),
              cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
            },
          ],
        },
      )
      const hooks = yield* PluginHooks.Service
      const observed: SessionModelObserved[] = []
      yield* hooks.register("session", "model.observed", () => Effect.die("PRIVATE OBSERVER FAILURE"))
      yield* hooks.register("session", "model.observed", (event) => Effect.sync(() => { observed.push(event) }))
      const ledger = yield* Effect.acquireRelease(Effect.sync(() => createLedger(":memory:")), (ledger) => Effect.sync(() => ledger.close()))
      yield* watchMonitor(context({ session: { hook: (name, callback, options) => hooks.register("session", name, callback, options) } }), () => undefined, () => ledger)
      yield* llm.push(
        TestLLM.complete(
          {
            reason: { normalized: fixture.finish },
            usage: {
              inputTokens: 15,
              outputTokens: 6,
              nonCachedInputTokens: 10,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
              reasoningTokens: 2,
              provenance: { inputTokens: { source: "reported", completeness: "complete" }, cacheReadInputTokens: { source: "reported", completeness: "complete" } },
            },
          },
          LLMEvent.toolCall({ id: "call-test", name: "test", input: {} }),
        ),
      )
      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            observer: SessionModelObservation.make(hooks, { sessionID, agent: Agent.defaultID, model: model.ref, kind: "primary" }, model.cost),
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Run one tool", toolChoice: fixture.toolChoice }),
            options: {},
            executeTool: () =>
              Effect.sync(() => {
                executions++
                return { content: [{ type: "text", text: "Completed tool" }] }
              }),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 2, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(fixture.finish === "stop")
      expect(executions).toBe(fixture.toolChoice === "none" ? 0 : 1)
      if (Exit.isSuccess(result))
        expect(result.value).toEqual(
          SessionStep.Outcome.Completed({ needsContinuation: fixture.toolChoice !== "none" }),
        )
      expect(yield* llm.requests()).toHaveLength(1)
      expect(observed).toHaveLength(1)
      expect(observed[0]).toMatchObject({ operationID: assistantMessageID, messageID: assistantMessageID, usage: { inputTokens: 15, cacheReadInputTokens: 3, completeness: "final" } })
      expect(Object.isFrozen(observed[0])).toBe(true)
      expect(ledger.getRequests(sessionID)).toHaveLength(1)
      expect(ledger.getRequests(sessionID)[0]?.observation).toMatchObject({ scope: "invocation", inputTokens: 15, cacheReadInputTokens: 3 })
      expect(ledger.getRequests(sessionID)[0]).toMatchObject({ inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 2 })
      expect(captures).toBe(2)
      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
      expect(message?.data).toMatchObject({
        finish: fixture.finish,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
        snapshot: { start, end, files },
        content: [{ type: "tool", state: { status: fixture.toolChoice === "none" ? "error" : "completed" } }],
      })
      expect(message?.data).toHaveProperty("cost", expect.closeTo(0.0000233, 10))
      const events = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      const types = events.map((event) => event.type)
      const terminal = fixture.finish === "stop" ? "session.step.ended.1" : "session.step.failed.1"
      expect(types.filter((type) => type === "session.step.streamed.1")).toHaveLength(1)
      expect(types.filter((type) => type === terminal)).toHaveLength(1)
      expect(types.indexOf("session.step.streamed.1")).toBeLessThan(types.indexOf(terminal))
      expect(
        types.indexOf(fixture.toolChoice === "none" ? "session.tool.failed.2" : "session.tool.success.2"),
      ).toBeLessThan(types.indexOf(terminal))
    }),
  )
}

it.effect("bounds an oversized tool failure before publishing it", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const output = yield* ToolOutput.Service
    yield* output.transform((editor) => editor.configure({ maxLines: 100, maxBytes: 1_000 }))
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(Snapshot.ID.make("start")),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
      .run()
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 100_000, output: 1_000 },
        cost: [],
      },
    )
    const hooks = yield* PluginHooks.Service
    yield* llm.push(
      TestLLM.complete(
        { reason: { normalized: "stop" } },
        LLMEvent.toolCall({ id: "call-test", name: "test", input: {} }),
      ),
    )
    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          observer: SessionModelObservation.make(
            hooks,
            { sessionID, agent: Agent.defaultID, model: model.ref, kind: "primary" },
            model.cost,
          ),
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Run one tool" }),
          options: {},
          executeTool: () => Effect.fail(new Tool.Error({ message: "x".repeat(20_000) })),
        },
        retry: () => Effect.succeed({ retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)
    expect(Exit.isSuccess(result)).toBe(true)

    const failed = yield* db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.type, "session.tool.failed.2"))
      .get()
    const message = (failed?.data as { error?: { message?: string } } | undefined)?.error?.message ?? ""
    expect(message.length).toBeLessThan(2_000)
    expect(message).toStartWith("x".repeat(1_000))
    expect(message).toContain("full output saved to")
  }),
)

it.effect("streams before the start snapshot exists and runs a local tool only after it is recorded", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const start = Snapshot.ID.make("before")
    const end = Snapshot.ID.make("after")
    const captured = yield* Deferred.make<void>()
    let captures = 0
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => (captures++ === 0 ? Deferred.await(captured).pipe(Effect.as(start)) : Effect.succeed(end)),
          files: () => Effect.succeed([RelativePath.make("changed.ts")]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
      .run()
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
      { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 100_000, output: 1_000 }, cost: [] },
    )
    const hooks = yield* PluginHooks.Service
    const types = () =>
      db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.map((rows) => rows.map((row) => row.type)))
    const atExecution: string[][] = []
    yield* llm.push(
      TestLLM.complete({ reason: { normalized: "stop" } }, LLMEvent.toolCall({ id: "call-test", name: "test", input: {} })),
    )
    const attempt = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          observer: SessionModelObservation.make(hooks, { sessionID, agent: Agent.defaultID, model: model.ref, kind: "primary" }, model.cost),
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Run one tool" }),
          options: {},
          executeTool: () =>
            types().pipe(
              Effect.orDie,
              Effect.map((seen) => {
                atExecution.push(seen)
                return { content: [{ type: "text" as const, text: "Completed tool" }] }
              }),
            ),
        },
        retry: () => Effect.succeed({ retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.forkChild({ startImmediately: true }))

    // The step starts while the start capture is still running, and its tool waits for it.
    let seen: string[] = []
    for (let tries = 0; tries < 1_000 && !seen.includes("session.step.started.1"); tries++) {
      yield* Effect.yieldNow
      seen = yield* types()
    }
    expect(seen).toContain("session.step.started.1")
    expect(seen).not.toContain("session.step.snapshotted.1")
    expect(atExecution).toEqual([])

    yield* Deferred.succeed(captured, undefined)
    expect(Exit.isSuccess(yield* Fiber.await(attempt))).toBe(true)
    expect(atExecution).toHaveLength(1)
    expect(atExecution[0]).toContain("session.step.snapshotted.1")
    const message = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantMessageID)).get()
    expect(message?.data).toMatchObject({ snapshot: { start, end } })
  }),
)
