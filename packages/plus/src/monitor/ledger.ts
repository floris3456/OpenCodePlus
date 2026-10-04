// The monitor's durable ledger: one SQLite file shared by every Plus instance
// in the process (and any other process pointed at the same data directory).
//
// It stores irreducible facts only: steps (one LLM call each) with their
// token usage, tool calls with their sizes and attributed tokens, sessions
// with their parent links, compaction epochs and user marks. Everything the
// monitor shows (carried tokens, groupings, comparisons) is derived at query
// time. Tool outputs, file contents and full commands are never stored.
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { teamsDataDir } from "../instructions/paths.js"
import type {
  CacheControlMarker,
  MessagePrefixFingerprint,
  SystemPartFingerprint,
  ToolFingerprint,
} from "./fingerprint.js"

export const RETENTION_DAYS = 90

const SCHEMA_VERSION = 2

export const HOUR = 3_600_000

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

create table if not exists request_fingerprint (
  request_id text primary key,
  session_id text not null,
  protocol text not null,
  system_parts text not null default '[]',
  tools text not null default '[]',
  options_hash text not null default '',
  options_keys text not null default '{}',
  message_prefixes text not null default '[]',
  cache_key text,
  cache_control text,
  body_hash text not null,
  created integer not null
);
create index if not exists request_fingerprint_session on request_fingerprint(session_id, created);

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
  readonly error?: string
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
  readonly status: "completed" | "error"
  readonly error?: string
  readonly usage?: Usage
  readonly messageID?: string
}

export interface RequestRow {
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
  readonly error?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly cost: number
  readonly messageID?: string
  readonly created: number
}

