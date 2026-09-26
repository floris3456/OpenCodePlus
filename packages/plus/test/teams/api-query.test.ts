import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listHandler } from "../../src/teams/api-query.js"
import { shippedTable, teamState } from "./preset-table.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { context } from "../harness.js"
import { Effect } from "effect"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { TokenUsage } from "@opencode/schema/token-usage"
import { git } from "../../src/teams/git.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { atomicJson } from "../../src/teams/store.js"

// Real temp git repositories where a real HEAD matters, a real temp
// XDG_DATA_HOME state root, real RunRecords written with saveRun. No mocks
// of our own code.
async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-query-"))
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

async function makeRepo(): Promise<{ dir: string; head: string }> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-query-repo-"))
  await git(dir, ["init"])
  await git(dir, ["config", "user.name", "team-test"])
  await git(dir, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# team query test\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { dir, head }
}

async function removeRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-team-query",
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
    bundle: "team-query-test",
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

function required<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

type ListEntry = {
  run: string
  role: string
  state: string
  task: string | null
  parent: string | null
  head: string
  branch: string
  directory: string
  worktree: string
  reportStatus: string | null
  lastUsed: string
  runtime: string
}

async function seedFamily(root: string, repoDir: string): Promise<Record<string, RunRecord>> {
  const parent = baseRun({
    id: "main-0123456789abcdef",
    role: "opus-orchestrator",
    directory: repoDir,
    sessionID: "ses_parent_001",
    state: "working",
    lastUsed: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
  })
  const childA = baseRun({
    id: "w-aaaaaaaaaaaaaaaa",
    directory: repoDir,
    parent: parent.id,
    sessionID: "ses_child_a",
    state: "working",
    lastUsed: "2026-09-02T00:00:00.000Z",
    createdAt: "2026-09-02T00:00:00.000Z",
  })
  const childB = baseRun({
    id: "w-bbbbbbbbbbbbbbbb",
    role: "gemini-implementer",
    directory: repoDir,
    parent: parent.id,
    sessionID: "ses_child_b",
    state: "idle",
    lastUsed: "2026-09-03T00:00:00.000Z",
    createdAt: "2026-09-03T00:00:00.000Z",
  })
  const grandchild = baseRun({
    id: "w-cccccccccccccccc",
    directory: repoDir,
    parent: childA.id,
    state: "idle",
    lastUsed: "2026-09-04T00:00:00.000Z",
    createdAt: "2026-09-04T00:00:00.000Z",
  })
  const unrelated = baseRun({
    id: "w-dddddddddddddddd",
    directory: repoDir,
    state: "idle",
    lastUsed: "2026-09-05T00:00:00.000Z",
    createdAt: "2026-09-05T00:00:00.000Z",
  })
  await saveRun(root, { ...parent, children: [childA.id, childB.id] })
  await saveRun(root, { ...childA, children: [grandchild.id] })
  await saveRun(root, childB)
  await saveRun(root, grandchild)
  await saveRun(root, unrelated)
  const stored = await loadRun(root, parent.id)
  if (stored === undefined) throw new Error("missing parent run")
  return { parent: stored, childA, childB, grandchild, unrelated }
}

test("an orchestrator sees its own run plus direct children only", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const family = await seedFamily(root, repo.dir)
      const value = required(await listHandler({}, callerFor(family.parent), shippedTable())) as ListEntry[]
      expect(value.map((entry) => entry.run).toSorted()).toEqual(
        [family.parent.id, family.childA.id, family.childB.id].toSorted(),
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("status and wait use Session-cumulative tokens and honestly count attempts", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const family = await seedFamily(root, repo.dir)
      const run = { ...family.childA, state: "idle" as const, budget: { tokens: 1 }, attempts: [{ n: 1, state: "no_report" as const, trigger: "delegate", startedAt: new Date().toISOString() }] }
      await saveRun(root, run)
      const tokens = { input: 101, output: 7, reasoning: 9, cache: { read: 11, write: 13 } }
      const ctx = context({ session: { ...context().session, get: () => Effect.succeed({ tokens }) } as unknown as SessionDomain })
      const api = createTeamApi(ctx, teamState())
      const status = required(await api.status({ runs: [run.id] }, callerFor(family.parent))) as Array<{ budget: Record<string, unknown> }>
      expect(status[0]?.budget).toMatchObject({ attemptsUsed: 1, turnsUsed: 1, tokensUsed: TokenUsage.total(tokens), usageBasis: "Session-cumulative", exhausted: true })
      expect(required(await api.wait({ runs: [run.id], timeoutMs: 10000, ack: false }, callerFor(family.parent)))).toMatchObject({ overBudget: [run.id] })
      const unavailable = createTeamApi(context(), teamState())
      expect(required(await unavailable.status({ runs: [run.id] }, callerFor(family.parent)))).toMatchObject([{ budget: { tokensUsed: null, exhausted: false } }])
    } finally { await removeRepo(repo.dir) }
  })
})

