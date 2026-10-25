import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelObservation } from "@opencode/core/session/model-observation"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const KINDS: ReadonlyArray<SessionRequestKind> = ["primary", "compaction", "title", "generate"]

const session = Session.Info.make({
  id: Session.ID.make("ses_hook_kind"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

describe("SessionModelRequest HTTP hooks", () => {
  it.effect("tags every Session request kind on http.request and http.response", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: Array<{ hook: string; kind: SessionRequestKind; agent: Agent.ID }> = []
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "request", kind: event.kind, agent: event.agent })
        }),
      )
      yield* hooks.register("session", "http.response", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "response", kind: event.kind, agent: event.agent })
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))

      for (const kind of KINDS) {
        const prepared = yield* requests[kind]({
          session,
          agent: Agent.ID.make("build"),
          model,
          system: [],
          messages: [],
        })
        const http = prepared.options.http
        if (!http) throw new Error(`Expected HTTP middleware for ${kind}`)
        yield* http(HttpClientRequest.post("https://example.test/v1/chat/completions"), (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))),
        )
      }

      expect(seen).toEqual(
        KINDS.flatMap((kind) => [
          { hook: "request", kind, agent: Agent.ID.make("build") },
          { hook: "response", kind, agent: Agent.ID.make("build") },
        ]),
      )
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("offers the WebSocket executor alongside HTTP hooks and routes the WebSocket hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      yield* hooks.register("session", "http.request", () => Effect.sync(() => void seen.push("http.request")))
      yield* hooks.register("session", "experimental.ws.handshake", (event) =>
        Effect.sync(() => {
          seen.push(`handshake:${event.kind}:${event.url}`)
          event.headers.authorization = "Bearer minted"
          delete event.headers["api-key"]
        }),
      )
      yield* hooks.register("session", "experimental.ws.send", (event) =>
        Effect.sync(() => {
          seen.push(`send:${event.kind}:${event.frame}`)
          event.frame = `${event.frame}+plugin`
        }),
      )
      yield* hooks.register("session", "experimental.ws.receive", (event) =>
        Effect.sync(() => {
          seen.push(`receive:${event.kind}:${event.frame}`)
          event.frame = event.frame.toUpperCase()
        }),
      )
      const bound: Array<{ url: string; headers: Record<string, string> }> = []
      const frames: string[] = []
      const websocketTransport = SessionModelTransport.Service.of({
        bind: (_sessionID, interceptor) => ({
          execute: () =>
            Effect.gen(function* () {
              if (!interceptor?.handshake || !interceptor.send || !interceptor.receive)
                throw new Error("Expected a full WebSocket interceptor")
              bound.push(
                yield* interceptor.handshake({ url: "wss://example.test/v1/responses", headers: { "api-key": "k" } }),
              )
              frames.push(yield* interceptor.send("create"))
              frames.push(yield* interceptor.receive("created"))
              return { frames: Stream.empty, complete: Effect.void }
            }),
        }),
        close: () => Effect.void,
        closeAll: Effect.void,
      })
      const requests = yield* SessionModelRequest.Service.pipe(
        Effect.provide(SessionModelRequest.layer),
        Effect.provideService(SessionModelTransport.Service, websocketTransport),
      )
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model: SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
          transport: "websocket",
        }),
        system: [],
        messages: [],
        webSocket: "session",
      })

      expect(prepared.options.http).toBeDefined()
      expect(prepared.options.webSocket).toBeDefined()
      yield* prepared.options.webSocket!.execute({} as never)
      expect(bound).toEqual([{ url: "wss://example.test/v1/responses", headers: { authorization: "Bearer minted" } }])
      expect(frames).toEqual(["create+plugin", "CREATED"])
      expect(seen).toEqual([
        "handshake:primary:wss://example.test/v1/responses",
        "send:primary:create",
        "receive:primary:created",
      ])
    }),
  )
})

describe("SessionModelRequest model.request hook", () => {
  const child = Session.Info.make({ ...session, id: Session.ID.make("ses_hook_child"), parentID: session.id })

  it.effect("offers the parent's cache key to a child's request and sends the key the hook leaves", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const offered: Array<string | undefined> = []
      yield* hooks.register("session", "model.request", (event) =>
        Effect.sync(() => {
          offered.push(event.promptCacheKey)
          if (event.kind === "primary") event.promptCacheKey = event.sessionID
          if (event.kind === "title") delete event.promptCacheKey
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const input = { session: child, agent: Agent.ID.make("build"), model, system: [], messages: [] }

      const primary = yield* requests.primary(input)
      const generate = yield* requests.generate(input)
      const title = yield* requests.title(input)

      expect(offered).toEqual([session.id, session.id, session.id])
      expect(primary.request.promptCacheKey).toBe(child.id)
      expect(generate.request.promptCacheKey).toBe(session.id)
      expect(title.request.promptCacheKey).toBeUndefined()
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )
})

describe("SessionModelRequest hook message boundary", () => {
  it.effect("normalizes string content and drops undecodable hook messages", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.messages.push({ role: "user", content: "plain string" } as never)
          event.messages.push({ role: "user", content: 42 } as never)
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))

      const history = Message.user("history")
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model,
        system: [],
        messages: [history],
      })

      expect(prepared.event.messages[0]).toBe(history)
      expect(prepared.event.messages.map((message) => message.content)).toEqual([
        [{ type: "text", text: "history" }],
        [{ type: "text", text: "plain string" }],
      ])
      expect(prepared.request.messages.map((message) => message.content)).toEqual([
        [{ type: "text", text: "history" }],
        [{ type: "text", text: "plain string" }],
      ])
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("passes valid hook output through unchanged", () =>
    Effect.gen(function* () {
      const input = [Message.user("hello")]
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))

      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model,
        system: [],
        messages: input,
      })

      expect(prepared.request.messages).toEqual(input)
      expect(prepared.event.messages).toEqual(input)
      expect(prepared.event.messages[0]).toBe(input[0])
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )
})

describe("SessionModelRequest completed requests", () => {
  it.effect("keeps the recent sessions' requests for compaction to pin and drops the oldest", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const causes = new Map<string, string | undefined>()
      yield* hooks.register("session", "model.observed", (event) =>
        Effect.sync(() => {
          if (event.kind === "compaction") causes.set(event.sessionID, event.compaction?.cacheColdCause ?? "pinned")
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const sessions = Array.from({ length: 33 }, (_, index) =>
        Session.Info.make({ ...session, id: Session.ID.make(`ses_completed_${String(index).padStart(2, "0")}`) }),
      )
      const input = (chat: Session.Info) => ({
        session: chat,
        agent: Agent.ID.make("build"),
        model,
        system: [],
        messages: [Message.user("history")],
      })
      for (const chat of sessions) {
        const primary = yield* requests.primary(input(chat))
        yield* primary.observer!(Effect.void)
      }
      for (const chat of [sessions[0]!, sessions[32]!]) {
        const compaction = yield* requests.compaction(input(chat))
        yield* compaction.observer!(Effect.void).pipe(
          Effect.provideService(SessionModelObservation.Compaction, {
            version: 1,
            trigger: "manual",
            configuredStrategy: "local",
            strategySource: "built-in",
            selectedStrategy: "text-summary",
            selectionReason: "explicit-local",
          }),
        )
      }

      expect(causes.get(sessions[32]!.id)).toBe("pinned")
      expect(causes.get(sessions[0]!.id)).toBe("snapshot-unavailable")
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )
})
