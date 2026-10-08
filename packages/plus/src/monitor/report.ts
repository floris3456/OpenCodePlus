import type { MonitorQueryInput, MonitorReport, MonitorRequest, MonitorSessionRow, MonitorTotals } from "../rpc.js"
import {
  foldSession,
  isMiss,
  promptTokens,
  sessionFingerprints,
  windowedSessionSignals,
  type SessionAnalysis,
  type SessionFold,
} from "./cache.js"
import type { ContextFactRow, Ledger, RequestRow } from "./ledger.js"
import { scopeOf, type QueryContext } from "./query.js"

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

interface CachedSession {
  /** The ledger revision this entry was last confirmed at. */
  revision: string
  /** The session's change mark the entry was built from. */
  readonly mark: number
  /** The fingerprints were looked up per request (none stored under this session). */
  readonly perRequest: boolean
  readonly fold: SessionFold
  readonly lastFrom?: number
}

interface SessionData {
  readonly rows: readonly RequestRow[]
  readonly facts: readonly ContextFactRow[]
  readonly analysis: SessionAnalysis
}

const sessionCache = new WeakMap<Ledger, Map<string, CachedSession>>()

// One session's rows, facts and analysis. The analysis folds in-place writes
// (request completion, a corrected final wire fingerprint, a kind relabel), so
// it is keyed on change marks, never on row ids. An unchanged ledger revision
// (which also covers other connections and processes) answers at once; an
// unchanged session mark answers with one lookup however busy other chats are.
// Otherwise only this session is read again, only changed fingerprints are
// loaded, and the fold resumes at the first request a change can affect. The
// analysis never depends on the query window, so it stays reusable across
// window changes and polling.
function sessionData(ledger: Ledger, id: string): SessionData {
  const cache = sessionCache.get(ledger) ?? new Map<string, CachedSession>()
  sessionCache.set(ledger, cache)
  const cached = cache.get(id)
  const revision = ledger.revision()
  if (cached && cached.revision === revision) return dataOf(cached.fold)
  // The mark is read before the rows: a write in between shows as a change next time.
  const mark = ledger.sessionRevision(id)
  if (cached && !cached.perRequest && cached.mark === mark) {
    cached.revision = revision
    return dataOf(cached.fold)
  }
  const changed = cached && !cached.perRequest ? ledger.changedFingerprints(id, cached.mark) : []
  const rows = ledger.getRequests(id)
  const facts = ledger.getContextFacts(id)
  const updated = cached && !cached.perRequest ? updatedFingerprints(ledger, id, cached.fold, changed) : undefined
  if (cached && !cached.perRequest && updated && updated.size > 0) {
    const from = firstChange(cached.fold, rows, facts, changed)
    const fold = foldSession(rows, facts, updated, { previous: cached.fold, from })
    cache.set(id, { revision, mark, perRequest: false, fold, lastFrom: from })
    return dataOf(fold)
  }
  if (cached && cached.perRequest) {
    const fingerprints = new Map(cached.fold.analysis.fingerprints)
    for (const r of rows.slice(cached.fold.rows.length)) {
      fingerprints.set(r.id, ledger.getFingerprint(r.id))
    }
    const from = firstChange(cached.fold, rows, facts, [])
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
  sessionData(ledger, id)
  const cached = sessionCache.get(ledger)?.get(id)
  if (!cached) throw new Error(`Missing fold for session ${id}`)
  return cached.fold
}

export function sessionFoldResumeFrom(ledger: Ledger, id: string): number | undefined {
  return sessionCache.get(ledger)?.get(id)?.lastFrom
}

function dataOf(fold: SessionFold): SessionData {
  return { rows: fold.rows, facts: fold.facts, analysis: fold.analysis }
}

// The cached fingerprints with the changed ones reloaded (or dropped when deleted).
function updatedFingerprints(ledger: Ledger, id: string, fold: SessionFold, changed: readonly string[]) {
  const fingerprints = new Map(fold.analysis.fingerprints)
  for (const requestID of changed) {
    const fp = ledger.getFingerprint(requestID)
    if (fp?.sessionID === id) fingerprints.set(requestID, fp)
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
      : [...facts.slice(factChange), ...fold.facts.slice(factChange)].reduce((min, fact) => Math.min(min, fact.at), Infinity)
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
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]))
}

