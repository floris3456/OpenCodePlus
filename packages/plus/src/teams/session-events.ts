// The host session lifecycle events a team run's state follows. Kept in their
// own module so the TUI's team monitor can read the set without pulling the
// team runtime (lifecycle.ts and its fs/git/store imports) into the TUI plugin.

export type SessionOutcome = "idle" | "failed" | "interrupted"

// The host's session lifecycle is the only authority on whether a run's model
// turn is over. A child that never called finish still ends its turn, so no
// tool call from the child is needed for its parent to see it idle.
// `session.execution.succeeded` is the canonical host success event
// (`SessionEvent.Execution.Succeeded`, published by core's SessionExecution at
// the end of every busy period); `session.idle` is a deprecated ephemeral event
// the host no longer publishes, kept so older harnesses still settle.
export const SessionOutcomes: Record<string, SessionOutcome> = {
  "session.execution.succeeded": "idle",
  "session.idle": "idle",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
}

// Every host session event that changes what a run's state machine sees;
// streaming *.delta events are never here.
export const SessionRunEvents: ReadonlySet<string> = new Set([
  ...Object.keys(SessionOutcomes),
  "session.execution.started",
])
