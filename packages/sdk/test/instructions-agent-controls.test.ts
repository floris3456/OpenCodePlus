import { afterAll, beforeAll, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LLMClient } from "@opencode/ai"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { refuseNetwork, testEffect } from "../../core/test/lib/effect"

const it = testEffect(Layer.empty)
const sandbox = { root: "", previous: new Map<string, string | undefined>() }
const targetID = Agent.ID.make("controls-probe")
const agentRow = "agent:project:controls-probe"
const modeRow = "item:project:controls-probe:setting:mode"
const strategyRow = "item:project:controls-probe:compaction:strategy"
const modelRow = "item:project:controls-probe:compaction:model"
const instructionsRow = "item:project:controls-probe:compaction:instructions"
const marker = "COMPACTION_HOST_SENTINEL: retain the unresolved integration decision"
const activeModel = Model.Ref.parse("fixture/active")
const compactModel = Model.Ref.parse("fixture/summary")

// Plus reads these paths directly; an SDK Global override alone does not isolate it.
// Keep one file-owned home until all scoped hosts have closed, including on failure.
beforeAll(async () => {
  sandbox.root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-instructions-agent-controls-"))
  const env = {
    HOME: path.join(sandbox.root, "home"),
    OPENCODE_TEST_HOME: path.join(sandbox.root, "home"),
    OPENCODE_CONFIG_DIR: path.join(sandbox.root, "config"),
    XDG_CONFIG_HOME: path.join(sandbox.root, "xdg-config"),
    XDG_DATA_HOME: path.join(sandbox.root, "data"),
    XDG_CACHE_HOME: path.join(sandbox.root, "cache"),
    XDG_STATE_HOME: path.join(sandbox.root, "state"),
    TMPDIR: path.join(sandbox.root, "tmp"),
  }
  for (const [key, value] of Object.entries(env)) {
    sandbox.previous.set(key, process.env[key])
    process.env[key] = value
  }
  await Promise.all(Object.values(env).map((directory) => fs.mkdir(directory, { recursive: true })))
})

afterAll(async () => {
  for (const [key, value] of sandbox.previous) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (sandbox.root) await fs.rm(sandbox.root, { recursive: true, force: true })
})

const fixture = Effect.gen(function* () {
  // Load the host after installing the isolated environment. Explicit Global paths
  // also protect against modules cached by another SDK test in the same process.
  const { OpenCode, AbsolutePath, Location } = yield* Effect.promise(() => import("../src/effect"))
  const { Global } = yield* Effect.promise(() => import("@opencode/util/global"))
  const { llmClient } = yield* Effect.promise(() => import("@opencode/core/effect/app-node-platform"))
  const { httpClient } = yield* Effect.promise(() => import("@opencode/util/effect/app-node-platform"))
  const { Plus } = yield* Effect.promise(() => import("../../plus/src/rpc"))
  const directory = yield* Effect.promise(() => fs.mkdtemp(path.join(sandbox.root, "project-")))
  const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
  const llm = yield* TestLLM.Test.pipe(
    Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("fixture ready", "fixture-answer") })),
  )
  const violations: string[] = []
  yield* Effect.addFinalizer(() => Effect.sync(() => expect(violations).toEqual([])))
  const model = {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200_000, output: 8_192 },
  }
  const opencode = yield* OpenCode.create(
    {
      database: { path: ":memory:" },
      events: { persist: true },
      config: {
        directory: path.join(sandbox.root, "config"),
        project: false,
        content: JSON.stringify({
          model: "fixture/active",
          // The host-injected definition avoids reading ancestor configuration.
          // agent.create below supplies its real, editable project file and preset.
          agents: { "controls-probe": { mode: "primary" } },
          providers: {
            fixture: {
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: { baseURL: "https://fixture.invalid/v1" },
              models: { active: model, summary: model },
            },
          },
        }),
      },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    },
    {
      overrides: [
        Global.node.replace(
          Global.layerWith({
            home: path.join(sandbox.root, "home"),
            config: path.join(sandbox.root, "config"),
            data: path.join(sandbox.root, "data"),
            cache: path.join(sandbox.root, "cache"),
            state: path.join(sandbox.root, "state"),
            tmp: path.join(sandbox.root, "tmp"),
            bin: path.join(sandbox.root, "cache", "bin"),
            log: path.join(sandbox.root, "data", "log"),
            repos: path.join(sandbox.root, "data", "repos"),
          }),
        ),
        llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
        httpClient.replace(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, refuseNetwork(violations)))),
        ),
      ],
    },
  )
  yield* opencode.plugin.awaitActivation({ location })
  const plus = opencode.rpc(Plus.Definition)
  yield* plus["project.enable"](undefined, { location })
  yield* plus["agent.create"]({ scope: "project", id: targetID, preset: { kind: "agent", id: "build" } }, { location })
  expect((yield* opencode.agent.get({ location, agentID: targetID })).data.mode).toBe("primary")
  const caller = yield* opencode.sessions.create({
    location,
    agent: Agent.ID.make("build"),
    model: activeModel,
    title: "Instructions control caller",
  })
  const target = yield* opencode.sessions.create({
    location,
    agent: targetID,
    model: activeModel,
    title: "Instructions controlled session",
  })
  const tool = Effect.fn("agentControls.tool")(function* (name: string, input: Record<string, unknown>) {
    const id = `call_${crypto.randomUUID()}`
    yield* llm.push(TestLLM.tool(id, name, input), TestLLM.text("done", `text_${id}`))
    yield* opencode.sessions.prompt({ sessionID: caller.id, text: `Run fixture tool ${id}` })
    yield* opencode.sessions.wait({ sessionID: caller.id }).pipe(Effect.timeout("10 seconds"))
    const messages = yield* opencode.sessions.context({ sessionID: caller.id })
    const part = messages
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .find((part) => part.type === "tool" && part.id === id)
    if (!part || part.type !== "tool") throw new Error(`Missing production tool result: ${name} ${id}`)
    return part.state
  })
  const instructions = Effect.fn("agentControls.instructions")(function* (
    method: "set" | "reset" | "show",
    input: Record<string, unknown>,
  ) {
    const state = yield* tool("execute", {
      code: `return await tools.instructions.${method}(${JSON.stringify(input)})`,
    })
    expect(state.status).toBe("completed")
    if (state.status !== "completed") throw new Error(`Instructions ${method} failed: ${JSON.stringify(state)}`)
    const text = state.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    // Code Mode can complete normally while a nested Instructions call failed.
    expect(state.metadata?.error, `Instructions ${method}: ${text}`).not.toBe(true)
    expect(state.metadata?.toolCalls).toEqual([expect.objectContaining({ status: "completed" })])
    return text
  })
  expect(yield* instructions("show", { id: "item:project:controls-probe:system:role" })).toContain(targetID)
  return { opencode, plus, location, llm, caller, target, tool, instructions }
})

