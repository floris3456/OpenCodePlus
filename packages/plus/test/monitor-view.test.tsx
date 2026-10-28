import { afterEach, expect, test } from "bun:test"
import type { Ledger } from "../src/monitor/ledger.js"
import { sessionChecklist } from "../src/monitor/notices.js"
import { queryMonitor } from "../src/monitor/query.js"
import { captureWire, queryCacheResults } from "../src/monitor/snapshot.js"
import { queryPrompt } from "../src/monitor/wire.js"
import type { Plus } from "../src/rpc.js"
import {
  defaultSettings,
  drillInto,
  formatDelta,
  formatTokens,
  formatReusePercent,
  formatReportedRead,
  formatReportedWriteByTTL,
  queryOf,
  type MonitorSettings,
} from "../src/tui/monitor/format.js"
import {
  groupMountLog,
  MonitorView,
  refreshInterval,
  resetGroupMountLog,
  stopGroupMountLog,
  TOOLS_BODY_ROWS,
  type MonitorTarget,
} from "../src/tui/monitor/view.js"
import { createSignal } from "solid-js"
import { cleanupLedgers, collect, contractFixtureReport, ledger, saveAll, script, usage } from "./monitor-fixture.js"
import { dispatch, sleep } from "./instructions-nav.js"
import { createTestTheme, renderPlusFixture, type DialogScript, type TestFixture } from "./tui.js"

afterEach(cleanupLedgers)

const NOW = 1_800_000_000_000

test("the Sessions checklist opens with this chat's tree open and only the chat checked; space and ctrl+space check sessions and trees", async () => {
  const db = await seeded()
  const { fixture, queries, lists, closed } = await render(db, {
    initialSession: true,
    settings: { ...defaultSettings, scope: "all", tab: "sessions" },
  })
  try {
    const first = await fixture.waitForFrame((text) => text.includes("└─") && text.includes("filters 1"))
    expect(queries[0]).toMatchObject({ scope: "session", sessionIDs: ["ses_chat"] })
    expect(lists[0]).toMatchObject({ first: "ses_chat", expanded: ["ses_chat"] })
    // No S needed: the chat and its subagent are listed, the chat checked.
    expect(first).toMatch(/\[x\] ▼ Fix the thing/)
    expect(first).toMatch(/\[ \] {3}└─ ses_child/)
    expect(first).toContain("Active sessions · 1 tree")

    // space checks the subagent too; the filter stays one Back step.
    await dispatch(fixture, "down")
    await dispatch(fixture, "space")
    await fixture.waitForFrame((text) => text.includes("2 sessions") && text.includes("filters 1"))
    expect(queries.at(-1)?.sessionIDs).toEqual(["ses_chat", "ses_child"])
    await dispatch(fixture, "space")
    await fixture.waitForFrame((text) => !text.includes("2 sessions"))
    expect(queries.at(-1)?.sessionIDs).toEqual(["ses_chat"])

    // ctrl+space checks the whole tree, and unchecks it when all of it is checked.
    await dispatch(fixture, "ctrl+space")
    await fixture.waitForFrame(() => queries.at(-1)?.sessionIDs?.length === 2)
    await dispatch(fixture, "ctrl+space")
    await fixture.waitForFrame((text) => text.includes("No session checked"))
    expect(queries.at(-1)?.sessionIDs).toEqual([])

    // ← closes the tree onto its root, → opens it again.
    await dispatch(fixture, "left")
    await fixture.waitForFrame((text) => text.includes("▶ Fix the thing (1)") && !text.includes("└─"))
    await dispatch(fixture, "right")
    await fixture.waitForFrame((text) => text.includes("▼ Fix the thing") && text.includes("└─"))

    await dispatch(fixture, "escape")
    expect(closed()).toBe(1)
    // Backspace drops the checks and returns to the stored scope, untouched.
    await dispatch(fixture, "backspace")
    await fixture.waitForFrame((text) => !text.includes("⌫ undo"))
    expect(queries.at(-1)?.scope).toBe("all")
    expect((fixture.storeValue("monitor") as { settings: MonitorSettings }).settings.scope).toBe("all")
  } finally {
    fixture.destroy()
  }
})

test("a cache notice opens its session alone on the Cache tab, loads older pages until its request is selected, and marks it", async () => {
  const db = await ledger()
  db.session({ id: "ses_chat" }, NOW - 1000)
  db.session({ id: "ses_sub", parentID: "ses_chat" }, NOW - 1000)
  for (let i = 0; i < 205; i++) {
    const id = `page-${String(i).padStart(3, "0")}`
    db.requestStarted({ id, sessionID: "ses_sub", kind: "step", started: NOW - 500 + i })
    db.requestEnded(id, { status: "completed", ended: NOW - 200 })
  }
  db.requestStarted({ id: "chat-step", sessionID: "ses_chat", kind: "step", started: NOW - 100 })
  db.requestEnded("chat-step", { status: "completed", ended: NOW - 50 })
  const [target, setTarget] = createSignal<MonitorTarget>()
  const taken = { count: 0 }
  const { fixture, queries } = await render(db, {
    initialSession: true,
    width: 120,
    height: 30,
    // Filters that would hide the request: another tab, a short window, one agent.
    settings: { ...defaultSettings, tab: "tools", window: "15m", agent: "build" },
    target,
    onTarget: () => {
      taken.count++
      setTarget(undefined)
    },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("filters 1"))
    setTarget({ sessionID: "ses_sub", requestID: "page-010" })
    // page-010 is the 195th newest: the second page of older rows has to load first.
    await fixture.waitForFrame((text) => text.includes("row 195 of"))
    expect(taken.count).toBe(1)
    expect(queries.at(-1)).toMatchObject({ scope: "session", sessionIDs: ["ses_sub"], view: "cache" })
    expect(queries.at(-1)?.since).toBeUndefined()
    expect(queries.at(-1)?.agents).toBeUndefined()
    expect(fixture.captureCharFrame()).toContain("Scope: This session: ses_sub")

    // With the selection moved away, the notice's request keeps its mark.
    await dispatch(fixture, "up")
    await fixture.waitForFrame((text) => text.includes("row 194 of"))
    const row = fixture.renderer.root.findDescendantById("monitor-row-page-010") as unknown as { backgroundColor: { equals: (other: unknown) => boolean } }
    expect(row.backgroundColor.equals(createTestTheme().background.feedback.warning.base)).toBe(true)
  } finally {
    fixture.destroy()
  }
})

test("undoing the automatic chat filter exposes the project rather than implicitly selecting the same chat", async () => {
  const { fixture, queries } = await render(await seeded(), { initialSession: true })
  try {
    await fixture.waitForFrame((text) => text.includes("filters 1"))
    await dispatch(fixture, "backspace")
    await fixture.waitForFrame((text) => text.includes("Scope: Project"))
    expect(queries.at(-1)).toMatchObject({ scope: "project" })
    expect(queries.at(-1)?.sessionIDs).toBeUndefined()
  } finally {
    fixture.destroy()
  }
})

