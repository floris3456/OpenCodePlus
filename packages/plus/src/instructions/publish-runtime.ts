import { AsyncLocalStorage } from "node:async_hooks"
import { Effect, type Context } from "effect"

// Plus installs its registrations from async code through Effect.runPromise,
// which starts each effect on a fresh fiber with no services. Inside a publish
// those effects must see the publish's core batch (`ctx.batch`), so the host
// rebuilds and reconciles each registry once per publish instead of once per
// install and dispose. The batch's Effect context rides here across awaits.
const publishContext = new AsyncLocalStorage<Context.Context<never>>()

/** `Effect.runPromise`, inside the current publish's batch when there is one. */
export function runPublish<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const context = publishContext.getStore()
  return context === undefined ? Effect.runPromise(effect) : Effect.runPromiseWith(context)(effect)
}

/** Runs one publish's installs and disposals as one core batch. */
export function inPublishBatch<A>(
  batch: <X, E, R>(effect: Effect.Effect<X, E, R>) => Effect.Effect<X, E, R>,
  run: () => Promise<A>,
): Effect.Effect<A> {
  return batch(
    Effect.gen(function* () {
      const context = yield* Effect.context<never>()
      return yield* Effect.promise(() => publishContext.run(context, run))
    }),
  )
}
