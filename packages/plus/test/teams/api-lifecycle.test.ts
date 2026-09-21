import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { git } from "../../src/teams/git.js"
import { peek } from "../../src/teams/inbox.js"
import { loadRun, saveRun, isAttemptTerminal, type RunRecord } from "../../src/teams/run.js"
import { claim, create, load } from "../../src/teams/tasks.js"
import { stopHandler, supersedeHandler } from "../../src/teams/api-lifecycle.js"
import { onSessionIdle } from "../../src/teams/lifecycle.js"
import type { TeamCaller } from "../../src/teams/api.js"

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

async function makeRepo(): Promise<{ dir: string; head: string }> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-lifecycle-repo-"))
  await git(dir, ["init"])
  await git(dir, ["config", "user.name", "team-test"])
  await git(dir, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# lifecycle test\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { dir, head }
}

async function removeRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

function recordSession() {
  const prompted: Array<{ sessionID: unknown; text: unknown }> = []
  const interrupted: unknown[] = []
  let seq = 0
  const domain = {
    create: (input: unknown) => {
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_child_${seq}`) })
    },
    prompt: (input: { sessionID: unknown; text: unknown }) => {
      prompted.push({ sessionID: input.sessionID, text: input.text })
      return Effect.succeed(undefined as never)
    },
    wait: (input: unknown) => Effect.succeed(undefined),
    interrupt: (input: unknown) => {
      interrupted.push(input)
      return Effect.succeed({ interrupted: true })
    },
  } as unknown as SessionDomain
  return { prompted, interrupted, domain }
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

function parentWithChild(parentID: string, childID: string, childOverrides?: Partial<RunRecord>): { parent: RunRecord; child: RunRecord } {
  const now = new Date().toISOString()
  const parent = baseRun({
    id: parentID,
    role: "opus-orchestrator",
    kind: "main",
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    sessionID: "ses_parent_001",
    children: [childID],
  })
  const child = baseRun({
    id: childID,
    role: "muse-implementer",
    state: "idle",
    attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
    parent: parentID,
    sessionID: "ses_child_001",
    ...childOverrides,
  })
  return { parent, child }
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

const REASON = "Child approach diverged; a fresh worker will retry with a narrower scope."

test("stop on an idle child stops and records both history rows", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const { parent, child } = parentWithChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa", {
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      const sessions = recordSession()
      const value = required(await stopHandler(context({ session: sessions.domain }), { run: child.id }, callerFor(parent))) as {
        run: string
        state: string
      }
      expect(value).toEqual({ run: child.id, state: "stopped" })
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("stopped")
      expect(stored?.history).toEqual([
        { at: expect.any(String), from: "idle", to: "stopping", trigger: "shutdown" },
        { at: expect.any(String), from: "stopping", to: "stopped", trigger: "exited" },
      ])
      expect(sessions.interrupted).toHaveLength(1)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("stop on a working child sets stopRequested and reports stopping, and is idempotent", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const { parent, child } = parentWithChild("main-0123456789abcdef", "w-bbbbbbbbbbbbbbbb", {
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const ctx = context({ session: sessions.domain })
    const value = required(await stopHandler(ctx, { run: child.id }, callerFor(parent))) as {
      run: string
      state: string
    }
    expect(value).toEqual({ run: child.id, state: "stopping" })
    const stored = await loadRun(root, child.id)
    expect(stored?.stopRequested).toBe(true)
    expect(stored?.state).toBe("working")

    // Idempotent: second call returns the same outcome
    const second = required(await stopHandler(ctx, { run: child.id }, callerFor(parent))) as {
      run: string
      state: string
    }
    expect(second).toEqual({ run: child.id, state: "stopping" })

    // Idle handler completes it: when the turn ends, onSessionIdle transitions to stopped
    const finished = await onSessionIdle(ctx, root, stored!)
    expect(finished.state).toBe("stopped")
    const stoppedStored = await loadRun(root, child.id)
    expect(stoppedStored?.state).toBe("stopped")
    expect(stoppedStored?.history).toEqual([
      { at: expect.any(String), from: "working", to: "idle", trigger: "turn_ended" },
      { at: expect.any(String), from: "idle", to: "stopping", trigger: "shutdown" },
      { at: expect.any(String), from: "stopping", to: "stopped", trigger: "exited" },
    ])
  })
})

test("stop on an already stopped child succeeds as a no-op", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentWithChild("main-0123456789abcdef", "w-cccccccccccccccc", { state: "stopped" })
    await saveRun(root, parent)
    await saveRun(root, child)
    const value = required(await stopHandler(context({ session: recordSession().domain }), { run: child.id }, callerFor(parent))) as {
      run: string
      state: string
    }
    expect(value).toEqual({ run: child.id, state: "stopped" })
    const stored = await loadRun(root, child.id)
    expect(stored?.state).toBe("stopped")
    expect(stored?.history).toEqual([])
  })
})

test("stop on a dead child reconciles to stopped", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentWithChild("main-0123456789abcdef", "w-dddddddddddddddd", { state: "dead" })
    await saveRun(root, parent)
    await saveRun(root, child)
    const value = required(await stopHandler(context({ session: recordSession().domain }), { run: child.id }, callerFor(parent))) as {
      run: string
      state: string
    }
    expect(value).toEqual({ run: child.id, state: "stopped" })
    const stored = await loadRun(root, child.id)
    expect(stored?.state).toBe("stopped")
    expect(stored?.history).toEqual([{ at: expect.any(String), from: "dead", to: "stopped", trigger: "reconcile" }])
  })
})

test("stop on a ready child sets stopRequested and reports stopping", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentWithChild("main-0123456789abcdef", "w-eeeeeeeeeeeeeeee", { state: "ready" })
    await saveRun(root, parent)
    await saveRun(root, child)
    const value = required(await stopHandler(context({ session: recordSession().domain }), { run: child.id }, callerFor(parent))) as {
      run: string
      state: string
    }
    expect(value).toEqual({ run: child.id, state: "stopping" })
    const stored = await loadRun(root, child.id)
    expect(stored?.stopRequested).toBe(true)
  })
})

test("stop on a non-child fails E_NOT_CHILD with the exact message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({
      id: "main-0123456789abcdef",
      role: "opus-orchestrator",
      kind: "main",
      state: "working",
      sessionID: "ses_parent_002",
      children: [],
    })
    const stranger = baseRun({
      id: "w-ffffffffffffffff",
      role: "muse-implementer",
      state: "idle",
      parent: "main-ffffffffffffffff",
      sessionID: "ses_other_001",
    })
    await saveRun(root, parent)
    await saveRun(root, stranger)
    const error = rejected(await stopHandler(context({ session: recordSession().domain }), { run: stranger.id }, callerFor(parent)))
    expect(error.code).toBe("E_NOT_CHILD")
    expect(error.message).toBe(
      "Run w-ffffffffffffffff is not your direct child. Your children: []. Use status to read others.",
    )
  })
})

test("supersede on an idle clean child supersedes, stores the reason and preserves the worktree", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const { parent, child } = parentWithChild("main-0123456789abcdef", "w-1111111111111111", {
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await create(root, parent.id, [
        {
          id: "T1",
          title: "Task T1",
          dependsOn: [],
          role: "muse-implementer",
          effort: "small",
          deliverable: { kind: "commit" },
          paths: ["docs/*"],
          checks: [{ id: "t", argv: ["bun", "test", "t.test.ts"] }],
        },
      ])
      await claim(root, parent.id, "T1", child.id)
      await saveRun(root, { ...child, task: "T1" })
      const value = required(
        await supersedeHandler(context({ session: recordSession().domain }), { run: child.id, reason: REASON }, callerFor(parent)),
      ) as { run: string; state: string; hadUncommitted: boolean; head: string }
      expect(value).toEqual({ run: child.id, state: "superseded", hadUncommitted: false, head: repo.head })
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("superseded")
      expect(stored?.supersededReason).toBe(REASON)
      expect((await load(root, parent.id)).tasks["T1"]?.state).toBe("cancelled")
      expect((await fs.stat(repo.dir)).isDirectory()).toBe(true)
      expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(repo.head)
      expect(await Bun.file(path.join(repo.dir, "README.md")).exists()).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("supersede on an idle dirty child reports hadUncommitted true and preserves the dirty file", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const { parent, child } = parentWithChild("main-0123456789abcdef", "w-2222222222222222", {
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      await fs.writeFile(path.join(repo.dir, "dirty.txt"), "uncommitted work\n")
      const value = required(
        await supersedeHandler(context({ session: recordSession().domain }), { run: child.id, reason: REASON }, callerFor(parent)),
      ) as { run: string; state: string; hadUncommitted: boolean; head: string }
      expect(value.state).toBe("superseded")
      expect(value.hadUncommitted).toBe(true)
      expect(value.head).toBe(repo.head)
      expect(await Bun.file(path.join(repo.dir, "dirty.txt")).exists()).toBe(true)
      expect((await loadRun(root, child.id))?.state).toBe("superseded")
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("supersede on a working child with waitMs 0 still ends superseded via stopping/stopped", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const now = new Date().toISOString()
      const { parent, child } = parentWithChild("main-0123456789abcdef", "w-3333333333333333", {
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        state: "working",
        attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      const sessions = recordSession()
      const value = required(
        await supersedeHandler(context({ session: sessions.domain }), { run: child.id, reason: REASON, waitMs: 0 }, callerFor(parent)),
      ) as { run: string; state: string; hadUncommitted: boolean; head: string }
      expect(value).toEqual({ run: child.id, state: "superseded", hadUncommitted: false, head: repo.head })
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("superseded")
      expect(stored?.history).toEqual([
        { at: expect.any(String), from: "working", to: "stopping", trigger: "stop_force" },
        { at: expect.any(String), from: "stopping", to: "stopped", trigger: "exited" },
        { at: expect.any(String), from: "stopped", to: "superseded", trigger: "supersede" },
      ])
      expect(sessions.interrupted).toHaveLength(1)
      const shutdown = await peek(root, child.id)
      expect(shutdown.some((item) => item.kind === "shutdown")).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("supersede on an already superseded child is a no-op success", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const before = parentWithChild("main-0123456789abcdef", "w-4444444444444444", {
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        state: "superseded",
        supersededReason: "Original reason that is long enough.",
      }).child
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        kind: "main",
        state: "working",
        sessionID: "ses_parent_003",
        children: [before.id],
      })
      await saveRun(root, parent)
      await saveRun(root, before)
      const snapshot = await loadRun(root, before.id)
      const value = required(
        await supersedeHandler(
          context({ session: recordSession().domain }),
          { run: before.id, reason: "A different reason that is also long enough." },
          callerFor(parent),
        ),
      ) as { run: string; state: string; hadUncommitted: boolean; head: string }
      expect(value).toEqual({ run: before.id, state: "superseded", hadUncommitted: false, head: repo.head })
      const after = await loadRun(root, before.id)
      expect(after).toEqual(snapshot)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("supersede on a non-child fails E_NOT_CHILD with the exact message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({
      id: "main-0123456789abcdef",
      role: "opus-orchestrator",
      kind: "main",
      state: "working",
      sessionID: "ses_parent_004",
      children: [],
    })
    const stranger = baseRun({
      id: "w-5555555555555555",
      role: "muse-implementer",
      state: "idle",
      parent: "main-ffffffffffffffff",
      sessionID: "ses_other_002",
    })
    await saveRun(root, parent)
    await saveRun(root, stranger)
    const error = rejected(
      await supersedeHandler(context({ session: recordSession().domain }), { run: stranger.id, reason: REASON }, callerFor(parent)),
    )
    expect(error.code).toBe("E_NOT_CHILD")
    expect(error.message).toBe(
      "Run w-5555555555555555 is not your direct child. Your children: []. Use status to read others.",
    )
  })
})

test("supersede notifies the parent inbox with the reason", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const { parent, child } = parentWithChild("main-0123456789abcdef", "w-6666666666666666", {
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      required(
        await supersedeHandler(context({ session: recordSession().domain }), { run: child.id, reason: REASON }, callerFor(parent)),
      )
      const items = await peek(root, parent.id)
      expect(items).toHaveLength(1)
      expect(items[0]?.kind).toBe("notify")
      expect(items[0]?.from).toBe(child.id)
      expect(items[0]?.text).toContain(child.id)
      expect(items[0]?.text).toContain(REASON)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("supersede on a starting child with streaming attempt interrupts and settles the attempt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const now = new Date().toISOString()
      const { parent, child } = parentWithChild("main-0123456789abcdef", "w-7777777777777777", {
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        state: "starting",
        attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
        sessionID: "ses_child_starting_001",
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      const sessions = recordSession()
      const value = required(
        await supersedeHandler(
          context({ session: sessions.domain }),
          { run: child.id, reason: REASON, waitMs: 0 },
          callerFor(parent),
        ),
      ) as { run: string; state: string; hadUncommitted: boolean; head: string }
      expect(value.state).toBe("superseded")
      expect(sessions.interrupted).toHaveLength(1)
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("superseded")
      const last = stored?.attempts[stored.attempts.length - 1]
      expect(last !== undefined && isAttemptTerminal(last.state)).toBe(true)
      expect(last?.state).toBe("interrupted")
      const shutdown = await peek(root, child.id)
      expect(shutdown.some((item) => item.kind === "shutdown")).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("supersede on an idle child with terminal attempt does not interrupt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const now = new Date().toISOString()
      const { parent, child } = parentWithChild("main-0123456789abcdef", "w-8888888888888888", {
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        state: "idle",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
        sessionID: "ses_child_idle_001",
      })
      await saveRun(root, parent)
      await saveRun(root, child)
      const sessions = recordSession()
      const value = required(
        await supersedeHandler(context({ session: sessions.domain }), { run: child.id, reason: REASON }, callerFor(parent)),
      ) as { run: string; state: string }
      expect(value.state).toBe("superseded")
      expect(sessions.interrupted).toHaveLength(0)
      const stored = await loadRun(root, child.id)
      expect(stored?.state).toBe("superseded")
      expect(stored?.attempts[stored.attempts.length - 1]?.state).toBe("succeeded")
    } finally {
      await removeRepo(repo.dir)
    }
  })
})
