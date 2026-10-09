// The monitor's read model: totals, groups, a live feed and an optional
// comparison window over the ledger, for the TUI, the RPC and the tool alike.
//
// Filters narrow calls by scope, time, agent, tool, model and status. Step
// totals follow scope, time, agent and model (a tool filter does not apply
// to steps: a step is not one tool's). "Carried" is derived here: a call's
// result tokens times the steps its session ran after it until the next
// compaction.
//
// Wide windows read whole hours from the `call_hour` rollup and only the
// partial hours at the window's edges from `call`; the answer is the same
// either way (the rollup is keyed down to session and compaction epoch).
// Grouping by target and "failed only" need per-call columns and always read
// `call`.
import type { Database } from "bun:sqlite"
import type {
  MonitorCall,
  MonitorGroup,
  MonitorGroupBy,
  MonitorQueryInput,
  MonitorReport,
  MonitorTotals,
} from "../rpc.js"
import { HOUR, type Ledger } from "./ledger.js"
import { requestReport } from "./report.js"
import { QueryCache, type QueryBoundary } from "./query-cache.js"

const DEFAULT_TOP = 20
const DEFAULT_FEED = 12
const MAX_ROWS = 500

const compactionSince = (alias: string) =>
  `(select coalesce(max(at), 0) from context_fact where session_id = ${alias}.session_id and kind = 'compaction' and at < $until)`

export interface QueryContext {
  /** The Location's directory, for project scope. */
  readonly directory?: string
  readonly now?: number
  /**
   * Real per-session state from the host: "running" from the live active set,
   * otherwise the last execution's outcome (succeeded/failed/interrupted). A
   * session absent from the map has no recorded execution state.
   */
  readonly states?: ReadonlyMap<string, string>
  /** Real per-session agent from the host, overriding the ledger's last write. */
  readonly agents?: ReadonlyMap<string, string>
}

type Bindings = Record<string, string | number | null>

interface Window {
  readonly since: number
  readonly until: number
}

const queryCaches = new WeakMap<Ledger, QueryCache>()

export function queryCacheStats(ledger: Ledger) {
  return queryCaches.get(ledger)?.stats() ?? { entries: 0, bytes: 0, hits: 0, misses: 0 }
}

export function queryMonitor(ledger: Ledger, input: MonitorQueryInput, context: QueryContext = {}): MonitorReport {
  const db = ledger.db
  const now = context.now ?? Date.now()
  const window = { since: input.since ?? 0, until: input.until ?? now + 1 }
  const comparison =
    input.compare === undefined ? undefined : { since: input.compare.since ?? 0, until: input.compare.until ?? now + 1 }
  const cache = queryCaches.get(ledger) ?? new QueryCache()
  queryCaches.set(ledger, cache)
  const key = JSON.stringify([
    input,
    context.directory,
    context.states ? [...context.states].toSorted(([a], [b]) => a.localeCompare(b)) : null,
    context.agents ? [...context.agents].toSorted(([a], [b]) => a.localeCompare(b)) : null,
  ])
  const revision = ledger.revision()
  const cached = cache.get(key, revision, [window.until, ...(comparison ? [comparison.until] : [])])
  if (cached) return { ...cached, now }
  const group = input.group ?? "tool"
  const top = clamp(input.top ?? DEFAULT_TOP)
  const requests = requestReport(ledger, input, context, window)
  const bounds: QueryBoundary[] = []
  // One grouped pass answers both: the totals sum every group, the table keeps the top ones.
  const read = (target: Window) => {
    const groups = groupsOf(db, input, context, target, group)
    const totals = totalsOf(db, input, context, target, groups)
    const analyzed: typeof requests = target === window ? requests : requestReport(ledger, input, context, target)
    const analysis = analyzed.totals
    bounds.push({
      until: target.until,
      // Facets intentionally include the whole edge hour, so their population
      // can change at an hour boundary before the next request/call timestamp.
      nextExpiry: Math.min(analyzed.nextExpiry, (Math.floor(target.until / HOUR) + 1) * HOUR),
      // Global timestamps are conservative for scoped queries. No payload or
      // history is loaded; indexes locate the next existing cutoff boundary.
      nextData:
        db
          .query<{ at: number | null }, [number, number, number, number]>(
            `select min(at) as at from (
        select min(started) as at from request where started >= ?
        union all select min(started) from call where started >= ?
        union all select min(started) from step where started >= ?
        union all select min(at) from context_fact where at >= ?
      )`,
          )
          .get(target.until, target.until, target.until, target.until)?.at ?? Infinity,
    })
    // Unknown pricing is omitted everywhere, never merged to a free zero: the
    // baseline zero is dropped unless the request analysis supplies a cost.
    const { missCost: _baseline, hitRate: _legacyRate, ...baseline } = totals
    const { missCost, ...analysisRest } = analysis
    const merged: MonitorTotals = {
      ...baseline,
      ...analysisRest,
      steps: totals.steps,
      ...(missCost === undefined ? {} : { missCost }),
    }
    return { totals: merged, groups: groups.slice(0, top).map((entry) => entry.group) }
  }
  const report: MonitorReport = {
    now,
    ...read(window),
    ...requests.sections,
    ...(input.view === "overview"
      ? {
          // The Overview tab's top tools must not depend on whichever grouping
          // the Tools tab last selected, so compute them tool-grouped here.
          topTools: groupsOf(db, input, context, window, "tool")
            .map((entry) => entry.group)
            .sort((a, b) => b.carried - a.carried || b.resultTokens - a.resultTokens)
            .slice(0, 3),
        }
      : {}),
    feed: feedOf(db, input, context, window, clamp(input.feed ?? DEFAULT_FEED)),
    ...(comparison === undefined ? {} : { compare: read(comparison) }),
    facets: facetsOf(db, input, context, window),
    marks: db
      .query<{ id: number; at: number; label: string }, []>("select id, at, label from mark order by at desc limit 50")
      .all()
      .map((row) => ({ id: row.id, at: row.at, label: row.label })),
  }
  cache.set(key, revision, bounds, report)
  return report
}

