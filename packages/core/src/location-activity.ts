export * as LocationActivity from "./location-activity.js"

import { Clock, Context, Duration, Effect, Layer, RcMap, Schema } from "effect"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { LocationServiceMap } from "./location-service-map.js"
import { SessionEvent } from "./session/event.js"
import { SessionExecution } from "./session/execution.js"
import { SessionStore } from "./session/store.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

const isSessionEvent = Schema.is(SessionEvent.Durable)

export interface Interface {
  /**
   * Evicts a loaded Location now, unless a Session there is active. This is the
   * idle sweep's eviction without the wait: a team worker's folder releases its
   * cached services as soon as its run stops. A missing or unloaded Location is
   * a no-op, and an active Session there is left to the normal idle timeout.
   */
  readonly evict: (ref: Location.Ref) => Effect.Effect<void>
  /**
   * Whether a Location's services are loaded now. A caller that would boot a
   * folder as a side effect (a cache-warming ping) checks first and skips an
   * unloaded folder, which reads fresh state when it is next loaded.
   */
  readonly loaded: (ref: Location.Ref) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocationActivity") {}

export function layer(options: { readonly timeToLive?: Duration.Input; readonly sweepInterval?: Duration.Input } = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const bus = yield* Bus.Service
      const locations = yield* LocationServiceMap.Service
      const execution = yield* SessionExecution.Service
      const sessions = yield* SessionStore.Service
      const timeToLive = Duration.toMillis(options.timeToLive ?? "60 minutes")
      const entries = new Map<string, { readonly ref: Location.Ref; expiresAt: number }>()
      const key = (ref: Location.Ref) => `${LocationServiceMap.canonical(ref).directory}\0${ref.workspaceID ?? ""}`
      const touch = (ref: Location.Ref) =>
        Effect.sync(() => {
          entries.set(key(ref), { ref, expiresAt: clock.currentTimeMillisUnsafe() + timeToLive })
        })
      // The sessions whose execution is owned here and placed in `ref`.
      const ownersIn = (ref: Location.Ref) =>
        Effect.gen(function* () {
          const active = yield* Effect.forEach(yield* execution.active, (sessionID) => sessions.get(sessionID))
          return active.flatMap((session) => (session && key(session.location) === key(ref) ? [session] : []))
        })
      const invalidate = (ref: Location.Ref) =>
        Effect.logInfo("location services evicted", {
          directory: ref.directory,
          workspaceID: ref.workspaceID,
        }).pipe(Effect.andThen(locations.invalidate(ref)))
      // Whether the location's services are loaded now. `RcMap.has` reports the
      // cache without booting it.
      const loaded = (ref: Location.Ref) => RcMap.has(locations.rcMap, LocationServiceMap.canonical(ref))

      const evict = Effect.fn("LocationActivity.evict")(function* (ref: Location.Ref) {
        // An active Session keeps its folder: the normal idle timeout decides.
        if ((yield* ownersIn(ref)).length > 0) {
          yield* touch(ref)
          return
        }
        entries.delete(key(ref))
        yield* invalidate(ref)
      })

      const unsubscribe = yield* bus.listen((event) => {
        if (!isSessionEvent(event)) return Effect.void
        const location = event.location
        if (!location) return Effect.void
        return RcMap.has(locations.rcMap, location).pipe(
          Effect.flatMap((active) => (active ? touch(location) : Effect.void)),
        )
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Effect.gen(function* () {
        yield* Effect.sleep(options.sweepInterval ?? "1 minute")
        const refs = Array.from(yield* RcMap.keys(locations.rcMap))
        const cached = new Set(refs.map(key))
        yield* Effect.forEach(refs, (ref) => (entries.has(key(ref)) ? Effect.void : touch(ref)), { discard: true })
        for (const id of entries.keys()) {
          if (!cached.has(id)) entries.delete(id)
        }
        const now = clock.currentTimeMillisUnsafe()
        const expired = Array.from(entries.values()).filter((entry) => entry.expiresAt <= now)
        if (expired.length === 0) return
        yield* Effect.forEach(
          expired,
          (entry) =>
            Effect.gen(function* () {
              const owners = yield* ownersIn(entry.ref)
              // Invalidation only detaches the cache entry; borrowers retain the old
              // graph. Stop its executions and settle tool cleanup before detaching it.
              yield* Effect.forEach(
                owners,
                (session) => execution.interrupt(session.id, { reason: "inactivity", awaitSettlement: true }),
                {
                  discard: true,
                  concurrency: "unbounded",
                },
              )
              const remaining = yield* ownersIn(entry.ref)
              // New work admitted during cleanup may now own the cached graph.
              if (remaining.length > 0) {
                yield* touch(entry.ref)
                return
              }
              entries.delete(key(entry.ref))
              yield* invalidate(entry.ref)
            }),
          { discard: true, concurrency: "unbounded" },
        )
      }).pipe(Effect.forever, Effect.forkScoped)

      return Service.of({ evict, loaded })
    }),
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [Bus.node, LocationServiceMap.node, SessionExecution.node, SessionStore.node],
})