function sameFact(a: ContextFactRow, b: ContextFactRow): boolean {
  return a.id === b.id && a.at === b.at && a.kind === b.kind && a.sessionID === b.sessionID && JSON.stringify(a.detail) === JSON.stringify(b.detail)
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

  // Hooks can record a request before the asynchronous host lookup learns its
  // session; include these rows rather than silently losing real requests.
  const ids = ledger.db
    .query<{ id: string }, [typeof scope.bindings]>(
      `${scope.cte}
    select distinct session_id as id from request ${scope.cte ? "where session_id in (select id from scope)" : ""}
    union select distinct session_id as id from step ${scope.cte ? "where session_id in (select id from scope)" : ""}`,
    )
    .all(scope.bindings)
    .map((s) => s.id)

  const selected = [...new Set([...sessions.map((s) => s.id), ...ids])]

  const legacyMap = new Map<string, LegacyStep[]>()
  const hasLegacySteps =
    ledger.db
      .query<
        { c: number },
        []
      >("select count(*) as c from step s where not exists (select 1 from request r where r.session_id = s.session_id and r.message_id = s.message_id)")
      .get()?.c ?? 0

  if (hasLegacySteps > 0) {
    const rawLegacy = ledger.db
      .query<
        LegacyStep,
        [typeof scope.bindings]
      >(`${scope.cte} select s.* from step s where not exists (select 1 from request r where r.session_id = s.session_id and r.message_id = s.message_id) ${scope.cte ? "and s.session_id in (select id from scope)" : ""}`)
      .all(scope.bindings)
    for (let i = 0; i < rawLegacy.length; i++) {
      const step = rawLegacy[i]!
      const list = legacyMap.get(step.session_id)
      if (list) list.push(step)
      else legacyMap.set(step.session_id, [step])
    }
  }

  const analyses = selected.map((id) => {
    const { rows, facts, analysis } = sessionData(ledger, id)
    const compact = facts.findLast((f) => f.kind === "compaction" && f.at < window.until)?.at
    const since = Math.max(window.since, input.sinceCompaction ? (compact ?? 0) : 0)
    const legacy = (legacyMap.get(id) ?? []).filter(
      (s) =>
        s.started >= since &&
        s.started < window.until &&
        (!input.agents?.length || input.agents.includes(s.agent ?? "")) &&
        (!input.models?.length || input.models.includes(`${s.provider}/${s.model}`)),
    )
    const signals = windowedSessionSignals(
      analysis,
      { since, until: window.until },
      { agents: input.agents, models: input.models, titles: input.titles },
    )
    const details = analysis.details.filter(
      (d) =>
        d.request.at >= since &&
        d.request.at < window.until &&
        (input.titles || d.request.kind !== "title") &&
        (!input.agents?.length || input.agents.includes(d.request.agent ?? "")) &&
        (!input.models?.length || input.models.includes(`${d.request.provider}/${d.request.model}`)),
    )
    const current = rows.findLast((r) => r.started < window.until && r.kind !== "ping" && !r.isTitle)
    const after =
      compact === undefined
        ? undefined
        : rows.find((r) => r.started >= compact && r.kind !== "compaction" && r.kind !== "ping" && !r.isTitle)
    return {
      id,
      rows,
      details,
      legacy,
      unstable: signals.unstable.map((entry) => ({ ...entry, sessionID: id })),
      fingerprints: analysis.fingerprints,
      unread: signals.unread,
      pings: signals.pings,
      context: {
        sessionID: id,
        now: current ? promptTokens(current) : 0,
        ...(after ? { atCompaction: promptTokens(after) } : {}),
      },
    }
  })

  const details = analyses
    .flatMap((a) => a.details)
    .sort((a, b) => a.request.at - b.request.at || a.request.id.localeCompare(b.request.id))
  // Copies: the steps view adds per-query fields, and the analysis is cached.
  const requests = details.map((d) => ({ ...d.request }))

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

  // The hit rate reads only requests that produced a cache verdict. An errored
  // request's tokens are real usage but must not move the rate; its input and
  // cache read are excluded here while remaining in the token totals above.
  const rateOf = (rows: readonly MonitorRequest[]) =>
    rows.reduce(
      (acc, r) =>
        r.verdict === "error"
          ? acc
          : { input: acc.input + (r.input ?? 0), cacheRead: acc.cacheRead + (r.cacheRead ?? 0) },
      { input: 0, cacheRead: 0 },
    )
  const hitRateOf = (rate: { readonly input: number; readonly cacheRead: number }, legacyRead: number, legacyInput: number) =>
    (rate.cacheRead + legacyRead) / Math.max(1, rate.cacheRead + legacyRead + rate.input + legacyInput)

  const pingRows = requests.filter((r) => r.kind === "ping")
  const misses = requests.filter(isMiss)
  const legacy = analyses.flatMap((a) => a.legacy)
  const legacyTotal = (key: "input" | "output" | "reasoning" | "cache_read" | "cache_write" | "cost") =>
    legacy.reduce((n, s) => n + s[key], 0)
  const rateTotals = rateOf(requests)
  const totals: Partial<MonitorTotals> = {
    ...(requests.length ? totalsFor(requests) : { requests: 0, hitRate: 0, misses: 0 }),
    pings: pingRows.length,
    pingCost: sum(pingRows, "cost"),
    missTokens: sum(misses, "missTokens"),
    // Unknown pricing is omitted, not represented as a free miss.
    ...(misses.every((r) => r.missCost !== undefined) ? { missCost: sum(misses, "missCost") } : {}),
    input: sum(requests, "input") + legacyTotal("input"),
    output: sum(requests, "output") + legacyTotal("output"),
    reasoning: sum(requests, "reasoning") + legacyTotal("reasoning"),
    cacheRead: sum(requests, "cacheRead") + legacyTotal("cache_read"),
    cacheWrite: sum(requests, "cacheWrite") + legacyTotal("cache_write"),
    cost: sum(requests, "cost") + legacyTotal("cost"),
    hitRate: hitRateOf(rateTotals, legacyTotal("cache_read"), legacyTotal("input")),
  }

  const sections: { -readonly [K in keyof MonitorReport]?: MonitorReport[K] } = {
    teams: ledger.db
      .query<{ team: string }, []>("select distinct team from session where team is not null order by team")
      .all()
      .map((r) => r.team),
  }

  const view = input.view ?? "overview"
  if (view === "cache" || view === "steps" || input.view === undefined) {
    sections.requests = requests.filter((r) => !input.missesOnly || isMiss(r))
  }

  if (input.id) {
    const index = details.findIndex((d) => d.request.id === input.id)
    const detail = details[index]
    if (detail) {
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
          [string, string]
        >(
          `select c.*, c.result_tokens * max(0, coalesce(e.last_idx, c.idx) - c.idx) as carried
          from call c
          left join epoch e on e.session_id = c.session_id and e.epoch = c.epoch
          where c.session_id = ? and c.message_id = ?
          order by c.started`,
        )
        .all(detail.request.sessionID, detail.request.messageID ?? "")

      sections.detail = {
        ...detail,
        request: requests[index]!,
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

  if (view === "steps" || view === "cache") {
    const hasSteps = ledger.db.query<{ c: number }, []>("select count(*) as c from step").get()?.c ?? 0
    const hasCalls = ledger.db.query<{ c: number }, []>("select count(*) as c from call").get()?.c ?? 0

    if (hasSteps > 0 || hasCalls > 0) {
      const finishByMessage = new Map<string, string>()
      const toolsByMessage = new Map<string, string[]>()

      if (hasSteps > 0) {
        const stepRows = ledger.db
          .query<
            { session_id: string; message_id: string; finish: string | null },
            [typeof scope.bindings]
          >(`${scope.cte} select session_id, message_id, finish from step where message_id is not null ${scope.cte ? "and session_id in (select id from scope)" : ""}`)
          .all(scope.bindings)
        for (let i = 0; i < stepRows.length; i++) {
          const s = stepRows[i]!
          if (s.finish) finishByMessage.set(`${s.session_id}:${s.message_id}`, s.finish)
        }
      }

      if (hasCalls > 0) {
        const callRows = ledger.db
          .query<
            { session_id: string; message_id: string; tool: string },
            [typeof scope.bindings]
          >(`${scope.cte} select distinct session_id, message_id, tool from call where message_id is not null ${scope.cte ? "and session_id in (select id from scope)" : ""}`)
          .all(scope.bindings)
        for (let i = 0; i < callRows.length; i++) {
          const c = callRows[i]!
          const key = `${c.session_id}:${c.message_id}`
          const list = toolsByMessage.get(key)
          if (list) list.push(c.tool)
          else toolsByMessage.set(key, [c.tool])
        }
      }

      for (let i = 0; i < requests.length; i++) {
        const r = requests[i]!
        const key = `${r.sessionID}:${r.messageID ?? ""}`
        const tools = toolsByMessage.get(key) ?? []
        const finish = finishByMessage.get(key)
        Object.assign(r, { tools, ...(finish ? { finish } : {}) })
      }
    } else {
      for (let i = 0; i < requests.length; i++) {
        Object.assign(requests[i]!, { tools: [] })
      }
    }
  }

  if (view === "overview" || view === "cache") {
    sections.unstable = analyses.flatMap((a) => a.unstable)
    sections.pings = {
      sent: pingRows.length,
      cost: sum(pingRows, "cost"),
      followedByHit: analyses.reduce((n, a) => n + a.pings.followedByHit, 0),
      followedByMiss: analyses.reduce((n, a) => n + a.pings.followedByMiss, 0),
    }
    sections.unread = analyses.reduce((total, a) => total + a.unread, 0)
  }

  if (view === "overview") {
    sections.context = analyses.map((a) => a.context)
    sections.topMisses = [...misses]
      .sort((a, b) => (b.missCost ?? 0) - (a.missCost ?? 0) || (b.missTokens ?? 0) - (a.missTokens ?? 0))
      .slice(0, 3)

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
        rateInput: number
        rateCacheRead: number
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
          rateInput: 0,
          rateCacheRead: 0,
          lastActive: 0,
        }
        agentMap.set(key, entry)
      }
      return entry
    }
    for (let i = 0; i < requests.length; i++) {
      const r = requests[i]!
      const entry = agentEntry(r.agent ?? "?", r.provider ?? "", r.model ?? "")
      if (r.kind === "step") entry.steps++
      if (isMiss(r)) entry.misses++
      entry.input += r.input
      entry.cacheRead += r.cacheRead
      entry.cacheWrite += r.cacheWrite
      entry.output += r.output
      entry.reasoning += r.reasoning
      entry.cost += r.cost
      if (r.verdict !== "error") {
        entry.rateInput += r.input
        entry.rateCacheRead += r.cacheRead
      }
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
      entry.rateInput += step.input
      entry.rateCacheRead += step.cache_read
      if (step.started > entry.lastActive) entry.lastActive = step.started
    }
    sections.agents = [...agentMap.values()]
      .map((e) => ({
        agent: e.agent,
        model: e.model,
        steps: e.steps,
        hitRate: e.rateCacheRead / Math.max(1, e.rateInput + e.rateCacheRead),
        misses: e.misses,
        tokens: e.input + e.cacheRead + e.cacheWrite + e.output + e.reasoning,
        cost: e.cost,
        lastActive: e.lastActive,
      }))
      .sort((a, b) => b.lastActive - a.lastActive)
  }

  if (view === "sessions") {
    const all = ledger.db.query<SessionRow, []>("select * from session").all()
    const byID = new Map(all.map((s) => [s.id, s]))
    const rows: MonitorSessionRow[] = sessions.map((s) => {
      const chain = [s.id]
      for (let parent = s.parent_id; parent && !chain.includes(parent); parent = byID.get(parent)?.parent_id ?? null) {
        chain.push(parent)
      }
      const rs = requests.filter((r) => r.sessionID === s.id)
      const sessionLegacy = analyses.find((a) => a.id === s.id)?.legacy ?? []
      const base = totalsFor(rs)
      const rate = rateOf(rs)
      const legacySum = (key: "input" | "output" | "reasoning" | "cache_read" | "cache_write" | "cost") =>
        sessionLegacy.reduce((n, step) => n + step[key], 0)
      const input = base.input + legacySum("input")
      const cacheRead = base.cacheRead + legacySum("cache_read")
      // The host is authoritative for the agent; the ledger's last write is the
      // fallback, which can have been overwritten by a title or generate call.
      const agent = context.agents?.get(s.id) ?? s.agent
      return {
        sessionID: s.id,
        rootID: chain.at(-1)!,
        depth: chain.length - 1,
        ...(s.parent_id ? { parentID: s.parent_id } : {}),
        ...(s.title ? { title: s.title } : {}),
        ...(agent ? { agent } : {}),
        ...(s.run_id ? { runID: s.run_id } : {}),
        ...(s.role ? { role: s.role } : {}),
        ...(s.team ? { team: s.team } : {}),
        ...(context.states?.get(s.id) === undefined ? {} : { state: context.states.get(s.id)! }),
        lastActive: Math.max(rs.at(-1)?.at ?? 0, sessionLegacy.at(-1)?.started ?? 0) || s.last_seen,
        input,
        output: base.output + legacySum("output"),
        reasoning: base.reasoning + legacySum("reasoning"),
        cacheRead,
        cacheWrite: base.cacheWrite + legacySum("cache_write"),
        cost: base.cost + legacySum("cost"),
        hitRate: hitRateOf(rate, legacySum("cache_read"), legacySum("input")),
        requests: base.requests,
        steps: base.steps + sessionLegacy.length,
        misses: base.misses,
      }
    })

    const ordered: MonitorSessionRow[] = []
    const visit = (row: MonitorSessionRow) => {
      ordered.push(row)
      rows
        .filter((s) => s.parentID === row.sessionID)
        .sort((a, b) => b.lastActive - a.lastActive)
        .forEach(visit)
    }

    rows
      .filter((r) => !rows.some((p) => p.sessionID === r.parentID))
      .sort(
        (a, b) =>
          Math.max(...rows.filter((r) => r.rootID === b.rootID).map((r) => r.lastActive)) -
          Math.max(...rows.filter((r) => r.rootID === a.rootID).map((r) => r.lastActive)),
      )
      .forEach(visit)

    sections.sessions = ordered
  }

  return { totals, sections }
}
