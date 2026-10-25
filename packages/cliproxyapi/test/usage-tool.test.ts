import { expect, test } from "bun:test"
import type { UsageSnapshot } from "../src/quota/usage.js"
import { usageOutput } from "../src/usage-tool.js"

const NOW = Date.parse("2026-10-25T20:00:00Z")
const window = (seconds: number, remaining: number, resetIn: number | undefined, extra: Partial<UsageSnapshot["credentials"][number]["windows"][number]> = {}) => ({
  scope: "all",
  seconds,
  remaining,
  reset: resetIn === undefined ? 0 : (NOW + resetIn) / 1000,
  observed: NOW / 1000,
  held: false,
  state: resetIn === undefined ? "dormant" : "current",
  ...(resetIn === undefined ? { dormant: true } : {}),
  ...extra,
})
const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  protocol: 1,
  view: "usage",
  now: NOW / 1000,
  max_age_seconds: 90,
  all: false,
  provider: "claude",
  model: "claude-opus-5-5",
  current: "claude-minke.json",
  active: [],
  last_used: NOW / 1000 - 60,
  credentials: [
    {
      id: "claude-minke.json",
      alias: "minke@informatix.nl",
      provider: "claude",
      shared_with: [],
      windows: [
        window(18_000, 100, undefined),
        window(604_800, 13.7, (3 * 24 * 60 + 61) * 60_000),
        window(604_800, 40, 3_600_000, { scope: "sonnet", not_applicable: true }),
      ],
    },
    {
      id: "claude-klaas.json",
      alias: "klaas@interned.nl",
      provider: "claude",
      shared_with: ["klaas-2"],
      windows: [window(18_000, 88, 4 * 3_600_000 + 5 * 60_000), window(604_800, 99, 17 * 3_600_000 + 41 * 60_000, { scope: "sonnet" })],
    },
  ],
  ...overrides,
})

test("the usage tool reads the sidebar's view: windows, the chat's account, NEXT USE and FORCE USE", () => {
  const next_use = {
    v: 1 as const,
    at_ms: NOW,
    expires_ms: NOW + 30_000,
    mode: "active" as const,
    provider: "claude",
    model: "claude-opus-5-5",
    reason: "cold_move",
    auth: "claude-klaas.json",
    forced: false,
    force_auth: "claude-klaas.json",
    force_reason: "soon" as const,
  }
  const output = usageOutput(snapshot({ next_use }), "cliproxyapi/claude-opus-5-5", NOW)
  expect(output).toEqual({
    model: "cliproxyapi/claude-opus-5-5",
    last_used: "minke@informatix.nl",
    next_use: { alias: "klaas@interned.nl", reason: "cold_move" },
    force_use: { alias: "klaas@interned.nl", when: "soon" },
    accounts: [
      {
        alias: "minke@informatix.nl",
        provider: "claude",
        id: "claude-minke.json",
        in_use: true,
        shared_with: [],
        windows: [
          { window: "5h", left: 100, state: "dormant" },
          { window: "7d", left: 13, resets_at: "2026-10-28T21:01:00.000Z", resets_in: "3d 1h", state: "current" },
        ],
      },
      {
        alias: "klaas@interned.nl",
        provider: "claude",
        id: "claude-klaas.json",
        in_use: false,
        shared_with: ["klaas-2"],
        windows: [
          { window: "5h", left: 88, resets_at: "2026-10-26T00:05:00.000Z", resets_in: "4h 5m", state: "current" },
          { window: "7d sonnet", left: 99, resets_at: "2026-10-26T13:41:00.000Z", resets_in: "17h 41m", state: "current" },
        ],
      },
    ],
    text: [
      "Credential usage for cliproxyapi/claude-opus-5-5:",
      "- minke@informatix.nl (claude) LAST USED: 5h 100% left (not started); 7d 13% left, resets in 3d 1h",
      "- klaas@interned.nl (claude): 5h 88% left, resets in 4h 5m; 7d sonnet 99% left, resets in 17h 41m",
      "NEXT USE, once this chat's cache is cold: klaas@interned.nl",
      "FORCE USE soon: klaas@interned.nl",
    ].join("\n"),
  })
})

test("a running chat's account is IN USE; a chat no account serves says so", () => {
  const running = usageOutput(snapshot({ active: ["claude-klaas.json"], current: "claude-klaas.json" }), "cliproxyapi/claude-opus-5-5", NOW)
  expect(running.in_use).toBe("klaas@interned.nl")
  expect(running.last_used).toBeUndefined()
  expect(running.text.split("\n")[2]).toStartWith("- klaas@interned.nl (claude) IN USE: ")
  expect(usageOutput(snapshot({ credentials: [], current: "" }), "cliproxyapi/unknown", NOW).text).toBe(
    "Credential usage for cliproxyapi/unknown:\nNo account serves this model.",
  )
})
