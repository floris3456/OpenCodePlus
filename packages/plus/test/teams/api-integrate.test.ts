import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { integrateHandler } from "../../src/teams/api-integrate.js"
import { shippedTable } from "./preset-table.js"
import type { TeamCaller } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { enqueue, pending, queue } from "../../src/teams/merge.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { atomicJson } from "../../src/teams/store.js"
import { create, load } from "../../src/teams/tasks.js"

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-integrate-"))
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
  const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-integrate-repo-"))
  const dir = path.join(scratch, "repo")
  await git(scratch, ["init", "-b", "main", "repo"])
  await git(dir, ["config", "user.name", "team-test"])
  await git(dir, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# integrate test\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { scratch, dir, head }
}

async function makeChild(
  scratch: string,
  repoDir: string,
  name: string,
  base: string,
  files: Record<string, string>,
  message: string,
): Promise<{ dir: string; branch: string; head: string }> {
  const dir = path.join(scratch, `child-${name}`)
  const branch = `child-${name}`
  await git(repoDir, ["worktree", "add", "-b", branch, dir, base])
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  await git(dir, ["add", "-A"])
  await git(dir, ["commit", "-m", message])
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { dir, branch, head }
}

function recordSession() {
  const created: unknown[] = []
  const prompted: Array<{ sessionID: unknown; text: unknown }> = []
  const waited: unknown[] = []
  let seq = 0
  const domain = {
    create: (input: unknown) => {
      created.push(input)
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_child_${seq}`) })
    },
    prompt: (input: { sessionID: unknown; text: unknown }) => {
      prompted.push({ sessionID: input.sessionID, text: input.text })
      return Effect.succeed(undefined as never)
    },
    wait: (input: unknown) => {
      waited.push(input)
      return Effect.succeed(undefined)
    },
  } as unknown as SessionDomain
  return { created, prompted, waited, domain }
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-team-integrate",
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
    bundle: "team-integrate-test",
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

function rejected(result: {
  ok: true
  value: unknown
} | {
  ok: false
  error: { code: string; message: string; accepted?: unknown }
}): {
  code: string
  message: string
  accepted?: unknown
} {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`)
  return result.error
}

async function writeReport(root: string, runID: string, n: number, status: string): Promise<void> {
  const now = new Date().toISOString()
  await atomicJson(path.join(root, "runs", runID, `report-${n}.json`), {
    run: runID,
    attempt: n,
    status,
    summary: `${status} summary`,
    concerns: [],
    needs: [],
    findings: [],
    deferred: [],
    commits: [],
    checks: [],
    head: "0123456789abcdef0123456789abcdef01234567",
    base: "0123456789abcdef0123456789abcdef01234567",
    dirty: false,
    dirtyFiles: [],
    reportPath: path.join(root, "runs", runID, `report-${n}.md`),
    at: now,
  })
}

function ctxFor() {
  return context({ session: recordSession().domain })
}

async function withReadyChild(fn: (fixture: {
  root: string
  repo: Awaited<ReturnType<typeof makeRepo>>
  parent: RunRecord
  child: RunRecord
  head: string
}) => Promise<void>) {
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
        sessionID: "ses_parent_retention",
        children: ["w-aaaaaaaaaaaaaaaa"],
      })
      const work = await makeChild(repo.scratch, repo.dir, "retention", repo.head, { "child.txt": "retained history\n" }, "feat: retained history")
      // The record can lag an ordinary git commit; cleanup must save the tip it
      // actually landed before removing the checkout used for historical reads.
      const child = baseRun({
        id: "w-aaaaaaaaaaaaaaaa",
        directory: work.dir,
        branch: work.branch,
        base: repo.head,
        head: repo.head,
        parent: parent.id,
        sessionID: "ses_child_retention",
        worktree: "present",
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await writeReport(root, child.id, 1, "done")
      await fn({ root, repo, parent, child, head: work.head })
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}

test("a saved done report cannot land before the actual Session drains; waiting is bounded", async () => {
  await withReadyChild(async ({ root, repo, parent, child }) => {
    const calls: string[] = []
    let waitReleased = false
    const domain = {
      wait: ({ sessionID }: { sessionID: string }) => {
        calls.push(sessionID)
        return Effect.never.pipe(Effect.ensuring(Effect.sync(() => { waitReleased = true })))
      },
    } as unknown as SessionDomain
    const start = Date.now()
    const error = rejected(await integrateHandler(context({ session: domain }), { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable()))
    expect(error.code).toBe("E_BUSY")
    expect(error.message).toContain("1000ms")
    expect(Date.now() - start).toBeLessThan(5000)
    expect(calls).toEqual([String(child.sessionID)])
    expect(waitReleased).toBe(true)
    expect(await queue(root, parent.id)).toEqual([])
    expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(repo.head)
    expect((await loadRun(root, child.id))?.worktree).toBe("present")
    expect(await fs.realpath(child.directory)).toBe(child.directory)
  })
})

test("a missing or failed Session-idle check refuses before queue admission", async () => {
  await withReadyChild(async ({ root, repo, parent, child }) => {
    const failed = context({ session: { wait: () => Effect.fail(new Error("session unavailable")) } as unknown as SessionDomain })
    expect(rejected(await integrateHandler(failed, { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable())).code).toBe("E_SESSION")
    await saveRun(root, { ...child, sessionID: null })
    expect(rejected(await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable())).code).toBe("E_NO_SESSION")
    expect(await queue(root, parent.id)).toEqual([])
    expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(repo.head)
  })
})

test("integration reads the report after actual Session settlement", async () => {
  await withReadyChild(async ({ root, repo, parent, child }) => {
    const settled = context({ session: { wait: () => Effect.promise(() => writeReport(root, child.id, 2, "blocked")) } as unknown as SessionDomain })
    const error = rejected(await integrateHandler(settled, { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable()))
    expect(error.code).toBe("E_NOT_DONE")
    expect(error.message).toContain("attempt 2")
    expect(await queue(root, parent.id)).toEqual([])
  })
})

test.skipIf(process.platform !== "linux")("landing succeeds with truthful cwd retention, then guarded removal succeeds after release", async () => {
  await withReadyChild(async ({ root, repo, parent, child, head }) => {
    const holder = Bun.spawn(["sh", "-c", "printf 'ready\\n'; read -r release"], {
      cwd: child.directory,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = holder.stdout.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n")
      expect(await fs.readlink(`/proc/${holder.pid}/cwd`)).toBe(child.directory)
      const sessions = recordSession()
      const value = required(await integrateHandler(context({ session: sessions.domain }), { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable()))
      expect(value).toMatchObject({
        state: "landed",
        head,
        worktree: "retained",
        reason: expect.stringContaining(`PID ${holder.pid}`),
        cleanup: [{ run: child.id, worktree: "retained", code: "E_WT_IN_USE" }],
      })
      expect(sessions.waited).toEqual([{ sessionID: child.sessionID }])
      expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(head)
      expect((await loadRun(root, child.id))?.worktree).toBe("present")
      expect((await loadRun(root, child.id))?.head).toBe(head)
      expect(await fs.realpath(child.directory)).toBe(child.directory)
      expect(holder.exitCode).toBeNull()
      const retry = required(await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable()))
      expect(retry).toMatchObject({ state: "landed", head, worktree: "retained", alreadyLanded: true, reason: expect.stringContaining(`PID ${holder.pid}`) })
      expect(await queue(root, parent.id)).toHaveLength(1)
      expect((await loadRun(root, child.id))?.worktree).toBe("present")
    } finally {
      reader.releaseLock()
      holder.stdin.write("release\n")
      holder.stdin.end()
      expect(await holder.exited).toBe(0)
    }
    // Cleanup retry is the same product integrate path. Parent history, dirt and
    // now-failing checks must not be consulted as if this were a new landing.
    await fs.writeFile(path.join(repo.dir, "later.txt"), "parent moved on\n")
    await git(repo.dir, ["add", "later.txt"])
    await git(repo.dir, ["commit", "-m", "feat: later parent work"])
    const later = await git(repo.dir, ["rev-parse", "HEAD"])
    await fs.writeFile(path.join(repo.dir, "later.txt"), "uncommitted parent work\n")
    await atomicJson(path.join(root, "runs", parent.id, "checks.json"), [{ id: "red", argv: ["bun", "test", "missing.test.ts"] }])
    const originalEntry = (await queue(root, parent.id))[0].id
    const removed = required(await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable()))
    expect(removed).toMatchObject({ entry: originalEntry, state: "landed", head, worktree: "removed", alreadyLanded: true })
    expect(await queue(root, parent.id)).toHaveLength(1)
    expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(later)
    expect(await fs.readFile(path.join(repo.dir, "later.txt"), "utf8")).toBe("uncommitted parent work\n")
    expect(await fs.stat(child.directory).then(() => true, () => false)).toBe(false)
    expect(await git(repo.dir, ["rev-parse", child.branch])).toBe(head)
    expect((await loadRun(root, child.id))?.head).toBe(head)
    expect((await loadRun(root, child.id))?.worktree).toBe("removed")
  })
})

test("git cleanup failure remains a landed result with a retained worktree", async () => {
  await withReadyChild(async ({ root, repo, parent, child, head }) => {
    await git(repo.dir, ["worktree", "lock", child.directory])
    const value = required(await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable()))
    expect(value).toMatchObject({ state: "landed", head, worktree: "retained", reason: expect.stringContaining("locked") })
    expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(head)
    expect((await loadRun(root, child.id))?.worktree).toBe("present")
    expect((await loadRun(root, child.id))?.head).toBe(head)
    expect(await fs.realpath(child.directory)).toBe(child.directory)
    const busy = context({ session: { wait: () => Effect.never } as unknown as SessionDomain })
    const retry = required(await integrateHandler(busy, { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable()))
    expect(retry).toMatchObject({ state: "landed", head, worktree: "retained", alreadyLanded: true, cleanup: [{ code: "E_BUSY" }] })
    expect((await loadRun(root, child.id))?.worktree).toBe("present")
    expect(await queue(root, parent.id)).toHaveLength(1)
  })
})

test("successful cleanup records the actual original child head for history", async () => {
  await withReadyChild(async ({ root, repo, parent, child, head }) => {
    const value = required(await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: repo.head }, callerFor(parent), shippedTable()))
    expect(value).toMatchObject({ state: "landed", head, worktree: "removed" })
    expect((await loadRun(root, child.id))?.worktree).toBe("removed")
    expect((await loadRun(root, child.id))?.head).toBe(head)
    expect((await loadRun(root, child.id))?.base).toBe(repo.head)
    expect(await fs.stat(child.directory).then(() => true, () => false)).toBe(false)
  })
})

test("happy path lands the child commit in the parent worktree", async () => {
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
        attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
        sessionID: "ses_parent_001",
        children: ["w-aaaaaaaaaaaaaaaa"],
      })
      const childWork = await makeChild(repo.scratch, repo.dir, "happy", parentHead, { "child.txt": "hello\n" }, "feat: add child file")
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
        task: null,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await writeReport(root, child.id, 1, "done")
      const value = required(
        await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()),
      ) as { entry: string; state: string; head: string | null }
      expect(typeof value.entry).toBe("string")
      expect(value.state).toBe("landed")
      expect(value.head).toBe(childWork.head)
      expect(value.head).not.toBe(parentHead)
      const head = value.head
      if (typeof head !== "string") throw new Error("missing landed head")
      expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(head)
      expect(await fs.readFile(path.join(repo.dir, "child.txt"), "utf8")).toBe("hello\n")
      const subject = await git(repo.dir, ["log", "-1", "--format=%s"])
      expect(subject).toBe("feat: add child file")
      const stored = await loadRun(root, child.id)
      expect(stored?.id).toBe(child.id)
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)

