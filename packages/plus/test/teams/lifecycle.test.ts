import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { createState } from "../../src/index.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { peek } from "../../src/teams/inbox.js"
import { reconcile } from "../../src/teams/lifecycle.js"
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

test("team_wait reports a gone session as settled failed with report null", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = parentRun("main-0123456789abcdef", "ses_parent_alive_6")
    const child = workingChild("w-1111111111111111", parent.id, "ses_gone_006")
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(
      context({ session: sessionHarness(new Set(["ses_parent_alive_6"])) }),
      createState(),
    )
    const result = await api.wait({ runs: [child.id], timeoutMs: 10000 }, callerFor(parent))
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
    const value = result.value as {
      settled: Array<{ run: string; attemptState: string; report: { status: string; summary: string; path: string } | null }>
      timedOut: boolean
      stillOpen: string[]
    }
    expect(value.timedOut).toBe(false)
    expect(value.settled).toHaveLength(1)
    expect(value.settled[0]?.run).toBe(child.id)
    expect(value.settled[0]?.attemptState).toBe("failed")
    expect(value.settled[0]?.report).toBeNull()
  })
}, 30000)

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
    expect(items[0]?.text).toContain("next: supersede + delegate fresh")
  })
})
