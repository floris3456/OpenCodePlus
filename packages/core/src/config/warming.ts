export * as ConfigWarming from "./warming.js"

import { builtIn, Scoped, Warming } from "@opencode/schema/config/warming"
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

/** The model's built-in warming (schema `builtIn`) as settings; undefined where it has none. */
function builtInFor(id: string | undefined): Resolved | undefined {
  const own = id === undefined ? undefined : builtIn(id)
  return own && { ...defaults, interval: Duration.millis(own.interval), duration: Duration.millis(own.duration) }
}

/**
 * Applies one level's value over the value inherited from the level above.
 * `false` disables the scope, `true` enables it with the model's defaults, and an object
 * enables it and merges only its provided fields over the inherited settings
 * (or over the model's defaults when the inherited level is disabled). Absent values inherit.
 */
function apply(inherited: Resolved | undefined, value: Value | undefined, base: Resolved): Resolved | undefined {
  if (value === undefined) return inherited
  if (value === true) return { ...base }
  if (value === false) return undefined
  return { ...(inherited ?? base), ...value }
}

/**
 * Resolves global, provider, and model warming for one provider/model selection. With none of them
 * set, the model's built-in warming applies (on for Claude and GPT-5.6+, off otherwise).
 */
export function resolve(input: {
  readonly global: Value | undefined
  readonly provider: ScopedValue | undefined
  readonly model: ScopedValue | undefined
  /** The model's id, for its built-in warming and defaults. */
  readonly id?: string
}): Resolved | undefined {
  const own = builtInFor(input.id)
  const providerValue = scoped(input.provider)
  const modelValue = scoped(input.model)
  if (input.global === undefined && providerValue === undefined && modelValue === undefined) return own
  const base = own ?? defaults
  return apply(apply(apply(undefined, input.global, base), providerValue, base), modelValue, base)
}
