import { randomBytes } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Option } from "effect"
import { toolError } from "./schema.js"
import type { AttemptState, RunState } from "./schema.js"
import { atomicJson, lock, readJson } from "./store.js"
import { append } from "./audit.js"
import { errCode, io } from "./io.js"

export type RunKind = "main" | "w"

export interface AttemptRecord {
  n: number
  state: AttemptState
  startedAt: string
  trigger: string
  prompt?: string
  endedAt?: string
}

export interface HistoryEntry {
  at: string
  from: RunState
  to: RunState
  trigger: string
}

export interface RunBudget {
  turns?: number
  tokens?: number
  wallMs?: number
}

export interface RunRecord {
  id: string
  role: string
  kind: RunKind
  repo: string
  repoKey: string
  directory: string
  branch: string
  base: string
  head: string
  state: RunState
  attempts: AttemptRecord[]
  task: string | null
  parent: string | null
  children: string[]
  briefSha: string
  bundle: string
  budget: RunBudget
  createdAt: string
  lastUsed: string
  sessionID: string | null
  configDigest: string | null
  supersededReason?: string
  history: HistoryEntry[]
}

export interface TransitionCtx {
  force?: boolean
  reason?: string
  [k: string]: unknown
}

export interface RunTransitionRow {
  /** null = "—" (no prior state; creation via delegate / plan_handoff / CLI new). */
  from: RunState | null
  to: RunState
  trigger: string
  guard?: string
}

// Every row of docs/team-v2/02-state-machines.md §1, in table order.
// Multi-valued cells are expanded to one row per from/trigger so that
// iterating TRANSITIONS covers the table exactly.
export const TRANSITIONS: RunTransitionRow[] = [
  // — → created
  { from: null, to: "created", trigger: "delegate", guard: "Brief valid; bounds ok" },
  { from: null, to: "created", trigger: "plan_handoff", guard: "Brief valid; bounds ok" },
  { from: null, to: "created", trigger: "new", guard: "Brief valid; bounds ok" },
  // created → preparing
  { from: "created", to: "preparing", trigger: "immediately", guard: "repo git lock acquired" },
  // preparing → ready / dead
  {
    from: "preparing",
    to: "ready",
    trigger: "worktree_ready",
    guard: "after_create exit 0 within hooks.timeoutMs",
  },
  { from: "preparing", to: "dead", trigger: "hook_failed" },
  // ready → starting (admit / resume)
  { from: "ready", to: "starting", trigger: "admit", guard: "slot available (bounds.inFlight)" },
  { from: "ready", to: "starting", trigger: "resume", guard: "slot available (bounds.inFlight)" },
  // starting → idle / dead
  {
    from: "starting",
    to: "idle",
    trigger: "connected",
    guard: "MCP team and team-query both connected within startTimeoutMs",
  },
  { from: "starting", to: "dead", trigger: "start_failed" },
  // idle → working
  { from: "idle", to: "working", trigger: "prompt" },
  // working → idle
  { from: "working", to: "idle", trigger: "turn_ended" },
  // working → blocked_input
  { from: "working", to: "blocked_input", trigger: "permission_request" },
  // blocked_input → working
  { from: "blocked_input", to: "working", trigger: "answered" },
  // idle → stopping
  { from: "idle", to: "stopping", trigger: "shutdown", guard: "no active turn" },
  // working → stopping (CLI stop --force only)
  { from: "working", to: "stopping", trigger: "stop_force", guard: "human" },
  // stopping → stopped
  { from: "stopping", to: "stopped", trigger: "exited" },
  // stopped → starting (resume / followup(queue) / wait-triggered nudge)
  { from: "stopped", to: "starting", trigger: "resume", guard: "slot available" },
  { from: "stopped", to: "starting", trigger: "followup", guard: "slot available" },
  { from: "stopped", to: "starting", trigger: "nudge", guard: "slot available" },
  // idle/working → dead (liveness probe fails x2)
  { from: "idle", to: "dead", trigger: "probe_failed" },
  { from: "working", to: "dead", trigger: "probe_failed" },
  // dead → starting (replaces registration)
  { from: "dead", to: "starting", trigger: "resume" },
  // dead → stopped (reconciler after deadGraceMs with no parent action)
  {
    from: "dead",
    to: "stopped",
    trigger: "reconcile",
    guard: "past deadGraceMs with no parent action",
  },
  // any non-terminal → superseded
  { from: "created", to: "superseded", trigger: "supersede", guard: "run not working" },
  { from: "preparing", to: "superseded", trigger: "supersede", guard: "run not working" },
  { from: "ready", to: "superseded", trigger: "supersede", guard: "run not working" },
  { from: "starting", to: "superseded", trigger: "supersede", guard: "run not working" },
  { from: "idle", to: "superseded", trigger: "supersede", guard: "run not working" },
  {
    from: "working",
    to: "superseded",
    trigger: "supersede",
    guard: "force:true after shutdown_request timed out",
  },
  { from: "blocked_input", to: "superseded", trigger: "supersede", guard: "run not working" },
  { from: "stopping", to: "superseded", trigger: "supersede", guard: "run not working" },
  { from: "stopped", to: "superseded", trigger: "supersede", guard: "run not working" },
  { from: "dead", to: "superseded", trigger: "supersede", guard: "run not working" },
  // stopped/superseded → reaped (gc)
  {
    from: "stopped",
    to: "reaped",
    trigger: "gc",
    guard: "age >= gc.reapAfter, not referenced by open merge entry, not promoted-from",
  },
  {
    from: "superseded",
    to: "reaped",
    trigger: "gc",
    guard: "age >= gc.reapAfter, not referenced by open merge entry, not promoted-from",
  },
]

