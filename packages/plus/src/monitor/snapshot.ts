import fs from "node:fs"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { Effect, Schema } from "effect"
import type { MonitorQueryInput, MonitorReport, MonitorRequest, MonitorRequestDetail, MonitorSessionRow, MonitorTotals } from "../rpc.js"
import { foldSession, markedMessageBoundary } from "./cache.js"
import { sha256 } from "./fingerprint.js"
import type { ContextFactRow, Ledger } from "./ledger.js"
import { scopeOf, type QueryContext } from "./query.js"

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
 * Only top-level generation budgets are separated from prompt changes. Object
 * key order is JSON noise; array order and string bytes are never normalized.
 */
export function compareWire(before: string, after: string): WireDiff {
  const a = decodeWire(before)
  const b = decodeWire(after)
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
    if (["max_tokens", "max_output_tokens", "max_completion_tokens"].includes(key) ||
      (onDemand && (key === "compaction" || (key === "context_management" && a[key] == null && b[key] === null)))) {
      if (a[key] !== b[key]) options.push(key)
      continue
    }
    visit(a[key], b[key], key)
  }
  return { append: changed.length === 0, addedMessages: additions.messages, addedChars: additions.chars, changed, first: changed[0], options, markers }
}

/** Called by the final transport observer, after every request transform. */
export async function captureWire(ledger: Ledger, id: string, body: string) {
  const directory = `${ledger.path}.transcripts`
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${sha256(id)}.json.gz`)
  await fs.promises.writeFile(file, Bun.gzipSync(body), { mode: 0o600 })
  ledger.db.query("insert into cache_wire values (?, ?) on conflict(request_id) do update set path = excluded.path").run(id, file)
}

function transcript(ledger: Ledger, id: string) {
  const stored = ledger.db.query<{ path: string }, [string]>("select path from cache_wire where request_id = ?").get(id)
  if (!stored || !fs.existsSync(stored.path)) return
  return { path: stored.path, body: gunzipSync(fs.readFileSync(stored.path)).toString() }
}

function compareTranscripts(ledger: Ledger, previous: string | undefined, id: string) {
  // A missing/corrupt diagnostic archive must never suppress measured detection.
  try {
    const before = previous ? transcript(ledger, previous) : undefined
    const after = transcript(ledger, id)
    return { before, after, diff: before && after ? compareWire(before.body, after.body) : undefined }
  } catch {
    return { before: undefined, after: undefined, diff: undefined }
  }
}

/** Once per completed invocation. Uses an indexed predecessor, never a history fold.
 * The existing pure detector/pricing implementation sees at most three requests.
 */
export function projectCacheResult(ledger: Ledger, id: string) {
  const current = ledger.getRequest(id)
  if (!current || current.ended === undefined) return
  const epoch = current.observation?.historyEpoch ?? null
  const previousID = ledger.db.query<{ id: string }, [string, string | null, string | null, string | null, number, string, string]>(`
    select id from request where session_id = ? and provider is ? and model is ?
      and json_extract(observation, '$.historyEpoch') is ? and ended <= ? and status = 'completed'
      and is_title = 0 and (kind != 'generate' or ? = 'generate') and id != ?
    order by ended desc, started desc, id desc limit 1
  `).get(current.sessionID, current.provider ?? null, current.model ?? null, epoch, current.started, current.kind, id)?.id
  const previous = previousID ? ledger.getRequest(previousID) : undefined
  const latestID = ledger.db.query<{ id: string }, [string, number, string]>(`
    select id from request where session_id = ? and ended <= ? and status = 'completed' and is_title = 0 and id != ?
    order by ended desc, started desc, id desc limit 1
  `).get(current.sessionID, current.started, id)?.id
  const latest = latestID && latestID !== previousID ? ledger.getRequest(latestID) : undefined
  const rows = [latest, previous, current].filter((r) => r !== undefined).sort((a, b) => a.started - b.started)
  const facts = ledger.db.query<{ id: number; session_id: string; at: number; kind: string; detail: string }, [string, number, number, string, number, string | null, string | null]>(`
    select * from context_fact where session_id = ? and at > ? and at <= ?
    union select * from context_fact where id = (select id from context_fact where session_id = ? and kind = 'pricing' and at <= ?
      and json_extract(detail, '$.provider') is ? and json_extract(detail, '$.model') is ? order by at desc limit 1)
  `).all(current.sessionID, previous?.started ?? current.started, current.started, current.sessionID, current.started, current.provider ?? null, current.model ?? null)
    .map((row): ContextFactRow => ({ id: row.id, sessionID: row.session_id, at: row.at, kind: row.kind, detail: JSON.parse(row.detail) }))
  const fingerprints = new Map(rows.map((r) => [r.id, ledger.getFingerprint(r.id)]))
  const analysis = foldSession(rows, facts, fingerprints).analysis
  const detail = analysis.detail(id)
  if (!detail) return
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
  const why = detail.request.verdict === "cold"
    ? latest ? "New history epoch or model; no reusable predecessor" : "First measured request in this history epoch"
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
    cause: divergence || historicalChange ? "prefix-changed" : knownCause || detail.request.verdict === "cold" ? detail.request.cause : "unknown",
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
    ...(wire.before ? [`Previous transcript: ${wire.before.path}`] : []),
    ...(wire.after ? [`Current transcript: ${wire.after.path}`] : []),
    ...(linked ? ["previous_response_id links to the predecessor's response. The expanded server-held history is not present in this wire body."] : []),
    "These are the exact bodies sent by Plus to the configured endpoint; downstream proxy transforms are not visible.",
    "A recorded difference is evidence, not proof that it caused the provider's cache loss.",
  ]
  const saved: MonitorRequestDetail = { ...detail, request, lines, segments: detail.segments.slice(0, 16), firstDivergence: divergence ?? detail.firstDivergence }
  ledger.db.query(`insert into cache_result values (?, ?, ?, ?, ?, ?) on conflict(request_id) do update set
    session_id = excluded.session_id, started = excluded.started, verdict = excluded.verdict, summary = excluded.summary, detail = excluded.detail`)
    .run(id, current.sessionID, current.started, request.verdict, JSON.stringify(request), JSON.stringify(saved))
}

const backfills = new WeakMap<Ledger, ReturnType<typeof setTimeout>>()

export function stopCacheBackfill(ledger: Ledger) {
  clearTimeout(backfills.get(ledger))
  backfills.delete(ledger)
}

export function backfillCacheBatch(ledger: Ledger, limit = 16) {
  const rows = ledger.db.query<{ id: string }, [number]>(`select id from request where ended is not null
    and not exists (select 1 from cache_result where request_id = request.id) order by started limit ?`).all(limit)
  rows.forEach((row) => projectCacheResult(ledger, row.id))
  return rows.length
}

/** Restart/backfill work is scheduled separately; screen reads never await it. */
export function scheduleCacheBackfill(ledger: Ledger) {
  if (backfills.has(ledger)) return
  const batch = () => {
    Effect.runSync(Effect.sync(() => {
      // Yield between historical requests so backfill cannot monopolize the
      // server while an open screen or a model stream needs to make progress.
      if (backfillCacheBatch(ledger, 1) > 0) backfills.set(ledger, setTimeout(batch, 25).unref())
      else backfills.delete(ledger)
    }).pipe(Effect.catchCause(() => {
      backfills.delete(ledger)
      return Effect.logWarning("Cache monitor background analysis failed; pending rows remain visible")
    })))
  }
  backfills.set(ledger, setTimeout(batch, 0).unref())
}

/** SQL aggregates and one page of small results. No transcript/fingerprint IO. */
export function queryCacheResults(ledger: Ledger, input: MonitorQueryInput, context: QueryContext = {}): MonitorReport {
  const now = context.now ?? Date.now()
  const scope = scopeOf(input, context)
  const bindings = { ...scope.bindings, $since: input.since ?? 0, $until: input.until ?? now + 1,
    $agents: JSON.stringify(input.agents ?? []), $models: JSON.stringify(input.models ?? []) }
  const where = `started >= $since and started < $until ${scope.cte ? "and session_id in (select id from scope)" : ""}
    ${input.sinceCompaction ? "and started >= coalesce((select max(at) from context_fact where session_id = cache_result.session_id and kind = 'compaction' and at < $until), 0)" : ""}
    and (json_array_length($agents) = 0 or json_extract(summary, '$.agent') in (select value from json_each($agents)))
    and (json_array_length($models) = 0 or json_extract(summary, '$.provider') || '/' || json_extract(summary, '$.model') in (select value from json_each($models)))
    ${input.titles ? "" : "and json_extract(summary, '$.kind') != 'title'"}
    and coalesce(json_extract(summary, '$.measurement.scope'), '') != 'exchange'`
  const fields = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cost", "missTokens"] as const
  const sums = ledger.db.query<Pick<MonitorTotals, typeof fields[number]> & { requests: number; misses: number; coldRequests: number; coldTokens: number; steps: number; errors: number; pricedMisses: number; missCost: number }, typeof bindings>(`${scope.cte} select count(*) requests,
    ${fields.map((field) => `coalesce(sum(json_extract(summary, '$.${field}')), 0) as ${field}`).join(",")},
    coalesce(sum(verdict in ('miss', 'partial')), 0) misses, coalesce(sum(verdict = 'cold'), 0) coldRequests,
    coalesce(sum(verdict in ('miss', 'partial') and json_type(summary, '$.missCost') is not null), 0) pricedMisses,
    coalesce(sum(case when verdict in ('miss', 'partial') then json_extract(summary, '$.missCost') else 0 end), 0) missCost,
    coalesce(sum(case when verdict = 'cold' then json_extract(summary, '$.measurement.input') else 0 end), 0) coldTokens,
    coalesce(sum(json_extract(summary, '$.kind') = 'step'), 0) steps,
    coalesce(sum(json_extract(summary, '$.outcome') = 'error'), 0) errors
    from cache_result where ${where}`).get(bindings)!
  const limit = Math.min(500, Math.max(1, input.requestPage?.limit ?? 100))
  const cursor = input.requestPage?.cursor
  const newer = input.requestPage?.direction === "newer"
  const filter = `${where} ${input.missesOnly ? "and verdict in ('miss', 'partial', 'cold')" : ""} ${input.errors ? "and json_extract(summary, '$.outcome') = 'error'" : ""}`
  const page = ledger.db.query<{ summary: string; started: number; request_id: string }, Record<string, string | number>>(`${scope.cte}
    select summary, started, request_id from cache_result where ${filter}
    ${cursor ? `and (started, request_id) ${newer ? ">" : "<"} ($at, $id)` : ""}
    order by started ${newer ? "asc" : "desc"}, request_id ${newer ? "asc" : "desc"} limit $limit`)
    .all({ ...bindings, $limit: limit, ...(cursor ? { $at: cursor.at, $id: cursor.id } : {}) })
  const total = ledger.db.query<{ n: number }, typeof bindings>(`${scope.cte} select count(*) n from cache_result where ${filter}`).get(bindings)!.n
  const requests = page.map((row): MonitorRequest => JSON.parse(row.summary)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  const edge = (direction: "older" | "newer") => {
    const row = direction === "older" ? requests[0] : requests.at(-1)
    if (!row) return
    const exists = ledger.db.query<{ found: number }, Record<string, string | number>>(`${scope.cte} select 1 found from cache_result
      where ${filter} and (started, request_id) ${direction === "older" ? "<" : ">"} ($at, $id) limit 1`).get({ ...bindings, $at: row.at, $id: row.id })
    return exists ? { at: row.at, id: row.id } : undefined
  }
  const detailRow = input.id ? ledger.db.query<{ detail: string }, Record<string, string | number>>(`${scope.cte} select detail from cache_result where ${where} and request_id = $id`).get({ ...bindings, $id: input.id }) : undefined
  const sessionLimit = Math.min(500, Math.max(1, input.pages?.sessions?.limit ?? 100))
  const offset = input.pages?.sessions?.cursor?.offset ?? 0
  const sessionScope = scope.cte ? "where s.id in (select id from scope)" : ""
  const sessions = ledger.db.query<{ id: string; title: string | null; agent: string | null; last_seen: number; parent_id: string | null; totals: string }, typeof scope.bindings>(`${scope.cte}
    select s.id, s.title, s.agent, s.last_seen, s.parent_id,
      (select json_object('requests', count(*), 'steps', coalesce(sum(json_extract(summary, '$.kind') = 'step'), 0),
        'misses', coalesce(sum(verdict in ('miss', 'partial')), 0),
        ${fields.filter((field) => field !== "missTokens").map((field) => `'${field}', coalesce(sum(json_extract(summary, '$.${field}')), 0)`).join(",")})
        from cache_result where session_id = s.id) totals
      from session s ${sessionScope}
    order by s.last_seen desc, s.id limit ${sessionLimit} offset ${offset}`).all(scope.bindings)
    .map((row): MonitorSessionRow => ({ ...JSON.parse(row.totals), sessionID: row.id, rootID: row.parent_id ?? row.id, depth: row.parent_id ? 1 : 0,
      ...(row.title ? { title: row.title } : {}), ...(row.agent ? { agent: row.agent } : {}),
      lastActive: row.last_seen }))
  const sessionCount = ledger.db.query<{ n: number }, typeof scope.bindings>(`${scope.cte} select count(*) n from session s ${sessionScope}`).get(scope.bindings)!.n
  const pingRows = ledger.db.query<{ verdict: string | null; cost: number }, typeof bindings>(`${scope.cte}
    select (select coalesce(result.verdict, 'unknown') from request next left join cache_result result on result.request_id = next.id
      where next.session_id = p.session_id and next.started >= r.ended and next.started < $until
        and next.id != r.id and next.kind != 'ping' and next.is_title = 0
        and coalesce(json_extract(next.observation, '$.scope'), '') != 'exchange'
      order by next.started, next.id limit 1) verdict, json_extract(p.summary, '$.cost') cost
    from (select * from cache_result where ${where} and json_extract(summary, '$.kind') = 'ping') p
    join request r on r.id = p.request_id`).all(bindings)
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
  const { pricedMisses, missCost, ...totals } = sums
  const older = edge("older")
  const newerEdge = edge("newer")
  const comparison = input.compare ? queryCacheResults(ledger, { ...input, compare: undefined,
    since: input.compare.since ?? 0, until: input.compare.until ?? now + 1 }, context) : undefined
  const revision = "cache-sessions-v1"
  return {
    cachePending: ledger.db.query<{ n: number }, typeof scope.bindings>(`${scope.cte} select count(*) n from request
      where ended is not null ${scope.cte ? "and session_id in (select id from scope)" : ""}
      and not exists (select 1 from cache_result where request_id = request.id)`).get(scope.bindings)!.n,
    now, totals: { ...totals, ...(pricedMisses === sums.misses ? { missCost } : {}),
      pings: pings.sent, pingCost: pings.cost, calls: 0, running: 0, callTokens: 0, resultTokens: 0, carried: 0 },
    pings,
    ...(comparison ? { compare: { totals: comparison.totals, groups: [] } } : {}),
    groups: [], feed: [], facets: { agents: [], tools: [], models: [] }, marks: [], requests, sessions,
    requestPage: { total, returned: requests.length, limit, complete: total <= requests.length,
      ...(older ? { older } : {}), ...(newerEdge ? { newer: newerEdge } : {}) },
    pages: { sessions: { total: sessionCount, returned: sessions.length, limit: sessionLimit, offset, revision, reset: false, complete: sessionCount <= sessions.length,
      ...(offset > 0 ? { previous: { offset: Math.max(0, offset - sessionLimit), revision } } : {}),
      ...(offset + sessions.length < sessionCount ? { next: { offset: offset + sessionLimit, revision } } : {}) } },
    ...(detailRow ? { detail: JSON.parse(detailRow.detail) as MonitorRequestDetail } : {}),
  }
}
