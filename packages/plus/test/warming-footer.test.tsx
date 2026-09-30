import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { CONFIRM_MS, confirmText, createWarming } from "../src/tui/warming.js"
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

test("a warm cache, a chat with warming off and a running chat send at once", async () => {
  const warming = { current: undefined as ReturnType<typeof createWarming> | undefined }
  const statuses: Record<string, unknown> = {
    ses_warm: { sessionID: "ses_warm", chat: "default", active: true, since: Date.now(), expires: Date.now() + 30 * MINUTE, interval: 4 * MINUTE, now: Date.now() },
    ses_off: { sessionID: "ses_off", chat: "off", active: false, since: Date.now(), expires: Date.now() - MINUTE, interval: 4 * MINUTE, now: Date.now() },
    ses_running: { sessionID: "ses_running", chat: "default", active: false, since: Date.now() - 40 * MINUTE, expires: Date.now() - MINUTE, interval: 4 * MINUTE, now: Date.now() },
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
    for (const [sessionID, shown] of [["ses_warm", "cache warm"], ["ses_off", "cache warming off"], ["ses_running", "cache cold"]] as const) {
      setSession(sessionID)
      await fixture.waitForFrame((next) => next.includes(shown))
      expect([sessionID, fixture.send({ sessionID, mode: "normal", delivery: "steer" })]).toEqual([sessionID, true])
    }
  } finally {
    warming.current?.dispose()
  }
})
