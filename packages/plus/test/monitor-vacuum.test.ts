import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Stream } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bufferedCount, startLedgerCompaction, whileHeld, type CompactionOutcome } from "../src/monitor/compact.js"
import { createLedger, defaultLedgerPath, type Ledger } from "../src/monitor/ledger.js"
import { monitorQuery, watchMonitor } from "../src/monitor/plugin.js"
import { context } from "./harness.js"
import { script, usage } from "./monitor-fixture.js"

// One temp directory for this file; every test opens and closes its own ledger.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plus-monitor-vacuum-"))
const ledgers: Ledger[] = []
afterAll(() => {
  ledgers.splice(0).forEach((ledger) => ledger.close())
  fs.rmSync(dir, { recursive: true, force: true })
})

let sequence = 0
const fileFor = (name: string) => path.join(dir, `${name}-${sequence++}.db`)

const pages = (db: Ledger | Database) =>
  ("db" in db ? db.db : db).query<{ page_count: number }, []>("pragma page_count").get()!.page_count
const free = (db: Ledger | Database) =>
  ("db" in db ? db.db : db).query<{ freelist_count: number }, []>("pragma freelist_count").get()!.freelist_count
const autoVacuum = (db: Ledger | Database) =>
  ("db" in db ? db.db : db).query<{ auto_vacuum: number }, []>("pragma auto_vacuum").get()!.auto_vacuum
const size = (file: string) => fs.statSync(file).size
const rows = (db: Ledger, table: string) =>
  db.db.query<{ n: number }, []>(`select count(*) as n from ${table}`).get()!.n

/** Writes `count` requests, then optionally prunes below `before`. */
function fill(db: Ledger, count: number, before?: number) {
  db.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `req_${i}`
      db.requestStarted({ id, sessionID: `ses_${i % 20}`, kind: "step", started: i, agent: "build", provider: "p", model: "m" })
      db.requestEnded(id, { status: "completed", ended: i + 1, finish: "stop" })
    }
  })()
  if (before === undefined) return
  db.prune(before)
}

