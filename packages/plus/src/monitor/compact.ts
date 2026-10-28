// Compacting the monitor ledger must never run on the main thread: SQLite in
// Bun is synchronous, and a multi-second `VACUUM` at the first monitored event
// would freeze every chat, the TUI and every RPC in the service process. So the
// rewrite runs in a Worker (its own thread, its own SQLite connection), started
// when the monitor is activated; while it runs, callers buffer writes and
// answer reads with a status instead of opening the file.
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"

/** A ledger at least this large is worth compacting. */
export const COMPACT_BYTES = 64 * 1024 * 1024
/** Free pages below this share of the file are normal fragmentation. */
export const COMPACT_SHARE = 0.3
/** A VACUUM rewrites the whole file beside it; never start one without room. */
export const COMPACT_HEADROOM = 1.2

export interface LedgerCompactionOptions {
  /** Bytes still free on the ledger's filesystem; `fs.statfsSync` by default. */
  freeBytes?: (dir: string) => number
  compactBytes?: number
  compactShare?: number
  compactHeadroom?: number
  /** How the rewrite itself runs: the worker by default, a test's own work otherwise. */
  run?: (file: string) => Promise<CompactionOutcome>
  /** Where the worker module's code comes from; a test injects its own. */
  worker?: (file: string) => Worker
}

export interface CompactionNumbers {
  bytesBefore: number
  bytesAfter: number
  pagesBefore: number
  pagesAfter: number
  freeBefore: number
  freeAfter: number
  durationMs: number
}

export interface CompactionOutcome {
  compacted: boolean
  /** Why nothing was rewritten, when `compacted` is false. */
  reason?: "clean" | "small" | "no-room" | "failed"
  error?: string
  numbers?: CompactionNumbers
}

export interface Compaction {
  readonly file: string
  /** Settles with the outcome; never rejects. */
  readonly done: Promise<CompactionOutcome>
}

// One compaction per ledger file per process; a second activation joins it.
const running = new Map<string, Compaction>()
// Files whose rewrite is in progress: nothing may open them now.
const held = new Set<string>()
// Work that arrived meanwhile, in arrival order, replayed when the rewrite ends.
const queues = new Map<string, Array<() => void>>()
let dropped = 0

/** How much monitored work may wait for one rewrite before the oldest is dropped. */
export const BUFFER_LIMIT = 10_000

/** Whether the file is being rewritten right now, so nothing may open it. */
export const compactionRunning = (file: string) => running.has(file)

/** Whether opening this file must wait for its rewrite to finish. */
export const ledgerHeld = (file: string) => held.has(file)

export function holdLedger(file: string) {
  held.add(file)
}

/** Opens the way again and replays the buffered work through its normal paths. */
export function releaseLedger(file: string) {
  held.delete(file)
  const queue = queues.get(file) ?? []
  queues.delete(file)
  queue.forEach((task) => {
    try {
      task()
    } catch (cause) {
      Effect.runSync(Effect.logWarning("plus monitor buffered work failed", { file, cause }))
    }
  })
}

/** How many tasks are waiting for the file's rewrite; lets a test wait for a buffer. */
export const bufferedCount = (file: string) => queues.get(file)?.length ?? 0

/**
 * Holds `task` while the file is being rewritten. Returns false when it is not,
 * so the caller runs it now. Only closures are buffered, never an open handle;
 * beyond `limit` the oldest are dropped and one log line counts them.
 */
export function whileHeld(file: string, task: () => void, limit = BUFFER_LIMIT): boolean {
  if (!held.has(file)) return false
  const queue = queues.get(file) ?? []
  queue.push(task)
  queues.set(file, queue)
  if (queue.length <= limit) return true
  const lost = queue.length - limit
  queue.splice(0, lost)
  dropped += lost
  Effect.runSync(
    Effect.logWarning("plus monitor dropped buffered work while compacting", { file, dropped: lost, total: dropped, limit }),
  )
  return true
}

/**
 * Starts the ledger rewrite for `file`, or joins the one already running.
 * Returns undefined when the file is too small or the disk too full: both are
 * cheap syscalls, and neither needs a worker.
 */
