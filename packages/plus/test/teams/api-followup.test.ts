import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { change, presetTable, shippedMembers, teamState } from "./preset-table.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { peek } from "../../src/teams/inbox.js"
import { onSessionEvent } from "../../src/teams/lifecycle.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { FollowupInput } from "../../src/teams/schema.js"
import { atomicJson } from "../../src/teams/store.js"

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-followup-"))
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

function recordSession() {
  const created: unknown[] = []
  const prompted: Array<{ sessionID: unknown; text: unknown }> = []
  const waited: unknown[] = []
  let seq = 0
  const domain = {
    get: () => Effect.succeed({ id: Session.ID.make("ses_child_001") }),
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

function recordRejectingSession(message = "prompt blew up") {
  const prompted: Array<{ sessionID: unknown; text: unknown }> = []
  const domain = {
    get: () => Effect.succeed({ id: Session.ID.make("ses_child_001") }),
    prompt: (input: { sessionID: unknown; text: unknown }) => {
      prompted.push({ sessionID: input.sessionID, text: input.text })
      return Effect.fail(new Error(message))
    },
    wait: (input: unknown) => Effect.succeed(undefined),
  } as unknown as SessionDomain
  return { prompted, domain }
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: process.cwd(),
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
    bundle: "team-followup-test",
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

function followupInput(overrides?: Record<string, unknown>): FollowupInput {
  return {
    run: "w-aaaaaaaaaaaaaaaa",
    requestID: "req-1",
    prompt: "Clarify the blocked need: scope paths now include docs/*, continue in place.",
    ...overrides,
  } as FollowupInput
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

function parentChild(parentID: string, childID: string, childOverrides?: Partial<RunRecord>): { parent: RunRecord; child: RunRecord } {
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

async function writeBrief(root: string, child: RunRecord): Promise<void> {
  await atomicJson(path.join(root, "runs", child.id, "brief.json"), {
    requestID: "brief-1",
    role: "muse-implementer",
    objective: "Fix the agent filter in the query module so scoped listing works as documented.",
    deliverable: { kind: "commit" },
    scope: { paths: ["docs/*"], forbidden: [] },
    context: { interfaces: [], decisions: [] },
    checks: [],
    effort: "medium",
  })
}

test("queued followup lands in the child inbox and get_context sees it", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa")
    await saveRun(root, parent)
    await saveRun(root, child)
    await writeBrief(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const value = required(
      await api.followup(followupInput(), callerFor(parent)),
    ) as { attempt: number; state: string }
    expect(value).toEqual({ attempt: 2, state: "admitted" })
    const items = await peek(root, child.id)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("followup")
    expect(items[0]?.from).toBe(parent.id)
    expect(items[0]?.text).toContain("Clarify the blocked need")
    const seen = required(await api.get_context({}, callerFor(child))) as {
      inbox: Array<{ kind: string; from: string; text: string }>
    }
    expect(seen.inbox).toHaveLength(1)
    expect(seen.inbox[0]?.kind).toBe("followup")
    expect(seen.inbox[0]?.text).toContain("Clarify the blocked need")
  })
})

test("delivery now on a working child fails E_BUSY with the exact message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const { parent, child } = parentChild("main-0123456789abcdef", "w-bbbbbbbbbbbbbbbb", {
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const result = await api.followup(followupInput({ run: child.id, requestID: "busy-1", delivery: "now" }), callerFor(parent))
    const error = rejected(result)
    expect(error.code).toBe("E_BUSY")
    expect(error.message).toBe(`Child is working (attempt 1). Use delivery:"queue" (default) or wait first.`)
    if (!result.ok) expect(result.error.accepted).toEqual({ delivery: "queue" })
    else throw new Error("expected E_BUSY")
    expect(await peek(root, child.id)).toEqual([])
  })
})

// Whether a child takes corrections is the child's own "Corrections by
// followup" row (Briefs it accepts), which the Plus reviewer preset ships off:
// a review is re-run fresh, not corrected.
test("a reviewer-preset child refuses a followup with its row's message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-cccccccccccccccc", { role: "astra-reviewer" })
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const error = rejected(await api.followup(followupInput({ run: child.id, requestID: "rev-1" }), callerFor(parent)))
    expect(error.code).toBe("E_NO_FOLLOWUP")
    expect(error.message).toBe(
      "astra-reviewer takes no corrections by followup: delegate a fresh run with team_delegate and point it at the previous report (Briefs it accepts → Corrections by followup).",
    )
    expect(error.accepted).toBe("delegate a fresh run")
  })
})

