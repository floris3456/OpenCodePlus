import fs from "node:fs"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { Effect, Schema } from "effect"
import type { MonitorQueryInput, MonitorReport, MonitorRequest, MonitorRequestDetail, MonitorSessionRow } from "../rpc.js"
import { foldSession, markedMessageBoundary } from "./cache.js"
import { sha256 } from "./fingerprint.js"
import { CACHE_COLUMNS, cacheColumnValues, type Ledger, type RequestFingerprintData, type RequestRow } from "./ledger.js"
import { scopeOf, type QueryContext } from "./query.js"
import { settleUnreadWrites } from "./unread-saved.js"
import { settleRequestChanges } from "./unstable-saved.js"
import { comparableWire, hasWire, storeWire, wireBody } from "./wire.js"

const decodeWire = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))
type WireDiff = { append: boolean; addedMessages: number; addedChars: number; changed: string[]; first?: string; options: string[]; markers: string[] }

function jsonObject(value: Schema.Json | undefined): value is Schema.JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function toolName(value: Schema.Json) {
  if (!jsonObject(value)) return
  if (typeof value.name === "string") return value.name
  if (jsonObject(value.function) && typeof value.function.name === "string") return value.function.name
}

/** Compare every supplied field, including thinking/signatures and cache markers.
 * Only top-level generation budgets and streaming are separated from prompt changes. Object
 * key order is JSON noise; array order and string bytes are never normalized.
 */
export function compareWire(before: string, after: string): WireDiff {
  return compareWireValues(decodeWire(before), decodeWire(after))
}

/** compareWire for decoded bodies, such as the values `comparableWire` gives. */
export function compareWireValues(a: Schema.JsonObject, b: Schema.JsonObject): WireDiff {
  const changed: string[] = []
  const options: string[] = []
  const markers: string[] = []
  const additions = { messages: 0, chars: 0 }
  const visit = (a: Schema.Json | undefined, b: Schema.Json | undefined, at: string) => {
    if (a === b) return
    if (Array.isArray(a) && Array.isArray(b)) {
      if (at === "tools") {
        const left = new Map(a.map((value: Schema.Json) => [toolName(value), value]))
        const right = new Map(b.map((value: Schema.Json) => [toolName(value), value]))
        if (!left.has(undefined) && !right.has(undefined) && left.size === a.length && right.size === b.length) {
          const common = [...left.keys()].filter((name) => right.has(name))
          const order = [...right.keys()].filter((name) => left.has(name))
          if (common.some((name, index) => order[index] !== name)) changed.push("tools.order")
          for (const name of new Set([...left.keys(), ...right.keys()])) visit(left.get(name), right.get(name), `tools[${name}]`)
          return
        }
      }
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((at === "messages" || at === "input") && i >= a.length) {
          additions.messages++
          additions.chars += JSON.stringify(b[i]).length
          continue
        }
        visit(a[i], b[i], `${at}[${i}]`)
      }
      return
    }
    if (jsonObject(a) && jsonObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) visit(a[key], b[key], at ? `${at}.${key}` : key)
      return
    }
    // Persist field paths only; exact values remain in the transcript files.
    if (/(^|\.)cache_control(?:\.|$)/.test(at)) markers.push(at)
    else changed.push(at)
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const onDemand = jsonObject(b.compaction) && b.compaction.type === "summarize"
    if (["max_tokens", "max_output_tokens", "max_completion_tokens", "stream"].includes(key) ||
      (onDemand && (key === "compaction" || (key === "context_management" && a[key] == null && b[key] === null)))) {
      if (a[key] !== b[key]) options.push(key)
      continue
    }
    visit(a[key], b[key], key)
  }
  return { append: changed.length === 0, addedMessages: additions.messages, addedChars: additions.chars, changed, first: changed[0], options, markers }
}

/**
 * Called by the final transport observer, after every request transform. The
 * wire store keeps each sent item once; only a body it cannot rebuild
 * byte-for-byte also keeps an exact compressed copy.
 */
