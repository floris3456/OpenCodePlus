import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { integrateHandler } from "../../src/teams/api-integrate.js"
import type { TeamCaller } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { gc, sweep } from "../../src/teams/lifecycle.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Policy } from "../../src/teams/schema.js"
import { atomicJson, lock } from "../../src/teams/store.js"
import { create, mergeArea, ownedRoot, slug } from "../../src/teams/worktree.js"

const defaultPolicy = Schema.decodeUnknownSync(Policy)({})

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-gc-"))
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

async function makeRepo(): Promise<{ scratch: string; dir: string; head: string }> {
  const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-gc-repo-"))
  const dir = path.join(scratch, "repo")
  await git(scratch, ["init", "-b", "main", "repo"])
  await git(dir, ["config", "user.name", "team-test"])
  await git(dir, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# gc test repo\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { scratch, dir, head }
}

async function makeChildWorktree(
  scratch: string,
  repoDir: string,
  name: string,
  base: string,
  files?: Record<string, string>,
  message?: string,
): Promise<{ dir: string; branch: string; head: string }> {
  const dir = path.join(scratch, `child-${name}`)
  const branch = `team/w/child-${name}`
  await git(repoDir, ["worktree", "add", "-b", branch, dir, base])
  if (files !== undefined) {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(dir, rel)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content)
    }
  }
  if (message !== undefined) {
    await git(dir, ["add", "-A"])
    await git(dir, ["commit", "-m", message])
  }
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { dir, branch, head }
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-team-gc",
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
    bundle: "team-gc-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    worktree: "present",
    ...overrides,
  }
}

function callerFor(record: RunRecord): TeamCaller {
  return { sessionID: String(record.sessionID ?? "ses_unknown"), agent: record.role, run: record }
}

function dummyContext() {
  const domain = {
    get: () => Effect.succeed({ id: Session.ID.make("ses_dummy") }),
    wait: () => Effect.succeed(undefined),
  } as unknown as SessionDomain
  return context({ session: domain })
}

async function dirExists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false)
}