test("the Prompt tab lists every sent item, opens one verbatim, steps between requests, and P jumps from Cache", async () => {
  const db = await seeded()
  const body = (messages: unknown[]) => JSON.stringify({ model: "fixture-model", system: [{ type: "text", text: "Fixture system prompt" }], messages })
  const asked = { role: "user", content: [{ type: "text", text: "Read the fixture file" }] }
  const called = { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { filePath: "src/a.ts" } }] }
  const answered = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export const a = 1" }] }
  const sent = db.db.query<{ id: string; started: number }, []>("select id, started from request where session_id = 'ses_chat' order by started").all()
  await captureWire(db, sent[0]!.id, body([asked]), { sessionID: "ses_chat", at: sent[0]!.started })
  await captureWire(db, sent[1]!.id, body([asked, called, answered]), { sessionID: "ses_chat", at: sent[1]!.started })
  const { fixture } = await render(db, { settings: { ...defaultSettings, tab: "cache" } })
  try {
    await fixture.waitForFrame((text) => text.includes("reqs: 2"))
    dispatch(fixture, "2")
    const list = await fixture.waitForFrame((text) => text.includes("request 2/2") && text.includes("export const a = 1"))
    expect(list).toContain("Fixture system prompt")
    expect(list).toContain("Read the fixture file")
    expect(list).toMatch(/\+ +call +\S+ +read src\/a\.ts/)
    expect(list).toMatch(/result +\S+ +read · 18 chars · export const a = 1/)
    expect(list).toContain("2 new")
    expect(list).toContain("live")

    // The last item is selected; Enter shows it readable, v the exact JSON, ⌫ goes back.
    dispatch(fixture, "return")
    await sleep(300)
    await fixture.waitForFrame((text) => text.includes("messages[2].content[0] · readable") && text.includes("tool_use_id: toolu_1"))
    dispatch(fixture, "v")
    await fixture.waitForFrame((text) => text.includes('"tool_use_id": "toolu_1"'))
    dispatch(fixture, "backspace")
    await fixture.waitForFrame((text) => text.includes("request 2/2") && !text.includes("⌫ back"))

    // x keeps only what changed against the previous request.
    dispatch(fixture, "x")
    const changed = await fixture.waitForFrame((text) => text.includes("export const a = 1") && !text.includes("Fixture system prompt"))
    expect(changed).not.toContain("Read the fixture file")
    dispatch(fixture, "x")

    dispatch(fixture, "[")
    await sleep(300)
    const older = await fixture.waitForFrame((text) => text.includes("request 1/2"))
    expect(older).not.toContain("export const a = 1")
    expect(older).toContain("[l] latest")
    dispatch(fixture, "l")
    await sleep(300)
    await fixture.waitForFrame((text) => text.includes("request 2/2") && text.includes("live"))

    // From the Cache tab, P opens the selected (newest) request's prompt.
    dispatch(fixture, "1")
    await fixture.waitForFrame((text) => text.includes("What changed"))
    dispatch(fixture, "shift+p")
    await sleep(300)
    await fixture.waitForFrame((text) => text.includes("request 2/2") && text.includes("[l] latest"))
  } finally {
    fixture.destroy()
  }
})

test.each(["cache"] as const)("%s repeated Enter opens a request detail only once", async (tab) => {
  const { fixture } = await render(await seeded(), { settings: { ...defaultSettings, tab } })
  try {
    await fixture.waitForFrame((text) => text.includes("reqs: 2"))
    await dispatch(fixture, "return")
    await fixture.waitForFrame((text) => text.includes("filters 1"))
    await dispatch(fixture, "return")
    expect(await fixture.waitForFrame((text) => text.includes("filters 1"))).not.toContain("filters 2")
    await dispatch(fixture, "backspace")
    await fixture.waitForFrame((text) => !text.includes("⌫ undo"))
  } finally {
    fixture.destroy()
  }
})

test.each(["tool", "agent", "model"] as const)("%s group filtering cannot repeat a picker or row filter", (group) => {
  const row = { key: "selected" } as Plus.MonitorGroup
  expect(drillInto({ ...defaultSettings, group, [group]: row.key }, row)).toBeUndefined()
  expect(drillInto({ ...defaultSettings, group, [group]: "another" }, row)?.settings[group]).toBe(row.key)
})

test("Cache read cells distinguish stored legacy/absent/running from reported zero, and incomplete reuse never rounds to 100%", async () => {
  const db = await ledger()
  db.session({ id: "ses_chat" }, NOW - 10000)
  for (const [id, started] of [
    ["legacy", NOW - 5000],
    ["zero", NOW - 4000],
    ["absent", NOW - 3000],
    ["running", NOW - 2000],
  ] as const) {
    db.requestStarted({ id, sessionID: "ses_chat", kind: "step", started })
    if (id === "running") continue
    db.requestEnded(id, {
      status: "completed",
      ended: started + 1,
      usage: { input: 1000, output: 0, reasoning: 0, cacheRead: id === "legacy" ? 1000 : 0, cacheWrite: 0, cost: 0 },
    })
  }
  db.requestObserved("zero", { version: 1, completeness: "final", inputTokens: 1000, cacheReadInputTokens: 0 })
  db.requestObserved("absent", { version: 1, completeness: "final", inputTokens: 1000 })
  const report = queryMonitor(db, { scope: "session", sessionID: "ses_chat", view: "cache" }, { now: NOW })
  expect(report.requests!.map(formatReportedRead)).toEqual(["—", "0", "—", "—"])
  const overview = queryMonitor(db, { scope: "session", sessionID: "ses_chat", view: "overview" }, { now: NOW })
  expect(overview.context?.[0]).toMatchObject({ now: 0, inputState: "pending" })
  expect(
    queryMonitor(db, { scope: "session", sessionID: "ses_chat", view: "overview", since: NOW - 500 }, { now: NOW })
      .context?.[0]?.inputState,
  ).toBe("pending")
  expect(formatReusePercent(202000 / 203000)).toBe("99.5%")
  expect(formatReusePercent(999999 / 1000000)).toBe("<100%")
  expect(formatReusePercent(1)).toBe("100%")
  expect(formatReusePercent(undefined)).toBe("—")
  const request = report.requests![0]!
  expect(formatReportedWriteByTTL(request)).toBe("Reported write 5m: — · Reported write 1h: —")
  expect(
    formatReportedWriteByTTL({
      ...request,
      measurement: { state: "reported", write: 900, writeByTTL: { "5m": 700, "1h": 200 } },
    }),
  ).toBe("Reported write 5m: 700 · Reported write 1h: 200")
  expect(
    formatReportedWriteByTTL({ ...request, measurement: { state: "reported", write: 900, writeByTTL: { "5m": 0 } } }),
  ).toBe("Reported write 5m: 0 · Reported write 1h: —")
  const { fixture } = await render(db, { width: 80, height: 24, settings: { ...defaultSettings, tab: "cache" } })
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("row 1 of 4"))
    const lines = frame.split("\n")
    const header = lines.find((line) => line.includes("Verdict") && line.includes("Read"))!
    // Request rows start with their time; the verdict differs per row ("none", "unknown").
    expect(
      lines
        .filter((line) => /^\s*\d\d:\d\d:\d\d step /.test(line))
        .map((line) => line.slice(header.indexOf("Read"), header.indexOf("Lost")).trim()),
    ).toEqual(["—", "—", "0", "—"])
  } finally {
    fixture.destroy()
  }
})

test("detail collection pages update the real consumer, preserve polling cursor, expose full text and never fetch every page", async () => {
  const db = await ledger()
  db.session({ id: "ses_chat" }, NOW - 10000)
  db.requestStarted({ id: "detail", sessionID: "ses_chat", messageID: "detail", kind: "step", started: NOW - 5000 })
  db.requestEnded("detail", { status: "completed", ended: NOW - 4000 })
  for (let i = 0; i < 205; i++)
    db.callStarted({
      sessionID: "ses_chat",
      messageID: "detail",
      callID: `call-${String(i).padStart(3, "0")}`,
      tool: `tool-${i}`,
      idx: i,
      epoch: 0,
      status: "completed",
      started: NOW - 4000,
      inputChars: 1,
      target: i === 0 ? "α".repeat(2000) : `target-${i}`,
    })
  const { fixture, queries } = await render(db, {
    width: 80,
    height: 24,
    settings: { ...defaultSettings, tab: "cache" },
    dialogs: { selects: ["detail.calls"] },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("1/1 requests"))
    await dispatch(fixture, "return")
    await fixture.waitForFrame((text) => text.includes("Request Detail: detail"))
    await dispatch(fixture, "p")
    await fixture.waitForFrame((text) => text.includes("detail.calls 1-50/205"))
    await dispatch(fixture, "]")
    await fixture.waitForFrame((text) => text.includes("detail.calls 51-100/205") && text.includes("call-050"))
    const cursor = queries.at(-1)?.pages?.["detail.calls"]?.cursor
    const count = queries.length
    await sleep(1200)
    expect(queries.at(-1)?.pages?.["detail.calls"]?.cursor).toEqual(cursor)
    expect(queries.length - count).toBeLessThanOrEqual(2)
    expect(queries.some((query) => (query.pages?.["detail.calls"]?.cursor?.offset ?? 0) > 50)).toBe(false)
    await dispatch(fixture, "v")
    await fixture.waitForFrame(() => queries.at(-1)?.fullText === true)
    await dispatch(fixture, "l")
    await fixture.waitForFrame((text) => text.includes("detail.calls 1-50/205"))
  } finally {
    fixture.destroy()
  }
})

