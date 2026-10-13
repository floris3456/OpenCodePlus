export * as SessionModelObservation from "./model-observation.js"

import { LLMEvent, Usage } from "@opencode/ai"
import type { SessionModelObserved } from "@opencode/plugin/effect/session"
import type { CompactionObservation } from "@opencode/plugin/compaction-observation"
import { Context, Effect, Exit } from "effect"
import type { PluginHooks } from "../plugin/hooks.js"
import type { Model } from "@opencode/schema/model"
import { SessionUsage } from "./usage.js"

type Scope = Pick<SessionModelObserved, "sessionID" | "agent" | "model" | "kind" | "historyEpoch">
type Exchange = {
  requestID: string
  transport: "http" | "websocket"
  started: number
  outcome: "prepared" | "response" | "failed"
}
type Invocation = {
  id: string
  usage?: Usage
  terminal: boolean
  failed: boolean
  exchangeCount: number
  exchanges: Exchange[]
}

export const Current = Context.Reference<Invocation | undefined>("SessionModelObservation", {
  defaultValue: () => undefined,
})
export const Purpose = Context.Reference<"warming" | undefined>("SessionModelObservation/Purpose", {
  defaultValue: () => undefined,
})
export const Compaction = Context.Reference<CompactionObservation | undefined>("SessionModelObservation/Compaction", {
  defaultValue: () => undefined,
})
const Operation = Context.Reference<string | undefined>("SessionModelObservation/Operation", {
  defaultValue: () => undefined,
})

export const operation = <A, E, R>(effect: Effect.Effect<A, E, R>, id?: string) =>
  Effect.suspend(() => effect.pipe(Effect.provideService(Operation, id ?? crypto.randomUUID())))

type Identity = { operationID?: string; messageID?: string; onStart?: (invocationID: string) => void }
export type Observer = <A, E, R>(effect: Effect.Effect<A, E, R>, identity?: Identity) => Effect.Effect<A, E, R>

export function make(hooks: PluginHooks.Interface, scope: Scope, costs?: Model.Info["cost"]): Observer {
  const operationID = crypto.randomUUID()
  return (effect, identity) =>
    Effect.flatMap(Operation, (operation) =>
      Effect.flatMap(Purpose, (purpose) =>
        Effect.flatMap(Compaction, (compaction) => Effect.suspend(() => {
          const invocation: Invocation = {
            id: crypto.randomUUID(),
            terminal: false,
            failed: false,
            exchangeCount: 0,
            exchanges: [],
          }
          identity?.onStart?.(invocation.id)
          const started = Date.now()
          return effect.pipe(
            Effect.provideService(Current, invocation),
            Effect.onExit((exit) => {
              const usage = (invocation.usage ?? new Usage({})).observation(
                invocation.usage ? (invocation.terminal ? "final" : "partial") : "unavailable",
              )
              Object.values(usage.provenance ?? {}).forEach(Object.freeze)
              Object.freeze(usage.provenance)
              Object.freeze(usage.promptCacheDiagnostic)
              const accounting = invocation.usage ? SessionUsage.tokens(invocation.usage) : undefined
              if (accounting) Object.freeze(accounting.cache)
              const event: SessionModelObserved = Object.freeze({
                ...scope,
                purpose,
                compaction: compaction ? Object.freeze({ ...compaction }) : undefined,
                model: Object.freeze({ ...scope.model }),
                invocationID: invocation.id,
                operationID: identity?.operationID ?? operation ?? operationID,
                messageID: identity?.messageID,
                started,
                ended: Date.now(),
                outcome: Exit.hasInterrupts(exit)
                  ? "cancelled"
                  : Exit.isFailure(exit) || invocation.failed
                    ? "failed"
                    : "completed",
                usage: Object.freeze(usage),
                accounting: accounting
                  ? Object.freeze({
                      tokens: Object.freeze(accounting),
                      cost: costs?.length ? SessionUsage.calculateCost(costs, accounting) : undefined,
                    })
                  : undefined,
                exchanges: Object.freeze(invocation.exchanges.map((exchange) => Object.freeze({ ...exchange }))),
                exchangeCount: invocation.exchangeCount,
              })
              // A failing observer is not model work, must not enter retries, and must not leak its error text.
              return hooks.trigger("session", "model.observed", event).pipe(
                Effect.asVoid,
                Effect.timeout("2 seconds"),
                Effect.catchCause(() =>
                  Effect.logWarning("session model observation unavailable", { code: "observer-failed" }),
                ),
              )
            }),
          )
        })),
      ),
    )
}

export function run<A, E, R>(observer: Observer | undefined, effect: Effect.Effect<A, E, R>, identity?: Identity) {
  return observer ? observer(effect, identity) : effect
}

export const capture = (event: LLMEvent) =>
  Effect.gen(function* () {
    const invocation = yield* Current
    if (!invocation) return
    if (LLMEvent.is.providerError(event)) invocation.failed = true
    if (LLMEvent.is.stepFinish(event) || LLMEvent.is.finish(event)) invocation.usage = event.usage ?? invocation.usage
    if (LLMEvent.is.finish(event)) {
      invocation.terminal = true
      if (event.reason.normalized === "error" || event.reason.normalized === "unknown") invocation.failed = true
    }
  })

export const captureUsage = (usage: Usage | undefined) =>
  Effect.gen(function* () {
    const invocation = yield* Current
    if (!invocation) return
    invocation.usage = usage ?? invocation.usage
    invocation.terminal = true
  })

export const exchange = (transport: Exchange["transport"], requestID: string, started: number) =>
  Effect.gen(function* () {
    const invocation = yield* Current
    if (!invocation) return undefined
    const exchange: Exchange = { transport, requestID, started, outcome: "prepared" }
    invocation.exchangeCount++
    if (invocation.exchanges.length < 16) invocation.exchanges.push(exchange)
    return { invocationID: invocation.id, exchange }
  })

/** Final wire observers are read-only too; transforms retain their existing failure semantics. */
export const finalObservers = <A>(observers: Array<(value: A) => Effect.Effect<void>>, value: A) =>
  Effect.suspend(() => {
    let warned = false
    return Effect.forEach(observers, (observe) =>
      Effect.suspend(() => observe(value)).pipe(
        Effect.timeout("1 second"),
        Effect.catchCause(() => {
          if (warned) return Effect.void
          warned = true
          return Effect.logWarning("session final wire observer failed", { code: "observer-failed" })
        }),
      ),
    ).pipe(Effect.asVoid)
  })
