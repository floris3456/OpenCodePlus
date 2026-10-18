import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import type { Ledger } from "../src/monitor/ledger.js"
import { dismissNotice, queryNotices, sessionChecklist } from "../src/monitor/notices.js"
import type { PlusSettings } from "../src/rpc.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

const MINUTE = 60_000
const NOW = 100 * 60 * MINUTE
const settings: PlusSettings = {
  coldCompact: false,
  noticeMinutes: 15,
  noticeMinTokens: 0,
  noticeKinds: "misses-and-partials",
  noticeDismiss: "everywhere",
  imageFormat: "webp",
  imageSize: "full",
  imagesFull: "compact",
}

/** One measured step that read `read` of 4,100 input tokens from the cache. */
function step(db: Ledger, id: string, sessionID: string, ended: number, read: number) {
  db.requestStarted({ id, sessionID, kind: "step", started: ended - 1_000, provider: "openai", model: "gpt-4o", agent: "general", messageID: id })
  db.requestFingerprint({ requestID: id, sessionID, ...fingerprintWireBody({ messages: [{ role: "user", content: "unchanged".repeat(1000) }] }) })
  db.requestEnded(id, { ended, status: "completed", usage: { input: 4_100 - read, output: 10, reasoning: 0, cacheRead: read, cacheWrite: 0, cost: 0 } })
  db.requestObserved(id, { version: 1, completeness: "final", inputTokens: 4_100, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
}

test("notices list misses of any session within the lifetime, newest first, with the tree they belong to", async () => {
  const db = await ledger()
  db.session({ id: "ses_root", agent: "build", title: "Chat" }, NOW - 30 * MINUTE)
  db.session({ id: "ses_sub", parentID: "ses_root", agent: "general", title: "Round 2: scene visuals" }, NOW - 30 * MINUTE)
  db.session({ id: "ses_other", agent: "build", title: "Another chat" }, NOW - 30 * MINUTE)
  step(db, "old-hit", "ses_sub", NOW - 40 * MINUTE, 0)
  step(db, "old-hit-2", "ses_sub", NOW - 39 * MINUTE, 4_000)
  step(db, "expired-miss", "ses_sub", NOW - 20 * MINUTE, 0)
  step(db, "warm", "ses_sub", NOW - 10 * MINUTE, 4_000)
  step(db, "sub-miss", "ses_sub", NOW - 5 * MINUTE, 0)
  step(db, "other-warm", "ses_other", NOW - 4 * MINUTE, 0)
  step(db, "other-warm-2", "ses_other", NOW - 3 * MINUTE, 4_000)
  step(db, "other-miss", "ses_other", NOW - 2 * MINUTE, 0)

  const notices = queryNotices(db, settings, NOW)
  expect(notices.map((notice) => notice.requestID)).toEqual(["other-miss", "sub-miss"])
  expect(notices[1]).toMatchObject({
    sessionID: "ses_sub",
    rootID: "ses_root",
    title: "Round 2: scene visuals",
    agent: "general",
    verdict: "miss",
    at: NOW - 5 * MINUTE,
  })
  expect(notices[1]!.missTokens).toBeGreaterThan(0)
  // A longer lifetime brings back the older miss.
  expect(queryNotices(db, { ...settings, noticeMinutes: 30 }, NOW).map((notice) => notice.requestID)).toContain("expired-miss")
  // A minimum above every loss hides them all.
  expect(queryNotices(db, { ...settings, noticeMinTokens: 100_000 }, NOW)).toEqual([])
})

test("an opened notice is hidden from every reader of the server's ledger", async () => {
  const db = await ledger()
  db.session({ id: "ses_a", agent: "build" }, NOW - 10 * MINUTE)
  step(db, "a-warm", "ses_a", NOW - 9 * MINUTE, 4_000)
  step(db, "a-miss", "ses_a", NOW - 8 * MINUTE, 0)
  step(db, "a-warm-2", "ses_a", NOW - 7 * MINUTE, 4_000)
  step(db, "a-miss-2", "ses_a", NOW - 6 * MINUTE, 0)
  expect(queryNotices(db, settings, NOW).map((notice) => notice.requestID)).toEqual(["a-miss-2", "a-miss"])
  dismissNotice(db, "a-miss-2", NOW)
  expect(queryNotices(db, settings, NOW).map((notice) => notice.requestID)).toEqual(["a-miss"])
})

test("the checklist lists active trees with the chat's tree first, and descendants only under expanded roots", async () => {
  const db = await ledger()
  db.session({ id: "ses_chat", agent: "build", title: "My chat" }, NOW - 50 * MINUTE)
  db.session({ id: "ses_chat_sub", parentID: "ses_chat", agent: "general", title: "Subagent" }, NOW - 50 * MINUTE)
  db.session({ id: "ses_busy", agent: "build", title: "Busy chat" }, NOW - MINUTE)
  db.session({ id: "ses_busy_sub", parentID: "ses_busy", agent: "general", title: "Busy subagent" }, NOW - MINUTE)
  db.session({ id: "ses_old", agent: "build", title: "Old chat" }, NOW - 90 * MINUTE)

  const active = new Set(["ses_busy_sub"])
  const collapsed = sessionChecklist(db, { first: "ses_chat_sub" }, { active, now: NOW })
  expect(collapsed.sessions.map((row) => [row.sessionID, row.depth, row.descendants])).toEqual([
    ["ses_chat", 0, 1],
    ["ses_busy", 0, 1],
  ])
  expect(collapsed).toMatchObject({ roots: 2, inactive: 1 })

  const expanded = sessionChecklist(db, { first: "ses_chat", expanded: ["ses_chat", "ses_busy"] }, { active, now: NOW })
  expect(expanded.sessions.map((row) => [row.sessionID, row.depth, row.active])).toEqual([
    ["ses_chat", 0, false],
    ["ses_chat_sub", 1, false],
    ["ses_busy", 0, false],
    ["ses_busy_sub", 1, true],
  ])

  const everything = sessionChecklist(db, { all: true }, { active, now: NOW })
  expect(everything.sessions.map((row) => row.sessionID)).toEqual(["ses_busy", "ses_chat", "ses_old"])
  expect(everything.inactive).toBe(0)
})