function clamp(value: number): number {
  return Math.max(0, Math.min(MAX_ROWS, Math.floor(value)))
}

// The sessions in scope, as a CTE named `scope` (absent for scope "all").
export function scopeOf(input: MonitorQueryInput, context: QueryContext): { cte: string; bindings: Bindings } {
  if (input.scope === "session" && input.sessionID !== undefined)
    return {
      cte: "with scope(id) as (select $root)",
      bindings: { $root: input.sessionID },
    }
  if (input.scope === "tree" && input.sessionID !== undefined)
    return {
      cte: `with recursive ancestors(id, parent_id) as (
        select id, parent_id from session where id = $root
        union select s.id, s.parent_id from session s join ancestors a on s.id = a.parent_id
      ), scope(id) as (
        select coalesce(parent_id, id) from ancestors where parent_id is null or parent_id not in (select id from session)
        union select s.id from session s join scope on s.parent_id = scope.id
      )`,
      bindings: { $root: input.sessionID },
    }
  if (input.scope === "team" && input.team !== undefined)
    return { cte: "with scope(id) as (select id from session where team = $team)", bindings: { $team: input.team } }
  if (input.scope === "project" && context.directory !== undefined)
    return {
      cte: "with recursive scope(id) as (select id from session where directory = $directory union select s.id from session s join scope on s.parent_id = scope.id)",
      bindings: { $directory: context.directory },
    }
  // Any incomplete scoped query reads nothing rather than everything.
  if (input.scope !== "all") return { cte: "with scope(id) as (select null where 0)", bindings: {} }
  return { cte: "", bindings: {} }
}

function inList(
  column: string,
  name: string,
  values: readonly string[] | undefined,
): { sql: string; bindings: Bindings } {
  if (values === undefined || values.length === 0) return { sql: "", bindings: {} }
  const names = values.map((_, index) => `$${name}${index}`)
  return {
    sql: ` and ${column} in (${names.join(", ")})`,
    bindings: Object.fromEntries(values.map((value, index) => [`$${name}${index}`, value])),
  }
}

interface Source {
  /** A CTE prefix (the scope) for the statement that selects from `rows`. */
  readonly cte: string
  /** A subquery with one uniform row shape, whichever table it reads. */
  readonly rows: string
  readonly bindings: Bindings
}

