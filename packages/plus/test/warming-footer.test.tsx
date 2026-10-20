import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { CONFIRM_MS, confirmText, createWarming, holdsSend, warmingLabel } from "../src/tui/warming.js"
import { createTestTheme, renderPlusFixture } from "./tui.js"

const MINUTE = 60_000

test("the real footer turns from the countdown to a yellow cache cold when the window runs out, and stays", async () => {
  const opened = Date.now()
  const warming = { current: undefined as ReturnType<typeof createWarming> | undefined }
  await using fixture = await renderPlusFixture({
    snapshots: [],
    width: 80,
    height: 4,
    rpc: {
      "warming.status": async () => ({
        sessionID: "ses_warm",
        chat: "default",
        active: true,
        since: opened - 30 * MINUTE,
        expires: opened + 1_500,
        interval: 4 * MINUTE,
        now: Date.now(),
      }),
    },
    render: (context) => {
      warming.current = createWarming(context)
      return <warming.current.Footer sessionID="ses_warm" />
    },
  })
  // The footer changes on a real one-second clock, so poll in wall time: the
  // fixture's waitForFrame stops as soon as the renderer is idle.
  const until = async (predicate: (frame: string) => boolean) => {
    const deadline = Date.now() + 5_000
    while (true) {
      await fixture.flush()
      const frame = fixture.captureCharFrame()
      if (predicate(frame) || Date.now() > deadline) return frame
      await Bun.sleep(50)
    }
  }
  try {
    const counting = await until((frame) => frame.includes("cache warm ·"))
    expect(counting).toMatch(/cache warm · 0:0[12] left/)
    const muted = fixture
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.startsWith("cache warm"))
    expect(muted?.fg.equals(createTestTheme().text.muted)).toBe(true)
    const cold = await until((frame) => frame.includes("cache cold"))
    expect(cold).toContain("cache cold")
    expect(cold).not.toContain("cache warm ·")
    const span = fixture
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((item) => item.text.startsWith("cache cold"))
    expect(span?.fg.equals(createTestTheme().text.feedback.warning.base)).toBe(true)
    // It stays on later ticks instead of disappearing.
    await Bun.sleep(1_200)
    await fixture.flush()
    expect(fixture.captureCharFrame()).toContain("cache cold")
  } finally {
    warming.current?.dispose()
  }
})

// Sending into a cold cache: like interrupting a running chat, the first submit
// arms and the footer asks for a second; a second within CONFIRM_MS sends.
test("a send into a cold cache is held until a second submit, and the footer asks for it", async () => {
  const warming = { current: undefined as ReturnType<typeof createWarming> | undefined }
  const cold = {
    sessionID: "ses_cold",
    chat: "default",
    active: false,
    since: Date.now() - 40 * MINUTE,
    expires: Date.now() - 5 * MINUTE,
    interval: 4 * MINUTE,
    now: Date.now(),
  }
  await using fixture = await renderPlusFixture({
    snapshots: [],
    width: 80,
    height: 4,
    rpc: { "warming.status": async () => cold },
    render: (context) => {
      warming.current = createWarming(context)
      return <warming.current.Footer sessionID="ses_cold" />
    },
  })
  const frame = async () => {
    await fixture.flush()
    return fixture.captureCharFrame()
  }
  try {
    await fixture.waitForFrame((next) => next.includes("cache cold"))
    // Shell commands, other chats and a new chat are never held.
    expect(fixture.send({ sessionID: "ses_cold", mode: "shell", delivery: "steer" })).toBe(true)
    expect(fixture.send({ sessionID: "ses_other", mode: "normal", delivery: "steer" })).toBe(true)
    expect(fixture.send({ mode: "normal", delivery: "steer" })).toBe(true)
    // First submit: held, and the footer asks for the second.
    expect(fixture.send({ sessionID: "ses_cold", mode: "normal", delivery: "steer" })).toBe(false)
    expect(await frame()).toContain(confirmText("enter"))
    const span = fixture
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((item) => item.text.startsWith("cache cold ·"))
    expect(span?.fg.equals(createTestTheme().text.feedback.warning.base)).toBe(true)
    // Second submit sends, and the footer is plain cache cold again.
    expect(fixture.send({ sessionID: "ses_cold", mode: "normal", delivery: "steer" })).toBe(true)
    const after = await frame()
    expect(after).toContain("cache cold")
    expect(after).not.toContain("again to send")
    // Armed again, it lapses after CONFIRM_MS: the next submit is held again.
    expect(fixture.send({ sessionID: "ses_cold", mode: "normal", delivery: "steer" })).toBe(false)
    await Bun.sleep(CONFIRM_MS + 100)
    expect(await frame()).not.toContain("again to send")
    expect(fixture.send({ sessionID: "ses_cold", mode: "normal", delivery: "steer" })).toBe(false)
  } finally {
    warming.current?.dispose()
  }
}, 15_000)