test("Sessions and session/facet pickers request further pages only on explicit navigation", async () => {
  const db = await ledger()
  for (let i = 0; i < 125; i++) {
    const id = `session-${String(i).padStart(3, "0")}`
    db.session({ id, directory: "/work/project", title: `Session ${i}` }, NOW - 10000)
    db.callStarted({
      sessionID: id,
      messageID: "fixture",
      callID: id,
      agent: `agent-${i}`,
      tool: "read",
      idx: 0,
      epoch: 0,
      status: "completed",
      started: NOW - 1000,
      inputChars: 1,
    })
  }
  const { fixture, queries, lists } = await render(db, {
    settings: { ...defaultSettings, scope: "all", tab: "sessions" },
    dialogs: { selects: ["\0next", "agent-99"] },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("trees 1-100/125"))
    await dispatch(fixture, "]")
    await fixture.waitForFrame((text) => text.includes("trees 101-125/125"))
    expect(lists.at(-1)?.page).toEqual({ offset: 100 })
    // space checks a session of the second page.
    await dispatch(fixture, "space")
    await fixture.waitForFrame(() => queries.some((q) => q.scope === "session" && q.sessionIDs?.length === 1))
    await dispatch(fixture, "l")
    await fixture.waitForFrame((text) => text.includes("trees 1-100/125"))
    await dispatch(fixture, "backspace")
    await dispatch(fixture, "a")
    await fixture.waitForFrame(() => queries.some((q) => q.pages?.["facets.agents"]?.cursor?.offset === 100))
  } finally {
    fixture.destroy()
  }
})

test("request page keys fetch only explicit pages, polling preserves cursor and filter scope resets it", async () => {
  const db = await ledger()
  db.session({ id: "ses_chat" }, NOW - 1000)
  for (let i = 0; i < 205; i++) {
    db.requestStarted({
      id: `page-${String(i).padStart(3, "0")}`,
      sessionID: "ses_chat",
      kind: "step",
      started: NOW - 500 + i,
    })
    db.requestEnded(`page-${String(i).padStart(3, "0")}`, { status: "completed", ended: NOW - 200 })
  }
  // More results than one query saves; the service's background backfill saves the rest.
  saveAll(db)
  const { fixture, queries } = await render(db, {
    width: 80,
    height: 24,
    settings: { ...defaultSettings, tab: "cache" },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("100/205 requests"))
    expect(queries.at(-1)?.requestPage).toBeUndefined()
    await dispatch(fixture, "[")
    await fixture.waitForFrame(() => queries.at(-1)?.requestPage?.direction === "older")
    const cursor = queries.at(-1)?.requestPage?.cursor
    expect(cursor).toBeDefined()
    await sleep(1200)
    expect(queries.at(-1)?.requestPage?.cursor).toEqual(cursor)
    expect(queries.filter((q) => q.requestPage?.cursor && q.requestPage.cursor.id !== cursor!.id)).toEqual([])
    await dispatch(fixture, "]")
    await fixture.waitForFrame(() => queries.at(-1)?.requestPage?.direction === "newer")
    await dispatch(fixture, "l")
    await fixture.waitForFrame(() => queries.at(-1)?.requestPage === undefined)
    await dispatch(fixture, "[")
    await fixture.waitForFrame(() => queries.at(-1)?.requestPage?.direction === "older")
    await dispatch(fixture, "x")
    await fixture.waitForFrame(() => queries.at(-1)?.missesOnly === true && queries.at(-1)?.requestPage === undefined)
  } finally {
    fixture.destroy()
  }
})

test("ended requests not analyzed yet are counted beside the request page", async () => {
  const db = await ledger()
  const report = { ...contractFixtureReport(NOW), requestPage: { total: 48, returned: 48, limit: 100, complete: true } }
  const { fixture } = await render(db, {
    width: 100,
    height: 24,
    settings: { ...defaultSettings, tab: "cache" },
    customReport: () => ({ ...report, cachePending: 157 }),
  })
  try {
    await fixture.waitForFrame((text) => text.includes("48/48 requests · 157 not analyzed yet · [—] older"))
  } finally {
    fixture.destroy()
  }
  const settled = await render(db, {
    width: 100,
    height: 24,
    settings: { ...defaultSettings, tab: "cache" },
    customReport: () => ({ ...report, cachePending: 0 }),
  })
  try {
    await settled.fixture.waitForFrame((text) => text.includes("48/48 requests · [—] older"))
  } finally {
    settled.fixture.destroy()
  }
})

// A chat that read a file and ran tests, then delegated to an explorer that grepped and failed an edit.
async function seeded(): Promise<Ledger> {
  const db = await ledger()
  const clock = { now: NOW - 60_000 }
  const collector = collect(db, clock)
  const chat = script("ses_chat", clock)
  chat.created({ agent: "build", title: "Fix the thing" })
  chat.step("m1")
  chat.call("m1", "c1", "read", { path: "/work/project/src/a.ts" })
  chat.call("m1", "c2", "shell", { command: "bun test test/a.test.ts" })
  chat.at(1_000)
  chat.ok("m1", "c1", "a".repeat(3_000))
  chat.at(2_000)
  chat.ok("m1", "c2", "b".repeat(1_000))
  chat.end("m1", "tool-calls", usage(1_000, 200, 9_000))
  chat.step("m2")
  chat.end("m2", "stop", usage(1_000, 50, 10_800))
  const child = script("ses_child", clock)
  child.created({ agent: "explore", parentID: "ses_chat" })
  child.step("k1", "explore")
  child.call("k1", "c3", "grep", { pattern: "needle" })
  child.ok("k1", "c3", "x".repeat(500))
  child.call("k1", "c4", "edit", { path: "/work/project/src/b.ts" })
  child.fail("k1", "c4", "old string not found")
  child.end("k1", "stop", usage(500, 40))
  ;[...chat.events, ...child.events].forEach((event) => collector.observe(event))
  return db
}

// A chat that used more distinct tools than the taller composer body shows, so
// the group table has to scroll to keep the selected row visible.
async function manyTools(): Promise<Ledger> {
  const db = await ledger()
  const clock = { now: NOW - 60_000 }
  const collector = collect(db, clock)
  const chat = script("ses_chat", clock)
  chat.created({ agent: "build", title: "Many tools" })
  chat.step("m1")
  const names = ["read", "shell", "grep", "edit", "glob", "list", "webfetch", "task", "write"]
  names.forEach((name, index) => chat.call("m1", `c${index}`, name, { path: `/work/project/${name}` }))
  chat.at(1_000)
  // Growing result sizes keep the token order deterministic.
  names.forEach((_, index) => chat.ok("m1", `c${index}`, "z".repeat(1_000 * (index + 1))))
  chat.end("m1", "stop", usage(1_000, 200, 9_000))
  chat.events.forEach((event) => collector.observe(event))
  return db
}

