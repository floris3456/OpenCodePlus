import { Schema } from "effect"
import { ProviderMetadata } from "./options.js"
import { PromptCacheDiagnostic } from "./prompt-cache-diagnostic.js"
import { DroppedThinking } from "./dropped-thinking.js"

const fieldProvenance = Schema.Struct({
  source: Schema.Literals(["reported", "derived"]),
  completeness: Schema.Literals(["complete", "partial"]),
})

/**
 * Token usage reported by an LLM provider.
 *
 * **Inclusive totals** (match AI SDK / OpenAI / LangChain convention — a
 * reader from any of those ecosystems sees the number they expect):
 *
 * - `inputTokens` — total prompt tokens, *including* cached reads/writes.
 * - `outputTokens` — total output tokens, *including* reasoning.
 * - `totalTokens` — provider-supplied total, or `inputTokens + outputTokens`.
 *
 * **Non-overlapping breakdown** (every field is independently meaningful;
 * consumers never have to subtract):
 *
 * - `nonCachedInputTokens` — the "fresh" portion of the prompt.
 * - `cacheReadInputTokens` — input tokens served from cache.
 * - `cacheWriteInputTokens` — input tokens written to cache.
 * - `reasoningTokens` — subset of `outputTokens` spent on hidden reasoning.
 *
 * **Invariant**: `nonCachedInputTokens + cacheReadInputTokens +
 * cacheWriteInputTokens = inputTokens`, and `reasoningTokens ≤ outputTokens`.
 * Each protocol mapper computes whichever side it doesn't get natively,
 * with `Math.max(0, …)` clamping for defense against provider bugs. Because
 * every breakdown field is stored independently, downstream consumers can
 * read whatever they need (cost-by-category, context-pressure, AI-SDK-style
 * inclusive total) without ever subtracting — eliminating the underflow
 * class of bug where a clamped difference would silently store the wrong
 * value.
 *
 * **Semantics by provider**:
 *
 * - OpenAI Chat / Responses / Gemini: provider reports inclusive
 *   `inputTokens` and an inclusive `outputTokens`; mapper subtracts to
 *   derive the breakdown.
 * - Anthropic and Bedrock report the input breakdown natively: Anthropic's
 *   `input_tokens` and Bedrock's `inputTokens` are non-cached only. Their
 *   mappers sum the breakdown to derive the inclusive `inputTokens`.
 *   Anthropic's `outputTokens` includes extended thinking. Newer responses
 *   expose that subset as `output_tokens_details.thinking_tokens`, which maps
 *   to `reasoningTokens`; older responses leave it undefined.
 *
 * `providerMetadata` always carries the provider's raw usage payload —
 * keyed by provider name (`{ openai: ... }`, `{ anthropic: ... }`, etc.)
 * — for fields we don't normalize and for billing-level audit trails.
 * Matches the same escape-hatch field on `LLMEvent`.
 */
