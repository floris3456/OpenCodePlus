import { Effect, Predicate } from "effect"

// Lifts a promise into Effect keeping the original rejection value in the
// failure channel (bare tryPromise would wrap it). Shared by the teams data
// layer so expected filesystem races (EEXIST, ENOENT) recover through
// Effect.catchIf / Effect.ignore instead of throw statements.
export function io<A>(task: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: task, catch: (error) => error })
}

export function errCode(error: unknown): string | undefined {
  if (!Predicate.isObject(error)) return undefined
  return Predicate.isString(error.code) ? error.code : undefined
}
