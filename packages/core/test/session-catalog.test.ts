import { describe, expect } from "bun:test"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { AISDK } from "@opencode/core/aisdk"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { FileSystem } from "@opencode/core/filesystem"
import { FSUtil } from "@opencode/util/fs-util"
import { Form } from "@opencode/core/form"
import { Generate } from "@opencode/core/generate"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Integration } from "@opencode/core/integration"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Mcp } from "@opencode/core/mcp/index"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Npm } from "@opencode/util/npm"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Reference } from "@opencode/core/reference"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { Rpc } from "@opencode/core/rpc"
import { Session } from "@opencode/core/session"
import { SessionContext } from "@opencode/core/session/context"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { Vcs } from "@opencode/core/vcs"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { WebSearch } from "@opencode/core/websearch"
import { Worktree } from "@opencode/core/worktree"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { readInitial, readUpdate } from "./lib/instructions"
import { tempLocationLayer } from "./fixture/location"
import { emptyMcpLayer } from "./fixture/mcp"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: "", name }),
    resolve: (name) => Effect.succeed({ directory: "", name }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: "", name }),
    which: () => Effect.undefined,
  }),
)

const generateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))

const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    rules: () => Effect.succeed([]),
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
    close: Effect.void,
  }),
)

const testLayer = AppNodeBuilder.build(
  LayerNode.group([
    AppProcess.node,
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    Bus.node,
    Form.node,
    Generate.node,
    InstructionDiscovery.node,
    LayerNodePlatform.httpClient,
    Plugin.node,
    Agent.node,
    AISDK.node,
    Command.node,
    Integration.node,
    KV.node,
    Mcp.node,
    Session.node,
    PersistentPty.node,
    LocationServiceMap.node,
    Permission.node,
    PluginHooks.node,
    Reference.node,
    Rpc.node,
    Skill.node,
    SkillDiscovery.node,
    Tool.node,
    Vcs.node,
    Watcher.node,
    WebSearch.node,
    Worktree.node,
    SessionContext.node,
    InstructionBuiltIns.node,
    InstructionEntry.node,
    SkillInstructions.node,
    ReferenceInstructions.node,
    McpInstructions.node,
    McpTool.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
  ]),
  [
    Location.node.replace(tempLocationLayer),
    Npm.node.replace(npmLayer),
    Config.node.replace(Config.testLayer()),
    Mcp.node.replace(emptyMcpLayer),
    Generate.node.replace(generateLayer),
    Permission.node.replace(permissionLayer),
  ],
)

const it = testEffect(testLayer)

const buildID = Agent.ID.make("build")
const planID = Agent.ID.make("plan")

const setupAgents = Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(buildID, (agent) => {
      agent.mode = "primary"
    })
    editor.update(planID, (agent) => {
      agent.mode = "primary"
    })
  })
})

const setupTools = Effect.gen(function* () {
  const registry = yield* Tool.Service
  yield* registry.transform((editor) => {
    editor.add({
      name: "lookup",
      description: "Look up an order",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.String,
      execute: () => Effect.succeed({ output: "order" }),
      options: { namespace: "orders" },
    })
    editor.add({
      name: "echo",
      description: "Echo text",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.String,
      execute: () => Effect.succeed({ output: "echo" }),
      options: { namespace: "notes" },
    })
  })
  const registration = yield* McpTool.Service
  yield* registration.flush
})

const createSession = (agent: Agent.ID) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const location = yield* Location.Service
    return yield* session.create({ location: Location.Ref.make({ directory: location.directory }), agent })
  })

const codemodeSource = (selection: SessionContext.Selection) =>
  selection.instructions.filter((source) => source.key === "core/codemode")

const codemodeText = (selection: SessionContext.Selection) =>
  Effect.gen(function* () {
    const initial = yield* readInitial(codemodeSource(selection))
    return initial.text
  })

