import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { queryMonitor } from "../src/monitor/query.js"
import { requestReport, sessionFold } from "../src/monitor/report.js"
import { reportPage } from "../src/monitor/report-page.js"
import type { MonitorQueryInput, MonitorPageSection } from "../src/rpc.js"
import { cleanupLedgers, ledger, saveAll } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

async function populated() {
  const db = await ledger()
  for (let i = 0; i < 125; i++) {
    const sessionID = `s${String(i).padStart(4, "0")}`
    db.session(
      { id: sessionID, agent: `agent-${i}`, team: `team-${i}`, directory: "/fixture", title: `Fixture ${i}` },
      1,
    )
    for (const [suffix, started] of [
      ["a", 1000],
      ["b", 5000],
    ] as const) {
      const id = `${sessionID}-${suffix}`
      db.requestStarted({ id, sessionID, messageID: id, agent: `agent-${i}`, kind: "step", started })
      db.requestEnded(id, { status: "completed", ended: started + 1 })
      db.requestFingerprint({
        requestID: id,
        sessionID,
        ...fingerprintWireBody({
          input: "fixture",
          tools: Array.from({ length: 75 }, (_, j) => ({ type: "function", name: `tool-${j}`, description: suffix })),
        }),
      })
    }
    db.callStarted({
      sessionID,
      messageID: `${sessionID}-b`,
      callID: `base-${i}`,
      agent: `agent-${i}`,
      model: `model-${i}`,
      tool: `tool-${i}`,
      idx: 0,
      epoch: 0,
      status: "completed",
      started: 5000,
      inputChars: 1,
    })
  }
  for (let i = 0; i < 120; i++) {
    db.callStarted({
      sessionID: "s0000",
      messageID: "s0000-b",
      callID: `call-${i}`,
      tool: `detail-tool-${i}`,
      idx: i,
      epoch: 0,
      status: "completed",
      started: 5000,
      inputChars: 1,
      target: i === 0 ? "α".repeat(10000) : `target-${i}`,
    })
    db.contextFact({
      sessionID: "s0000",
      at: 2000 + i,
      kind: "account_switch",
      detail: { from: `fixture-${i}`, to: `fixture-${i + 1}` },
    })
    db.contextFact({
      sessionID: "s0000",
      at: 2000 + i,
      kind: "instruction_update",
      detail: { keys: [`fixture-key-${i}`] },
    })
    db.contextFact({ sessionID: "s0000", at: 2000 + i, kind: "revert" })
  }
  // 250 results: more than one query saves; the background backfill saves them all.
  saveAll(db)
  return db
}

test("all remaining collections are bounded and reachable with exact population counts; facet continuations are not hidden", async () => {
  const db = await populated()
  const input = { scope: "all", since: 0, until: 10000 } as const
  for (const [view, section, expected] of [
    ["sessions", "sessions", 125],
    ["overview", "agents", 125],
    ["overview", "context", 125],
    ["cache", "teams", 125],
  ] as const) {
    let report = queryMonitor(db, { ...input, view }, { now: 10000 })
    const firstTotals = report.totals
    expect(report.pages?.[section]).toMatchObject({ total: expected, returned: 100, complete: false, reset: false })
    const seen = new Set<string>()
    while (true) {
      const rows = report[section]!
      rows.forEach((row) => {
        const key = JSON.stringify(row)
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      })
      const cursor = report.pages?.[section]?.next
      if (!cursor) break
      report = queryMonitor(db, { ...input, view, pages: { [section]: { cursor } } }, { now: 10000 })
      expect(report.totals).toEqual(firstTotals)
    }
    expect(seen.size).toBe(expected)
  }
  for (const dimension of ["agents", "models", "tools"] as const) {
    const section = `facets.${dimension}` as MonitorPageSection
    let report = queryMonitor(db, { ...input, view: "cache" }, { now: 10000 })
    const total = report.facets.pages?.[section]?.total
    expect(total).toBeGreaterThan(100)
    const seen = new Set(report.facets[dimension])
    while (report.facets.pages?.[section]?.next) {
      report = queryMonitor(
        db,
        { ...input, view: "cache", pages: { [section]: { cursor: report.facets.pages[section]!.next } } },
        { now: 10000 },
      )
      report.facets[dimension].forEach((value) => {
        expect(seen.has(value)).toBe(false)
        seen.add(value)
      })
    }
    expect(seen.size).toBe(total!)
  }
})

