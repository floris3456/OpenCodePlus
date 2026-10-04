import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { Duration, Effect, Option, Predicate, Schema } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { errCode, io } from "./io.js"

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

let lastMs = 0
let lastRand = new Uint8Array(10)
let seeded = false

function encodeTime(ms: number): string {
  let n = ms
  let out = ""
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n & 31] + out
    n = Math.floor(n / 32)
  }
  return out
}

function encodeRand(rand: Uint8Array): string {
  let n = 0n
  for (const b of rand) n = (n << 8n) | BigInt(b)
  let out = ""
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(n & 31n)] + out
    n >>= 5n
  }
  return out
}

/** Monotonic ULID: 26 chars Crockford base32 (10 time + 16 random). */
export function ulid(): string {
  let ms = Date.now()
  if (seeded && ms < lastMs) ms = lastMs
  if (!seeded || ms > lastMs) {
    const buf = randomBytes(10)
    lastRand = new Uint8Array(buf)
    lastMs = ms
    seeded = true
  } else {
    let carry = 1
    for (let i = 9; i >= 0 && carry > 0; i--) {
      const v = lastRand[i] + carry
      lastRand[i] = v & 0xff
      carry = v > 0xff ? 1 : 0
    }
    if (carry > 0) {
      lastMs += 1
      const buf = randomBytes(10)
      lastRand = new Uint8Array(buf)
      ms = lastMs
    } else {
      ms = lastMs
    }
  }
  return encodeTime(ms) + encodeRand(lastRand)
}

/** Atomic JSON write: tmp file then rename. Mode 0o600. */
export async function atomicJson(target: string, value: unknown): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* io(() => mkdir(path.dirname(target), { recursive: true }))
      const tmp = `${target}.${ulid()}.tmp`
      yield* io(() => writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }))
      // Filesystems that cannot chmod still hold the right bytes; the mode is
      // best-effort hardening, never load-bearing.
      yield* Effect.ignore(io(() => chmod(tmp, 0o600)))
      yield* io(() => rename(tmp, target))
      yield* Effect.ignore(io(() => chmod(target, 0o600)))
    }),
  )
}

/** Read JSON; undefined on ENOENT. */
export async function readJson<T>(target: string): Promise<T | undefined> {
  return Effect.runPromise(
    io(() => readFile(target, "utf8")).pipe(
      // Parse as a failure (not a defect) so callers can recover per file.
      Effect.flatMap((raw) => Effect.try({ try: () => JSON.parse(raw) as T, catch: (error) => error })),
      Effect.catchIf(
        (error) => errCode(error) === "ENOENT",
        () => Effect.succeed(undefined),
      ),
    ),
  )
}

// The only place teamsDataDir() enters: every store/run/audit function takes
// the state root as an explicit first argument and tests pass a temp dir.
export function stateRoot(): string {
  return teamsDataDir()
}

export type LockKind = "state" | "wt" | "repo"

export interface LockBreakInfo {
  pid: number
  at: string
  op?: string
}

export interface LockOptions {
  /** How long to wait for the lock. `0` means a single try: succeed or fail `E_LOCKED`. */
  timeoutMs?: number
  op?: string
  onBreak?: (info: LockBreakInfo) => void
}

export interface LockedError extends Error {
  code: "E_LOCKED"
  accepted: string
  retryAfterMs: number
}

// In-process queue per lock file. Same-process contenders used to race the
// kernel lock and could starve one another for the whole timeout; now they
// take turns in arrival order before any of them touches the file. A present
// entry means a caller holds the turn; its array holds the waiters' grants.
// Releasing hands the turn straight to the oldest waiter, so a newcomer never
// overtakes one (Effect's Semaphore wakes waiters a tick later and lets a
// newcomer take the permit first). Module state is process-wide because the
// module is imported once.
const turns = new Map<string, Array<() => void>>()

function takeTurn(lockPath: string, timeoutMs: number): Promise<boolean> {
  const waiting = turns.get(lockPath)
  if (waiting === undefined) {
    turns.set(lockPath, [])
    return Promise.resolve(true)
  }
  if (timeoutMs <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    const grant = () => {
      clearTimeout(timer)
      resolve(true)
    }
    // A grant removes itself from `waiting` before it runs, so a waiter still
    // listed when its time is up has not been handed the turn.
    const timer = setTimeout(() => {
      const index = waiting.indexOf(grant)
      if (index < 0) return
      waiting.splice(index, 1)
      resolve(false)
    }, timeoutMs)
    waiting.push(grant)
  })
}

function passTurn(lockPath: string): void {
  const next = turns.get(lockPath)?.shift()
  if (next === undefined) {
    turns.delete(lockPath)
    return
  }
  next()
}

// Poll backoff: 25, 50, 100, 200, 250, 250, … ms plus 0-25 ms of jitter so
// distinct waiters do not resynchronize on the same tick.
function pollDelayMs(attempt: number): number {
  return Math.min(250, 25 * 2 ** attempt) + Math.random() * 25
}

const holdStats = new Map<string, { total: number; count: number }>()

function statsKey(kind: LockKind, key: string): string {
  return `${kind}:${key}`
}

function recordHold(kind: LockKind, key: string, ms: number): void {
  const k = statsKey(kind, key)
  const s = holdStats.get(k) ?? { total: 0, count: 0 }
  s.total += ms
  s.count += 1
  holdStats.set(k, s)
}

