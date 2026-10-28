// The monitor's durable ledger: one SQLite file shared by every Plus instance
// in the process (and any other process pointed at the same data directory).
//
// It stores usage/events plus a rebuildable cache-screen projection. Tool
// accounting still derives carried tokens and groupings at query time. Full
// sent bodies live in private transcript files; this database stores references
// and compact cache diagnostics, not those bodies.
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { inconsistentObservation, Observation, readObservation, type RequestObservation } from "./observation.js"
import { errorFingerprint } from "./fingerprint.js"
import { teamsDataDir } from "../instructions/paths.js"
import { stopCacheBackfill } from "./snapshot.js"
import type {
  CacheControlMarker,
  MessagePrefixFingerprint,
  SystemPartFingerprint,
  ToolFingerprint,
} from "./fingerprint.js"

export const RETENTION_DAYS = 90

const SCHEMA_VERSION = 3

export const HOUR = 3_600_000

// How many rows may chain on one keyframe before the next keyframe (B35). Every
// 64th row of a session, and its first, stores a full list, so decoding a
// single row walks at most 63 bases.
const KEYFRAME_INTERVAL = 64

// How many leading entries two message lists share, compared entry by entry.
function sharedPrefix(base: readonly unknown[], list: readonly unknown[]): number {
  const max = Math.min(base.length, list.length)
  let i = 0
  while (i < max && JSON.stringify(base[i]) === JSON.stringify(list[i])) i++
  return i
}

// One call row's contribution to its hour, signed: +1 on insert, -1 on
// delete, and both (old out, new in) on update.
function rollupUpsert(row: "new" | "old", sign: 1 | -1): string {
  const n = (expression: string) => (sign === 1 ? `(${expression})` : `-(${expression})`)
  const top = `${row}.parent_call is null`
  return `insert into call_hour (hour, session_id, epoch, agent, model, config, tool, calls, inner, errors, top_errors, running,
      call_tokens, result_tokens, result_idx, estimated, duration, timed)
    values (${row}.started / ${HOUR}, ${row}.session_id, ${row}.epoch, coalesce(${row}.agent, ''), coalesce(${row}.model, ''),
      coalesce(${row}.config, ''), ${row}.tool,
      ${n(top)}, ${n(`${row}.parent_call is not null`)}, ${n(`${row}.status = 'error'`)}, ${n(`${row}.status = 'error' and ${top}`)},
      ${n(`${row}.status = 'running'`)}, ${n(`${row}.call_tokens`)}, ${n(`${row}.result_tokens`)}, ${n(`${row}.result_tokens * ${row}.idx`)},
      ${n(`${top} and ${row}.measured = 0 and ${row}.status != 'running'`)},
      ${n(`case when ${row}.ended is not null and ${top} then ${row}.ended - ${row}.started else 0 end`)},
      ${n(`${row}.ended is not null and ${top}`)})
    on conflict (hour, session_id, epoch, agent, model, config, tool) do update set
      calls = calls + excluded.calls, inner = inner + excluded.inner, errors = errors + excluded.errors,
      top_errors = top_errors + excluded.top_errors, running = running + excluded.running,
      call_tokens = call_tokens + excluded.call_tokens, result_tokens = result_tokens + excluded.result_tokens,
      result_idx = result_idx + excluded.result_idx, estimated = estimated + excluded.estimated,
      duration = duration + excluded.duration, timed = timed + excluded.timed;`
}

// Per-session change marks for the Monitor's analysis cache. Every write to a
// session's requests, fingerprints or context facts, from any connection or
// process, bumps that session's revision, and a written or deleted
// fingerprint records the revision it was written at. An analysis then reloads
// only what changed in its own session; another chat's writes leave it alone.
function changeTriggers(): string {
  const bump = (session: string) => `insert into session_change (session_id, rev) values (${session}, 1)
    on conflict (session_id) do update set rev = rev + 1;`
  const mark = (row: "new" | "old", prefixChanged = "1") => `insert into fingerprint_change (request_id, session_id, rev, prefix_rev)
    select ${row}.request_id, ${row}.session_id, rev, case when ${prefixChanged} then rev else 0 end
    from session_change where session_id = ${row}.session_id
    on conflict (request_id) do update set session_id = excluded.session_id, rev = excluded.rev,
      prefix_rev = case when excluded.prefix_rev > 0 then excluded.prefix_rev else fingerprint_change.prefix_rev end;`
  // REPLACE can delete a conflicting row without firing DELETE triggers on
  // another connection (recursive_triggers defaults off). Capture its indexed
  // preimage before insertion. An ignored duplicate may conservatively reset
  // the fold too; never scan a Session's history on the normal append path.
  const replacement = (table: string, key: string, conflict: string) => {
    const entity = table === "request_fingerprint" ? "fingerprint" : table
    const replaced = `select ${key} as id, session_id from ${table} where (${conflict}) and (${key} != new.${key} or session_id != new.session_id)`
    return `create trigger if not exists ${table}_change_replace before insert on ${table} begin
      insert into session_change(session_id, rev) select session_id, 1 from (${replaced}) where 1
        on conflict(session_id) do update set rev = rev + 1;
      insert into analysis_reset(session_id, entity, rev)
        select preimage.session_id, '${entity}', session_change.rev from (${replaced}) preimage
        join session_change on session_change.session_id = preimage.session_id where 1
        on conflict(session_id, entity) do update set rev = excluded.rev;
      ${table === "request_fingerprint" ? "" : `delete from analysis_change where entity = '${entity}' and id in (select id from (${replaced}));`}
    end;`
  }
  const plain = (table: string) => {
    const live = `insert into analysis_change (entity, id, session_id, rev)
      values ('${table}', new.id, new.session_id, (select rev from session_change where session_id = new.session_id))
      on conflict(entity, id) do update set session_id = excluded.session_id, rev = excluded.rev;`
    const reset = `insert into analysis_reset (session_id, entity, rev)
      values (old.session_id, '${table}', (select rev from session_change where session_id = old.session_id))
      on conflict(session_id, entity) do update set rev = excluded.rev;`
    return `
create trigger if not exists ${table}_change_insert after insert on ${table} begin ${bump("new.session_id")} ${live} end;
create trigger if not exists ${table}_change_update after update on ${table} begin
  ${bump("old.session_id")} ${bump("new.session_id")}
  insert into analysis_reset (session_id, entity, rev)
    select old.session_id, '${table}', rev from session_change where session_id = old.session_id and (old.session_id != new.session_id or old.id != new.id)
    on conflict(session_id, entity) do update set rev = excluded.rev;
  delete from analysis_change where entity = '${table}' and id = old.id;
  ${live}
end;
create trigger if not exists ${table}_change_delete after delete on ${table} begin
  ${bump("old.session_id")} ${reset}
  delete from analysis_change where entity = '${table}' and id = old.id;
end;`
  }
  return `${replacement("request", "id", "id = new.id")}
${replacement("context_fact", "id", "id = new.id or (session_id = new.session_id and at = new.at and kind = new.kind and detail = new.detail)")}
${replacement("request_fingerprint", "request_id", "request_id = new.request_id")}
${plain("request")}
${plain("context_fact")}
create trigger if not exists request_fingerprint_change_insert after insert on request_fingerprint begin
  ${bump("new.session_id")} ${mark("new")}
end;
create trigger if not exists request_fingerprint_change_update after update on request_fingerprint begin
  ${bump("old.session_id")} ${bump("new.session_id")} ${mark("new", "old.message_prefixes is not new.message_prefixes or old.prefix_base is not new.prefix_base or old.prefix_shared is not new.prefix_shared")}
  insert into analysis_reset (session_id, entity, rev)
    select old.session_id, 'fingerprint', rev from session_change where session_id = old.session_id and (old.session_id != new.session_id or old.request_id != new.request_id)
    on conflict(session_id, entity) do update set rev = excluded.rev;
end;
create trigger if not exists request_fingerprint_change_delete after delete on request_fingerprint begin
  ${bump("old.session_id")} ${mark("old")}
end;`
}

// Saved analysis the reports read (snapshot.ts cache_result, unread-saved.ts,
// unstable-saved.ts) follows corrections: a request's saved result reads its
// predecessors and the facts before it, its changed segments read the previous
// real request, and a write's unread tokens read the requests in its lifetime.
// So a change to a request, its fingerprint's content or a fact drops what it
// can affect, from that point of its session on; the backfill saves it again.
// `saved_dirty` tells the windowed walks how far back to look for those rows.
// Deletions (retention) drop nothing else: later results keep what they saw.
// A fingerprint rewritten with the same content (a repeated capture) drops nothing.
const FINGERPRINT_CONTENT = [
  "session_id", "protocol", "system_parts", "tools", "options_hash", "options_keys", "message_prefixes",
  "prefix_base", "prefix_shared", "prefix_depth", "cache_key", "cache_control", "body_hash", "created",
  "previous_response_id", "response_id", "fingerprint_version", "policy_version", "system_hash",
]

