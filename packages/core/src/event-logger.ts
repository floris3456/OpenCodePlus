export * as EventLogger from "./event-logger.js"

import { Effect, Layer } from "effect"
import type { Event } from "@opencode/schema/event"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "./bus.js"

const EVENT_TYPES = new Set(["agent.updated", "provider.updated", "model.updated", "command.updated", "config.updated"])

/** Longest a single event type may write one line to the log. */
const WINDOW = "10 seconds"

interface Pending {
  event: Event.Payload
  count: number
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    // Registry storms used to fill the log. One line per type per window keeps
    // them visible without pushing the rest of the log out.
    const scope = yield* Effect.scope
    const pending = new Map<string, Pending>()

    const flush = (type: string) =>
      Effect.suspend(() => {
        const state = pending.get(type)
        if (!state || state.count === 0) return Effect.void
        const line = { event: state.event, count: state.count }
        state.count = 0
        return Effect.logInfo("event", line)
      })

    // One repeating window per observed type. Events between ticks only count;
    // each tick logs the count since the previous line when it is non-zero.
    const watch = (type: string) =>
      Effect.sleep(WINDOW).pipe(
        Effect.andThen(flush(type)),
        Effect.forever,
        Effect.forkIn(scope, { startImmediately: true }),
      )

    const unsubscribe = yield* bus.listen((event) =>
      EVENT_TYPES.has(event.type)
        ? Effect.suspend(() => {
            const state = pending.get(event.type)
            if (!state) {
              // The first event of a type logs at once, then opens its window.
              pending.set(event.type, { event, count: 0 })
              return Effect.logInfo("event", { event }).pipe(Effect.andThen(watch(event.type)))
            }
            state.count += 1
            state.event = event
            return Effect.void
          })
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
  }),
)

export const node = makeGlobalNode({ name: "event-logger", layer, deps: [Bus.node] })
