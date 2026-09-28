import { Message } from "@opencode/ai"
import { describe, expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
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
import { ConfigWarming } from "@opencode/schema/config/warming"
import { Duration, Effect, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const decode = Schema.decodeUnknownSync(Info)
const scoped = Schema.decodeUnknownSync(ConfigWarming.Scoped)

type ScopedWarming = ReturnType<typeof scoped>
type WarmCall = { readonly sessionID: Session.ID; readonly prompt: string }

const document = (input: unknown) => new Document({ type: "document", info: decode(input) })

// A replaceable configuration boundary: the plugin captures this service on
// activation, so later edits apply from the next hook event.
const makeConfig = Effect.fn("makeConfig")(function* (initial: Entry[]) {
  const entries = yield* Ref.make(initial)
  return {
    service: Config.Service.of({
      entries: () => Ref.get(entries),
      changes: () => Stream.empty,
    }),
    set: (next: Entry[]) => Ref.set(entries, next),
  }
})

const ref = (providerID: string, id: string) =>
  Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })

const addProvider = Effect.fn("addProvider")(function* (input: {
  readonly id: string
  readonly warming?: ScopedWarming
  readonly models: ReadonlyArray<{ readonly id: string; readonly warming?: ScopedWarming }>
}) {
  const providers = yield* Provider.Service
  yield* providers.transform((editor) => {
    editor.add({
      info: {
        ...Provider.Info.empty(Provider.ID.make(input.id)),
        package: "@opencode/ai/providers/openai/chat",
        ...(input.warming === undefined ? {} : { settings: { warming: input.warming } }),
      },
      models: input.models.map((model) => ({
        ...Model.Info.default(Provider.ID.make(input.id), Model.ID.make(model.id)),
        ...(model.warming === undefined ? {} : { settings: { warming: model.warming } }),
      })),
    })
  })
})

const loadCatalog = Effect.fn("loadCatalog")(function* (config: Config.Interface) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
})

const activate = Effect.fn("activateWarming")(function* (
  calls: WarmCall[],
  config: Config.Interface,
  // When set, a recorded warm request also raises the session generate hook from
  // the same fiber, matching how the host invokes hooks from inside the loop.
  internal?: Map<Session.ID, Model.Ref>,
) {
  const plugin = yield* Plugin.Service
  const sessions = yield* Session.Service
  const hooks = yield* PluginHooks.Service
  const host = yield* PluginHost.make(plugin).pipe(
    Effect.provideService(
      Session.Service,
      Session.Service.of({
        ...sessions,
        generate: (input) =>
          Effect.gen(function* () {
            calls.push({ sessionID: input.sessionID, prompt: input.prompt })
            const model = internal?.get(input.sessionID)
            if (!model) return ""
            yield* hooks.trigger("session", "generate", {
              sessionID: input.sessionID,
              agent: Agent.ID.make("build"),
              model,
              system: [],
              messages: [Message.user(input.prompt)],
              tools: {},
              options: {},
            })
            return ""
          }),
      }),
    ),
  )
  yield* WarmingPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
})

const makeSessions = Effect.fn("makeSessions")(function* () {
  const sessions = yield* Session.Service
  const location = yield* Location.Service
  const parent = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
  const child = yield* sessions.create({ parentID: parent.id })
  return { parent: parent.id, child: child.id }
})

const trigger = Effect.fn("triggerContext")(function* (
  sessionID: Session.ID,
  model: Model.Ref,
  internal?: Map<Session.ID, Model.Ref>,
) {
  internal?.set(sessionID, model)
  const hooks = yield* PluginHooks.Service
  const event: SessionHooks["context"] = {
    sessionID,
    agent: Agent.ID.make("build"),
    model,
    system: [],
    messages: [],
    tools: {},
    options: {},
  }
  yield* hooks.trigger("session", "context", event)
})

