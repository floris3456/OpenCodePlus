import { Option, Schema } from "effect"
import { CompactionObservation } from "@opencode/plugin/compaction-observation"
import { PromptCacheDiagnostic } from "@opencode/plugin/prompt-cache-diagnostic"
import { DroppedThinking } from "@opencode/plugin/dropped-thinking"

const field = Schema.Struct({
  source: Schema.Literals(["reported", "derived"]),
  completeness: Schema.Literals(["complete", "partial"]),
})
const token = Schema.Number.check(Schema.isFinite())
const bucket = token.check(Schema.isGreaterThanOrEqualTo(0))

/** Allow-listed measurement payload. No metadata, response body, headers or error text. */
export const Observation = Schema.Struct({
  version: Schema.Literal(1),
  completeness: Schema.Literals(["final", "partial", "unavailable"]),
  scope: Schema.optional(Schema.Literals(["invocation", "exchange"])),
  invocationID: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  operationID: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  exchangeCount: Schema.optional(Schema.Number),
  historyEpoch: Schema.optional(Schema.String),
  compaction: Schema.optional(CompactionObservation),
  promptCacheDiagnostic: Schema.optional(PromptCacheDiagnostic),
  droppedThinking: Schema.optional(DroppedThinking),
  inputTokens: Schema.optional(token),
  cacheReadInputTokens: Schema.optional(token),
  cacheWriteInputTokens: Schema.optional(token),
  cacheWriteInputTokensByTTL: Schema.optional(
    Schema.Struct({
      "5m": Schema.optional(bucket),
      "1h": Schema.optional(bucket),
    }),
  ),
  nonCachedInputTokens: Schema.optional(token),
  outputTokens: Schema.optional(token),
  reasoningTokens: Schema.optional(token),
  provenance: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(field),
      cacheReadInputTokens: Schema.optional(field),
      cacheWriteInputTokens: Schema.optional(field),
      cacheWriteInputTokensByTTL: Schema.optional(
        Schema.Struct({
          "5m": Schema.optional(field),
          "1h": Schema.optional(field),
        }),
      ),
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
  const sum = (value.cacheWriteInputTokensByTTL?.["5m"] ?? 0) + (value.cacheWriteInputTokensByTTL?.["1h"] ?? 0)
  return (
    value.inconsistent === true ||
    (value.cacheWriteInputTokens !== undefined &&
      (sum > value.cacheWriteInputTokens ||
        (value.cacheWriteInputTokensByTTL?.["5m"] !== undefined &&
          value.cacheWriteInputTokensByTTL?.["1h"] !== undefined &&
          sum !== value.cacheWriteInputTokens))) ||
    (["5m", "1h"] as const).some(
      (ttl) =>
        value.cacheWriteInputTokensByTTL?.[ttl] !== undefined &&
        value.provenance?.cacheWriteInputTokensByTTL?.[ttl]?.completeness === "partial",
    ) ||
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
