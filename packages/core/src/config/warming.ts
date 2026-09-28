export * as ConfigWarming from "./warming.js"

import { Scoped, Warming } from "@opencode/schema/config/warming"
import { Duration, Option, Schema } from "effect"

const defaults = {
  prompt: "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK",
  interval: Duration.minutes(4),
  duration: Duration.minutes(30),
}

export type Resolved = {
  readonly prompt: string
  readonly interval: Duration.Duration
  readonly duration: Duration.Duration
}

type Value = typeof Warming.Type
type ScopedValue = typeof Scoped.Type

const decodeScoped = Schema.decodeUnknownOption(Warming)

// Provider and model settings carry the encoded string form; one decode at this
// boundary turns every level into the same decoded value.
const scoped = (value: ScopedValue | undefined): Value | undefined => Option.getOrUndefined(decodeScoped(value))

/**
 * Applies one level's value over the value inherited from the level above.
 * `false` disables the scope, `true` enables it with defaults, and an object
 * enables it and merges only its provided fields over the inherited settings
 * (or over defaults when the inherited level is disabled). Absent values inherit.
 */
function apply(inherited: Resolved | undefined, value: Value | undefined): Resolved | undefined {
  if (value === undefined) return inherited
  if (value === true) return { ...defaults }
  if (value === false) return undefined
  return { ...(inherited ?? defaults), ...value }
}

/** Resolves global, provider, and model warming for one provider/model selection. */
export function resolve(input: {
  readonly global: Value | undefined
  readonly provider: ScopedValue | undefined
  readonly model: ScopedValue | undefined
}): Resolved | undefined {
  const provider = apply(apply(undefined, input.global), scoped(input.provider))
  return apply(provider, scoped(input.model))
}
