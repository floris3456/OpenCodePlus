import { afterEach, expect, test } from "bun:test"
import type { Plus } from "../src/rpc.js"
import { defaultSettings, type MonitorSettings } from "../src/tui/monitor/format.js"
import { MonitorView } from "../src/tui/monitor/view.js"
import { cleanupLedgers } from "./monitor-fixture.js"
import { dispatch, sleep } from "./instructions-nav.js"
import { renderPlusFixture, type TestFixture } from "./tui.js"

afterEach(cleanupLedgers)

const NOW = 1_800_000_000_000
const COUNT = 5_000

function request(index: number, overrides: Partial<Plus.MonitorRequest> = {}): Plus.MonitorRequest {
  return {
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
    causeText: `row-${String(index).padStart(4, "0")}`,
    ...overrides,
  }
}

function session(index: number): NonNullable<Plus.MonitorReport["sessions"]>[number] {
  return {
    sessionID: `ses_${index}`,
    rootID: `ses_${index}`,
    depth: 0,
    title: `chat-${String(index).padStart(4, "0")}`,
    agent: "build",
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
  }
}

/** A report whose requests/sessions arrays are rebuilt each poll, as the RPC does. */
function makeReport(input: Plus.MonitorQueryInput): Plus.MonitorReport {
  const requests = Array.from({ length: COUNT }, (_, index) => request(index))
  const selected = requests.find((entry) => entry.id === input.id)
  return {
    now: NOW,
    totals: {
      steps: COUNT,
      calls: COUNT,
      errors: 0,
      running: 0,
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
    facets: { agents: ["build"], tools: [], models: ["claude-3-7-sonnet"] },
    marks: [],
    requests,
    ...(input.view === "sessions" ? { sessions: Array.from({ length: COUNT }, (_, index) => session(index)) } : {}),
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

async function render(
  settings: MonitorSettings,
  options: {
    report?: (input: Plus.MonitorQueryInput) => Plus.MonitorReport
    width?: number
    height?: number
    prompts?: (string | undefined)[]
  } = {},
): Promise<{ fixture: TestFixture; queries: Plus.MonitorQueryInput[] }> {
  const queries: Plus.MonitorQueryInput[] = []
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: options.width ?? 140,
    height: options.height ?? 40,
    ...(options.prompts === undefined ? {} : { dialogs: { prompts: options.prompts } }),
    storage: new Map<string, unknown>([["monitor", { settings }]]),
    rpc: {
      "monitor.query": async (input: Plus.MonitorQueryInput) => {
        queries.push(input)
        return (options.report ?? makeReport)(input)
      },
      "monitor.cache": async (input: Plus.MonitorQueryInput) => (options.report ?? makeReport)(input),
      "monitor.mark": async () => ({ id: 1, at: NOW, label: "m" }),
    },
    render: (context) => (
      <MonitorView context={context} sessionID={() => "ses_chat"} active={() => true} full={true} onClose={() => {}} />
    ),
  })
  return { fixture, queries }
}

/** Every mounted row renderable, in tree order, from the real renderer. */
function mountedRows(fixture: TestFixture): { id: string; node: unknown }[] {
  const rows: { id: string; node: unknown }[] = []
  const walk = (node: { id?: string; getChildren?: () => unknown[] }): void => {
    if (node.id?.startsWith("monitor-row-")) rows.push({ id: node.id, node })
    for (const child of node.getChildren?.() ?? []) walk(child as { id?: string; getChildren?: () => unknown[] })
  }
  walk(fixture.renderer.root)
  return rows
}

function scrollBox(fixture: TestFixture) {
  const scroll = fixture.renderer.root.findDescendantById("monitor-scroll")
  if (scroll === undefined) throw new Error("monitor scrollbox missing")
  return scroll as unknown as {
    scrollTop: number
    scrollHeight: number
    viewport: { height: number }
    scrollTo: (position: number) => void
  }
}

test("the Cache tab mounts only a viewport window of a 5,000-row list, and refreshes keep the rows", async () => {
  const { fixture, queries } = await render({ ...defaultSettings, tab: "cache", scope: "all" })
  try {
    await fixture.waitForFrame((text) => text.includes("row-4999"))
    expect(queries[0]).toMatchObject({ scope: "all", view: "cache" })

    // The window is the viewport plus margin, far fewer than the list.
    const first = mountedRows(fixture)
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(200)
    expect(first.some((row) => row.id === "monitor-row-req_0")).toBe(false)

    // Several polls return a fresh report; unchanged rows keep the same
    // renderable objects instead of being remounted.
    const before = queries.length
    await sleep(2_500)
    await fixture.flush()
    expect(queries.length).toBeGreaterThan(before)
    const after = mountedRows(fixture)
    expect(after.map((row) => row.id)).toEqual(first.map((row) => row.id))
    expect(after.map((row) => row.node)).toEqual(first.map((row) => row.node))

    // The position line counts the whole list, not the window.
    expect(fixture.captureCharFrame()).toContain(`row 1 of ${COUNT}`)
  } finally {
    fixture.destroy()
  }
})

test("manual scrolling mounts the rows at the viewport while the selection stays put", async () => {
  const { fixture } = await render({ ...defaultSettings, tab: "cache", scope: "all" })
  try {
    await fixture.waitForFrame((text) => text.includes("row-4999"))
    const scroll = scrollBox(fixture)
    // Selection is still row 0; scroll far away from it.
    expect(fixture.captureCharFrame()).toContain("row 1 of 5000")
    scroll.scrollTo(100)
    await fixture.flush()

    // The rows at the new viewport are mounted and drawn; a spacer no longer
    // covers them.
    expect(scroll.scrollTop).toBe(100)
    expect(fixture.renderer.root.findDescendantById("monitor-row-req_4899")).toBeDefined()
    expect(fixture.captureCharFrame()).toContain("row-4899")
    expect(mountedRows(fixture).length).toBeLessThan(200)
  } finally {
    fixture.destroy()
  }
})

test("the Cache window follows the keyboard through the full list and drills the selected row", async () => {
  const { fixture, queries } = await render({ ...defaultSettings, tab: "cache", scope: "all" })
  try {
    await fixture.waitForFrame((text) => text.includes("row-4999"))
    for (let step = 0; step < 60; step++) dispatch(fixture, "down")
    const moved = await fixture.waitForFrame((text) => text.includes("row-4939"))
    expect(moved).toContain("row 61 of 5000")

    dispatch(fixture, "return")
    const detail = await fixture.waitForFrame((text) => text.includes("Request Detail:"))
    expect(detail).toContain("Request Detail: req_4939")
    expect(queries.at(-1)?.id).toBe("req_4939")

    // Navigating the whole span keeps the mounted set bounded.
    expect(mountedRows(fixture).length).toBeLessThan(200)
  } finally {
    fixture.destroy()
  }
})

test("a same-id row updates its fields without being remounted", async () => {
  const settings: MonitorSettings = { ...defaultSettings, tab: "sessions", scope: "all" }
  let currentBaseline = true
  const { fixture } = await render(settings, {
    report: (input) => {
      const base = makeReport(input)
      if (currentBaseline) return base
      // Same ids, changed title/agent/tokens.
      return {
        ...base,
        sessions: base.sessions!.map((row, index) =>
          index === 0 ? { ...row, title: "Renamed chat", agent: "explore", input: 999_000 } : row,
        ),
      }
    },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("chat-0000"))
    const before = fixture.renderer.root.findDescendantById("monitor-row-ses_0")
    expect(before).toBeDefined()

    currentBaseline = false
    await sleep(2_500)
    await fixture.flush()

    const after = fixture.renderer.root.findDescendantById("monitor-row-ses_0")
    expect(after).toBe(before)
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("Renamed chat")
    expect(frame).toContain("explore")
    const cells = (after as unknown as { getChildren: () => { plainText?: string }[] }).getChildren().map((c) => c.plainText)
    expect(cells[0]).toBe("Renamed chat")
    expect(cells).toContain("999k")
  } finally {
    fixture.destroy()
  }
})

test("the window stays bounded through a narrow/wide resize and keeps drawing rows", async () => {
  const { fixture } = await render({ ...defaultSettings, tab: "cache", scope: "all" }, { width: 160, height: 45 })
  try {
    await fixture.waitForFrame((text) => text.includes("row-4999"))
    for (const [width, height] of [
      [80, 24],
      [120, 40],
      [160, 45],
    ] as const) {
      fixture.resize(width, height)
      await fixture.flush()
      const frame = fixture.captureCharFrame()
      frame.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(width))
      expect(frame).toContain("row 1 of 5000")
      expect(mountedRows(fixture).length).toBeLessThan(200)
      expect(frame).toContain("row-4999")
    }
  } finally {
    fixture.destroy()
  }
})

