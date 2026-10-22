import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Provider } from "@opencode/core/provider"
import { Tool } from "@opencode/core/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import Pacer from "@opencodeplus/cliproxyapi/pacer"
import { Effect, Layer, Schedule, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { makePluginTestLayer } from "./fixture"

const asserted: string[] = []
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: (input) => Effect.sync(() => void asserted.push(input.action)),
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const it = testEffect(makePluginTestLayer(permission))

const chat = (id: string, provider: string) => ({
  id, providers: [provider], kind: "chat",
  context_length: 200000, max_completion_tokens: 32000,
  input_modalities: ["text"], output_modalities: ["text"],
  reasoning: { mode: "none", levels: [] }, service_tiers: [],
})

it.live("the shipped Pacer adapter's web tools search through the connected CPA from Code Mode", () =>
  Effect.gen(function* () {
    const requests: { path: string; auth: string | null; body: Record<string, unknown> }[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/v1/models") return Response.json({
            object: "list",
            schema: "cliproxyapi.model-details/1",
            hash: "fixture",
            data: [chat("claude-haiku-5-5", "claude"), chat("gpt-6-luna", "codex")],
          })
          if (url.pathname !== "/v1/alpha/search" && url.pathname !== "/v1/messages") return new Response(null, { status: 404 })
          const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json())
          requests.push({ path: url.pathname, auth: request.headers.get("authorization"), body })
          if (url.pathname === "/v1/alpha/search") return Response.json({
            output: "Releases (https://github.com/x/releases)\n\ue200cite\ue202turn0search0\ue201 v8.0.37",
            results: [{ type: "text_result", title: "Releases", url: "https://github.com/x/releases" }],
          })
          return Response.json({
            stop_reason: "end_turn",
            content: [
              { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "CLIProxyAPI release" } },
              { type: "text", text: "v8.0.37", citations: [{ url: "https://github.com/x/releases", title: "Releases" }] },
            ],
            usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
          })
        },
      })),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const plugins = yield* Plugin.Service
    const models = yield* Model.Service
    const integrations = yield* Integration.Service
    const tools = yield* Tool.Service
    yield* plugins.activate([{ ...PluginPromise.fromPromise(Pacer), revision: "1" }])
    yield* integrations.connection.key({
      integrationID: Integration.ID.make("cliproxyapi"),
      key: "fixture-key", answer: { baseURL: `${server.url.origin}/v1` },
    })
    // The tools read the catalogue Pacer saves once it has read CPA's models.
    yield* models.get(Provider.ID.make("cliproxyapi"), Model.ID.make("gpt-6-luna")).pipe(Effect.repeat({
      while: (model) => model === undefined,
      times: 100, schedule: Schedule.spaced("20 millis"),
    }))
    const snapshot = yield* tools.snapshot()
    const run = (code: string) =>
      snapshot
        .execute({
          sessionID: Session.ID.make("ses_web"),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_web"),
          call: { type: "tool-call", id: `call_${code.length}`, name: "execute", input: { code } },
        })
        .pipe(Effect.map((execution) => JSON.parse(execution.output.output)))

    // A script receives the declared output, page text included.
    expect(yield* run('return await tools.web.chatgpt_search({ query: "CLIProxyAPI release" })')).toEqual({
      text: "Releases (https://github.com/x/releases)\n v8.0.37",
      model: "gpt-6-luna",
      sources: [{ url: "https://github.com/x/releases", title: "Releases" }],
    })
    expect(yield* run('return await tools.web.claude_search({ question: "Latest CLIProxyAPI release?" })')).toEqual({
      answer: "v8.0.37",
      model: "claude-haiku-5-5",
      queries: ["CLIProxyAPI release"],
      sources: [{ url: "https://github.com/x/releases", title: "Releases" }],
      searches: 1,
      tokens: { input: 10, output: 5 },
    })
    expect(requests.map((request) => [request.path, request.auth])).toEqual([
      ["/v1/alpha/search", "Bearer fixture-key"],
      ["/v1/messages", "Bearer fixture-key"],
    ])
    expect(requests[0]?.body).toMatchObject({ id: "ses_web-search", model: "gpt-6-luna" })
    expect(requests[1]?.body).toMatchObject({ model: "claude-haiku-5-5", thinking: { type: "disabled" } })
    // Each call asked for the web search permission (the execute tool itself is a built-in leaf).
    expect(asserted.filter((action) => action === "websearch")).toHaveLength(2)
  }),
)