// With Compact cold chats first on and a cold-cache list, the server summarizes
// the chat before the model answers: nothing to confirm, the first Enter sends.
test("a send into a cold cache that the cold-cache models will summarize first goes on the first submit", async () => {
  const warming = { current: undefined as ReturnType<typeof createWarming> | undefined }
  const cold = {
    sessionID: "ses_cold",
    chat: "default",
    active: false,
    since: Date.now() - 40 * MINUTE,
    expires: Date.now() - 5 * MINUTE,
    interval: 4 * MINUTE,
    coldModels: ["proxy/summary", "proxy/fallback"],
    now: Date.now(),
  }
  await using fixture = await renderPlusFixture({
    snapshots: [],
    width: 80,
    height: 4,
    rpc: { "warming.status": async () => cold },
    render: (context) => {
      warming.current = createWarming(context)
      return <warming.current.Footer sessionID="ses_cold" />
    },
  })
  try {
    await fixture.waitForFrame((next) => next.includes("cache cold · compacts with proxy/summary first"))
    expect(fixture.send({ sessionID: "ses_cold", mode: "normal", delivery: "steer" })).toBe(true)
    await fixture.flush()
    expect(fixture.captureCharFrame()).not.toContain("again to send")
  } finally {
    warming.current?.dispose()
  }
})

test("a warm cache, a chat with warming off, a running chat and a compacted chat send at once", async () => {
  const warming = { current: undefined as ReturnType<typeof createWarming> | undefined }
  const statuses: Record<string, unknown> = {
    ses_warm: { sessionID: "ses_warm", chat: "default", active: true, since: Date.now(), expires: Date.now() + 30 * MINUTE, interval: 4 * MINUTE, now: Date.now() },
    ses_off: { sessionID: "ses_off", chat: "off", active: false, since: Date.now(), expires: Date.now() - MINUTE, interval: 4 * MINUTE, now: Date.now() },
    ses_running: { sessionID: "ses_running", chat: "default", active: false, since: Date.now() - 40 * MINUTE, expires: Date.now() - MINUTE, interval: 4 * MINUTE, now: Date.now() },
    ses_compacted: { sessionID: "ses_compacted", chat: "default", compacted: true, active: false, now: Date.now() },
  }
  const [session, setSession] = createSignal("ses_warm")
  await using fixture = await renderPlusFixture({
    snapshots: [],
    width: 80,
    height: 4,
    sessionStatus: { ses_running: "running" },
    rpc: { "warming.status": async (input: { sessionID: string }) => statuses[input.sessionID] },
    render: (context) => {
      warming.current = createWarming(context)
      return <warming.current.Footer sessionID={session()} />
    },
  })
  try {
    for (const [sessionID, shown] of [["ses_warm", "cache warm"], ["ses_off", "cache warming off"], ["ses_running", "cache cold"], ["ses_compacted", "compacted"]] as const) {
      setSession(sessionID)
      await fixture.waitForFrame((next) => next.includes(shown))
      expect([sessionID, fixture.send({ sessionID, mode: "normal", delivery: "steer" })]).toEqual([sessionID, true])
    }
  } finally {
    warming.current?.dispose()
  }
})