it.live(
  "Instructions off prohibits host execution and launch, remains editable, and re-enables",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      expect(yield* f.opencode.sessions.generate({ sessionID: f.target.id, prompt: "Before disabling" })).toEqual({
        text: "fixture ready",
      })
      yield* f.instructions("set", { id: agentRow, state: "off" })
      expect((yield* f.opencode.agent.list({ location: f.location })).data.map((agent) => agent.id)).not.toContain(
        targetID,
      )
      expect(yield* f.opencode.agent.get({ location: f.location, agentID: targetID }).pipe(Effect.flip)).toMatchObject({
        _tag: "AgentNotFoundError",
      })
      expect((yield* f.plus["instructions.snapshot"](undefined, { location: f.location })).agents).toContainEqual(
        expect.objectContaining({ id: targetID, scope: "project" }),
      )
      expect(yield* f.instructions("show", { id: "item:project:controls-probe:system:role" })).toContain(targetID)

      // Existing OpenCode semantics admit explicit agent IDs. Off removes UI availability
      // and prohibits execution; it does not change switchAgent/create admission here.
      yield* f.opencode.sessions.switchAgent({ sessionID: f.target.id, agent: targetID })
      const before = (yield* f.llm.requests()).length
      expect(
        yield* f.opencode.sessions.generate({ sessionID: f.target.id, prompt: "Must not run" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServiceUnavailableError", message: 'Agent not found: "controls-probe"' })
      expect((yield* f.llm.requests()).length).toBe(before)
      expect(
        yield* f.tool("subagent", { agent: targetID, description: "disabled probe", prompt: "Must not run" }),
      ).toMatchObject({
        status: "error",
        error: { type: "tool.execution", message: "Unknown agent: controls-probe" },
      })
      expect((yield* f.opencode.sessions.list({ parentID: f.caller.id })).data).toEqual([])

      // The disabled owner remains editable, including across a publish.
      yield* f.instructions("set", { id: agentRow, mode: "all" })
      yield* f.instructions("set", { id: agentRow, state: "on" })
      expect((yield* f.opencode.agent.get({ location: f.location, agentID: targetID })).data.mode).toBe("all")
      expect((yield* f.opencode.agent.list({ location: f.location })).data.map((agent) => agent.id)).toContain(targetID)
      expect(yield* f.opencode.sessions.generate({ sessionID: f.target.id, prompt: "After re-enabling" })).toEqual({
        text: "fixture ready",
      })
      yield* f.instructions("set", { id: agentRow, state: "off" })
      yield* f.instructions("reset", { id: agentRow })
      // Reset on an owner clears its current-level settings/compaction group.
      expect((yield* f.opencode.agent.get({ location: f.location, agentID: targetID })).data.mode).toBe("primary")
    }),
  45_000,
)

it.live(
  "Instructions modes reach the host and primary mode forbids the production subagent tool",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      for (const mode of ["all", "subagent", "primary"] as const) {
        yield* f.instructions("set", { id: modeRow, text: mode })
        expect((yield* f.opencode.agent.get({ location: f.location, agentID: targetID })).data.mode).toBe(mode)
      }
      expect(
        yield* f.tool("subagent", { agent: targetID, description: "primary probe", prompt: "Must not run" }),
      ).toMatchObject({
        status: "error",
        error: { type: "tool.execution", message: "Agent controls-probe cannot run as a subagent" },
      })
      expect((yield* f.opencode.sessions.list({ parentID: f.caller.id })).data).toEqual([])
      yield* f.instructions("set", { id: modeRow, text: "all" })
      yield* f.instructions("reset", { id: modeRow })
      expect((yield* f.opencode.agent.get({ location: f.location, agentID: targetID })).data.mode).toBe("primary")
    }),
  45_000,
)