test("an empty scope says so and mounts no rows", async () => {
  const { fixture } = await render(
    { ...defaultSettings, tab: "cache", scope: "all" },
    { report: (input) => ({ ...makeReport(input), requests: [] }) },
  )
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("No requests recorded in scope."))
    expect(mountedRows(fixture)).toHaveLength(0)
    expect(frame).not.toContain("row 1 of")
  } finally {
    fixture.destroy()
  }
})

test("the filtered list shrinks the position count and caps selection", async () => {
  // Only req_4997's evidence contains "row-4997"; the text filter narrows to it.
  const { fixture } = await render(
    { ...defaultSettings, tab: "cache", scope: "all" },
    { prompts: ["row-4997"] },
  )
  try {
    await fixture.waitForFrame((text) => text.includes("row 1 of 5000"))
    // Move the selection far down, then filter: the count shrinks and the
    // selection is capped to the filtered rows.
    for (let step = 0; step < 30; step++) dispatch(fixture, "down")
    await fixture.waitForFrame((text) => text.includes("row 31 of 5000"))
    dispatch(fixture, "slash")
    await fixture.waitForFrame((text) => text.includes("filter “row-4997”"))
    const filtered = await fixture.waitForFrame((text) => text.includes("row 1 of 1"))
    expect(filtered).toContain("row 1 of 1")
    expect(mountedRows(fixture).length).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("last-row navigation through a filtered list reaches and drills the last item", async () => {
  const { fixture, queries } = await render(
    { ...defaultSettings, tab: "cache", scope: "all" },
    { report: (input) => ({ ...makeReport(input), requests: [request(10), request(11), request(12)] }) },
  )
  try {
    await fixture.waitForFrame((text) => text.includes("row-0012"))
    expect(fixture.captureCharFrame()).toContain("row 1 of 3")
    dispatch(fixture, "down")
    dispatch(fixture, "down")
    const last = await fixture.waitForFrame((text) => text.includes("row 3 of 3"))
    expect(last).toContain("row 3 of 3")
    dispatch(fixture, "return")
    const detail = await fixture.waitForFrame((text) => text.includes("Request Detail:"))
    expect(detail).toContain("Request Detail: req_10")
    expect(queries.at(-1)?.id).toBe("req_10")
  } finally {
    fixture.destroy()
  }
})

test("a same-id Cache row updates model, tokens and cause without being remounted", async () => {
  const settings: MonitorSettings = { ...defaultSettings, tab: "cache", scope: "all" }
  const newest = COUNT - 1
  let baseline = true
  const { fixture } = await render(settings, {
    report: (input) => {
      const base = makeReport(input)
      const changed = baseline
        ? request(newest, { model: "claude-3-7-sonnet", causeText: "Sent prefix unchanged" })
        : request(newest, { model: "gpt-5", input: 999_000, causeText: "Sent content changed: tools[read]" })
      return { ...base, requests: [...base.requests!.slice(0, -1), changed] }
    },
  })
  try {
    await fixture.waitForFrame((text) => text.includes("Sent prefix unchanged"))
    const before = fixture.renderer.root.findDescendantById(`monitor-row-req_${newest}`)
    expect(before).toBeDefined()

    baseline = false
    await sleep(2_500)
    await fixture.flush()

    const after = fixture.renderer.root.findDescendantById(`monitor-row-req_${newest}`)
    // The row renderable is reused, not remounted, and its cells carry the
    // changed fields.
    expect(after).toBe(before)
    const cells = (after as unknown as { getChildren: () => { plainText?: string }[] })
      .getChildren()
      .map((c) => c.plainText)
    expect(cells.join(" ")).toContain("gpt-5")
    expect(cells.join(" ")).toContain("999k")
    expect(cells.join(" ")).toContain("Sent content changed: tools[read]")
  } finally {
    fixture.destroy()
  }
})

test("the Cache and Sessions tabs window their rows the same way", async () => {
  for (const tab of ["cache", "sessions"] as const) {
    const { fixture } = await render({ ...defaultSettings, tab, scope: "all" })
    try {
      await fixture.waitForFrame((text) => text.includes(`of ${COUNT}`))
      const mounted = mountedRows(fixture)
      expect(mounted.length).toBeGreaterThan(0)
      expect(mounted.length).toBeLessThan(200)
    } finally {
      fixture.destroy()
    }
  }
})

test("the Cache tab lists newest first and the first row opens its own detail", async () => {
  const { fixture, queries } = await render(
    { ...defaultSettings, tab: "cache", scope: "all" },
    {
      report: (input) => ({
        ...makeReport(input),
        requests: [
          request(10, { at: NOW - 3_000 }),
          request(11, { at: NOW - 2_000 }),
          request(12, { at: NOW - 1_000 }),
        ],
      }),
    },
  )
  try {
    const first = await fixture.waitForFrame((text) => text.includes("row-0012"))
    // Newest first: the newest row renders above the older ones.
    expect(first.indexOf("row-0012")).toBeLessThan(first.indexOf("row-0011"))
    expect(first.indexOf("row-0011")).toBeLessThan(first.indexOf("row-0010"))
    expect(fixture.captureCharFrame()).toContain("row 1 of 3")
    // Selecting the first row shows its own (newest) request's detail.
    dispatch(fixture, "return")
    const detail = await fixture.waitForFrame((text) => text.includes("Request Detail:"))
    expect(detail).toContain("Request Detail: req_12")
    expect(queries.at(-1)?.id).toBe("req_12")
  } finally {
    fixture.destroy()
  }
})

test("a new request leaves a list scrolled away from the selection where it is", async () => {
  let extra: Plus.MonitorRequest[] = []
  const { fixture } = await render(
    { ...defaultSettings, tab: "cache", scope: "all" },
    { report: (input) => ({ ...makeReport(input), requests: [...makeReport(input).requests!.slice(-100), ...extra] }) },
  )
  try {
    await fixture.waitForFrame((text) => text.includes("row-4999"))
    const scroll = scrollBox(fixture)
    scroll.scrollTo(60)
    await fixture.flush()
    expect(fixture.captureCharFrame()).toContain("row-4939")
    // The newest request arrives at the top while the selection is off screen.
    // Every frame drawn meanwhile keeps the rows on screen: none is blank.
    const frames: string[] = []
    const record = () => frames.push(fixture.captureCharFrame())
    fixture.renderer.on("frame", record)
    extra = [request(COUNT, { at: NOW + 1_000 })]
    await sleep(2_500)
    await fixture.flush()
    fixture.renderer.off("frame", record)
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("row 2 of 101")
    expect(scroll.scrollTop).toBe(61)
    expect(frame).toContain("row-4939")
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.filter((drawn) => !drawn.includes("row-4939"))).toEqual([])
  } finally {
    fixture.destroy()
  }
})

/** Pages by cursor (100 unless asked), newest page first, as the monitor's request pages are served. */
function pagedReport(rows: () => readonly Plus.MonitorRequest[]) {
  return (input: Plus.MonitorQueryInput): Plus.MonitorReport => {
    const all = rows()
    const cursor = input.requestPage?.cursor
    const limit = input.requestPage?.limit ?? 100
    const page = (cursor === undefined ? all : all.filter((row) => row.at < cursor.at)).slice(-limit)
    return {
      ...makeReport(input),
      requests: page,
      requestPage: {
        total: all.length,
        returned: page.length,
        limit,
        complete: page.length === all.length,
        ...(page[0] !== undefined && page[0].id !== all[0]?.id ? { older: { at: page[0].at, id: page[0].id } } : {}),
      },
    }
  }
}

test("the Cache list loads older requests before the scroll reaches its last row", async () => {
  let rows = Array.from({ length: 1_000 }, (_, index) => request(4_000 + index))
  const { fixture, queries } = await render({ ...defaultSettings, tab: "cache", scope: "all" }, { report: pagedReport(() => rows) })
  try {
    await fixture.waitForFrame((text) => text.includes("100/1000 requests"))
    const scroll = scrollBox(fixture)
    // Still about 45 rows above the end of the first page: the next one loads now.
    scroll.scrollTo(30)
    await fixture.waitForFrame((text) => text.includes("200/1000 requests"))
    expect(scroll.scrollTop).toBe(30)
    expect(queries.filter((query) => query.requestPage?.direction === "older")).toHaveLength(1)
    // The keyboard runs on past the first page without a stop.
    for (let step = 0; step < 150; step++) dispatch(fixture, "down")
    const moved = await fixture.waitForFrame((text) => text.includes("row 151 of"))
    expect(moved).toContain("row-4849")
    // Polls keep the loaded rows and add new ones at the top.
    rows = [...rows, request(5_000, { at: NOW + 1_000 })]
    await sleep(2_500)
    await fixture.flush()
    const polled = fixture.captureCharFrame()
    expect(polled).toMatch(/[23]01\/1001 requests/)
    expect(polled).toContain("row 152 of")
  } finally {
    fixture.destroy()
  }
})

test("the scrollbar spans the whole chat, and a drag far down loads the rows down to it", async () => {
  const rows = Array.from({ length: 1_000 }, (_, index) => request(4_000 + index))
  const { fixture, queries } = await render({ ...defaultSettings, tab: "cache", scope: "all" }, { report: pagedReport(() => rows) })
  try {
    await fixture.waitForFrame((text) => text.includes("100/1000 requests"))
    const scroll = scrollBox(fixture)
    // Room for all 1000 rows from the first page on: loading never resizes it.
    const height = scroll.scrollHeight
    expect(height).toBeGreaterThanOrEqual(1_000)
    scroll.scrollTo(30)
    await fixture.waitForFrame((text) => text.includes("200/1000 requests"))
    expect(scroll.scrollHeight).toBe(height)
    // Dragged to row 701: one request reaches it, and its rows are drawn there.
    scroll.scrollTo(700)
    const far = await fixture.waitForFrame((text) => text.includes("row-4299"))
    expect(scroll.scrollTop).toBe(700)
    expect(scroll.scrollHeight).toBe(height)
    expect(far).toMatch(/[89]00\/1000 requests/)
    expect(queries.some((query) => query.requestPage?.limit === 500)).toBe(true)
  } finally {
    fixture.destroy()
  }
})

test("scrolling to the start of a long chat loads every request once", async () => {
  const rows = Array.from({ length: 1_000 }, (_, index) => request(4_000 + index))
  const { fixture, queries } = await render({ ...defaultSettings, tab: "cache", scope: "all" }, { report: pagedReport(() => rows) })
  try {
    await fixture.waitForFrame((text) => text.includes("100/1000 requests"))
    const scroll = scrollBox(fixture)
    for (let step = 0; step < 40 && !fixture.captureCharFrame().includes("row-4000"); step++) {
      scroll.scrollTo(scroll.scrollTop + 60)
      await fixture.flush()
      await sleep(50)
    }
    const end = fixture.captureCharFrame()
    expect(end).toContain("row-4000")
    expect(end).toContain("1000/1000 requests · [—] older")
    const loads = queries.filter((query) => query.requestPage?.direction === "older")
    expect(new Set(loads.map((query) => query.requestPage?.cursor?.id)).size).toBe(loads.length)
    // l returns to the newest request.
    dispatch(fixture, "l")
    const latest = await fixture.waitForFrame((text) => text.includes("row-4999"))
    expect(latest).toContain("row 1 of 1000")
    expect(scroll.scrollTop).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("a new request keeps the selection on the same request, not the same row", async () => {
  let extra: Plus.MonitorRequest[] = []
  const { fixture } = await render(
    { ...defaultSettings, tab: "cache", scope: "all" },
    {
      report: (input) => ({
        ...makeReport(input),
        requests: [
          request(10, { at: NOW - 3_000 }),
          request(11, { at: NOW - 2_000 }),
          request(12, { at: NOW - 1_000 }),
          ...extra,
        ],
      }),
    },
  )
  try {
    await fixture.waitForFrame((text) => text.includes("row-0012"))
    expect(fixture.captureCharFrame()).toContain("row 1 of 3")
    // A newer request arrives at the top; the selection follows req_12 down.
    extra = [request(13, { at: NOW - 500 })]
    await sleep(2_500)
    await fixture.flush()
    const kept = fixture.captureCharFrame()
    expect(kept).toContain("row 2 of 4")
    expect(kept).toContain("row-0012")
    dispatch(fixture, "return")
    const detail = await fixture.waitForFrame((text) => text.includes("Request Detail:"))
    expect(detail).toContain("Request Detail: req_12")
  } finally {
    fixture.destroy()
  }
})
