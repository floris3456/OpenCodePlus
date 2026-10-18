// Cache notices and the Sessions checklist: the two server-wide reads behind
// the monitor's notice stack and its Sessions tab. Both read the one ledger of
// this server, so every TUI, whatever folder it is in, sees the same answer.
import type { MonitorNotice, MonitorQueryInput, MonitorRequest, MonitorSessionList, MonitorSessionRow, MonitorSessionsInput, PlusSettings } from "../rpc.js"
import type { Ledger } from "./ledger.js"
import type { QueryContext } from "./query.js"
import { orderSessions, savedSessions, settleRecentResults } from "./snapshot.js"

const NOTICE_LIMIT = 50
// A long request ends well after it starts; the lifetime counts from its end.
const LONGEST_REQUEST = 3_600_000
// Dismissals outlive the longest notice lifetime, then are pruned.
const DISMISSED_FOR = 86_400_000

/** Misses and partial reuses that ended within the notice lifetime and nobody opened yet, newest first. */
export function queryNotices(ledger: Ledger, settings: PlusSettings, now = Date.now()): MonitorNotice[] {
  settleRecentResults(ledger)
  const since = now - settings.noticeMinutes * 60_000
  const rows = ledger.db
    .query<{ request_id: string; session_id: string; verdict: "miss" | "partial"; miss_tokens: number | null; summary: string; at: number; title: string | null; agent: string | null }, Record<string, string | number>>(`
      select c.request_id, c.session_id, c.verdict, c.miss_tokens, c.summary, max(c.started, coalesce(r.ended, c.started)) at, s.title, s.agent
      from cache_result c left join request r on r.id = c.request_id left join session s on s.id = c.session_id
      where c.verdict in (${settings.noticeKinds === "misses" ? "'miss'" : "'miss', 'partial'"})
        and c.started >= $earliest and c.kind not in ('ping', 'title') and c.exchange = 0
        and coalesce(c.miss_tokens, 0) >= $min
        and not exists (select 1 from notice_dismissed d where d.request_id = c.request_id)
      order by c.started desc, c.request_id desc limit ${NOTICE_LIMIT}`)
    .all({ $earliest: since - LONGEST_REQUEST, $min: settings.noticeMinTokens })
    .filter((row) => row.at >= since)
  const roots = rootsOf(ledger, rows.map((row) => row.session_id))
  return rows
    .map((row): MonitorNotice => {
      const request: MonitorRequest = JSON.parse(row.summary)
      return {
        requestID: row.request_id,
        sessionID: row.session_id,
        rootID: roots.get(row.session_id) ?? row.session_id,
        ...(row.title ? { title: row.title } : {}),
        ...((row.agent ?? request.agent) ? { agent: row.agent ?? request.agent } : {}),
        ...(request.model ? { model: request.model } : {}),
        verdict: row.verdict,
        missTokens: row.miss_tokens ?? 0,
        causeText: request.causeText ?? request.cause ?? "unknown cause",
        at: row.at,
      }
    })
    .toSorted((a, b) => b.at - a.at || b.requestID.localeCompare(a.requestID))
}

/** Hides a notice from every TUI of this server. */
export function dismissNotice(ledger: Ledger, requestID: string, now = Date.now()) {
  ledger.db.transaction(() => {
    ledger.db.query("insert into notice_dismissed (request_id, at) values (?, ?) on conflict(request_id) do nothing").run(requestID, now)
    ledger.db.query("delete from notice_dismissed where at < ?").run(now - DISMISSED_FOR)
  })()
}

/**
 * Every session of the ledger as trees, a page of roots at a time. Without
 * `all`, only active sessions and the sessions above them are listed; the tree
 * of `first` is always listed, and listed first. Each root carries how many
 * listed sessions sit below it; those of an expanded root follow it.
 */
export function sessionChecklist(
  ledger: Ledger,
  input: MonitorSessionsInput,
  context: QueryContext & { readonly active: ReadonlySet<string> },
): MonitorSessionList {
  const known = ledger.db
    .query<{ id: string; parent_id: string | null; last_seen: number }, []>("select id, parent_id, last_seen from session")
    .all()
  const placed = orderSessions(
    known.map((row) => ({
      sessionID: row.id,
      rootID: row.id,
      depth: 0,
      ...(row.parent_id ? { parentID: row.parent_id } : {}),
      lastActive: row.last_seen,
      requests: 0, steps: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, misses: 0,
    })),
  )
  const byID = new Map(placed.map((row) => [row.sessionID, row]))
  const firstRoot = input.first === undefined ? undefined : (byID.get(input.first)?.rootID ?? input.first)
  const listed = new Set(input.all ? placed.map((row) => row.sessionID) : [])
  if (!input.all)
    placed
      .filter((row) => context.active.has(row.sessionID) || row.rootID === firstRoot)
      .forEach((row) => {
        // Keep the sessions above an active one, so its tree stays whole.
        const visit = (id: string | undefined): void => {
          if (id === undefined || listed.has(id)) return
          listed.add(id)
          visit(byID.get(id)?.parentID)
        }
        visit(row.sessionID)
      })
  const kept = placed.filter((row) => listed.has(row.sessionID))
  const roots = [
    ...kept.filter((row) => row.depth === 0 && row.sessionID === firstRoot),
    ...kept.filter((row) => row.depth === 0 && row.sessionID !== firstRoot),
  ]
  const limit = Math.min(500, Math.max(1, input.page?.limit ?? 100))
  const offset = Math.max(0, input.page?.offset ?? 0)
  // Any session of a tree expands its root, so a client can name the chat it shows.
  const expanded = new Set((input.expanded ?? []).map((id) => byID.get(id)?.rootID ?? id))
  const below = Map.groupBy(
    kept.filter((row) => row.depth > 0),
    (row) => row.rootID,
  )
  const page = roots.slice(offset, offset + limit).flatMap((root) => [
    { id: root.sessionID, descendants: below.get(root.sessionID)?.length ?? 0 },
    ...(expanded.has(root.sessionID) ? (below.get(root.sessionID) ?? []).map((row) => ({ id: row.sessionID })) : []),
  ])
  const query: MonitorQueryInput = {
    scope: "session",
    sessionIDs: page.map((entry) => entry.id),
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
  }
  const rows = new Map(
    savedSessions(ledger, query, context, { since: input.since ?? 0, until: input.until ?? (context.now ?? Date.now()) + 1 }).map((row) => [row.sessionID, row]),
  )
  return {
    sessions: page.flatMap((entry): MonitorSessionRow[] => {
      const row = rows.get(entry.id)
      const place = byID.get(entry.id)
      if (row === undefined || place === undefined) return []
      return [{
        ...row,
        rootID: place.rootID,
        depth: place.depth,
        active: context.active.has(entry.id),
        ...("descendants" in entry ? { descendants: entry.descendants } : {}),
      }]
    }),
    roots: roots.length,
    offset,
    limit,
    inactive: known.length - kept.length,
  }
}

/** Each session's topmost ancestor in the ledger. */
function rootsOf(ledger: Ledger, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, string>()
  return new Map(
    ledger.db
      .query<{ id: string; root: string }, [string]>(`
        with recursive up(id, at, parent) as (
          select s.id, s.id, s.parent_id from session s where s.id in (select value from json_each(?))
          union select up.id, p.id, p.parent_id from up join session p on p.id = up.parent
        )
        select id, at root from up where parent is null or parent not in (select id from session)`)
      .all(JSON.stringify([...new Set(ids)]))
      .map((row) => [row.id, row.root]),
  )
}
