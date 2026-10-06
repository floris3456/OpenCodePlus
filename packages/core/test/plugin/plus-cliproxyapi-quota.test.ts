import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Rpc } from "@opencode/core/rpc"
import cliproxyapi, { INTEGRATION_ID, PROVIDER_ID } from "@opencodeplus/cliproxyapi/server"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { withEnv } from "../fixture/env"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

// Part 3 of plus-1.1.16-cliproxyapi: quota follows what the CPA runs, and the
// model catalogue falls through details, Codex, then CPA's plain model list.
const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make(INTEGRATION_ID)
const providerID = Provider.ID.make(PROVIDER_ID)
const EVENTS = "/v0/resource/plugins/quota-handoff/events"

type Catalogue = "details" | "codex" | "plain" | "codex-down"

const plainList = {
  object: "list",
  data: [
    { id: "gpt-5", object: "model", owned_by: "openai" },
    { id: "gpt-image-2", object: "model", owned_by: "openai" },
  ],
}

/** A stub CPA: `state.quota` says whether its quota-handoff plugin is installed. */
function cpa(catalogue: Catalogue, quota: boolean) {
  const state = { quota, events: [] as (string | null)[], models: [] as string[] }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === EVENTS) {
        state.events.push(request.headers.get("authorization"))
        return state.quota ? Response.json({ mode: "shadow", protocol: 1 }) : new Response(null, { status: 404 })
      }
      if (url.pathname !== "/v1/models") return new Response(null, { status: 404 })
      state.models.push(url.search)
      if (url.searchParams.get("details") === "true" && catalogue === "details")
        return Response.json({
          object: "list",
          schema: "cliproxyapi.model-details/1",
          hash: "h1",
          data: [
            {
              id: "gpt-5",
              kind: "chat",
              context_length: 400_000,
              max_completion_tokens: 128_000,
              reasoning: { mode: "levels", levels: ["low", "high"] },
            },
          ],
        })
      if (url.searchParams.has("client_version") && catalogue === "codex-down")
        return new Response("upstream down", { status: 502 })
      if (url.searchParams.has("client_version") && catalogue === "codex")
        return Response.json({
          models: [{ slug: "gpt-5", context_window: 272_000, supported_reasoning_levels: [{ effort: "medium" }] }],
        })
      // A CPA without a catalogue ignores the parameters and sends its plain model list.
      return Response.json(plainList)
    },
  })
  return { server, state }
}

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* cliproxyapi.effect(host)
})

const connect = (origin: string) =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    yield* integrations.connection.key({ integrationID, key: "cpa-key", answer: { baseURL: `${origin}/v1` } })
  })

const quotaEnabled = Effect.gen(function* () {
  const rpc = yield* Rpc.Service
  return ((yield* rpc.call("opencode.plus.quota.usage", "enabled", {})) as { enabled: boolean }).enabled
})

const model = (id: string) =>
  Effect.gen(function* () {
    const models = yield* Model.Service
    return yield* models.get(providerID, Model.ID.make(id))
  })

function withConfig<A, E, R>(file: unknown, body: () => Effect.Effect<A, E, R>) {
  return withTempDir((tmp) =>
    withEnv({ OPENCODE_CONFIG_DIR: tmp.path }, () =>
      Effect.gen(function* () {
        if (file !== undefined)
          yield* Effect.promise(() => Bun.write(`${tmp.path}/cliproxyapi.json`, JSON.stringify(file)))
        return yield* body()
      }),
    ),
  )
}

function eventually<A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean, remaining = 3000) {
  const attempt = (left: number): Effect.Effect<A, E | Error, R> =>
    Effect.gen(function* () {
      const value = yield* effect
      if (predicate(value)) return value
      if (left === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
      yield* Effect.promise(() => Bun.sleep(1))
      return yield* attempt(left - 1)
    })
  return attempt(remaining)
}

function withCpa<A, E, R>(
  catalogue: Catalogue,
  quota: boolean,
  body: (stub: ReturnType<typeof cpa>) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => cpa(catalogue, quota)),
    body,
    (stub) => Effect.promise(() => stub.server.stop(true)),
  )
}