describe("SessionContext catalog hook", () => {
  it.effect("renders per-agent catalogs with isolated pins", () =>
    Effect.gen(function* () {
      yield* setupAgents
      yield* setupTools
      const hooks = yield* PluginHooks.Service
      const context = yield* SessionContext.Service
      yield* hooks.register("session", "catalog", (event) =>
        Effect.sync(() => {
          if (event.agent === planID) {
            const current = event.tools["orders.lookup"]
            if (current) event.tools["orders.lookup"] = { description: "Plan-only lookup", pinned: true }
          }
        }),
      )
      const buildSession = yield* createSession(buildID)
      const planSession = yield* createSession(planID)
      const buildSelection = yield* context.select(buildSession.id)
      const planSelection = yield* context.select(planSession.id)
      const buildText = yield* codemodeText(buildSelection)
      const planText = yield* codemodeText(planSelection)
      expect(planText).toContain("Plan-only lookup")
      expect(buildText).toContain("Look up an order")
      expect(buildText).not.toContain("Plan-only lookup")
      expect(planText).not.toBe(buildText)
    }),
  )

  it.effect("ignores added keys and restores deleted keys", () =>
    Effect.gen(function* () {
      yield* setupAgents
      yield* setupTools
      const hooks = yield* PluginHooks.Service
      const context = yield* SessionContext.Service
      yield* hooks.register("session", "catalog", (event) =>
        Effect.sync(() => {
          event.tools["orders.invented"] = { description: "Invented", pinned: false }
          delete event.tools["notes.echo"]
        }),
      )
      const session = yield* createSession(buildID)
      const selection = yield* context.select(session.id)
      const text = yield* codemodeText(selection)
      expect(text).not.toContain("Invented")
      expect(text).toContain("Echo text")
      const registry = yield* Tool.Service
      const snapshot = yield* registry.snapshot()
      const expected = yield* readInitial(CodeModeInstructions.make(snapshot.codeModeCatalog))
      const actual = yield* readInitial(codemodeSource(selection))
      expect(actual.text).toBe(expected.text)
    }),
  )

  it.effect("switching the agent produces an instruction update", () =>
    Effect.gen(function* () {
      yield* setupAgents
      yield* setupTools
      const hooks = yield* PluginHooks.Service
      const context = yield* SessionContext.Service
      const sessions = yield* Session.Service
      yield* hooks.register("session", "catalog", (event) =>
        Effect.sync(() => {
          if (event.agent === planID) {
            const current = event.tools["orders.lookup"]
            if (current) event.tools["orders.lookup"] = { description: "Plan-only lookup", pinned: false }
          }
        }),
      )
      const session = yield* createSession(buildID)
      const first = yield* context.select(session.id)
      const initial = yield* readInitial(codemodeSource(first))
      yield* sessions.switchAgent({ sessionID: session.id, agent: planID })
      const second = yield* context.select(session.id)
      const updated = yield* readUpdate(codemodeSource(second), initial)
      expect(updated.changed).toBe(true)
      expect(updated.text).toContain("has changed")
      expect(updated.text).toContain("Plan-only lookup")
    }),
  )

  it.effect("compaction and generate paths observe the same catalog as primary", () =>
    Effect.gen(function* () {
      yield* setupAgents
      yield* setupTools
      const hooks = yield* PluginHooks.Service
      const context = yield* SessionContext.Service
      const requests = yield* SessionModelRequest.Service
      yield* hooks.register("session", "catalog", (event) =>
        Effect.sync(() => {
          const current = event.tools["orders.lookup"]
          if (current) event.tools["orders.lookup"] = { description: "Hooked lookup", pinned: false }
        }),
      )
      const session = yield* createSession(buildID)
      const selection = yield* context.select(session.id)
      const model = SessionRunnerModel.resolved(LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }), {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      })
      const observed = yield* readInitial(selection.instructions)
      const initial = Instructions.renderInitialParts(selection.instructions, observed.values)
      const loaded = { ...selection, model, initial, messages: [] as never[] }
      const transcript = SessionModelRequest.baseTranscript({
        agent: loaded.agent.info,
        model: loaded.model,
        tools: loaded.tools,
        initial: loaded.initial,
        messages: loaded.messages,
      })
      const primary = yield* requests.primary({
        session: loaded.session,
        agent: loaded.agent.id,
        model: loaded.model,
        tools: loaded.tools,
        system: transcript.system,
        messages: transcript.messages,
      })
      const compaction = yield* requests.compaction({
        session: loaded.session,
        agent: loaded.agent.id,
        model: loaded.model,
        tools: loaded.tools,
        system: transcript.system,
        messages: transcript.messages,
      })
      const generate = yield* requests.generate({
        session: loaded.session,
        agent: loaded.agent.id,
        model: loaded.model,
        tools: loaded.tools,
        system: transcript.system,
        messages: transcript.messages,
      })
      const text = yield* codemodeText(selection)
      expect(text).toContain("Hooked lookup")
      for (const prepared of [primary, compaction, generate]) {
        const systems = prepared.request.system.map((part) => part.text).join("\n")
        expect(systems).toContain("Hooked lookup")
      }
      expect(primary.request.system.map((part) => part.text)).toEqual(
        compaction.request.system.map((part) => part.text),
      )
      expect(primary.request.system.map((part) => part.text)).toEqual(
        generate.request.system.map((part) => part.text),
      )
    }),
  )

  it.effect("a replaced input shows edited parameters in the catalog and search, and calls keep the tool's own schema", () =>
    Effect.gen(function* () {
      yield* setupAgents
      const registry = yield* Tool.Service
      const received: unknown[] = []
      yield* registry.transform((editor) => {
        editor.add({
          name: "find",
          description: "Find an order",
          input: Schema.Struct({
            id: Schema.String.annotate({ description: "Order id" }),
            verbose: Schema.optional(Schema.Boolean).annotate({ description: "Include the order history" }),
          }),
          output: Schema.String,
          execute: (input) => Effect.sync(() => (received.push(input), { output: "found" })),
          options: { namespace: "orders", pinned: true },
        })
      })
      const hooks = yield* PluginHooks.Service
      const context = yield* SessionContext.Service
      const own: unknown[] = []
      yield* hooks.register("session", "catalog", (event) =>
        Effect.sync(() => {
          const current = event.tools["orders.find"]
          if (current?.input === undefined || event.agent !== planID) return
          own.push(current.input)
          const input = structuredClone(current.input) as { properties: Record<string, { description?: string }> }
          input.properties.id = { ...input.properties.id, description: "The order number" }
          delete input.properties.verbose
          event.tools["orders.find"] = { ...current, input }
        }),
      )
      const plan = yield* context.select((yield* createSession(planID)).id)
      const build = yield* context.select((yield* createSession(buildID)).id)
      const planText = yield* codemodeText(plan)
      expect(own).toHaveLength(1)
      expect(planText).toContain("The order number")
      expect(planText).not.toContain("verbose")
      // Control: another agent, untouched by the hook, keeps the tool's own parameters byte for byte.
      const buildText = yield* codemodeText(build)
      expect(buildText).toContain("Order id")
      expect(buildText).toContain("verbose")
      const plain = yield* registry.snapshot()
      expect(buildText).toBe((yield* readInitial(CodeModeInstructions.make(plain.codeModeCatalog))).text)

      const run = (code: string) =>
        plan.tools.execute({
          sessionID: plan.session.id,
          agent: planID,
          messageID: "msg_catalog_test" as never,
          call: { id: "call_1", name: "execute", input: { code } } as never,
        })
      const searched = yield* run(`return search({ query: "find" })`)
      const found = JSON.stringify(searched.output)
      expect(found).toContain("The order number")
      expect(found).not.toContain("verbose")
      // A call that still passes the hidden parameter reaches the tool unchanged.
      yield* run(`return await tools.orders.find({ id: "7", verbose: true })`)
      expect(received).toEqual([{ id: "7", verbose: true }])
    }),
  )

  it.effect("with no hook the output matches the un-hooked render", () =>
    Effect.gen(function* () {
      yield* setupAgents
      yield* setupTools
      const context = yield* SessionContext.Service
      const session = yield* createSession(buildID)
      const selection = yield* context.select(session.id)
      const registry = yield* Tool.Service
      const snapshot = yield* registry.snapshot()
      const expected = yield* readInitial(CodeModeInstructions.make(snapshot.codeModeCatalog))
      const actual = yield* readInitial(codemodeSource(selection))
      expect(actual.text).toBe(expected.text)
    }),
  )
})
