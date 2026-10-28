import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { createState } from "../../src/index.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { peek, put } from "../../src/teams/inbox.js"
import { gc, onSessionIdle, reconcile, childSettledText } from "../../src/teams/lifecycle.js"
import { Policy } from "../../src/teams/schema.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-lifecycle-"))
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp
  try {
    return await fn(path.join(tmp, "opencode", "opencodeplus", "teams"))
  } finally {
    if (prior === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prior
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-team-lifecycle",
    paths: [],
    branch: "team/implementer/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "team-lifecycle-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function callerFor(record: RunRecord): TeamCaller {
  return { sessionID: String(record.sessionID ?? "ses_unknown"), agent: record.role, run: record }
}

function sessionHarness(alive: ReadonlySet<string>) {
  const domain = {
    get: (input: { sessionID: unknown }) => {
      const id = String(input.sessionID)
      if (alive.has(id)) return Effect.succeed({ id })
      return Effect.fail(new Error(`unknown session ${id}`))
    },
    wait: () => Effect.succeed(undefined),
  } as unknown as SessionDomain
  return domain
}

function parentRun(id: string, sessionID: string): RunRecord {
  return baseRun({
    id,
    role: "opus-orchestrator",
    state: "idle",
    attempts: [],
    sessionID,
  })
}

function workingChild(id: string, parent: string, sessionID: string): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    role: "muse-implementer",
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    parent,
    task: "T1",
    sessionID,
  })
}

function startingChild(id: string, parent: string, sessionID: string): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    role: "muse-implementer",
    state: "starting",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    parent,
    task: "T2",
    sessionID,
  })
}

test.each(["superseded", "reaped", "dead", "missing"] as const)("reconcile stops and reaps children of a %s parent", async (state) => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = parentRun("main-orphan-parent", "ses_orphan_parent")
    const child = { ...workingChild("w-orphan-child", parent.id, "ses_orphan_child"), directory: path.join(root, "gone"), budget: { wallMs: 1 } }
    if (state !== "missing") await saveRun(root, { ...parent, state })
    await saveRun(root, child)
    const pending = await put(root, child.id, { kind: "followup", from: parent.id, text: "must not restart this orphan" })
    const interrupted: string[] = []
    const ctx = context({ session: {
      ...sessionHarness(new Set([child.sessionID!])),
      interrupt: (input) => Effect.promise(async () => {
        interrupted.push(input.sessionID)
        // The real host may deliver the execution's end before interrupt returns.
        await onSessionIdle(ctx, root, child, "interrupted")
        return { interrupted: true }
      }),
    } })
    await reconcile(ctx, root)
    expect(interrupted).toEqual([child.sessionID!])
    expect((await loadRun(root, child.id))?.state).toBe("stopped")
    expect((await loadRun(root, child.id))?.attempts.at(-1)?.state).toBe("interrupted")
    expect(await peek(root, parent.id)).toEqual([])
    expect(await peek(root, child.id)).toEqual([pending])
    await reconcile(ctx, root)
    expect(interrupted).toHaveLength(1)
    const result = await gc(root, Schema.decodeUnknownSync(Policy)({ gc: { reapAfter: "0ms" } }))
    expect(result.reaped).toContain(child.id)
    expect((await loadRun(root, child.id))?.state).toBe("reaped")
  })
})

test("an orphan is not reapable until its running session has been interrupted", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = { ...parentRun("main-reaped", "ses_reaped"), state: "reaped" as const }
    const child = workingChild("w-running", parent.id, "ses_running")
    await saveRun(root, parent)
    await saveRun(root, child)
    const session = sessionHarness(new Set([child.sessionID!]))
    await reconcile(context({ session: { ...session, interrupt: () => Effect.die("interrupt unavailable") } }), root)
    expect((await loadRun(root, child.id))?.state).toBe("stopping")
    expect((await loadRun(root, child.id))?.attempts.at(-1)?.state).toBe("streaming")
    await reconcile(context({ session: { ...session, interrupt: () => Effect.succeed({ interrupted: true }) } }), root)
    expect((await loadRun(root, child.id))?.state).toBe("stopped")
    expect((await loadRun(root, child.id))?.attempts.at(-1)?.state).toBe("interrupted")
  })
})

test.each(["working", "idle", "starting", "blocked_input", "dead"] as const)("an orphan in %s becomes reapable even without a live session", async (state) => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = { ...parentRun("main-gone", "ses_gone_parent"), state: "reaped" as const }
    const child = { ...workingChild("w-orphan", parent.id, "ses_gone_child"), state }
    await saveRun(root, parent)
    await saveRun(root, child)
    await reconcile(context({ session: sessionHarness(new Set()) }), root)
    expect((await loadRun(root, child.id))?.state).toBe("stopped")
    expect((await loadRun(root, child.id))?.attempts.at(-1)?.state).toBe("interrupted")
    expect(await peek(root, parent.id)).toEqual([])
  })
})