describe("opencode.plus.cliproxyapi quota follows the CPA", () => {
  it.live("a connected CPA running quota-handoff turns quota on, and the probe never carries the key", () =>
    withCpa("details", true, (stub) =>
      withConfig(undefined, () =>
        Effect.gen(function* () {
          yield* addPlugin()
          expect(yield* quotaEnabled).toBe(false)
          yield* connect(stub.server.url.origin)
          yield* eventually(quotaEnabled, (enabled) => enabled)
          expect(stub.state.events.length).toBeGreaterThan(0)
          expect(stub.state.events.every((authorization) => authorization === null)).toBe(true)
        }),
      ),
    ),
  )

  it.effect("a CPA without quota-handoff leaves quota off until it appears, then turns on without a restart", () =>
    withCpa("details", false, (stub) =>
      withConfig(undefined, () =>
        Effect.gen(function* () {
          yield* addPlugin()
          yield* connect(stub.server.url.origin)
          yield* eventually(model("gpt-5"), (value) => value !== undefined)
          yield* eventually(
            Effect.sync(() => stub.state.events.length),
            (count) => count > 0,
          )
          expect(yield* quotaEnabled).toBe(false)

          // The CPA operator installs quota-handoff; the next refresh finds it.
          stub.state.quota = true
          yield* eventually(TestClock.adjust("5 minutes").pipe(Effect.andThen(quotaEnabled)), (enabled) => enabled)

          // And removes it again: quota turns off the same way.
          stub.state.quota = false
          yield* eventually(TestClock.adjust("5 minutes").pipe(Effect.andThen(quotaEnabled)), (enabled) => !enabled)
        }),
      ),
    ),
  )

  it.live('"quota": false in cliproxyapi.json keeps quota off for a CPA running quota-handoff, without probing', () =>
    withCpa("details", true, (stub) =>
      withConfig({ routes: {}, quota: false }, () =>
        Effect.gen(function* () {
          yield* addPlugin()
          yield* connect(stub.server.url.origin)
          // The catalogue refresh and the probe run together; wait for the models.
          yield* eventually(model("gpt-5"), (value) => value !== undefined)
          yield* Effect.promise(() => Bun.sleep(50))
          expect(yield* quotaEnabled).toBe(false)
          expect(stub.state.events).toEqual([])
        }),
      ),
    ),
  )

  it.live('"quota": true turns quota on at start for a file route, even for a CPA the probe would refuse', () =>
    withCpa("details", false, (stub) =>
      withConfig({ routes: { [PROVIDER_ID]: stub.server.url.origin }, quota: true }, () =>
        Effect.gen(function* () {
          yield* addPlugin()
          // No probe needed: existing setups (this repository's host) keep quota from the first request.
          expect(yield* quotaEnabled).toBe(true)
          yield* Effect.promise(() => Bun.sleep(50))
          expect(yield* quotaEnabled).toBe(true)
          expect(stub.state.events).toEqual([])
        }),
      ),
    ),
  )
})

describe("opencode.plus.cliproxyapi model source", () => {
  it.live("details first: CPA's own levels", () =>
    withCpa("details", false, (stub) =>
      withConfig(undefined, () =>
        Effect.gen(function* () {
          yield* addPlugin()
          yield* connect(stub.server.url.origin)
          const gpt = yield* eventually(model("gpt-5"), (value) => value !== undefined)
          expect(gpt?.variants.map((variant) => String(variant.id))).toEqual(["low", "high"])
          // Details stop the fall-through: the Codex catalogue is never asked for.
          expect(stub.state.models.length).toBeGreaterThan(0)
          expect(stub.state.models.every((query) => query === "?details=true")).toBe(true)
        }),
      ),
    ),
  )

  it.live("then the Codex catalogue", () =>
    withCpa("codex", false, (stub) =>
      withConfig(undefined, () =>
        Effect.gen(function* () {
          yield* addPlugin()
          yield* connect(stub.server.url.origin)
          const gpt = yield* eventually(model("gpt-5"), (value) => value !== undefined)
          expect(gpt?.variants.map((variant) => String(variant.id))).toEqual(["medium"])
          expect(yield* model("gpt-image-2")).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("then the plain model list: every model, with no invented levels", () =>
    withCpa("plain", false, (stub) =>
      withConfig(undefined, () =>
        Effect.gen(function* () {
          yield* addPlugin()
          yield* connect(stub.server.url.origin)
          const gpt = yield* eventually(model("gpt-5"), (value) => value !== undefined)
          expect(gpt?.name).toBe("gpt-5")
          expect(gpt?.variants).toEqual([])
          expect((yield* model("gpt-image-2"))?.name).toBe("gpt-image-2 (images)")
          expect(stub.state.models[0]).toBe("?details=true")
          expect(stub.state.models[1]).toStartWith("?client_version=")
        }),
      ),
    ),
  )

  it.live("a failing Codex request is not mistaken for a CPA without a catalogue", () =>
    withCpa("codex-down", false, (stub) =>
      withConfig(undefined, () =>
        Effect.gen(function* () {
          yield* addPlugin()
          yield* connect(stub.server.url.origin)
          yield* eventually(
            Effect.sync(() => stub.state.models.length),
            (count) => count >= 2,
          )
          yield* Effect.promise(() => Bun.sleep(50))
          // The refresh failed and keeps the last catalogue (none yet); the plain list is not used.
          expect(yield* model("gpt-5")).toBeUndefined()
        }),
      ),
    ),
  )
})