test("a compacted chat shows compacted in muted text and sends on the first submit", async () => {
  const warming = { current: undefined as ReturnType<typeof createWarming> | undefined }
  const status = {
    sessionID: "ses_compacted",
    chat: "default" as const,
    compacted: true,
    active: false,
    now: Date.now(),
  }
  await using fixture = await renderPlusFixture({
    snapshots: [],
    width: 80,
    height: 4,
    rpc: { "warming.status": async () => status },
    render: (context) => {
      warming.current = createWarming(context)
      return <warming.current.Footer sessionID="ses_compacted" />
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("compacted"))
    expect(fixture.captureCharFrame()).toContain("compacted")
    const span = fixture
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((item) => item.text.startsWith("compacted"))
    expect(span?.fg.equals(createTestTheme().text.muted)).toBe(true)

    // The guard lets the first submit through without holding for a second enter.
    expect(fixture.send({ sessionID: "ses_compacted", mode: "normal", delivery: "steer" })).toBe(true)
  } finally {
    warming.current?.dispose()
  }
})

test("compact before cold switches per chat to a single compact label with no separate marker", async () => {
  const warming = { current: undefined as ReturnType<typeof createWarming> | undefined }
  const state = { compact: false }
  const calls: unknown[] = []
  const expires = Date.now() + 23 * MINUTE + 41_000
  const status = () => ({
    sessionID: "ses_chat",
    chat: "default" as const,
    compact: state.compact,
    active: true,
    expires,
    interval: 4 * MINUTE,
    now: Date.now(),
  })
  await using fixture = await renderPlusFixture({
    snapshots: [],
    width: 80,
    height: 4,
    route: { type: "session", sessionID: "ses_chat" },
    rpc: {
      "warming.status": async () => status(),
      "warming.compact": async (input: { sessionID: string; on: boolean }) => {
        calls.push(input)
        state.compact = input.on
        return status()
      },
    },
    render: (context) => {
      warming.current = createWarming(context)
      return (
        <box flexDirection="row" gap={2}>
          <warming.current.Footer sessionID="ses_chat" />
          <text>~/project</text>
        </box>
      )
    },
  })
  try {
    // Off in a new chat: standard cache warm countdown, no separate marker.
    await fixture.waitForFrame((frame) => frame.includes("cache warm ·"))
    expect(fixture.captureCharFrame()).not.toContain("compact before cold")
    expect(fixture.captureCharFrame()).toContain("cache warm ·")
    expect(fixture.captureCharFrame()).not.toContain("compact cache warm")

    // Switch on: turns into single label "compact cache warm · ...", no separate marker.
    await warming.current!.toggleCompact()
    await fixture.waitForFrame((frame) => frame.includes("compact cache warm ·"))
    expect(fixture.captureCharFrame()).not.toContain("compact before cold")
    const line = fixture.captureCharFrame().split("\n").find((entry) => entry.includes("compact cache warm")) ?? ""
    expect(line).toContain("compact cache warm ·")
    expect(line).toContain("~/project")

    const span = fixture
      .captureSpans()
      .lines.flatMap((entry) => entry.spans)
      .find((item) => item.text.startsWith("compact cache warm"))
    expect(span?.fg.equals(createTestTheme().text.muted)).toBe(true)
    expect(fixture.fake.toasts.at(-1)?.message).toContain("Compact before cold on")

    // The same switch turns it off again.
    await warming.current!.toggleCompact()
    await fixture.waitForFrame((frame) => frame.includes("cache warm ·") && !frame.includes("compact cache warm"))
    expect(calls).toEqual([
      { sessionID: "ses_chat", on: true },
      { sessionID: "ses_chat", on: false },
    ])
    expect(fixture.fake.toasts.at(-1)?.message).toBe("Compact before cold off for this chat")
  } finally {
    warming.current?.dispose()
  }
})

test("warmingLabel formats the compact before cold single label and compacted state correctly", () => {
  const now = 1_000_000
  // 1. compactAt countdown
  expect(
    warmingLabel({ sessionID: "s", chat: "default", compact: true, compactAt: now + 5_000, active: true, now }, now),
  ).toEqual({ text: "compact cache warm · 0:05 left", tone: "muted" })

  // 2. window-end countdown
  expect(
    warmingLabel({ sessionID: "s", chat: "default", compact: true, active: true, expires: now + 5_000, now }, now),
  ).toEqual({ text: "compact cache warm · 0:05 left", tone: "muted" })

  // 3. warming off + compactAt
  expect(
    warmingLabel(
      { sessionID: "s", chat: "off", compact: true, compactAt: now + 5_000, active: false, expires: now - 1000, now },
      now,
    ),
  ).toEqual({ text: "compact cache warm · 0:05 left", tone: "muted" })

  // 4. compact cache cold
  expect(
    warmingLabel({ sessionID: "s", chat: "default", compact: true, active: false, expires: now - 5_000, now }, now),
  ).toEqual({ text: "compact cache cold", tone: "warning" })

  expect(
    warmingLabel(
      { sessionID: "s", chat: "default", compact: true, compactAt: now - 1_000, active: false, now },
      now,
    ),
  ).toEqual({ text: "compact cache cold", tone: "warning" })

  // 5. compacted muted (compact on or off, chat on/off/default)
  expect(
    warmingLabel({ sessionID: "s", chat: "default", compact: true, compacted: true, active: false, now }, now),
  ).toEqual({ text: "compacted", tone: "muted" })

  expect(
    warmingLabel({ sessionID: "s", chat: "default", compact: false, compacted: true, active: false, now }, now),
  ).toEqual({ text: "compacted", tone: "muted" })

  expect(
    warmingLabel({ sessionID: "s", chat: "off", compact: false, compacted: true, active: false, now }, now),
  ).toEqual({ text: "compacted", tone: "muted" })
})

test("warming switched off mid-window counts down to the keep-alive where the cache goes cold", () => {
  const now = 1_000_000
  const off = {
    sessionID: "s",
    chat: "off" as const,
    active: false,
    since: now - MINUTE,
    expires: now + 29 * MINUTE,
    interval: 4 * MINUTE,
    coldAt: now + 3 * MINUTE,
    now,
  }
  // Compact before cold on: the compaction moved to that keep-alive moment.
  const compacting = { ...off, compact: true, compactAt: off.coldAt }
  expect(warmingLabel(compacting, now)).toEqual({ text: "compact cache warm · 3:00 left", tone: "muted" })
  expect(warmingLabel(compacting, now + 3 * MINUTE + 1_000)).toEqual({ text: "compact cache cold", tone: "warning" })
  // Compact before cold off: the same moment, while warming stays off.
  const cooling = { ...off, compact: false, coldAt: now + 2 * MINUTE + 30_000 }
  expect(warmingLabel(cooling, now)).toEqual({ text: "cache warming off · warm 2:30 left", tone: "muted" })
  // Then it says the cache is cold, without holding a send: warming is off for it.
  expect(warmingLabel(cooling, cooling.coldAt)).toEqual({ text: "cache cold · warming off", tone: "warning", holds: false })
  expect(warmingLabel(cooling, cooling.coldAt + MINUTE)).toEqual({ text: "cache cold · warming off", tone: "warning", holds: false })
  expect(warmingLabel({ ...cooling, coldModels: ["proxy/cheap"] }, cooling.coldAt)).toEqual({
    text: "cache cold · compacts with proxy/cheap first",
    tone: "warning",
    holds: false,
  })
  expect(holdsSend(warmingLabel(cooling, cooling.coldAt))).toBe(false)
  // A window that ran out does hold the send, as before.
  expect(holdsSend(warmingLabel({ ...off, chat: "default", compact: false, coldAt: undefined }, off.expires + 1))).toBe(true)
  // Control: a chat with warming off and no window to count shows the plain label.
  expect(warmingLabel({ sessionID: "s", chat: "off", compact: false, active: false, now }, now)).toEqual({
    text: "cache warming off",
    tone: "muted",
  })
})

test("the real footer counts a switched-off chat down to its cold moment, then says it is cold, and never holds its send", async () => {
  const warming = { current: undefined as ReturnType<typeof createWarming> | undefined }
  const opened = Date.now()
  await using fixture = await renderPlusFixture({
    snapshots: [],
    width: 80,
    height: 4,
    rpc: {
      "warming.status": async () => ({
        sessionID: "ses_off",
        chat: "off",
        compact: false,
        active: false,
        since: opened - 3 * MINUTE,
        expires: opened + 27 * MINUTE,
        interval: 4 * MINUTE,
        coldAt: opened + 1_500,
        now: Date.now(),
      }),
    },
    render: (context) => {
      warming.current = createWarming(context)
      return <warming.current.Footer sessionID="ses_off" />
    },
  })
  const until = async (predicate: (frame: string) => boolean) => {
    const deadline = Date.now() + 5_000
    while (true) {
      await fixture.flush()
      const frame = fixture.captureCharFrame()
      if (predicate(frame) || Date.now() > deadline) return frame
      await Bun.sleep(50)
    }
  }
  try {
    expect(await until((frame) => frame.includes("cache warming off · warm"))).toMatch(/cache warming off · warm 0:0[12] left/)
    expect(fixture.send({ sessionID: "ses_off", mode: "normal", delivery: "steer" })).toBe(true)
    const cold = await until((frame) => frame.includes("cache cold · warming off"))
    expect(cold).toContain("cache cold · warming off")
    expect(cold).not.toContain("left")
    const span = fixture
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((item) => item.text.startsWith("cache cold"))
    expect(span?.fg.equals(createTestTheme().text.feedback.warning.base)).toBe(true)
    expect(fixture.send({ sessionID: "ses_off", mode: "normal", delivery: "steer" })).toBe(true)
  } finally {
    warming.current?.dispose()
  }
})

test("the footer keeps warming visible regardless of compaction source and names the cold-arming model", () => {
  const now = 1_000_000
  const base = { sessionID: "s", chat: "default" as const, compact: true, active: true, expires: now + 5_000, now }
  expect(warmingLabel({ ...base, compactSource: "chat" }, now)).toEqual({
    text: "compact cache warm · 0:05 left",
    tone: "muted",
  })
  expect(warmingLabel({ ...base, compactSource: "model" }, now)).toEqual({
    text: "compact cache warm · 0:05 left",
    tone: "muted",
  })
  // When cold arming applies, the footer names the model it compacts with first.
  expect(warmingLabel({ ...base, compactSource: "model", coldModels: ["a/b", "c/d"] }, now)).toEqual({
    text: "compact cache warm · 0:05 left",
    tone: "muted",
  })
  const cold = { ...base, compactSource: "model" as const, active: false, expires: now - 5_000, coldModels: ["a/b", "c/d"] }
  expect(warmingLabel(cold, now)).toEqual({ text: "cache cold · compacts with a/b first", tone: "warning" })
  expect(warmingLabel({ ...base, compact: false, compactSource: "chat" }, now)).toEqual({
    text: "cache warm · 0:05 left",
    tone: "muted",
  })
  // The model's off (no chat override) leaves the ordinary warming label.
  expect(warmingLabel({ sessionID: "s", chat: "default", compact: false, compactSource: "model", active: false, now }, now)).toBeUndefined()
})
