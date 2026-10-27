import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createLedger, type Ledger } from "../src/monitor/ledger.js"

// One temp directory for this file; every test opens and closes its own ledger.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plus-monitor-vacuum-"))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

let sequence = 0
const fileFor = (name: string) => path.join(dir, `${name}-${sequence++}.db`)

const pages = (db: Ledger | Database) =>
  ("db" in db ? db.db : db).query<{ page_count: number }, []>("pragma page_count").get()!.page_count
const free = (db: Ledger | Database) =>
  ("db" in db ? db.db : db).query<{ freelist_count: number }, []>("pragma freelist_count").get()!.freelist_count
const autoVacuum = (db: Ledger | Database) =>
  ("db" in db ? db.db : db).query<{ auto_vacuum: number }, []>("pragma auto_vacuum").get()!.auto_vacuum
const size = (file: string) => fs.statSync(file).size

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

test("a mostly-free ledger is compacted on open, switches to incremental mode and keeps its rows", () => {
  const file = fileFor("fragmented")
  const first = createLedger(file)
  fill(first, 20_000)
  first.db.query("delete from cache_result").run()
  first.db.exec("delete from request")
  first.db.exec("delete from request_fingerprint")
  first.db.exec("insert into mark (label, at) values ('kept', 1)")
  const rowsBefore = first.db.query<{ n: number }, []>("select count(*) as n from mark").get()!.n
  first.close()

  const before = { bytes: size(file), pages: pages(new Database(file, { readonly: true })), free: free(new Database(file, { readonly: true })) }
  expect(before.free / before.pages).toBeGreaterThan(0.3)

  const reopened = createLedger(file, { compactBytes: 1, freeBytes: () => 8 * 1024 * 1024 * 1024 })
  expect(size(file)).toBeLessThan(before.bytes)
  expect(free(reopened.db)).toBeLessThan(before.free)
  expect(autoVacuum(reopened.db)).toBe(2)
  expect(reopened.db.query("pragma quick_check").get()).toEqual({ quick_check: "ok" })
  expect(reopened.db.query<{ n: number }, []>("select count(*) as n from mark").get()!.n).toBe(rowsBefore)
  reopened.db.exec("insert into mark (label, at) values ('after', 1)")
  expect(reopened.db.query<{ n: number }, []>("select count(*) as n from mark").get()!.n).toBe(rowsBefore + 1)
  reopened.close()
})

test("a small ledger is left alone: same size, same free pages", () => {
  const file = fileFor("small")
  const first = createLedger(file)
  fill(first, 500)
  first.db.exec("delete from request")
  first.db.exec("delete from request_fingerprint")
  first.close()

  const reader = new Database(file, { readonly: true })
  const before = { bytes: size(file), free: free(reader), pages: pages(reader) }
  reader.close()

  const reopened = createLedger(file)
  expect(size(file)).toBe(before.bytes)
  expect(free(reopened.db)).toBe(before.free)
  expect(pages(reopened.db)).toBe(before.pages)
  reopened.close()
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

  const reopened = createLedger(file, { compactBytes: 1, freeBytes: () => before.bytes })
  expect(size(file)).toBe(before.bytes)
  expect(free(reopened.db)).toBe(before.free)
  expect(autoVacuum(reopened.db)).toBe(before.auto)
  reopened.close()
})

test("pruning returns free pages, and only once an hour", () => {
  const file = fileFor("prune")
  const clock = { at: 0 }
  const db = createLedger(file, { now: () => clock.at, incrementalPages: 2000 })
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
  db.close()
})
