export * as WarmingPlugin from "./warming.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks, SessionWarming, SessionWarmingSettings } from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import type { Session } from "@opencode/schema/session"
import { Clock, Duration, Effect, Fiber, Scope } from "effect"
import { Config } from "../config.js"
import { ConfigWarming } from "../config/warming.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { PluginHooks } from "./hooks.js"

type ActiveSession = {
  last: number
  /** Start of the warming window: the latest non-warming request. */
  since: number
  expires: number
  agent: Agent.ID
  model: Model.Ref
  settings: SessionWarmingSettings
  /** Bumped per schedule so a loop replaced during a fork stops instead of sleeping on. */
  epoch: number
  fiber?: Fiber.Fiber<void>
}

export const Plugin = define({
  id: "opencode.warming",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const models = yield* Model.Service
    const providers = yield* Provider.Service
    const hooks = yield* PluginHooks.Service
    // A session's current model can switch between hook events, so resolve the
    // effective warming settings for that model every time instead of caching them.
    const loadSettings = Effect.fn("WarmingPlugin.loadSettings")(function* (model: Model.Ref) {
      const provider = yield* providers.get(model.providerID)
      // Catalog model settings already merge provider and model levels. The provider
      // value is applied first so an explicit provider disable severs inherited global fields.
      const catalog = yield* models.get(model.providerID, model.id)
      const settings = ConfigWarming.resolve({
        global: Config.latest(yield* config.entries(), "warming"),
        provider: provider?.settings?.warming,
        model: catalog?.settings?.warming,
      })
      if (!settings) return
      return {
        prompt: settings.prompt,
        interval: Duration.toMillis(settings.interval),
        duration: Duration.toMillis(settings.duration),
      }
    })

    // Plugins decide last through the session `warming` hook; the result is validated once here.
    const decide = Effect.fn("WarmingPlugin.decide")(function* (
      input: Omit<SessionWarming, "settings">,
      proposed: SessionWarmingSettings | undefined,
    ) {
      const event: SessionWarming = { ...input, settings: proposed && { ...proposed } }
      const settings = (yield* hooks.trigger("session", "warming", event)).settings
      if (!settings) return
      if (
        Number.isFinite(settings.interval) &&
        settings.interval > 0 &&
        Number.isFinite(settings.duration) &&
        settings.duration > 0
      )
        return { ...settings }
      yield* Effect.logWarning("warming interval and duration must be finite positive durations")
    })

    const scope = yield* Scope.Scope
    const sessions = new Map<Session.ID, ActiveSession>()
    const loop: (sessionID: Session.ID, epoch: number) => Effect.Effect<void> = Effect.fn("WarmingPlugin.loop")(
      function* (sessionID, epoch) {
        const current = sessions.get(sessionID)
        // A newer schedule owns this session; a replaced loop must not sleep or warm.
        if (current?.epoch !== epoch) return

        const now = yield* Clock.currentTimeMillis
        const next = Math.min(current.last + current.settings.interval, current.expires)
        if (now < next) {
          yield* Effect.sleep(Duration.millis(next - now))
          return yield* loop(sessionID, epoch)
        }
        if (now >= current.expires) {
          if (sessions.get(sessionID) === current) sessions.delete(sessionID)
          return
        }

        // Plugins may stop warming or re-time the window right before each warming request.
        const settings = yield* decide(
          { sessionID, agent: current.agent, model: current.model, phase: "warm", since: current.since, now },
          current.settings,
        )
        if (current.epoch !== epoch) return
        if (!settings) {
          if (sessions.get(sessionID) === current) sessions.delete(sessionID)
          return
        }
        current.settings = settings
        current.expires = current.since + settings.duration
        const decided = yield* Clock.currentTimeMillis
        if (decided >= current.expires || decided < Math.min(current.last + settings.interval, current.expires))
          return yield* loop(sessionID, epoch)

        const last = current.last
        yield* Effect.logInfo("warming session", { sessionID, last })
        yield* ctx.session
          .generate({ sessionID, prompt: settings.prompt })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to warm session", { sessionID, cause })))
        const latest = sessions.get(sessionID)
        if (latest === current && latest.last === last) latest.last = yield* Clock.currentTimeMillis
        return yield* loop(sessionID, epoch)
      },
    )

    // External activity replaces the scheduled loop, so interval and duration changes
    // apply from the next hook event instead of the replaced loop's old wake-up.
    const reschedule = Effect.fn("WarmingPlugin.reschedule")(function* (sessionID: Session.ID, active: ActiveSession) {
      const epoch = active.epoch + 1
      active.epoch = epoch
      if (active.fiber) yield* Fiber.interrupt(active.fiber)
      const fiber = yield* loop(sessionID, epoch).pipe(
        Effect.catchCause((cause) => Effect.logError("session warming loop failed", { sessionID, cause })),
        Effect.forkIn(scope),
      )
      // A concurrent hook may have scheduled a newer loop while this fork started.
      if (active.epoch === epoch) active.fiber = fiber
    })

    const hook = (event: SessionHooks["context"], kind: "primary" | "compaction" | "generate") =>
      Effect.gen(function* () {
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        if (session.parentID) return

        const active = sessions.get(event.sessionID)
        // The warming request itself runs this hook from the session's loop; never
        // interrupt or reschedule that loop from inside its own generate call.
        if (active?.fiber?.id === (yield* Effect.fiberId)) return
        const configured = yield* loadSettings(event.model)

        // Once generate exposes request metadata to context hooks, tag warm requests instead of matching the prompt.
        const message = event.messages.at(-1)
        if (
          message?.role === "user" &&
          message.content.length === 1 &&
          message.content[0]?.type === "text" &&
          (message.content[0].text === active?.settings.prompt || message.content[0].text === configured?.prompt)
        )
          return

        const now = yield* Clock.currentTimeMillis
        const settings = yield* decide(
          { sessionID: event.sessionID, agent: event.agent, model: event.model, phase: "activity", kind, since: now, now },
          configured,
        )
        if (!settings) {
          if (active) {
            sessions.delete(event.sessionID)
            if (active.fiber) yield* Fiber.interrupt(active.fiber)
          }
          return
        }

        if (active) {
          active.last = now
          active.since = now
          active.expires = now + settings.duration
          active.agent = event.agent
          active.model = event.model
          active.settings = settings
          yield* reschedule(event.sessionID, active)
          return
        }
        const scheduled: ActiveSession = {
          last: now,
          since: now,
          expires: now + settings.duration,
          agent: event.agent,
          model: event.model,
          settings,
          epoch: 0,
        }
        sessions.set(event.sessionID, scheduled)
        yield* Effect.logInfo("scheduled session warming", {
          sessionID: event.sessionID,
          interval: settings.interval,
          expires: scheduled.expires,
        })
        yield* reschedule(event.sessionID, scheduled)
      })
    yield* ctx.session.hook("context", (event) => hook(event, "primary"))
    yield* ctx.session.hook("compaction", (event) => hook(event, "compaction"))
    yield* ctx.session.hook("generate", (event) => hook(event, "generate"))
  }),
})