async function render(
  db: Ledger,
  options: {
    full?: boolean
    initialSession?: boolean
    width?: number
    height?: number
    dialogs?: DialogScript
    settings?: MonitorSettings
    /** Which durable store key the settings seed; defaults to the view's. */
    settingsKey?: string
    /** Render a marker line under the view to measure how many rows it took. */
    marker?: boolean
    /** Keep every monitor.query pending to observe the Loading state. */
    hold?: boolean
    customReport?: Plus.MonitorReport | ((input: Plus.MonitorQueryInput) => Plus.MonitorReport)
    /** Sessions the checklist counts as active; every ledger session when absent. */
    active?: readonly string[]
    /** A fixed Sessions checklist answer instead of the ledger's. */
    checklist?: Plus.MonitorSessionList
    /** Holds each Sessions checklist answer until the promise it returns settles. */
    checklistGate?: () => Promise<void>
    /** A cache notice the view opens on; cleared when the view takes it. */
    target?: () => MonitorTarget | undefined
    onTarget?: () => void
  } = {},
): Promise<{ fixture: TestFixture; queries: Plus.MonitorQueryInput[]; lists: Plus.MonitorSessionsInput[]; closed: () => number }> {
  const queries: Plus.MonitorQueryInput[] = []
  const lists: Plus.MonitorSessionsInput[] = []
  let closes = 0
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: options.width ?? 140,
    height: options.height ?? 40,
    ...(options.dialogs === undefined ? {} : { dialogs: options.dialogs }),
    ...(options.settings === undefined
      ? {}
      : {
          storage: new Map<string, unknown>([
            [
              options.settingsKey ?? ((options.full ?? true) ? "monitor" : "monitor-composer"),
              { settings: options.settings },
            ],
          ]),
        }),
    rpc: {
      "monitor.query": async (input: Plus.MonitorQueryInput) => {
        queries.push(input)
        if (options.hold === true) return await new Promise<never>(() => {})
        if (options.customReport !== undefined) {
          return typeof options.customReport === "function" ? options.customReport(input) : options.customReport
        }
        return queryMonitor(db, input, { directory: "/work/project", now: NOW })
      },
      // The scope picker's list, the Sessions checklist and the Prompt tab have their own RPCs.
      "monitor.cache": async (input: Plus.MonitorQueryInput) => queryCacheResults(db, input, { directory: "/work/project", now: NOW }),
      "monitor.sessions": async (input: Plus.MonitorSessionsInput) => {
        lists.push(input)
        await options.checklistGate?.()
        if (options.checklist !== undefined) return options.checklist
        const active = new Set(options.active ?? db.db.query<{ id: string }, []>("select id from session").all().map((row) => row.id))
        return sessionChecklist(db, input, { active, now: NOW, directory: "/work/project" })
      },
      "monitor.prompt": async (input: Plus.MonitorPromptInput) => queryPrompt(db, input),
      "monitor.mark": async (input: Plus.MonitorMarkInput) => ({
        id: db.mark(input.label, NOW),
        at: NOW,
        label: input.label,
      }),
    },
    render: (context) => {
      const view = (
        <MonitorView
          context={context}
          sessionID={() => "ses_chat"}
          active={() => true}
          full={options.full ?? true}
          initialSession={options.initialSession}
          {...(options.target === undefined ? {} : { target: options.target })}
          {...(options.onTarget === undefined ? {} : { onTarget: options.onTarget })}
          onClose={() => {
            closes += 1
          }}
        />
      )
      if (options.marker !== true) return view
      return (
        <box flexDirection="column">
          {view}
          <text>body-end</text>
        </box>
      )
    },
  })
  return { fixture, queries, lists, closed: () => closes }
}

/** The row under the view: the view's own height when it is the first child. */
function markerRow(frame: string): number {
  return frame.split("\n").findIndex((line) => line.trim() === "body-end")
}

const GROUP_LABELS = ["read", "shell", "grep", "edit", "glob", "list", "webfetch", "task", "write"]

/** The group rows drawn above the marker, in frame order. */
function groupRows(frame: string): string[] {
  const lines = frame.split("\n")
  const end = markerRow(frame)
  return lines
    .slice(0, end === -1 ? lines.length : end)
    .map((line) => line.trim())
    .filter((line) => GROUP_LABELS.some((label) => line.startsWith(`${label} `)))
    .map((line) => line.split(/\s+/)[0]!)
}

test("the monitor opens on the session, shows totals line, and s chooses the tree in one picker", async () => {
  const db = await seeded()
  const { fixture, queries } = await render(db, { dialogs: { selects: ["tree\0ses_chat"] } })
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("Scope: This session"))
    expect(queries[0]).toMatchObject({ scope: "session", sessionID: "ses_chat" })
    expect(frame).toContain("Scope: This session: ")
    expect(frame).toContain("When: All")
    expect(frame).toContain("reqs: 2")
    expect(frame).toContain("steps: 2")
    expect(frame).toContain("hit rate: —")
    expect(frame).toContain("[1 Cache]")
    expect(frame).toContain("[2 Prompt]")
    expect(frame).toContain("[3 Tools]")
    expect(frame).toContain("[4 Sessions]")
    dispatch(fixture, "s")
    const treeFrame = await fixture.waitForFrame((text) => text.includes("Scope: Team tree"))
    expect(treeFrame).toContain("Scope: Team tree")
    expect(queries.at(-1)?.scope).toBe("tree")
    // The current chat is one row, never a bare "This chat" followed by its name.
    const options = fixture.fake.selectInputs.at(-1)?.options.map((option) => option.title) ?? []
    expect(options.slice(0, 4)).toEqual([expect.stringMatching(/^This chat · /), "This chat with its subagents", "This project", "All sessions"])
    expect(options.filter((title) => title === "This chat")).toEqual([])
  } finally {
    fixture.destroy()
  }
})

test("the Cache tab shows legacy changes without a confident miss, and detail opens and closes", async () => {
  const db = await seeded()
  const base = contractFixtureReport(NOW)
  const requests = base.requests!.map((request) => ({
    ...request,
    verdict: "none" as const,
    measurement: { state: "legacy-unknown" as const },
    confidence: "unknown" as const,
    causeText: `observed: ${request.cause ?? "unknown"}`,
    expected: undefined,
    missTokens: 0,
    missCost: 0,
  }))
  const { fixture } = await render(db, {
    customReport: {
      ...base,
      requests,
      totals: { ...base.totals, hitRate: undefined, misses: 0, missTokens: 0, missCost: 0 },
      detail: { ...base.detail!, request: requests.find((request) => request.id === base.detail!.request.id)! },
    },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("Scope: This session"))
    dispatch(fixture, "1")
    const cacheFrame = await fixture.waitForFrame((text) => text.includes("Verdict") && text.includes("observed: prefix-changed"))
    const rows = cacheFrame.split("\n").filter((line) => /\d\d:\d\d:\d\d/.test(line))
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((line) => expect(line).toMatch(/ none /))

    // The changed request is the newest, so it is the first row: open its
    // detail with return, without moving the selection.
    dispatch(fixture, "return")
    const detailFrame = await fixture.waitForFrame((text) => text.includes("Request Detail:"))
    expect(detailFrame).toContain("Observation: legacy-unknown")
    expect(detailFrame).toContain("observed: prefix-changed")
    expect(detailFrame).toContain("Reported read: —")
    expect(detailFrame).toContain("Shortfall estimate: —")
    expect(detailFrame).not.toContain("Expected prefix:")
    expect(detailFrame).toContain("system: AGENTS.md")
    expect(detailFrame).toContain("Fingerprint Segments:")
    expect(detailFrame).toContain("chars 2500 → 2900")

    // Close detail with backspace
    dispatch(fixture, "backspace")
    const closedFrame = await fixture.waitForFrame((text) => !text.includes("Request Detail:"))
    expect(closedFrame).toContain("observed: prefix-changed")
  } finally {
    fixture.destroy()
  }
})

test("narrow and wide layouts format totals line without horizontal scroll", async () => {
  const db = await seeded()
  const wide = await render(db, { width: 140, height: 40 })
  try {
    const wideFrame = await wide.fixture.waitForFrame((text) => text.includes("Scope: This session"))
    wideFrame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(140))
    expect(wideFrame).toContain("reqs: 2")
    expect(wideFrame).toContain("read: 19.8k")
    expect(wideFrame).toContain("hit rate: —")
    expect(wideFrame).toContain("cost: $0.00")
  } finally {
    wide.fixture.destroy()
  }

  const narrow = await render(db, { width: 80, height: 40 })
  try {
    const narrowFrame = await narrow.fixture.waitForFrame((text) => text.includes("Scope: This session"))
    narrowFrame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(80))
    expect(narrowFrame).toContain("reqs: 2")
    expect(narrowFrame).toContain("steps: 2")
    expect(narrowFrame).toContain("hit rate: —")
    expect(narrowFrame).toContain("cost: $0.00")
  } finally {
    narrow.fixture.destroy()
  }
})

