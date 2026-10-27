// A cache write's unread tokens depend only on that write and the reads inside
// its lifetime, so save them once the lifetime ends and a report sums the saved
// numbers instead of folding whole session histories.
import { cacheLifetime, unreadFingerprintKeys } from "./cache.js"
import type { Ledger, RequestFingerprintData } from "./ledger.js"
import type { UnreadKey } from "./unread-index.js"

const ready = new WeakSet<Ledger>()

interface DueWrite {
  readonly request_id: string
  readonly session_id: string
  readonly at: number
  readonly expires: number
  readonly tokens: number
  readonly write_read: number
  readonly provider: string | null
  readonly model: string | null
}

interface CandidateRead {
  readonly id: string
  readonly is_title: number
  readonly cache_read_tokens: number
}

interface KeyIndexEntry {
  readonly any: boolean
  readonly tails: Set<string | undefined>
}

function ensureTable(ledger: Ledger) {
  if (ready.has(ledger)) return
  ledger.db.exec(`create table if not exists unread_write (
  request_id text primary key,
  session_id text not null,
  at integer not null,
  expires integer,
  agent text,
  model text,
  is_title integer not null,
  tokens integer not null,
  unread_real integer,
  unread_all integer
);
create index if not exists unread_write_session on unread_write(session_id, at);
create index if not exists unread_write_at on unread_write(at);`)
  ready.add(ledger)
}

/**
 * Bounded work, twice per call: save up to `limit` ended writes that have no row
 * yet, then finalize up to `limit` expired writes whose session has no request
 * still running across their lifetime. Returns how many rows were written or
 * finalized; zero means nothing is left to do at `now`.
 */
export function settleUnreadWrites(ledger: Ledger, now: number, limit = 64): number {
  ensureTable(ledger)
  return insertWrites(ledger, limit) + finalizeWrites(ledger, now, limit)
}

function insertWrites(ledger: Ledger, limit: number): number {
  const pending = ledger.db
    .query<
      {
        id: string
        session_id: string
        started: number
        agent: string | null
        provider: string | null
        model: string | null
        is_title: number
        cache_write_tokens: number
      },
      [number]
    >(
      `select r.id, r.session_id, r.started, r.agent, r.provider, r.model, r.is_title, r.cache_write_tokens
        from request r
        where r.ended is not null and r.cache_write_tokens > 0
          and not exists (select 1 from unread_write u where u.request_id = r.id)
        order by r.started asc, r.rowid asc limit ?`,
    )
    .all(limit)
  if (pending.length === 0) return 0
  const insert = ledger.db.query<unknown, [string, string, number, number | null, string | null, string, number, number]>(
    `insert into unread_write (request_id, session_id, at, expires, agent, model, is_title, tokens)
      values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(request_id) do nothing`,
  )
  return ledger.db.transaction(() =>
    pending.reduce((written, row) => {
      const lifetime = cacheLifetime({ provider: row.provider ?? undefined, model: row.model ?? undefined }, ledger.getFingerprint(row.id))
      // The saved filter column matches `cache_result.model`, and a model reads
      // a missing provider or model as empty.
      const saved = insert.run(
        row.id,
        row.session_id,
        row.started,
        lifetime === undefined ? null : row.started + lifetime,
        row.agent,
        `${row.provider ?? ""}/${row.model ?? ""}`,
        row.is_title,
        row.cache_write_tokens,
      ).changes
      return written + (saved > 0 ? 1 : 0)
    }, 0),
  )()
}

// A request still open this long after it started is a crashed run's row: it
// never ends and, like the fold, reads nothing, so it must not hold writes back.
const ABANDONED_AFTER = 6 * 3_600_000

function finalizeWrites(ledger: Ledger, now: number, limit: number): number {
  // A session's open requests are few, so they are read once and matched in SQL
  // rather than rescanning each write's session history for every candidate.
  const open = ledger.db
    .query<{ session: string; started: number }, [number]>("select session_id as session, started from request where ended is null and started > ?")
    .all(now - ABANDONED_AFTER)
  const due = ledger.db
    .query<DueWrite, [number, string, number]>(
      `select u.request_id, u.session_id, u.at, u.expires, u.tokens,
        r.cache_read_tokens as write_read, r.provider, r.model
      from unread_write u join request r on r.id = u.request_id
      where u.expires is not null and u.expires <= ? and u.unread_real is null
        and not exists (select 1 from json_each(?) o
          where json_extract(o.value, '$.session') = u.session_id and json_extract(o.value, '$.started') <= u.expires)
      order by u.expires asc, u.request_id asc limit ?`,
    )
    .all(now, JSON.stringify(open), limit)
  if (due.length === 0) return 0
  const bySession = new Map<string, DueWrite[]>()
  due.forEach((write) => {
    const group = bySession.get(write.session_id)
    if (group) group.push(write)
    else bySession.set(write.session_id, [write])
  })
  return ledger.db.transaction(() =>
    [...bySession.values()].reduce((finalized, writes) => finalized + finalizeSession(ledger, writes), 0),
  )()
}