export function newRunID(kind: "main" | "w"): string {
  return `${kind}-${randomBytes(8).toString("hex")}`
}

export function canTransition(
  from: RunState | null,
  to: RunState,
  trigger: string,
  ctx?: TransitionCtx,
): boolean {
  const row = TRANSITIONS.find((r) => r.from === from && r.to === to && r.trigger === trigger)
  if (!row) return false
  // 02 §1 guard: supersede from working requires force:true.
  if (row.from === "working" && row.to === "superseded" && !ctx?.force) return false
  return true
}

export function transition(run: RunRecord, to: RunState, trigger: string, ctx?: TransitionCtx): RunRecord {
  if (!canTransition(run.state, to, trigger, ctx)) {
    const legal = [...new Set(TRANSITIONS.filter((r) => r.from === run.state).map((r) => r.to))]
    throw toolError(
      "E_TRANSITION",
      `Run ${run.id} cannot go ${run.state} → ${to} on "${trigger}". ` +
        `Legal targets from ${run.state}: [${legal.join(", ")}].`,
      legal,
    )
  }
  const at = new Date().toISOString()
  const next: RunRecord = {
    ...run,
    state: to,
    lastUsed: at,
    attempts: [...run.attempts],
    children: [...run.children],
    history: [...run.history, { at, from: run.state, to, trigger }],
  }
  if (to === "superseded" && ctx?.reason !== undefined) {
    next.supersededReason = String(ctx.reason)
  }
  return next
}

/** 02 §1: only superseded and reaped are terminal (stopped and dead are NOT). */
export function isTerminal(state: RunState): boolean {
  return state === "superseded" || state === "reaped"
}

export interface AttemptTransitionRow {
  from: AttemptState
  to: AttemptState
  trigger: string
}

// Every path of docs/team-v2/02-state-machines.md §2:
// queued → admitted → streaming → finishing → terminal,
// plus failed/interrupted/timed_out/stalled reachable from any non-terminal.
export const ATTEMPT_TRANSITIONS: AttemptTransitionRow[] = [
  { from: "queued", to: "admitted", trigger: "admit" },
  { from: "admitted", to: "streaming", trigger: "first_event" },
  { from: "streaming", to: "finishing", trigger: "finish" },
  { from: "finishing", to: "succeeded", trigger: "validated" },
  { from: "finishing", to: "reported", trigger: "validated" },
  { from: "finishing", to: "no_report", trigger: "validated" },
  { from: "finishing", to: "failed", trigger: "failed" },
  { from: "finishing", to: "interrupted", trigger: "interrupt" },
  { from: "finishing", to: "timed_out", trigger: "timeout" },
  { from: "finishing", to: "stalled", trigger: "stall" },
  { from: "queued", to: "failed", trigger: "failed" },
  { from: "queued", to: "interrupted", trigger: "interrupt" },
  { from: "queued", to: "timed_out", trigger: "timeout" },
  { from: "queued", to: "stalled", trigger: "stall" },
  { from: "admitted", to: "failed", trigger: "failed" },
  { from: "admitted", to: "interrupted", trigger: "interrupt" },
  { from: "admitted", to: "timed_out", trigger: "timeout" },
  { from: "admitted", to: "stalled", trigger: "stall" },
  { from: "streaming", to: "failed", trigger: "failed" },
  { from: "streaming", to: "interrupted", trigger: "interrupt" },
  { from: "streaming", to: "timed_out", trigger: "timeout" },
  { from: "streaming", to: "stalled", trigger: "stall" },
]

export function isAttemptTerminal(state: AttemptState): boolean {
  return (
    state === "succeeded" ||
    state === "reported" ||
    state === "no_report" ||
    state === "failed" ||
    state === "interrupted" ||
    state === "timed_out" ||
    state === "stalled"
  )
}

export function canAttemptTransition(from: AttemptState, to: AttemptState, trigger?: string): boolean {
  if (trigger === undefined) {
    return ATTEMPT_TRANSITIONS.some((r) => r.from === from && r.to === to)
  }
  return ATTEMPT_TRANSITIONS.some((r) => r.from === from && r.to === to && r.trigger === trigger)
}

