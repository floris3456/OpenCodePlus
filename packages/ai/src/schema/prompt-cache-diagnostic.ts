import { Schema } from "effect"

/** OpenAI's documented allowlist, checked 2026-10-09. Not actual usage or a local cache verdict.
 * https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics
 */
export const PromptCacheDiagnostic = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Literal("provider-reported"),
  protocol: Schema.Literal("openai-responses"),
  outcome: Schema.Literals(["cache_hit", "cache_miss", "unknown"]),
  reportedOutcome: Schema.Literals([
    "cache_hit",
    "cache_miss",
    "comparison_response_not_found",
    "unavailable",
    "unknown",
  ]),
  reason: Schema.optional(
    Schema.Literals([
      "model_changed",
      "prompt_cache_key_changed",
      "service_tier_changed",
      "tools_changed",
      "text_format_changed",
      "reasoning_effort_changed",
      "verbosity_changed",
      "context_compacted",
      "input_changed",
    ]),
  ),
  comparisonReusableTokens: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  cacheMissedTokens: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
}).check(
  Schema.makeFilter(
    (value) =>
      value.outcome ===
      (value.reportedOutcome === "cache_hit"
        ? "cache_hit"
        : value.reportedOutcome === "cache_miss" && value.reason
          ? "cache_miss"
          : "unknown"),
  ),
)
export type PromptCacheDiagnostic = typeof PromptCacheDiagnostic.Type
