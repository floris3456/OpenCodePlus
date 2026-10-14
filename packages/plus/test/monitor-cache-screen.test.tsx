import { afterEach, expect, test } from "bun:test"
import type { Plus } from "../src/rpc.js"
import { projectCacheResult, queryCacheResults } from "../src/monitor/snapshot.js"
import { CacheScreen } from "../src/tui/monitor/cache-screen.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"
import { dispatch } from "./instructions-nav.js"
import { renderPlusFixture } from "./tui.js"

afterEach(cleanupLedgers)

test.each([60, 120])("cache screen opens on this chat and lists active sessions at width %s", async (width) => {
  const db = await ledger()
  db.session({ id: "chat", title: "Active conversation" }, Date.now())
  db.session({ id: "other", title: "Another conversation" }, Date.now())
  const queries: Plus.MonitorQueryInput[] = []
  const fixture = await renderPlusFixture({
    snapshots: [], width, height: 25, dialogs: { selects: ["other"] },
    render: (context) => <CacheScreen context={context} sessionID={() => "chat"} active={() => true} onClose={() => {}} />,
    rpc: { "monitor.cache": async (input: Plus.MonitorQueryInput) => {
      queries.push(input)
      return queryCacheResults(db, input)
    } },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("Active conversation"))
    expect(queries[0]).toMatchObject({ scope: "session", sessionID: "chat" })
    await dispatch(fixture, "s")
    await fixture.waitForFrame((text) => text.includes("Another conversation"))
    expect(fixture.fake.selectInputs.at(-1)?.options.map((option) => option.value)).toContain("chat")
    expect(queries.at(-1)).toMatchObject({ scope: "session", sessionID: "other" })
  } finally {
    fixture.destroy()
  }
})

test("miss evidence keeps the header visible and compaction remains a kind annotation", async () => {
  const db = await ledger()
  db.session({ id: "chat", title: "Detail fixture" }, 1)
  for (const [id, at, read, kind] of [["a", 10, 10000, "step"], ["b", 20, 0, "compaction"]] as const) {
    db.requestStarted({ id, sessionID: "chat", kind, started: at })
    db.requestEnded(id, { ended: at + 1, status: "completed" })
    db.requestObserved(id, { version: 1, completeness: "final", historyEpoch: "same", inputTokens: 11000, cacheReadInputTokens: read, cacheWriteInputTokens: 0 })
    projectCacheResult(db, id)
  }
  const fixture = await renderPlusFixture({ snapshots: [], width: 60, height: 14,
    render: (context) => <CacheScreen context={context} sessionID={() => "chat"} active={() => true} onClose={() => {}} />,
    rpc: { "monitor.cache": async (input: Plus.MonitorQueryInput) => queryCacheResults(db, input) },
  })
  try {
    const rows = await fixture.waitForFrame((text) => text.includes("[comp]") && text.includes("miss"))
    expect(rows).toContain("1 misses/partials")
    expect(dispatch(fixture, "enter")).toBe(true)
    const detail = await fixture.waitForFrame((text) => text.includes("baseline 10000"))
    expect(detail.split("\n")[0]).toContain("Detail fixture")
    expect(detail.split("\n")[1]).toContain("2 requests")
    await dispatch(fixture, "down")
    await dispatch(fixture, "escape")
    await fixture.waitForFrame((text) => text.includes("[comp]"))
  } finally {
    fixture.destroy()
  }
})
