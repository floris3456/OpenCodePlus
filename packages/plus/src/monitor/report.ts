import type { MonitorQueryInput, MonitorReport, MonitorRequest, MonitorRequestDetail, MonitorTotals } from "../rpc.js"
import {
  foldSession,
  isMiss,
  promptTokens,
  sessionFingerprints,
  windowPings,
  type SessionAnalysis,
  type SessionFold,
} from "./cache.js"
import type { ContextFactRow, Ledger, RequestRow } from "./ledger.js"
import { scopeOf, type QueryContext } from "./query.js"
import { reuseRate, measurement } from "./measurement.js"
import { AnalysisCache } from "./analysis-cache.js"
import { reportPage, reportPageBounds } from "./report-page.js"
import { backfillCacheBatch, FOLD_FIELDS, requestAnalysis, savedRequestFilter } from "./snapshot.js"
import { savedUnread, settleUnreadWrites } from "./unread-saved.js"
import { savedUnstable, settleRequestChanges } from "./unstable-saved.js"
export { ANALYSIS_CACHE_LIMIT } from "./analysis-cache.js"

interface SessionRow {
  id: string
  parent_id: string | null
  title: string | null
  agent: string | null
  run_id: string | null
  role: string | null
  team: string | null
  last_seen: number
}

interface LegacyStep {
  session_id: string
  started: number
  agent: string | null
  provider: string | null
  model: string | null
  input: number
  output: number
  reasoning: number
  cache_read: number
  cache_write: number
  cost: number
}

interface SessionData {
  readonly rows: readonly RequestRow[]
  readonly facts: readonly ContextFactRow[]
  readonly analysis: SessionAnalysis
  readonly fold: SessionFold
}

const sessionCache = new WeakMap<Ledger, AnalysisCache>()

// One session's rows, facts and analysis. The analysis folds in-place writes
// (request completion, a corrected final wire fingerprint, a kind relabel), so
// it is keyed on change marks, never on row ids. An unchanged ledger revision
// (which also covers other connections and processes) answers at once; an
// unchanged session mark answers with one lookup however busy other chats are.
// Otherwise only changed request/fact payloads and fingerprints are read,
// loaded, and the fold resumes at the first request a change can affect. The
// analysis never depends on the query window, so it stays reusable across
// window changes and polling.
function sessionData(ledger: Ledger, id: string): SessionData {
  const cache = sessionCache.get(ledger) ?? new AnalysisCache()
  sessionCache.set(ledger, cache)
  const cached = cache.get(id)
  const revision = ledger.revision()
  if (cached && cached.revision === revision) return dataOf(cached.fold)
  // The mark is read before the rows: a write in between shows as a change next time.
  const mark = ledger.sessionRevision(id)
  if (cached && cached.mark === mark) {
    cached.revision = revision
    return dataOf(cached.fold)
  }
  const changed = cached ? ledger.changedFingerprints(id, cached.mark) : []
  const requestDelta = cached ? ledger.changedRequests(id, cached.mark) : undefined
  const factDelta = cached ? ledger.changedContextFacts(id, cached.mark) : undefined
  // Arrays still copy/sort in memory; the SQLite payload read is delta-only.
  const rows = cached && requestDelta !== undefined
    ? mergeChanged(cached.fold.rows, requestDelta, (a, b) => a.started - b.started || (a.ledgerOrder ?? 0) - (b.ledgerOrder ?? 0))
    : ledger.getRequests(id)
  const facts = cached && factDelta !== undefined
    ? mergeChanged(cached.fold.facts, factDelta, (a, b) => a.at - b.at
      || Buffer.compare(Buffer.from(a.kind), Buffer.from(b.kind))
      || Buffer.compare(Buffer.from(a.ledgerDetail ?? "{}"), Buffer.from(b.ledgerDetail ?? "{}")))
    : ledger.getContextFacts(id)
  const updated = cached && !cached.perRequest ? updatedFingerprints(ledger, id, rows, cached.fold, changed) : undefined
  if (cached && !cached.perRequest && updated && updated.size > 0) {
    const from = firstChange(cached.fold, rows, facts, changed)
    const fold = foldSession(rows, facts, updated, { previous: cached.fold, from })
    cache.set(id, { revision, mark, perRequest: false, fold, lastFrom: from })
    return dataOf(fold)
  }
  if (cached && cached.perRequest) {
    const fingerprints = new Map(rows.map((row) => [row.id, cached.fold.analysis.fingerprints.get(row.id)]))
    for (const requestID of changed) {
      if (!fingerprints.has(requestID)) continue
      const fp = ledger.getFingerprint(requestID)
      fingerprints.set(requestID, fp?.sessionID === id ? fp : undefined)
    }
    for (const r of rows.filter((row) => !cached.fold.analysis.fingerprints.has(row.id))) {
      const fp = ledger.getFingerprint(r.id)
      fingerprints.set(r.id, fp?.sessionID === id ? fp : undefined)
    }
    const from = firstChange(cached.fold, rows, facts, changed)
    const fold = foldSession(rows, facts, fingerprints, { previous: cached.fold, from })
    cache.set(id, { revision, mark, perRequest: true, fold, lastFrom: from })
    return dataOf(fold)
  }
  const loaded = sessionFingerprints(ledger, rows)
  const fold = foldSession(rows, facts, loaded.fingerprints)
  cache.set(id, { revision, mark, perRequest: loaded.perRequest, fold, lastFrom: 0 })
  return dataOf(fold)
}