test("the same reviewer takes a followup once its Corrections by followup row is on", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-cccccccccccccccc", { role: "astra-reviewer" })
    await saveRun(root, parent)
    await saveRun(root, child)
    const reviewer = shippedMembers().find((member) => member.id === "astra-reviewer")
    if (reviewer === undefined) throw new Error("no astra-reviewer in the shipped team")
    const table = presetTable({ records: [change(reviewer, "perm:team_get_context:accepts.followup", { state: "on" })] })
    const api = createTeamApi(context({ session: recordSession().domain }), teamState(table))
    expect(required(await api.followup(followupInput({ run: child.id, requestID: "rev-2" }), callerFor(parent)))).toMatchObject({ attempt: 2, state: "admitted" })
  })
})

test("a child with no preset takes no correction: the row falls back to off", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-cccccccccccccccc", { role: "ocp-alice" })
    await saveRun(root, parent)
    await saveRun(root, child)
    const table = presetTable({ members: [...shippedMembers(), { id: "ocp-alice", team: "opencodeplus-team" }] })
    const api = createTeamApi(context({ session: recordSession().domain }), teamState(table))
    const error = rejected(await api.followup(followupInput({ run: child.id, requestID: "alice-1" }), callerFor(parent)))
    expect(error.code).toBe("E_NO_FOLLOWUP")
    expect(error.message).toStartWith("ocp-alice takes no corrections by followup")
  })
})

test("non-child run is refused with E_NOT_CHILD", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({
      id: "main-0123456789abcdef",
      role: "opus-orchestrator",
      kind: "main",
      state: "working",
      sessionID: "ses_parent_002",
      children: ["w-knownchild1", "w-knownchild2"],
    })
    const stranger = baseRun({
      id: "w-dddddddddddddddd",
      role: "muse-implementer",
      state: "idle",
      parent: "main-ffffffffffffffff",
      sessionID: "ses_other_001",
    })
    await saveRun(root, parent)
    await saveRun(root, stranger)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const result = await api.followup(followupInput({ run: stranger.id, requestID: "nc-1" }), callerFor(parent))
    const error = rejected(result)
    expect(error.code).toBe("E_NOT_CHILD")
    expect(error.message).toBe(
      `Run ${stranger.id} is not your direct child. Your children: [w-knownchild1, w-knownchild2]. Use status to read others.`,
    )
    expect(error.accepted).toEqual(["w-knownchild1", "w-knownchild2"])
  })
})

test("unknown run id is refused with E_NOT_CHILD and empty children list", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({
      id: "main-0123456789abcdef",
      role: "opus-orchestrator",
      kind: "main",
      state: "working",
      sessionID: "ses_parent_002",
      children: [],
    })
    await saveRun(root, parent)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const result = await api.followup(followupInput({ run: "w-0000000000000000", requestID: "unk-1" }), callerFor(parent))
    const error = rejected(result)
    expect(error.code).toBe("E_NOT_CHILD")
    expect(error.message).toBe(
      "Run w-0000000000000000 is not your direct child. Your children: []. Use status to read others.",
    )
    expect(error.accepted).toEqual([])
  })
})

test("terminal superseded child fails E_TERMINAL with the exact message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa", {
      state: "superseded",
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const result = await api.followup(followupInput({ run: child.id, requestID: "term-1" }), callerFor(parent))
    const error = rejected(result)
    expect(error.code).toBe("E_TERMINAL")
    expect(error.message).toBe(`Run ${child.id} is superseded/reaped; delegate a fresh run.`)
    expect(error.accepted).toBe("delegate a fresh run")
  })
})

test("terminal reaped child fails E_TERMINAL with the exact message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa", {
      state: "reaped",
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const result = await api.followup(followupInput({ run: child.id, requestID: "term-reap-1" }), callerFor(parent))
    const error = rejected(result)
    expect(error.code).toBe("E_TERMINAL")
    expect(error.message).toBe(`Run ${child.id} is superseded/reaped; delegate a fresh run.`)
    expect(error.accepted).toBe("delegate a fresh run")
  })
})