const triggerGenerate = Effect.fn("triggerGenerate")(function* (
  sessionID: Session.ID,
  model: Model.Ref,
  prompt: string,
) {
  const hooks = yield* PluginHooks.Service
  const event: SessionHooks["generate"] = {
    sessionID,
    agent: Agent.ID.make("build"),
    model,
    system: [],
    messages: [Message.user(prompt)],
    tools: {},
    options: {},
  }
  yield* hooks.trigger("session", "generate", event)
})

const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))

const advance = Effect.fn("advance")(function* (steps: number) {
  for (let step = 0; step < steps; step++) {
    yield* settle
    yield* TestClock.adjust("1 second")
  }
  yield* settle
})

const cross = Effect.fn("cross")(function* (duration: Duration.Input) {
  yield* settle
  yield* TestClock.adjust(duration)
  yield* settle
})

const callsFor = (calls: readonly WarmCall[], sessionID: Session.ID) =>
  calls.filter((call) => call.sessionID === sessionID)

describe("WarmingPlugin", () => {
  it.effect("warms a session from global settings and drops it when global warming is disabled", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([
        document({ warming: { prompt: "global", interval: "1 second", duration: "1 hour" } }),
      ])
      yield* addProvider({ id: "alpha", models: [{ id: "m1" }] })
      const calls: WarmCall[] = []
      yield* activate(calls, config.service)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.parent, ref("alpha", "m1"))
      yield* advance(3)
      expect(callsFor(calls, sessions.parent).length).toBeGreaterThan(0)
      expect(callsFor(calls, sessions.parent).at(-1)?.prompt).toBe("global")

      yield* config.set([document({ warming: false })])
      yield* trigger(sessions.parent, ref("alpha", "m1"))
      const before = calls.length
      yield* advance(3)
      expect(calls.length).toBe(before)
    }),
  )

  it.effect("uses provider warming over global and model warming over provider", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([
        document({ warming: { prompt: "global", interval: "1 second", duration: "1 hour" } }),
      ])
      yield* addProvider({
        id: "alpha",
        warming: scoped({ prompt: "provider" }),
        models: [{ id: "inherited" }, { id: "overridden", warming: scoped({ prompt: "model" }) }],
      })
      const calls: WarmCall[] = []
      yield* activate(calls, config.service)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.parent, ref("alpha", "inherited"))
      yield* advance(2)
      expect(callsFor(calls, sessions.parent).at(-1)?.prompt).toBe("provider")

      yield* trigger(sessions.parent, ref("alpha", "overridden"))
      const before = calls.length
      yield* advance(2)
      const next = calls.slice(before)
      expect(next.length).toBeGreaterThan(0)
      expect(next.every((call) => call.prompt === "model")).toBe(true)
    }),
  )

  it.effect("warms a model enabled over a disabled provider and skips a model disabled under an enabled provider", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([
        document({ warming: { prompt: "global", interval: "1 second", duration: "1 hour" } }),
      ])
      yield* addProvider({
        id: "alpha",
        warming: false,
        models: [{ id: "on", warming: scoped({ prompt: "model-only" }) }],
      })
      yield* addProvider({
        id: "beta",
        warming: scoped({ prompt: "provider", interval: "1 second" }),
        models: [{ id: "off", warming: scoped(false) }],
      })
      const calls: WarmCall[] = []
      yield* activate(calls, config.service)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.parent, ref("alpha", "on"))
      yield* trigger(sessions.child, ref("beta", "off"))
      yield* advance(3)
      // The enabled model inherits defaults, not the disabled provider's or global interval.
      expect(callsFor(calls, sessions.parent)).toEqual([])
      expect(callsFor(calls, sessions.child)).toEqual([])

      yield* cross("4 minutes")
      expect(callsFor(calls, sessions.parent).length).toBeGreaterThan(0)
      expect(callsFor(calls, sessions.parent).at(-1)?.prompt).toBe("model-only")
      expect(callsFor(calls, sessions.child)).toEqual([])
    }),
  )

  it.effect(
    "applies a model switch mid-session on the next hook event and stops warming when the model resolves off",
    () =>
      Effect.gen(function* () {
        const config = yield* makeConfig([
          document({ warming: { prompt: "global", interval: "1 second", duration: "1 hour" } }),
        ])
        yield* addProvider({
          id: "alpha",
          models: [
            { id: "fast", warming: scoped({ prompt: "fast" }) },
            { id: "slow", warming: scoped({ prompt: "slow", interval: "4 minutes" }) },
            { id: "off", warming: scoped(false) },
          ],
        })
        const calls: WarmCall[] = []
        yield* activate(calls, config.service)
        const sessions = yield* makeSessions()

        yield* trigger(sessions.parent, ref("alpha", "fast"))
        yield* advance(2)
        expect(callsFor(calls, sessions.parent).at(-1)?.prompt).toBe("fast")

        yield* trigger(sessions.parent, ref("alpha", "slow"))
        const switched = calls.length
        yield* advance(3)
        expect(calls.length).toBe(switched)

        yield* cross("4 minutes")
        const slow = calls.slice(switched)
        expect(slow.length).toBeGreaterThan(0)
        expect(slow.every((call) => call.prompt === "slow")).toBe(true)

        yield* trigger(sessions.parent, ref("alpha", "off"))
        const stopped = calls.length
        yield* advance(3)
        yield* cross("4 minutes")
        expect(calls.length).toBe(stopped)
      }),
  )

  it.effect("applies a slower to faster interval change on the next hook event", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([
        document({ warming: { prompt: "global", interval: "1 second", duration: "1 hour" } }),
      ])
      yield* addProvider({
        id: "alpha",
        models: [
          { id: "slow", warming: scoped({ prompt: "slow", interval: "4 minutes" }) },
          { id: "fast", warming: scoped({ prompt: "fast", interval: "1 second" }) },
        ],
      })
      const calls: WarmCall[] = []
      yield* activate(calls, config.service)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.parent, ref("alpha", "slow"))
      yield* advance(1)
      expect(callsFor(calls, sessions.parent)).toEqual([])

      yield* trigger(sessions.parent, ref("alpha", "fast"))
      yield* advance(1)
      const warmed = callsFor(calls, sessions.parent)
      expect(warmed.length).toBeGreaterThan(0)
      expect(warmed.every((call) => call.prompt === "fast")).toBe(true)
    }),
  )

  it.effect("expires a session on a shortened duration from the next hook event", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([
        document({ warming: { prompt: "global", interval: "1 second", duration: "1 hour" } }),
      ])
      yield* addProvider({
        id: "alpha",
        models: [
          { id: "long", warming: scoped({ prompt: "long", interval: "4 minutes" }) },
          { id: "short", warming: scoped({ prompt: "short", interval: "1 second", duration: "2 seconds" }) },
        ],
      })
      const calls: WarmCall[] = []
      yield* activate(calls, config.service)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.parent, ref("alpha", "long"))
      // Let the long schedule enter its four-minute sleep before the switch.
      yield* advance(1)
      expect(callsFor(calls, sessions.parent)).toEqual([])

      yield* trigger(sessions.parent, ref("alpha", "short"))
      yield* advance(1)
      const warmed = callsFor(calls, sessions.parent).length
      expect(warmed).toBeGreaterThan(0)
      expect(callsFor(calls, sessions.parent).at(-1)?.prompt).toBe("short")

      // The two-second window ends before the replaced four-minute interval or hour-long duration.
      yield* advance(1)
      expect(callsFor(calls, sessions.parent).length).toBe(warmed)
      yield* cross("4 minutes")
      expect(callsFor(calls, sessions.parent).length).toBe(warmed)
    }),
  )

  it.effect("never warms subagents", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([
        document({ warming: { prompt: "global", interval: "1 second", duration: "1 hour" } }),
      ])
      yield* addProvider({ id: "alpha", models: [{ id: "m1" }] })
      const calls: WarmCall[] = []
      yield* activate(calls, config.service)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.child, ref("alpha", "m1"))
      yield* advance(3)
      expect(callsFor(calls, sessions.child)).toEqual([])

      yield* trigger(sessions.parent, ref("alpha", "m1"))
      yield* advance(2)
      expect(callsFor(calls, sessions.parent).length).toBeGreaterThan(0)
    }),
  )

  it.effect("does not warm a provider whose warming resolves off", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([document({ warming: false })])
      yield* addProvider({
        id: "alpha",
        warming: scoped({ prompt: "alpha", interval: "1 second", duration: "1 hour" }),
        models: [{ id: "m1" }],
      })
      yield* addProvider({ id: "beta", models: [{ id: "m1" }] })
      const calls: WarmCall[] = []
      yield* activate(calls, config.service)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.parent, ref("beta", "m1"))
      yield* advance(3)
      expect(callsFor(calls, sessions.parent)).toEqual([])

      yield* trigger(sessions.parent, ref("alpha", "m1"))
      yield* advance(2)
      expect(callsFor(calls, sessions.parent).length).toBeGreaterThan(0)
      expect(callsFor(calls, sessions.parent).at(-1)?.prompt).toBe("alpha")
    }),
  )

  it.effect("resolves provider and model warming loaded from configuration", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([
        document({
          warming: { prompt: "global", interval: "1 second", duration: "1 hour" },
          providers: {
            alpha: {
              package: "@opencode/ai/providers/openai/chat",
              settings: { warming: { prompt: "provider" } },
              models: { m1: { settings: { warming: { prompt: "model" } } } },
            },
          },
        }),
      ])
      yield* loadCatalog(config.service)
      const calls: WarmCall[] = []
      yield* activate(calls, config.service)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.parent, ref("alpha", "m1"))
      yield* advance(2)
      expect(callsFor(calls, sessions.parent).length).toBeGreaterThan(0)
      expect(callsFor(calls, sessions.parent).at(-1)?.prompt).toBe("model")
    }),
  )

  it.effect("does not extend warming for a request carrying the warming prompt", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([
        document({ warming: { prompt: "global", interval: "1 second", duration: "3 seconds" } }),
      ])
      yield* addProvider({ id: "alpha", models: [{ id: "m1" }] })
      const calls: WarmCall[] = []
      yield* activate(calls, config.service)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.parent, ref("alpha", "m1"))
      yield* advance(2)
      const warmed = callsFor(calls, sessions.parent).length
      expect(warmed).toBeGreaterThan(0)

      yield* triggerGenerate(sessions.parent, ref("alpha", "m1"), "global")
      expect(callsFor(calls, sessions.parent).length).toBe(warmed)

      yield* advance(1)
      yield* cross("10 seconds")
      expect(callsFor(calls, sessions.parent).length).toBe(warmed)
    }),
  )

  it.effect("keeps its own schedule when a warming request raises session hooks", () =>
    Effect.gen(function* () {
      const config = yield* makeConfig([
        document({ warming: { prompt: "global", interval: "1 second", duration: "1 hour" } }),
      ])
      yield* addProvider({ id: "alpha", models: [{ id: "m1" }] })
      const calls: WarmCall[] = []
      const internal = new Map<Session.ID, Model.Ref>()
      yield* activate(calls, config.service, internal)
      const sessions = yield* makeSessions()

      yield* trigger(sessions.parent, ref("alpha", "m1"), internal)
      yield* advance(3)
      const warmed = callsFor(calls, sessions.parent)
      expect(warmed.length).toBeGreaterThanOrEqual(3)
      expect(warmed.every((call) => call.prompt === "global")).toBe(true)
    }),
  )
})