export function startLedgerCompaction(file: string, options: LedgerCompactionOptions = {}): Compaction | undefined {
  const existing = running.get(file)
  if (existing !== undefined) return existing
  const bytes = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0
  if (bytes < (options.compactBytes ?? COMPACT_BYTES)) return undefined
  const free = (options.freeBytes ?? freeBytesOn)(path.dirname(file))
  if (free < bytes * (options.compactHeadroom ?? COMPACT_HEADROOM)) {
    Effect.runSync(Effect.logWarning("plus monitor ledger left uncompacted for disk space", { file, bytes, free }))
    return undefined
  }
  const started = Date.now()
  Effect.runSync(Effect.logInfo("plus monitor ledger compaction started", { file, bytes, free }))
  holdLedger(file)
  const work = options.run ?? ((target: string) => vacuumInWorker(target, options))
  const compaction: Compaction = {
    file,
    done: Promise.resolve()
      .then(() => work(file))
      .catch((cause: unknown): CompactionOutcome => ({
        compacted: false,
        reason: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      }))
      .then((outcome) => {
        if (outcome.compacted && outcome.numbers !== undefined)
          Effect.runSync(
            Effect.logInfo("plus monitor ledger compaction finished", {
              file,
              ...outcome.numbers,
              durationMs: Date.now() - started,
            }),
          )
        else if (outcome.reason === "failed")
          Effect.runSync(
            Effect.logWarning("plus monitor ledger compaction failed; the ledger opens as it is", {
              file,
              error: outcome.error,
            }),
          )
        else Effect.runSync(Effect.logInfo("plus monitor ledger left alone", { file, reason: outcome.reason }))
        return outcome
      })
      .finally(() => {
        running.delete(file)
        releaseLedger(file)
      }),
  }
  running.set(file, compaction)
  return compaction
}

const freeBytesOn = (dir: string) => {
  const stat = fs.statfsSync(dir)
  return stat.bavail * stat.bsize
}

/**
 * Runs the rewrite in a worker. A VACUUM rewrites live rows, so nothing is
 * dropped, and WAL readers on other connections keep reading throughout.
 *
 * The worker is built from a Blob so it also exists inside the compiled
 * `opencodeplus` binary, where a `new URL(..., import.meta.url)` worker file
 * would need its own build entrypoint.
 */
function vacuumInWorker(file: string, options: LedgerCompactionOptions) {
  const share = options.compactShare ?? COMPACT_SHARE
  const worker =
    options.worker?.(file) ??
    new Worker(
      URL.createObjectURL(
        new Blob(
          [
            `
import { Database } from "bun:sqlite"
import fs from "node:fs"
const file = ${JSON.stringify(file)}
const scalar = (db, sql) => Object.values(db.query(sql).get() ?? {})[0]
try {
  const db = new Database(file)
  const auto = scalar(db, "pragma auto_vacuum")
  const pages = scalar(db, "pragma page_count")
  const free = scalar(db, "pragma freelist_count")
  if (auto === 2 && !(pages > 0 && free / pages > ${share})) {
    db.close()
    postMessage({ compacted: false, reason: "clean" })
  } else {
    const before = fs.statSync(file).size
    const started = Date.now()
    db.exec("pragma auto_vacuum = incremental")
    db.exec("vacuum")
    // VACUUM writes through the WAL; only this makes the file itself shrink.
    db.exec("pragma wal_checkpoint(truncate)")
    const after = { pages: scalar(db, "pragma page_count"), free: scalar(db, "pragma freelist_count") }
    db.close()
    postMessage({
      compacted: true,
      numbers: {
        bytesBefore: before,
        bytesAfter: fs.statSync(file).size,
        pagesBefore: pages,
        pagesAfter: after.pages,
        freeBefore: free,
        freeAfter: after.free,
        durationMs: Date.now() - started,
      },
    })
  }
} catch (cause) {
  postMessage({ compacted: false, reason: "failed", error: String(cause && cause.message ? cause.message : cause) })
}
`,
          ],
          { type: "text/javascript" },
        ),
      ),
      { type: "module" },
    )
  return new Promise<CompactionOutcome>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<CompactionOutcome>) => {
      resolve(event.data)
      worker.terminate()
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error((event as ErrorEvent).message ?? "ledger compaction worker failed"))
    }
  })
}
