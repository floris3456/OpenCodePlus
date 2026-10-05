import { describe, expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { WarmingPlugin } from "@opencode/core/plugin/warming"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { Effect, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Info)
const document = (input: unknown) => new Document({ type: "document", info: decode(input) })

const ref = (providerID: string, id: string) =>
  Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })

describe("warming ping usage seam", () => {
  it.effect("reports ping usage through the warmed phase of the warming hook and generated hook", () =>
    Effect.gen(function* () {
      const configEntries = yield* Ref.make<Entry[]>([
        document({ warming: { prompt: "ping", interval: "1 second", duration: "1 hour" } }),
      ])
      const configService = Config.Service.of({
        entries: () => Ref.get(configEntries),
        changes: () => Stream.empty,
      })

      const providers = yield* Provider.Service
      yield* providers.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make("alpha")),
            package: "@opencode/ai/providers/openai/chat",
          },
          models: [{ ...Model.Info.default(Provider.ID.make("alpha"), Model.ID.make("m1")) }],
        })
      })

      const hooks = yield* PluginHooks.Service
      const seenWarming: Array<SessionHooks["warming"]> = []
      yield* hooks.register("session", "warming", (event) =>
        Effect.sync(() => {
          seenWarming.push({ ...event })
        }),
      )

      const plugin = yield* Plugin.Service
      const sessions = yield* Session.Service
      const location = yield* Location.Service
      const parent = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })

      const host = yield* PluginHost.make(plugin).pipe(
        Effect.provideService(
          Session.Service,
          Session.Service.of({
            ...sessions,
            generate: () => Effect.succeed(""),
          }),
        ),
      )

      yield* WarmingPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, configService))

      // Trigger activity to start warming
      yield* hooks.trigger("session", "context", {
        sessionID: parent.id,
        agent: Agent.ID.make("build"),
        model: ref("alpha", "m1"),
        system: [],
        messages: [],
        tools: {},
        options: {},
      })

      // Advance clock past interval
      for (let i = 0; i < 2; i++) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
        yield* TestClock.adjust("1 second")
      }
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))

      const warmed = seenWarming.filter((event) => event.phase === "warmed")
      expect(warmed.length).toBeGreaterThan(0)
      expect(warmed[0]?.sessionID).toBe(parent.id)
      expect(warmed[0]?.agent).toBe(Agent.ID.make("build"))
      expect(warmed[0]?.model).toEqual(ref("alpha", "m1"))
    }),
  )
})
