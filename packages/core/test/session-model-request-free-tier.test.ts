import { describe, expect } from "bun:test"
import { ToolDefinition } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Tool } from "@opencode/core/tool"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// Zen's free tier refuses a request that does not declare the shell and read tools (FreeTierError, "can only be
// used from within OpenCode"): an agent denied the shell must still declare both names. OpenCode's own title
// request is served without tools and refused with them, so it declares none.

const it = testEffect(PluginTestLayer)

const session = Session.Info.make({
  id: Session.ID.make("ses_free_tier"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const price = (input: number) => ({
  input: Money.USDPerMillionTokens.make(input),
  output: Money.USDPerMillionTokens.make(input),
  cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
})
// The catalog names the provider; the route (OpenAI Chat, as Zen's chat models use) does not.
const model = (provider: string, cost: ReturnType<typeof price>[]) => ({
  ...SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "big-pickle" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost,
    limit: { context: 200_000, output: 32_000 },
  }),
  ref: Model.Ref.make({ id: Model.ID.make("big-pickle"), providerID: Provider.ID.make(provider) }),
})
const free = model("opencode", [price(0)])
const executed: string[] = []
// A read-only agent: read and grep, no shell.
const readOnly: Tool.Snapshot = {
  definitions: ["grep", "read"].map((name) =>
    ToolDefinition.make({ name, description: `real ${name}`, inputSchema: { type: "object", properties: {} } }),
  ),
  execute: (input) =>
    Effect.sync(() => {
      executed.push(input.call.name)
      return { output: "ran", metadata: {} } as unknown as Tool.NormalizedResult
    }),
}
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})
const requests = SessionModelRequest.Service.pipe(
  Effect.provide(SessionModelRequest.layer),
  Effect.provideService(SessionModelTransport.Service, transport),
)
const input = { session, agent: Agent.ID.make("reviewer"), system: [], messages: [] }
const call = (name: string) => ({
  sessionID: session.id,
  agent: Agent.ID.make("reviewer"),
  messageID: SessionMessage.ID.make("msg_free_tier"),
  call: { type: "tool-call" as const, id: `call_${name}`, name, input: {} },
})

describe("SessionModelRequest Zen free tier", () => {
  it.effect("a free Zen title request declares no tools: Zen serves OpenCode's title request only without them", () =>
    Effect.gen(function* () {
      const prepared = yield* (yield* requests).title({ ...input, model: free })
      expect(prepared.request.tools).toEqual([])
      expect(prepared.request.toolChoice).toBeUndefined()
    }),
  )

  it.effect("a free Zen request of an agent with no tools declares shell and read, and neither runs", () =>
    Effect.gen(function* () {
      const prepared = yield* (yield* requests).primary({ ...input, model: free })
      expect(prepared.request.tools.map((tool) => tool.name)).toEqual(["shell", "read"])
      // Leaving the tool choice alone: the runner reads "none" as "out of agent steps".
      expect(prepared.request.toolChoice).toBeUndefined()
      const refused = yield* prepared.executeTool(call("read")).pipe(Effect.flip)
      expect(refused.message).toBe('No tool named "read" is available to you. Use a tool from your tool list.')
    }),
  )

  it.effect("an agent without the shell keeps its tools and gains a placeholder that runs nothing", () =>
    Effect.gen(function* () {
      executed.length = 0
      const prepared = yield* (yield* requests).primary({ ...input, model: free, tools: readOnly })
      expect(prepared.request.tools.map((tool) => [tool.name, tool.description])).toEqual([
        ["grep", "real grep"],
        ["read", "real read"],
        ["shell", "Not available to you. Never call this tool."],
      ])
      expect(prepared.request.toolChoice).toBeUndefined()
      const refused = yield* prepared.executeTool(call("shell")).pipe(Effect.flip)
      expect(refused).toBeInstanceOf(Tool.Error)
      expect(refused.message).toBe('No tool named "shell" is available to you. Use a tool from your tool list.')
      // The real read still runs; the placeholder never reached the tool runtime.
      yield* prepared.executeTool(call("read"))
      expect(executed).toEqual(["read"])
    }),
  )

  it.effect("paid Zen models and other providers get no placeholders", () =>
    Effect.gen(function* () {
      const service = yield* requests
      for (const paid of [model("opencode", [price(3)]), model("test", []), model("test", [price(0)])]) {
        const title = yield* service.title({ ...input, model: paid })
        expect(title.request.tools).toEqual([])
        expect(title.request.toolChoice).toBeUndefined()
        const primary = yield* service.primary({ ...input, model: paid, tools: readOnly })
        expect(primary.request.tools.map((tool) => tool.name)).toEqual(["grep", "read"])
      }
    }),
  )
})
