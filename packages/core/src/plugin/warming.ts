export * as WarmingPlugin from "./warming.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks, SessionWarming, SessionWarmingSettings } from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import type { Session } from "@opencode/schema/session"
import { Cause, Clock, Duration, Effect, Fiber, Option, Scope } from "effect"
import { Config } from "../config.js"
import { ConfigWarming } from "../config/warming.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { AgentNotFoundError } from "../session/error.js"
import { PluginHooks } from "./hooks.js"

type ActiveSession = {
  last: number
  /** Start of the warming window: the latest non-warming request. */
  since: number
  expires: number
  agent: Agent.ID
  model: Model.Ref
  settings: SessionWarmingSettings
  /** The last warming ping failed because the pinned agent no longer exists. */
  missingAgent: boolean
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
        // The ping pins the agent and model of the last real request. A blank Enter only
        // commits the composer selection, so the session's stored selection must not retarget
        // the cache the loop is keeping warm. The core generate path reads these fields even
        // though the plugin session surface only declares `sessionID` and `prompt`.
        const ping: Parameters<typeof ctx.session.generate>[0] & {
          agent: Agent.ID
          model: Model.Ref
        } = { sessionID, prompt: settings.prompt, agent: current.agent, model: current.model }
        let pingError: string | undefined
        let pingMissingAgent = false
        yield* ctx.session
          .generate(ping)
          .pipe(
            Effect.catchCause((cause) => {
              pingError = Cause.pretty(cause).slice(0, 160)
              if (Option.getOrUndefined(Cause.findErrorOption(cause)) instanceof AgentNotFoundError)
                pingMissingAgent = true
              return Effect.logWarning("failed to warm session", { sessionID, cause })
            }),
          )
        yield* hooks
          .trigger("session", "warming", {
            sessionID,
            agent: current.agent,
            model: current.model,
            phase: "warmed",
            since: current.since,
            now: yield* Clock.currentTimeMillis,
            error: pingError,
            settings: undefined,
          })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to trigger warmed hook", { cause })))
        // A renamed or deleted agent ends the window when it is still missing
        // on the next ping, as an expired window ends. One transient miss
        // followed by a success keeps warming.
        if (pingMissingAgent && current.missingAgent) {
          if (sessions.get(sessionID) === current) sessions.delete(sessionID)
          yield* Effect.logInfo("stopping session warming: agent not found", {
            sessionID,
            agent: current.agent,
          })
          return
        }
        const latest = sessions.get(sessionID)
        if (latest === current) {
          latest.missingAgent = pingMissingAgent
          if (latest.last === last) latest.last = yield* Clock.currentTimeMillis
        }
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
        // interrupt or reschedule that loop from inside its own generate call. The
        // request is also marked non-durable, which is the primary guard if the fiber
        // identity ever stops matching.
        if (event.durable === false) return
        if (active?.fiber?.id === (yield* Effect.fiberId)) return
        const configured = yield* loadSettings(event.model)

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
          active.missingAgent = false
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
          missingAgent: false,
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
