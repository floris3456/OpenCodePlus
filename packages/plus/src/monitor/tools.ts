// The monitor as tools: read what tools cost, by whom, and compare windows.
// Reads only, plus a named mark (a timestamp to compare before and after).
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { runRegistration } from "../instructions/apply.js"
import { MonitorGroupBy, MonitorScope, type MonitorQueryInput } from "../rpc.js"
import { monitorMark, monitorQuery } from "./plugin.js"

const namespace = "monitor"
const origin = { type: "plugin", name: "opencode.plus" } as const
const options = { namespace, codemode: true, permission: "monitor" } as const

export const QueryDescription =
  "What tools cost, by agent, tool, model, session or config: totals, top groups and the latest calls.\n" +
  "Tokens per call are attributed: call = share of the step's output spent writing the call, result = tokens the result added to the next prompt (measured from the next step; estimated when it cannot be), carried = result × later steps until compaction.\n" +
  "scope: session (this chat and everything it delegated; default), project or all. window: 15m, 1h, 24h, 7d … or since/until epoch ms. compare: a second window read with the same filters — {window} is that long ending where the main window starts (the previous period), or explicit {since, until}."

export const MarkDescription = "Record a named mark (now), to compare the monitor before and after a change."

const Duration = Schema.String.annotate({ description: "A duration back from now: 30m, 2h, 7d." })

const QueryInput = Schema.Struct({
  scope: Schema.optionalKey(MonitorScope),
  sessionID: Schema.optionalKey(Schema.String),
  window: Schema.optionalKey(Duration),
  since: Schema.optionalKey(Schema.Number),
  until: Schema.optionalKey(Schema.Number),
  agents: Schema.optionalKey(Schema.Array(Schema.String)),
  tools: Schema.optionalKey(Schema.Array(Schema.String)),
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  errors: Schema.optionalKey(Schema.Boolean),
  group: Schema.optionalKey(MonitorGroupBy),
  sort: Schema.optionalKey(Schema.Literals(["tokens", "calls", "carried", "errors", "time"])),
  top: Schema.optionalKey(Schema.Number),
  feed: Schema.optionalKey(Schema.Number),
  compare: Schema.optionalKey(
    Schema.Struct({
      window: Schema.optionalKey(Duration),
      since: Schema.optionalKey(Schema.Number),
      until: Schema.optionalKey(Schema.Number),
    }),
  ),
})

const MarkInput = Schema.Struct({ label: Schema.String })

export async function registerMonitorTools(ctx: Context): Promise<Registration> {
  return runRegistration(ctx.tool.transform, (editor) => {
    editor.namespace({
      name: namespace,
      description: "Tool and token monitor: who used which tools and what they cost.",
    })
    editor.add({
      name: "query",
      description: QueryDescription,
      input: QueryInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input, context) =>
        Effect.gen(function* () {
          const now = Date.now()
          const since = yield* windowStart(input.window, input.since, now)
          const compare =
            input.compare === undefined ? undefined : yield* previousWindow(input.compare, input.window, since, now)
          const scope = input.scope ?? "session"
          const query: MonitorQueryInput = {
            scope,
            ...(scope === "session" ? { sessionID: input.sessionID ?? String(context.sessionID) } : {}),
            ...(since === undefined ? {} : { since }),
            ...(input.until === undefined ? {} : { until: input.until }),
            ...(input.agents === undefined ? {} : { agents: input.agents }),
            ...(input.tools === undefined ? {} : { tools: input.tools }),
            ...(input.models === undefined ? {} : { models: input.models }),
            ...(input.errors === undefined ? {} : { errors: input.errors }),
            ...(input.group === undefined ? {} : { group: input.group }),
            ...(input.sort === undefined ? {} : { sort: input.sort }),
            ...(input.top === undefined ? {} : { top: input.top }),
            feed: input.feed ?? 10,
            ...(compare === undefined ? {} : { compare }),
          }
          return { output: monitorQuery(ctx, query) }
        }),
    })
    editor.add({
      name: "mark",
      description: MarkDescription,
      input: MarkInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input) => Effect.sync(() => ({ output: monitorMark(input.label) })),
    })
  })
}

const UNITS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** "30m", "2h", "1h30m", "7d" → milliseconds, or undefined when malformed. */
export function parseDuration(text: string): number | undefined {
  const parts = [
    ...text
      .trim()
      .toLowerCase()
      .matchAll(/(\d+(?:\.\d+)?)\s*([smhdw])/g),
  ]
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text.trim().toLowerCase().replace(/\s+/g, ""))
    return undefined
  return parts.reduce((sum, part) => sum + Number(part[1]) * (UNITS[part[2] ?? ""] ?? 0), 0)
}

// The comparison window: explicit bounds win; otherwise a window of the given
// (or the main) length that ends where the main window starts.
function previousWindow(
  compare: { readonly window?: string; readonly since?: number; readonly until?: number },
  mainWindow: string | undefined,
  mainSince: number | undefined,
  now: number,
): Effect.Effect<{ since?: number; until?: number }, Tool.Error> {
  const text = compare.window ?? mainWindow
  const until = compare.until ?? mainSince ?? now
  if (compare.since !== undefined) return Effect.succeed({ since: compare.since, until })
  if (text === undefined)
    return Effect.fail(new Tool.Error({ message: "compare needs a window (e.g. 24h) or since/until" }))
  const span = parseDuration(text)
  if (span === undefined)
    return Effect.fail(new Tool.Error({ message: `window "${text}" is not a duration such as 30m, 2h or 7d` }))
  return Effect.succeed({ since: until - span, until })
}

function windowStart(
  window: string | undefined,
  since: number | undefined,
  now: number,
): Effect.Effect<number | undefined, Tool.Error> {
  if (window === undefined) return Effect.succeed(since)
  const span = parseDuration(window)
  if (span === undefined)
    return Effect.fail(new Tool.Error({ message: `window "${window}" is not a duration such as 30m, 2h or 7d` }))
  return Effect.succeed(now - span)
}
