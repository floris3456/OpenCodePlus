import { expect, test } from "bun:test"
import {
  barCells,
  countdown,
  percentLabel,
  usageArguments,
  windowLabel,
  windowShort,
  windowState,
  windowTail,
} from "../../src/quota/usage-format.js"
import type { UsageSnapshot, UsageWindow } from "../../src/quota/usage.js"

const window: UsageWindow = { scope: "all", seconds: 18000, remaining: 61, reset: 103600, observed: 99999, held: false }
const snapshot = { now: 100000, max_age_seconds: 90 } as UsageSnapshot

test("window names cover five-hour, weekly and other returned windows", () => {
  expect([windowLabel(window), windowShort(window)]).toEqual(["5 hours", "5h"])
  expect(windowLabel({ ...window, seconds: 604800, scope: "sonnet" })).toBe("7 days · sonnet")
  expect(windowShort({ ...window, seconds: 2592000 })).toBe("30d")
  expect(windowLabel({ ...window, seconds: 5400 })).toBe("90 minutes")
  expect(windowLabel({ ...window, seconds: 86400 })).toBe("1 day")
})

test("compact numbers never overstate capacity and fit their columns", () => {
  expect(percentLabel(99.9)).toBe("99%")
  expect(percentLabel(0.4)).toBe("<1%")
  expect(percentLabel(140)).toBe("100%")
  expect(barCells(50, 10)).toEqual({ filled: "█████", empty: "░░░░░" })
  expect(barCells(-5, 4)).toEqual({ filled: "", empty: "░░░░" })
  expect([countdown(30), countdown(3600), countdown(3660), countdown(604799)]).toEqual([
    "<1m",
    "1h 0m",
    "1h 1m",
    "7d 0h",
  ])
  for (const seconds of [59, 3599, 86399, 604800 * 4]) expect(countdown(seconds).length).toBeLessThanOrEqual(7)
})

test("window state distinguishes stale readings, passed resets, dormant and unlimited windows", () => {
  expect(windowState(window, snapshot, 100000)).toBe("normal")
  expect(windowState({ ...window, remaining: 15 }, snapshot, 100000)).toBe("low")
  expect(windowState({ ...window, remaining: 9 }, snapshot, 100000)).toBe("critical")
  expect(windowState({ ...window, observed: 99000 }, snapshot, 100000)).toBe("stale")
  expect(windowState(window, snapshot, 103601)).toBe("reset")
  expect(windowState({ ...window, dormant: true, reset: 0 }, snapshot, 100000)).toBe("dormant")
  expect(windowState({ ...window, not_applicable: true }, snapshot, 100000)).toBe("unlimited")
  // Exact hours keep two units so a countdown never looks like a window name ("5h").
  expect(windowTail(window, "normal", 100000)).toBe("1h 0m")
  expect(windowTail(window, "stale", 100000)).toBe("STALE")
})

test("slash arguments accept only an optional --all", () => {
  expect(usageArguments(" --all ")).toBe(true)
  expect(usageArguments("")).toBe(false)
  expect(usageArguments("--all trailing")).toBeUndefined()
})