function savedSchema(): string {
  const dirty = (name: string, at: string) => `insert into saved_dirty (name, at) values ('${name}', ${at})
    on conflict (name) do update set at = min(at, excluded.at);`
  const drop = (session: string, at: string, id: string) => `
    delete from cache_result where session_id = ${session} and started >= ${at};
    delete from request_change where session_id = ${session} and started >= ${at};
    ${dirty("request_change", at)}
    delete from unread_write where request_id = ${id};
    ${dirty("unread_write", at)}
    update unread_write set unread_real = null, unread_all = null
      where session_id = ${session} and at < ${at} and expires >= ${at} and unread_real is not null;`
  return `
create table if not exists unread_write (
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
create index if not exists unread_write_at on unread_write(at);
create index if not exists unread_write_due on unread_write(expires) where unread_real is null;
create index if not exists request_open on request(started) where ended is null;
create table if not exists request_change (
  request_id text primary key,
  session_id text not null,
  started integer not null,
  real integer not null,
  changed text not null
);
create index if not exists request_change_session on request_change(session_id, started);
create table if not exists saved_dirty (name text primary key, at integer not null);
create trigger if not exists saved_request_update after update on request begin
  ${drop("old.session_id", "min(old.started, new.started)", "old.id")}
  ${drop("new.session_id", "min(old.started, new.started)", "new.id")}
end;
create trigger if not exists saved_fingerprint_insert after insert on request_fingerprint
  when exists (select 1 from request where id = new.request_id) begin
  ${drop("new.session_id", "(select started from request where id = new.request_id)", "new.request_id")}
end;
create trigger if not exists saved_fingerprint_update after update on request_fingerprint
  when (${FINGERPRINT_CONTENT.map((column) => `old.${column} is not new.${column}`).join(" or ")})
    and exists (select 1 from request where id = new.request_id) begin
  ${drop("new.session_id", "(select started from request where id = new.request_id)", "new.request_id")}
end;
create trigger if not exists saved_fact_insert after insert on context_fact begin
  delete from cache_result where session_id = new.session_id and started >= new.at;
end;`
}

function rollupTriggers(): string {
  return `
create trigger if not exists call_hour_insert after insert on call begin
  ${rollupUpsert("new", 1)}
end;
create trigger if not exists call_hour_update after update on call begin
  ${rollupUpsert("old", -1)}
  ${rollupUpsert("new", 1)}
end;
create trigger if not exists call_hour_delete after delete on call begin
  ${rollupUpsert("old", -1)}
end;`
}

const schema = `
create table if not exists session (
  id text primary key,
  parent_id text,
  agent text,
  title text,
  directory text,
  run_id text,
  role text,
  first_seen integer not null,
  last_seen integer not null
);
create index if not exists session_parent on session(parent_id);
create index if not exists session_directory on session(directory);

create table if not exists step (
  session_id text not null,
  message_id text not null,
  kind text not null,
  idx integer not null,
  epoch integer not null,
  agent text,
  provider text,
  model text,
  variant text,
  config text,
  started integer not null,
  ended integer,
  finish text,
  input integer not null default 0,
  output integer not null default 0,
  reasoning integer not null default 0,
  cache_read integer not null default 0,
  cache_write integer not null default 0,
  cost real not null default 0,
  primary key (session_id, message_id)
);
create index if not exists step_ended on step(ended);
create index if not exists step_session on step(session_id, epoch, idx);

create table if not exists call (
  session_id text not null,
  call_id text not null,
  message_id text not null,
  parent_call text,
  idx integer not null,
  epoch integer not null,
  agent text,
  model text,
  config text,
  tool text not null,
  target text,
  status text not null,
  error text,
  started integer not null,
  ended integer,
  input_chars integer not null default 0,
  result_chars integer not null default 0,
  call_tokens integer not null default 0,
  result_tokens integer not null default 0,
  measured integer not null default 0,
  primary key (session_id, call_id)
);
create index if not exists call_started on call(started);
create index if not exists call_session on call(session_id, epoch, idx);
create index if not exists call_message on call(session_id, message_id);
create index if not exists call_tool on call(tool, started);
create index if not exists call_agent on call(agent, started);

-- Hourly partial sums of call, kept by triggers, so wide windows read a few
-- thousand rows instead of every call. Keyed down to the session and epoch so
-- carried tokens (per session epoch) and the session scope stay exact; the
-- query reads whole hours here and the partial hours at a window's edges from
-- call itself.
create table if not exists call_hour (
  hour integer not null,
  session_id text not null,
  epoch integer not null,
  agent text not null,
  model text not null,
  config text not null,
  tool text not null,
  calls integer not null default 0,
  inner integer not null default 0,
  errors integer not null default 0,
  top_errors integer not null default 0,
  running integer not null default 0,
  call_tokens integer not null default 0,
  result_tokens integer not null default 0,
  result_idx integer not null default 0,
  estimated integer not null default 0,
  duration integer not null default 0,
  timed integer not null default 0,
  primary key (hour, session_id, epoch, agent, model, config, tool)
) without rowid;
create index if not exists call_hour_session on call_hour(session_id, hour);
${rollupTriggers()}

create table if not exists epoch (
  session_id text not null,
  epoch integer not null,
  last_idx integer not null,
  primary key (session_id, epoch)
);

create table if not exists mark (
  id integer primary key autoincrement,
  at integer not null,
  label text not null
);
create index if not exists mark_at on mark(at);

-- Cache notices opened or dismissed in any TUI: hidden from every TUI of this
-- server. Rows outlive the longest notice lifetime briefly, then are pruned.
create table if not exists notice_dismissed (
  request_id text primary key,
  at integer not null
);

create table if not exists meta (
  key text primary key,
  value text not null
);

create table if not exists request (
  id text primary key,
  session_id text not null,
  kind text not null,
  is_title integer not null default 0,
  agent text,
  provider text,
  model text,
  variant text,
  started integer not null,
  ended integer,
  duration integer,
  status text not null default 'completed',
  error text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost real not null default 0,
  message_id text,
  created integer not null
);
create index if not exists request_session on request(session_id, started);
create index if not exists request_message on request(session_id, message_id);
create index if not exists request_started on request(started);
create index if not exists request_kind on request(kind);
create index if not exists request_predecessor on request(session_id, provider, model, ended desc);

-- Cache-screen read model. Full wire bodies live in the private wire store
-- (wire.ts); a body it cannot rebuild exactly keeps a compressed file here.
-- Opening the screen reads only these compact, completed-request results.
create table if not exists cache_wire (
  request_id text primary key,
  path text not null
);
create table if not exists cache_result (
  request_id text primary key,
  session_id text not null,
  started integer not null,
  verdict text not null,
  summary text not null,
  detail text not null
);
create index if not exists cache_result_verdict on cache_result(verdict, started, request_id);

create table if not exists request_fingerprint (
  request_id text primary key,
  session_id text not null,
  protocol text not null,
  system_parts text not null default '[]',
  tools text not null default '[]',
  options_hash text not null default '',
  options_keys text not null default '{}',
  message_prefixes text not null default '[]',
  -- Message lists are stored as deltas against the session's previous
  -- fingerprint (by created then rowid): prefix_base names that row's request
  -- id, prefix_shared how many leading entries equal its decoded list, and
  -- message_prefixes holds only the entries after them. A keyframe (every 64th
  -- row of a session and its first) has prefix_base null and the full list;
  -- prefix_depth is 0. A legacy row (all three null) is a keyframe, so older
  -- files read unchanged. See B35 in docs/plans/plus-1.2.0.md.
  prefix_base text,
  prefix_shared integer,
  prefix_depth integer,
  cache_key text,
  cache_control text,
  body_hash text not null,
  created integer not null
);
create index if not exists request_fingerprint_session on request_fingerprint(session_id, created);
create index if not exists request_fingerprint_created on request_fingerprint(created);

create table if not exists context_fact (
  id integer primary key autoincrement,
  session_id text not null,
  at integer not null,
  kind text not null,
  detail text not null default '{}',
  unique (session_id, at, kind, detail)
);
create index if not exists context_fact_session on context_fact(session_id, at);
create index if not exists context_fact_kind on context_fact(kind, at);
create index if not exists context_fact_at on context_fact(at);

create table if not exists session_change (
  session_id text primary key,
  rev integer not null
) without rowid;
create table if not exists fingerprint_change (
  request_id text primary key,
  session_id text not null,
  rev integer not null,
  prefix_rev integer not null default 0
) without rowid;
create index if not exists fingerprint_change_session on fingerprint_change(session_id, rev);
-- Bounded materialized indexes: one mark per live payload, one reset per
-- session/entity. No append log or per-deletion tombstone.
create table if not exists analysis_change (
  entity text not null, id text not null, session_id text not null, rev integer not null,
  primary key (entity, id)
) without rowid;
create index if not exists analysis_change_session on analysis_change(session_id, entity, rev);
create table if not exists analysis_reset (
  session_id text not null, entity text not null, rev integer not null,
  primary key (session_id, entity)
) without rowid;
`