test("same requestID twice is idempotent, different args fail E_REQUEST_ID", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-eeeeeeeeeeeeeeee")
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const first = required(
      await api.followup(followupInput({ run: child.id, requestID: "idem-1", prompt: "First followup text to answer the need." }), callerFor(parent)),
    ) as { attempt: number; state: string }
    expect(first).toEqual({ attempt: 2, state: "admitted" })
    expect(await peek(root, child.id)).toHaveLength(1)
    const second = required(
      await api.followup(followupInput({ run: child.id, requestID: "idem-1", prompt: "First followup text to answer the need." }), callerFor(parent)),
    )
    expect(second).toMatchObject({ ...first, replayed: true, receipt: first, current: { state: "working", attempt: 2 } })
    expect(await peek(root, child.id)).toHaveLength(1)
    const error = rejected(
      await api.followup(followupInput({ run: child.id, requestID: "idem-1", prompt: "A different followup text entirely here." }), callerFor(parent)),
    )
    expect(error.code).toBe("E_REQUEST_ID")
    expect(error.message).toBe(
      `requestID "idem-1" was used with different arguments; reuse only to retry the identical call, else pick a new requestID.`,
    )
    expect(await peek(root, child.id)).toHaveLength(1)
  })
})

test("budget in the call replaces the child budget outright", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-ffffffffffffffff", {
      budget: { turns: 60, tokens: 1000, wallMs: 5000 },
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const value = required(
      await api.followup(followupInput({ run: child.id, requestID: "bud-1", budget: { turns: 10 } }), callerFor(parent)),
    )
    expect(value).toEqual({ attempt: 2, state: "admitted" })
    expect((await loadRun(root, child.id))?.budget).toEqual({ turns: 10 })
  })
})

test("a stopped child resumes once, consumes stop intent, and replays after settlement", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa", { state: "stopped", stopRequested: true })
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const ctx = context({ session: sessions.domain })
    const api = createTeamApi(ctx, teamState())
    const input = followupInput()
    expect(required(await api.followup(input, callerFor(parent)))).toEqual({ attempt: 2, state: "admitted" })
    expect((await loadRun(root, child.id))?.stopRequested).toBeUndefined()
    await onSessionEvent(ctx, root, { type: "session.execution.started", data: { sessionID: child.sessionID } })
    await onSessionEvent(ctx, root, { type: "session.execution.succeeded", data: { sessionID: child.sessionID } })
    const settled = await loadRun(root, child.id)
    expect(settled?.state).toBe("idle")
    expect(settled?.attempts).toHaveLength(2)
    expect(settled?.attempts[0]).toEqual(child.attempts[0])
    expect(required(await api.followup(input, callerFor(parent)))).toMatchObject({ replayed: true, current: { state: "idle", attempt: 2 } })
    expect(sessions.prompted).toHaveLength(1)
    expect(await peek(root, child.id)).toEqual([])
  })
})

test("unavailable targets refuse before inbox, budget or request receipt changes", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    for (const overrides of [{ worktree: "removed" as const }, { sessionID: null }, { state: "dead" as const }]) {
      const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa", overrides)
      await saveRun(root, parent)
      await saveRun(root, child)
      const before = await loadRun(root, child.id)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      expect((await api.followup(followupInput({ budget: { tokens: 1 } }), callerFor(parent))).ok).toBe(false)
      expect(await loadRun(root, child.id)).toEqual(before)
      expect(await peek(root, child.id)).toEqual([])
      expect(await fs.readdir(path.join(root, "requests")).catch(() => [])).toEqual([])
      expect(sessions.prompted).toHaveLength(0)
    }
  })
})

test("delivery now on an idle child prompts, moves to working and returns admitted", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-1111111111111111")
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const api = createTeamApi(context({ session: sessions.domain }), teamState())
    const value = required(
      await api.followup(
        followupInput({ run: child.id, requestID: "now-1", delivery: "now", prompt: "Continue in place: fix the off-by-one now." }),
        callerFor(parent),
      ),
    ) as { attempt: number; state: string }
    expect(value).toEqual({ attempt: 2, state: "admitted" })
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]?.text).toContain("fix the off-by-one")
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("working")
    expect(moved?.attempts[moved.attempts.length - 1]?.state).toBe("admitted")
    expect(moved?.attempts[moved.attempts.length - 1]?.n).toBe(2)
  })
})

test("queue default on an idle child prompts and returns admitted with the real attempt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-2222222222222222")
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const api = createTeamApi(context({ session: sessions.domain }), teamState())
    const value = required(
      await api.followup(
        followupInput({ run: child.id, requestID: "queue-idle-1", prompt: "Continue in place: cover the idle handoff now." }),
        callerFor(parent),
      ),
    ) as { attempt: number; state: string }
    expect(value.state).toBe("admitted")
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]?.text).toContain("idle handoff")
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("working")
    const last = moved?.attempts[moved.attempts.length - 1]
    expect(last?.state).toBe("admitted")
    expect(last?.n).toBe(value.attempt)
    expect(await peek(root, child.id)).toHaveLength(1)
  })
})