test("the narrow Cache keeps the kind column and fits 80 columns", async () => {
  const db = await seeded()
  const { fixture } = await render(db, {
    width: 80,
    height: 40,
    settings: { ...defaultSettings, tab: "cache" },
    customReport: () => contractFixtureReport(NOW),
  })
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("What changed") && / miss /.test(text))
    // The kind column survives at 80 columns so pings and compactions stay distinguishable.
    expect(frame).toContain("Kind")
    expect(frame).toContain("[comp]")
    expect(frame).not.toContain("Model")
    frame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(80))
  } finally {
    fixture.destroy()
  }
})

test("the Overview top tools ignore the tab's last grouping", async () => {
  const db = await seeded()
  // With the persisted grouping on target, the overview still ranks by tool.
  const report = queryMonitor(
    db,
    { scope: "session", sessionID: "ses_chat", view: "overview", group: "target", sort: "tokens", top: 20, feed: 0 },
    { directory: "/work/project", now: NOW },
  )
  expect(report.topTools?.map((group) => group.key)).toEqual(["read", "shell"])
  expect(report.groups.map((group) => group.key)).toEqual(["read src/a.ts", "shell bun test"])
})

test("the Sessions tab shows a token total that includes cache and reasoning", async () => {
  const db = await seeded()
  const row = { ...contractFixtureReport(NOW).sessions![0]!, sessionID: "ses_chat", rootID: "ses_chat", depth: 0, active: true, descendants: 0 }
  const expected = row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite
  const { fixture } = await render(db, {
    settings: { ...defaultSettings, tab: "sessions" },
    checklist: { sessions: [row], roots: 1, offset: 0, limit: 100, inactive: 0 },
  })
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("Session / Role"))
    expect(frame).toContain(formatTokens(expected))
    // The old bug summed only input + output.
    expect(frame).not.toContain(formatTokens(row.input + row.output))
  } finally {
    fixture.destroy()
  }
})

test("a Sessions checklist answer slower than the poll is shown; the poll waits for it and asks once more", async () => {
  const db = await seeded()
  const gates: (() => void)[] = []
  const { fixture, lists } = await render(db, {
    settings: { ...defaultSettings, tab: "sessions" },
    checklistGate: () => new Promise<void>((resolve) => gates.push(resolve)),
  })
  try {
    await fixture.waitForFrame((text) => text.includes("Loading sessions"))
    expect(lists).toHaveLength(1)
    // One real poll interval (REFRESH_MS, 1 s: the seeded chat is live) passes with
    // the answer still out. A poll used to send a second request and drop this answer.
    await Bun.sleep(1_200)
    expect(lists).toHaveLength(1)
    gates.shift()!()
    const frame = await fixture.waitForFrame((text) => !text.includes("Loading sessions"))
    // The chat's row, under the column headings (the scope line names it too).
    expect(frame.slice(frame.indexOf("Session / Role"))).toContain("Fix the thing")
    // The poll that came while the answer was out asks again as soon as it is in.
    const deadline = Date.now() + 5_000
    while (lists.length < 2 && Date.now() < deadline) await Bun.sleep(10)
    expect(lists).toHaveLength(2)
  } finally {
    gates.splice(0).forEach((open) => open())
    fixture.destroy()
  }
})

test("S shows inactive sessions from any tab, and on the Sessions tab steps back to active only", async () => {
  const db = await seeded()
  db.session({ id: "ses_old", title: "Old chat" }, NOW - 86_400_000)
  const { fixture, lists } = await render(db, {
    settings: { ...defaultSettings, scope: "project", tab: "tools" },
    active: ["ses_chat"],
  })
  try {
    await fixture.waitForFrame((text) => text.includes("Scope: Project"))
    dispatch(fixture, "shift+s")
    const all = await fixture.waitForFrame((text) => text.includes("Old chat"))
    expect(all).toContain("All sessions · 2 trees")
    expect(lists.at(-1)?.all).toBe(true)
    dispatch(fixture, "shift+s")
    const active = await fixture.waitForFrame((text) => text.includes("Active sessions") && !text.includes("Old chat"))
    // The chat's own tree is always listed; the old chat is counted, not shown.
    expect(active).toContain("Fix the thing")
    expect(active).toContain("1 inactive hidden")
    expect(lists.at(-1)?.all).toBeUndefined()
  } finally {
    fixture.destroy()
  }
})

test("checking sessions is a temporary filter: Backspace restores the stored scope and filters", async () => {
  const db = await seeded()
  const saved: MonitorSettings = { ...defaultSettings, tab: "sessions", scope: "project", agent: "build" }
  const { fixture, queries } = await render(db, { width: 120, height: 40, settings: saved, settingsKey: "monitor" })
  try {
    // Outside a session selection nothing is checked.
    const first = await fixture.waitForFrame((text) => text.includes("Session / Role") && text.includes("Fix the thing"))
    expect(first).not.toContain("[x]")
    expect(queries[0]).toMatchObject({ scope: "project", view: "cache" })

    // space starts a selection of the session, as a temporary drill.
    dispatch(fixture, "space")
    await fixture.waitForFrame((text) => text.includes("filters 1") && text.includes("[x] ▼ Fix the thing"))
    expect(queries.at(-1)).toMatchObject({ scope: "session", sessionIDs: ["ses_chat"], agents: ["build"] })
    expect((fixture.storeValue("monitor") as { settings: MonitorSettings }).settings).toMatchObject({ scope: "project", agent: "build" })

    // ctrl+space adds the rest of the tree to the same drill.
    dispatch(fixture, "ctrl+space")
    await fixture.waitForFrame(() => queries.at(-1)?.sessionIDs?.length === 2)
    expect(await fixture.waitForFrame((text) => text.includes("filters 1"))).not.toContain("filters 2")

    dispatch(fixture, "backspace")
    await fixture.waitForFrame((text) => !text.includes("⌫ undo"))
    expect(queries.at(-1)).toMatchObject({ scope: "project" })
    expect(queries.at(-1)?.agents).toEqual(["build"])
    expect((fixture.storeValue("monitor") as { settings: MonitorSettings }).settings).toMatchObject({ scope: "project", agent: "build" })
  } finally {
    fixture.destroy()
  }
})

test("the narrow Sessions layout drops columns instead of clipping", async () => {
  const db = await seeded()
  const { fixture } = await render(db, {
    width: 80,
    height: 40,
    settings: { ...defaultSettings, tab: "sessions" },
    customReport: () => contractFixtureReport(NOW),
  })
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("Session / Role") && text.includes("Fix the thing"))
    expect(frame).toContain("Last seen")
    expect(frame).not.toContain("Agent")
    frame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(80))
  } finally {
    fixture.destroy()
  }
})

test("the monitor shows this chat's totals, tools and latest calls on Tools tab", async () => {
  const db = await seeded()
  const { fixture, queries } = await render(db, { settings: { ...defaultSettings, tab: "tools" } })
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("latest calls"))
    expect(queries[0]).toMatchObject({ scope: "session", sessionID: "ses_chat", group: "tool", sort: "tokens" })
    expect(frame).toContain("Scope: This session: ")
    expect(frame).toContain("tools: call")
    // Groups, largest first: read (1.2k measured) above shell.
    const rows = frame.split("\n").map((line) => line.trim())
    const read = rows.findIndex((line) => line.startsWith("read "))
    const shell = rows.findIndex((line) => line.startsWith("shell "))
    expect(read).toBeGreaterThan(-1)
    expect(shell).toBeGreaterThan(read)
    expect(rows[read]).toContain("1.2k")
    // The feed names what each call touched.
    expect(frame).toContain("src/a.ts")
    expect(frame).toContain("bun test")
  } finally {
    fixture.destroy()
  }
})

