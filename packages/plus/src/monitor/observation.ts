import { Option, Schema } from "effect"

const field = Schema.Struct({
  source: Schema.Literals(["reported", "derived"]),
  completeness: Schema.Literals(["complete", "partial"]),
})
const token = Schema.Number.check(Schema.isFinite())

/** Allow-listed measurement payload. No metadata, response body, headers or error text. */
export const Observation = Schema.Struct({
  version: Schema.Literal(1),
  completeness: Schema.Literals(["final", "partial", "unavailable"]),
  scope: Schema.optional(Schema.Literals(["invocation", "exchange"])),
  invocationID: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  operationID: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  exchangeCount: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(token),
  cacheReadInputTokens: Schema.optional(token),
  cacheWriteInputTokens: Schema.optional(token),
  nonCachedInputTokens: Schema.optional(token),
  outputTokens: Schema.optional(token),
  reasoningTokens: Schema.optional(token),
  provenance: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(field),
      cacheReadInputTokens: Schema.optional(field),
      cacheWriteInputTokens: Schema.optional(field),
      nonCachedInputTokens: Schema.optional(field),
      outputTokens: Schema.optional(field),
      reasoningTokens: Schema.optional(field),
    }),
  ),
  inconsistent: Schema.optional(Schema.Boolean),
})

export type Observation = typeof Observation.Type
export type RequestObservation = Omit<Observation, "version"> & { readonly version: number }

export function inconsistentObservation(value: Observation) {
  return (
    value.inconsistent === true ||
    [
      value.inputTokens,
      value.cacheReadInputTokens,
      value.cacheWriteInputTokens,
      value.nonCachedInputTokens,
      value.outputTokens,
      value.reasoningTokens,
    ].some((tokens) => tokens !== undefined && tokens < 0) ||
    (value.inputTokens !== undefined &&
      value.cacheReadInputTokens !== undefined &&
      value.cacheWriteInputTokens !== undefined &&
      value.cacheReadInputTokens + value.cacheWriteInputTokens > value.inputTokens)
  )
}

/** Unsupported/malformed payloads remain in storage, but never supply usable measurements. */
export function readObservation(text: string): RequestObservation {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Observation))(text)
  if (Option.isSome(decoded))
    return decoded.value.inputTokens !== undefined && decoded.value.provenance?.inputTokens?.completeness === "partial"
      ? { version: 1, completeness: "unavailable" }
      : inconsistentObservation(decoded.value)
        ? { ...decoded.value, inconsistent: true }
        : decoded.value
  const header = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ version: Schema.Number })))(text)
  return { version: Option.isSome(header) ? header.value.version : 0, completeness: "unavailable" }
}
