import { afterEach, expect, test } from "bun:test"
import type { Ledger } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import type { Plus } from "../src/rpc.js"
import {
  defaultSettings,
  drillInto,
  formatDelta,
  formatTokens,
  queryOf,
  type MonitorSettings,
} from "../src/tui/monitor/format.js"
import { MonitorView, refreshInterval } from "../src/tui/monitor/view.js"
import { cleanupLedgers, collect, ledger, script, usage } from "./monitor-fixture.js"
import { dispatch, sleep } from "./instructions-nav.js"
import { renderPlusFixture, type DialogScript, type TestFixture } from "./tui.js"

afterEach(cleanupLedgers)

const NOW = 1_800_000_000_000

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

async function render(
  db: Ledger,
  options: { full?: boolean; width?: number; height?: number; dialogs?: DialogScript; settings?: MonitorSettings } = {},
): Promise<{ fixture: TestFixture; queries: Plus.MonitorQueryInput[]; closed: () => number }> {
  const queries: Plus.MonitorQueryInput[] = []
  let closes = 0
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: options.width ?? 140,
    height: options.height ?? 40,
    ...(options.dialogs === undefined ? {} : { dialogs: options.dialogs }),
    ...(options.settings === undefined
      ? {}
      : { storage: new Map<string, unknown>([["monitor", { settings: options.settings }]]) }),
    rpc: {
      "monitor.query": async (input: Plus.MonitorQueryInput) => {
        queries.push(input)
        return queryMonitor(db, input, { directory: "/work/project", now: NOW })
      },
      "monitor.mark": async (input: Plus.MonitorMarkInput) => ({
        id: db.mark(input.label, NOW),
        at: NOW,
        label: input.label,
      }),
    },
    render: (context) => (
      <MonitorView
        context={context}
        sessionID={() => "ses_chat"}
        active={() => true}
        full={options.full ?? true}
        onClose={() => {
          closes += 1
        }}
      />
    ),
  })
  return { fixture, queries, closed: () => closes }
}

test("the monitor shows this chat's and its delegates' totals, tools and latest calls", async () => {
  const db = await seeded()
  const { fixture, queries } = await render(db)
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("latest calls"))
    expect(queries[0]).toMatchObject({ scope: "session", sessionID: "ses_chat", group: "tool", sort: "tokens" })
    expect(frame).toContain("scope this chat + delegated · window all")
    expect(frame).toContain("3 steps · 4 calls (1 failed) · in 2.5k · cache 19.8k · out 290")
    expect(frame).toContain("tools: call")
    // Groups, largest first: read (1.2k measured) above shell.
    const rows = frame.split("\n").map((line) => line.trim())
    const read = rows.findIndex((line) => line.startsWith("read "))
    const shell = rows.findIndex((line) => line.startsWith("shell "))
    expect(read).toBeGreaterThan(-1)
    expect(shell).toBeGreaterThan(read)
    expect(rows[read]).toContain("1.2k")
    // The feed names what each call touched, and marks the failure.
    expect(frame).toContain("src/a.ts")
    expect(frame).toContain("bun test")
    expect(rows.find((line) => line.includes(" edit ") && line.includes("src/b.ts"))).toContain("✗")
  } finally {
    fixture.destroy()
  }
})

test("keys change grouping, scope, window and filters, and the choice persists", async () => {
  const db = await seeded()
  const { fixture, queries } = await render(db, { dialogs: { selects: ["explore"] } })
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
    await fixture.waitForFrame((text) => text.includes("scope this project"))
    expect(queries.at(-1)?.scope).toBe("project")
    dispatch(fixture, "t")
    await fixture.waitForFrame((text) => text.includes("window 15m"))
    expect(queries.at(-1)?.since).toBeGreaterThan(0)
  } finally {
    fixture.destroy()
  }
})

test("enter drills from a tool into its targets and backspace comes back", async () => {
  const db = await seeded()
  const { fixture, queries, closed } = await render(db)
  try {
    await fixture.waitForFrame((text) => text.includes("latest calls"))
    dispatch(fixture, "return")
    const drilled = await fixture.waitForFrame((text) => text.includes("tool read"))
    expect(queries.at(-1)).toMatchObject({ tools: ["read"], group: "target" })
    expect(drilled).toContain("read src/a.ts")
    expect(drilled).toContain("drilled 1")
    // The drill-down never rewrites the stored settings.
    expect((fixture.storeValue("monitor") as { settings: MonitorSettings } | undefined)?.settings.tool).toBeUndefined()
    dispatch(fixture, "backspace")
    await fixture.waitForFrame((text) => !text.includes("drilled"))
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
  const { fixture, queries } = await render(db, { dialogs: { prompts: ["before the prompt change"] } })
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
    expect(frame).toContain("(before: 4 calls")
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
    const frame = await fixture.waitForFrame((text) => text.includes("latest calls"))
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

test("an empty ledger says so instead of showing an empty table", async () => {
  const db = await ledger()
  const { fixture } = await render(db, { settings: { ...defaultSettings, window: "1h" } })
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
  expect(queryOf(defaultSettings, { ...base, sessionID: "s" })).toEqual({
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
})
