// The monitor as tools: read what tools cost, by whom, and compare windows.
// Reads only, plus a named mark (a timestamp to compare before and after).
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { runRegistration } from "../instructions/apply.js"
import {
  MonitorGroupBy,
  MonitorScope,
  MonitorView,
  MonitorRequestPageInput,
  MonitorPagesInput,
  type MonitorQueryInput,
} from "../rpc.js"
import { monitorMark, monitorQuery } from "./plugin.js"

const namespace = "monitor"
const origin = { type: "plugin", name: "opencode.plus" } as const
const options = { namespace, codemode: true, permission: "monitor" } as const

export const QueryDescription =
  "For a combined session or tree report, pass sessionIDs:[...]; it overrides sessionID, and an empty list selects nothing. " +
  "Request arrays are bounded (default 100, maximum 500), chronological within each page. requestPage:{limit,cursor,direction:'older'|'newer'} uses requestPage.older/newer cursors; omitted cursor returns latest. Other collections use pages:{section:{limit,cursor}} and report.pages[section].next/previous (facets use report.facets.pages). Sessions/context/agents/teams/unstable default to 100 rows; detail.* defaults to 50. Changed content visibly resets stale revision cursors. Counts/coverage stay full-population. Text search is page-local. Presentation text is previewed at 512 characters with truncation metadata; fullText:true requests unabridged selected-page text. Request tool-name previews have toolsTotal/toolsComplete; all attributed calls remain reachable through detail.calls pages. " +
  "One call returns the calling session's cache misses with cause, confidence and one-line evidence, plus token/cost totals and tool groups. query({view:'cache', id}) returns full evidence: named segment diff, timings, ping history, account switches, expected versus actual tokens, session/message ids and attributed calls. Verdicts: hit, partial miss, miss, cold start, no cache reported, failed request.\n" +
  "Tokens per call are attributed: call = share of the step's output spent writing the call, result = tokens the result added to the next prompt (measured from the next step; estimated when it cannot be), carried = result × later steps until compaction.\n" +
  "scope: session (only this chat; default), tree (topmost delegation root and all descendants), team (requires team name), project or all. since:'compaction' starts at each session's latest compaction. view: overview, cache, tools, sessions or steps; existing groupings stay available. window: 15m, 1h, 24h, 7d … or since/until epoch ms. compare: {window} reads the previous period, or use explicit {since, until}. monitor.mark records a named comparison timestamp."

export const MarkDescription = "Record a named mark (now), to compare the monitor before and after a change."

const Duration = Schema.String.annotate({ description: "A duration back from now: 30m, 2h, 7d." })

const QueryInput = Schema.Struct({
  scope: Schema.optionalKey(MonitorScope),
  sessionID: Schema.optionalKey(Schema.String),
  sessionIDs: Schema.optionalKey(Schema.Array(Schema.String)),
  team: Schema.optionalKey(Schema.String),
  view: Schema.optionalKey(MonitorView),
  id: Schema.optionalKey(Schema.String),
  missesOnly: Schema.optionalKey(Schema.Boolean),
  requestPage: Schema.optionalKey(MonitorRequestPageInput),
  pages: Schema.optionalKey(MonitorPagesInput),
  fullText: Schema.optionalKey(Schema.Boolean),
  titles: Schema.optionalKey(Schema.Boolean),
  window: Schema.optionalKey(Duration),
  since: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Literal("compaction")])),
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
          const since = yield* windowStart(input.window, typeof input.since === "number" ? input.since : undefined, now)
          const compare =
            input.compare === undefined ? undefined : yield* previousWindow(input.compare, input.window, since, now)
          const scope = input.scope ?? "session"
          const query: MonitorQueryInput = {
            scope,
            ...(scope === "session" || scope === "tree"
              ? input.sessionIDs !== undefined
                ? { sessionIDs: input.sessionIDs }
                : { sessionID: input.sessionID ?? String(context.sessionID) }
              : {}),
            ...(input.team === undefined ? {} : { team: input.team }),
            ...(input.view === undefined ? {} : { view: input.view }),
            ...(input.id === undefined ? {} : { id: input.id }),
            ...(input.missesOnly === undefined ? {} : { missesOnly: input.missesOnly }),
            ...(input.requestPage === undefined ? {} : { requestPage: input.requestPage }),
            ...(input.pages === undefined ? {} : { pages: input.pages }),
            ...(input.fullText === undefined ? {} : { fullText: input.fullText }),
            ...(input.titles === undefined ? {} : { titles: input.titles }),
            ...(input.since === "compaction" ? { sinceCompaction: true } : {}),
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
          return { output: yield* Effect.promise(() => monitorQuery(ctx, query)) }
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