export function sessionFold(ledger: Ledger, id: string): SessionFold {
  return sessionData(ledger, id).fold
}

export function sessionFoldResumeFrom(ledger: Ledger, id: string): number | undefined {
  return sessionCache.get(ledger)?.get(id)?.lastFrom
}

export function sessionCacheStats(ledger: Ledger) {
  return sessionCache.get(ledger)?.stats() ?? { sessions: 0, rows: 0, bytes: 0, segments: 0 }
}

function dataOf(fold: SessionFold): SessionData {
  return { rows: fold.rows, facts: fold.facts, analysis: fold.analysis, fold }
}

function mergeChanged<T extends { readonly id: string | number }>(previous: readonly T[], changed: readonly T[], order: (a: T, b: T) => number): readonly T[] {
  if (changed.length === 0) return previous
  const replacements = new Map(changed.map((row) => [row.id, row]))
  return [...previous.filter((row) => !replacements.has(row.id)), ...changed].sort(order)
}

// The cached fingerprints with the changed ones reloaded (or dropped when deleted).
function updatedFingerprints(
  ledger: Ledger,
  id: string,
  rows: readonly RequestRow[],
  fold: SessionFold,
  changed: readonly string[],
) {
  const surviving = new Set(rows.map((row) => row.id))
  const fingerprints = new Map([...fold.analysis.fingerprints].filter(([key]) => surviving.has(key)))
  for (const requestID of changed) {
    const fp = ledger.getFingerprint(requestID)
    if (fp?.sessionID === id && surviving.has(requestID)) fingerprints.set(requestID, fp)
    else fingerprints.delete(requestID)
  }
  return fingerprints
}

// The first request whose verdict a change can affect: a changed or new row,
// a row with a changed fingerprint, or a row starting at or after the earliest
// added or removed context fact (a verdict reads only facts up to its start).
function firstChange(
  fold: SessionFold,
  rows: readonly RequestRow[],
  facts: readonly ContextFactRow[],
  changed: readonly string[],
): number {
  const rowChange = firstDifference(rows, fold.rows, sameRow)
  const factChange = firstDifference(facts, fold.facts, sameFact)
  const factAt =
    factChange < 0
      ? Infinity
      : [...facts.slice(factChange), ...fold.facts.slice(factChange)].reduce(
          (min, fact) => Math.min(min, fact.at),
          Infinity,
        )
  const ids = new Set(changed)
  const affected = rows.findIndex((row) => row.started >= factAt || ids.has(row.id))
  return Math.min(rowChange < 0 ? rows.length : rowChange, affected < 0 ? rows.length : affected)
}

function firstDifference<T>(next: readonly T[], previous: readonly T[], same: (a: T, b: T) => boolean): number {
  for (let i = 0; i < Math.max(next.length, previous.length); i++) {
    if (next[i] === undefined || previous[i] === undefined || !same(next[i]!, previous[i]!)) return i
  }
  return -1
}

// Ledger rows carry every field, undefined ones included.
function sameRow(a: RequestRow, b: RequestRow): boolean {
  const keys = Object.keys(a) as (keyof RequestRow)[]
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) =>
      key === "observation"
        ? JSON.stringify(a.observation) === JSON.stringify(b.observation)
        : Object.is(a[key], b[key]),
    )
  )
}

function sameFact(a: ContextFactRow, b: ContextFactRow): boolean {
  return (
    a.id === b.id &&
    a.at === b.at &&
    a.kind === b.kind &&
    a.sessionID === b.sessionID &&
    JSON.stringify(a.detail) === JSON.stringify(b.detail)
  )
}

