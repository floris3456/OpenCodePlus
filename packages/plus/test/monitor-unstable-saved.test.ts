import { afterEach, expect, test } from "bun:test"
import { windowedSessionSignals } from "../src/monitor/cache.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import type { Ledger } from "../src/monitor/ledger.js"
import { sessionFold } from "../src/monitor/report.js"
import { savedUnstable, settleRequestChanges } from "../src/monitor/unstable-saved.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

const BASE = "base".repeat(1600)

// One request whose system prompt and shell description name the segments they
// change, so the diff reports them under stable names.
function request(
  db: Ledger,
  id: string,
  at: number,
  options: { system: string; tool?: string; agent?: string; kind?: string } = { system: "rules" },
) {
  db.session({ id: "unstable", agent: "build" }, at)
  db.requestStarted({
    id,
    sessionID: "unstable",
    messageID: id,
    kind: options.kind ?? "step",
    isTitle: options.kind === "title",
    agent: options.agent ?? "build",
    provider: "openai",
    model: "gpt-4o",
    started: at,
  })
  db.requestEnded(id, {
    ended: at + 1,
    status: "completed",
    usage: { input: 1000, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 1000, cost: 0 },
  })
  db.requestFingerprint({
    requestID: id,
    sessionID: "unstable",
    created: at,
    ...fingerprintWireBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "system", content: BASE },
          { role: "system", content: options.system },
          { role: "user", content: "Hello" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "shell", description: options.tool ?? "run a shell", parameters: { type: "object" } },
          },
        ],
      },
      {
        protocol: "openai-chat",
        namedSystemParts: [
          { name: "base", text: BASE },
          { name: "AGENTS.md", text: options.system },
        ],
      },
    ),
  })
}

const WINDOW = { since: 0, until: 10_000_000 }

test("saved changed segments replay the fold's unstable streaks in the same order", async () => {
  const db = await ledger()
  // The tools start changing a request before the system prompt, so the entry
  // order of a row where both qualify follows first change, not the diff order.
  request(db, "r0", 1_000, { system: "rules", tool: "run a shell 0" })
  request(db, "ping", 1_100, { system: "a private warming prompt", tool: "another tool", kind: "ping" })
  request(db, "r1", 1_200, { system: "rules", tool: "run a shell 1" })
  request(db, "title", 1_300, { system: "a title prompt", tool: "another tool", kind: "title" })
  request(db, "r2", 1_400, { system: "rules 2", tool: "run a shell 2" })
  request(db, "r3", 1_500, { system: "rules 3", tool: "run a shell 3" })
  request(db, "r4", 1_600, { system: "rules 4", tool: "run a shell 4", agent: "review" })

  expect(settleRequestChanges(db, 1_000_000)).toBe(7)
  expect(settleRequestChanges(db, 1_000_000)).toBe(0)

  const fold = sessionFold(db, "unstable").analysis
  for (const selection of [{}, { agents: ["build"] }, { agents: ["review"] }, { models: ["openai/gpt-4o"] }]) {
    const expected = windowedSessionSignals(fold, WINDOW, selection).unstable.map((entry) => ({
      segment: entry.segment,
      streak: entry.streak,
    }))
    const saved = savedUnstable(db, ["unstable"], WINDOW, selection)
    expect(saved.pending).toBe(0)
    expect(saved.unstable).toEqual(expected.map((entry) => ({ sessionID: "unstable", ...entry })))
  }

  // At the fourth real request the tools have changed four times and the
  // system prompt three, ordered by when each name first changed.
  expect(savedUnstable(db, ["unstable"], WINDOW, {})).toEqual({
    unstable: [
      { sessionID: "unstable", segment: "tool shell description", streak: 4 },
      { sessionID: "unstable", segment: "tool shell wire", streak: 4 },
      { sessionID: "unstable", segment: "system wire", streak: 3 },
    ],
    pending: 0,
  })
  // A window ending before that request keeps only the tools' third streak.
  const early = { since: 0, until: 1_550 }
  expect(savedUnstable(db, ["unstable"], early, {})).toEqual({
    unstable: [
      { sessionID: "unstable", segment: "tool shell description", streak: 3 },
      { sessionID: "unstable", segment: "tool shell wire", streak: 3 },
    ],
    pending: 0,
  })
  expect(savedUnstable(db, ["unstable"], early, { agents: ["review"] }).unstable).toEqual([])

  // A request written after settling is pending until it gets its own row.
  request(db, "r5", 1_700, { system: "rules 4", tool: "run a shell 4" })
  expect(savedUnstable(db, ["unstable"], WINDOW, {}).pending).toBe(1)
  expect(settleRequestChanges(db, 1_000_000)).toBe(1)
  expect(savedUnstable(db, ["unstable"], WINDOW, {}).pending).toBe(0)
  expect(savedUnstable(db, ["unstable"], WINDOW, {}).unstable).toEqual(
    windowedSessionSignals(sessionFold(db, "unstable").analysis, WINDOW, {}).unstable.map((entry) => ({
      sessionID: "unstable",
      ...entry,
    })),
  )
})