test("keys change grouping, scope, window and filters, and the choice persists", async () => {
  const db = await seeded()
  const { fixture, queries } = await render(db, {
    settings: { ...defaultSettings, tab: "tools", scope: "tree" },
    dialogs: { selects: ["explore", "project\0"] },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("latest calls"))
    dispatch(fixture, "g")
    const byAgent = await fixture.waitForFrame((text) =>
      text.split("\n").some((line) => /^agent\s+calls/.test(line.trim())),
    )
    expect(queries.at(-1)?.group).toBe("agent")
    expect(byAgent.split("\n").some((line) => line.trim().startsWith("build "))).toBe(true)
    expect((fixture.storeValue("monitor") as { settings: MonitorSettings }).settings.group).toBe("agent")
    dispatch(fixture, "a")
    await fixture.waitForFrame((text) => text.includes("agent explore"))
    expect(fixture.fake.selectInputs.at(-1)?.options.map((option) => option.title)).toEqual([
      "Every agent",
      "build",
      "explore",
    ])
    expect(queries.at(-1)?.agents).toEqual(["explore"])
    dispatch(fixture, "x")
    await fixture.waitForFrame((text) => text.includes("failed only"))
    expect(queries.at(-1)).toMatchObject({ agents: ["explore"], errors: true })
    dispatch(fixture, "s")
    await fixture.waitForFrame((text) => text.includes("Scope: Project"))
    expect(queries.at(-1)?.scope).toBe("project")
    // The scope choice keeps the filters chosen before it.
    expect(queries.at(-1)).toMatchObject({ agents: ["explore"], errors: true })
    dispatch(fixture, "t")
    await fixture.waitForFrame((text) => text.includes("When: Since last compaction"))
    expect(queries.at(-1)?.sinceCompaction).toBe(true)
  } finally {
    fixture.destroy()
  }
})

test("the composer M opens the full page on this chat's session", async () => {
  const db = await seeded()
  let opened: string | undefined
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 90,
    height: 30,
    render: (context) => (
      <MonitorView
        context={context}
        sessionID={() => "ses_chat"}
        active={() => true}
        full={false}
        mode="composer"
        onClose={() => {}}
        onOpenFull={() => {
          opened = "ses_chat"
        }}
      />
    ),
    rpc: {
      "monitor.query": async (input: Plus.MonitorQueryInput) =>
        queryMonitor(db, input, { directory: "/work/project", now: NOW }),
    },
  })
  try {
    await fixture.waitForFrame((text) => text.split("\n").some((line) => /^tool\s+calls/.test(line.trim())))
    dispatch(fixture, "M")
    expect(opened).toBe("ses_chat")
  } finally {
    fixture.destroy()
  }
})

test("the composer defaults to the tree scope and drills Tools even when its stored tab is Prompt", async () => {
  const db = await seeded()
  const { fixture, queries } = await render(db, {
    full: false,
    width: 90,
    height: 30,
    settings: { ...defaultSettings, tab: "prompt" },
  })
  try {
    await fixture.waitForFrame((text) => text.split("\n").some((line) => /^tool\s+calls/.test(line.trim())))
    // The compact body renders Tools, not the stored Prompt tab.
    expect(queries[0]?.view).toBe("tools")
    dispatch(fixture, "return")
    const drilled = await fixture.waitForFrame((text) => text.includes("tool read"))
    expect(drilled).toContain("read src/a.ts")
    dispatch(fixture, "backspace")
    await fixture.waitForFrame((text) => !text.includes("⌫ undo"))
  } finally {
    fixture.destroy()
  }

  // A fresh compact store defaults its scope to the team tree, not session.
  const fresh = await render(db, { full: false, width: 90, height: 30 })
  try {
    await fresh.fixture.waitForFrame((text) => text.split("\n").some((line) => /^tool\s+calls/.test(line.trim())))
    expect(fresh.queries[0]).toMatchObject({ view: "tools", scope: "tree" })
  } finally {
    fresh.fixture.destroy()
  }
})

test("full and compact keep separate persisted settings", async () => {
  const db = await seeded()
  // The full page's stored tab is Cache; the compact body has its own store and
  // still renders Tools without overwriting the full page's choice.
  const full = await render(db, {
    width: 100,
    height: 30,
    settings: { ...defaultSettings, tab: "cache" },
    settingsKey: "monitor",
  })
  try {
    await full.fixture.waitForFrame((text) => text.includes("Verdict") && text.includes("What changed"))
    expect(full.queries[0]?.view).toBe("cache")
    expect((full.fixture.storeValue("monitor") as { settings: MonitorSettings }).settings.tab).toBe("cache")
    expect(full.fixture.storeValue("monitor-composer")).toBeUndefined()
  } finally {
    full.fixture.destroy()
  }

  const compact = await render(db, { full: false, width: 90, height: 30 })
  try {
    await compact.fixture.waitForFrame((text) => text.split("\n").some((line) => /^tool\s+calls/.test(line.trim())))
    expect(compact.queries[0]).toMatchObject({ view: "tools", scope: "tree" })
    // Changing a compact setting writes only the composer's own key.
    dispatch(compact.fixture, "s")
    await compact.fixture.waitForFrame((text) => text.includes("scope team"))
    expect((compact.fixture.storeValue("monitor-composer") as { settings: MonitorSettings }).settings.scope).toBe(
      "team",
    )
    expect(compact.fixture.storeValue("monitor")).toBeUndefined()
  } finally {
    compact.fixture.destroy()
  }
})

test("the Cache selection scrolls its full row into view", async () => {
  const db = await seeded()
  const requests: Plus.MonitorRequest[] = Array.from({ length: 20 }, (_, index) => ({
    id: `req_${index}`,
    sessionID: "ses_chat",
    kind: "step",
    at: NOW - (20 - index) * 1_000,
    agent: "build",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    input: 100,
    output: 10,
    reasoning: 0,
    cacheRead: index % 2 === 0 ? 900 : 0,
    cacheWrite: index % 2 === 0 ? 0 : 900,
    cost: 0.001,
    verdict: index % 2 === 0 ? "hit" : "miss",
    causeText: `row-${String(index).padStart(2, "0")}`,
  }))
  const { fixture } = await render(db, {
    width: 100,
    height: 18,
    settings: { ...defaultSettings, tab: "cache" },
    customReport: () => ({ ...contractFixtureReport(NOW), requests }),
  })
  try {
    await fixture.waitForFrame((text) => text.includes("row-19"))
    for (let step = 0; step < 19; step++) dispatch(fixture, "down")
    const frame = await fixture.waitForFrame((text) => text.includes("row-00"))
    // The selected full row scrolled into view rather than staying above the fold.
    expect(frame).toContain("row-00")
  } finally {
    fixture.destroy()
  }
})

test("every total metric stays visible and labelled at 80, 100 and 160 columns", async () => {
  const db = await seeded()
  const totals: Plus.MonitorTotals = {
    steps: 4,
    calls: 6,
    errors: 1,
    running: 0,
    input: 21_400,
    output: 376,
    reasoning: 120,
    cacheRead: 30_800,
    cacheWrite: 15_800,
    cost: 0.09,
    callTokens: 273,
    resultTokens: 464,
    carried: 502,
    requests: 5,
    pings: 2,
    pingCost: 0.006,
    misses: 1,
    missTokens: 18_000,
    missCost: 0.027,
    hitRate: 0.59,
  }
  const labels = [
    "reqs:",
    "steps:",
    "in:",
    "read:",
    "write:",
    "out:",
    "reason:",
    "hit rate:",
    "misses:",
    "miss cost:",
    "pings:",
    "cost:",
  ]
  for (const width of [80, 100, 160]) {
    const { fixture } = await render(db, {
      width,
      height: 40,
      settings: { ...defaultSettings, tab: "tools" },
      customReport: () => ({ ...contractFixtureReport(NOW), totals }),
    })
    try {
      const frame = await fixture.waitForFrame((text) => text.includes("reqs: 5"))
      const totalsBlock = frame
        .split("\n")
        .filter((line) =>
          /^(reqs|steps|in|read|write|out|reason|hit rate|misses|miss cost|pings|cost):/.test(line.trim()),
        )
        .join("\n")
      labels.forEach((label) => expect(totalsBlock).toContain(label))
      frame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(width))
      // Known-zero and non-zero values stay visible, never dropped.
      expect(totalsBlock).toContain("reason: 120")
      expect(totalsBlock).toContain("pings: 2")
      expect(totalsBlock).toContain("write: 15.8k")
    } finally {
      fixture.destroy()
    }
  }
})