export class Usage extends Schema.Class<Usage>("AI.Usage")({
  /** Effective input size of the final message iteration, when reported; not billed totals. */
  contextTokens: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  nonCachedInputTokens: Schema.optional(Schema.Number),
  cacheReadInputTokens: Schema.optional(Schema.Number),
  cacheWriteInputTokens: Schema.optional(Schema.Number),
  /** Reported cache creation counts by TTL, never inferred from request markers. */
  cacheWriteInputTokensByTTL: Schema.optional(
    Schema.Struct({
      "5m": Schema.optional(Schema.Number),
      "1h": Schema.optional(Schema.Number),
    }),
  ),
  reasoningTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  /** Best-effort comparison estimates, separate from all actual token counters. */
  promptCacheDiagnostic: Schema.optional(PromptCacheDiagnostic),
  /** Provider-reported thinking blocks removed from this request before the model read it. */
  droppedThinking: Schema.optional(DroppedThinking),
  /** Measurement provenance, independent of the compatibility accounting values above.
   * Absence is unknown; in particular it must not turn a partial sum into a complete total.
   */
  provenance: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(fieldProvenance),
      cacheReadInputTokens: Schema.optional(fieldProvenance),
      cacheWriteInputTokens: Schema.optional(fieldProvenance),
      cacheWriteInputTokensByTTL: Schema.optional(
        Schema.Struct({
          "5m": Schema.optional(fieldProvenance),
          "1h": Schema.optional(fieldProvenance),
        }),
      ),
      nonCachedInputTokens: Schema.optional(fieldProvenance),
      outputTokens: Schema.optional(fieldProvenance),
      reasoningTokens: Schema.optional(fieldProvenance),
    }),
  ),
  providerMetadata: Schema.optional(ProviderMetadata),
}) {
  /**
   * Non-reasoning output tokens (including compaction summaries) — `outputTokens` minus `reasoningTokens`, clamped
   * to zero. The one place subtraction happens in this contract; the clamp
   * means a provider reporting `reasoningTokens > outputTokens` produces a
   * harmless zero rather than a negative that crashes downstream schemas.
   */
  get visibleOutputTokens() {
    return Math.max(0, (this.outputTokens ?? 0) - (this.reasoningTokens ?? 0))
  }

  static from(input: UsageInput) {
    return input instanceof Usage ? input : new Usage(input)
  }

  /** Sparse monitor view. Accounting compatibility values are never evidence of presence.
   * Protocols without provenance deliberately have no usable measurement coverage yet.
   */
  observation(completeness: "final" | "partial" | "unavailable") {
    const bucketOf = (ttl: "5m" | "1h") => {
      const value = this.cacheWriteInputTokensByTTL?.[ttl]
      return completeness !== "unavailable" &&
        value !== undefined &&
        Number.isFinite(value) &&
        value >= 0 &&
        this.provenance?.cacheWriteInputTokensByTTL?.[ttl]?.completeness === "complete"
        ? value
        : undefined
    }
    const buckets = { "5m": bucketOf("5m"), "1h": bucketOf("1h") }
    const bucketValues = [this.cacheWriteInputTokensByTTL?.["5m"], this.cacheWriteInputTokensByTTL?.["1h"]]
    const bucketSum = bucketValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    const fields = [
      "inputTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
      "nonCachedInputTokens",
      "outputTokens",
      "reasoningTokens",
    ] as const
    const valueOf = (field: (typeof fields)[number]) => {
      const value = this[field]
      return completeness !== "unavailable" &&
        value !== undefined &&
        Number.isFinite(value) &&
        this.provenance?.[field]?.completeness === "complete"
        ? value
        : undefined
    }
    return {
      version: 1 as const,
      completeness,
      ...(this.promptCacheDiagnostic ? { promptCacheDiagnostic: this.promptCacheDiagnostic } : {}),
      ...(this.droppedThinking ? { droppedThinking: this.droppedThinking } : {}),
      inputTokens: valueOf("inputTokens"),
      cacheReadInputTokens: valueOf("cacheReadInputTokens"),
      cacheWriteInputTokens: valueOf("cacheWriteInputTokens"),
      ...(buckets["5m"] !== undefined || buckets["1h"] !== undefined
        ? { cacheWriteInputTokensByTTL: Object.freeze(buckets) }
        : {}),
      nonCachedInputTokens: valueOf("nonCachedInputTokens"),
      outputTokens: valueOf("outputTokens"),
      reasoningTokens: valueOf("reasoningTokens"),
      provenance: this.provenance?.cacheWriteInputTokensByTTL
        ? {
            ...this.provenance,
            cacheWriteInputTokensByTTL: Object.freeze({
              "5m": this.provenance.cacheWriteInputTokensByTTL["5m"]
                ? Object.freeze({ ...this.provenance.cacheWriteInputTokensByTTL["5m"] })
                : undefined,
              "1h": this.provenance.cacheWriteInputTokensByTTL["1h"]
                ? Object.freeze({ ...this.provenance.cacheWriteInputTokensByTTL["1h"] })
                : undefined,
            }),
          }
        : this.provenance,
      inconsistent:
        fields.some((field) => this[field] !== undefined && (!Number.isFinite(this[field]) || this[field] < 0)) ||
        bucketValues.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0)) ||
        (this.cacheWriteInputTokens !== undefined &&
          (bucketSum > this.cacheWriteInputTokens ||
            ((["5m", "1h"] as const).every(
              (ttl) => this.provenance?.cacheWriteInputTokensByTTL?.[ttl]?.completeness === "complete",
            ) &&
              bucketSum !== this.cacheWriteInputTokens))) ||
        (this.inputTokens !== undefined &&
          this.cacheReadInputTokens !== undefined &&
          this.cacheWriteInputTokens !== undefined &&
          this.cacheReadInputTokens + this.cacheWriteInputTokens > this.inputTokens),
    }
  }
}

export type UsageInput = Usage | ConstructorParameters<typeof Usage>[0]