export interface SessionFacts {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
  readonly title?: string
  readonly directory?: string
  readonly runID?: string
  readonly role?: string
  readonly team?: string
}

export interface StepStart {
  readonly sessionID: string
  readonly messageID: string
  readonly kind: "step" | "compaction"
  readonly idx: number
  readonly epoch: number
  readonly agent?: string
  readonly provider?: string
  readonly model?: string
  readonly variant?: string
  readonly config?: string
  readonly started: number
}

export interface Usage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: number
}

export interface CallStart {
  readonly sessionID: string
  readonly callID: string
  readonly messageID: string
  readonly parentCall?: string
  readonly idx: number
  readonly epoch: number
  readonly agent?: string
  readonly model?: string
  readonly config?: string
  readonly tool: string
  readonly target?: string
  readonly status: "running" | "completed" | "error"
  readonly started: number
  readonly inputChars: number
}

export interface CallEnd {
  readonly sessionID: string
  readonly callID: string
  readonly status: "completed" | "error"
  /** Provider/tool failure. Hashed at this persistence boundary, never stored as text. */
  readonly error?: unknown
  readonly ended: number
  readonly resultChars: number
  readonly resultTokens: number
}

export interface CallTokens {
  readonly sessionID: string
  readonly callID: string
  readonly callTokens?: number
  readonly resultTokens?: number
  readonly measured?: boolean
}

export interface RequestStart {
  readonly id: string
  readonly sessionID: string
  readonly kind: "step" | "compaction" | "ping" | "generate" | "title" | string
  readonly isTitle?: boolean
  readonly agent?: string
  readonly provider?: string
  readonly model?: string
  readonly variant?: string
  readonly started: number
  readonly messageID?: string
  readonly created?: number
}

export interface RequestEnd {
  readonly ended: number
  readonly duration?: number
  readonly status: "completed" | "error" | "cancelled" | "unknown"
  readonly finish?: string
  readonly error?: unknown
  readonly usage?: Usage
  readonly messageID?: string
}

export interface RequestRow {
  /** SQLite ordering metadata; non-enumerable, not part of report payloads. */
  readonly ledgerOrder?: number
  readonly id: string
  readonly sessionID: string
  readonly kind: string
  readonly isTitle: boolean
  readonly agent?: string
  readonly provider?: string
  readonly model?: string
  readonly variant?: string
  readonly started: number
  readonly ended?: number
  readonly duration?: number
  readonly status: string
  readonly finish?: string
  readonly error?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly cost: number
  readonly messageID?: string
  readonly created: number
  /** Absent for legacy accounting rows. Unsupported versions are unavailable, not legacy. */
  readonly observation?: RequestObservation
}

export interface RequestFingerprintData {
  readonly requestID: string
  readonly sessionID: string
  readonly fingerprintVersion?: number
  readonly policyVersion?: number
  readonly systemHash?: string
  readonly protocol: string
  readonly systemParts: readonly SystemPartFingerprint[]
  readonly tools: readonly ToolFingerprint[]
  readonly optionsHash: string
  readonly optionsKeys: Record<string, string>
  readonly messagePrefixes: readonly MessagePrefixFingerprint[]
  readonly cacheKey?: string
  readonly previousResponseId?: string
  readonly responseId?: string
  readonly cacheControl?: readonly CacheControlMarker[]
  readonly bodyHash: string
  readonly created?: number
}

export interface ContextFact {
  readonly sessionID: string
  readonly at: number
  readonly kind: string
  readonly detail?: Record<string, unknown>
}

/** Correlate event publication time, not subscriber arrival order. */
export function endRequestWindow(ledger: Ledger, start: RequestStart, end: RequestEnd, oldest = false): RequestRow | undefined {
  return ledger.db.transaction(() => {
    const rows = ledger.getRequests(start.sessionID)
    const existing = rows.find((row) => row.messageID === start.messageID && row.ended !== undefined)
    if (existing) return existing
    const candidates = rows.filter((row) => row.kind === start.kind && (row.messageID === undefined || row.messageID === start.messageID) && row.started >= start.started && row.started <= end.ended)
    // Exact invocation observations cannot be reconciled by a publication-time guess or
    // overwritten with compaction/Step aggregate accounting. Keep that on `step` only.
    const observed = candidates.filter((row) => row.observation !== undefined)
    if (observed.length > 0) {
      const representative = observed.findLast((row) => row.observation?.scope !== "exchange") ?? observed.at(-1)!
      // Core serializes compactions in one Session. Link this logical
      // accounting row to its observed operation so the legacy fallback does
      // not add the aggregate again. Never assign aggregate usage or outcome
      // to an invocation (which can succeed even if compaction is unusable).
      ledger.requestStarted({ ...representative, messageID: start.messageID })
      return ledger.getRequest(representative.id)
    }
    const chosen = oldest ? candidates.find((row) => row.ended === undefined) ?? candidates.at(-1) : candidates.at(-1)
    if (!chosen) ledger.requestStarted(start)
    // Compaction Ended.tokens is the aggregate of its attempts, not per-attempt usage.
    // Attribute that total to the last attempt; earlier wire requests are retried.
    if (!oldest) candidates.filter((row) => row.id !== chosen?.id).forEach((row) => ledger.requestEnded(row.id, { ended: end.ended, status: "error", error: "retried" }))
    ledger.requestEnded(chosen?.id ?? start.id, { ...end, messageID: start.messageID })
    return ledger.getRequest(chosen?.id ?? start.id)
  })()
}

export interface ContextFactRow extends ContextFact {
  readonly id: number
  /** Raw SQLite text for the existing unique-index tie order. */
  readonly ledgerDetail?: string
}

export interface Ledger {
  readonly db: Database
  readonly path: string
  session(facts: SessionFacts, now: number): void
  stepStarted(step: StepStart): void
  stepEnded(sessionID: string, messageID: string, ended: number, finish: string, usage: Usage): void
  callStarted(call: CallStart): void
  callEnded(end: CallEnd): void
  callTokens(updates: readonly CallTokens[]): void
  callTarget(sessionID: string, callID: string, target: string): void
  position(sessionID: string): { idx: number; epoch: number }
  mark(label: string, at: number): number
  prune(before: number): void
  close(): void
  /**
   * Change key for this shared ledger file. Combines this connection's own
   * write counter with SQLite's `data_version`, which changes when another
   * connection or process commits to the same file. Query-time analysis caches
   * key on it so an in-place update (request completion, a corrected final wire
   * fingerprint, a kind relabel) from any handle invalidates stale reads.
   */
  revision(): string
  /** This session's change mark: any write to its requests, fingerprints or context facts moves it. */
  sessionRevision(sessionID: string): number
  /** Request ids whose fingerprint in this session was written or deleted after its revision `since`. */
  changedFingerprints(sessionID: string, since: number): readonly string[]
  /** Undefined means a deletion/move requires a full session payload reload. */
  changedRequests(sessionID: string, since: number): readonly RequestRow[] | undefined
  changedContextFacts(sessionID: string, since: number): readonly ContextFactRow[] | undefined
  requestStarted(req: RequestStart): void
  requestEnded(id: string, end: RequestEnd): void
  /** Exact-ID terminal measurement, written after requestEnded. Never inferred from Session aggregates. */
  requestObserved(id: string, observation: Observation): void
  requestFingerprint(fp: RequestFingerprintData): void
  contextFact(fact: ContextFact): void
  relabelLatestRequest(sessionID: string, fromKind: string, toKind: string): void
  getRequest(id: string): RequestRow | undefined
  getRequests(sessionID: string): readonly RequestRow[]
  /** The session's requests that started in [from, to], in the same order as getRequests. */
  getRequestsBetween(sessionID: string, from: number, to: number): readonly RequestRow[]
  getFingerprint(requestID: string): RequestFingerprintData | undefined
  getFingerprints(sessionID: string): readonly RequestFingerprintData[]
  getContextFacts(sessionID: string): readonly ContextFactRow[]
}

/**
 * The numbers the monitor sums, copied out of each saved result's JSON. Two
 * covering indexes carry them, so totals, per-session sums and request pages
 * are index-only reads instead of parsing every result's JSON.
 */