/** Waits for a condition without sleeping: each step is one turn of the event loop. */
async function until(condition: () => boolean) {
  for (let turn = 0; turn < 1_000; turn++) {
    if (condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error("condition never held")
}

/** A gate a test opens itself, so no test waits on a real rewrite it cannot time. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { opened, open }
}

/** A compaction whose worker is the test: it ends when the gate opens. */
const gated = (file: string, outcome: () => CompactionOutcome) => {
  const stopped = gate()
  const compaction = startLedgerCompaction(file, {
    compactBytes: 0,
    freeBytes: () => 2 ** 40,
    run: async () => {
      await stopped.opened
      return outcome()
    },
  })!
  return { compaction, stopped }
}

test("a mostly-free ledger is compacted in the worker, keeps its rows and switches to incremental mode", async () => {
  const file = fileFor("fragmented")
  const first = createLedger(file)
  fill(first, 20_000)
  first.db.exec("delete from request")
  first.db.exec("delete from request_fingerprint")
  first.db.exec("insert into mark (label, at) values ('kept', 1)")
  const marks = rows(first, "mark")
  first.close()

  const reader = new Database(file, { readonly: true })
  const before = { bytes: size(file), pages: pages(reader), free: free(reader) }
  reader.close()
  expect(before.free / before.pages).toBeGreaterThan(0.3)

  // The real worker on the real file: nothing about the rewrite is injected.
  const compaction = startLedgerCompaction(file, { compactBytes: 1, freeBytes: () => 8 * 1024 * 1024 * 1024 })!
  const outcome = await compaction.done
  expect(outcome).toMatchObject({ compacted: true, numbers: { pagesBefore: before.pages } })

  const reopened = createLedger(file)
  ledgers.push(reopened)
  expect(size(file)).toBeLessThan(before.bytes)
  expect(free(reopened.db)).toBeLessThan(before.free)
  expect(autoVacuum(reopened.db)).toBe(2)
  expect(reopened.db.query("pragma quick_check").get()).toEqual({ quick_check: "ok" })
  expect(rows(reopened, "mark")).toBe(marks)
  reopened.db.exec("insert into mark (label, at) values ('after', 1)")
  expect(rows(reopened, "mark")).toBe(marks + 1)
})

test("a small ledger is never handed to the worker, so its file and pages stay as they are", () => {
  const file = fileFor("small")
  const first = createLedger(file)
  fill(first, 500)
  first.db.exec("delete from request")
  first.db.exec("delete from request_fingerprint")
  first.close()

  const reader = new Database(file, { readonly: true })
  const before = { bytes: size(file), free: free(reader), pages: pages(reader) }
  reader.close()

  expect(startLedgerCompaction(file)).toBeUndefined()
  const reopened = createLedger(file)
  ledgers.push(reopened)
  expect(size(file)).toBe(before.bytes)
  expect(free(reopened.db)).toBe(before.free)
  expect(pages(reopened.db)).toBe(before.pages)
})

test("a ledger whose disk is too full is skipped rather than rewritten", () => {
  const file = fileFor("full-disk")
  const first = createLedger(file)
  fill(first, 20_000)
  first.db.exec("delete from request")
  first.db.exec("delete from request_fingerprint")
  first.close()

  const reader = new Database(file, { readonly: true })
  const before = { bytes: size(file), free: free(reader), auto: autoVacuum(reader) }
  reader.close()

  expect(startLedgerCompaction(file, { compactBytes: 1, freeBytes: () => before.bytes })).toBeUndefined()
  const reopened = createLedger(file)
  ledgers.push(reopened)
  expect(size(file)).toBe(before.bytes)
  expect(free(reopened.db)).toBe(before.free)
  expect(autoVacuum(reopened.db)).toBe(before.auto)
})

test("pruning returns free pages, and only once an hour", () => {
  const file = fileFor("prune")
  const clock = { at: 0 }
  const db = createLedger(file, { now: () => clock.at, incrementalPages: 2000 })
  ledgers.push(db)
  fill(db, 80_000, 100_000)
  // No hour has passed since the ledger opened, so this prune freed pages
  // without returning any of them.
  const freed = free(db)
  expect(freed / pages(db)).toBeGreaterThan(0.3)

  // A second prune inside the hour frees nothing more.
  db.prune(100_000)
  expect(free(db)).toBe(freed)

  // An hour later it returns a bounded batch, not the whole freelist.
  clock.at += 3_600_000
  db.prune(100_000)
  expect(free(db)).toBeLessThan(freed)
  expect(free(db)).toBeGreaterThan(0)
})

test("events that arrive during a compaction are all written afterwards, in order", async () => {
  const file = fileFor("buffered")
  const clock = { now: 1_000 }
  const events = script("ses_buffered", clock)
  events.created({ agent: "build" })
  // Three steps, so their rows say whether the replay kept their order.
  for (const id of ["m1", "m2", "m3"]) {
    events.step(id)
    events.end(id, "stop", usage(10, 1))
  }
  const { compaction, stopped } = gated(file, () => ({ compacted: false, reason: "clean" }))
  const ctx = context({ event: { subscribe: () => Stream.fromIterable(events.events) as never }, session: { hook: () => Effect.succeed({ dispose: Effect.void }) } })

  const watcher = Effect.runPromise(Effect.scoped(
    watchMonitor(ctx, () => undefined, () => createLedger(file), () => file),
  ))
  // The stream is consumed while the file is held, so every event waits there.
  await until(() => bufferedCount(file) === events.events.length)
  expect(fs.existsSync(file)).toBe(false)
  stopped.open()
  await compaction.done
  await watcher

  const db = createLedger(file)
  ledgers.push(db)
  expect(fs.existsSync(file)).toBe(true)
  expect(db.db.query<{ message_id: string }, []>("select message_id from step order by started").all().map((row) => row.message_id))
    .toEqual(["m1", "m2", "m3"])
})

test("a query during a compaction answers with the status and never opens the file", async () => {
  const prior = process.env.XDG_DATA_HOME
  const root = fs.mkdtempSync(path.join(dir, "data-"))
  process.env.XDG_DATA_HOME = root
  try {
    const file = defaultLedgerPath()
    const { compaction, stopped } = gated(file, () => ({ compacted: false, reason: "clean" }))
    const report = await monitorQuery(context({}), { scope: "all" })
    expect(report.compacting).toBe(true)
    expect(report.requests).toEqual([])
    const cache = await monitorQuery(context({}), { scope: "all", view: "cache" })
    expect(cache.compacting).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    stopped.open()
    await compaction.done
    expect(fs.existsSync(file)).toBe(false)
    // With the rewrite done, the same query opens the ledger normally.
    const opened = await monitorQuery(context({}), { scope: "all" })
    expect(opened.compacting).toBeUndefined()
    expect(fs.existsSync(file)).toBe(true)
  } finally {
    if (prior === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prior
  }
})

test("a failed worker still opens the ledger and keeps the buffered work", async () => {
  const file = fileFor("failed")
  const db = createLedger(file)
  ledgers.push(db)
  const failed = gated(file, () => { throw new Error("worker died") })
  let wrote = 0
  const ctx = context({ event: { subscribe: () => never() as never }, session: { hook: () => Effect.succeed({ dispose: Effect.void }) } })
  await Effect.runPromise(Effect.scoped(watchMonitor(ctx, () => undefined, () => db, () => file)))
  // A write issued while held waits, then still lands after the failure.
  whileHeld(file, () => wrote++)
  failed.stopped.open()
  const outcome = await failed.compaction.done
  expect(outcome).toMatchObject({ compacted: false, reason: "failed", error: "worker died" })
  expect(wrote).toBe(1)
  db.mark("after failure", 5)
  expect(rows(db, "mark")).toBe(1)
})

function never() {
  return Stream.empty as never
}