export interface RequestFingerprintData {
  readonly requestID: string
  readonly sessionID: string
  readonly protocol: string
  readonly systemParts: readonly SystemPartFingerprint[]
  readonly tools: readonly ToolFingerprint[]
  readonly optionsHash: string
  readonly optionsKeys: Record<string, string>
  readonly messagePrefixes: readonly MessagePrefixFingerprint[]
  readonly cacheKey?: string
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

export interface ContextFactRow extends ContextFact {
  readonly id: number
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
  requestStarted(req: RequestStart): void
  requestEnded(id: string, end: RequestEnd): void
  requestFingerprint(fp: RequestFingerprintData): void
  contextFact(fact: ContextFact): void
  oldestOpenRequest(sessionID: string, kind: string): RequestRow | undefined
  retireOpenRequests(sessionID: string, kind: string, exceptId?: string): void
  relabelLatestRequest(sessionID: string, fromKind: string, toKind: string): void
  getRequest(id: string): RequestRow | undefined
  getRequests(sessionID: string): readonly RequestRow[]
  getFingerprint(requestID: string): RequestFingerprintData | undefined
  getFingerprints(sessionID: string): readonly RequestFingerprintData[]
  getContextFacts(sessionID: string): readonly ContextFactRow[]
}

/** `monitor.db` next to the teams data, under the XDG data directory. */
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

export function createLedger(file: string): Ledger {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.exec("pragma journal_mode = wal")
  db.exec("pragma synchronous = normal")
  db.exec("pragma busy_timeout = 2000")
  db.exec(schema)
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

  const upsertRequest = db.query(`
    insert into request (id, session_id, kind, is_title, agent, provider, model, variant, started, message_id, created)
    values ($id, $session, $kind, $isTitle, $agent, $provider, $model, $variant, $started, $message, $created)
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
      input_tokens = coalesce($input, input_tokens),
      output_tokens = coalesce($output, output_tokens),
      reasoning_tokens = coalesce($reasoning, reasoning_tokens),
      cache_read_tokens = coalesce($cacheRead, cache_read_tokens),
      cache_write_tokens = coalesce($cacheWrite, cache_write_tokens),
      cost = coalesce($cost, cost),
      message_id = coalesce($message, message_id)
    where id = $id`)
  const upsertFingerprint = db.query(`
    insert into request_fingerprint (request_id, session_id, protocol, system_parts, tools, options_hash, options_keys, message_prefixes, cache_key, cache_control, body_hash, created)
    values ($requestId, $session, $protocol, $systemParts, $tools, $optionsHash, $optionsKeys, $messagePrefixes, $cacheKey, $cacheControl, $bodyHash, $created)
    on conflict(request_id) do update set
      protocol = excluded.protocol,
      system_parts = excluded.system_parts,
      tools = excluded.tools,
      options_hash = excluded.options_hash,
      options_keys = excluded.options_keys,
      message_prefixes = excluded.message_prefixes,
      cache_key = excluded.cache_key,
      cache_control = excluded.cache_control,
      body_hash = excluded.body_hash`)
  const insertContextFact = db.query(`
    insert into context_fact (session_id, at, kind, detail)
    values ($session, $at, $kind, $detail)
    on conflict do nothing`)
  const findOldestOpenRequest = db.query<Record<string, unknown>, [string, string]>(
    "select * from request where session_id = ? and kind = ? and ended is null order by started asc limit 1",
  )
  const retireEarlierOpenRequests = db.query<void, [number, number, string, string, string]>(
    "update request set ended = ?, status = 'error', error = 'retried', duration = (? - started) where session_id = ? and kind = ? and ended is null and id != ?",
  )
  const retireAllOpenRequests = db.query<void, [number, number, string, string]>(
    "update request set ended = ?, status = 'error', error = 'retried', duration = (? - started) where session_id = ? and kind = ? and ended is null",
  )
  const updateLatestKind = db.query<void, [string, string, string]>(
    "update request set kind = ? where id = (select id from request where session_id = ? and kind = ? order by started desc limit 1)",
  )
  const findRequest = db.query<Record<string, unknown>, [string]>("select * from request where id = ?")
  const findSessionRequests = db.query<Record<string, unknown>, [string]>(
    "select * from request where session_id = ? order by started asc",
  )
  const findFingerprint = db.query<Record<string, unknown>, [string]>(
    "select * from request_fingerprint where request_id = ?",
  )
  const findSessionFingerprints = db.query<Record<string, unknown>, [string]>(
    "select * from request_fingerprint where session_id = ? order by created asc",
  )
  const findContextFacts = db.query<Record<string, unknown>, [string]>(
    "select * from context_fact where session_id = ? order by at asc",
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

  return {
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
        $error: end.error ?? null,
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
      db.transaction(() => {
        db.query("delete from call where started < ?").run(before)
        db.query("delete from step where started < ?").run(before)
        db.query("delete from request where started < ?").run(before)
        db.query("delete from request_fingerprint where created < ?").run(before)
        db.query("delete from context_fact where at < ?").run(before)
        db.query("delete from mark where at < ?").run(before)
        db.query(
          "delete from session where last_seen < ? and id not in (select session_id from step) and id not in (select session_id from request)",
        ).run(before)
        db.query("delete from epoch where session_id not in (select distinct session_id from step)").run()
        db.query("delete from call_hour where calls = 0 and inner = 0 and running = 0").run()
      })()
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
        $error: end.error ? end.error.slice(0, 160) : null,
        $input: end.usage?.input ?? null,
        $output: end.usage?.output ?? null,
        $reasoning: end.usage?.reasoning ?? null,
        $cacheRead: end.usage?.cacheRead ?? null,
        $cacheWrite: end.usage?.cacheWrite ?? null,
        $cost: end.usage?.cost ?? null,
        $message: end.messageID ?? null,
      }),
    requestFingerprint: (fp) =>
      upsertFingerprint.run({
        $requestId: fp.requestID,
        $session: fp.sessionID,
        $protocol: fp.protocol,
        $systemParts: JSON.stringify(fp.systemParts),
        $tools: JSON.stringify(fp.tools),
        $optionsHash: fp.optionsHash,
        $optionsKeys: JSON.stringify(fp.optionsKeys),
        $messagePrefixes: JSON.stringify(fp.messagePrefixes),
        $cacheKey: fp.cacheKey ?? null,
        $cacheControl: fp.cacheControl ? JSON.stringify(fp.cacheControl) : null,
        $bodyHash: fp.bodyHash,
        $created: fp.created ?? Date.now(),
      }),
    contextFact: (fact) =>
      insertContextFact.run({
        $session: fact.sessionID,
        $at: fact.at,
        $kind: fact.kind,
        $detail: JSON.stringify(fact.detail ?? {}),
      }),
    oldestOpenRequest: (sessionID, kind) => {
      const row = findOldestOpenRequest.get(sessionID, kind)
      return row ? toRequestRow(row) : undefined
    },
    retireOpenRequests: (sessionID, kind, exceptId) => {
      const now = Date.now()
      if (exceptId) {
        retireEarlierOpenRequests.run(now, now, sessionID, kind, exceptId)
      } else {
        retireAllOpenRequests.run(now, now, sessionID, kind)
      }
    },
    relabelLatestRequest: (sessionID, fromKind, toKind) => {
      updateLatestKind.run(toKind, sessionID, fromKind)
    },
    getRequest: (id) => {
      const row = findRequest.get(id)
      return row ? toRequestRow(row) : undefined
    },
    getRequests: (sessionID) => findSessionRequests.all(sessionID).map(toRequestRow),
    getFingerprint: (requestID) => {
      const row = findFingerprint.get(requestID)
      return row ? toFingerprintData(row) : undefined
    },
    getFingerprints: (sessionID) => findSessionFingerprints.all(sessionID).map(toFingerprintData),
    getContextFacts: (sessionID) => findContextFacts.all(sessionID).map(toContextFactRow),
    close: () => {
      open.delete(file)
      db.close()
    },
  }
}

function toRequestRow(row: Record<string, unknown>): RequestRow {
  return {
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
    error: typeof row.error === "string" ? row.error : undefined,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    reasoningTokens: Number(row.reasoning_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    cost: Number(row.cost ?? 0),
    messageID: typeof row.message_id === "string" ? row.message_id : undefined,
    created: Number(row.created ?? row.started),
  }
}

function toFingerprintData(row: Record<string, unknown>): RequestFingerprintData {
  return {
    requestID: String(row.request_id),
    sessionID: String(row.session_id),
    protocol: String(row.protocol),
    systemParts: JSON.parse(String(row.system_parts || "[]")),
    tools: JSON.parse(String(row.tools || "[]")),
    optionsHash: String(row.options_hash || ""),
    optionsKeys: JSON.parse(String(row.options_keys || "{}")),
    messagePrefixes: JSON.parse(String(row.message_prefixes || "[]")),
    cacheKey: typeof row.cache_key === "string" ? row.cache_key : undefined,
    cacheControl: typeof row.cache_control === "string" ? JSON.parse(row.cache_control) : undefined,
    bodyHash: String(row.body_hash || ""),
    created: Number(row.created ?? 0),
  }
}

function toContextFactRow(row: Record<string, unknown>): ContextFactRow {
  return {
    id: Number(row.id),
    sessionID: String(row.session_id),
    at: Number(row.at),
    kind: String(row.kind),
    detail: row.detail ? JSON.parse(String(row.detail)) : {},
  }
}