test("blocked report at attempt 2 is refused with E_NOT_DONE", async () => {
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
        attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
        sessionID: "ses_parent_002",
        children: ["w-bbbbbbbbbbbbbbbb"],
      })
      const childWork = await makeChild(repo.scratch, repo.dir, "blocked", parentHead, { "child.txt": "blocked work\n" }, "feat: blocked work")
      const now = new Date().toISOString()
      const child = baseRun({
        id: "w-bbbbbbbbbbbbbbbb",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: parentHead,
        head: childWork.head,
        state: "idle",
        attempts: [
          { n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now },
          { n: 2, state: "reported", startedAt: now, trigger: "followup", endedAt: now },
        ],
        parent: parent.id,
        sessionID: "ses_child_002",
        task: null,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await writeReport(root, child.id, 1, "done")
      await writeReport(root, child.id, 2, "blocked")
      const error = rejected(await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()))
      expect(error.code).toBe("E_NOT_DONE")
      expect(error.message).toBe(
        `Child w-bbbbbbbbbbbbbbbb last report is "blocked" (attempt 2). Only done/done_with_concerns can be integrated. Send a followup or supersede.`,
      )
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("working child is refused with E_BUSY", async () => {
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
        attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
        sessionID: "ses_parent_003",
        children: ["w-cccccccccccccccc"],
      })
      const childWork = await makeChild(repo.scratch, repo.dir, "busy", parentHead, { "child.txt": "busy work\n" }, "feat: busy work")
      const now = new Date().toISOString()
      const child = baseRun({
        id: "w-cccccccccccccccc",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: parentHead,
        head: childWork.head,
        state: "working",
        attempts: [
          { n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now },
          { n: 2, state: "streaming", startedAt: now, trigger: "followup" },
        ],
        parent: parent.id,
        sessionID: "ses_child_003",
        task: null,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await writeReport(root, child.id, 1, "done")
      const error = rejected(await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()))
      expect(error.code).toBe("E_BUSY")
      expect(error.message).toBe("Child is working; wait first.")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("wrong expectedParentHead is refused with E_STALE_PARENT", async () => {
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
        attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
        sessionID: "ses_parent_004",
        children: ["w-dddddddddddddddd"],
      })
      const childWork = await makeChild(repo.scratch, repo.dir, "stale", parentHead, { "child.txt": "stale work\n" }, "feat: stale work")
      const now = new Date().toISOString()
      const child = baseRun({
        id: "w-dddddddddddddddd",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: parentHead,
        head: childWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_004",
        task: null,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await writeReport(root, child.id, 1, "done")
      const error = rejected(
        await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: "0".repeat(40) }, callerFor(parent), shippedTable()),
      )
      expect(error.code).toBe("E_STALE_PARENT")
      expect(error.message).toBe(`Your HEAD is ${parentHead}; pass it as expectedParentHead (never the child's commit).`)
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("dirty parent is refused with E_DIRTY naming the file", async () => {
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
        attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
        sessionID: "ses_parent_005",
        children: ["w-eeeeeeeeeeeeeeee"],
      })
      const childWork = await makeChild(repo.scratch, repo.dir, "dirty", parentHead, { "child.txt": "dirty work\n" }, "feat: dirty work")
      const now = new Date().toISOString()
      const child = baseRun({
        id: "w-eeeeeeeeeeeeeeee",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: parentHead,
        head: childWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_005",
        task: null,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await writeReport(root, child.id, 1, "done")
      await fs.writeFile(path.join(repo.dir, "README.md"), "# integrate test modified\n")
      const error = rejected(await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toBe(
        "Your worktree has tracked modifications [README.md]; commit or discard them; the merge queue is paused until clean.",
      )
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("second integrate of a removed child returns its saved landing without enqueuing again", async () => {
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
        attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
        sessionID: "ses_parent_006",
        children: ["w-ffffffffffffffff"],
      })
      const childWork = await makeChild(repo.scratch, repo.dir, "already", parentHead, { "child.txt": "already work\n" }, "feat: already work")
      const now = new Date().toISOString()
      const child = baseRun({
        id: "w-ffffffffffffffff",
        role: "muse-implementer",
        directory: childWork.dir,
        branch: childWork.branch,
        base: parentHead,
        head: childWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_006",
        task: null,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await writeReport(root, child.id, 1, "done")
      const first = required(
        await integrateHandler(ctxFor(), { run: child.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()),
      ) as { entry: string; state: string; head: string | null }
      expect(first.state).toBe("landed")
      const landedHead = first.head
      if (typeof landedHead !== "string") throw new Error("missing landed head")
      const unavailable = context({ session: { wait: () => Effect.fail(new Error("Session unavailable")) } as unknown as SessionDomain })
      const again = required(await integrateHandler(unavailable, { run: child.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()))
      expect(again).toMatchObject({ entry: first.entry, state: "landed", head: landedHead, worktree: "removed", alreadyLanded: true })
      expect(await queue(root, parent.id)).toHaveLength(1)
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)

test("non-child run is refused with E_NOT_CHILD", async () => {
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
        sessionID: "ses_parent_007",
        children: ["w-aaaaaaaaaaaaaaaa"],
      })
      const stranger = baseRun({
        id: "w-bbbbbbbbbbbbbbbb",
        role: "muse-implementer",
        directory: repo.dir,
        branch: "main",
        base: parentHead,
        head: parentHead,
        state: "idle",
        parent: "main-ffffffffffffffff",
        sessionID: "ses_other_001",
      })
      await saveRun(root, parent)
      await saveRun(root, stranger)
      const error = rejected(
        await integrateHandler(ctxFor(), { run: stranger.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()),
      )
      expect(error.code).toBe("E_NOT_CHILD")
      expect(error.message).toBe(
        "Run w-bbbbbbbbbbbbbbbb is not your direct child. Your children: [w-aaaaaaaaaaaaaaaa]. Use status to read others.",
      )
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
})

test("integrate drains an older pending entry instead of stranding it", async () => {
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
        attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
        sessionID: "ses_parent_008",
        children: ["w-aaaaaaaaaaaaaaaa", "w-bbbbbbbbbbbbbbbb"],
      })
      const oldWork = await makeChild(repo.scratch, repo.dir, "oldpending", parentHead, { "old.txt": "old\n" }, "feat: old work")
      const newWork = await makeChild(repo.scratch, repo.dir, "newpending", parentHead, { "new.txt": "new\n" }, "feat: new work")
      const now = new Date().toISOString()
      const oldChild = baseRun({
        id: "w-aaaaaaaaaaaaaaaa",
        role: "muse-implementer",
        directory: oldWork.dir,
        branch: oldWork.branch,
        base: parentHead,
        head: oldWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_008a",
        task: null,
      })
      const newChild = baseRun({
        id: "w-bbbbbbbbbbbbbbbb",
        role: "muse-implementer",
        directory: newWork.dir,
        branch: newWork.branch,
        base: parentHead,
        head: newWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_008b",
        task: null,
      })
      await saveRun(root, parent)
      await saveRun(root, oldChild)
      await saveRun(root, newChild)
      await writeReport(root, oldChild.id, 1, "done")
      await writeReport(root, newChild.id, 1, "done")
      await enqueue(root, {
        parentRun: parent.id,
        parentWorktree: parent.directory,
        childRun: oldChild.id,
        childBranch: oldChild.branch,
        childHead: oldWork.head,
        expectedParentHead: parentHead,
      })
      expect(await pending(root, parent.id)).toHaveLength(1)
      const busy = context({ session: {
        wait: ({ sessionID }: { sessionID: string }) => sessionID === oldChild.sessionID ? Effect.never : Effect.void,
      } as unknown as SessionDomain })
      const refusal = rejected(await integrateHandler(busy, { run: newChild.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()))
      expect(refusal.code).toBe("E_BUSY")
      expect(refusal.message).toContain(oldChild.id)
      expect(await pending(root, parent.id)).toHaveLength(1)
      expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(parentHead)
      const sessions = recordSession()
      const value = required(
        await integrateHandler(context({ session: sessions.domain }), { run: newChild.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()),
      ) as { entry: string; state: string; head: string | null }
      expect(sessions.waited).toEqual([{ sessionID: newChild.sessionID }, { sessionID: oldChild.sessionID }])
      expect(value.state).toBe("landed")
      expect(typeof value.head).toBe("string")
      expect(await pending(root, parent.id)).toHaveLength(0)
      expect((await queue(root, parent.id)).filter((entry) => entry.state === "landed")).toHaveLength(2)
      expect(await fs.readFile(path.join(repo.dir, "old.txt"), "utf8")).toBe("old\n")
      expect(await fs.readFile(path.join(repo.dir, "new.txt"), "utf8")).toBe("new\n")
      expect((await loadRun(root, newChild.id))?.head).toBe(newWork.head)
      expect((await loadRun(root, newChild.id))?.head).not.toBe(value.head)
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)

test("rework attribution on conflict belongs to older child's task and plan run", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const plan1 = "p-1111111111111111"
      const plan2 = "p-2222222222222222"
      await create(root, plan1, [
        {
          id: "T1",
          title: "Task T1",
          dependsOn: [],
          role: "muse-implementer",
          effort: "small",
          deliverable: { kind: "commit" },
          paths: ["base.txt"],
          checks: [],
        },
      ])
      await create(root, plan2, [
        {
          id: "T2",
          title: "Task T2",
          dependsOn: [],
          role: "muse-implementer",
          effort: "small",
          deliverable: { kind: "commit" },
          paths: ["new.txt"],
          checks: [],
        },
      ])
      await fs.writeFile(path.join(repo.dir, "base.txt"), "initial\n")
      await git(repo.dir, ["add", "base.txt"])
      await git(repo.dir, ["commit", "-m", "chore: add base"])
      const p0 = await git(repo.dir, ["rev-parse", "HEAD"])

      const oldWork = await makeChild(repo.scratch, repo.dir, "oldconflict", p0, { "base.txt": "old change\n" }, "feat: old edit")

      await fs.writeFile(path.join(repo.dir, "base.txt"), "parent change\n")
      await git(repo.dir, ["add", "base.txt"])
      await git(repo.dir, ["commit", "-m", "feat: parent edit"])
      const p1 = await git(repo.dir, ["rev-parse", "HEAD"])

      const newWork = await makeChild(repo.scratch, repo.dir, "newclean", p1, { "new.txt": "new\n" }, "feat: new edit")

      const now = new Date().toISOString()
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: p1,
        head: p1,
        state: "working",
        attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
        sessionID: "ses_parent_conflict",
        children: ["w-1111111111111111", "w-2222222222222222"],
      })
      const oldChild = baseRun({
        id: "w-1111111111111111",
        role: "muse-implementer",
        directory: oldWork.dir,
        branch: oldWork.branch,
        base: p0,
        head: oldWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_old",
        task: "T1",
      })
      const newChild = baseRun({
        id: "w-2222222222222222",
        role: "muse-implementer",
        directory: newWork.dir,
        branch: newWork.branch,
        base: p1,
        head: newWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_new",
        task: "T2",
      })
      await saveRun(root, parent)
      await saveRun(root, oldChild)
      await saveRun(root, newChild)
      await writeReport(root, oldChild.id, 1, "done")
      await writeReport(root, newChild.id, 1, "done")

      await enqueue(root, {
        parentRun: parent.id,
        parentWorktree: parent.directory,
        childRun: oldChild.id,
        childBranch: oldChild.branch,
        childHead: oldWork.head,
        expectedParentHead: p1,
      })

      const value = required(
        await integrateHandler(ctxFor(), { run: newChild.id, expectedParentHead: p1 }, callerFor(parent), shippedTable()),
      ) as { entry: string; state: string; head: string | null }
      expect(value.state).toBe("landed")

      const all = await queue(root, parent.id)
      const oldEntry = all.find((e) => e.childRun === oldChild.id)
      const newEntry = all.find((e) => e.childRun === newChild.id)
      expect(oldEntry?.state).toBe("conflict")
      expect(oldEntry?.conflictFiles).toContain("base.txt")
      expect(oldEntry?.reworkTask).toBe("T1.rework.1")
      expect(newEntry?.state).toBe("landed")
      expect(newEntry?.reworkTask).toBeUndefined()

      const graph1 = await load(root, plan1)
      expect(graph1.tasks["T1"].state).toBe("rework")
      expect(graph1.tasks["T1.rework.1"]).toBeDefined()
      expect(graph1.tasks["T1.rework.1"].paths).toContain("base.txt")

      const graph2 = await load(root, plan2)
      expect(graph2.tasks["T2"].state).not.toBe("rework")
      expect(graph2.tasks["T2.rework.1"]).toBeUndefined()
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)

test("rework attribution on red checks belongs to older child's task and plan run", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const plan1 = "p-3333333333333333"
      const plan2 = "p-4444444444444444"
      await create(root, plan1, [
        {
          id: "T1",
          title: "Task T1",
          dependsOn: [],
          role: "muse-implementer",
          effort: "small",
          deliverable: { kind: "commit" },
          paths: ["gate.test.ts"],
          checks: [],
        },
      ])
      await create(root, plan2, [
        {
          id: "T2",
          title: "Task T2",
          dependsOn: [],
          role: "muse-implementer",
          effort: "small",
          deliverable: { kind: "commit" },
          paths: ["gate.test.ts"],
          checks: [],
        },
      ])
      const parentHead = repo.head
      const failingTest = 'import { test, expect } from "bun:test"\ntest("gate", () => { expect(1).toBe(2) })\n'
      const passingTest = 'import { test, expect } from "bun:test"\ntest("gate", () => { expect(1).toBe(1) })\n'

      const oldWork = await makeChild(repo.scratch, repo.dir, "oldred", parentHead, { "gate.test.ts": failingTest }, "feat: failing test")
      const newWork = await makeChild(repo.scratch, repo.dir, "newgreen", parentHead, { "gate.test.ts": passingTest }, "feat: passing test")

      const now = new Date().toISOString()
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: parentHead,
        head: parentHead,
        state: "working",
        attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
        sessionID: "ses_parent_red",
        children: ["w-3333333333333333", "w-4444444444444444"],
      })
      const oldChild = baseRun({
        id: "w-3333333333333333",
        role: "muse-implementer",
        directory: oldWork.dir,
        branch: oldWork.branch,
        base: parentHead,
        head: oldWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_old_red",
        task: "T1",
      })
      const newChild = baseRun({
        id: "w-4444444444444444",
        role: "muse-implementer",
        directory: newWork.dir,
        branch: newWork.branch,
        base: parentHead,
        head: newWork.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        parent: parent.id,
        sessionID: "ses_child_new_green",
        task: "T2",
      })
      await saveRun(root, parent)
      await saveRun(root, oldChild)
      await saveRun(root, newChild)
      await writeReport(root, oldChild.id, 1, "done")
      await writeReport(root, newChild.id, 1, "done")

      await atomicJson(path.join(root, "runs", parent.id, "checks.json"), [
        { id: "gate-check", argv: ["bun", "test", "gate.test.ts"] },
      ])

      await enqueue(root, {
        parentRun: parent.id,
        parentWorktree: parent.directory,
        childRun: oldChild.id,
        childBranch: oldChild.branch,
        childHead: oldWork.head,
        expectedParentHead: parentHead,
      })

      const value = required(
        await integrateHandler(ctxFor(), { run: newChild.id, expectedParentHead: parentHead }, callerFor(parent), shippedTable()),
      ) as { entry: string; state: string; head: string | null }
      expect(value.state).toBe("landed")

      const all = await queue(root, parent.id)
      const oldEntry = all.find((e) => e.childRun === oldChild.id)
      const newEntry = all.find((e) => e.childRun === newChild.id)
      expect(oldEntry?.state).toBe("red")
      expect(oldEntry?.redChecks).toContain("gate-check")
      expect(oldEntry?.reworkTask).toBe("T1.rework.1")
      expect(newEntry?.state).toBe("landed")
      expect(newEntry?.reworkTask).toBeUndefined()

      const graph1 = await load(root, plan1)
      expect(graph1.tasks["T1"].state).toBe("rework")
      expect(graph1.tasks["T1.rework.1"]).toBeDefined()

      const graph2 = await load(root, plan2)
      expect(graph2.tasks["T2"].state).not.toBe("rework")
      expect(graph2.tasks["T2.rework.1"]).toBeUndefined()
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)
