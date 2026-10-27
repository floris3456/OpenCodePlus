// Each request's changed prompt segments, saved once, so unstable-prefix
// streaks replay from stored rows instead of folding whole session histories.
// A row's changed names depend only on itself and the latest earlier real
// request, which is why settling them in any order gives the same answer as
// the fold.
import { prefixDiff } from "./cache.js"
import type { Ledger, RequestFingerprintData } from "./ledger.js"

const ready = new WeakSet<Ledger>()

function ensureTable(ledger: Ledger) {
  if (ready.has(ledger)) return
  ledger.db.exec(`create table if not exists request_change (
  request_id text primary key,
  session_id text not null,
  started integer not null,
  real integer not null,
  changed text not null
);
create index if not exists request_change_session on request_change(session_id, started);`)
  ready.add(ledger)
}

// The fold's `diffOf(lastRealFp, fp)`: the session order, not the service
// order, decides which segments a request changed.
function changedNames(before: RequestFingerprintData | undefined, after: RequestFingerprintData | undefined): readonly string[] {
  if (!before || !after) return []
  return prefixDiff(before, after, false).changes
    .filter((change) => change.change === "changed")
    .map((change) => change.name)
}

/**
 * Saves a request_change row for up to `limit` requests that have none yet and
 * returns how many rows were written. Every request gets a row, real or not;
 * `changed` is `[]` for anything that is not a real row.
 */
export function settleRequestChanges(ledger: Ledger, limit = 256): number {
  ensureTable(ledger)
  const pending = ledger.db
    .query<{ id: string; session_id: string; started: number; rowid: number }, [number]>(
      // Oldest first across sessions, so a long session never starves the rest.
      // This order is also each session's own order, so a batch always takes a
      // prefix of that session's unsettled rows: its predecessor is settled.
      `select r.id as id, r.session_id as session_id, r.started as started, r.rowid as rowid from request r
        where not exists (select 1 from request_change c where c.request_id = r.id)
        order by r.started asc, r.rowid asc limit ?`,
    )
    .all(limit)
  if (pending.length === 0) return 0
  const first = new Map<string, { started: number; rowid: number; ids: Set<string>; lastStarted: number; lastRowid: number }>()
  for (const row of pending) {
    const entry = first.get(row.session_id)
    if (entry) {
      entry.ids.add(row.id)
      entry.lastStarted = row.started
      entry.lastRowid = row.rowid
      continue
    }
    first.set(row.session_id, {
      started: row.started,
      rowid: row.rowid,
      ids: new Set([row.id]),
      lastStarted: row.started,
      lastRowid: row.rowid,
    })
  }
  // Same rows and order as `getRequests`: started, then insertion order. The
  // range stops at the session's last unsettled row, so a batch never walks
  // the settled tail.
  const rows = ledger.db.query<{ id: string; kind: string; is_title: number; started: number }, [string, number, number, number, number, number, number]>(
    `select id, kind, is_title, started from request where session_id = ?
      and (started > ? or (started = ? and rowid >= ?)) and (started < ? or (started = ? and rowid <= ?))
      order by started asc, rowid asc`,
  )
  // Everything before a session's earliest unsettled row is settled, so the
  // predecessor real request comes from the saved rows: never rescan history.
  // Each lookup walks the (session_id, started) index backwards and stops.
  const earlierReal = ledger.db.query<{ request_id: string }, [string, number]>(
    `select request_id from request_change where session_id = ? and real = 1 and started < ?
      order by started desc limit 1`,
  )
  const earlierRealAtSameStart = ledger.db.query<{ request_id: string }, [string, number, number]>(
    `select c.request_id as request_id from request_change c join request r on r.id = c.request_id
      where c.session_id = ? and c.real = 1 and c.started = ? and r.rowid < ? order by r.rowid desc limit 1`,
  )
  const insert = ledger.db.query<unknown, [string, string, number, number, string]>(
    `insert into request_change (request_id, session_id, started, real, changed) values (?, ?, ?, ?, ?)
      on conflict(request_id) do nothing`,
  )
  return ledger.db.transaction(() => {
    let settled = 0
    for (const [sessionID, entry] of first) {
      // The fold reads a fingerprint only when it belongs to this session, so a
      // moved request's stale row is undefined here too.
      const fingerprint = (requestID: string) => {
        const fp = ledger.getFingerprint(requestID)
        return fp?.sessionID === sessionID ? fp : undefined
      }
      const predecessor = earlierRealAtSameStart.get(sessionID, entry.started, entry.rowid) ?? earlierReal.get(sessionID, entry.started)
      let lastReal = predecessor ? fingerprint(predecessor.request_id) : undefined
      for (const row of rows.all(sessionID, entry.started, entry.started, entry.rowid, entry.lastStarted, entry.lastStarted, entry.lastRowid)) {
        const real = row.kind !== "ping" && !row.is_title
        const fp = real ? fingerprint(row.id) : undefined
        if (entry.ids.has(row.id) && insert.run(row.id, sessionID, row.started, real ? 1 : 0, JSON.stringify(changedNames(lastReal, fp))).changes > 0) settled++
        if (real) lastReal = fp
      }
    }
    return settled
  })()
}