// Every call in scope and window that passes the filters, as uniform rows:
// raw calls for partial hours (or everything, when a query needs per-call
// columns), rollup rows for whole hours in between.
function callRows(
  input: MonitorQueryInput,
  context: QueryContext,
  window: Window,
  options: { raw?: boolean } = {},
): Source {
  const scope = scopeOf(input, context)
  const errors = input.errors === true
  const filters = (alias: string) => {
    const agents = inList(`${alias}.agent`, "agent", input.agents)
    const tools = inList(`${alias}.tool`, "tool", input.tools)
    const models = inList(`${alias}.model`, "model", input.models)
    return {
      sql: `${scope.cte === "" ? "" : ` and ${alias}.session_id in (select id from scope)`}${agents.sql}${tools.sql}${models.sql}${input.sinceCompaction ? ` and ${alias}.started >= ${compactionSince(alias)}` : ""}`,
      bindings: { ...agents.bindings, ...tools.bindings, ...models.bindings },
    }
  }
  const raw = filters("c")
  // As for the feed: walk time for a wide scope, the session index for one chat.
  const index = input.scope === "session" ? "" : "indexed by call_started"
  const rawRows = (
    where: string,
  ) => `select c.session_id, c.epoch, coalesce(c.agent, '') as agent, coalesce(c.model, '') as model,
      coalesce(c.config, '') as config, c.tool, c.target,
      (c.parent_call is null) as calls, (c.parent_call is not null) as inner, (c.status = 'error') as errors,
      (c.status = 'error' and c.parent_call is null) as top_errors, (c.status = 'running') as running,
      c.call_tokens, c.result_tokens, c.result_tokens * max(0, coalesce(e.last_idx, c.idx) - c.idx) as carried,
      (c.parent_call is null and c.measured = 0 and c.status != 'running') as estimated,
      case when c.ended is not null and c.parent_call is null then c.ended - c.started else 0 end as duration,
      (c.ended is not null and c.parent_call is null) as timed
    from call c ${index} left join epoch e on e.session_id = c.session_id and e.epoch = c.epoch
    where ${where}${raw.sql}${errors ? " and c.status = 'error'" : ""}`
  const firstHour = Math.ceil(window.since / HOUR)
  const lastHour = Math.floor(window.until / HOUR)
  const rollup = options.raw !== true && !errors && !input.sinceCompaction && firstHour < lastHour
  if (!rollup)
    return {
      cte: scope.cte,
      rows: rawRows("c.started >= $since and c.started < $until"),
      bindings: { ...scope.bindings, ...raw.bindings, $since: window.since, $until: window.until },
    }
  const hourly = filters("h")
  return {
    cte: scope.cte,
    rows: `${rawRows("c.started >= $since and c.started < $edgeStart")}
      union all
      ${rawRows("c.started >= $edgeEnd and c.started < $until")}
      union all
      select h.session_id, h.epoch, h.agent, h.model, h.config, h.tool, null as target, h.calls, h.inner, h.errors, h.top_errors,
        h.running, h.call_tokens, h.result_tokens,
        case when e.last_idx is null then 0 else e.last_idx * h.result_tokens - h.result_idx end as carried,
        h.estimated, h.duration, h.timed
      from call_hour h left join epoch e on e.session_id = h.session_id and e.epoch = h.epoch
      where h.hour >= $firstHour and h.hour < $lastHour${hourly.sql}`,
    bindings: {
      ...scope.bindings,
      ...raw.bindings,
      ...hourly.bindings,
      $since: window.since,
      $until: window.until,
      $edgeStart: firstHour * HOUR,
      $edgeEnd: lastHour * HOUR,
      $firstHour: firstHour,
      $lastHour: lastHour,
    },
  }
}

