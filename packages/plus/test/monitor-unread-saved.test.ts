import { afterEach, expect, test } from "bun:test"
import { windowedSessionSignals } from "../src/monitor/cache.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { sessionFold } from "../src/monitor/report.js"
import { savedUnread, settleUnreadWrites } from "../src/monitor/unread-saved.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

const SESSION = "unread-saved"
const UNTIL = 200_000_000

// Five requests: r1 reads all of r0's write, r4 (a title) reads all of r2's, and
// nothing reads r3's. A title read is excluded from the real total, so r2 is
// unread only when titles are excluded.
async function session() {
  const db = await ledger()
  db.session({ id: SESSION, agent: "build" }, 0)
  const messages = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]
  const requests = [
    { id: "r0", at: 1_000, write: 1_000, read: 0, messages: messages.slice(0, 1) },
    { id: "r1", at: 2_000, write: 0, read: 1_000, messages: messages.slice(0, 2) },
    { id: "r2", at: 3_000, write: 800, read: 0, messages },
    { id: "r3", at: 4_000, write: 700, read: 0, messages: [...messages, { role: "assistant", content: "d" }] },
    { id: "r4", at: 5_000, write: 0, read: 800, messages, kind: "title", isTitle: true },
  ]
  for (const request of requests) {
    db.requestStarted({ id: request.id, sessionID: SESSION, kind: request.kind ?? "step", isTitle: request.isTitle ?? false, agent: "build", provider: "p", model: "m", started: request.at })
    db.requestEnded(request.id, { ended: request.at + 1, status: "completed", usage: { input: 0, output: 0, reasoning: 0, cacheRead: request.read, cacheWrite: request.write, cost: 0 } })
    db.requestFingerprint({ requestID: request.id, sessionID: SESSION, created: request.at, ...fingerprintWireBody({ prompt_cache_retention: "24h", messages: request.messages }) })
  }
  return db
}

test("saved unread tokens equal the fold for both titles flags", async () => {
  const db = await session()
  const window = { since: 0, until: UNTIL }
  const expected = (titles: boolean) => windowedSessionSignals(sessionFold(db, SESSION).analysis, window, { titles }).unread

  expect(settleUnreadWrites(db, UNTIL, 1_000)).toBe(6)
  expect(expected(false)).toBe(1_500)
  expect(savedUnread(db, [SESSION], window, { titles: false })).toEqual({ unread: expected(false), pending: 0 })
  expect(expected(true)).toBe(700)
  expect(savedUnread(db, [SESSION], window, { titles: true })).toEqual({ unread: expected(true), pending: 0 })
})

test("an expired write stays pending until it is settled", async () => {
  const db = await session()
  const window = { since: 0, until: UNTIL }

  expect(settleUnreadWrites(db, 0, 1_000)).toBe(3)
  expect(savedUnread(db, [SESSION], window, { titles: false })).toEqual({ unread: 0, pending: 3 })
  expect(settleUnreadWrites(db, UNTIL, 1_000)).toBe(3)
  expect(savedUnread(db, [SESSION], window, { titles: false })).toEqual({
    unread: windowedSessionSignals(sessionFold(db, SESSION).analysis, window, { titles: false }).unread,
    pending: 0,
  })
  expect(settleUnreadWrites(db, UNTIL, 1_000)).toBe(0)
})

test("a write whose lifetime is unknown is saved but never counted", async () => {
  const db = await ledger()
  db.session({ id: SESSION }, 0)
  db.requestStarted({ id: "r0", sessionID: SESSION, kind: "step", agent: "build", provider: "p", model: "m", started: 1_000 })
  db.requestEnded("r0", { ended: 1_001, status: "completed", usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 900, cost: 0 } })

  expect(settleUnreadWrites(db, 1_000_000, 1_000)).toBe(1)
  expect(savedUnread(db, [SESSION], { since: 0, until: 1_000_000 }, {})).toEqual({ unread: 0, pending: 0 })
})

// Every write's 24-hour lifetime has ended by EXPIRED; r5 starts inside them, minutes before.
const EXPIRED = 86_500_000
const LATE = 86_000_000

test("a request still running inside the write's lifetime defers finalizing it", async () => {
  const db = await session()
  const window = { since: 0, until: UNTIL }
  db.requestStarted({ id: "r5", sessionID: SESSION, kind: "step", agent: "build", provider: "p", model: "m", started: LATE })

  expect(settleUnreadWrites(db, EXPIRED, 1_000)).toBe(3)
  expect(savedUnread(db, [SESSION], window, { titles: false })).toEqual({ unread: 0, pending: 3 })
  db.requestEnded("r5", { ended: LATE + 1, status: "completed", usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } })
  expect(settleUnreadWrites(db, EXPIRED, 1_000)).toBe(3)
  expect(savedUnread(db, [SESSION], window, { titles: false })).toEqual({
    unread: windowedSessionSignals(sessionFold(db, SESSION).analysis, window, { titles: false }).unread,
    pending: 0,
  })
})

test("a request still open six hours after it started no longer defers, as the fold reads nothing from it", async () => {
  const db = await session()
  const window = { since: 0, until: UNTIL }
  db.requestStarted({ id: "r5", sessionID: SESSION, kind: "step", agent: "build", provider: "p", model: "m", started: LATE })

  expect(settleUnreadWrites(db, EXPIRED, 1_000)).toBe(3)
  expect(settleUnreadWrites(db, LATE + 6 * 3_600_000 + 1, 1_000)).toBe(3)
  expect(savedUnread(db, [SESSION], window, { titles: false })).toEqual({
    unread: windowedSessionSignals(sessionFold(db, SESSION).analysis, window, { titles: false }).unread,
    pending: 0,
  })
})
