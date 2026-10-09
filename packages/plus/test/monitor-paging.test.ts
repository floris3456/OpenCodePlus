import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { queryMonitor } from "../src/monitor/query.js"
import type { MonitorQueryInput } from "../src/rpc.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

test("keyset enumeration reaches the whole equal-timestamp population; totals never depend on page", async () => {
  const db = await ledger()
  db.session({ id: "s" }, 1)
  const ids = Array.from({ length: 607 }, (_, i) => `r${String(i).padStart(4, "0")}`)
  ids.toReversed().forEach((id, i) => {
    db.requestStarted({ id, sessionID: "s", messageID: id, agent: i % 2 ? "odd" : "even", kind: "step", started: Math.floor((606 - i) / 7) + 1 })
    db.requestEnded(id, { status: "completed", ended: 99 })
    db.callStarted({ sessionID: "s", messageID: id, callID: `call-${id}`, tool: `tool-${id}`, idx: i, epoch: 0, status: "completed", started: 1, inputChars: 0 })
  })
  const input = { scope: "session", sessionID: "s", view: "cache" } as const
  const query = (requestPage?: MonitorQueryInput["requestPage"]) => queryMonitor(db, { ...input, requestPage }, { now: 100 })
  const first = query()
  expect(first.requests).toHaveLength(100)
  expect(first.requests!.every((r) => r.tools?.[0] === `tool-${r.id}`)).toBe(true)
  expect(db.db.query<{ detail: string }, []>("explain query plan select distinct tool from call where session_id = 's' and message_id = 'r0000'").all().some((r) => r.detail.includes("call_message"))).toBe(true)
  expect(first.requestPage).toMatchObject({ total: 607, returned: 100, complete: false, limit: 100 })
  const seen = new Set(first.requests!.map((r) => r.id))
  let page = first
  while (page.requestPage?.older) {
    page = query({ cursor: page.requestPage.older, direction: "older" })
    expect(page.totals).toEqual(first.totals)
    page.requests!.forEach((r) => { expect(seen.has(r.id)).toBe(false); seen.add(r.id) })
  }
  expect([...seen].sort()).toEqual(ids)
  const newer = query({ cursor: page.requestPage!.newer, direction: "newer" })
  expect(newer.requests![0]!.at).toBeGreaterThanOrEqual(page.requests!.at(-1)!.at)
  expect(query({ limit: 1e9 }).requests).toHaveLength(500)
  expect(query({ limit: 0 }).requests).toHaveLength(1)
  expect(query({ limit: Number.NaN }).requests).toHaveLength(100)
  const filteredIDs: string[] = []
  let filtered = queryMonitor(db, { ...input, agents: ["even"] }, { now: 100 })
  expect(filtered.requestPage?.total).toBe(304)
  while (true) {
    filteredIDs.push(...filtered.requests!.map((r) => r.id))
    if (!filtered.requestPage?.older) break
    filtered = queryMonitor(db, { ...input, agents: ["even"], requestPage: { cursor: filtered.requestPage.older } }, { now: 100 })
    expect(filtered.requestPage?.total).toBe(304)
    expect(filtered.totals.requests).toBe(304)
  }
  expect(filteredIDs.sort()).toEqual(ids.filter((_, i) => i % 2 === 0))
})

test("cursor survives deletion, insertion, settlement and fingerprint correction; detail is scope/window checked", async () => {
  const db = await ledger()
  db.session({ id: "s" }, 1)
  db.session({ id: "other" }, 1)
  for (const id of ["a", "b", "c", "d"]) db.requestStarted({ id, sessionID: "s", kind: "step", started: 10 })
  db.requestStarted({ id: "outside", sessionID: "other", kind: "step", started: 10 })
  const input = { scope: "session", sessionID: "s", view: "cache" } as const
  const query = (extra: Partial<MonitorQueryInput> = {}) => queryMonitor(db, { ...input, ...extra }, { now: 100 })
  const first = query({ requestPage: { limit: 2 } })
  expect(first.requests!.map((r) => r.id)).toEqual(["c", "d"])
  const cursor = first.requestPage!.older!
  db.db.query("delete from request where id = ?").run("c")
  db.requestStarted({ id: "bb", sessionID: "s", kind: "step", started: 10 })
  db.requestEnded("b", { status: "completed", ended: 20 })
  db.requestFingerprint({ requestID: "b", sessionID: "s", ...fingerprintWireBody({ input: "fixture" }) })
  expect(query({ requestPage: { limit: 2, cursor } }).requests!.map((r) => r.id)).toEqual(["b", "bb"])
  expect(query({ id: "b", requestPage: { limit: 1 } }).detail?.request.id).toBe("b")
  expect(query({ id: "outside" }).detail).toBeUndefined()
  expect(query({ id: "missing" }).detail).toBeUndefined()
  expect(query({ id: "b", since: 11 }).detail).toBeUndefined()
  const empty = query({ agents: ["absent"], requestPage: { cursor } })
  expect(empty.requests).toEqual([])
  expect(empty.requestPage).toMatchObject({ total: 0, returned: 0, complete: true })
  expect(query().requestPage?.total).toBe(4)
})
