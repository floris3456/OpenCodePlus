import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"

/**
 * The early thresholds a chat's model resolves in Instructions (Compaction ›
 * Input / Output token threshold). Adds only an early request, after
 * armed/cold/quota decisions have had their precedence.
 */
export function decideCompactionTriggers(
  event: SessionCompactionDecision,
  triggers: { readonly input?: number | undefined; readonly output?: number | undefined },
) {
  if (event.reason !== "auto" || !event.auto || event.due || event.compact || event.refusal || !event.metrics?.advanced)
    return
  const trigger =
    triggers.input !== undefined && triggers.input > 0 && event.metrics.input >= triggers.input
      ? "input-threshold"
      : triggers.output !== undefined && triggers.output > 0 && event.metrics.output >= triggers.output
        ? "output-threshold"
        : undefined
  if (trigger === undefined) return
  event.compact = true
  event.explanation = {
    ...event.explanation,
    trigger,
    threshold: trigger === "input-threshold" ? triggers.input : triggers.output,
  }
}