export function requestReport(
  ledger: Ledger,
  input: MonitorQueryInput,
  context: QueryContext,
  window: { since: number; until: number },
) {
  const scope = scopeOf(input, context)
  const sessions = ledger.db
    .query<
      SessionRow,
      [typeof scope.bindings]
    >(`${scope.cte} select * from session ${scope.cte ? "where id in (select id from scope)" : ""}`)
    .all(scope.bindings)

  // Saved per-request results answer this report, never a history fold: the
  // fold ran on the service's one thread and took seconds to minutes and
  // gigabytes for a project. Each saved result is the whole fold's analysis of
  // its request (snapshot.ts requestAnalysis); requests still running are
  // analyzed the same way here. What is not saved yet is reported as pending.
  const signals = savedSignals(ledger, input, window, scope.cte ? sessions.map((session) => session.id) : null)
  const filter = savedRequestFilter(input, context, window)
  const running = runningRequests(ledger, input, scope, window)
  const requests = [
    ...ledger.db
      .query<{ summary: string }, typeof filter.bindings>(`${filter.cte} select summary from cache_result where ${filter.where}`)
      .all(filter.bindings)
      .map((row): MonitorRequest => JSON.parse(row.summary)),
    ...running,
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  // Running requests are analyzed already. A saved summary carries the cache
  // screen's wording and its `fold` column the fold's own; a result saved
  // before that column is analyzed again until the backfill saves it anew.
  const foldText = (rows: readonly MonitorRequest[]) => {
    const saved = rows.filter((r) => !running.includes(r)).map((r) => r.id)
    const folds = new Map(
      saved.length === 0
        ? []
        : ledger.db
            .query<{ id: string; fold: string | null }, string[]>(
              `select request_id id, fold from cache_result where request_id in (${saved.map(() => "?").join(", ")})`,
            )
            .all(...saved)
            .map((row) => [row.id, row.fold]),
    )
    const analyzed = requestAnalysis(ledger, saved.filter((id) => !folds.get(id)))
    return rows.map((r) => {
      if (running.includes(r)) return r
      const fold = folds.get(r.id)
      if (!fold) return analyzed.summary(r.id) ?? r
      return {
        ...Object.fromEntries(Object.entries(r).filter(([key]) => !FOLD_FIELDS.includes(key))),
        ...JSON.parse(fold),
      } as MonitorRequest
    })
  }
  // Transport-only children remain inspectable, but are not extra model calls
  // or unknown-usage invocations in aggregate measurement coverage.
  const invocations = requests.filter((r) => r.measurement?.scope !== "exchange")

  const sum = (
    rows: readonly MonitorRequest[],
    key: "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite" | "cost" | "missTokens" | "missCost",
  ) => rows.reduce((n, r) => n + (r[key] ?? 0), 0)

  const totalsFor = (rows: readonly MonitorRequest[]) => {
    let inputTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let costTotal = 0
    let stepsCount = 0
    let missesCount = 0
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      inputTokens += r.input ?? 0
      outputTokens += r.output ?? 0
      reasoningTokens += r.reasoning ?? 0
      cacheReadTokens += r.cacheRead ?? 0
      cacheWriteTokens += r.cacheWrite ?? 0
      costTotal += r.cost ?? 0
      if (r.kind === "step" || r.kind === "compaction") stepsCount++
      if (isMiss(r)) missesCount++
    }
    return {
      requests: rows.length,
      steps: stepsCount,
      input: inputTokens,
      output: outputTokens,
      reasoning: reasoningTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      cost: costTotal,
      misses: missesCount,
    }
  }

  const pingRows = invocations.filter((r) => r.kind === "ping")
  const misses = requests.filter(isMiss)
  const legacy = legacyStepRows(ledger, input, scope, window)
  const legacyTotal = (key: "input" | "output" | "reasoning" | "cache_read" | "cache_write" | "cost") =>
    legacy.reduce((n, s) => n + s[key], 0)
  const priced = invocations.filter((r) => r.pricing?.state === "priced")
  const zeroShortfall = invocations.filter((r) => r.pricing?.state === "zero-shortfall").length
  const unpriced = invocations.filter((r) => r.pricing?.state === "unpriced").length
  const unknownShortfall = invocations.length - priced.length - zeroShortfall - unpriced + legacy.length
  const pricingComplete = unpriced === 0 && unknownShortfall === 0 && invocations.length > 0
  const totals: Partial<MonitorTotals> = {
    ...(invocations.length ? totalsFor(invocations) : { requests: 0, misses: 0 }),
    exchangeRows: requests.length - invocations.length,
    pings: pingRows.length,
    pingCost: sum(pingRows, "cost"),
    missTokens: sum(misses, "missTokens"),
    coldRequests: invocations.filter((r) => r.verdict === "cold").length,
    coldTokens: invocations.filter((r) => r.verdict === "cold").reduce((sum, r) => sum + (r.measurement?.input ?? 0), 0),
    // A priced subset is explanatory, never a complete total or recorded accounting.
    ...(pricingComplete ? { missCost: sum(priced, "missCost") } : {}),
    pricingCoverage: {
      requests: invocations.length + legacy.length,
      priced: priced.length,
      zeroShortfall,
      unpriced,
      unknownShortfall,
      complete: pricingComplete,
      ...(priced.length ? { subsetScenarioCost: sum(priced, "missCost") } : {}),
      scenario: "shortfall-vs-cache-read",
    },
    input: sum(requests, "input") + legacyTotal("input"),
    output: sum(requests, "output") + legacyTotal("output"),
    reasoning: sum(requests, "reasoning") + legacyTotal("reasoning"),
    cacheRead: sum(requests, "cacheRead") + legacyTotal("cache_read"),
    cacheWrite: sum(requests, "cacheWrite") + legacyTotal("cache_write"),
    cost: sum(requests, "cost") + legacyTotal("cost"),
    ...reuseRate(requests, legacy.length),
  }

  const sections: { -readonly [K in keyof MonitorReport]?: MonitorReport[K] } = {
    teams: ledger.db
      .query<{ team: string }, []>("select distinct team from session where team is not null order by team")
      .all()
      .map((r) => r.team),
  }

  const view = input.view ?? "overview"
  if (view === "cache" || view === "steps" || input.view === undefined) {
    const eligible = requests.filter((r) => !input.missesOnly || isMiss(r))
    const limit = Number.isFinite(input.requestPage?.limit)
      ? Math.max(1, Math.min(500, Math.floor(input.requestPage!.limit!)))
      : 100
    const cursor = input.requestPage?.cursor
    const compare = (r: MonitorRequest) =>
      cursor === undefined ? 0 : r.at - cursor.at || r.id.localeCompare(cursor.id)
    const candidates =
      cursor === undefined
        ? eligible
        : eligible.filter((r) => (input.requestPage?.direction === "newer" ? compare(r) > 0 : compare(r) < 0))
    const page =
      input.requestPage?.direction === "newer" && cursor !== undefined
        ? candidates.slice(0, limit)
        : candidates.slice(-limit)
    // The returned rows show the fold's own wording.
    sections.requests = foldText(page).map((r) => ({ ...r }))
    const first = page[0]
    const last = page.at(-1)
    const before =
      first && eligible.some((r) => r.at < first.at || (r.at === first.at && r.id.localeCompare(first.id) < 0))
    const after = last && eligible.some((r) => r.at > last.at || (r.at === last.at && r.id.localeCompare(last.id) > 0))
    sections.requestPage = {
      total: eligible.length,
      returned: page.length,
      limit,
      complete: page.length === eligible.length,
      ...(before ? { older: { at: first.at, id: first.id } } : {}),
      ...(after ? { newer: { at: last.at, id: last.id } } : {}),
      // Keep an empty cursor page navigable after deletions or filter changes.
      ...(!page.length && cursor && eligible.length
        ? input.requestPage?.direction === "newer"
          ? { older: cursor }
          : { newer: cursor }
        : {}),
    }
  }

  const pages: Record<string, NonNullable<MonitorReport["pages"]>[string]> = {}
  if (input.id) {
    const detail = requests.some((r) => r.id === input.id) ? requestAnalysis(ledger, [input.id]).detail(input.id) : undefined
    if (detail) {
      const callCount = ledger.db
        .query<{ total: number; revision: string }, [string, string]>(
          `select count(*) as total, coalesce(group_concat(value), '') as revision from (
          select json_array(c.session_id,c.call_id,c.tool,c.status,c.agent,c.model,c.target,c.error,c.started,c.ended,c.call_tokens,c.result_tokens,c.measured,c.result_tokens * max(0,coalesce(e.last_idx,c.idx)-c.idx)) as value
          from call c left join epoch e on e.session_id=c.session_id and e.epoch=c.epoch
          where c.session_id=? and c.message_id=? order by c.started,c.call_id
        )`,
        )
        .get(detail.request.sessionID, detail.request.messageID ?? "")!
      const callPage = reportPageBounds(
        callCount.total,
        new Bun.CryptoHasher("sha256").update(callCount.revision).digest("hex"),
        input.pages?.["detail.calls"],
        50,
      )
      pages["detail.calls"] = callPage
      const calls = ledger.db
        .query<
          {
            call_id: string
            tool: string
            status: string
            agent: string | null
            model: string | null
            target: string | null
            error: string | null
            started: number
            ended: number | null
            call_tokens: number
            result_tokens: number
            measured: number
            carried: number
          },
          [string, string, number, number]
        >(
          `select c.*, c.result_tokens * max(0, coalesce(e.last_idx, c.idx) - c.idx) as carried
          from call c
          left join epoch e on e.session_id = c.session_id and e.epoch = c.epoch
          where c.session_id = ? and c.message_id = ?
           order by c.started, c.call_id limit ? offset ?`,
        )
        .all(detail.request.sessionID, detail.request.messageID ?? "", callPage.limit, callPage.offset)

      sections.detail = {
        ...detail,
        request: { ...detail.request },
        calls: calls.map((c) => ({
          sessionID: detail.request.sessionID,
          callID: c.call_id,
          tool: c.tool,
          status: c.status,
          ...(c.agent === null ? {} : { agent: c.agent }),
          ...(c.model === null ? {} : { model: c.model }),
          ...(c.target === null ? {} : { target: c.target }),
          ...(c.error === null ? {} : { error: c.error }),
          started: c.started,
          ...(c.ended === null ? {} : { ended: c.ended }),
          callTokens: c.call_tokens,
          resultTokens: c.result_tokens,
          measured: c.measured === 1,
          carried: c.carried,
        })),
      }
    }
  }

  const enrichment = { statements: 0, messages: 0, finishRows: 0, toolRows: 0 }
  if (view === "steps" || view === "cache") {
    // Only enrich returned rows (and the explicit detail), not the population
    // used for totals. Both lookups use Session/message indexes.
    const returned = [...(sections.requests ?? []), ...(sections.detail ? [sections.detail.request] : [])]
    if (returned.length) {
      const keys = [
        ...new Map(
          returned
            .filter((r) => r.messageID)
            .map((r) => [JSON.stringify([r.sessionID, r.messageID]), [r.sessionID, r.messageID]]),
        ).values(),
      ]
      const selectedMessages =
        "with selected(session_id,message_id) as (select json_extract(value,'$[0]'),json_extract(value,'$[1]') from json_each(?))"
      const finishes = ledger.db
        .query<
          { session_id: string; message_id: string; finish: string | null },
          [string]
        >(`${selectedMessages} select s.session_id,s.message_id,s.finish from selected k join step s on s.session_id=k.session_id and s.message_id=k.message_id`)
        .all(JSON.stringify(keys))
      const calls = ledger.db
        .query<
          { session_id: string; message_id: string; tool: string; total: number },
          [string]
        >(`${selectedMessages}, names as (select distinct c.session_id,c.message_id,c.tool from selected k join call c indexed by call_message on c.session_id=k.session_id and c.message_id=k.message_id), ranked as (select *,row_number() over (partition by session_id,message_id order by tool) as ordinal,count(*) over (partition by session_id,message_id) as total from names) select session_id,message_id,tool,total from ranked where ordinal <= 20`)
        .all(JSON.stringify(keys))
      Object.assign(enrichment, {
        statements: 2,
        messages: keys.length,
        finishRows: finishes.length,
        toolRows: calls.length,
      })
      const finishMap = new Map(finishes.map((s) => [JSON.stringify([s.session_id, s.message_id]), s.finish]))
      const toolMap = new Map<string, string[]>()
      const toolTotals = new Map<string, number>()
      calls.forEach((c) => {
        const key = JSON.stringify([c.session_id, c.message_id])
        const list = toolMap.get(key) ?? []
        list.push(c.tool)
        toolMap.set(key, list)
        toolTotals.set(key, c.total)
      })
      returned.forEach((r) => {
        const key = JSON.stringify([r.sessionID, r.messageID])
        const ended = finishMap.get(key)
        const tools = toolMap.get(key) ?? []
        const total = toolTotals.get(key) ?? 0
        Object.assign(r, {
          tools,
          toolsTotal: total,
          toolsComplete: tools.length === total,
          ...(ended ? { finish: ended } : {}),
        })
      })
    }
  }

  if (view === "overview" || view === "cache") {
    sections.unstable = signals.unstable
    sections.pings = [...Map.groupBy(requests, (r) => r.sessionID).values()]
      .map((rows) => windowPings(rows.map((request) => ({ request }))))
      .reduce(
        (total, pings) => ({
          sent: total.sent + pings.sent,
          cost: total.cost + pings.cost,
          followedByHit: total.followedByHit + pings.followedByHit,
          followedByCold: total.followedByCold + pings.followedByCold,
          unused: total.unused + pings.unused,
          unknown: total.unknown + pings.unknown,
          unknownReasons: Object.entries(pings.unknownReasons).reduce(
            (reasons, [reason, count]) => ({ ...reasons, [reason]: (reasons[reason] ?? 0) + count }),
            total.unknownReasons,
          ),
          followedByMiss: total.followedByMiss + pings.followedByMiss,
        }),
        { sent: 0, cost: 0, followedByHit: 0, followedByCold: 0, unused: 0, unknown: 0, unknownReasons: {} as Record<string, number>, followedByMiss: 0 },
      )
    sections.unread = signals.unread
  }

  if (view === "overview") {
    // Sessions active in the window read their latest request's measurement;
    // quiet ones need only their indexed predecessor reads.
    const active = activeSessions(ledger, scope, window)
    sections.context = [
      ...active.map((id) => sessionContext(ledger, id, window.until)),
      ...sessions.filter((session) => !active.includes(session.id)).map((session) => quietContext(ledger, session.id, window.until)),
    ]
    const topMisses = [...misses]
      .sort((a, b) => (b.missCost ?? 0) - (a.missCost ?? 0) || (b.missTokens ?? 0) - (a.missTokens ?? 0))
      .slice(0, 3)
    sections.topMisses = foldText(topMisses)

    const agentMap = new Map<
      string,
      {
        agent: string
        model: string
        steps: number
        misses: number
        input: number
        cacheRead: number
        cacheWrite: number
        output: number
        reasoning: number
        cost: number
        measured: MonitorRequest[]
        legacy: number
        lastActive: number
      }
    >()
    const agentEntry = (agent: string, provider: string, model: string) => {
      const key = `${agent}\0${provider}/${model}`
      let entry = agentMap.get(key)
      if (!entry) {
        entry = {
          agent,
          model: `${provider}/${model}`,
          steps: 0,
          misses: 0,
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          cost: 0,
          measured: [],
          legacy: 0,
          lastActive: 0,
        }
        agentMap.set(key, entry)
      }
      return entry
    }
    for (let i = 0; i < invocations.length; i++) {
      const r = invocations[i]!
      const entry = agentEntry(r.agent ?? "?", r.provider ?? "", r.model ?? "")
      if (r.kind === "step") entry.steps++
      if (isMiss(r)) entry.misses++
      entry.input += r.input
      entry.cacheRead += r.cacheRead
      entry.cacheWrite += r.cacheWrite
      entry.output += r.output
      entry.reasoning += r.reasoning
      entry.cost += r.cost
      entry.measured.push(r)
      if (r.at > entry.lastActive) entry.lastActive = r.at
    }
    // v1 step rows carry their own agent/model and tokens; a mixed ledger must
    // show them in the agents table too, not only in the totals line.
    for (const step of legacy) {
      const entry = agentEntry(step.agent ?? "?", step.provider ?? "", step.model ?? "")
      entry.steps++
      entry.input += step.input
      entry.cacheRead += step.cache_read
      entry.cacheWrite += step.cache_write
      entry.output += step.output
      entry.reasoning += step.reasoning
      entry.cost += step.cost
      entry.legacy++
      if (step.started > entry.lastActive) entry.lastActive = step.started
    }
    sections.agents = [...agentMap.values()]
      .map((e) => ({
        agent: e.agent,
        model: e.model,
        steps: e.steps,
        ...reuseRate(e.measured, e.legacy),
        misses: e.misses,
        tokens: e.input + e.cacheRead + e.cacheWrite + e.output + e.reasoning,
        cost: e.cost,
        lastActive: e.lastActive,
      }))
      .sort((a, b) => b.lastActive - a.lastActive)
  }

  if (sections.sessions) {
    const page = reportPage(sections.sessions, input.pages?.sessions)
    sections.sessions = page.rows
    pages.sessions = page.metadata
  }
  if (sections.context) {
    const page = reportPage(sections.context, input.pages?.context)
    sections.context = page.rows
    pages.context = page.metadata
  }
  if (sections.agents) {
    const page = reportPage(sections.agents, input.pages?.agents)
    sections.agents = page.rows
    pages.agents = page.metadata
  }
  if (sections.teams) {
    const page = reportPage(sections.teams, input.pages?.teams)
    sections.teams = page.rows
    pages.teams = page.metadata
  }
  if (sections.unstable) {
    const page = reportPage(sections.unstable, input.pages?.unstable)
    sections.unstable = page.rows
    pages.unstable = page.metadata
  }
  if (sections.detail) {
    const detail = sections.detail
    const lines = reportPage(detail.lines, input.pages?.["detail.lines"], 50)
    const segments = reportPage(detail.segments, input.pages?.["detail.segments"], 50)
    const pings = reportPage(detail.pings, input.pages?.["detail.pings"], 50)
    const accounts = reportPage(detail.accounts, input.pages?.["detail.accounts"], 50)
    const instructions = reportPage(
      detail.instructions.flatMap((entry) =>
        entry.keys.length > 1 ? entry.keys.map((key) => ({ ...entry, keys: [key] })) : [entry],
      ),
      input.pages?.["detail.instructions"],
      50,
    )
    const reverts = reportPage(detail.reverts, input.pages?.["detail.reverts"], 50)
    sections.detail = {
      ...detail,
      lines: lines.rows,
      segments: segments.rows,
      pings: pings.rows,
      accounts: accounts.rows,
      instructions: instructions.rows,
      reverts: reverts.rows,
    }
    Object.assign(pages, {
      "detail.lines": lines.metadata,
      "detail.segments": segments.metadata,
      "detail.pings": pings.metadata,
      "detail.accounts": accounts.metadata,
      "detail.instructions": instructions.metadata,
      "detail.reverts": reverts.metadata,
    })
  }
  sections.pages = pages
  // Text limits are presentation limits, not a hard response-byte guarantee.
  // IDs/opaque hashes stay intact; fullText exposes unabridged selected facts.
  const truncated: NonNullable<MonitorReport["presentation"]>["truncated"][number][] = []
  const textLimit = 512
  const present = <T extends object>(row: T, section: string, at: number): T => {
    const clip = (value: unknown, field: string): unknown => {
      if (typeof value === "string") {
        const key = field.split(".").at(-1)!
        if (
          value.length <= textLimit ||
          input.fullText ||
          key === "id" ||
          key === "hash" ||
          key.endsWith("ID") ||
          key.endsWith("Id") ||
          key.endsWith("Hash")
        )
          return value
        truncated.push({ section, row: at, field, chars: value.length })
        return `${value.slice(0, textLimit)}…`
      }
      if (Array.isArray(value)) return value.map((entry, i) => clip(entry, `${field}.${i}`))
      if (value !== null && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, clip(entry, field ? `${field}.${key}` : key)]),
        )
      return value
    }
    return clip(row, "") as T
  }
  if (sections.requests) sections.requests = sections.requests.map((r, i) => present(r, "requests", i))
  if (sections.sessions) sections.sessions = sections.sessions.map((r, i) => present(r, "sessions", i))
  if (sections.agents) sections.agents = sections.agents.map((r, i) => present(r, "agents", i))
  if (sections.unstable) sections.unstable = sections.unstable.map((r, i) => present(r, "unstable", i))
  if (sections.topMisses) sections.topMisses = sections.topMisses.map((r, i) => present(r, "topMisses", i))
  if (sections.detail) {
    const detail = sections.detail
    sections.detail = {
      ...detail,
      request: present(detail.request, "detail.request", 0),
      lines: detail.lines.map((line, i) => present({ line }, "detail.lines", i).line),
      segments: detail.segments.map((r, i) => present(r, "detail.segments", i)),
      calls: detail.calls?.map((r, i) => present(r, "detail.calls", i)),
      accounts: detail.accounts.map((r, i) => present(r, "detail.accounts", i)),
      instructions: detail.instructions.map((entry, i) => ({
        ...entry,
        keys: entry.keys.map((key) => present({ key }, "detail.instructions", i).key),
      })),
      ...(detail.firstDivergence
        ? { firstDivergence: present({ firstDivergence: detail.firstDivergence }, "detail", 0).firstDivergence }
        : {}),
    }
  }
  sections.presentation = { textLimit, truncated }
  sections.cachePending = signals.cachePending
  if (signals.analysisPending > 0) sections.analysisPending = signals.analysisPending
  const nextExpiry = signals.nextExpiry
  return { totals, sections, nextExpiry, enrichment }
}