test("known zero, known positive and omitted miss cost each render distinctly", async () => {
  const db = await seeded()
  const base = contractFixtureReport(NOW)
  const omitted: Plus.MonitorTotals = { ...base.totals, misses: 1 }
  delete (omitted as { missCost?: number }).missCost
  const cases: { totals: Plus.MonitorTotals; expect: string; absent?: string }[] = [
    { totals: { ...base.totals, misses: 1, missCost: 0.027 }, expect: "miss cost: $0.03" },
    { totals: { ...base.totals, misses: 1, missCost: 0 }, expect: "miss cost: $0.00" },
    { totals: omitted, expect: "miss cost: —", absent: "miss cost: $0.00" },
  ]
  for (const item of cases) {
    const { fixture } = await render(db, {
      width: 140,
      height: 40,
      settings: { ...defaultSettings, tab: "tools" },
      customReport: () => ({ ...base, totals: item.totals }),
    })
    try {
      const frame = await fixture.waitForFrame((text) => text.includes("miss cost:"))
      expect(frame).toContain(item.expect)
      if (item.absent !== undefined) expect(frame).not.toContain(item.absent)
    } finally {
      fixture.destroy()
    }
  }
})

test("omitted requests/pings totals render — while known zero stays 0", async () => {
  const db = await seeded()
  const base = contractFixtureReport(NOW)
  const omitted: Plus.MonitorTotals = { ...base.totals, steps: 3 }
  delete (omitted as { requests?: number }).requests
  delete (omitted as { pings?: number }).pings
  const cases: { totals: Plus.MonitorTotals; requests: string; pings: string }[] = [
    { totals: omitted, requests: "reqs: —", pings: "pings: —" },
    { totals: { ...base.totals, requests: 0, pings: 0, steps: 0 }, requests: "reqs: 0", pings: "pings: 0" },
    { totals: { ...base.totals, requests: 5, pings: 2, steps: 4 }, requests: "reqs: 5", pings: "pings: 2" },
  ]
  for (const width of [80, 100, 160]) {
    for (const item of cases) {
      const { fixture } = await render(db, {
        width,
        height: 40,
        settings: { ...defaultSettings, tab: "tools" },
        customReport: () => ({ ...base, totals: item.totals }),
      })
      try {
        const frame = await fixture.waitForFrame((text) => text.includes("steps:"))
        expect(frame).toContain(item.requests)
        expect(frame).toContain(item.pings)
        frame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(width))
      } finally {
        fixture.destroy()
      }
    }
  }
})

test("Cache detail labels omitted timings — and keeps a real zero as 0ms", async () => {
  const db = await seeded()
  const base = contractFixtureReport(NOW)
  const cases: { timing: Plus.MonitorRequestDetail["timing"]; gap: string; lifetime: string }[] = [
    { timing: { warming: "on" }, gap: "Gap since last request: —", lifetime: "Cache lifetime: —" },
    {
      timing: { gapMs: 0, lifetimeMs: 0, warming: "off" },
      gap: "Gap since last request: 0ms",
      lifetime: "Cache lifetime: 0ms",
    },
    {
      timing: { gapMs: 420_000, lifetimeMs: 300_000, warming: "off" },
      gap: "Gap since last request: 7m",
      lifetime: "Cache lifetime: 5m",
    },
  ]
  for (const width of [80, 160]) {
    for (const item of cases) {
      const { fixture } = await render(db, {
        width,
        height: 40,
        settings: { ...defaultSettings, tab: "cache" },
        customReport: () => ({
          ...base,
          detail: { ...base.detail!, timing: item.timing },
        }),
      })
      try {
        // Drill into the first request to open the detail.
        await fixture.waitForFrame((text) => / (miss|cold) /.test(text))
        dispatch(fixture, "return")
        const frame = await fixture.waitForFrame((text) => text.includes("Request Detail:"))
        expect(frame).toContain(item.gap)
        expect(frame).toContain(item.lifetime)
        frame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(width))
      } finally {
        fixture.destroy()
      }
    }
  }
})

test("the / text filter narrows every table but leaves the totals", async () => {
  const db = await seeded()
  const { fixture, queries } = await render(db, {
    settings: { ...defaultSettings, tab: "tools" },
    dialogs: { prompts: ["shell"] },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("latest calls"))
    dispatch(fixture, "/")
    await fixture.waitForFrame((text) => text.includes("filter “shell”"))
    const filtered = await fixture.waitForFrame((text) => {
      const rows = text.split("\n").map((line) => line.trim())
      return rows.some((line) => line.startsWith("shell ")) && !rows.some((line) => line.startsWith("read "))
    })
    // The filter is applied to rendered rows only: the request keeps the same
    // scope and carries no text key (the RPC has none).
    expect(queries.at(-1)).toMatchObject({ scope: "session", sessionID: "ses_chat" })
    expect(queries.at(-1)).not.toHaveProperty("filterText")
    // Totals still describe the real query.
    expect(filtered).toContain("reqs: 2")

    dispatch(fixture, "1")
    await fixture.waitForFrame((text) => text.includes("Verdict") || text.includes("Kind"))
    expect((fixture.storeValue("monitor") as { settings: MonitorSettings }).settings.filterText).toBe("shell")
  } finally {
    fixture.destroy()
  }
})

