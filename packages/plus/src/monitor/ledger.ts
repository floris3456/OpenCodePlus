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

export const RETENTION_DAYS = 90

const SCHEMA_VERSION = 1

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
`

export interface SessionFacts {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
  readonly title?: string
  readonly directory?: string
  readonly runID?: string
  readonly role?: string
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
  db.query(
    "insert into meta (key, value) values ('schema', ?) on conflict(key) do update set value = excluded.value",
  ).run(String(SCHEMA_VERSION))

  const upsertSession = db.query(`
    insert into session (id, parent_id, agent, title, directory, run_id, role, first_seen, last_seen)
    values ($id, $parent, $agent, $title, $directory, $run, $role, $now, $now)
    on conflict(id) do update set
      parent_id = coalesce(excluded.parent_id, session.parent_id),
      agent = coalesce(excluded.agent, session.agent),
      title = coalesce(excluded.title, session.title),
      directory = coalesce(excluded.directory, session.directory),
      run_id = coalesce(excluded.run_id, session.run_id),
      role = coalesce(excluded.role, session.role),
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
        db.query("delete from mark where at < ?").run(before)
        db.query("delete from session where last_seen < ? and id not in (select session_id from step)").run(before)
        db.query("delete from epoch where session_id not in (select distinct session_id from step)").run()
        db.query("delete from call_hour where calls = 0 and inner = 0 and running = 0").run()
      })()
    },
    close: () => {
      open.delete(file)
      db.close()
    },
  }
}
