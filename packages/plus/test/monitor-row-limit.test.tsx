import { afterEach, expect, test } from "bun:test"
import type { Plus } from "../src/rpc.js"
import { defaultSettings, type MonitorSettings } from "../src/tui/monitor/format.js"
import { MonitorView } from "../src/tui/monitor/view.js"
import { resetRowWindowLog, rowWindowLog, stopRowWindowLog } from "../src/tui/monitor/window.js"
import { cleanupLedgers } from "./monitor-fixture.js"
import { dispatch, sleep } from "./instructions-nav.js"
import { renderPlusFixture, type TestFixture } from "./tui.js"

afterEach(() => {
  stopRowWindowLog()
  cleanupLedgers()
})

const NOW = 1_800_000_000_000
const COUNT = 5_000

function makeRequests(): Plus.MonitorRequest[] {
  return Array.from({ length: COUNT }, (_, index) => ({
    id: `req_${index}`,
    sessionID: "ses_chat",
    kind: "step",
    at: NOW - (COUNT - index) * 1_000,
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
    evidence: `row-${String(index).padStart(4, "0")}`,
  }))
}

function makeSessions(): Plus.MonitorReport["sessions"] {
  return Array.from({ length: COUNT }, (_, index) => ({
    sessionID: `ses_${index}`,
    rootID: `ses_${index}`,
    depth: 0,
    title: `chat-${String(index).padStart(4, "0")}`,
    lastActive: NOW - index * 1_000,
    input: 100,
    output: 10,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    hitRate: 0,
    requests: 1,
    steps: 1,
    misses: 0,
  }))
}

/** A report with a fresh requests/sessions array each poll, as a real poll does. */
function report(input: Plus.MonitorQueryInput): Plus.MonitorReport {
  const list = makeRequests()
  const selected = list.find((entry) => entry.id === input.id)
  return {
    now: NOW,
    totals: {
      steps: COUNT,
      calls: COUNT,
      errors: 0,
      running: 1,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      callTokens: 0,
      resultTokens: 0,
      carried: 0,
    },
    groups: [],
    feed: [],
    facets: { agents: [], tools: [], models: [] },
    marks: [],
    requests: list,
    ...(input.view === "sessions" ? { sessions: makeSessions() } : {}),
    ...(selected === undefined
      ? {}
      : {
          detail: {
            request: selected,
            lines: [],
            segments: [],
            timing: { warming: "off" },
            pings: [],
            accounts: [],
            instructions: [],
            reverts: [],
            actualCacheRead: 0,
          },
        }),
  } as Plus.MonitorReport
}

async function render(settings: MonitorSettings): Promise<{ fixture: TestFixture; queries: Plus.MonitorQueryInput[] }> {
  const queries: Plus.MonitorQueryInput[] = []
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 30,
    storage: new Map<string, unknown>([["monitor", { settings }]]),
    rpc: {
      "monitor.query": async (input: Plus.MonitorQueryInput) => {
        queries.push(input)
        return report(input)
      },
      "monitor.mark": async () => ({ id: 1, at: NOW, label: "m" }),
    },
    render: (context) => (
      <MonitorView context={context} sessionID={() => "ses_chat"} active={() => true} full={true} onClose={() => {}} />
    ),
  })
  return { fixture, queries }
}

test("the Cache tab mounts only a viewport window of a 5,000-row list, and refreshes keep those rows", async () => {
  resetRowWindowLog()
  const { fixture, queries } = await render({ ...defaultSettings, tab: "cache", scope: "all" })
  try {
    await fixture.waitForFrame((text) => text.includes("row-0000"))
    expect(queries[0]).toMatchObject({ scope: "all", view: "cache" })

    // The whole 5,000-row list is never instantiated: the window is the
    // viewport plus a margin, far fewer than the list.
    const firstMount = [...rowWindowLog.keys]
    expect(firstMount.length).toBeGreaterThan(0)
    expect(firstMount.length).toBeLessThan(200)
    expect(firstMount.includes("req_4999")).toBe(false)

    // Several polls return a fresh requests array; unchanged rows keep their
    // components instead of remounting, so no new rows appear and the mounted
    // set stays the same.
    const before = queries.length
    await sleep(2_500)
    await fixture.flush()
    expect(queries.length).toBeGreaterThan(before)
    expect([...rowWindowLog.keys]).toEqual(firstMount)

    // The position line counts the whole filtered list, not the window.
    expect(fixture.captureCharFrame()).toContain(`of ${COUNT}`)
  } finally {
    fixture.destroy()
  }
})

test("the Cache window follows the selection through the full list and drills the right row", async () => {
  resetRowWindowLog()
  const { fixture, queries } = await render({ ...defaultSettings, tab: "cache", scope: "all" })
  try {
    await fixture.waitForFrame((text) => text.includes("row-0000"))
    // Move well past the first window; the window follows and shows the row.
    for (let step = 0; step < 60; step++) dispatch(fixture, "down")
    const moved = await fixture.waitForFrame((text) => text.includes("row-0060"))
    expect(moved).toContain("row 61 of 5000")

    // Enter drills the selected request, not the first mounted one.
    dispatch(fixture, "return")
    const detail = await fixture.waitForFrame((text) => text.includes("Request Detail:"))
    expect(detail).toContain("Request Detail: req_60")
    expect(queries.at(-1)?.id).toBe("req_60")

    // The window moved but the mounted set stayed bounded well under 5,000.
    expect(new Set(rowWindowLog.keys).size).toBeLessThan(500)
  } finally {
    fixture.destroy()
  }
})

test("the Steps and Sessions tabs window their rows the same way", async () => {
  for (const tab of ["steps", "sessions"] as const) {
    resetRowWindowLog()
    const { fixture } = await render({ ...defaultSettings, tab, scope: "all" })
    try {
      await fixture.waitForFrame((text) => text.includes(`of ${COUNT}`))
      const mounted = new Set(rowWindowLog.keys)
      expect(mounted.size).toBeGreaterThan(0)
      expect(mounted.size).toBeLessThan(200)
    } finally {
      fixture.destroy()
      stopRowWindowLog()
    }
  }
})