/**
 * Unstable-prefix streaks replayed from saved rows: the same entries and
 * selection as `windowedSessionSignals(sessionFold(ledger, id).analysis,
 * window, filter)`, per session from its first row. `pending` counts requests
 * not settled yet, whose changes the answer is still missing.
 */
export function savedUnstable(
  ledger: Ledger,
  sessionIDs: readonly string[] | null,
  window: { since: number; until: number },
  filter: { agents?: readonly string[]; models?: readonly string[] } = {},
): { unstable: { sessionID: string; segment: string; streak: number }[]; pending: number } {
  ensureTable(ledger)
  const sessions = sessionIDs ?? ledger.db
    .query<{ session_id: string }, []>("select distinct session_id from request order by session_id asc")
    .all()
    .map((row) => row.session_id)
  const pending = ledger.db
    .query<{ n: number }, [number, string]>(
      `select count(*) as n from request r
        where (? = 1 or r.session_id in (select value from json_each(?)))
          and not exists (select 1 from request_change c where c.request_id = r.id)`,
    )
    .get(sessionIDs === null ? 1 : 0, JSON.stringify(sessionIDs ?? []))!.n
  const rows = ledger.db.query<
    { changed: string; started: number; real: number; agent: string | null; provider: string | null; model: string | null },
    [string]
  >(
    `select c.changed as changed, r.started as started, c.real as real,
        r.agent as agent, r.provider as provider, r.model as model
      from request_change c join request r on r.id = c.request_id
      where c.session_id = ? order by r.started asc, r.rowid asc`,
  )
  const selected = (row: { agent: string | null; provider: string | null; model: string | null }) =>
    (!filter.agents?.length || filter.agents.includes(row.agent ?? "")) &&
    (!filter.models?.length || filter.models.includes(`${row.provider ?? ""}/${row.model ?? ""}`))
  const unstable: { sessionID: string; segment: string; streak: number }[] = []
  for (const sessionID of sessions) {
    // A name keeps the number it got when it first changed, which orders the
    // entries one row records, so the replay must number names as it goes.
    const names = new Map<string, number>()
    let streaks = new Map<string, number>()
    const latest = new Map<string, { segment: string; streak: number; at: number }>()
    for (const row of rows.all(sessionID)) {
      if (row.real === 0) continue
      const next = new Map<string, number>()
      for (const name of new Set(JSON.parse(row.changed) as string[])) {
        next.set(name, (streaks.get(name) ?? 0) + 1)
        if (!names.has(name)) names.set(name, names.size)
      }
      streaks = next
      if (row.started < window.since || row.started >= window.until || !selected(row)) continue
      for (const [name, count] of [...next].filter(([, count]) => count >= 3).sort(([a], [b]) => names.get(a)! - names.get(b)!)) {
        const existing = latest.get(name)
        if (!existing || row.started >= existing.at) latest.set(name, { segment: name, streak: count, at: row.started })
      }
    }
    for (const entry of latest.values()) unstable.push({ sessionID, segment: entry.segment, streak: entry.streak })
  }
  return { unstable, pending }
}