test("detail arrays paginate independently without eager expansion; calls and text remain inspectable", async () => {
  const db = await populated()
  const input = { scope: "session", sessionID: "s0000", view: "cache", since: 0, until: 10000, id: "s0000-b" } as const
  const first = queryMonitor(db, input, { now: 10000 })
  expect(first.pages!["detail.segments"]!.total).toBeGreaterThan(50)
  expect(first.pages!["detail.accounts"]!.total).toBe(120)
  expect(first.pages!["detail.instructions"]!.total).toBe(120)
  expect(first.pages!["detail.reverts"]!.total).toBe(120)
  expect(first.pages?.["detail.calls"]).toMatchObject({ total: 121, returned: 50, complete: false })
  expect(first.detail?.request).toMatchObject({ toolsTotal: 121, toolsComplete: false })
  expect(first.detail?.request.tools).toHaveLength(20)
  expect(first.presentation?.truncated.some((r) => r.field === "target")).toBe(true)
  const unabridged = queryMonitor(db, { ...input, fullText: true }, { now: 10000 })
  expect(unabridged.detail?.calls?.find((c) => c.callID === "call-0")?.target).toHaveLength(10000)
  const analysis = sessionFold(db, "s0000").analysis
  const expansions = analysis.work.details
  for (const section of ["segments", "calls", "accounts", "instructions", "reverts", "lines", "pings"] as const) {
    const name = `detail.${section}` as MonitorPageSection
    let report = first
    const seen = new Set<string>()
    while (true) {
      report.detail![section]!.forEach((row) => {
        const key = JSON.stringify(row)
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      })
      const cursor = report.pages?.[name]?.next
      if (!cursor) break
      report = queryMonitor(db, { ...input, pages: { [name]: { cursor } } }, { now: 10000 })
      expect(report.totals).toEqual(first.totals)
    }
    expect(seen.size).toBe(first.pages![name]!.total)
  }
  expect(analysis.work.details).toBe(expansions)
  const oldCallCursor = first.pages!["detail.calls"]!.next!
  db.db.query("update call set target = 'corrected' where session_id = ? and call_id = ?").run("s0000", "call-0")
  const corrected = queryMonitor(db, { ...input, pages: { "detail.calls": { cursor: oldCallCursor } } }, { now: 10000 })
  expect(corrected.pages!["detail.calls"]).toMatchObject({ reset: true, offset: 0, total: 121 })
  expect(corrected.detail!.calls!.find((c) => c.callID === "call-0")?.target).toBe("corrected")
  expect(queryMonitor(db, { ...input, id: "missing" }, { now: 10000 }).detail).toBeUndefined()
  expect(queryMonitor(db, { ...input, sessionID: "s0001" }, { now: 10000 }).detail).toBeUndefined()
})

test("stale revision, empty populations and max limits are explicit; enrichment uses two bounded indexed batches", async () => {
  const db = await populated()
  const input = { scope: "all", view: "sessions", since: 0, until: 10000 } as const
  const first = queryMonitor(db, input, { now: 10000 })
  db.session({ id: "new", title: "new" }, 1)
  const changed = queryMonitor(
    db,
    { ...input, pages: { sessions: { cursor: first.pages!.sessions!.next } } },
    { now: 10000 },
  )
  expect(changed.pages?.sessions).toMatchObject({ total: 126, offset: 0, reset: true, complete: false })
  expect(queryMonitor(db, { ...input, pages: { sessions: { limit: 1e9 } } }, { now: 10000 }).sessions).toHaveLength(126)
  const empty = queryMonitor(db, { ...input, scope: "session", sessionID: "missing" }, { now: 10000 })
  expect(empty.pages?.sessions).toMatchObject({ total: 0, returned: 0, complete: true })
  const report = requestReport(db, { ...input, view: "cache" }, { now: 10000 }, { since: 0, until: 10000 })
  expect(report.enrichment).toMatchObject({ statements: 2, messages: 100 })
  expect(report.enrichment.toolRows).toBeLessThanOrEqual(2000)
  expect(report.sections.requests).toHaveLength(100)
  const plan = db.db
    .query<
      { detail: string },
      []
    >("explain query plan with selected(session_id,message_id) as (select json_extract(value,'$[0]'),json_extract(value,'$[1]') from json_each('[[\"s0000\",\"s0000-b\"]]')) select c.tool from selected k join call c indexed by call_message on c.session_id=k.session_id and c.message_id=k.message_id")
    .all()
  expect(
    plan.some((row) => row.detail.includes("call_message") && row.detail.includes("session_id=? AND message_id=?")),
  ).toBe(true)
  const max = reportPage(
    Array.from({ length: 620 }, (_, i) => i),
    { limit: 9999 },
  )
  expect(max.rows).toHaveLength(500)
  expect(max.metadata).toMatchObject({ total: 620, returned: 500, complete: false })
})
