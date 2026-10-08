export * as SessionRequestPrepare from "./request-prepare.js"

import { Context, Duration, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { PluginHooks } from "../plugin/hooks.js"

/**
 * Request preparation measured p50 6 ms and p99 68 ms over 13,872 recorded steps, so 120 s is a
 * hang detector, not a performance budget. It bounds each preparation stage of a step on its own
 * (loading the session context, the compaction decision, the model-request hooks) up to the point
 * the request is handed to the model stream; provider retries, rate-limit waits and the stream
 * itself are never covered.
 */
export const TIMEOUT: Duration.Duration = Duration.seconds(120)

/**
 * The bound is a plain value on a Reference so a test can run it fast through the smallest existing
 * seam. Production never overrides it; there is no config file, environment variable or public
 * option surface for it.
 */
export const Timeout = Context.Reference<Duration.Duration>("@opencode/SessionRequestPrepareTimeout", {
  defaultValue: () => TIMEOUT,
})

/** Names the stage in a timeout message, including the plugin when its registration knew one. */
export function message(timeout: Duration.Duration, stage: PluginHooks.Stage | undefined) {
  const bound = `${Duration.toSeconds(timeout)}s`
  const where =
    stage === undefined
      ? "while preparing the request"
      : stage.kind === "stage"
        ? `while ${stage.label}`
        : `stuck in the ${stage.domain}.${stage.name} hook${stage.plugin === undefined ? "" : ` of ${stage.plugin}`}`
  return `Request preparation did not finish within ${bound} (${where})`
}

/**
 * Runs one preparation stage under the bound. A named `stage` is installed for the duration so a
 * timeout inside non-hook work names it; a hung hook overrides it and is not restored. `onTimeout`
 * builds the failure after the timeout fires, when the stage slot holds the hung hook or stage.
 */
export function bound<A, E, R, E2, R2>(
  hooks: PluginHooks.Interface,
  effect: Effect.Effect<A, E, R>,
  stage: PluginHooks.Stage | undefined,
  onTimeout: (stage: PluginHooks.Stage | undefined, timeout: Duration.Duration) => Effect.Effect<never, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> {
  return Effect.gen(function* () {
    const timeout = yield* Timeout
    const previous = yield* hooks.stage
    if (stage !== undefined) yield* hooks.setStage(stage)
    const result = yield* effect.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => hooks.stage.pipe(Effect.flatMap((current) => onTimeout(current, timeout))),
      }),
    )
    if (stage !== undefined) yield* hooks.setStage(previous)
    return result
  })
}

export const node = makeGlobalNode({ service: Timeout, layer: Layer.succeed(Timeout, TIMEOUT), deps: [] })