export const CACHE_COLUMNS = [
  ["kind", "text", "$.kind"],
  ["agent", "text", "$.agent"],
  ["model", "text", "$.provider || '/' || $.model"],
  ["outcome", "text", "$.outcome"],
  ["exchange", "integer", "coalesce($.measurement.scope, '') = 'exchange'"],
  ["input", "integer", "coalesce($.input, 0)"],
  ["output", "integer", "coalesce($.output, 0)"],
  ["reasoning", "integer", "coalesce($.reasoning, 0)"],
  ["cache_read", "integer", "coalesce($.cacheRead, 0)"],
  ["cache_write", "integer", "coalesce($.cacheWrite, 0)"],
  ["cost", "real", "coalesce($.cost, 0)"],
  ["miss_tokens", "integer", "coalesce($.missTokens, 0)"],
  ["miss_cost", "real", "$.missCost"],
  ["measured_state", "text", "$.measurement.state"],
  ["measured_input", "integer", "$.measurement.input"],
  ["measured_read", "integer", "$.measurement.read"],
] as const

/** The SQL that computes every cache column from a `summary` JSON value. */
export function cacheColumnValues(summary: string) {
  return CACHE_COLUMNS.map(([, , value]) => value.replace(/\$\.([\w.]+)/g, (_, field: string) => `json_extract(${summary}, '$.${field}')`))
}

function migrateCacheColumns(db: Database) {
  const existing = new Set(db.query<{ name: string }, []>("pragma table_info(cache_result)").all().map((column) => column.name))
  const missing = CACHE_COLUMNS.filter(([name]) => !existing.has(name))
  if (missing.length) {
    db.transaction(() => {
      missing.forEach(([name, type]) => db.exec(`alter table cache_result add column ${name} ${type}`))
      const values = cacheColumnValues("summary")
      db.exec(`update cache_result set ${CACHE_COLUMNS.map(([name], index) => `${name} = ${values[index]}`).join(", ")}`)
    })()
  }
  const columns = CACHE_COLUMNS.map(([name]) => name).join(", ")
  db.exec(`create index if not exists cache_result_time_totals on cache_result(started, request_id, session_id, verdict, ${columns})`)
  db.exec(`create index if not exists cache_result_session_totals on cache_result(session_id, started, request_id, verdict, ${columns})`)
  db.exec("drop index if exists cache_result_session")
  db.exec("drop index if exists cache_result_started")
  // Ended requests minus saved results is the backlog still to analyze.
  db.exec("create index if not exists request_ended on request(session_id) where ended is not null")
}

// A Monitor tab over all history reads these indexes, never the wide rows they
// cover: the ledger file is large, fragmented and mostly out of the page cache,
// where reading every step or request row takes seconds. Step totals and v1
// steps by time; a ping's next request, with its end and exchange scope.
function migrateReadIndexes(db: Database) {
  db.exec(`create index if not exists step_window on step(started, session_id, message_id, agent, provider, model,
    input, output, reasoning, cache_read, cache_write, cost)`)
  db.exec("drop index if exists step_started")
  db.exec(`create index if not exists request_follow on request(session_id, started, id, kind, is_title,
    coalesce(json_extract(observation, '$.scope'), ''), ended)`)
}

// Free pages below this share of the file are normal fragmentation.
const COMPACT_SHARE = 0.3
// Pages returned to disk after a prune, and the least time between those runs.
const INCREMENTAL_PAGES = 2000
const INCREMENTAL_EVERY = HOUR

/**
 * How this handle tidies the file it holds. The one-time rewrite is not here:
 * it runs in a worker (compact.ts) so it never blocks the service.
 */
export interface LedgerOptions {
  incrementalPages?: number
  incrementalEvery?: number
  /** Share of free pages above which pruning returns some to the disk. */
  compactShare?: number
  /** Clock for the once-an-hour prune gate. */
  now?: () => number
}

/** `monitor.db` next to the teams data, under the XDG data directory. */
// Pruning frees pages in place, so the file stops growing but does not shrink;
// only a `VACUUM` gives that space back. Two things do that now, and neither
// blocks the service: the one-time rewrite runs in a worker at monitor start
// (compact.ts), holding writes in memory until it is done; afterwards each
// prune pass may return a bounded batch of free pages with
// `incremental_vacuum`, at most hourly. Neither drops a row: the rewrite
// rewrites live rows, and the incremental form frees only pages SQLite already
// marks as free.
export function defaultLedgerPath(): string {
  return path.join(path.dirname(teamsDataDir()), "monitor.db")
}

// One connection per file per process: every Plus instance (one per Location)
// writes through the same handle, so their writes never contend for the lock.
const open = new Map<string, Ledger>()

export function ledgerAt(file: string = defaultLedgerPath()): Ledger {
  const existing = open.get(file)
  if (existing !== undefined) return existing
  const created = createLedger(file)
  open.set(file, created)
  return created
}