test.each(["superseded", "reaped", "dead"] as const)("a child's settlement sends no notice to a %s parent", async (state) => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = { ...parentRun("main-terminal", "ses_terminal_parent"), state }
    const child = workingChild("w-settled", parent.id, "ses_settled_child")
    await saveRun(root, parent)
    await saveRun(root, child)
    await onSessionIdle(context(), root, child, "failed")
    expect((await loadRun(root, child.id))?.attempts.at(-1)?.state).toBe("failed")
    expect(await peek(root, parent.id)).toEqual([])
  })
})

test("reconcile marks a working run with a missing session dead", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = parentRun("main-0123456789abcdef", "ses_parent_alive_1")
    const child = workingChild("w-aaaaaaaaaaaaaaaa", parent.id, "ses_gone_001")
    await saveRun(root, parent)
    await saveRun(root, child)
    const ids = await reconcile(context({ session: sessionHarness(new Set(["ses_parent_alive_1"])) }), root)
    expect(ids).toEqual(["w-aaaaaaaaaaaaaaaa"])
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("dead")
    expect(moved?.attempts[moved.attempts.length - 1]?.state).toBe("failed")
  })
})

test("reconcile marks a starting run dead the same way", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = parentRun("main-0123456789abcdef", "ses_parent_alive_2")
    const child = startingChild("w-bbbbbbbbbbbbbbbb", parent.id, "ses_gone_002")
    await saveRun(root, parent)
    await saveRun(root, child)
    const ids = await reconcile(context({ session: sessionHarness(new Set(["ses_parent_alive_2"])) }), root)
    expect(ids).toEqual(["w-bbbbbbbbbbbbbbbb"])
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("dead")
    expect(moved?.attempts[moved.attempts.length - 1]?.state).toBe("failed")
  })
})

test("reconcile leaves a run whose session still resolves alone", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = parentRun("main-0123456789abcdef", "ses_parent_alive_3")
    const child = workingChild("w-cccccccccccccccc", parent.id, "ses_alive_003")
    await saveRun(root, parent)
    await saveRun(root, child)
    const ids = await reconcile(
      context({ session: sessionHarness(new Set(["ses_parent_alive_3", "ses_alive_003"])) }),
      root,
    )
    expect(ids).toEqual([])
    const kept = await loadRun(root, child.id)
    expect(kept?.state).toBe("working")
    expect(kept?.attempts[kept.attempts.length - 1]?.state).toBe("streaming")
  })
})

test("reconcile leaves a superseded run and a null-session run alone", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = parentRun("main-0123456789abcdef", "ses_parent_alive_4")
    const now = new Date().toISOString()
    const superseded = baseRun({
      id: "w-dddddddddddddddd",
      role: "muse-implementer",
      state: "superseded",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      parent: parent.id,
      sessionID: "ses_gone_004",
    })
    const nullSession = baseRun({
      id: "w-eeeeeeeeeeeeeeee",
      role: "muse-implementer",
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      parent: parent.id,
      sessionID: null,
    })
    await saveRun(root, parent)
    await saveRun(root, superseded)
    await saveRun(root, nullSession)
    const ids = await reconcile(context({ session: sessionHarness(new Set(["ses_parent_alive_4"])) }), root)
    expect(ids).toEqual([])
    expect((await loadRun(root, superseded.id))?.state).toBe("superseded")
    expect((await loadRun(root, nullSession.id))?.state).toBe("working")
  })
})

test("reconcile with one garbage run directory still processes the healthy ones", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = parentRun("main-0123456789abcdef", "ses_parent_alive_5")
    const child = workingChild("w-ffffffffffffffff", parent.id, "ses_gone_005")
    await saveRun(root, parent)
    await saveRun(root, child)
    await fs.mkdir(path.join(root, "runs", "w-0000000000000000"), { recursive: true })
    await fs.writeFile(path.join(root, "runs", "w-0000000000000000", "run.json"), "{ not json\n")
    const ids = await reconcile(context({ session: sessionHarness(new Set(["ses_parent_alive_5"])) }), root)
    expect(ids).toEqual(["w-ffffffffffffffff"])
    expect((await loadRun(root, child.id))?.state).toBe("dead")
  })
})

