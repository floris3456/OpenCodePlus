import { Schema } from "effect"

/** Thinking blocks the provider removed from the request before the model read it, as the provider reported them.
 * The model answered without their reasoning. Anthropic reports these as `thinking_dropped` input transformations
 * when a block's binding no longer matches the request ahead of it.
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 */
export const DroppedThinking = Schema.Struct({
  blocks: Schema.Number,
  /** Request path of the first reported block, such as `messages.3.content.0`. */
  first: Schema.optional(Schema.String),
  /** The provider's reasons, such as `prefix_binding_mismatch`. */
  reasons: Schema.Array(Schema.String),
})
export type DroppedThinking = typeof DroppedThinking.Type