test("removed worktree diff uses retained commits, not the surviving parent's dirty tree", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await git(repo.dir, ["branch", "retained-child"])
      const parent = baseRun({ id: "main-history", role: "opus-orchestrator", directory: repo.dir, kind: "main" })
      await fs.writeFile(path.join(repo.dir, "README.md"), "committed child change\n")
      await git(repo.dir, ["add", "README.md"])
      await git(repo.dir, ["commit", "-m", "fix: child change"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      const child = baseRun({ id: "w-history", parent: parent.id, worktree: "removed", directory: path.join(root, "removed"), branch: "retained-child", base: repo.head, head, gitCommonDir: await fs.realpath(await git(repo.dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) })
      await saveRun(root, parent)
      await saveRun(root, child)
      await fs.writeFile(path.join(repo.dir, "README.md"), "unrelated parent dirt\n")
      const api = createTeamApi(context(), teamState())
      const diff = required(await api.diff({ run: child.id }, callerFor(parent))) as { patch: string; head: string }
      expect(diff.head).toBe(head)
      expect(diff.patch).toContain("+committed child change")
      expect(diff.patch).not.toContain("parent dirt")
      expect(required(await api.diff({ run: child.id, maxBytes: 10 }, callerFor(parent)))).toMatchObject({ truncated: true })
    } finally { await removeRepo(repo.dir) }
  })
})

