import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AttemptState, RunState } from "../../src/teams/schema.js"
import {
  ATTEMPT_TRANSITIONS,
  TRANSITIONS,
  attemptTransition,
  bySession,
  canAttemptTransition,
  canTransition,
  isAttemptTerminal,
  isTerminal,
  loadRun,
  newRunID,
  retryDelayMs,
  saveRun,
  startAttempt,
  transition,
  type RunRecord,
} from "../../src/teams/run.js"
import { verify } from "../../src/teams/audit.js"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teams-run-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

let seq = 0
function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  seq += 1
  const id = `w-${seq.toString(16).padStart(4, "0").padEnd(16, "0")}`
  const now = new Date().toISOString()
  return {
    id,
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: `/tmp/wt-${seq}`,
    branch: `team/implementer/t-${seq}`,
    base: "ocp-main",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "created",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "team2-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function caught(fn: () => unknown): Promise<unknown> {
  return Promise.resolve().then(fn).then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe("run state machine (02 §1)", () => {
  test("every documented row is accepted by canTransition", () => {
    expect(TRANSITIONS.length).toBeGreaterThan(0)
    for (const row of TRANSITIONS) {
      expect(canTransition(row.from, row.to, row.trigger, { force: true })).toBe(true)
    }
  })

  test("every non-creation row transitions to a new record with history", () => {
    for (const row of TRANSITIONS) {
      if (row.from === null) continue
      // working → superseded needs force; pass it for all rows uniformly.
      const run = makeRun({ state: row.from })
      const before = JSON.parse(JSON.stringify(run)) as RunRecord
      const next = transition(run, row.to, row.trigger, { force: true, reason: "test" })
      expect(next.state).toBe(row.to)
      expect(next.history.length).toBe(run.history.length + 1)
      expect(next.history.at(-1)).toMatchObject({ from: row.from, to: row.to, trigger: row.trigger })
      // Never mutates the input.
      expect(run).toEqual(before)
      if (row.to === "superseded") {
        expect(next.supersededReason).toBe("test")
      }
    }
  })

  test("representative undocumented pairs are refused with E_TRANSITION", async () => {
    const bad: Array<[RunState, RunState, string]> = [
      ["created", "working", "prompt"],
      ["created", "idle", "connected"],
      ["idle", "ready", "worktree_ready"],
      ["working", "ready", "worktree_ready"],
      ["ready", "stopped", "exited"],
      ["stopped", "working", "prompt"],
      ["idle", "reaped", "gc"],
      ["reaped", "starting", "resume"],
      ["reaped", "reaped", "gc"],
      ["created", "dead", "probe_failed"],
    ]
    for (const [from, to, trigger] of bad) {
      expect(canTransition(from, to, trigger, { force: true })).toBe(false)
      const thrown = await caught(() => transition(makeRun({ state: from }), to, trigger, { force: true }))
      expect(thrown).toMatchObject({ code: "E_TRANSITION" })
      const msg = (thrown as { message: string }).message
      expect(msg).toContain(from)
      expect(msg).toContain(to)
      expect(msg).toContain(trigger)
      expect((thrown as { accepted?: unknown }).accepted).toBeDefined()
    }
  })

  test("working → superseded requires force", () => {
    expect(canTransition("working", "superseded", "supersede")).toBe(false)
    expect(canTransition("working", "superseded", "supersede", { force: true })).toBe(true)
  })

  test("dead → starting on resume is allowed", () => {
    expect(canTransition("dead", "starting", "resume")).toBe(true)
    const next = transition(makeRun({ state: "dead" }), "starting", "resume")
    expect(next.state).toBe("starting")
  })

  test("superseded → anything (except gc to reaped) is refused", async () => {
    // The one legal exit is superseded → reaped on gc.
    expect(canTransition("superseded", "reaped", "gc")).toBe(true)
    const targets: RunState[] = [
      "created",
      "preparing",
      "ready",
      "starting",
      "idle",
      "working",
      "blocked_input",
      "stopping",
      "stopped",
      "dead",
      "superseded",
    ]
    for (const to of targets) {
      expect(canTransition("superseded", to, "resume")).toBe(false)
      const thrown = await caught(() => transition(makeRun({ state: "superseded" }), to, "resume"))
      expect(thrown).toMatchObject({ code: "E_TRANSITION" })
      expect((thrown as { message: string }).message).toContain("superseded")
      expect((thrown as { accepted?: unknown }).accepted).toBeDefined()
    }
  })

  test("isTerminal matches the documented terminal set", () => {
    const terminal: RunState[] = ["superseded", "reaped"]
    const nonTerminal: RunState[] = [
      "created",
      "preparing",
      "ready",
      "starting",
      "idle",
      "working",
      "blocked_input",
      "stopping",
      "stopped",
      "dead",
    ]
    for (const s of terminal) expect(isTerminal(s)).toBe(true)
    for (const s of nonTerminal) expect(isTerminal(s)).toBe(false)
  })

  test("newRunID matches /^(main|w)-[0-9a-f]{16}$/", () => {
    for (const kind of ["main", "w"] as const) {
      for (let i = 0; i < 10; i++) {
        expect(newRunID(kind)).toMatch(/^(main|w)-[0-9a-f]{16}$/)
      }
    }
    expect(newRunID("main").startsWith("main-")).toBe(true)
    expect(newRunID("w").startsWith("w-")).toBe(true)
  })
})

describe("attempt state machine (02 §2)", () => {
  test("every documented attempt row is accepted", () => {
    expect(ATTEMPT_TRANSITIONS.length).toBeGreaterThan(0)
    for (const row of ATTEMPT_TRANSITIONS) {
      expect(canAttemptTransition(row.from, row.to, row.trigger)).toBe(true)
    }
  })

  test("attemptTransition walks queued → admitted → streaming → finishing → succeeded", () => {
    let run = makeRun({ state: "working" })
    run = startAttempt(run, { trigger: "prompt", prompt: "do it" })
    expect(run.attempts.length).toBe(1)
    expect(run.attempts[0].state).toBe("queued")
    run = attemptTransition(run, "admitted", "admit")
    run = attemptTransition(run, "streaming", "first_event")
    run = attemptTransition(run, "finishing", "finish")
    run = attemptTransition(run, "succeeded", "validated")
    expect(run.attempts[0].state).toBe("succeeded")
    expect(isAttemptTerminal(run.attempts[0].state)).toBe(true)
  })

  test("failed/interrupted/timed_out/stalled reachable from any non-terminal", () => {
    const froms: AttemptState[] = ["queued", "admitted", "streaming", "finishing"]
    const tos: Array<{ to: AttemptState; trigger: string }> = [
      { to: "failed", trigger: "failed" },
      { to: "interrupted", trigger: "interrupt" },
      { to: "timed_out", trigger: "timeout" },
      { to: "stalled", trigger: "stall" },
    ]
    for (const from of froms) {
      for (const { to, trigger } of tos) {
        expect(canAttemptTransition(from, to, trigger)).toBe(true)
      }
    }
    // Spot-check through the public transition function.
    let run = makeRun({ state: "working" })
    run = startAttempt(run, { trigger: "prompt" })
    run = attemptTransition(run, "failed", "failed")
    expect(run.attempts[0].state).toBe("failed")
  })

  test("a second non-terminal attempt is refused", async () => {
    let run = makeRun({ state: "working" })
    run = startAttempt(run, { trigger: "prompt" })
    const blocked = await caught(() => startAttempt(run, { trigger: "prompt" }))
    expect(blocked).toMatchObject({ code: "E_TRANSITION" })
    expect((blocked as { accepted?: unknown }).accepted).toBeDefined()

    // Two non-terminal attempts: every attemptTransition must refuse.
    const twoOpen: RunRecord = {
      ...run,
      attempts: [
        { n: 1, state: "queued", startedAt: run.attempts[0].startedAt, trigger: "prompt" },
        { n: 2, state: "queued", startedAt: run.attempts[0].startedAt, trigger: "prompt" },
      ],
    }
    const refused = await caught(() => attemptTransition(twoOpen, "admitted", "admit"))
    expect(refused).toMatchObject({ code: "E_TRANSITION" })
  })

  test("isAttemptTerminal matches the documented set", () => {
    const terminal: AttemptState[] = [
      "succeeded",
      "reported",
      "no_report",
      "failed",
      "interrupted",
      "timed_out",
      "stalled",
    ]
    const open: AttemptState[] = ["queued", "admitted", "streaming", "finishing"]
    for (const s of terminal) expect(isAttemptTerminal(s)).toBe(true)
    for (const s of open) expect(isAttemptTerminal(s)).toBe(false)
  })
})

describe("retryDelayMs", () => {
  test("10000, 20000, 40000 … capped at 300000", () => {
    expect(retryDelayMs(1)).toBe(10000)
    expect(retryDelayMs(2)).toBe(20000)
    expect(retryDelayMs(3)).toBe(40000)
    expect(retryDelayMs(4)).toBe(80000)
    expect(retryDelayMs(5)).toBe(160000)
    expect(retryDelayMs(6)).toBe(300000)
    expect(retryDelayMs(10)).toBe(300000)
    expect(retryDelayMs(2, { baseMs: 5000 })).toBe(10000)
    expect(retryDelayMs(1, { baseMs: 10000, maxMs: 5000 })).toBe(5000)
  })
})

describe("save/load", () => {
  test("round-trips a record", async () => {
    let run = makeRun({ state: "idle", sessionID: "sess-1", configDigest: "digest-1" })
    run = startAttempt(run, { trigger: "prompt", prompt: "hello" })
    run = attemptTransition(run, "admitted", "admit")
    run = transition(run, "working", "prompt")
    await saveRun(dir, run)
    const back = await loadRun(dir, run.id)
    expect(back).toEqual(run)
    expect(back?.attempts[0].prompt).toBe("hello")
  })

  test("loadRun of a missing id returns undefined", async () => {
    expect(await loadRun(dir, "w-0000000000000000")).toBeUndefined()
  })

  test("saveRun emits run.created exactly once for a run written twice", async () => {
    const run = makeRun({ state: "created" })
    await saveRun(dir, run)
    await saveRun(dir, { ...run, lastUsed: new Date().toISOString() })
    const content = await readFile(join(dir, "audit.log"), "utf8")
    const created = content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.kind === "run.created" && line.run === run.id)
    expect(created.length).toBe(1)
    const v = await verify(dir)
    expect(v.ok).toBe(true)
  })
})

describe("bySession", () => {
  test("hits the run bound to a session and misses unknown sessions", async () => {
    const run = makeRun({ state: "idle", sessionID: "sess-1" })
    const other = makeRun({ state: "idle", sessionID: "sess-2" })
    await saveRun(dir, run)
    await saveRun(dir, other)
    expect((await bySession(dir, "sess-1"))?.id).toBe(run.id)
    expect((await bySession(dir, "sess-2"))?.id).toBe(other.id)
    expect(await bySession(dir, "sess-unknown")).toBeUndefined()
  })

  test("never throws on a missing or partial runs directory", async () => {
    expect(await bySession(join(dir, "missing"), "sess-1")).toBeUndefined()
    await mkdir(join(dir, "runs", "w-empty"), { recursive: true })
    await mkdir(join(dir, "runs", "w-corrupt"), { recursive: true })
    await writeFile(join(dir, "runs", "w-corrupt", "run.json"), "{nope")
    await writeFile(join(dir, "runs", "stray"), "x")
    expect(await bySession(dir, "sess-1")).toBeUndefined()
  })
})
