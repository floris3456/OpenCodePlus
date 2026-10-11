export * as SessionMovement from "./movement.js"

import { Effect } from "effect"
import type { Session } from "@opencode/schema/session"
import type { Instance } from "../instance/service.js"
import { PluginHooks } from "../plugin/hooks.js"
import type { SessionStore } from "./store.js"

/** Await destination integrations after the placement commits and before any destination execution. */
export const commit = Effect.fn("SessionMovement.commit")(function* (
  store: SessionStore.Interface,
  instances: Instance.Interface,
  sessionID: Session.ID,
  publish: Effect.Effect<void>,
): Effect.fn.Return<void> {
  const source = yield* store.get(sessionID)
  if (!source) return yield* Effect.die("Missing moving session")
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      yield* publish
      const destination = yield* store.get(sessionID)
      if (!destination) return yield* Effect.die("Missing moved session")
      yield* Effect.gen(function* () {
        // PluginHost depends on SessionMove; defer this edge until the placement is committed.
        const { Plugin } = yield* Effect.promise(() => import("../plugin.js"))
        const plugins = yield* Plugin.Service
        const hooks = yield* PluginHooks.Service
        yield* plugins.awaitActivation
        yield* hooks.trigger("session", "moved", { source, destination })
      }).pipe(instances.provide(destination), Effect.orDie)
    }),
  )
})