export function createLedger(file: string, options: LedgerOptions = {}): Ledger {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  // Check before any migration, pragma or metadata write; never downgrade an unknown writer.
  const hasMeta = db.query("select name from sqlite_master where type = 'table' and name = 'meta'").get()
  const version = hasMeta ? db.query<{ value: string }, []>("select value from meta where key = 'schema'").get()?.value : undefined
  if (version !== undefined && !["1", "2", String(SCHEMA_VERSION)].includes(version)) {
    db.close()
    throw new Error("Unsupported monitor ledger schema")
  }
  const delta = hasMeta ? db.query<{ value: string }, []>("select value from meta where key = 'analysis_delta'").get()?.value : undefined
  if (delta !== undefined && !["1", "2", "3"].includes(delta)) {
    db.close()
    throw new Error("Unsupported monitor analysis index version")
  }
  // Before the first table, so a new ledger starts in incremental mode; on an
  // existing one this is a no-op until the next `VACUUM`. It must also precede
  // the journal-mode switch: on an empty file, setting WAL first stops it from
  // persisting.
  db.exec("pragma auto_vacuum = incremental")
  db.exec("pragma journal_mode = wal")
  db.exec("pragma synchronous = normal")
  db.exec("pragma busy_timeout = 2000")
  db.exec(schema)
  // Explicit additive migration replaces the old plain triggers, which
  // CREATE IF NOT EXISTS alone would silently keep on an existing database.
  db.transaction(() => {
    if (delta === "3") return
    if (!db.query<{ name: string }, []>("pragma table_info(fingerprint_change)").all().some((column) => column.name === "prefix_rev")) {
      db.exec("alter table fingerprint_change add column prefix_rev integer not null default 0")
    }
    for (const table of ["request", "context_fact", "request_fingerprint"]) {
      for (const operation of ["insert", "update", "delete", "replace"]) db.exec(`drop trigger if exists ${table}_change_${operation}`)
    }
    db.exec(changeTriggers())
    db.exec("insert into meta (key, value) values ('analysis_delta', '3') on conflict(key) do update set value = excluded.value")
  })()
  if (!db.query<{ name: string }, []>("pragma table_info(request)").all().some((column) => column.name === "observation")) db.exec("alter table request add column observation text")
  if (!db.query<{ name: string }, []>("pragma table_info(request)").all().some((column) => column.name === "finish")) db.exec("alter table request add column finish text")
  const fingerprintColumns = db.query<{ name: string }, []>("pragma table_info(request_fingerprint)").all()
  for (const [name, type] of [["fingerprint_version", "integer"], ["policy_version", "integer"], ["system_hash", "text"]]) {
    if (!fingerprintColumns.some((column) => column.name === name)) db.exec(`alter table request_fingerprint add column ${name} ${type}`)
  }
  for (const name of ["previous_response_id", "response_id"]) {
    if (!fingerprintColumns.some((column) => column.name === name)) db.exec(`alter table request_fingerprint add column ${name} text`)
  }
  for (const [name, type] of [["prefix_base", "text"], ["prefix_shared", "integer"], ["prefix_depth", "integer"]] as const) {
    if (!fingerprintColumns.some((column) => column.name === name)) db.exec(`alter table request_fingerprint add column ${name} ${type}`)
  }
  db.exec("create index if not exists request_fingerprint_base on request_fingerprint(prefix_base)")
  migrateCacheColumns(db)
  migrateReadIndexes(db)
  // The fold's own wording of a saved result (report.ts); rows saved before it are saved again.
  if (!db.query<{ name: string }, []>("pragma table_info(cache_result)").all().some((column) => column.name === "fold")) db.exec("alter table cache_result add column fold text")
  db.exec("create index if not exists cache_result_unfolded on cache_result(started) where fold is null")
  db.exec(savedSchema())
  if (
    !db
      .query<{ name: string }, []>("pragma table_info(session)")
      .all()
      .some((c) => c.name === "team")
  )
    db.exec("alter table session add column team text")
  db.query(
    "insert into meta (key, value) values ('schema', ?) on conflict(key) do update set value = excluded.value",
  ).run(String(SCHEMA_VERSION))

  const upsertSession = db.query(`
    insert into session (id, parent_id, agent, title, directory, run_id, role, team, first_seen, last_seen)
    values ($id, $parent, $agent, $title, $directory, $run, $role, $team, $now, $now)
    on conflict(id) do update set
      parent_id = coalesce(excluded.parent_id, session.parent_id),
      agent = coalesce(excluded.agent, session.agent),
      title = coalesce(excluded.title, session.title),
      directory = coalesce(excluded.directory, session.directory),
      run_id = coalesce(excluded.run_id, session.run_id),
      role = coalesce(excluded.role, session.role),
      team = coalesce(excluded.team, session.team),
      last_seen = max(session.last_seen, excluded.last_seen)`)
  const insertStep = db.query(`
    insert into step (session_id, message_id, kind, idx, epoch, agent, provider, model, variant, config, started)
    values ($session, $message, $kind, $idx, $epoch, $agent, $provider, $model, $variant, $config, $started)
    on conflict(session_id, message_id) do update set
      agent = coalesce(excluded.agent, step.agent),
      provider = coalesce(excluded.provider, step.provider),
      model = coalesce(excluded.model, step.model),
      variant = coalesce(excluded.variant, step.variant),
      config = coalesce(excluded.config, step.config)`)
  const bumpEpoch = db.query(`
    insert into epoch (session_id, epoch, last_idx) values ($session, $epoch, $idx)
    on conflict(session_id, epoch) do update set last_idx = max(epoch.last_idx, excluded.last_idx)`)
  const endStep = db.query(`
    update step set ended = $ended, finish = $finish, input = $input, output = $output, reasoning = $reasoning,
      cache_read = $cacheRead, cache_write = $cacheWrite, cost = $cost
    where session_id = $session and message_id = $message`)
  const insertCall = db.query(`
    insert into call (session_id, call_id, message_id, parent_call, idx, epoch, agent, model, config, tool, target, status, started, input_chars)
    values ($session, $call, $message, $parent, $idx, $epoch, $agent, $model, $config, $tool, $target, $status, $started, $inputChars)
    on conflict(session_id, call_id) do update set
      tool = excluded.tool,
      target = coalesce(excluded.target, call.target),
      input_chars = max(call.input_chars, excluded.input_chars)`)
  const endCall = db.query(`
    update call set status = $status, error = $error, ended = $ended, result_chars = $resultChars,
      result_tokens = case when measured = 1 then result_tokens else $resultTokens end
    where session_id = $session and call_id = $call`)
  const setCallTokens = db.query(`
    update call set
      call_tokens = coalesce($callTokens, call_tokens),
      result_tokens = coalesce($resultTokens, result_tokens),
      measured = coalesce($measured, measured)
    where session_id = $session and call_id = $call`)
  const setCallTarget = db.query("update call set target = $target where session_id = $session and call_id = $call")
  const lastPosition = db.query<{ idx: number | null; epoch: number | null }, [string]>(
    "select max(idx) as idx, max(epoch) as epoch from step where session_id = ?",
  )
  const insertMark = db.query<{ id: number }, [number, string]>(
    "insert into mark (at, label) values (?, ?) returning id",
  )

  // An open request is `running`, never the column default: a request that has
  // not ended must not claim `completed` or `error`. Only `requestEnded` writes
  // the real terminal status, so a row that never received its terminal event
  // stays honestly open (ended NULL) instead of reporting a fabricated outcome.
  const upsertRequest = db.query(`
    insert into request (id, session_id, kind, is_title, agent, provider, model, variant, started, message_id, created, status)
    values ($id, $session, $kind, $isTitle, $agent, $provider, $model, $variant, $started, $message, $created, 'running')
    on conflict(id) do update set
      kind = excluded.kind,
      is_title = excluded.is_title,
      agent = coalesce(excluded.agent, request.agent),
      provider = coalesce(excluded.provider, request.provider),
      model = coalesce(excluded.model, request.model),
      variant = coalesce(excluded.variant, request.variant),
      message_id = coalesce(excluded.message_id, request.message_id)`)
  const updateRequestEnd = db.query(`
    update request set
      ended = $ended,
      duration = case when $duration is not null then $duration else ($ended - started) end,
      status = $status,
      error = $error,
      finish = $finish,
      input_tokens = coalesce($input, input_tokens),
      output_tokens = coalesce($output, output_tokens),
      reasoning_tokens = coalesce($reasoning, reasoning_tokens),
      cache_read_tokens = coalesce($cacheRead, cache_read_tokens),
      cache_write_tokens = coalesce($cacheWrite, cache_write_tokens),
      cost = coalesce($cost, cost),
      message_id = coalesce($message, message_id)
    where id = $id and observation is null`)
  const upsertFingerprint = db.query(`
    insert into request_fingerprint (request_id, session_id, protocol, system_parts, tools, options_hash, options_keys, message_prefixes, prefix_base, prefix_shared, prefix_depth, cache_key, cache_control, body_hash, created, previous_response_id, response_id, fingerprint_version, policy_version, system_hash)
    values ($requestId, $session, $protocol, $systemParts, $tools, $optionsHash, $optionsKeys, $messagePrefixes, $prefixBase, $prefixShared, $prefixDepth, $cacheKey, $cacheControl, $bodyHash, $created, $previousResponse, $response, $fingerprintVersion, $policyVersion, $systemHash)
    on conflict(request_id) do update set
      fingerprint_version = excluded.fingerprint_version,
      policy_version = excluded.policy_version,
      system_hash = excluded.system_hash,
      protocol = excluded.protocol,
      system_parts = excluded.system_parts,
      tools = excluded.tools,
      options_hash = excluded.options_hash,
      options_keys = excluded.options_keys,
      message_prefixes = excluded.message_prefixes,
      prefix_base = excluded.prefix_base,
      prefix_shared = excluded.prefix_shared,
      prefix_depth = excluded.prefix_depth,
      cache_key = excluded.cache_key,
      cache_control = excluded.cache_control,
      body_hash = excluded.body_hash,
      previous_response_id = excluded.previous_response_id,
      response_id = coalesce(excluded.response_id, request_fingerprint.response_id)`)
  const insertContextFact = db.query(`
    insert into context_fact (session_id, at, kind, detail)
    values ($session, $at, $kind, $detail)
    on conflict do nothing`)
  const updateLatestKind = db.query<void, [string, string, string, string]>(
    "update request set kind = ? where id = (select id from request where session_id = ? and kind in (?, ?) order by started desc, rowid desc limit 1)",
  )
  const findRequest = db.query<Record<string, unknown>, [string]>("select * from request where id = ?")
  const findSessionRequests = db.query<Record<string, unknown>, [string]>(
    "select *, rowid as ledger_order from request where session_id = ? order by started asc, rowid asc",
  )
  const findSessionRequestsBetween = db.query<Record<string, unknown>, [string, number, number]>(
    "select *, rowid as ledger_order from request where session_id = ? and started >= ? and started <= ? order by started asc, rowid asc",
  )
  const findFingerprint = db.query<Record<string, unknown>, [string]>(
    "select * from request_fingerprint where request_id = ?",
  )
  const fingerprintRow = db.query<Record<string, unknown>, [string]>(
    "select request_id, session_id, prefix_base, prefix_shared, prefix_depth, message_prefixes, created, rowid from request_fingerprint where request_id = ?",
  )
  const sessionFingerprintRows = db.query<Record<string, unknown>, [string]>(
    "select * from request_fingerprint where session_id = ? order by created asc, rowid asc",
  )
  const sessionFingerprintCount = db.query<{ n: number }, [string]>(
    "select count(*) as n from request_fingerprint where session_id = ?",
  )
  const lastSessionFingerprint = db.query<Record<string, unknown>, [string, string]>(
    "select request_id, prefix_base, prefix_shared, prefix_depth, message_prefixes from request_fingerprint where session_id = ? and request_id != ? order by created desc, rowid desc limit 1",
  )
  const fingerprintPosition = db.query<{ n: number }, [string, number, number, number]>(
    "select count(*) as n from request_fingerprint where session_id = ? and (created < ? or (created = ? and rowid < ?))",
  )
  const fingerprintBase = db.query<Record<string, unknown>, [string, number, number, number]>(
    "select request_id, prefix_base, prefix_shared, prefix_depth, message_prefixes from request_fingerprint where session_id = ? and (created < ? or (created = ? and rowid < ?)) order by created desc, rowid desc limit 1",
  )
  const fingerprintRun = db.query<Record<string, unknown>, [string, number, number, number]>(
    "select request_id, prefix_base, prefix_shared, prefix_depth, message_prefixes, created, rowid from request_fingerprint where session_id = ? and (created > ? or (created = ? and rowid >= ?)) order by created asc, rowid asc limit 64",
  )
  const updateFingerprintPrefix = db.query(
    "update request_fingerprint set message_prefixes = $prefixes, prefix_base = $base, prefix_shared = $shared, prefix_depth = $depth where request_id = $id",
  )
  const affectedFingerprintSessions = db.query<{ session_id: string }, [number]>(
    "select distinct session_id from request_fingerprint where created < ?",
  )
  const firstSurvivingFingerprint = db.query<{ request_id: string; prefix_base: string | null }, [string, number]>(
    "select request_id, prefix_base from request_fingerprint where session_id = ? and created >= ? order by created asc, rowid asc limit 1",
  )
  const sessionFingerprintChange = db.query<{ request_id: string; rev: number }, [string]>(
    "select request_id, rev from fingerprint_change where session_id = ?",
  )
  const restoreFingerprintChange = db.query(
    "insert into fingerprint_change (request_id, session_id, rev) values ($id, $session, $rev) on conflict(request_id) do update set session_id = excluded.session_id, rev = excluded.rev",
  )
  const deleteFingerprintChange = db.query("delete from fingerprint_change where request_id = ?")
  const findContextFacts = db.query<Record<string, unknown>, [string]>(
    "select * from context_fact where session_id = ? order by at asc, kind asc, detail asc",
  )
  // SQLite's own change counter for this connection advances on every write
  // this handle makes (including the rollup triggers and the few direct writes
  // outside this module). `data_version` changes when another connection or
  // process commits to the same file, so the pair covers both writers. Every
  // Plus instance in a process shares one handle via `ledgerAt`; a second
  // process (or a direct `createLedger`) is the other case.
  const totalChanges = db.query<{ n: number }, []>("select total_changes() as n")
  const dataVersion = db.query<{ data_version: number }, []>("pragma data_version")
  const sessionRevision = db.query<{ rev: number }, [string]>("select rev from session_change where session_id = ?")
  const changedFingerprints = db.query<{ request_id: string }, [number, string, number, string, number]>(
    `with recursive changed(request_id, descend) as (
      select request_id, prefix_rev > ? from fingerprint_change where session_id = ? and rev > ?
      union select request.id, 1 from request join analysis_reset on analysis_reset.session_id = request.session_id
        where request.session_id = ? and analysis_reset.entity = 'fingerprint' and analysis_reset.rev > ?
      union select request_fingerprint.request_id, 1 from request_fingerprint join changed on request_fingerprint.prefix_base = changed.request_id where changed.descend = 1
    ) select distinct request_id from changed`,
  )
  const analysisReset = db.query<{ rev: number }, [string, string]>(
    "select rev from analysis_reset where session_id = ? and entity = ?",
  )
  const changedRequests = db.query<Record<string, unknown>, [string, number]>(
    "select request.*, request.rowid as ledger_order from analysis_change join request on request.id = analysis_change.id where analysis_change.session_id = ? and analysis_change.entity = 'request' and analysis_change.rev > ? order by request.started, request.rowid",
  )
  const changedContextFacts = db.query<Record<string, unknown>, [string, number]>(
    "select context_fact.* from analysis_change join context_fact on context_fact.id = analysis_change.id where analysis_change.session_id = ? and analysis_change.entity = 'context_fact' and analysis_change.rev > ? order by context_fact.at, context_fact.id",
  )

  const writeCallTokens = db.transaction((updates: readonly CallTokens[]) => {
    updates.forEach((update) =>
      setCallTokens.run({
        $session: update.sessionID,
        $call: update.callID,
        $callTokens: update.callTokens ?? null,
        $resultTokens: update.resultTokens ?? null,
        $measured: update.measured === undefined ? null : update.measured ? 1 : 0,
      }),
    )
  })
  const startStep = db.transaction((step: StepStart) => {
    insertStep.run({
      $session: step.sessionID,
      $message: step.messageID,
      $kind: step.kind,
      $idx: step.idx,
      $epoch: step.epoch,
      $agent: step.agent ?? null,
      $provider: step.provider ?? null,
      $model: step.model ?? null,
      $variant: step.variant ?? null,
      $config: step.config ?? null,
      $started: step.started,
    })
    bumpEpoch.run({ $session: step.sessionID, $epoch: step.epoch, $idx: step.idx })
  })

  // -- Fingerprint message-list deltas (B35) --------------------------------
  //
  // Rows are ordered by (created, rowid). A keyframe (prefix_base null) holds
  // the full list; a delta names its base and stores only the entries after
  // prefix_shared equal entries. Every 64th row of a session, and its first, is
  // a keyframe, so a single-row read walks at most 63 bases and a session read
  // in order rebuilds each list from the one before it.
  const decodeTail = (row: Record<string, unknown>): MessagePrefixFingerprint[] =>
    JSON.parse(String(row.message_prefixes || "[]"))

  // Walk one row's chain back to its keyframe and rebuild the full list.
  const decodeFingerprintList = (row: Record<string, unknown>): MessagePrefixFingerprint[] => {
    const chain: Record<string, unknown>[] = []
    let current = row
    for (let depth = 0; current.prefix_base !== null && depth < 4096; depth++) {
      chain.push(current)
      const base = fingerprintRow.get(String(current.prefix_base))
      if (!base) break
      current = base
    }
    let list = decodeTail(current)
    for (let i = chain.length - 1; i >= 0; i--) {
      list = [...list.slice(0, Number(chain[i]!.prefix_shared ?? 0)), ...decodeTail(chain[i]!)]
    }
    return list
  }

  // The full list of a row held in memory: its stored tail is already full
  // when the row is a keyframe or a legacy row, otherwise walk its base.
  const fullListOf = (row: Record<string, unknown>): MessagePrefixFingerprint[] =>
    row.prefix_base === null ? decodeTail(row) : decodeFingerprintList(row)

  // Rebuild every list of a session in one ordered pass, using the previous
  // row for a delta and falling back to a walk only for a broken chain.
  const decodeSessionLists = (rows: readonly Record<string, unknown>[]): MessagePrefixFingerprint[][] => {
    const lists: MessagePrefixFingerprint[][] = []
    let previous: MessagePrefixFingerprint[] | undefined
    let previousId: string | undefined
    for (const row of rows) {
      const list =
        row.prefix_base === null
          ? decodeTail(row)
          : previous !== undefined && row.prefix_base === previousId
            ? [...previous.slice(0, Number(row.prefix_shared ?? 0)), ...decodeTail(row)]
            : decodeFingerprintList(row)
      lists.push(list)
      previous = list
      previousId = String(row.request_id)
    }
    return lists
  }

  // Persist one row's message list as a delta against `base`, or as a keyframe.
  const writeFingerprintDelta = (
    requestID: string,
    list: readonly MessagePrefixFingerprint[],
    keyframe: boolean,
    base: { id: string; depth: number; list: readonly MessagePrefixFingerprint[] } | undefined,
  ): void => {
    if (keyframe || base === undefined) {
      updateFingerprintPrefix.run({ $prefixes: JSON.stringify(list), $base: null, $shared: 0, $depth: 0, $id: requestID })
      return
    }
    const shared = sharedPrefix(base.list, list)
    updateFingerprintPrefix.run({
      $prefixes: JSON.stringify(list.slice(shared)),
      $base: base.id,
      $shared: shared,
      $depth: base.depth + 1,
      $id: requestID,
    })
  }

  // Rewrite every row of a session as a delta, keeping the 64-row keyframe
  // rule. Used for in-place migration and for a rare reordered insert. The
  // rewrite preserves each row's decoded list, so it restores the
  // `fingerprint_change` marks the update trigger added: an analysis cached
  // before the rewrite has the same data and must not reload it. `session_change`
  // still moves, which is the migration the caller reports.
  const reencodeSession = (sessionID: string): void => {
    const rows = sessionFingerprintRows.all(sessionID)
    if (rows.length === 0) return
    const marks = new Map(sessionFingerprintChange.all(sessionID).map((row) => [String(row.request_id), Number(row.rev)]))
    const lists = decodeSessionLists(rows)
    rows.forEach((row, i) =>
      writeFingerprintDelta(
        String(row.request_id),
        lists[i]!,
        i % KEYFRAME_INTERVAL === 0,
        i === 0 ? undefined : { id: String(rows[i - 1]!.request_id), depth: (i - 1) % KEYFRAME_INTERVAL, list: lists[i - 1]! },
      ),
    )
    for (const row of rows) {
      const requestID = String(row.request_id)
      const rev = marks.get(requestID)
      if (rev === undefined) deleteFingerprintChange.run(requestID)
      else restoreFingerprintChange.run(requestID, sessionID, rev)
    }
  }

  // The `upsertFingerprint` bindings, with the message-list columns given by
  // the encoding step rather than the caller's full list.
  const writeFingerprintRow = (
    fp: RequestFingerprintData,
    messagePrefixes: string,
    prefixBase: string | null,
    prefixShared: number | null,
    prefixDepth: number | null,
    created: number,
  ): void => {
    upsertFingerprint.run({
      $requestId: fp.requestID,
      $session: fp.sessionID,
      $protocol: fp.protocol,
      $fingerprintVersion: fp.fingerprintVersion ?? null,
      $policyVersion: fp.policyVersion ?? null,
      $systemHash: fp.systemHash ?? null,
      $systemParts: JSON.stringify(fp.systemParts),
      $tools: JSON.stringify(fp.tools),
      $optionsHash: fp.optionsHash,
      $optionsKeys: JSON.stringify(fp.optionsKeys),
      $messagePrefixes: messagePrefixes,
      $prefixBase: prefixBase,
      $prefixShared: prefixShared,
      $prefixDepth: prefixDepth,
      $cacheKey: fp.cacheKey ?? null,
      $previousResponse: fp.previousResponseId ?? null,
      $response: fp.responseId ?? null,
      $cacheControl: fp.cacheControl ? JSON.stringify(fp.cacheControl) : null,
      $bodyHash: fp.bodyHash,
      $created: created,
    })
  }

  // Store `fp` as a delta against the session's previous fingerprint. A row
  // whose list changed rewrites the rows that chain on it; a row inserted out
  // of order rewrites the session. One transaction.
  const storeFingerprint = db.transaction((fp: RequestFingerprintData) => {
    const created = fp.created ?? Date.now()
    const existing = fingerprintRow.get(fp.requestID)
    if (existing && existing.prefix_depth !== null) {
      const at = [Number(existing.created), Number(existing.created), Number(existing.rowid)] as const
      if (JSON.stringify(fullListOf(existing)) === JSON.stringify(fp.messagePrefixes)) {
        // The list is unchanged: keep the stored delta and just refresh the
        // other columns, so no chained row is rewritten.
        writeFingerprintRow(
          fp,
          String(existing.message_prefixes),
          existing.prefix_base as string | null,
          existing.prefix_shared as number | null,
          existing.prefix_depth as number | null,
          Number(existing.created),
        )
        return
      }
      const position = fingerprintPosition.get(fp.sessionID, ...at)?.n ?? 0
      const baseRow = fingerprintBase.get(fp.sessionID, ...at)
      const base =
        baseRow === null
          ? undefined
          : { id: String(baseRow.request_id), depth: Number(baseRow.prefix_depth ?? 0), list: fullListOf(baseRow) }
      const nextKeyframe = position - (position % KEYFRAME_INTERVAL) + KEYFRAME_INTERVAL
      const run = fingerprintRun.all(fp.sessionID, ...at).slice(0, nextKeyframe - position)
      // Decode the run's current lists through its own chain before any rewrite.
      const runLists = decodeSessionLists(run)
      let previous: { id: string; depth: number; list: readonly MessagePrefixFingerprint[] } | undefined = base
      run.forEach((row, index) => {
        const keyframe = (position + index) % KEYFRAME_INTERVAL === 0
        const list: readonly MessagePrefixFingerprint[] = index === 0 ? fp.messagePrefixes : runLists[index]!
        const shared = previous === undefined ? 0 : sharedPrefix(previous.list, list)
        const depth = previous === undefined ? 0 : previous.depth + 1
        const encoded = keyframe || previous === undefined ? JSON.stringify(list) : JSON.stringify(list.slice(shared))
        if (index === 0) {
          writeFingerprintRow(
            fp,
            encoded,
            keyframe || previous === undefined ? null : previous.id,
            keyframe || previous === undefined ? 0 : shared,
            keyframe ? 0 : depth,
            Number(existing.created),
          )
        } else {
          writeFingerprintDelta(String(row.request_id), list, keyframe, previous)
        }
        previous = { id: String(row.request_id), depth: keyframe ? 0 : depth, list }
      })
      return
    }
    // A new row. The fast path appends at the end of the session; an insert
    // that reorders the session rewrites it in one pass.
    const last = lastSessionFingerprint.get(fp.sessionID, fp.requestID)
    if (last && Number(last.created ?? 0) > created) {
      writeFingerprintRow(fp, JSON.stringify(fp.messagePrefixes), null, 0, 0, created)
      reencodeSession(fp.sessionID)
      return
    }
    const keyframe = (sessionFingerprintCount.get(fp.sessionID)?.n ?? 0) % KEYFRAME_INTERVAL === 0
    writeFingerprintRow(fp, JSON.stringify(fp.messagePrefixes), null, 0, 0, created)
    if (keyframe || last === null) return
    writeFingerprintDelta(fp.requestID, fp.messagePrefixes, false, {
      id: String(last.request_id),
      depth: Number(last.prefix_depth ?? 0),
      list: fullListOf(last),
    })
  })

  let lastIncremental = 0
  const ledger: Ledger = {
    db,
    path: file,
    session: (facts, now) =>
      upsertSession.run({
        $id: facts.id,
        $parent: facts.parentID ?? null,
        $agent: facts.agent ?? null,
        $title: facts.title ?? null,
        $directory: facts.directory ?? null,
        $run: facts.runID ?? null,
        $role: facts.role ?? null,
        $team: facts.team ?? null,
        $now: now,
      }),
    stepStarted: (step) => startStep(step),
    stepEnded: (sessionID, messageID, ended, finish, usage) =>
      endStep.run({
        $session: sessionID,
        $message: messageID,
        $ended: ended,
        $finish: finish,
        $input: usage.input,
        $output: usage.output,
        $reasoning: usage.reasoning,
        $cacheRead: usage.cacheRead,
        $cacheWrite: usage.cacheWrite,
        $cost: usage.cost,
      }),
    callStarted: (call) =>
      insertCall.run({
        $session: call.sessionID,
        $call: call.callID,
        $message: call.messageID,
        $parent: call.parentCall ?? null,
        $idx: call.idx,
        $epoch: call.epoch,
        $agent: call.agent ?? null,
        $model: call.model ?? null,
        $config: call.config ?? null,
        $tool: call.tool,
        $target: call.target ?? null,
        $status: call.status,
        $started: call.started,
        $inputChars: call.inputChars,
      }),
    callEnded: (end) =>
      endCall.run({
        $session: end.sessionID,
        $call: end.callID,
        $status: end.status,
        // The owning boundary hashes any error so no caller can persist text.
        $error: end.error === undefined ? null : errorFingerprint(end.error),
        $ended: end.ended,
        $resultChars: end.resultChars,
        $resultTokens: end.resultTokens,
      }),
    callTokens: (updates) => writeCallTokens(updates),
    callTarget: (sessionID, callID, target) =>
      setCallTarget.run({ $session: sessionID, $call: callID, $target: target }),
    position: (sessionID) => {
      const row = lastPosition.get(sessionID)
      return { idx: row?.idx ?? -1, epoch: row?.epoch ?? 0 }
    },
    mark: (label, at) => insertMark.get(at, label)?.id ?? 0,
    prune: (before) => {
      const archives = db.query<{ path: string }, [number]>(`select distinct path from cache_wire where request_id in
        (select id from request where started < ?)`).all(before)
      db.transaction(() => {
        // Before rows go, the first surviving row of each affected session
        // becomes a keyframe, so no chain points at a deleted base. Decode it
        // through its chain while that chain is still whole.
        affectedFingerprintSessions.all(before).forEach(({ session_id }) => {
          const first = firstSurvivingFingerprint.get(session_id, before)
          if (first === null || first.prefix_base === null) return
          const row = fingerprintRow.get(first.request_id)
          if (row === null) return
          updateFingerprintPrefix.run({
            $prefixes: JSON.stringify(decodeFingerprintList(row)),
            $base: null,
            $shared: 0,
            $depth: 0,
            $id: first.request_id,
          })
        })
        db.query("delete from call where started < ?").run(before)
        db.query("delete from step where started < ?").run(before)
        db.query("delete from cache_wire where request_id in (select id from request where started < ?)").run(before)
        db.query("delete from cache_result where started < ?").run(before)
        // Saved unread writes and changed segments; their modules create the tables on first use.
        if (db.query("select 1 from sqlite_master where type = 'table' and name = 'unread_write'").get())
          db.query("delete from unread_write where at < ?").run(before)
        if (db.query("select 1 from sqlite_master where type = 'table' and name = 'request_change'").get())
          db.query("delete from request_change where started < ?").run(before)
        db.query("delete from request where started < ?").run(before)
        db.query("delete from request_fingerprint where created < ?").run(before)
        db.query("delete from context_fact where at < ?").run(before)
        db.query("delete from mark where at < ?").run(before)
        db.query(
          "delete from session where last_seen < ? and id not in (select session_id from step) and id not in (select session_id from request)",
        ).run(before)
        db.query("delete from epoch where session_id not in (select distinct session_id from step)").run()
        db.query("delete from call_hour where calls = 0 and inner = 0 and running = 0").run()
        // A deleted fingerprint's mark tells a cached analysis to drop it; once its
        // request is gone too, no analysis reads it any more.
        db.query(
          "delete from fingerprint_change where request_id not in (select request_id from request_fingerprint) and request_id not in (select id from request)",
        ).run()
      })()
      archives.forEach((archive) => {
        if (!db.query("select 1 from cache_wire where path = ? limit 1").get(archive.path)) fs.rmSync(archive.path, { force: true })
      })
      // Returning freed pages to disk is cheap but not free, and pruning runs
      // every couple of minutes: do it at most hourly, and only when the file
      // is mostly free space. A full `VACUUM` never runs here: it rewrites the
      // whole file, and that has its own worker at monitor start.
      const clock = options.now ?? Date.now
      const at = clock()
      if (at - lastIncremental < (options.incrementalEvery ?? INCREMENTAL_EVERY)) return
      const pages = db.query<{ page_count: number }, []>("pragma page_count").get()?.page_count ?? 0
      const free = db.query<{ freelist_count: number }, []>("pragma freelist_count").get()?.freelist_count ?? 0
      if (pages === 0 || free / pages <= (options.compactShare ?? COMPACT_SHARE)) return
      lastIncremental = at
      db.exec(`pragma incremental_vacuum(${options.incrementalPages ?? INCREMENTAL_PAGES})`)
    },
    requestStarted: (req) =>
      upsertRequest.run({
        $id: req.id,
        $session: req.sessionID,
        $kind: req.kind,
        $isTitle: req.isTitle ? 1 : 0,
        $agent: req.agent ?? null,
        $provider: req.provider ?? null,
        $model: req.model ?? null,
        $variant: req.variant ?? null,
        $started: req.started,
        $message: req.messageID ?? null,
        $created: req.created ?? req.started,
      }),
    requestEnded: (id, end) =>
      updateRequestEnd.run({
        $id: id,
        $ended: end.ended,
        $duration: end.duration ?? null,
        $status: end.status,
        $finish: end.finish ?? null,
        $error: end.error ? end.error === "retried" ? "retried" : errorFingerprint(end.error) : null,
        $input: end.usage?.input ?? null,
        $output: end.usage?.output ?? null,
        $reasoning: end.usage?.reasoning ?? null,
        $cacheRead: end.usage?.cacheRead ?? null,
        $cacheWrite: end.usage?.cacheWrite ?? null,
        $cost: end.usage?.cost ?? null,
        $message: end.messageID ?? null,
      }),
    requestFingerprint: (fp) => storeFingerprint(fp),
    requestObserved: (id, observation) => {
      const clean = Schema.decodeUnknownSync(Observation)(observation)
      if (clean.inputTokens !== undefined && clean.provenance?.inputTokens?.completeness === "partial")
        throw new Error("Partial input total cannot supply an inclusive measurement")
      const request = findRequest.get(id)
      if (request?.observation !== null && request?.observation !== undefined) return
      if (!request || request.ended === null)
        throw new Error("Monitor observation requires an ended request")
      // Unknown payloads belong to a newer writer; duplicates are first-observation-wins.
      db.query("update request set observation = ? where id = ? and observation is null").run(JSON.stringify(inconsistentObservation(clean) ? { ...clean, inconsistent: true } : clean), id)
    },
    contextFact: (fact) =>
      insertContextFact.run({
        $session: fact.sessionID,
        $at: fact.at,
        $kind: fact.kind,
        $detail: JSON.stringify(fact.detail ?? {}),
      }),
    relabelLatestRequest: (sessionID, fromKind, toKind) => {
      updateLatestKind.run(toKind, sessionID, fromKind, toKind)
    },
    getRequest: (id) => {
      const row = findRequest.get(id)
      return row ? toRequestRow(row) : undefined
    },
    getRequests: (sessionID) => findSessionRequests.all(sessionID).map(toRequestRow),
    getRequestsBetween: (sessionID, from, to) => findSessionRequestsBetween.all(sessionID, from, to).map(toRequestRow),
    getFingerprint: (requestID) => {
      const row = findFingerprint.get(requestID)
      if (!row) return undefined
      return toFingerprintData(row, decodeFingerprintList(row))
    },
    getFingerprints: (sessionID) => {
      const rows = sessionFingerprintRows.all(sessionID)
      const lists = decodeSessionLists(rows)
      // A legacy file's rows hold full lists and null prefix columns. Reading
      // the session migrates it in place, once: the next read finds no legacy
      // row and writes nothing.
      if (rows.some((row) => row.prefix_depth === null)) db.transaction(() => reencodeSession(sessionID))()
      return rows.map((row, index) => toFingerprintData(row, lists[index]!))
    },
    getContextFacts: (sessionID) => findContextFacts.all(sessionID).map(toContextFactRow),
    revision: () => `${totalChanges.get()?.n ?? 0}:${dataVersion.get()?.data_version ?? 0}`,
    sessionRevision: (sessionID) => sessionRevision.get(sessionID)?.rev ?? 0,
    changedFingerprints: (sessionID, since) => changedFingerprints.all(since, sessionID, since, sessionID, since).map((row) => row.request_id),
    changedRequests: (sessionID, since) => (analysisReset.get(sessionID, "request")?.rev ?? 0) > since
      ? undefined : changedRequests.all(sessionID, since).map(toRequestRow),
    changedContextFacts: (sessionID, since) => (analysisReset.get(sessionID, "context_fact")?.rev ?? 0) > since
      ? undefined : changedContextFacts.all(sessionID, since).map(toContextFactRow),
    close: () => {
      stopCacheBackfill(ledger)
      open.delete(file)
      db.close()
    },
  }
  return ledger
}