// Unread writes and unstable prefixes from the saved per-write and per-request
// analysis; what is not saved yet is pending.
function savedSignals(
  ledger: Ledger,
  input: MonitorQueryInput,
  window: { since: number; until: number },
  sessionIDs: readonly string[] | null,
) {
  const options = { ...(input.agents === undefined ? {} : { agents: input.agents }), ...(input.models === undefined ? {} : { models: input.models }) }
  const unread = savedUnread(ledger, sessionIDs, window, { ...options, titles: input.titles === true })
  const unstable = savedUnstable(ledger, sessionIDs, window, options)
  const ids = JSON.stringify(sessionIDs ?? [])
  const all = sessionIDs === null ? 1 : 0
  // A written cache that expires after the window's end is counted once it expires.
  const nextExpiry = ledger.db
    .query<{ at: number | null }, [number, number, number, number, string]>(
      `select min(expires) at from unread_write where at >= ? and at < ? and expires > ?
        and (? = 1 or session_id in (select value from json_each(?)))`,
    )
    .get(window.since, window.until, window.until, all, ids)?.at ?? Infinity
  const cachePending = ledger.db
    .query<{ n: number }, [number, string, number, string]>(
      `select max(0, (select count(*) from request indexed by request_ended where ended is not null and (? = 1 or session_id in (select value from json_each(?))))
        - (select count(*) from cache_result where ? = 1 or session_id in (select value from json_each(?)))) n`,
    )
    .get(all, ids, all, ids)!.n
  return {
    unread: unread.unread,
    unstable: unstable.unstable,
    nextExpiry,
    cachePending,
    analysisPending: unread.pending + unstable.pending,
  }
}

