import { expect, test } from "bun:test"
import { createWarming } from "../src/tui/warming.js"
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