test("enter drills from a tool into its targets and backspace comes back", async () => {
  const db = await seeded()
  const { fixture, queries, closed } = await render(db, { settings: { ...defaultSettings, tab: "tools" } })
  try {
    await fixture.waitForFrame((text) => text.includes("latest calls"))
    dispatch(fixture, "return")
    const drilled = await fixture.waitForFrame((text) => text.includes("tool read"))
    expect(queries.at(-1)).toMatchObject({ tools: ["read"], group: "target" })
    expect(drilled).toContain("read src/a.ts")
    expect(drilled).toContain("filters 1")
    // The drill-down never rewrites the stored settings.
    expect((fixture.storeValue("monitor") as { settings: MonitorSettings } | undefined)?.settings.tool).toBeUndefined()
    dispatch(fixture, "backspace")
    await fixture.waitForFrame((text) => !text.includes("⌫ undo"))
    expect(queries.at(-1)?.tools).toBeUndefined()
    expect(closed()).toBe(0)
    dispatch(fixture, "escape")
    expect(closed()).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("a mark is recorded and a comparison against it adds before/after columns", async () => {
  const db = await seeded()
  const { fixture, queries } = await render(db, {
    settings: { ...defaultSettings, tab: "tools" },
    dialogs: { prompts: ["before the prompt change"] },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("latest calls"))
    dispatch(fixture, "m")
    await sleep(20)
    expect(fixture.fake.toasts.at(-1)?.message).toContain("before the prompt change")
    dispatch(fixture, "c")
    // "previous" needs a window: with "all" the header says so instead of comparing.
    await fixture.waitForFrame((text) => text.includes("compare pick a window (t) to compare"))
    dispatch(fixture, "c")
    const frame = await fixture.waitForFrame((text) => text.includes("Δcalls"))
    expect(frame).toContain("compare before/after “before the prompt change”")
    // After the mark nothing happened yet; before it, everything did.
    expect(queries.at(-1)).toMatchObject({ since: NOW, compare: { until: NOW } })
    expect(frame).toContain("(before: 2 calls")
    // Every tool of the earlier window keeps its row, at zero now.
    const read = frame.split("\n").find((line) => line.trim().startsWith("read "))
    expect(read).toContain("-100%")
  } finally {
    fixture.destroy()
  }
})

test("in the composer, up on the first row leaves the tab and the view fits a narrow terminal", async () => {
  const db = await seeded()
  const { fixture, closed } = await render(db, { full: false, width: 72, height: 20 })
  try {
    const frame = await fixture.waitForFrame((text) =>
      text.split("\n").some((line) => /^tool\s+calls/.test(line.trim())),
    )
    frame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(72))
    dispatch(fixture, "down")
    dispatch(fixture, "up")
    expect(closed()).toBe(0)
    dispatch(fixture, "up")
    expect(closed()).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("the composer Tools tab takes the taller body in the table and Loading states", async () => {
  const db = await seeded()

  // The pending query shows Loading… in the same taller body the table takes.
  const loading = await render(db, { full: false, width: 72, height: 30, marker: true, hold: true })
  try {
    const frame = await loading.fixture.waitForFrame((text) => text.includes("Loading…"))
    expect(markerRow(frame)).toBe(TOOLS_BODY_ROWS)
  } finally {
    loading.fixture.destroy()
  }

  const { fixture } = await render(db, { full: false, width: 72, height: 30, marker: true })
  try {
    const frame = await fixture.waitForFrame((text) =>
      text.split("\n").some((line) => /^tool\s+calls/.test(line.trim())),
    )
    expect(markerRow(frame)).toBe(TOOLS_BODY_ROWS)
    // The taller body fits every seeded group without scrolling.
    expect(groupRows(frame)).toEqual(["read", "shell", "grep", "edit"])
    // The composer keeps only the filters, the totals and the table.
    expect(frame).not.toContain("tools: ")
    expect(frame).not.toContain("latest calls")
    frame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(72))
  } finally {
    fixture.destroy()
  }
})

test("the composer Tools tab scrolls the selection through groups past the fold", async () => {
  const db = await manyTools()
  const rows = TOOLS_BODY_ROWS - 3
  const ordered = queryMonitor(
    db,
    { scope: "session", sessionID: "ses_chat", group: "tool", sort: "tokens", top: 20, feed: 0 },
    { directory: "/work/project", now: NOW },
  ).groups.map((group) => group.key)
  expect(ordered.length).toBeGreaterThan(rows)

  const { fixture } = await render(db, { full: false, width: 72, height: 30, marker: true })
  try {
    const first = await fixture.waitForFrame((text) => groupRows(text).length > 0)
    expect(groupRows(first)).toEqual(ordered.slice(0, rows))
    // Move the selection to the last group; the scrollbox follows it.
    for (let step = 0; step < ordered.length - 1; step++) dispatch(fixture, "down")
    const moved = await fixture.waitForFrame((text) => groupRows(text).at(-1) === ordered.at(-1))
    expect(groupRows(moved)).toEqual(ordered.slice(ordered.length - rows))
    moved.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(72))
  } finally {
    fixture.destroy()
  }
})

test("a poll that returns the same groups keeps their row components", async () => {
  const db = await seeded()
  const { fixture, queries } = await render(db, { settings: { ...defaultSettings, tab: "tools", scope: "tree" } })
  try {
    await fixture.waitForFrame((text) => text.includes("latest calls"))
    const before = queries.length
    resetGroupMountLog()
    await sleep(1_200)
    await fixture.flush()
    // The view polled again with the same ledger: the rows stayed mounted.
    expect(queries.length).toBeGreaterThan(before)
    expect(groupMountLog.keys).toEqual([])
  } finally {
    stopGroupMountLog()
    fixture.destroy()
  }
})

test("an empty ledger says so instead of showing an empty table", async () => {
  const db = await ledger()
  const { fixture } = await render(db, { settings: { ...defaultSettings, tab: "tools", window: "1h" } })
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("No tool calls"))
    expect(frame).toContain("No tool calls in this chat yet in the last 1h.")
  } finally {
    fixture.destroy()
  }
})

test("queries follow the settings: windows, comparisons and a chat-less session scope", () => {
  const marks = [{ id: 1, at: 5_000_000, label: "m" }]
  const base = { now: 10_000_000, marks, top: 5, feed: 3 }
  expect(queryOf(defaultSettings, { ...base, sessionID: "s" })).toMatchObject({
    scope: "session",
    sessionID: "s",
    group: "tool",
    sort: "tokens",
    top: 5,
    feed: 3,
  })
  // No chat open: the session scope reads the project instead of nothing.
  expect(queryOf(defaultSettings, base).scope).toBe("project")
  expect(queryOf({ ...defaultSettings, window: "1h", compare: "previous" }, base)).toMatchObject({
    since: 10_000_000 - 3_600_000,
    compare: { since: 10_000_000 - 7_200_000, until: 10_000_000 - 3_600_000 },
  })
  expect(queryOf({ ...defaultSettings, compare: "mark" }, base)).toMatchObject({
    since: 5_000_000,
    compare: { until: 5_000_000 },
  })
  expect(queryOf({ ...defaultSettings, window: "1h", compare: "mark" }, base)).toMatchObject({
    since: 5_000_000,
    compare: { since: 5_000_000 - 3_600_000, until: 5_000_000 },
  })
  expect(drillInto(defaultSettings, { key: "read" } as Plus.MonitorGroup)?.settings).toMatchObject({
    tool: "read",
    group: "target",
  })
  expect(drillInto({ ...defaultSettings, group: "session" }, { key: "ses_x" } as Plus.MonitorGroup)).toMatchObject({
    sessionID: "ses_x",
  })
  expect(drillInto({ ...defaultSettings, group: "target" }, { key: "x" } as Plus.MonitorGroup)).toBeUndefined()
})

test("numbers are short and deltas honest", () => {
  expect([
    formatTokens(999),
    formatTokens(1_234),
    formatTokens(12_345),
    formatTokens(1_234_567),
    formatTokens(2_500_000_000),
  ]).toEqual(["999", "1.2k", "12.3k", "1.2M", "2.5B"])
  expect([formatDelta(0, 0), formatDelta(5, 0), formatDelta(15, 10), formatDelta(5, 10), formatDelta(10, 10)]).toEqual([
    "·",
    "new",
    "+50%",
    "-50%",
    "±0%",
  ])
})

test("the view polls every second while calls are live and every five when quiet", () => {
  const report = (running: number, latest: number | undefined) =>
    ({
      now: 100_000,
      totals: { running },
      feed: latest === undefined ? [] : [{ started: latest }],
    }) as unknown as Plus.MonitorReport
  expect(refreshInterval(undefined)).toBe(1_000)
  expect(refreshInterval(report(1, 0))).toBe(1_000)
  expect(refreshInterval(report(0, 90_000))).toBe(1_000)
  expect(refreshInterval(report(0, 10_000))).toBe(5_000)
  expect(refreshInterval(report(0, undefined))).toBe(5_000)
  // requests are oldest-first: the freshest activity is the last row, not the
  // first. A view reading requests[0] would poll idle here.
  const oldest = { now: 100_000, totals: { running: 0 }, feed: [], requests: [{ at: 10_000 }, { at: 99_500 }] }
  expect(refreshInterval(oldest as unknown as Plus.MonitorReport)).toBe(1_000)
  // An older tool feed must not mask a fresh request or ping: take the newest
  // timestamp available anywhere, not feed-first-then-requests.
  const oldFeedNewRequest = {
    now: 100_000,
    totals: { running: 0 },
    feed: [{ started: 10_000 }],
    requests: [{ at: 99_500 }],
  }
  expect(refreshInterval(oldFeedNewRequest as unknown as Plus.MonitorReport)).toBe(1_000)
  const oldFeedNewPing = {
    now: 100_000,
    totals: { running: 0 },
    feed: [{ started: 10_000 }],
    requests: [{ at: 20_000 }, { at: 99_800 }],
  }
  expect(refreshInterval(oldFeedNewPing as unknown as Plus.MonitorReport)).toBe(1_000)
  // Truly quiet: nothing recent anywhere stays at the idle pace.
  const quiet = {
    now: 100_000,
    totals: { running: 0 },
    feed: [{ started: 10_000 }],
    requests: [{ at: 20_000 }],
  }
  expect(refreshInterval(quiet as unknown as Plus.MonitorReport)).toBe(5_000)
})
