export * as WarmingPlugin from "./warming.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { Session } from "@opencode/schema/session"
import { Clock, Duration, Effect, Scope } from "effect"
import { Config } from "../config.js"
import { ConfigWarming } from "../config/warming.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"

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
    const sessions = new Map<Session.ID, { last: number; expires: number; settings: ConfigWarming.Resolved }>()
    const loop: (sessionID: Session.ID) => Effect.Effect<void> = Effect.fn("WarmingPlugin.loop")(function* (sessionID) {
      const current = sessions.get(sessionID)
      if (!current) return

      const now = yield* Clock.currentTimeMillis
      const next = Math.min(current.last + Duration.toMillis(current.settings.interval), current.expires)
      if (now < next) {
        yield* Effect.sleep(Duration.millis(next - now))
        return yield* loop(sessionID)
      }
      if (now >= current.expires) {
        sessions.delete(sessionID)
        return
      }

      const last = current.last
      yield* Effect.logInfo("warming session", { sessionID, last })
      yield* ctx.session
        .generate({ sessionID, prompt: current.settings.prompt })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to warm session", { sessionID, cause })))
      const latest = sessions.get(sessionID)
      if (latest === current && latest.last === last) latest.last = yield* Clock.currentTimeMillis
      return yield* loop(sessionID)
    })

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        if (session.parentID) return

        const active = sessions.get(event.sessionID)
        const settings = yield* loadSettings(event.model)
        if (!settings) {
          sessions.delete(event.sessionID)
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
          return
        }
        sessions.set(event.sessionID, { last: now, expires: now + duration, settings })
        yield* Effect.logInfo("scheduled session warming", {
          sessionID: event.sessionID,
          interval: settings.interval,
          expires: now + duration,
        })
        yield* loop(event.sessionID).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("session warming loop failed", { sessionID: event.sessionID, cause }),
          ),
          Effect.forkIn(scope),
        )
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
})
