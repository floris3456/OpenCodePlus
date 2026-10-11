import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Provider } from "@opencode/core/provider"
import Pacer from "@opencodeplus/cliproxyapi/pacer"
import { UsageDefinition } from "../../../cliproxyapi/src/quota/usage"
import { PluginTestLayer } from "./fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(PluginTestLayer)

it.live("Pacer loads without cliproxyapi.json and serves all-provider usage from its cached meter", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const paths: string[] = []
      const reading = { left: 73, at: Date.now(), cursor: "initial" }
      const changed = Promise.withResolvers<void>()
      const subscribed = Promise.withResolvers<void>()
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          paths.push(url.pathname + url.search)
          if (url.searchParams.get("cursor") === "initial") {
            subscribed.resolve()
            await changed.promise
          }
          if (url.searchParams.get("view") === "usage")
            return Response.json({
              view: "usage",
              now: reading.at / 1000,
              cursor: reading.cursor,
              ...(url.searchParams.get("auth") !== "api-key"
                ? {
                    next_use: {
                      v: 1,
                      at_ms: Date.now(),
                      expires_ms: Date.now() + 30000,
                      mode: "dry-run",
                      provider: "claude",
                      model: "claude-sonnet-4-6",
                      auth: "claude-next",
                      reason: "cold_move",
                      forced: false,
                    },
                  }
                : {}),
              credentials: ["claude", "codex"].map((provider) => ({
                id: provider,
                alias: provider,
                provider,
                shared_with: [],
                windows: [
                  {
                    scope: "all",
                    seconds: 18000,
                    left: reading.left,
                    reset_ms: Date.now() + 3600000,
                    read_ms: Date.now(),
                    state: "current",
                    applies: true,
                  },
                ],
              })),
            })
          if (url.pathname === "/v1/models")
            return Response.json({
              object: "list",
              schema: "cliproxyapi.model-details/1",
              hash: "fixture",
              data: [
                {
                  id: "claude-sonnet-4-6",
                  providers: ["claude"],
                  kind: "chat",
                  context_length: 200000,
                  max_completion_tokens: 64000,
                  input_modalities: ["text"],
                  output_modalities: ["text"],
                  reasoning: { mode: "levels", levels: ["high"] },
                  service_tiers: [],
                },
              ],
            })
          return Response.json({
            protocol: 1,
            pacer: true,
            client: {
              version: 1,
              caps: ["quota"],
              views: ["usage"],
              request_header: "X-Pacer-Client",
              quota_header: "X-Pacer-Quota",
            },
          })
        },
      })
      return { server, paths, reading, changed, subscribed }
    }),
    ({ server, paths, reading, changed, subscribed }) =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const host = yield* PluginHost.make(plugin)
        yield* PluginPromise.fromPromise(Pacer).effect(host)
        const integrations = yield* Integration.Service
        yield* integrations.connection.key({
          integrationID: Integration.ID.make("cliproxyapi"),
          key: "fixture-key",
          answer: { baseURL: `${server.url.origin}/v1` },
        })
        const models = yield* Model.Service
        const model = yield* models.get(Provider.ID.make("cliproxyapi"), Model.ID.make("claude-sonnet-4-6")).pipe(
          Effect.repeat({
            while: (value) => value === undefined,
            times: 100,
            schedule: Schedule.spaced("20 millis"),
          }),
        )
        expect(model?.package).toBe("@opencode/ai/providers/anthropic-compatible")
        const usage = yield* host
          .rpc(UsageDefinition)
          .read({ providerID: "cliproxyapi", modelID: "claude-sonnet-4-6", all: true })
          .pipe(
            Effect.repeat({
              while: (result) => (result.snapshot?.credentials.length ?? 0) < 2,
              times: 100,
              schedule: Schedule.spaced("20 millis"),
            }),
          )
        expect(usage.snapshot?.credentials.map((row) => row.provider)).toEqual(["claude", "codex"])
        expect(usage.snapshot?.credentials.every((row) => row.windows[0]?.remaining === 73)).toBe(true)
        yield* Effect.promise(() => subscribed.promise).pipe(Effect.timeout("3 seconds"))
        const before = paths.length
        const selected = yield* host.rpc(UsageDefinition).read({
          providerID: "cliproxyapi",
          modelID: "claude-sonnet-4-6",
          all: false,
        })
        expect(selected.snapshot?.providers).toEqual(["claude"])
        expect(selected.snapshot?.credentials.map((row) => row.provider)).toEqual(["claude"])
        expect(selected.snapshot?.current).toBe("")
        expect(selected.snapshot?.all).toBe(false)
        const unknown = yield* host.rpc(UsageDefinition).read({
          providerID: "cliproxyapi",
          modelID: "unknown-model",
          all: false,
        })
        expect(unknown.snapshot?.credentials).toEqual([])
        const result = yield* host
          .rpc(UsageDefinition)
          .read({ providerID: "cliproxyapi", modelID: "claude-sonnet-4-6", all: true })
        expect(result.status).toBe("ready")
        expect(result.snapshot?.all).toBe(true)
        expect(paths.length).toBe(before)
        expect(paths.some((path) => path.includes("quota-handoff"))).toBe(false)
        const hooks = yield* PluginHooks.Service
        const sessionID = Session.ID.make("ses_pacer_switch")
        const agent = Agent.ID.make("build")
        const ref = Model.Ref.make({
          providerID: Provider.ID.make("cliproxyapi"),
          id: Model.ID.make("claude-sonnet-4-6"),
        })
        const boundary = {
          sessionID,
          agent,
          model: ref,
          reason: "auto" as const,
          auto: true,
          due: false,
          boundary: { fresh: true, portable: true },
        }
        yield* hooks.trigger("session", "compaction.decide", boundary)
        const request = yield* hooks.trigger("session", "model.request", {
          sessionID,
          agent,
          model: ref,
          kind: "primary",
          baseURL: `${server.url.origin}/v1`,
          headers: {},
        })
        expect(request.headers["X-Quota-Handoff"]).toBeDefined()
        const otherRequest = yield* hooks.trigger("session", "model.request", {
          sessionID,
          agent,
          model: { ...ref, id: Model.ID.make("deepseek-flash") },
          kind: "primary",
          baseURL: `${server.url.origin}/v1`,
          headers: {},
        })
        expect(otherRequest.headers["X-Pacer-Client"]).toBeDefined()
        expect(otherRequest.headers["X-Quota-Handoff"]).toBeUndefined()
        const now = Date.now() + 1
        const quotaResponse = new Response("unread stream", {
          headers: {
            "X-Pacer-Quota": Buffer.from(
              JSON.stringify({
                v: 1,
                provider: "claude",
                auth: "claude",
                alias: "claude",
                at_ms: now,
                windows: [
                  {
                    scope: "all",
                    seconds: 18000,
                    left: 37,
                    reset_ms: now + 3600000,
                    read_ms: now - 1800000,
                    state: "current",
                    applies: true,
                  },
                ],
              }),
            ).toString("base64url"),
          },
        })
        const requestsBeforeQuota = paths.length
        yield* hooks.trigger("session", "http.response", {
          sessionID,
          agent,
          model: ref,
          kind: "primary",
          request: new Request(`${server.url.origin}/v1/messages`, { headers: otherRequest.headers }),
          response: quotaResponse,
        })
        expect(paths.length).toBe(requestsBeforeQuota)
        const live = yield* host.rpc(UsageDefinition).read({
          sessionID,
          providerID: "cliproxyapi",
          modelID: ref.id,
          all: false,
        })
        expect(live.snapshot?.current).toBe("claude")
        expect(live.snapshot?.active).toEqual(["claude"])
        expect(live.snapshot?.next_use?.auth).toBe("claude-next")
        expect(live.snapshot?.credentials[0]?.windows[0]?.remaining).toBe(37)
        expect(live.snapshot?.credentials[0]?.windows[0]?.state).toBe("current")
        expect(quotaResponse.bodyUsed).toBe(false)
        expect(paths.length).toBe(requestsBeforeQuota + 1)
        yield* host.rpc(UsageDefinition).read({ sessionID, providerID: "cliproxyapi", modelID: ref.id, all: false })
        expect(paths.length).toBe(requestsBeforeQuota + 1)
        yield* hooks.trigger("session", "http.response", {
          sessionID,
          agent,
          model: ref,
          kind: "primary",
          request: new Request(`${server.url.origin}/v1/messages`, { headers: request.headers }),
          response: Response.json({ error: { code: "quota_compact_required" } }, { status: 409 }),
        })
        const retry = yield* hooks.trigger("session", "retry", {
          sessionID,
          agent,
          model: ref,
          attempt: 1,
          decision: { retry: false },
          error: { type: "provider.invalid-request", message: "quota_compact_required" },
        })
        expect(retry.decision).toEqual({ retry: true, delay: 0 })
        const decision = yield* hooks.trigger("session", "compaction.decide", boundary)
        expect(decision.compact).toBe(true)
        expect(decision.portable).toBe(true)

        // A different caller's quota observation wakes the held subscription. An idle
        // viewer sees it through the cached RPC without acquiring a serving identity.
        reading.left = 19
        reading.at = Date.now() + 2
        reading.cursor = "changed"
        changed.resolve()
        const idle = yield* host.rpc(UsageDefinition).read({
          sessionID: "ses_pacer_idle",
          providerID: "cliproxyapi",
          modelID: ref.id,
          all: false,
        }).pipe(Effect.repeat({
          while: (result) => result.snapshot?.credentials[0]?.windows[0]?.remaining !== 19,
          times: 100,
          schedule: Schedule.spaced("20 millis"),
        }))
        expect(idle.snapshot?.credentials[0]?.windows[0]?.remaining).toBe(19)
        expect(idle.snapshot?.current).toBe("")
        expect(idle.snapshot?.active).toEqual([])
        expect(paths.some((path) => path.includes("cursor=initial") && path.includes("wait_ms=20000"))).toBe(true)
        expect(paths.some((path) => path.startsWith("/v1/messages"))).toBe(false)
      }),
    ({ server }) => Effect.sync(() => server.stop(true)),
  ),
)