test("queue on a working child returns the current attempt and does not prompt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const { parent, child } = parentChild("main-0123456789abcdef", "w-3333333333333333", {
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const api = createTeamApi(context({ session: sessions.domain }), teamState())
    const value = required(
      await api.followup(
        followupInput({ run: child.id, requestID: "queue-busy-1", prompt: "Continue in place: queue while working now." }),
        callerFor(parent),
      ),
    ) as { attempt: number; state: string }
    expect(value).toEqual({ attempt: 1, state: "queued" })
    expect(sessions.prompted).toHaveLength(0)
    const kept = await loadRun(root, child.id)
    expect(kept?.state).toBe("working")
    expect(kept?.attempts).toHaveLength(1)
    expect(kept?.attempts[0]?.n).toBe(1)
    expect(await peek(root, child.id)).toHaveLength(1)
  })
})

test("two queued followups to a working child keep the current attempt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const { parent, child } = parentChild("main-0123456789abcdef", "w-4444444444444444", {
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const api = createTeamApi(context({ session: sessions.domain }), teamState())
    const first = required(
      await api.followup(
        followupInput({ run: child.id, requestID: "queue-twice-1", prompt: "First queued followup while working here." }),
        callerFor(parent),
      ),
    ) as { attempt: number; state: string }
    const second = required(
      await api.followup(
        followupInput({ run: child.id, requestID: "queue-twice-2", prompt: "Second queued followup while working here." }),
        callerFor(parent),
      ),
    ) as { attempt: number; state: string }
    expect(first).toEqual({ attempt: 1, state: "queued" })
    expect(second).toEqual({ attempt: 1, state: "queued" })
    expect(sessions.prompted).toHaveLength(0)
    const kept = await loadRun(root, child.id)
    expect(kept?.attempts).toHaveLength(1)
    expect(await peek(root, child.id)).toHaveLength(2)
  })
})

test("a followup queued to a working child is delivered as a new attempt when it goes idle", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const { parent, child } = parentChild("main-0123456789abcdef", "w-6666666666666666", {
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const ctx = context({ session: sessions.domain })
    const api = createTeamApi(ctx, teamState())
    const queued = required(
      await api.followup(
        followupInput({ run: child.id, requestID: "queue-idle-handoff", prompt: "Continue in place: also cover the empty list." }),
        callerFor(parent),
      ),
    ) as { attempt: number; state: string }
    expect(queued).toEqual({ attempt: 1, state: "queued" })
    expect(sessions.prompted).toHaveLength(0)
    // The child's host session going idle is the whole handoff: no further
    // call by either side.
    await onSessionEvent(ctx, root, { type: "session.idle", properties: { sessionID: String(child.sessionID) } })
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]?.sessionID).toBe(child.sessionID)
    expect(sessions.prompted[0]?.text).toContain("also cover the empty list")
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("working")
    expect(moved?.attempts).toHaveLength(2)
    expect(moved?.attempts[0]?.state).toBe("no_report")
    expect(moved?.attempts[1]).toMatchObject({ n: 2, state: "admitted", trigger: "followup" })
    expect(await peek(root, child.id)).toEqual([])
  })
})

test("now whose prompt rejects restores the run and allows a same-requestID retry", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-5555555555555555")
    await saveRun(root, parent)
    await saveRun(root, child)
    const failing = recordRejectingSession()
    const failingApi = createTeamApi(context({ session: failing.domain }), teamState())
    const input = followupInput({ run: child.id, requestID: "now-fail-1", delivery: "now", prompt: "Continue in place: retry the failed admit now." })
    const result = await failingApi.followup(input, callerFor(parent))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected prompt failure")
    expect(result.error.code).not.toBe("E_BUSY")
    expect(failing.prompted).toHaveLength(1)
    const restored = await loadRun(root, child.id)
    expect(restored?.state).toBe("idle")
    expect(restored?.attempts).toHaveLength(1)
    expect(restored?.attempts[0]?.state).toBe("succeeded")
    expect(restored?.attempts[0]?.n).toBe(1)
    const sessions = recordSession()
    const retryApi = createTeamApi(context({ session: sessions.domain }), teamState())
    const retried = required(await retryApi.followup(input, callerFor(parent))) as { attempt: number; state: string }
    expect(retried).toEqual({ attempt: 2, state: "admitted" })
    expect(sessions.prompted).toHaveLength(1)
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("working")
    expect(moved?.attempts[moved.attempts.length - 1]?.n).toBe(2)
  })
})