function totalsOf(
  db: Database,
  input: MonitorQueryInput,
  context: QueryContext,
  window: Window,
  groups: readonly Grouped[],
): MonitorTotals {
  const sum = (pick: (entry: Grouped) => number) => groups.reduce((total, entry) => total + pick(entry), 0)
  const scope = scopeOf(input, context)
  const agents = inList("s.agent", "agent", input.agents)
  const models = inList("(s.provider || '/' || s.model)", "model", input.models)
  const stepRow = db
    .query<Record<string, number | null>, [Bindings]>(
      `${scope.cte} select
        count(*) as steps,
        sum(s.input) as input,
        sum(s.output) as output,
        sum(s.reasoning) as reasoning,
        sum(s.cache_read) as cacheRead,
        sum(s.cache_write) as cacheWrite,
        sum(s.cost) as cost
      from step s
      where s.started >= $since and s.started < $until
        ${input.sinceCompaction ? `and s.started >= ${compactionSince("s")}` : ""}
        ${scope.cte === "" ? "" : "and s.session_id in (select id from scope)"}${agents.sql}${models.sql}`,
    )
    .get({ ...scope.bindings, ...agents.bindings, ...models.bindings, $since: window.since, $until: window.until })
  const number = (row: Record<string, number | null> | null, key: string) => row?.[key] ?? 0
  return {
    steps: number(stepRow, "steps"),
    calls: sum((entry) => entry.group.calls),
    errors: sum((entry) => entry.topErrors),
    running: sum((entry) => entry.group.running),
    input: number(stepRow, "input"),
    output: number(stepRow, "output"),
    reasoning: number(stepRow, "reasoning"),
    cacheRead: number(stepRow, "cacheRead"),
    cacheWrite: number(stepRow, "cacheWrite"),
    cost: number(stepRow, "cost"),
    // Code Mode's inner calls carry no tokens of their own (their execute call does).
    callTokens: sum((entry) => entry.group.callTokens),
    resultTokens: sum((entry) => entry.group.resultTokens),
    carried: sum((entry) => entry.group.carried),
    requests: number(stepRow, "steps"),
    pings: 0,
    pingCost: 0,
    misses: 0,
    missTokens: 0,
    missCost: 0,
    hitRate:
      number(stepRow, "input") + number(stepRow, "cacheRead") > 0
        ? number(stepRow, "cacheRead") / (number(stepRow, "input") + number(stepRow, "cacheRead"))
        : 0,
  }
}

const unknown = (column: string) => `case when ${column} = '' then '?' else ${column} end`

const groupKey: Record<MonitorGroupBy, { key: string; label: string; join: string }> = {
  tool: { key: "u.tool", label: "u.tool", join: "" },
  agent: { key: unknown("u.agent"), label: unknown("u.agent"), join: "" },
  model: { key: unknown("u.model"), label: unknown("u.model"), join: "" },
  config: { key: unknown("u.config"), label: unknown("u.config"), join: "" },
  session: {
    key: "u.session_id",
    label: "coalesce(ss.title, ss.agent, u.session_id)",
    join: "left join session ss on ss.id = u.session_id",
  },
  target: {
    key: "u.tool || ' ' || coalesce(u.target, '')",
    label: "u.tool || ' ' || coalesce(u.target, '')",
    join: "",
  },
}

const groupOrder: Record<NonNullable<MonitorQueryInput["sort"]>, string> = {
  tokens: "callTokens + resultTokens desc",
  calls: "calls desc",
  carried: "carried desc",
  errors: "errors desc",
  time: "avgMs desc",
}

interface Grouped {
  readonly group: MonitorGroup
  /** Failed calls made directly by the model (Code Mode's inner failures excluded). */
  readonly topErrors: number
}

// Every group, ordered; the caller keeps the top ones for the table.
function groupsOf(
  db: Database,
  input: MonitorQueryInput,
  context: QueryContext,
  window: Window,
  group: MonitorGroupBy,
): Grouped[] {
  const source = callRows(input, context, window, { raw: group === "target" })
  const spec = groupKey[group]
  const rows = db
    .query<Record<string, string | number | null>, [Bindings]>(
      `${source.cte} select
        ${spec.key} as key,
        max(${spec.label}) as label,
        sum(u.calls) as calls,
        sum(u.inner) as inner,
        sum(u.errors) as errors,
        sum(u.top_errors) as topErrors,
        sum(u.running) as running,
        sum(u.call_tokens) as callTokens,
        sum(u.result_tokens) as resultTokens,
        sum(u.carried) as carried,
        sum(u.estimated) as estimated,
        1.0 * sum(u.duration) / max(1, sum(u.timed)) as avgMs
      from (${source.rows}) u ${spec.join}
      group by 1
      having sum(u.calls) + sum(u.inner) > 0
      order by ${groupOrder[input.sort ?? "tokens"]}, calls desc, key`,
    )
    .all(source.bindings)
  return rows.map((row) => ({
    topErrors: Number(row.topErrors ?? 0),
    group: {
      key: String(row.key ?? ""),
      label: String(row.label ?? row.key ?? ""),
      calls: Number(row.calls ?? 0),
      inner: Number(row.inner ?? 0),
      errors: Number(row.errors ?? 0),
      running: Number(row.running ?? 0),
      callTokens: Number(row.callTokens ?? 0),
      resultTokens: Number(row.resultTokens ?? 0),
      carried: Number(row.carried ?? 0),
      estimated: Number(row.estimated ?? 0),
      avgMs: Math.round(Number(row.avgMs ?? 0)),
    },
  }))
}