export interface StartAttemptOpts {
  trigger: string
  prompt?: string
}

export type AttemptCtx = { trigger?: string; [k: string]: unknown } | string

function attemptTriggerOf(ctx?: AttemptCtx): string | undefined {
  if (ctx === undefined) return undefined
  if (typeof ctx === "string") return ctx
  return ctx.trigger
}

function nonTerminalAttempts(run: RunRecord): AttemptRecord[] {
  return run.attempts.filter((a) => !isAttemptTerminal(a.state))
}

export function startAttempt(run: RunRecord, opts: StartAttemptOpts): RunRecord {
  const open = nonTerminalAttempts(run)
  if (open.length > 0) {
    const names = open.map((a) => `${a.n}:${a.state}`).join(", ")
    throw toolError(
      "E_TRANSITION",
      `Run ${run.id} cannot start a new attempt: attempt(s) [${names}] still non-terminal; ` +
        `only the last attempt may be non-terminal.`,
      run.attempts.map((a) => a.state),
    )
  }
  const at = new Date().toISOString()
  const attempt: AttemptRecord = {
    n: run.attempts.length + 1,
    state: "queued",
    startedAt: at,
    trigger: opts.trigger,
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
  }
  return { ...run, attempts: [...run.attempts, attempt], lastUsed: at }
}

export function attemptTransition(run: RunRecord, to: AttemptState, ctx?: AttemptCtx): RunRecord {
  if (run.attempts.length === 0) {
    throw toolError("E_TRANSITION", `Run ${run.id} has no attempts to transition to "${to}".`, [])
  }
  for (let i = 0; i < run.attempts.length - 1; i++) {
    const a = run.attempts[i]
    if (!isAttemptTerminal(a.state)) {
      throw toolError(
        "E_TRANSITION",
        `Run ${run.id} cannot transition attempt ${run.attempts.length} to "${to}": ` +
          `attempt ${a.n} is still ${a.state}; only the last attempt may be non-terminal.`,
        run.attempts.map((x) => x.state),
      )
    }
  }
  const last = run.attempts[run.attempts.length - 1]
  const trigger = attemptTriggerOf(ctx)
  if (!canAttemptTransition(last.state, to, trigger)) {
    const legal = [...new Set(ATTEMPT_TRANSITIONS.filter((r) => r.from === last.state).map((r) => r.to))]
    const on = trigger === undefined ? "" : ` on "${trigger}"`
    throw toolError(
      "E_TRANSITION",
      `Run ${run.id} attempt ${last.n} cannot go ${last.state} → ${to}${on}. ` +
        `Legal targets from ${last.state}: [${legal.join(", ")}].`,
      legal,
    )
  }
  const at = new Date().toISOString()
  const updated: AttemptRecord = {
    ...last,
    state: to,
    ...(isAttemptTerminal(to) ? { endedAt: at } : {}),
  }
  const attempts = [...run.attempts.slice(0, -1), updated]
  return { ...run, attempts, lastUsed: at }
}

/** 02 §1 stall rule: min(baseMs * 2^(n-1), maxMs). */
export function retryDelayMs(attemptNumber: number, opts?: { baseMs?: number; maxMs?: number }): number {
  const baseMs = opts?.baseMs ?? 10000
  const maxMs = opts?.maxMs ?? 300000
  return Math.min(baseMs * 2 ** (attemptNumber - 1), maxMs)
}

function runPath(root: string, id: string): string {
  return path.join(root, "runs", id, "run.json")
}

export async function saveRun(root: string, run: RunRecord): Promise<void> {
  const created = await lock(root, "state", run.id, async () => {
    const target = runPath(root, run.id)
    const existed = await Bun.file(target).exists()
    await atomicJson(target, run)
    return !existed
  })
  // The first write of a run's record enters the audit chain as run.created;
  // later writes are transitions covered by their own events.
  if (created) await append(root, "run.created", { run: run.id })
}

export async function loadRun(root: string, id: string): Promise<RunRecord | undefined> {
  return lock(root, "state", id, () => readJson<RunRecord>(runPath(root, id)))
}

// Actor gate for the tools layer: the run bound to a session, if any. A
// linear scan over small run.json files is cheap at team scale; unreadable
// entries and a missing runs directory simply miss instead of throwing.
export async function bySession(root: string, sessionID: string): Promise<RunRecord | undefined> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const dir = path.join(root, "runs")
      const entries = yield* io(() => readdir(dir)).pipe(
        Effect.catchIf(
          (error) => errCode(error) === "ENOENT",
          () => Effect.succeed(undefined),
        ),
      )
      if (entries === undefined) return undefined
      for (const entry of entries) {
        const record = yield* io(() => readJson<RunRecord>(path.join(dir, entry, "run.json"))).pipe(Effect.option)
        if (
          Option.isSome(record) &&
          record.value !== null &&
          record.value !== undefined &&
          record.value.sessionID === sessionID
        )
          return record.value
      }
      return undefined
    }),
  )
}