test("landed child worktree is removed on landing; branch ref and records remain", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parentHead = repo.head
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: parentHead,
        head: parentHead,
        state: "working",
        sessionID: "ses_parent_001",
        children: ["w-aaaaaaaaaaaaaaaa"],
      })
      const childWork = await makeChildWorktree(
        repo.scratch,
        repo.dir,
        "landing",
        parentHead,
        { "child.txt": "landing work\n" },
        "feat: landed child",
      )
      const now = new Date().toISOString()
      const child = baseRun({
        id: "w-aaaaaaaaaaaaaaaa",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: parentHead,
        head: childWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_001",
        worktree: "present",
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await atomicJson(path.join(root, "runs", child.id, "report-1.json"), {
        status: "done",
        summary: "child finished",
      })

      const res = await integrateHandler(
        dummyContext(),
        { run: child.id, expectedParentHead: parentHead },
        callerFor(parent),
      )
      expect(res.ok).toBe(true)

      // Expected end state 16:
      // 1. child worktree directory is removed
      expect(await dirExists(childWork.dir)).toBe(false)
      // 2. branch ref remains in git
      const branchCommit = await git(repo.dir, ["rev-parse", childWork.branch])
      expect(branchCommit).toBe(childWork.head)
      // 3. run record remains with worktree = "removed"
      const storedChild = await loadRun(root, child.id)
      expect(storedChild?.id).toBe(child.id)
      expect(storedChild?.worktree).toBe("removed")
      // 4. report remains
      const report = await fs.readFile(path.join(root, "runs", child.id, "report-1.json"), "utf8")
      expect(report).toContain("child finished")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("stale stopped run older than gc.reapAfter is reaped and worktree removed", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      const childWork = await makeChildWorktree(repo.scratch, repo.dir, "stopped-clean", repo.head)
      const staleDate = "2020-01-01T00:00:00.000Z"
      const child = baseRun({
        id: "w-bbbbbbbbbbbbbbbb",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: repo.head,
        head: childWork.head,
        state: "stopped",
        lastUsed: staleDate,
        worktree: "present",
      })
      await saveRun(root, parent)
      await saveRun(root, child)

      expect(await dirExists(childWork.dir)).toBe(true)

      const res = await gc(root, defaultPolicy)
      expect(res.reaped).toContain(child.id)
      expect(res.skippedDirty).not.toContain(child.id)

      // Worktree removed
      expect(await dirExists(childWork.dir)).toBe(false)
      // Branch ref remains
      expect(await git(repo.dir, ["rev-parse", childWork.branch])).toBe(childWork.head)
      // Run transitioned to reaped with worktree = "removed"
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("reaped")
      expect(stored?.worktree).toBe("removed")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("dirty stopped worktree is skipped by GC and visible as worktree: dirty", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      const childWork = await makeChildWorktree(
        repo.scratch,
        repo.dir,
        "stopped-dirty",
        repo.head,
        { "file.txt": "initial\n" },
        "feat: child work",
      )
      // Add dirty uncommitted tracked modification
      await fs.writeFile(path.join(childWork.dir, "file.txt"), "uncommitted modification\n")

      const staleDate = "2020-01-01T00:00:00.000Z"
      const child = baseRun({
        id: "w-cccccccccccccccc",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: repo.head,
        head: childWork.head,
        state: "stopped",
        lastUsed: staleDate,
        worktree: "present",
      })
      await saveRun(root, parent)
      await saveRun(root, child)

      const res = await gc(root, defaultPolicy)
      // D9: a dirty stopped worktree is skipped and shown as worktree: "dirty"
      expect(res.reaped).not.toContain(child.id)
      expect(res.skippedDirty).toContain(child.id)

      // Worktree is NOT removed
      expect(await dirExists(childWork.dir)).toBe(true)

      // Record remains stopped and worktree is dirty
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("stopped")
      expect(stored?.worktree).toBe("dirty")

      // Now commit the modification so it's clean
      await git(childWork.dir, ["add", "file.txt"])
      await git(childWork.dir, ["commit", "-m", "chore: clean modifications"])

      // Second GC run now reaps it
      const res2 = await gc(root, defaultPolicy)
      expect(res2.reaped).toContain(child.id)
      expect(await dirExists(childWork.dir)).toBe(false)
      const reaped = await loadRun(root, child.id)
      expect(reaped?.state).toBe("reaped")
      expect(reaped?.worktree).toBe("removed")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("stale superseded run with dirty worktree is reaped with --force", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      const childWork = await makeChildWorktree(
        repo.scratch,
        repo.dir,
        "superseded-dirty",
        repo.head,
        { "file.txt": "initial\n" },
        "feat: child work",
      )
      // Uncommitted tracked modifications
      await fs.writeFile(path.join(childWork.dir, "file.txt"), "dirty stuff\n")

      const staleDate = "2020-01-01T00:00:00.000Z"
      const child = baseRun({
        id: "w-dddddddddddddddd",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: repo.head,
        head: childWork.head,
        state: "superseded",
        lastUsed: staleDate,
        worktree: "present",
      })
      await saveRun(root, parent)
      await saveRun(root, child)

      // D9: GC uses --force only for superseded
      const res = await gc(root, defaultPolicy)
      expect(res.reaped).toContain(child.id)
      expect(await dirExists(childWork.dir)).toBe(false)
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("reaped")
      expect(stored?.worktree).toBe("removed")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

// The soak's class-A failure: `team_delegate` returned the worktree directory
// and the host's `FileSystem.realPath` then failed ENOENT because the periodic
// sweep had force-removed it as an orphan. The sweep judged orphans from the
// run records it read before its slow steps, so a worktree created after that
// read was unclaimed even while `delegate` was still registering its run. This
// test holds the new run's state lock, so its `saveRun` cannot land while gc
// runs: gc reads its records without the run, exactly the interleaving the
// soak hit. `delegateHandler`'s order is `worktree.create` then `saveRun`.
test("gc never removes a worktree whose run record is being written", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    const childID = "w-1234567890abcdef"
    let releaseLock: (() => void) | undefined
    let holdingLock: Promise<void> | undefined
    let writing: Promise<void> | undefined
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
        sessionID: "ses_parent_provisioning",
      })
      await saveRun(root, parent)

      // What delegateHandler does first: create the worktree...
      const created = await create(root, {
        repoRoot: repo.dir,
        repoKey: parent.repoKey,
        role: "implementer",
        name: slug("prov", childID),
        base: repo.head,
        workspaceRoot: root,
      })

      // ...and only then register the run. Holding the record's state lock is
      // the deterministic form of that window: the record cannot reach disk.
      let holding = false
      const held = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      holdingLock = lock(root, "state", childID, async () => {
        holding = true
        await held
      })
      for (let i = 0; i < 1000 && !holding; i++) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(holding).toBe(true)

      writing = saveRun(
        root,
        baseRun({
          id: childID,
          role: "muse-implementer",
          directory: created.dir,
          branch: created.branch,
          base: repo.head,
          head: created.head,
          state: "starting",
          attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
          parent: parent.id,
          sessionID: null,
          projectDirectory: repo.dir,
        }),
      )

      const res = await gc(root, defaultPolicy)

      // The host resolves exactly this directory when it creates the child
      // session. Before the fix this threw the soak's verbatim failure,
      // `NotFound: FileSystem.realPath (<worktree dir>)`, because gc had
      // force-removed the fresh worktree as an orphan.
      expect(await fs.realpath(created.dir)).toBe(created.dir)
      expect(await dirExists(created.dir)).toBe(true)
      expect(res.orphansRemoved).not.toContain(created.dir)

      releaseLock?.()
      await holdingLock
      await writing
      const stored = await loadRun(root, childID)
      expect(stored?.directory).toBe(created.dir)
      expect(stored?.worktree).toBe("present")
    } finally {
      releaseLock?.()
      await holdingLock?.catch(() => undefined)
      await writing?.catch(() => undefined)
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)

test("orphan worktree unclaimed by any run is removed by GC", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      await saveRun(root, parent)

      // An orphan is a worktree inside the team's own area for this repo key
      // that no run claims; create one directly in git.
      const orphanDir = path.join(ownedRoot(root, parent.repoKey), "implementer", "orphan-wt")
      const orphanBranch = "team/orphan/test-1"
      await git(repo.dir, ["worktree", "add", "-b", orphanBranch, orphanDir, repo.head])
      expect(await dirExists(orphanDir)).toBe(true)

      // A developer's own checkout of the same repository, outside that area.
      const outside = path.join(repo.scratch, "dev-checkout")
      await git(repo.dir, ["worktree", "add", "-b", "dev/own-work", outside, repo.head])
      await fs.writeFile(path.join(outside, "uncommitted.txt"), "work in progress\n")

      const res = await gc(root, defaultPolicy)
      expect(res.orphansRemoved).toContain(orphanDir)
      expect(await dirExists(orphanDir)).toBe(false)
      // The sweep never reaches outside the team's own worktree area.
      expect(res.orphansRemoved).not.toContain(outside)
      expect(await Bun.file(path.join(outside, "uncommitted.txt")).text()).toBe("work in progress\n")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("merge worktree in merge area survives GC while real orphan is removed", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      await saveRun(root, parent)

      // A merge worktree in the merge area, unclaimed by any run record
      // (simulating a live merge in flight).
      const mergeDir = path.join(mergeArea(ownedRoot(root, parent.repoKey)), "temp-merge-wt")
      await git(repo.dir, ["worktree", "add", "--detach", mergeDir, repo.head])
      expect(await dirExists(mergeDir)).toBe(true)

      // A real orphan elsewhere under the owned root
      const orphanDir = path.join(ownedRoot(root, parent.repoKey), "implementer", "orphan-wt")
      const orphanBranch = "team/orphan/test-gc"
      await git(repo.dir, ["worktree", "add", "-b", orphanBranch, orphanDir, repo.head])
      expect(await dirExists(orphanDir)).toBe(true)

      const res = await gc(root, defaultPolicy)

      // Real orphan is removed
      expect(res.orphansRemoved).toContain(orphanDir)
      expect(await dirExists(orphanDir)).toBe(false)

      // Merge worktree in merge area survives GC
      expect(res.orphansRemoved).not.toContain(mergeDir)
      expect(await dirExists(mergeDir)).toBe(true)
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("a worktree GC cannot remove is not reported reaped, and is reaped once removal works", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      // Inside the team's own worktree area, so the orphan scan sees it too.
      const childWork = await makeChildWorktree(
        path.join(ownedRoot(root, "opencode"), "implementer"),
        repo.dir,
        "locked",
        repo.head,
      )
      const child = baseRun({
        id: "w-7777777777777777",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: repo.head,
        head: childWork.head,
        state: "stopped",
        lastUsed: "2020-01-01T00:00:00.000Z",
        worktree: "present",
      })
      await saveRun(root, parent)
      await saveRun(root, child)

      // Real git state: `git worktree remove` refuses a locked worktree.
      await git(repo.dir, ["worktree", "lock", childWork.dir])

      const swept = await sweep(dummyContext(), root)
      expect(swept.gc.reaped).not.toContain(child.id)
      expect(swept.gc.removeFailed).toContain(child.id)
      expect(await dirExists(childWork.dir)).toBe(true)
      // The record still says the worktree is there, so it keeps its known-dir
      // protection in the orphan scan of the same pass.
      const kept = await loadRun(root, child.id)
      expect(kept?.state).toBe("stopped")
      expect(kept?.worktree).toBe("present")
      expect(swept.gc.orphansRemoved).not.toContain(childWork.dir)

      await git(repo.dir, ["worktree", "unlock", childWork.dir])
      const res = await gc(root, defaultPolicy)
      expect(res.reaped).toContain(child.id)
      expect(res.removeFailed).not.toContain(child.id)
      expect(await dirExists(childWork.dir)).toBe(false)
      const reaped = await loadRun(root, child.id)
      expect(reaped?.state).toBe("reaped")
      expect(reaped?.worktree).toBe("removed")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("stale run referenced by open merge entry is kept (not reaped)", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      const childWork = await makeChildWorktree(repo.scratch, repo.dir, "open-merge", repo.head)
      const staleDate = "2020-01-01T00:00:00.000Z"
      const child = baseRun({
        id: "w-eeeeeeeeeeeeeeee",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: repo.head,
        head: childWork.head,
        state: "stopped",
        lastUsed: staleDate,
        worktree: "present",
      })
      await saveRun(root, parent)
      await saveRun(root, child)

      // Add an open (pending) merge entry referencing the child
      await atomicJson(path.join(root, "runs", parent.id, "merge", "entry-1.json"), {
        id: "entry-1",
        parentRun: parent.id,
        childRun: child.id,
        childBranch: child.branch,
        childHead: child.head,
        expectedParentHead: parent.head,
        state: "pending",
        at: staleDate,
        updatedAt: staleDate,
      })

      const res = await gc(root, defaultPolicy)
      // Open merge entry -> kept
      expect(res.reaped).not.toContain(child.id)
      expect(await dirExists(childWork.dir)).toBe(true)
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("stopped")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("stale run promoted from is kept when keepPromotedFrom is true", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      const staleDate = "2020-01-01T00:00:00.000Z"
      const childWork = await makeChildWorktree(repo.scratch, repo.dir, "promoted-from", repo.head)
      const child1 = baseRun({
        id: "w-1111111111111111",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: repo.head,
        head: childWork.head,
        state: "stopped",
        lastUsed: staleDate,
        worktree: "present",
      })
      const child2 = baseRun({
        id: "w-2222222222222222",
        role: "opus-orchestrator",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
        promotedFrom: child1.id,
      })
      await saveRun(root, parent)
      await saveRun(root, child1)
      await saveRun(root, child2)

      // When keepPromotedFrom is true (default):
      const res = await gc(root, defaultPolicy)
      expect(res.reaped).not.toContain(child1.id)
      expect(await dirExists(childWork.dir)).toBe(true)

      // When keepPromotedFrom is false:
      const policyNoPromoted = {
        ...defaultPolicy,
        gc: { ...defaultPolicy.gc, keepPromotedFrom: false },
      }
      const res2 = await gc(root, policyNoPromoted)
      expect(res2.reaped).toContain(child1.id)
      expect(await dirExists(childWork.dir)).toBe(false)
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("fresh stopped run (age < reapAfter) is not reaped", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      const childWork = await makeChildWorktree(repo.scratch, repo.dir, "fresh-stopped", repo.head)
      const child = baseRun({
        id: "w-ffffffffffffffff",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: repo.head,
        head: childWork.head,
        state: "stopped",
        lastUsed: new Date().toISOString(),
        worktree: "present",
      })
      await saveRun(root, parent)
      await saveRun(root, child)

      const res = await gc(root, defaultPolicy)
      expect(res.reaped).not.toContain(child.id)
      expect(await dirExists(childWork.dir)).toBe(true)
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("tolerance: empty root, missing runs directory, and garbage run directory", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    // Empty root: no runs/
    const res1 = await gc(root, defaultPolicy)
    expect(res1.reaped).toEqual([])
    expect(res1.skippedDirty).toEqual([])
    expect(res1.orphansRemoved).toEqual([])
    expect(res1.removeFailed).toEqual([])

    // Corrupted run directory
    await fs.mkdir(path.join(root, "runs", "garbage-run"), { recursive: true })
    await fs.writeFile(path.join(root, "runs", "garbage-run", "run.json"), "{ invalid-json")

    const res2 = await gc(root, defaultPolicy)
    expect(res2.reaped).toEqual([])
  })
})

test("sweep tick runs both reconcile and gc", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      const childWork = await makeChildWorktree(repo.scratch, repo.dir, "sweep-reap", repo.head)
      const staleDate = "2020-01-01T00:00:00.000Z"
      const child = baseRun({
        id: "w-9999999999999999",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: repo.head,
        head: childWork.head,
        state: "stopped",
        lastUsed: staleDate,
        worktree: "present",
      })
      await saveRun(root, parent)
      await saveRun(root, child)

      expect(await dirExists(childWork.dir)).toBe(true)
      await sweep(dummyContext(), root)
      // child worktree is removed and child run is reaped by sweep
      expect(await dirExists(childWork.dir)).toBe(false)
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("reaped")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})
