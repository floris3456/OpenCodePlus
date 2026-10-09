import { Option, Schema } from "effect"
import { PromptCacheDiagnostic } from "../../schema/prompt-cache-diagnostic.js"

const wire = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  reason: Schema.optional(Schema.Unknown),
  comparison_reusable_tokens: Schema.optional(Schema.Unknown),
  cache_missed_tokens: Schema.optional(Schema.Unknown),
})

/** Passive reception only. Unknown strings are never retained as provider verdicts or error text. */
export function openaiCacheDiagnostic(value: unknown): PromptCacheDiagnostic | undefined {
  if (value === undefined || value === null) return undefined
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(wire)(value))
  const reportedOutcome =
    Option.getOrUndefined(Schema.decodeUnknownOption(PromptCacheDiagnostic.fields.reportedOutcome)(decoded?.type)) ??
    "unknown"
  const reason =
    reportedOutcome === "cache_miss"
      ? Option.getOrUndefined(Schema.decodeUnknownOption(PromptCacheDiagnostic.fields.reason)(decoded?.reason))
      : undefined
  const outcome =
    reportedOutcome === "cache_hit"
      ? "cache_hit"
      : reportedOutcome === "cache_miss" && reason
        ? "cache_miss"
        : "unknown"
  return {
    version: 1,
    source: "provider-reported",
    protocol: "openai-responses",
    outcome,
    reportedOutcome,
    ...(reason ? { reason } : {}),
    ...(reportedOutcome === "cache_miss"
      ? {
          comparisonReusableTokens: Option.getOrUndefined(
            Schema.decodeUnknownOption(PromptCacheDiagnostic.fields.comparisonReusableTokens)(
              decoded?.comparison_reusable_tokens,
            ),
          ),
          cacheMissedTokens: Option.getOrUndefined(
            Schema.decodeUnknownOption(PromptCacheDiagnostic.fields.cacheMissedTokens)(decoded?.cache_missed_tokens),
          ),
        }
      : {}),
  }
}