function averageHold(kind: LockKind, key: string): number {
  const s = holdStats.get(statsKey(kind, key))
  if (!s || s.count === 0) return 1000
  return Math.max(1, Math.round(s.total / s.count))
}

export function sanitizeLockKey(key: string): string {
  let s = key.replace(/[^A-Za-z0-9._-]/g, "_")
  if (s.length === 0) s = "_"
  if (s.length > 200) s = s.slice(0, 120) + "_" + s.length
  return s
}

const LockFile = Schema.Struct({
  pid: Schema.optional(Schema.Unknown),
  at: Schema.optional(Schema.Unknown),
  op: Schema.optional(Schema.Unknown),
})
const decodeLockFile = Schema.decodeUnknownOption(Schema.fromJsonString(LockFile))

function pidAlive(pid: number): Effect.Effect<boolean> {
  return Effect.try({
    try: () => {
      process.kill(pid, 0)
      return true
    },
    catch: (error) => errCode(error) === "ESRCH" ? false : true,
  }).pipe(Effect.match({ onFailure: (alive) => alive, onSuccess: () => true }))
}

function lockedError(kind: LockKind, key: string, timeoutMs: number): LockedError {
  const retryAfterMs = averageHold(kind, key)
  const error = new Error(`Lock ${kind}:${key} busy; timed out after ${timeoutMs}ms`) as LockedError
  error.code = "E_LOCKED"
  error.accepted = `retry after ${retryAfterMs}ms`
  error.retryAfterMs = retryAfterMs
  return error
}

// A lock file whose holder pid is gone (or was never a pid) is removed and
// the waiter retries the acquire; the previous holder cannot object.
function breakStale(
  lockPath: string,
  record: { readonly pid?: unknown; readonly at?: unknown; readonly op?: unknown } | undefined,
  onBreak: LockOptions["onBreak"],
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const pid = record?.pid
    const alive =
      Predicate.isNumber(pid) && Number.isInteger(pid) && pid > 0 ? yield* pidAlive(pid) : false
    if (alive) return false
    yield* Effect.ignore(io(() => unlink(lockPath)))
    if (onBreak !== undefined) {
      const pidValue = record?.pid
      const atValue = record?.at
      const opValue = record?.op
      const info: LockBreakInfo = {
        pid: Predicate.isNumber(pidValue) ? pidValue : -1,
        at: Predicate.isString(atValue) ? atValue : "",
        ...(Predicate.isString(opValue) ? { op: opValue } : {}),
      }
      yield* Effect.ignore(io(() => Promise.resolve().then(() => onBreak(info))))
    }
    return true
  })
}

function acquire(
  lockPath: string,
  kind: LockKind,
  key: string,
  op: string,
  deadline: number,
  timeoutMs: number,
  onBreak: LockOptions["onBreak"],
): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    let attempt = 0
    for (;;) {
      const created = yield* io(() =>
        writeFile(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), op }), {
          flag: "wx",
          mode: 0o600,
        }),
      ).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => errCode(error) === "EEXIST",
          () => Effect.succeed(false),
        ),
      )
      if (created) {
        yield* Effect.ignore(io(() => chmod(lockPath, 0o600)))
        return Date.now()
      }
      // EEXIST: someone holds (or held) the lock.
      const raw = yield* io(() => readFile(lockPath, "utf8")).pipe(
        Effect.map((text) => text as string | undefined),
        Effect.catchIf(
          (error) => errCode(error) === "ENOENT",
          () => Effect.succeed(undefined),
        ),
      )
      // The file vanished between attempts; loop back and acquire it.
      if (raw === undefined) continue
      const stale = yield* breakStale(lockPath, Option.getOrUndefined(decodeLockFile(raw)), onBreak)
      if (stale) continue
      if (Date.now() >= deadline) return yield* Effect.fail(lockedError(kind, key, timeoutMs))
      yield* Effect.sleep(Duration.millis(pollDelayMs(attempt)))
      attempt++
    }
  })
}

function release(lockPath: string, kind: LockKind, key: string, acquiredAt: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    recordHold(kind, key, Date.now() - acquiredAt)
    yield* Effect.ignore(io(() => unlink(lockPath)))
  })
}

/** File lock under <root>/locks/<kind>/<sanitized key>.lock. */
export async function lock<T>(
  root: string,
  kind: LockKind,
  key: string,
  fn: () => Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  const dir = path.join(root, "locks", kind)
  const lockPath = path.join(dir, `${sanitizeLockKey(key)}.lock`)
  const timeoutMs = opts?.timeoutMs ?? 30000
  const op = opts?.op ?? ""
  const deadline = Date.now() + timeoutMs
  // Queue before the first await, so the turn order is the call order. The
  // file lock below shares the same deadline.
  const turn = takeTurn(lockPath, timeoutMs)
  return Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => turn).pipe(
        Effect.flatMap((granted) => (granted ? Effect.void : Effect.fail(lockedError(kind, key, timeoutMs)))),
      ),
      () =>
        Effect.gen(function* () {
          yield* io(() => mkdir(dir, { recursive: true }))
          return yield* Effect.acquireUseRelease(
            acquire(lockPath, kind, key, op, deadline, timeoutMs, opts?.onBreak),
            () => io(fn),
            (acquiredAt) => release(lockPath, kind, key, acquiredAt),
          )
        }),
      () => Effect.sync(() => passTurn(lockPath)),
    ),
  )
}