it.live(
  "Instructions compaction overrides reach host metadata and the local summary request; reset inherits",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.instructions("set", { id: strategyRow, text: "local" })
      const defaults = (yield* f.opencode.agent.get({ location: f.location, agentID: targetID })).data.compaction
      expect(defaults?.model).toBeUndefined()
      yield* f.instructions("set", { id: modelRow, text: "fixture/summary" })
      yield* f.instructions("set", { id: instructionsRow, text: marker })
      expect((yield* f.opencode.agent.get({ location: f.location, agentID: targetID })).data.compaction).toEqual({
        strategy: "local",
        model: compactModel,
        system: marker,
      })
      yield* f.opencode.sessions.prompt({
        sessionID: f.target.id,
        text: "Remember the unresolved integration decision",
      })
      yield* f.opencode.sessions.wait({ sessionID: f.target.id })
      const selected = (yield* f.opencode.sessions.get({ sessionID: f.target.id })).model
      expect(selected).toMatchObject(activeModel)
      const before = (yield* f.llm.requests()).length
      yield* f.llm.push(TestLLM.text("## Objective\n- Keep the integration decision", "explicit-summary"))
      yield* f.opencode.sessions.compact({ sessionID: f.target.id })
      yield* f.opencode.sessions.wait({ sessionID: f.target.id })
      const requests = (yield* f.llm.requests()).slice(before)
      expect(requests).toHaveLength(1)
      expect(requests[0].model).toMatchObject({ provider: "fixture", id: "summary" })
      expect(requests[0].system.map((part) => part.text)).toContain(marker)
      expect(yield* f.opencode.sessions.context({ sessionID: f.target.id })).toContainEqual(
        expect.objectContaining({ type: "compaction", status: "completed", model: compactModel }),
      )
      expect((yield* f.opencode.sessions.get({ sessionID: f.target.id })).model).toEqual(selected)

      yield* f.instructions("reset", { id: modelRow })
      yield* f.instructions("reset", { id: instructionsRow })
      const reset = (yield* f.opencode.agent.get({ location: f.location, agentID: targetID })).data.compaction
      expect(reset?.model).toBeUndefined()
      // The linked preset may supply an explicit empty system; reset restores inheritance.
      expect(reset?.system).toBe(defaults?.system)
      expect(reset?.strategy).toBe("local")
      yield* f.opencode.sessions.prompt({
        sessionID: f.target.id,
        text: "A further decision after resetting local overrides",
      })
      yield* f.opencode.sessions.wait({ sessionID: f.target.id })
      const inheritedBefore = (yield* f.llm.requests()).length
      yield* f.llm.push(TestLLM.text("## Objective\n- Inherited model summary", "inherited-summary"))
      yield* f.opencode.sessions.compact({ sessionID: f.target.id })
      yield* f.opencode.sessions.wait({ sessionID: f.target.id })
      const inherited = (yield* f.llm.requests()).slice(inheritedBefore)
      expect(inherited).toHaveLength(1)
      expect(inherited[0].model).toMatchObject({ provider: "fixture", id: "active" })
      expect(inherited[0].system.map((part) => part.text)).not.toContain(marker)
      yield* f.instructions("reset", { id: strategyRow })
      expect(
        (yield* f.opencode.agent.get({ location: f.location, agentID: targetID })).data.compaction?.strategy ?? "auto",
      ).toBe("auto")
    }),
  45_000,
)