function toRequestRow(row: Record<string, unknown>): RequestRow {
  return Object.defineProperty({
    id: String(row.id),
    sessionID: String(row.session_id),
    kind: String(row.kind),
    isTitle: Boolean(row.is_title),
    agent: typeof row.agent === "string" ? row.agent : undefined,
    provider: typeof row.provider === "string" ? row.provider : undefined,
    model: typeof row.model === "string" ? row.model : undefined,
    variant: typeof row.variant === "string" ? row.variant : undefined,
    started: Number(row.started),
    ended: row.ended !== null && row.ended !== undefined ? Number(row.ended) : undefined,
    duration: row.duration !== null && row.duration !== undefined ? Number(row.duration) : undefined,
    status: String(row.status ?? "completed"),
    finish: typeof row.finish === "string" ? row.finish : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    reasoningTokens: Number(row.reasoning_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    cost: Number(row.cost ?? 0),
    messageID: typeof row.message_id === "string" ? row.message_id : undefined,
    created: Number(row.created ?? row.started),
    observation: typeof row.observation === "string" ? readObservation(row.observation) : undefined,
  }, "ledgerOrder", { value: Number(row.ledger_order ?? 0) })
}

function toFingerprintData(row: Record<string, unknown>, messagePrefixes: readonly MessagePrefixFingerprint[]): RequestFingerprintData {
  return {
    ...(typeof row.fingerprint_version === "number" ? { fingerprintVersion: row.fingerprint_version } : {}),
    ...(typeof row.policy_version === "number" ? { policyVersion: row.policy_version } : {}),
    ...(typeof row.system_hash === "string" ? { systemHash: row.system_hash } : {}),
    requestID: String(row.request_id),
    sessionID: String(row.session_id),
    protocol: String(row.protocol),
    systemParts: JSON.parse(String(row.system_parts || "[]")),
    tools: JSON.parse(String(row.tools || "[]")),
    optionsHash: String(row.options_hash || ""),
    optionsKeys: JSON.parse(String(row.options_keys || "{}")),
    messagePrefixes,
    cacheKey: typeof row.cache_key === "string" ? row.cache_key : undefined,
    previousResponseId: typeof row.previous_response_id === "string" ? row.previous_response_id : undefined,
    responseId: typeof row.response_id === "string" ? row.response_id : undefined,
    cacheControl: typeof row.cache_control === "string" ? JSON.parse(row.cache_control) : undefined,
    bodyHash: String(row.body_hash || ""),
    created: Number(row.created ?? 0),
  }
}

function toContextFactRow(row: Record<string, unknown>): ContextFactRow {
  return Object.defineProperty({
    id: Number(row.id),
    sessionID: String(row.session_id),
    at: Number(row.at),
    kind: String(row.kind),
    detail: row.detail ? JSON.parse(String(row.detail)) : {},
  }, "ledgerDetail", { value: String(row.detail ?? "{}") })
}