test("the parent inbox got exactly one settled failed notify line", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = parentRun("main-0123456789abcdef", "ses_parent_alive_7")
    const child = workingChild("w-2222222222222222", parent.id, "ses_gone_007")
    await saveRun(root, parent)
    await saveRun(root, child)
    const ids = await reconcile(context({ session: sessionHarness(new Set(["ses_parent_alive_7"])) }), root)
    expect(ids).toEqual(["w-2222222222222222"])
    const items = await peek(root, parent.id)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("notify")
    expect(items[0]?.text).toContain("settled: failed")
    expect(items[0]?.text).toContain("next: team_stop + delegate fresh")
  })
})

test("a settlement names at most 50 uncommitted files and counts the rest", () => {
  const child = workingChild("w-3333333333333333", "main-0123456789abcdef", "ses_settle_dirty")
  const attempt = child.attempts[0]!
  const files = Array.from({ length: 60 }, (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`)
  const lines = childSettledText(child, attempt, { status: "done_with_concerns", summary: "Bulk import adds files.", dirtyFiles: files }).split("\n")
  const uncommitted = lines.filter((line) => line.startsWith("Uncommitted:"))
  expect(uncommitted).toHaveLength(1)
  expect(uncommitted[0]?.startsWith(`Uncommitted: ${files.slice(0, 50).join(", ")} and 10 more`)).toBe(true)
  expect(uncommitted[0]).not.toContain("src/file-50.ts")
})

test("a failed attempt that was retried says how many times, for how long, and from when", () => {
  const child = workingChild("w-3333333333333334", "main-0123456789abcdef", "ses_settle_retried")
  const attempt = {
    ...child.attempts[0]!,
    state: "failed" as const,
    endedAt: "2026-10-28T10:05:40.000Z",
    error: { type: "provider.internal", message: "An unexpected error occurred.", status: 500 },
    retries: {
      firstAt: "2026-10-28T10:00:00.000Z",
      count: 5,
      error: { type: "provider.internal", message: "An unexpected error occurred.", status: 500 },
    },
  }
  const lines = childSettledText({ ...child, attempts: [attempt] }, attempt, undefined).split("\n")
  expect(lines).toContain("Error: provider.internal (500): An unexpected error occurred.")
  expect(lines).toContain("The host retried it 5 times over 5 min 40 s (from 10:00 UTC) before the step failed.")
  expect(lines.at(-1)).toStartWith("next:")
})

test("a recovered attempt that was retried says so once, before next:", () => {
  const child = workingChild("w-3333333333333335", "main-0123456789abcdef", "ses_settle_recovered")
  const attempt = {
    ...child.attempts[0]!,
    state: "reported" as const,
    endedAt: "2026-10-28T10:00:48.000Z",
    retries: {
      firstAt: "2026-10-28T10:00:00.000Z",
      count: 3,
      error: { type: "provider.internal", message: "Service overloaded", status: 529 },
    },
  }
  const lines = childSettledText({ ...child, attempts: [attempt] }, attempt, { status: "done", summary: "Landed." }).split("\n")
  const retried = lines.filter((line) => line.startsWith("Provider errors:"))
  expect(retried).toEqual([
    "Provider errors: the host retried 3 times over 48 s (last: provider.internal (529)); the run then continued.",
  ])
  expect(lines.indexOf(retried[0]!)).toBe(lines.findIndex((line) => line.startsWith("next:")) - 1)
})

test("reconcile skips valid-JSON malformed runs and still settles later healthy runs", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = parentRun("main-0123456789abcdef", "ses_parent_alive_8")
    await saveRun(root, parent)
    const badID = "w-aaaaaaaaaaaaaaaa"
    const badBase = workingChild(badID, parent.id, "ses_gone_bad_8")
    await fs.mkdir(path.join(root, "runs", badID), { recursive: true })
    await fs.writeFile(path.join(root, "runs", badID, "run.json"), JSON.stringify({ ...badBase, attempts: [null] }))
    const good = workingChild("w-bbbbbbbbbbbbbbbb", parent.id, "ses_gone_008")
    await saveRun(root, good)
    const ids = await reconcile(context({ session: sessionHarness(new Set(["ses_parent_alive_8"])) }), root)
    expect(ids).toEqual(["w-bbbbbbbbbbbbbbbb"])
    const moved = await loadRun(root, good.id)
    expect(moved?.state).toBe("dead")
    expect(moved?.attempts[moved.attempts.length - 1]?.state).toBe("failed")
    const raw = await fs.readFile(path.join(root, "runs", badID, "run.json"), "utf8")
    expect(JSON.parse(raw).attempts).toEqual([null])
  })
})