const settled = new WeakMap<Ledger, string>()

/**
 * Saves about 100 ms of what a report reads (results, then changed segments,
 * then expired writes) on the service's thread. Each kind saves at least one
 * batch, so a quiet ledger is complete at once however slow the machine; a
 * backlog continues in the next report and the background backfill
 * (snapshot.ts). A ledger left complete and unchanged has nothing new to save,
 * so an idle poll runs no SQL; a write that merely expires is finalized by
 * that backfill.
 */
export function settleSavedAnalysis(ledger: Ledger) {
  if (settled.get(ledger) === ledger.revision()) return
  const deadline = performance.now() + 100
  const drain = (batch: () => number) => {
    while (batch() > 0) if (performance.now() >= deadline) return true
    return false
  }
  const backlog = [
    drain(() => backfillCacheBatch(ledger, 16)),
    drain(() => settleRequestChanges(ledger, 64)),
    drain(() => settleUnreadWrites(ledger, Date.now(), 8)),
  ].includes(true)
  if (!backlog) settled.set(ledger, ledger.revision())
}

// Requests still running in scope and window, under the report's selection:
// not saved yet, so analyzed here exactly as their saved results will be.
function runningRequests(
  ledger: Ledger,
  input: MonitorQueryInput,
  scope: ReturnType<typeof scopeOf>,
  window: { since: number; until: number },
): MonitorRequest[] {
  const ids = ledger.db
    .query<{ id: string }, typeof scope.bindings>(
      `${scope.cte} select id from request where ended is null and started >= $runningSince and started < $runningUntil
        ${scope.cte ? "and session_id in (select id from scope)" : ""}`,
    )
    .all({ ...scope.bindings, $runningSince: window.since, $runningUntil: window.until })
    .map((row) => row.id)
  if (ids.length === 0) return []
  const compactions = compactionsBefore(ledger, input, window.until)
  const analyzed = requestAnalysis(ledger, ids)
  return ids.flatMap((id) => {
    const r = analyzed.summary(id)
    if (r === undefined) return []
    const selected = r.at >= Math.max(window.since, compactions?.get(r.sessionID) ?? 0) &&
      (input.titles || r.kind !== "title") &&
      (!input.agents?.length || input.agents.includes(r.agent ?? "")) &&
      (!input.models?.length || input.models.includes(`${r.provider}/${r.model}`))
    return selected ? [r] : []
  })
}

