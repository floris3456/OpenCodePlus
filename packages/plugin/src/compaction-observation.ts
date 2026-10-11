import { Schema } from "effect"

/** Resolved at execution, never inferred from a later configuration read. No free-form metadata. */
export const CompactionObservation = Schema.Struct({
  version: Schema.Literal(1),
  trigger: Schema.Literals(["manual", "context-threshold", "overflow", "cold", "handoff", "armed", "hook-request", "input-threshold", "output-threshold"]),
  threshold: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  configuredStrategy: Schema.Literals(["auto", "local", "remote"]),
  /** Resolved active-model policy; absence means no native policy was configured. */
  modelPolicy: Schema.optional(Schema.Literals(["native", "summary"])),
  strategySource: Schema.Literals([
    "built-in", "agent-config", "decision-hook", "checkpoint-owner",
    "defaults", "global", "project", "preset", "model", "config", "every", "host", "chat", "agent", "agents",
  ]),
  selectedStrategy: Schema.Literals(["native", "text-summary"]),
  selectionReason: Schema.Literals([
    "explicit-local", "explicit-remote", "portable-required", "auto-native", "auto-text",
    "anthropic-below-minimum", "native-not-triggered", "native-unavailable", "checkpoint-handoff",
  ]),
  modelSource: Schema.optional(Schema.Literals(["active-model", "decision-hook", "agent-config", "compaction-agent", "fallback-list", "checkpoint-owner"])),
})

export type CompactionObservation = typeof CompactionObservation.Type