test("a planner sees every run in the namespace", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const family = await seedFamily(root, repo.dir)
      const planner = baseRun({
        id: "main-ffffffffffffffff",
        role: "fable-planner",
        kind: "main",
        directory: repo.dir,
        sessionID: "ses_planner_001",
        state: "working",
        lastUsed: "2026-09-06T00:00:00.000Z",
        createdAt: "2026-09-06T00:00:00.000Z",
      })
      await saveRun(root, planner)
      const value = required(await listHandler({}, callerFor(planner), shippedTable())) as ListEntry[]
      expect(value.map((entry) => entry.run).toSorted()).toEqual(
        [family.parent.id, family.childA.id, family.childB.id, family.grandchild.id, family.unrelated.id, planner.id].toSorted(),
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("all:false hides superseded and reaped, all:true shows them", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const planner = baseRun({
        id: "main-ffffffffffffffff",
        role: "fable-planner",
        kind: "main",
        directory: repo.dir,
        sessionID: "ses_planner_002",
        state: "working",
      })
      const gone = baseRun({ id: "w-eeeeeeeeeeeeeeee", directory: repo.dir, state: "superseded" })
      const reaped = baseRun({ id: "w-ffffffffffffffff", directory: repo.dir, state: "reaped" })
      await saveRun(root, planner)
      await saveRun(root, gone)
      await saveRun(root, reaped)
      const omitted = required(await listHandler({}, callerFor(planner), shippedTable())) as ListEntry[]
      expect(omitted.map((entry) => entry.run).toSorted()).toEqual([planner.id])
      const hidden = required(await listHandler({ all: false }, callerFor(planner), shippedTable())) as ListEntry[]
      expect(hidden.map((entry) => entry.run).toSorted()).toEqual([planner.id])
      const shown = required(await listHandler({ all: true }, callerFor(planner), shippedTable())) as ListEntry[]
      expect(shown.map((entry) => entry.run).toSorted()).toEqual([gone.id, reaped.id, planner.id].toSorted())
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("role, state and parent filters each narrow the list", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const family = await seedFamily(root, repo.dir)
      const planner = baseRun({
        id: "main-ffffffffffffffff",
        role: "fable-planner",
        kind: "main",
        directory: repo.dir,
        sessionID: "ses_planner_003",
        state: "working",
      })
      await saveRun(root, planner)
      const byRole = required(await listHandler({ role: "gemini-implementer" }, callerFor(planner), shippedTable())) as ListEntry[]
      expect(byRole.map((entry) => entry.run)).toEqual([family.childB.id])
      const byState = required(await listHandler({ state: "working" }, callerFor(planner), shippedTable())) as ListEntry[]
      expect(byState.map((entry) => entry.run).toSorted()).toEqual([family.parent.id, family.childA.id, planner.id].toSorted())
      const byParent = required(await listHandler({ parent: family.parent.id }, callerFor(planner), shippedTable())) as ListEntry[]
      expect(byParent.map((entry) => entry.run).toSorted()).toEqual([family.childA.id, family.childB.id].toSorted())
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("every emitted field is present and correct for a populated run", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const stored = baseRun({
        id: "w-aaaaaaaaaaaaaaaa",
        role: "muse-implementer",
        directory: repo.dir,
        branch: "team/w/populated",
        head: repo.head,
        state: "working",
        task: "T12",
        parent: "main-0123456789abcdef",
        sessionID: "ses_child_pop",
        lastUsed: "2026-09-10T12:00:00.000Z",
        createdAt: "2026-09-10T00:00:00.000Z",
      })
      await saveRun(root, stored)
      await fs.writeFile(path.join(repo.dir, "notes.md"), "# notes\n")
      await git(repo.dir, ["add", "notes.md"])
      await git(repo.dir, ["commit", "-m", "docs: add notes"])
      const live = await git(repo.dir, ["rev-parse", "HEAD"])
      expect(live).not.toBe(repo.head)
      await atomicJson(path.join(root, "runs", stored.id, "report-1.json"), { status: "blocked", summary: "stuck" })
      await atomicJson(path.join(root, "runs", stored.id, "report-2.json"), { status: "done", summary: "finished" })
      const value = required(await listHandler({ all: true }, callerFor(stored), shippedTable())) as ListEntry[]
      expect(value).toEqual([
        {
          run: stored.id,
          role: "muse-implementer",
          state: "working",
          task: "T12",
          parent: "main-0123456789abcdef",
          head: live,
          branch: "team/w/populated",
          directory: repo.dir,
          worktree: "present",
          reportStatus: "done",
          lastUsed: "2026-09-10T12:00:00.000Z",
          runtime: "running",
        },
      ])
      const missing = baseRun({ id: "w-bbbbbbbbbbbbbbbb", directory: "/tmp/wt-team-query-gone", state: "stopped" })
      await saveRun(root, missing)
      const shown = required(await listHandler({ all: true }, callerFor(missing), shippedTable())) as ListEntry[]
      const gone = shown.find((entry) => entry.run === missing.id)
      expect(gone?.head).toBe(missing.head)
      expect(gone?.reportStatus).toBeNull()
      expect(gone?.runtime).toBe("stopped")
      const pending = baseRun({ id: "w-cccccccccccccccc", directory: "/tmp/wt-team-query-gone", state: "idle" })
      await saveRun(root, pending)
      const planner = baseRun({
        id: "main-ffffffffffffffff",
        role: "fable-planner",
        kind: "main",
        directory: repo.dir,
        sessionID: "ses_planner_pop",
        state: "working",
      })
      await saveRun(root, planner)
      const pendingEntry = (required(await listHandler({ all: true }, callerFor(planner), shippedTable())) as ListEntry[]).find(
        (entry) => entry.run === pending.id,
      )
      expect(pendingEntry?.runtime).toBe("pending")
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("the result is sorted by lastUsed descending then run id", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const planner = baseRun({
        id: "main-ffffffffffffffff",
        role: "fable-planner",
        kind: "main",
        directory: repo.dir,
        sessionID: "ses_planner_004",
        state: "working",
        lastUsed: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      const first = baseRun({ id: "w-1111111111111111", directory: repo.dir, lastUsed: "2026-05-01T00:00:00.000Z" })
      const second = baseRun({ id: "w-2222222222222222", directory: repo.dir, lastUsed: "2026-05-01T00:00:00.000Z" })
      const newest = baseRun({ id: "w-3333333333333333", directory: repo.dir, lastUsed: "2026-08-01T00:00:00.000Z" })
      await saveRun(root, planner)
      await saveRun(root, first)
      await saveRun(root, second)
      await saveRun(root, newest)
      const value = required(await listHandler({}, callerFor(planner), shippedTable())) as ListEntry[]
      expect(value.map((entry) => entry.run)).toEqual([newest.id, first.id, second.id, planner.id])
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("calling list does not modify any run.json", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const family = await seedFamily(root, repo.dir)
      const ids = [family.parent.id, family.childA.id, family.childB.id, family.grandchild.id, family.unrelated.id]
      const snapshots: Array<{ id: string; bytes: string }> = []
      for (const id of ids) snapshots.push({ id, bytes: await fs.readFile(path.join(root, "runs", id, "run.json"), "utf8") })
      await listHandler({}, callerFor(family.parent), shippedTable())
      await listHandler({ all: true }, callerFor(family.parent), shippedTable())
      for (const snapshot of snapshots) {
        expect(await fs.readFile(path.join(root, "runs", snapshot.id, "run.json"), "utf8")).toBe(snapshot.bytes)
      }
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("list and statusOf reflect worktree states (present, removed, dirty)", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const planner = baseRun({
        id: "main-ffffffffffffffff",
        role: "fable-planner",
        kind: "main",
        directory: repo.dir,
        sessionID: "ses_planner_wt",
        state: "working",
        worktree: "present",
      })
      const removed = baseRun({
        id: "w-1111111111111111",
        directory: repo.dir,
        state: "reaped",
        worktree: "removed",
      })
      const dirty = baseRun({
        id: "w-2222222222222222",
        directory: repo.dir,
        state: "stopped",
        worktree: "dirty",
      })
      await saveRun(root, planner)
      await saveRun(root, removed)
      await saveRun(root, dirty)

      const list = required(await listHandler({ all: true }, callerFor(planner), shippedTable())) as ListEntry[]
      const plannerEntry = list.find((e) => e.run === planner.id)
      const removedEntry = list.find((e) => e.run === removed.id)
      const dirtyEntry = list.find((e) => e.run === dirty.id)

      expect(plannerEntry?.worktree).toBe("present")
      expect(removedEntry?.worktree).toBe("removed")
      expect(dirtyEntry?.worktree).toBe("dirty")
    } finally {
      await removeRepo(repo.dir)
    }
  })
})