// Each session's latest compaction before `until`, when the report starts there.
function compactionsBefore(ledger: Ledger, input: MonitorQueryInput, until: number) {
  if (!input.sinceCompaction) return undefined
  return new Map(
    ledger.db
      .query<{ id: string; at: number }, [number]>(
        "select session_id id, max(at) at from context_fact where kind = 'compaction' and at < ? group by session_id",
      )
      .all(until)
      .map((row) => [row.id, row.at]),
  )
}

// Sessions with a request, step or fact in the window. Hooks can record a
// request before the asynchronous host lookup learns its session, so these
// come from the activity tables, not the session list.
function activeSessions(ledger: Ledger, scope: ReturnType<typeof scopeOf>, window: { since: number; until: number }): string[] {
  const within = scope.cte ? "and session_id in (select id from scope)" : ""
  return ledger.db
    .query<{ id: string }, typeof scope.bindings>(
      `${scope.cte}
      select distinct session_id as id from request where started >= $activeSince and started < $activeUntil ${within}
      union select distinct session_id as id from step where started >= $activeSince and started < $activeUntil ${within}
      union select distinct session_id as id from context_fact where at >= $activeSince and at < $activeUntil ${within}`,
    )
    .all({ ...scope.bindings, $activeSince: window.since, $activeUntil: window.until })
    .map((row) => row.id)
}