// One session's writes share a key cache: its reads are recomputed for each
// write, so their lengths are reused rather than rebuilt per comparison.
function finalizeSession(ledger: Ledger, writes: readonly DueWrite[]): number {
  const reads = ledger.db.query<CandidateRead, [string, number, number, string | null, string | null]>(
    `select id, is_title, cache_read_tokens from request
      where session_id = ? and cache_read_tokens > 0 and started > ? and started <= ?
        and provider is ? and model is ?
      order by started asc, rowid asc`,
  )
  const fingerprints = new Map<string, RequestFingerprintData | undefined>()
  const keys = new Map<string, { readonly read: readonly UnreadKey[]; readonly write: readonly UnreadKey[] }>()
  const keysOf = (requestID: string) => {
    const cached = keys.get(requestID)
    if (cached) return cached
    const fp = fingerprints.has(requestID) ? fingerprints.get(requestID) : ledger.getFingerprint(requestID)
    fingerprints.set(requestID, fp)
    const computed = { read: unreadFingerprintKeys(fp, false), write: unreadFingerprintKeys(fp, true) }
    keys.set(requestID, computed)
    return computed
  }
  const update = ledger.db.query<unknown, [number, number, string]>(
    "update unread_write set unread_real = ?, unread_all = ? where request_id = ?",
  )
  return writes.reduce((finalized, write) => {
    const index = writeKeyIndex(keysOf(write.request_id).write)
    const maxima = reads.all(write.session_id, write.at, write.expires, write.provider, write.model).reduce(
      (best, read) => {
        if (!matchesRead(index, keysOf(read.id).read)) return best
        return {
          all: Math.max(best.all, read.cache_read_tokens),
          real: read.is_title === 1 ? best.real : Math.max(best.real, read.cache_read_tokens),
        }
      },
      { all: 0, real: 0 },
    )
    const saved = update.run(
      unreadTokens(write.tokens, maxima.real, write.write_read),
      unreadTokens(write.tokens, maxima.all, write.write_read),
      write.request_id,
    ).changes
    return finalized + (saved > 0 ? 1 : 0)
  }, 0)
}

// A read key matches when some write key has the same prefix and either has no
// private tail or a different one: `unreadGain` evaluates each write key on its
// own, so one differing tail is enough.
function writeKeyIndex(keys: readonly UnreadKey[]) {
  const index = new Map<string, KeyIndexEntry>()
  keys.forEach((key) => {
    const entry = index.get(key.key)
    if (!entry) {
      index.set(key.key, { any: key.tail === undefined, tails: new Set(key.tail === undefined ? [] : [key.tail]) })
      return
    }
    if (key.tail !== undefined) entry.tails.add(key.tail)
    else index.set(key.key, { any: true, tails: entry.tails })
  })
  return index
}

function matchesRead(index: ReadonlyMap<string, KeyIndexEntry>, keys: readonly UnreadKey[]) {
  return keys.some((key) => {
    const entry = index.get(key.key)
    if (!entry) return false
    if (entry.any) return true
    return [...entry.tails].some((tail) => tail !== key.tail)
  })
}

// `unreadGain` with `maxRead` read from the candidate reads: a write counts as
// read only above what it already read itself.
function unreadTokens(tokens: number, maxRead: number, writeRead: number) {
  return Math.max(0, tokens - Math.max(0, maxRead - writeRead))
}

/**
 * Unread tokens saved for one window and selection. `sessionIDs` is the scope:
 * null for every session, or the sessions to include. `pending` counts expired
 * writes not finalized yet, plus ended writes that have no saved row.
 */
export function savedUnread(
  ledger: Ledger,
  sessionIDs: readonly string[] | null,
  window: { since: number; until: number },
  options: { titles?: boolean; agents?: readonly string[]; models?: readonly string[] } = {},
): { unread: number; pending: number } {
  ensureTable(ledger)
  const agentFilter = options.agents?.length
    ? ` and coalesce(u.agent, '') in (${options.agents.map((_, index) => `$agent${index}`).join(", ")})`
    : ""
  const modelFilter = options.models?.length
    ? ` and u.model in (${options.models.map((_, index) => `$model${index}`).join(", ")})`
    : ""
  const bindings = {
    $since: window.since,
    $until: window.until,
    $titles: options.titles === true ? 1 : 0,
    $all: sessionIDs === null ? 1 : 0,
    $sessions: JSON.stringify(sessionIDs ?? []),
    ...Object.fromEntries((options.agents ?? []).map((value, index) => [`$agent${index}`, value])),
    ...Object.fromEntries((options.models ?? []).map((value, index) => [`$model${index}`, value])),
  }
  const scope = (alias: string) => `($all = 1 or ${alias}.session_id in (select value from json_each($sessions)))`
  const unread = ledger.db
    .query<{ n: number }, [typeof bindings]>(
      `select coalesce(sum(case when $titles = 1 then u.unread_all else u.unread_real end), 0) as n
        from unread_write u
        where u.at >= $since and u.at < $until and u.expires <= $until and u.unread_real is not null
          and ($titles = 1 or u.is_title = 0)
          and ${scope("u")}${agentFilter}${modelFilter}`,
    )
    .get(bindings)!.n
  const unfinalized = ledger.db
    .query<{ n: number }, [typeof bindings]>(
      `select count(*) as n from unread_write u
        where u.at >= $since and u.at < $until and u.expires <= $until and u.unread_real is null
          and ${scope("u")}`,
    )
    .get(bindings)!.n
  const unsaved = ledger.db
    .query<{ n: number }, [typeof bindings]>(
      `select count(*) as n from request r
        where r.ended is not null and r.cache_write_tokens > 0 and r.started >= $since and r.started < $until
          and ${scope("r")}
          and not exists (select 1 from unread_write u where u.request_id = r.id)`,
    )
    .get(bindings)!.n
  return { unread, pending: unfinalized + unsaved }
}