export async function captureWire(ledger: Ledger, id: string, body: string, options: { sessionID?: string; url?: string; at?: number } = {}) {
  const exact = storeWire(ledger, {
    requestID: id,
    sessionID: options.sessionID ?? ledger.getRequest(id)?.sessionID ?? "",
    at: options.at ?? ledger.getRequest(id)?.started ?? Date.now(),
    body,
    ...(options.url ? { url: options.url } : {}),
  })
  if (exact || ledger.path === ":memory:") return
  const directory = `${ledger.path}.transcripts`
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${sha256(id)}.json.gz`)
  await fs.promises.writeFile(file, Bun.gzipSync(body), { mode: 0o600 })
  ledger.db.query("insert into cache_wire values (?, ?) on conflict(request_id) do update set path = excluded.path").run(id, file)
}

/** Where a request's sent body is kept: an exact compressed copy, or the item store. */
function transcript(ledger: Ledger, id: string) {
  const stored = ledger.db.query<{ path: string }, [string]>("select path from cache_wire where request_id = ?").get(id)
  if (stored && fs.existsSync(stored.path)) return { archive: stored.path }
  return hasWire(ledger, id) ? {} : undefined
}

function compareTranscripts(ledger: Ledger, previous: string | undefined, id: string) {
  // A missing/corrupt diagnostic archive must never suppress measured detection.
  try {
    const before = previous ? transcript(ledger, previous) : undefined
    const after = transcript(ledger, id)
    if (!previous || !before || !after) return { before, after, diff: undefined }
    // Two stored bodies compare without decoding the items they share.
    const values = before.archive || after.archive ? undefined : comparableWire(ledger, previous, id)
    if (values) return { before, after, diff: compareWireValues(values.before, values.after) }
    const text = (target: { archive?: string }, request: string) =>
      target.archive ? gunzipSync(fs.readFileSync(target.archive)).toString() : wireBody(ledger, request)
    const a = text(before, previous)
    const b = text(after, id)
    return { before, after, diff: a !== undefined && b !== undefined ? compareWire(a, b) : undefined }
  } catch {
    return { before: undefined, after: undefined, diff: undefined }
  }
}

// The rows a whole-history fold reads for one request: its cache predecessor,
// the latest earlier completed request, its last real request and its context
// baseline (cache.ts contextBaseline). Folding the session from the earliest of
// them, with its facts so far, gives the request exactly the whole fold's
// analysis (checked equal for 8,468 requests of a live ledger copy).
function anchorsOf(ledger: Ledger, current: RequestRow) {
  const epoch = current.observation?.historyEpoch ?? null
  const previousID = ledger.db.query<{ id: string }, [string, string | null, string | null, string | null, number, string, string]>(`
    select id from request where session_id = ? and provider is ? and model is ?
      and json_extract(observation, '$.historyEpoch') is ? and ended <= ? and status = 'completed'
      and is_title = 0 and (kind != 'generate' or ? = 'generate') and id != ?
    order by ended desc, started desc, id desc limit 1
  `).get(current.sessionID, current.provider ?? null, current.model ?? null, epoch, current.started, current.kind, current.id)?.id
  const previous = previousID ? ledger.getRequest(previousID) : undefined
  const latestID = ledger.db.query<{ id: string }, [string, number, string]>(`
    select id from request where session_id = ? and ended <= ? and status = 'completed' and is_title = 0 and id != ?
    order by ended desc, started desc, id desc limit 1
  `).get(current.sessionID, current.started, current.id)?.id
  const latest = latestID && latestID !== previousID ? ledger.getRequest(latestID) : undefined
  const lastReal = ledger.db.query<{ started: number }, [string, number]>(`
    select started from request where session_id = ? and started < ? and kind != 'ping' and is_title = 0
    order by started desc, rowid desc limit 1
  `).get(current.sessionID, current.started)?.started
  const baseline = ledger.db.query<{ started: number }, [string, number, number, string]>(`
    select started from request where session_id = ? and status = 'completed' and ended <= ?
      and (? = 0 or (kind != 'ping' and is_title = 0)) and id != ?
    order by started desc, rowid desc limit 1
  `).get(current.sessionID, current.started, current.kind !== "ping" && !current.isTitle ? 1 : 0, current.id)?.started
  const from = Math.min(current.started, previous?.started ?? Infinity, latest?.started ?? Infinity, lastReal ?? Infinity, baseline ?? Infinity)
  return { previous, latest, from }
}

/**
 * The whole-history fold's analysis of these requests (summary and detail),
 * from one fold per run of overlapping ranges they read: requests far apart in
 * a session (a report's top misses) never fold the history between them.
 */
export function requestAnalysis(ledger: Ledger, ids: readonly string[]) {
  const currents = ids.flatMap((id) => {
    const row = ledger.getRequest(id)
    return row ? [row] : []
  })
  const summaries = new Map<string, MonitorRequest>()
  const details = new Map<string, () => MonitorRequestDetail | undefined>()
  const fingerprints = new Map<string, RequestFingerprintData | undefined>()
  Map.groupBy(currents, (row) => row.sessionID).forEach((rows, session) => {
    const facts = ledger.getContextFacts(session)
    const runs = rows
      .map((row) => ({ row, from: anchorsOf(ledger, row).from }))
      .toSorted((a, b) => a.from - b.from)
      .reduce<{ from: number; to: number; rows: RequestRow[] }[]>((acc, span) => {
        const last = acc.at(-1)
        if (last === undefined || span.from > last.to) {
          acc.push({ from: span.from, to: span.row.started, rows: [span.row] })
          return acc
        }
        last.to = Math.max(last.to, span.row.started)
        last.rows.push(span.row)
        return acc
      }, [])
    runs.forEach((run) => {
      const range = ledger.getRequestsBetween(session, run.from, run.to)
      // As the whole fold reads them: a fingerprint recorded for another session is none.
      range.forEach((row) => {
        if (fingerprints.has(row.id)) return
        const fp = ledger.getFingerprint(row.id)
        fingerprints.set(row.id, fp?.sessionID === session ? fp : undefined)
      })
      const analysis = foldSession(range, facts.filter((fact) => fact.at <= run.to), fingerprints).analysis
      const analyzed = new Map(analysis.summaries.map((entry) => [entry.request.id, entry.request]))
      run.rows.forEach((row) => {
        const summary = analyzed.get(row.id)
        if (summary) summaries.set(row.id, summary)
        details.set(row.id, () => analysis.detail(row.id))
      })
    })
  })
  return { summary: (id: string) => summaries.get(id), detail: (id: string) => details.get(id)?.(), fingerprints }
}

/** Once per completed invocation, from the rows the whole fold reads for it (requestAnalysis), never a history fold. */
export function projectCacheResult(ledger: Ledger, id: string) {
  const current = ledger.getRequest(id)
  if (!current || current.ended === undefined) return
  const analyzed = requestAnalysis(ledger, [id])
  const detail = analyzed.detail(id)
  if (!detail) return
  const anchors = anchorsOf(ledger, current)
  const previous = anchors.previous
  const latest = anchors.latest
  const fingerprints = analyzed.fingerprints
  const wire = compareTranscripts(ledger, previous?.id, id)
  const diff = wire.diff
  const linked = previous && fingerprints.get(current.id)?.previousResponseId !== undefined &&
    fingerprints.get(current.id)?.previousResponseId === fingerprints.get(previous.id)?.responseId
  const previousFingerprint = previous ? fingerprints.get(previous.id) : undefined
  const boundary = previous?.kind === "ping" && previousFingerprint?.protocol === "anthropic-messages"
    ? markedMessageBoundary(previousFingerprint) : -1
  const privateTail = (field: string) => {
    const index = /^messages\[(\d+)\]/.exec(field)?.[1]
    return boundary >= 0 && index !== undefined && Number(index) > boundary
  }
  const warmingTail = diff?.changed.some(privateTail)
  const divergence = diff?.changed.find((field) => !privateTail(field) &&
    (!linked || (!field.startsWith("input[") && field !== "input" && field !== "previous_response_id")))
  const measured = detail.request.measurement
  const prior = previous?.observation?.inputTokens
  const increase = prior !== undefined && measured?.input !== undefined ? measured.input - prior : undefined
  const uncached = measured?.input !== undefined && measured.read !== undefined ? measured.input - measured.read : undefined
  const miss = detail.request.verdict === "miss" || detail.request.verdict === "partial"
  const knownCause = detail.request.cause && ["cache-expired", "account-changed", "account-changed-compacted-first", "revert", "instruction-update"].includes(detail.request.cause)
  const historicalChange = !diff && detail.segments.find((segment) =>
    !(segment.kind === "message" && segment.change === "added") &&
    !["option max_tokens", "option max_output_tokens", "option max_completion_tokens", "cache markers"].includes(segment.name))?.name
  // Nothing reads an expired cache: content that changed with it (a cold chat's instructions
  // rebase, its rebuilt pin) is listed below, not blamed.
  const expired = detail.request.cause === "cache-expired"
  const why = detail.request.verdict === "cold"
    ? latest ? "New history epoch or model; no reusable predecessor" : "First measured request in this history epoch"
    : expired ? detail.request.causeText
    : divergence ? `Sent content changed: ${divergence}`
    : knownCause ? detail.request.causeText
    : linked ? miss ? "Unknown upstream loss; linked continuation" : "Linked continuation"
    : warmingTail ? miss ? "Unknown upstream loss; warming tail replaced" : "Uncached warming tail replaced"
    : diff?.markers.length ? miss ? "Unknown loss; cache markers changed" : "Prompt appended; cache markers changed"
    : diff?.append ? miss ? "Unknown upstream loss; prefix unchanged" : "Sent prefix unchanged"
    : historicalChange ? `Recorded prefix change: ${historicalChange} (body unavailable)`
    : "Sent-body archive unavailable"
  const request: MonitorRequest = {
    ...detail.request,
    cause: !expired && (divergence || historicalChange) ? "prefix-changed" : knownCause || detail.request.verdict === "cold" ? detail.request.cause : "unknown",
    causeText: why,
    confidence: "unknown",
    evidence: `Read ${measured?.read ?? "unknown"}; baseline ${detail.request.expected ?? "unknown"}; shortfall ${detail.request.missTokens ?? "unknown"}. ${why}`,
  }
  const lines = [request.evidence!,
    `Provider inclusive input: ${measured?.input ?? "unknown"}; change from predecessor: ${increase ?? "unknown"}; uncached input: ${uncached ?? "unknown"}.`,
    ...(diff ? [`Appended ${diff.addedMessages} messages (${diff.addedChars} serialized characters; exact provider token count unavailable).`,
      ...diff.changed.slice(0, 16).map((field) => `${privateTail(field) ? "Uncached warming tail replaced" : linked ? "Changed transmitted delta field" : "Changed existing content"}: ${field}`),
      ...diff.markers.slice(0, 16).map((field) => `Cache hint changed (not new prompt text): ${field}`),
      ...(diff.changed.length > 16 ? [`${diff.changed.length - 16} more changes in saved transcripts.`] : []),
      ...(diff.options.length ? [`Generation-only changes: ${diff.options.join(", ")}`] : [])] : []),
    ...(increase !== undefined && uncached !== undefined ? [`Uncached input above net prompt growth: ${Math.max(0, uncached - Math.max(0, increase))} tokens. Net growth is measured; the provider does not attribute tokens to individual appended fields.`] : []),
    ...(wire.before && previous ? [`Previous sent body: ${previous.id} (Prompt tab)`] : []),
    ...(wire.after ? [`Current sent body: ${id} (Prompt tab)`] : []),
    ...(linked ? ["previous_response_id links to the predecessor's response. The expanded server-held history is not present in this wire body."] : []),
    "These are the exact bodies sent by Plus to the configured endpoint; downstream proxy transforms are not visible.",
    "A recorded difference is evidence, not proof that it caused the provider's cache loss.",
  ]
  const saved: MonitorRequestDetail = { ...detail, request, lines, segments: detail.segments.slice(0, 16), firstDivergence: divergence ?? detail.firstDivergence }
  const columns = CACHE_COLUMNS.map(([name]) => name)
  ledger.db.query(`insert into cache_result (request_id, session_id, started, verdict, summary, detail, fold, ${columns.join(", ")})
    values ($id, $session, $started, $verdict, $summary, $detail, $fold, ${cacheColumnValues("$summary").join(", ")})
    on conflict(request_id) do update set session_id = excluded.session_id, started = excluded.started, verdict = excluded.verdict,
      summary = excluded.summary, detail = excluded.detail, fold = excluded.fold, ${columns.map((name) => `${name} = excluded.${name}`).join(", ")}`)
    .run({
      $id: id,
      $session: current.sessionID,
      $started: current.started,
      $verdict: request.verdict,
      $summary: JSON.stringify(request),
      $detail: JSON.stringify(saved),
      $fold: JSON.stringify(Object.fromEntries(Object.entries(detail.request).filter(([key]) => FOLD_FIELDS.includes(key)))),
    })
}

/** Where a saved summary's wording (the cache screen's) differs from the fold's own, saved as `fold`. */
export const FOLD_FIELDS: readonly string[] = ["cause", "causeText", "confidence", "evidence"]

const backfills = new WeakMap<Ledger, ReturnType<typeof setTimeout>>()

export function stopCacheBackfill(ledger: Ledger) {
  clearTimeout(backfills.get(ledger))
  backfills.delete(ledger)
}

export function backfillCacheBatch(ledger: Ledger, limit = 16) {
  // Newest first: screens open on the latest requests, and every poll analyzes
  // the rows it shows again until they are saved. No result reads another.
  // Looking for missing results reads every request; counting them first does not.
  const missing = unsavedResults(ledger) === 0 ? [] : ledger.db.query<{ id: string }, [number]>(`select id from request
    where ended is not null and not exists (select 1 from cache_result where request_id = request.id) order by started desc limit ?`).all(limit)
  // Then results saved before their fold wording was (ledger.ts migration).
  const rows = missing.length < limit
    ? [...missing, ...ledger.db.query<{ id: string }, [number]>(`select request_id id from cache_result indexed by cache_result_unfolded
        where fold is null order by started desc limit ?`).all(limit - missing.length)]
    : missing
  rows.forEach((row) => projectCacheResult(ledger, row.id))
  return rows.length
}

const SETTLE_LIMIT = 16

/**
 * Before a read, save the few results of requests that ended moments ago, so
 * a screen never shows them as missing. A larger historical backlog stays
 * with the background backfill and is reported as pending.
 */
export function settleRecentResults(ledger: Ledger) {
  const pending = unsavedResults(ledger)
  if (pending > 0 && pending <= SETTLE_LIMIT) backfillCacheBatch(ledger, SETTLE_LIMIT)
}

/** Ended requests without a saved result: a result is saved once a request ends and pruned with it. */
function unsavedResults(ledger: Ledger) {
  return ledger.db.query<{ n: number }, []>(`select
    (select count(*) from request indexed by request_ended where ended is not null) - (select count(*) from cache_result) n`).get()!.n
}

/** Restart/backfill work is scheduled separately; screen reads never await it. */
export function scheduleCacheBackfill(ledger: Ledger) {
  if (backfills.has(ledger)) return
  const batch = () => {
    Effect.runSync(Effect.sync(() => {
      // Yield between historical requests so backfill cannot monopolize the
      // server while an open screen or a model stream needs to make progress.
      // Saved results first, then each request's changed segments, then the
      // unread tokens of writes whose lifetime has ended.
      const more = backfillCacheBatch(ledger, 1) > 0 || settleRequestChanges(ledger, 16) > 0 || settleUnreadWrites(ledger, Date.now(), 8) > 0
      if (more) backfills.set(ledger, setTimeout(batch, 25).unref())
      else backfills.delete(ledger)
    }).pipe(Effect.catchCause(() => {
      backfills.delete(ledger)
      return Effect.logWarning("Cache monitor background analysis failed; pending rows remain visible")
    })))
  }
  backfills.set(ledger, setTimeout(batch, 0).unref())
}

type Bindings = Record<string, string | number | null>
type Window = { since: number; until: number }

const MEASURED = "(kind != 'ping' and measured_state = 'reported' and measured_input is not null and measured_read is not null)"
// Every sum the monitor shows, from the covering-index columns only.
const TOTALS = `count(*) requests, coalesce(sum(input), 0) input, coalesce(sum(output), 0) output,
  coalesce(sum(reasoning), 0) reasoning, coalesce(sum(cache_read), 0) cacheRead, coalesce(sum(cache_write), 0) cacheWrite,
  coalesce(sum(cost), 0) cost, coalesce(sum(miss_tokens), 0) missTokens,
  coalesce(sum(verdict in ('miss', 'partial')), 0) misses, coalesce(sum(verdict = 'cold'), 0) coldRequests,
  coalesce(sum(verdict in ('miss', 'partial') and miss_cost is not null), 0) pricedMisses,
  coalesce(sum(case when verdict in ('miss', 'partial') then miss_cost else 0 end), 0) missCost,
  coalesce(sum(case when verdict = 'cold' then measured_input else 0 end), 0) coldTokens,
  coalesce(sum(kind = 'step'), 0) steps, coalesce(sum(kind in ('step', 'compaction')), 0) work,
  coalesce(sum(outcome = 'error'), 0) errors, coalesce(sum(kind != 'ping'), 0) useful,
  coalesce(sum(${MEASURED}), 0) measuredRequests,
  coalesce(sum(case when ${MEASURED} then measured_input else 0 end), 0) measuredInput,
  coalesce(sum(case when ${MEASURED} then measured_read else 0 end), 0) measuredRead,
  coalesce(max(started), 0) last`

interface Sums {
  requests: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  missTokens: number
  misses: number
  coldRequests: number
  pricedMisses: number
  missCost: number
  coldTokens: number
  steps: number
  work: number
  errors: number
  useful: number
  measuredRequests: number
  measuredInput: number
  measuredRead: number
  last: number
}

/** Every saved result a request report lists, transport-only exchange rows included. */
export function savedRequestFilter(input: MonitorQueryInput, context: QueryContext, window: Window) {
  return savedFilter(input, context, window, "cache_result", true)
}

/** The saved results a query reads, as a filter over `cache_result` under `alias`. */
function savedFilter(input: MonitorQueryInput, context: QueryContext, window: Window, alias = "cache_result", exchange = false) {
  const scope = scopeOf(input, context)
  const list = (column: string, name: string, values: readonly string[] | undefined) =>
    values?.length
      ? { sql: `and ${column} in (${values.map((_, index) => `$${name}${index}`).join(", ")})`, bindings: Object.fromEntries(values.map((value, index) => [`$${name}${index}`, value])) }
      : { sql: "", bindings: {} }
  const agents = list(`${alias}.agent`, "agent", input.agents)
  const models = list(`${alias}.model`, "model", input.models)
  return {
    cte: scope.cte,
    where: `${alias}.started >= $since and ${alias}.started < $until ${exchange ? "" : `and ${alias}.exchange = 0`}
      ${scope.cte ? `and ${alias}.session_id in (select id from scope)` : ""}
      ${input.sinceCompaction ? `and ${alias}.started >= coalesce((select max(at) from context_fact where session_id = ${alias}.session_id and kind = 'compaction' and at < $until), 0)` : ""}
      ${agents.sql} ${models.sql} ${input.titles ? "" : `and ${alias}.kind != 'title'`}`,
    bindings: { ...scope.bindings, ...agents.bindings, ...models.bindings, $since: window.since, $until: window.until } as Bindings,
  }
}

function totalsOf(sums: Sums) {
  return {
    requests: sums.requests,
    steps: sums.steps,
    errors: sums.errors,
    input: sums.input,
    output: sums.output,
    reasoning: sums.reasoning,
    cacheRead: sums.cacheRead,
    cacheWrite: sums.cacheWrite,
    cost: sums.cost,
    misses: sums.misses,
    missTokens: sums.missTokens,
    coldRequests: sums.coldRequests,
    coldTokens: sums.coldTokens,
    // A priced subset is never presented as the complete miss cost.
    ...(sums.pricedMisses === sums.misses ? { missCost: sums.missCost } : {}),
    ...(sums.measuredInput > 0 ? { hitRate: sums.measuredRead / sums.measuredInput } : {}),
    measuredRequests: sums.measuredRequests,
    unknownRequests: sums.useful - sums.measuredRequests,
    measuredInput: sums.measuredInput,
  }
}

/** Per-session sums of the saved results in scope. */
export function savedSessionSums(ledger: Ledger, input: MonitorQueryInput, context: QueryContext, window: Window) {
  const filter = savedFilter(input, context, window, "c")
  return new Map(ledger.db.query<Sums & { id: string }, Bindings>(`${filter.cte}
    select c.session_id id, ${TOTALS} from cache_result c where ${filter.where} group by c.session_id`).all(filter.bindings)
    .map((row) => [row.id, row]))
}

/**
 * Totals and warming follow-ups of the saved results in scope: index-only
 * reads. Per-session sums, when the caller already has them, add up instead.
 */
export function savedTotals(ledger: Ledger, input: MonitorQueryInput, context: QueryContext, window: Window, bySession?: ReadonlyMap<string, Sums>) {
  const filter = savedFilter(input, context, window)
  const sums = bySession
    ? [...bySession.values()].reduce<Sums>((total, row) => Object.fromEntries(Object.keys(total).map((key) => {
        const name = key as keyof Sums
        return [name, name === "last" ? Math.max(total.last, row.last) : total[name] + row[name]]
      })) as unknown as Sums, { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, missTokens: 0, misses: 0, coldRequests: 0, pricedMisses: 0, missCost: 0, coldTokens: 0, steps: 0, work: 0, errors: 0, useful: 0, measuredRequests: 0, measuredInput: 0, measuredRead: 0, last: 0 })
    : ledger.db.query<Sums, Bindings>(`${filter.cte} select ${TOTALS} from cache_result where ${filter.where}`).get(filter.bindings)!
  const ping = savedFilter(input, context, window, "p")
  const pingRows = ledger.db.query<{ verdict: string | null; cost: number }, Bindings>(`${ping.cte}
    select (select coalesce(result.verdict, 'unknown') from request next left join cache_result result on result.request_id = next.id
      where next.session_id = p.session_id and next.started >= r.ended and next.started < $until
        and next.id != r.id and next.kind != 'ping' and next.is_title = 0
        and coalesce(json_extract(next.observation, '$.scope'), '') != 'exchange'
      order by next.started, next.id limit 1) verdict, p.cost cost
    from cache_result p join request r on r.id = p.request_id where ${ping.where} and p.kind = 'ping'`).all(ping.bindings)
  const pings = { sent: pingRows.length, cost: 0, followedByHit: 0, followedByMiss: 0, followedByCold: 0, unused: 0, unknown: 0, unknownReasons: {} as Record<string, number> }
  pingRows.forEach((row) => {
    pings.cost += row.cost
    if (row.verdict === null) pings.unused++
    else if (row.verdict === "hit") pings.followedByHit++
    else if (row.verdict === "cold") pings.followedByCold++
    else if (row.verdict === "miss" || row.verdict === "partial") pings.followedByMiss++
    else pings.unknown++
  })
  if (pings.unknown) pings.unknownReasons["follow-up measurement unavailable"] = pings.unknown
  return { totals: { ...totalsOf(sums), pings: pings.sent, pingCost: pings.cost }, pings, filter }
}

interface LegacySums {
  id: string
  steps: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  last: number
}

/** v1 steps recorded before request rows existed; they count in token totals only. */
export function legacySteps(ledger: Ledger, input: MonitorQueryInput, context: QueryContext, window: Window) {
  const scope = scopeOf(input, context)
  const list = (column: string, name: string, values: readonly string[] | undefined) =>
    values?.length
      ? { sql: `and ${column} in (${values.map((_, index) => `$${name}${index}`).join(", ")})`, bindings: Object.fromEntries(values.map((value, index) => [`$${name}${index}`, value])) }
      : { sql: "", bindings: {} }
  const agents = list("s.agent", "agent", input.agents)
  const models = list("(s.provider || '/' || s.model)", "model", input.models)
  return new Map(ledger.db.query<LegacySums, Bindings>(`${scope.cte}
    select s.session_id id, count(*) steps, sum(s.input) input, sum(s.output) output, sum(s.reasoning) reasoning,
      sum(s.cache_read) cacheRead, sum(s.cache_write) cacheWrite, sum(s.cost) cost, max(s.started) last
    from step s where s.started >= $since and s.started < $until ${scope.cte ? "and s.session_id in (select id from scope)" : ""}
      ${input.sinceCompaction ? "and s.started >= coalesce((select max(at) from context_fact where session_id = s.session_id and kind = 'compaction' and at < $until), 0)" : ""}
      ${agents.sql} ${models.sql}
      and not exists (select 1 from request r where r.session_id = s.session_id and r.message_id = s.message_id)
    group by s.session_id`).all({ ...scope.bindings, ...agents.bindings, ...models.bindings, $since: window.since, $until: window.until })
    .map((row) => [row.id, row]))
}

/** Every session in scope with its saved totals in the window, ordered as trees. */
export function savedSessions(
  ledger: Ledger,
  input: MonitorQueryInput,
  context: QueryContext,
  window: Window,
  legacy = legacySteps(ledger, input, context, window),
  sums = savedSessionSums(ledger, input, context, window),
) {
  const scope = scopeOf(input, context)
  const sessions = ledger.db.query<{ id: string; parent_id: string | null; title: string | null; agent: string | null; run_id: string | null; role: string | null; team: string | null; last_seen: number }, Bindings>(
    `${scope.cte} select id, parent_id, title, agent, run_id, role, team, last_seen from session ${scope.cte ? "where id in (select id from scope)" : ""}`,
  ).all(scope.bindings)
  const rows = sessions.map((session): MonitorSessionRow => {
    const base = sums.get(session.id)
    const old = legacy.get(session.id)
    const agent = context.agents?.get(session.id) ?? session.agent
    const total = (key: "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite" | "cost") => (base?.[key] ?? 0) + (old?.[key] ?? 0)
    return {
      sessionID: session.id,
      rootID: session.id,
      depth: 0,
      ...(session.parent_id ? { parentID: session.parent_id } : {}),
      ...(session.title ? { title: session.title } : {}),
      ...(agent ? { agent } : {}),
      ...(session.run_id ? { runID: session.run_id } : {}),
      ...(session.role ? { role: session.role } : {}),
      ...(session.team ? { team: session.team } : {}),
      ...(context.states?.get(session.id) === undefined ? {} : { state: context.states.get(session.id)! }),
      lastActive: Math.max(base?.last ?? 0, old?.last ?? 0) || session.last_seen,
      input: total("input"),
      output: total("output"),
      reasoning: total("reasoning"),
      cacheRead: total("cacheRead"),
      cacheWrite: total("cacheWrite"),
      cost: total("cost"),
      ...((base?.measuredInput ?? 0) > 0 ? { hitRate: base!.measuredRead / base!.measuredInput } : {}),
      measuredRequests: base?.measuredRequests ?? 0,
      unknownRequests: (base?.useful ?? 0) - (base?.measuredRequests ?? 0) + (old?.steps ?? 0),
      measuredInput: base?.measuredInput ?? 0,
      requests: base?.requests ?? 0,
      steps: (base?.work ?? 0) + (old?.steps ?? 0),
      misses: base?.misses ?? 0,
    }
  })
  return orderSessions(rows)
}

/**
 * Roots by their tree's latest activity, each followed by its descendants
 * (newest first). Cyclic or orphaned placement stays reachable at the end.
 */
export function orderSessions(rows: readonly MonitorSessionRow[]): MonitorSessionRow[] {
  const byID = new Map(rows.map((row) => [row.sessionID, row]))
  const place = new Map<string, { rootID: string; depth: number }>()
  const placement = (id: string) => {
    const chain: string[] = []
    const seen = new Set<string>()
    let parent: string | undefined = id
    while (parent && !place.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      chain.push(parent)
      parent = byID.get(parent)?.parentID
    }
    const known = parent ? place.get(parent) : undefined
    const rootID = known?.rootID ?? parent ?? chain.at(-1)!
    chain.toReversed().forEach((key, index) => place.set(key, { rootID, depth: (known?.depth ?? -1) + index + 1 }))
    return place.get(id)!
  }
  const placed = rows.map((row) => ({ ...row, ...placement(row.sessionID) }))
  const children = new Map<string, MonitorSessionRow[]>()
  const latest = new Map<string, number>()
  placed.forEach((row) => {
    latest.set(row.rootID, Math.max(latest.get(row.rootID) ?? 0, row.lastActive))
    if (!row.parentID || !byID.has(row.parentID)) return
    children.set(row.parentID, [...(children.get(row.parentID) ?? []), row])
  })
  children.forEach((list) => list.sort((a, b) => b.lastActive - a.lastActive || a.sessionID.localeCompare(b.sessionID)))
  const ordered: MonitorSessionRow[] = []
  const visited = new Set<string>()
  const visit = (row: MonitorSessionRow) => {
    if (visited.has(row.sessionID)) return
    visited.add(row.sessionID)
    ordered.push(row)
    children.get(row.sessionID)?.forEach(visit)
  }
  placed
    .filter((row) => !row.parentID || !byID.has(row.parentID))
    .sort((a, b) => (latest.get(b.rootID) ?? 0) - (latest.get(a.rootID) ?? 0) || a.sessionID.localeCompare(b.sessionID))
    .forEach(visit)
  placed.filter((row) => !visited.has(row.sessionID)).sort((a, b) => a.sessionID.localeCompare(b.sessionID)).forEach(visit)
  return ordered
}

const memo = new WeakMap<Ledger, Map<string, { revision: string; report: MonitorReport }>>()

/**
 * SQL aggregates and one page of small results; no transcript or fingerprint
 * IO. An open-ended read at an unchanged ledger revision returns the previous
 * answer, so polling an idle screen costs one revision lookup.
 */
export function queryCacheResults(ledger: Ledger, input: MonitorQueryInput, context: QueryContext = {}): MonitorReport {
  const now = context.now ?? Date.now()
  settleRecentResults(ledger)
  const key = input.until === undefined && input.compare === undefined ? JSON.stringify([input, context.directory]) : undefined
  const revision = ledger.revision()
  const cache = memo.get(ledger) ?? new Map<string, { revision: string; report: MonitorReport }>()
  memo.set(ledger, cache)
  const hit = key === undefined ? undefined : cache.get(key)
  if (hit?.revision === revision) return { ...hit.report, now }
  const report = readCacheResults(ledger, input, context, now)
  if (key === undefined) return report
  cache.delete(key)
  cache.set(key, { revision, report })
  if (cache.size > 16) cache.delete(cache.keys().next().value!)
  return report
}

function readCacheResults(ledger: Ledger, input: MonitorQueryInput, context: QueryContext, now: number): MonitorReport {
  const scope = scopeOf(input, context)
  const saved = savedTotals(ledger, input, context, { since: input.since ?? 0, until: input.until ?? now + 1 })
  const limit = Math.min(500, Math.max(1, input.requestPage?.limit ?? 100))
  const cursor = input.requestPage?.cursor
  const newer = input.requestPage?.direction === "newer"
  const filter = `${saved.filter.where} ${input.missesOnly ? "and verdict in ('miss', 'partial', 'cold')" : ""} ${input.errors ? "and outcome = 'error'" : ""}`
  const bindings = saved.filter.bindings
  const page = ledger.db.query<{ summary: string }, Bindings>(`${scope.cte}
    select summary from cache_result where ${filter}
    ${cursor ? `and (started, request_id) ${newer ? ">" : "<"} ($at, $id)` : ""}
    order by started ${newer ? "asc" : "desc"}, request_id ${newer ? "asc" : "desc"} limit $limit`)
    .all({ ...bindings, $limit: limit, ...(cursor ? { $at: cursor.at, $id: cursor.id } : {}) })
  const total = ledger.db.query<{ n: number }, Bindings>(`${scope.cte} select count(*) n from cache_result where ${filter}`).get(bindings)!.n
  const requests = page.map((row): MonitorRequest => JSON.parse(row.summary)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  const edge = (direction: "older" | "newer") => {
    const row = direction === "older" ? requests[0] : requests.at(-1)
    if (!row) return
    const exists = ledger.db.query<{ found: number }, Bindings>(`${scope.cte} select 1 found from cache_result
      where ${filter} and (started, request_id) ${direction === "older" ? "<" : ">"} ($at, $id) limit 1`).get({ ...bindings, $at: row.at, $id: row.id })
    return exists ? { at: row.at, id: row.id } : undefined
  }
  const detailRow = input.id
    ? ledger.db.query<{ detail: string }, Bindings>(`${scope.cte} select detail from cache_result where request_id = $request
        ${scope.cte ? "and session_id in (select id from scope)" : ""}`).get({ ...scope.bindings, $request: input.id })
    : undefined
  // Only the session picker reads the session list.
  const listed = input.view === "sessions"
  const sessionLimit = Math.min(500, Math.max(1, input.pages?.sessions?.limit ?? 100))
  const offset = input.pages?.sessions?.cursor?.offset ?? 0
  const sessionScope = scope.cte ? "where s.id in (select id from scope)" : ""
  const sessions = !listed ? [] : ledger.db.query<{ id: string; title: string | null; agent: string | null; last_seen: number; parent_id: string | null } & Sums, Bindings>(`${scope.cte}
    select s.id, s.title, s.agent, s.last_seen, s.parent_id,
      (select count(*) from cache_result c where c.session_id = s.id and c.exchange = 0) requests,
      (select coalesce(sum(c.kind = 'step'), 0) from cache_result c where c.session_id = s.id and c.exchange = 0) steps,
      (select coalesce(sum(c.input), 0) from cache_result c where c.session_id = s.id) input,
      (select coalesce(sum(c.cache_read), 0) from cache_result c where c.session_id = s.id) cacheRead
    from session s ${sessionScope}
    order by s.last_seen desc, s.id limit ${sessionLimit} offset ${offset}`).all(scope.bindings)
    .map((row): MonitorSessionRow => ({
      sessionID: row.id, rootID: row.parent_id ?? row.id, depth: row.parent_id ? 1 : 0,
      ...(row.title ? { title: row.title } : {}), ...(row.agent ? { agent: row.agent } : {}),
      lastActive: row.last_seen, requests: row.requests ?? 0, steps: row.steps ?? 0, misses: row.misses ?? 0,
      input: row.input ?? 0, output: row.output ?? 0, reasoning: row.reasoning ?? 0, cacheRead: row.cacheRead ?? 0,
      cacheWrite: row.cacheWrite ?? 0, cost: row.cost ?? 0,
    }))
  const sessionCount = listed ? ledger.db.query<{ n: number }, Bindings>(`${scope.cte} select count(*) n from session s ${sessionScope}`).get(scope.bindings)!.n : 0
  const older = edge("older")
  const newerEdge = edge("newer")
  const comparison = input.compare ? queryCacheResults(ledger, { ...input, compare: undefined,
    since: input.compare.since ?? 0, until: input.compare.until ?? now + 1 }, context) : undefined
  const revision = "cache-sessions-v1"
  return {
    // A result is saved only for an ended request and is pruned with it.
    cachePending: ledger.db.query<{ n: number }, Bindings>(`${scope.cte} select max(0,
      (select count(*) from request indexed by request_ended where ended is not null ${scope.cte ? "and session_id in (select id from scope)" : ""})
      - (select count(*) from cache_result ${scope.cte ? "where session_id in (select id from scope)" : ""})) n`).get(scope.bindings)!.n,
    now,
    totals: { ...saved.totals, calls: 0, running: 0, callTokens: 0, resultTokens: 0, carried: 0 },
    pings: saved.pings,
    ...(comparison ? { compare: { totals: comparison.totals, groups: [] } } : {}),
    groups: [], feed: [], facets: { agents: [], tools: [], models: [] }, marks: [], requests,
    requestPage: { total, returned: requests.length, limit, complete: total <= requests.length,
      ...(older ? { older } : {}), ...(newerEdge ? { newer: newerEdge } : {}) },
    ...(listed ? { sessions, pages: { sessions: { total: sessionCount, returned: sessions.length, limit: sessionLimit, offset, revision, reset: false, complete: sessionCount <= sessions.length,
      ...(offset > 0 ? { previous: { offset: Math.max(0, offset - sessionLimit), revision } } : {}),
      ...(offset + sessions.length < sessionCount ? { next: { offset: offset + sessionLimit, revision } } : {}) } } } : {}),
    ...(detailRow ? { detail: JSON.parse(detailRow.detail) as MonitorRequestDetail } : {}),
  }
}
