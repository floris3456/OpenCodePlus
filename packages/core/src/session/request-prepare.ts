export * as SessionRequestPrepare from "./request-prepare.js"

import { Context, Duration, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { PluginHooks } from "../plugin/hooks.js"

/**
 * Request preparation measured p50 6 ms and p99 68 ms over 13,872 recorded steps, so 120 s is a
 * hang detector, not a performance budget. It bounds only preparing a step's request (the
 * model-request hooks: session.context, session.model.request) up to the point the request is
 * handed to the model stream; provider retries, rate-limit waits and the stream itself are never
 * covered.
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
      : `stuck in the ${stage.domain}.${stage.name} hook${stage.plugin === undefined ? "" : ` of ${stage.plugin}`}`
  return `Request preparation did not finish within ${bound} (${where})`
}

export const node = makeGlobalNode({ service: Timeout, layer: Layer.succeed(Timeout, TIMEOUT), deps: [] })