function feedOf(
  db: Database,
  input: MonitorQueryInput,
  context: QueryContext,
  window: Window,
  limit: number,
): MonitorCall[] {
  if (limit === 0) return []
  const scope = scopeOf(input, context)
  const agents = inList("c.agent", "agent", input.agents)
  const tools = inList("c.tool", "tool", input.tools)
  const models = inList("c.model", "model", input.models)
  // The newest calls of a wide scope are found fastest walking time backwards;
  // one chat's calls through its session index (the planner picks the latter
  // for both, which scans every call of a project).
  const index = input.scope === "session" ? "" : "indexed by call_started"
  const rows = db
    .query<Record<string, string | number | null>, [Bindings]>(
      `${scope.cte} select c.session_id, c.call_id, c.agent, c.model, c.tool, c.target, c.status, c.error, c.started, c.ended,
        c.call_tokens, c.result_tokens, c.measured, c.result_tokens * max(0, coalesce(e.last_idx, c.idx) - c.idx) as carried
      from call c ${index} left join epoch e on e.session_id = c.session_id and e.epoch = c.epoch
      where c.parent_call is null and c.started >= $since and c.started < $until
        ${input.sinceCompaction ? `and c.started >= ${compactionSince("c")}` : ""}
        ${scope.cte === "" ? "" : "and c.session_id in (select id from scope)"}${agents.sql}${tools.sql}${models.sql}
        ${input.errors === true ? "and c.status = 'error'" : ""}
      order by c.started desc, c.call_id desc
      limit $limit`,
    )
    .all({
      ...scope.bindings,
      ...agents.bindings,
      ...tools.bindings,
      ...models.bindings,
      $since: window.since,
      $until: window.until,
      $limit: limit,
    })
  return rows.map((row) => ({
    sessionID: String(row.session_id),
    callID: String(row.call_id),
    ...optional("agent", row.agent),
    ...optional("model", row.model),
    tool: String(row.tool),
    ...optional("target", row.target),
    status: String(row.status),
    ...optional("error", row.error),
    started: Number(row.started),
    ...(row.ended === null ? {} : { ended: Number(row.ended) }),
    callTokens: Number(row.call_tokens ?? 0),
    resultTokens: Number(row.result_tokens ?? 0),
    measured: row.measured === 1,
    carried: Number(row.carried ?? 0),
  }))
}

function optional<K extends string>(key: K, value: string | number | null | undefined): { [P in K]?: string } {
  return value === null || value === undefined ? {} : ({ [key]: String(value) } as { [P in K]?: string })
}

// What the filters can choose from in this scope and window (unfiltered), from
// the rollup's hours around the window: a value seen only in an edge hour just
// outside it is offered too, which filters to nothing and costs nothing.
function facetsOf(
  db: Database,
  input: MonitorQueryInput,
  context: QueryContext,
  window: Window,
): MonitorReport["facets"] {
  const scope = scopeOf(input, context)
  const rows = db
    .query<{ agent: string; tool: string; model: string }, [Bindings]>(
      `${scope.cte} select distinct h.agent, h.tool, h.model from call_hour h
      where h.hour >= $firstHour and h.hour <= $lastHour ${scope.cte === "" ? "" : "and h.session_id in (select id from scope)"}`,
    )
    .all({ ...scope.bindings, $firstHour: Math.floor(window.since / HOUR), $lastHour: Math.floor(window.until / HOUR) })
  const values = (pick: (row: { agent: string; tool: string; model: string }) => string) =>
    [...new Set(rows.map(pick).filter((value) => value !== ""))].sort().slice(0, 200)
  return { agents: values((row) => row.agent), tools: values((row) => row.tool), models: values((row) => row.model) }
}