// A quiet session's prompt size as of `until`, from indexed reads only.
function quietContext(ledger: Ledger, sessionID: string, until: number): NonNullable<MonitorReport["context"]>[number] {
  const state = ledger.db
    .query<{ now: number; atCompaction: number | null; status: string | null }, { $session: string; $until: number }>(`
      select coalesce((select input_tokens + cache_read_tokens + cache_write_tokens from request
        where session_id = $session and started < $until and kind != 'ping' and is_title = 0
        order by started desc, id desc limit 1), 0) as now,
      (select input_tokens + cache_read_tokens + cache_write_tokens from request
        where session_id = $session and started < $until and kind not in ('ping', 'compaction') and is_title = 0
        and started >= (select max(at) from context_fact where session_id = $session and kind = 'compaction' and at < $until)
         order by started, id limit 1) as atCompaction,
       (select status from request where session_id=$session and started < $until and kind != 'ping' and is_title=0
         order by started desc,id desc limit 1) as status`)
    .get({ $session: sessionID, $until: until })!
  return {
    sessionID,
    now: state.now,
    inputState: state.status === "running" ? "pending" : state.status === null ? "unavailable" : "stored",
    ...(state.atCompaction === null ? {} : { atCompaction: state.atCompaction }),
  }
}

// v1 steps recorded before request rows existed, in scope and window: they
// count in token totals and the agents table.
function legacyStepRows(
  ledger: Ledger,
  input: MonitorQueryInput,
  scope: ReturnType<typeof scopeOf>,
  window: { since: number; until: number },
): LegacyStep[] {
  const orphan = "not exists (select 1 from request r where r.session_id = s.session_id and r.message_id = s.message_id)"
  if ((ledger.db.query<{ c: number }, []>(`select count(*) as c from step s where ${orphan}`).get()?.c ?? 0) === 0) return []
  const compactions = compactionsBefore(ledger, input, window.until)
  return ledger.db
    .query<LegacyStep, typeof scope.bindings>(
      `${scope.cte} select s.* from step s where ${orphan} ${scope.cte ? "and s.session_id in (select id from scope)" : ""}`,
    )
    .all(scope.bindings)
    .filter(
      (s) =>
        s.started >= Math.max(window.since, compactions?.get(s.session_id) ?? 0) &&
        s.started < window.until &&
        (!input.agents?.length || input.agents.includes(s.agent ?? "")) &&
        (!input.models?.length || input.models.includes(`${s.provider}/${s.model}`)),
    )
}

