import type { Meter } from "opencode-pacer/core"
import type { UsageInput, UsageSnapshot } from "./usage.js"

/** Keep Pacer's freshness decision separate from the age of its provider reading. */
export function pacerSnapshot(
  meter: Pick<Meter, "lastServed" | "rows" | "snapshot">,
  input: UsageInput,
  now: number,
  providers?: readonly string[],
): UsageSnapshot {
  const served = input.sessionID ? meter.lastServed(input.sessionID) : undefined
  const rows = meter.rows()
  const current = rows.find(
    (row) => row.id === served?.auth && (providers === undefined || providers.includes(row.provider)),
  )
  const activity = input.sessionID ? meter.snapshot().activity?.[input.sessionID]?.auth : undefined
  return {
    protocol: 1,
    view: "usage",
    now: now / 1000,
    max_age_seconds: 90,
    all: input.all || (providers === undefined && !served),
    provider: providers?.[0] ?? current?.provider ?? "",
    ...(providers === undefined ? {} : { providers }),
    model: input.modelID,
    current: current?.id ?? "",
    active:
      activity &&
      rows.some((row) => row.id === activity && (providers === undefined || providers.includes(row.provider)))
        ? [activity]
        : [],
    last_used: (served?.at_ms ?? 0) / 1000,
    credentials: rows
      .filter(
        (c) =>
          input.all || (providers === undefined ? !served || c.id === served.auth : providers.includes(c.provider)),
      )
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
