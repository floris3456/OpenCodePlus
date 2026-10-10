import type { Meter } from "../pacer/meter.js"
import type { UsageInput, UsageSnapshot } from "./usage.js"

/** Keep Pacer's freshness decision separate from the age of its provider reading. */
export function pacerSnapshot(
  meter: Pick<Meter, "lastServed" | "rows">,
  input: UsageInput,
  now: number,
): UsageSnapshot {
  const served = input.sessionID ? meter.lastServed(input.sessionID) : undefined
  const rows = meter.rows()
  return {
    protocol: 1,
    view: "usage",
    now: now / 1000,
    max_age_seconds: 90,
    all: input.all || !served,
    provider: rows.find((c) => c.id === served?.auth)?.provider ?? "",
    model: input.modelID,
    current: served?.auth ?? "",
    active: [],
    last_used: (served?.at_ms ?? 0) / 1000,
    credentials: rows
      .filter((c) => input.all || !served || c.id === served.auth)
      .map((c) => ({
        id: c.id,
        alias: c.alias,
        provider: c.provider,
        shared_with: c.shared_with,
        windows: c.windows
          .filter((w) => w.left !== undefined && (w.reset_ms !== undefined || w.state === "dormant"))
          .map((w) => ({
            scope: w.scope,
            seconds: w.seconds,
            remaining: w.left!,
            reset: (w.reset_ms ?? 0) / 1000,
            state: w.state,
            updated: c.at_ms / 1000,
            observed: (w.read_ms ?? c.at_ms) / 1000,
            held: false,
            dormant: w.state === "dormant",
            not_applicable: !w.applies,
          })),
      })),
  }
}