// The session's prompt size as of `until`: its latest real request, and the
// first real request after its latest compaction.
function sessionContext(ledger: Ledger, sessionID: string, until: number): NonNullable<MonitorReport["context"]>[number] {
  const ids = ledger.db
    .query<{ current: string | null; after: string | null }, { $session: string; $until: number }>(`
      select (select id from request where session_id = $session and started < $until and kind != 'ping' and is_title = 0
          order by started desc, id desc limit 1) as current,
        (select id from request where session_id = $session and started < $until and kind not in ('ping', 'compaction') and is_title = 0
          and started >= (select max(at) from context_fact where session_id = $session and kind = 'compaction' and at < $until)
          order by started, id limit 1) as after`)
    .get({ $session: sessionID, $until: until })
  const current = ids?.current ? ledger.getRequest(ids.current) : undefined
  const after = ids?.after ? ledger.getRequest(ids.after) : undefined
  const measured = current ? measurement(current) : undefined
  return {
    sessionID,
    now: current ? promptTokens(current) : 0,
    inputState:
      current?.status === "running"
        ? "pending"
        : measured?.input !== undefined
          ? "measured"
          : measured?.state === "legacy-unknown"
            ? "stored"
            : "unavailable",
    ...(measured?.input === undefined ? {} : { measuredNow: measured.input }),
    ...(after ? { atCompaction: promptTokens(after) } : {}),
  }
}
