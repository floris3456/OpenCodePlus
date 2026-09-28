export * as WarmingPlugin from "./warming.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { Session } from "@opencode/schema/session"
import { Clock, Duration, Effect, Fiber, Scope } from "effect"
import { Config } from "../config.js"
import { ConfigWarming } from "../config/warming.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"

type ActiveSession = {
  last: number
  expires: number
  settings: ConfigWarming.Resolved
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
      const interval = Duration.toMillis(settings.interval)
      const duration = Duration.toMillis(settings.duration)
      if (Number.isFinite(interval) && interval > 0 && Number.isFinite(duration) && duration > 0) return settings
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
        const next = Math.min(current.last + Duration.toMillis(current.settings.interval), current.expires)
        if (now < next) {
          yield* Effect.sleep(Duration.millis(next - now))
          return yield* loop(sessionID, epoch)
        }
        if (now >= current.expires) {
          if (sessions.get(sessionID) === current) sessions.delete(sessionID)
          return
        }

        const last = current.last
        yield* Effect.logInfo("warming session", { sessionID, last })
        yield* ctx.session
          .generate({ sessionID, prompt: current.settings.prompt })
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

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        if (session.parentID) return

        const active = sessions.get(event.sessionID)
        const settings = yield* loadSettings(event.model)
        // The warming request itself runs this hook from the session's loop; never
        // interrupt or reschedule that loop from inside its own generate call.
        if (active?.fiber?.id === (yield* Effect.fiberId)) return
        if (!settings) {
          if (active) {
            sessions.delete(event.sessionID)
            if (active.fiber) yield* Fiber.interrupt(active.fiber)
          }
          return
        }

        // Once generate exposes request metadata to context hooks, tag warm requests instead of matching the prompt.
        const message = event.messages.at(-1)
        if (
          message?.role === "user" &&
          message.content.length === 1 &&
          message.content[0]?.type === "text" &&
          (message.content[0].text === active?.settings.prompt || message.content[0].text === settings.prompt)
        ) {
          if (active) active.settings = settings
          return
        }

        const now = yield* Clock.currentTimeMillis
        const duration = Duration.toMillis(settings.duration)
        if (active) {
          active.last = now
          active.expires = now + duration
          active.settings = settings
          yield* reschedule(event.sessionID, active)
          return
        }
        const scheduled: ActiveSession = { last: now, expires: now + duration, settings, epoch: 0 }
        sessions.set(event.sessionID, scheduled)
        yield* Effect.logInfo("scheduled session warming", {
          sessionID: event.sessionID,
          interval: settings.interval,
          expires: now + duration,
        })
        yield* reschedule(event.sessionID, scheduled)
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
})
