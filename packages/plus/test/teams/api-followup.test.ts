import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { change, presetTable, shippedMembers, teamState } from "./preset-table.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { peek } from "../../src/teams/inbox.js"
import { onSessionEvent } from "../../src/teams/lifecycle.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { FollowupInput, Report } from "../../src/teams/schema.js"
import { atomicJson } from "../../src/teams/store.js"
import { git, gitRaw } from "../../src/teams/git.js"
import { consumeColdCompaction } from "../../src/teams/cold-compaction.js"
import { warmingStore } from "../../src/warming.js"

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
  const prompted: Array<{ sessionID: unknown; text: unknown; delivery?: unknown }> = []
  const waited: unknown[] = []
  let seq = 0
  const domain = {
    get: () => Effect.succeed({ id: Session.ID.make("ses_child_001") }),
    create: (input: unknown) => {
      created.push(input)
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_child_${seq}`) })
    },
    prompt: (input: { sessionID: unknown; text: unknown; delivery?: unknown }) => {
      prompted.push({ sessionID: input.sessionID, text: input.text, delivery: input.delivery })
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
    role: "implementer",
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
    role: "orchestrator",
    kind: "main",
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    sessionID: "ses_parent_001",
    children: [childID],
  })
  const child = baseRun({
    id: childID,
    role: "implementer",
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
    role: "implementer",
    objective: "Fix the agent filter in the query module so scoped listing works as documented.",
    deliverable: { kind: "commit" },
    scope: { paths: ["docs/*"], forbidden: [] },
    context: { interfaces: [], decisions: [] },
    checks: [],
    effort: "medium",
  })
}

test("a retained landed child refuses corrections before any admission or receipt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa")
    await saveRun(root, parent)
    await saveRun(root, child)
    const before = await loadRun(root, child.id)
    await atomicJson(path.join(root, "runs", parent.id, "merge", "landed.json"), {
      id: "landed", parentRun: parent.id, childRun: child.id, childBranch: child.branch, state: "landed", childHead: child.head,
    })
    const session = recordSession()
    const result = await createTeamApi(context({ session: session.domain }), teamState()).followup(followupInput({ budget: { tokens: 1 } }), callerFor(parent))
    expect(rejected(result).code).toBe("E_ALREADY_LANDED")
    expect(await loadRun(root, child.id)).toEqual(before)
    expect(await peek(root, child.id)).toEqual([])
    expect(await fs.readdir(path.join(root, "requests")).catch(() => [])).toEqual([])
    expect(session.prompted).toEqual([])
  })
})

test("queued followup lands in the child inbox and get_context sees it", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa")
    await saveRun(root, parent)
    await saveRun(root, child)
    await writeBrief(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const value = required(
      await api.followup(followupInput(), callerFor(parent)),
    ) as { attempt: number; state: string; next: string }
    expect(value).toEqual({ attempt: 2, state: "admitted", next: "End your turn: its settlement wakes you." })
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
    expect(error.message).toBe(`Child is working (attempt 1). Use delivery:"queue" (default); it is delivered when the child goes idle.`)
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
    const { parent, child } = parentChild("main-0123456789abcdef", "w-cccccccccccccccc", { role: "reviewer" })
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const error = rejected(await api.followup(followupInput({ run: child.id, requestID: "rev-1" }), callerFor(parent)))
    expect(error.code).toBe("E_NO_FOLLOWUP")
    expect(error.message).toBe(
      "reviewer takes no corrections by followup: delegate a fresh run with team_delegate and point it at the previous report (Briefs it accepts → Corrections by followup).",
    )
    expect(error.accepted).toBe("delegate a fresh run")
  })
})

test("the same reviewer takes a followup once its Corrections by followup row is on", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-cccccccccccccccc", { role: "reviewer" })
    await saveRun(root, parent)
    await saveRun(root, child)
    const reviewer = shippedMembers().find((member) => member.id === "reviewer")
    if (reviewer === undefined) throw new Error("no reviewer in the shipped team")
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
      role: "orchestrator",
      kind: "main",
      state: "working",
      sessionID: "ses_parent_002",
      children: ["w-knownchild1", "w-knownchild2"],
    })
    const stranger = baseRun({
      id: "w-dddddddddddddddd",
      role: "implementer",
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
      role: "orchestrator",
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
    ) as { attempt: number; state: string; next: string }
    expect(first).toEqual({ attempt: 2, state: "admitted", next: "End your turn: its settlement wakes you." })
    expect(await peek(root, child.id)).toHaveLength(1)
    const second = required(
      await api.followup(followupInput({ run: child.id, requestID: "idem-1", prompt: "First followup text to answer the need." }), callerFor(parent)),
    )
    expect(second).toEqual({ ...(first as object), replayed: true, state: "working" })
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

test("budget in the call changes only given dimensions and writes history", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-ffffffffffffffff", {
      budget: { turns: 60, tokens: 1000, wallMs: 5000 },
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const value = required(
      await api.followup(
        followupInput({ run: child.id, requestID: "bud-1", budget: { turns: 10 }, reason: "Increase turns allowance" }),
        callerFor(parent),
      ),
    )
    expect(value).toEqual({ attempt: 2, state: "admitted", next: "End your turn: its settlement wakes you." })
    const updated = await loadRun(root, child.id)
    expect(updated?.budget).toEqual({ turns: 10, tokens: 1000, wallMs: 5000 })
    expect(updated?.history.some((h) => "reason" in h && h.reason === "Increase turns allowance")).toBe(true)
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
    expect(required(await api.followup(input, callerFor(parent)))).toEqual({ attempt: 2, state: "admitted", next: "End your turn: its settlement wakes you." })
    expect((await loadRun(root, child.id))?.stopRequested).toBeUndefined()
    await onSessionEvent(ctx, root, { type: "session.execution.started", data: { sessionID: child.sessionID } })
    await onSessionEvent(ctx, root, { type: "session.execution.succeeded", data: { sessionID: child.sessionID } })
    const settled = await loadRun(root, child.id)
    expect(settled?.state).toBe("idle")
    expect(settled?.attempts).toHaveLength(2)
    expect(settled?.attempts[0]).toEqual(child.attempts[0])
    // A replay returns the stored result with the child's state now.
    expect(required(await api.followup(input, callerFor(parent)))).toEqual({ attempt: 2, state: "idle", replayed: true, next: "End your turn: its settlement wakes you." })
    expect(sessions.prompted).toHaveLength(1)
    expect(await peek(root, child.id)).toEqual([])
  })
})

test("followup on a cold child the caller stopped fails E_STOPPED naming compactWith", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa", {
      state: "stopped",
      stoppedBy: "main-0123456789abcdef",
      sessionID: "ses_stopped_cold_caller",
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const now = Date.now()
    await warmingStore.decide({
      sessionID: Session.ID.make(child.sessionID!),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm",
      since: now - 300000,
      now: now - 300000,
      settings: { prompt: "ping", interval: 60000, duration: 120000 },
    }, {})
    const session = {
      ...recordSession().domain,
      get: () =>
        Effect.succeed({
          id: Session.ID.make(child.sessionID!),
          agent: "implementer",
          model: { providerID: "cliproxyapi", id: "gemini-3.8-flash-high" },
        }),
    } as unknown as SessionDomain
    const api = createTeamApi(context({ session }), teamState())
    const result = await api.followup(followupInput({ run: child.id }), callerFor(parent))
    const error = rejected(result)
    expect(error.code).toBe("E_STOPPED")
    // What the parent can do itself: the call to make, with the child's model.
    expect(error.message).toContain('team_followup again with compactWith: "cliproxyapi/gemini-3.8-flash-high"')
    expect(error.message).toContain("or delegate a fresh run")
    expect(error.message).not.toContain("Instructions ›")
    expect(error.accepted).toEqual({ compactWith: "cliproxyapi/gemini-3.8-flash-high" })
  })
})

// A stopped, cold child whose chat runs on gemini-3.8-flash-high, with cold
// lists set on that model's row and the session recording each compaction.
async function coldStoppedChild(root: string, sessionID: string) {
  const { parent, child } = parentChild("main-0123456789abcdef", "w-cccccccccccccccc", {
    state: "stopped",
    stoppedBy: "main-0123456789abcdef",
    sessionID,
  })
  await saveRun(root, parent)
  await saveRun(root, child)
  const now = Date.now()
  await warmingStore.decide(
    {
      sessionID: Session.ID.make(sessionID),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm",
      since: now - 300000,
      now: now - 300000,
      settings: { prompt: "ping", interval: 60000, duration: 120000 },
    },
    {},
  )
  const state = {
    ...teamState(),
    cachedModelSettings: [
      {
        type: "modelSettings" as const,
        level: "defaults" as const,
        updated: "2026-01-01T00:00:00.000Z",
        providerID: "cliproxyapi",
        modelID: "gemini-3.8-flash-high",
        coldCompact: "on",
        coldModels: ["cliproxyapi/claude-haiku-5-5", "cliproxyapi/deepseek-v4.1-flash-cheap"],
      },
    ],
  }
  const compacted: Array<readonly string[] | undefined> = []
  const sessions = recordSession()
  const ctx = context({
    session: {
      ...sessions.domain,
      get: () =>
        Effect.succeed({
          id: Session.ID.make(sessionID),
          agent: "implementer",
          model: { providerID: "cliproxyapi", id: "gemini-3.8-flash-high" },
        }),
      compact: () => {
        compacted.push(consumeColdCompaction(sessionID))
        return Effect.succeed(undefined as never)
      },
    } as unknown as SessionDomain,
  })
  return { parent, child, state, ctx, compacted }
}

test("followup on a cold stopped child without compactWith compacts with the child's own cold list", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child, state, ctx, compacted } = await coldStoppedChild(root, "ses_stopped_cold_list")
    const api = createTeamApi(ctx, state)
    const result = await api.followup(followupInput({ run: child.id }), callerFor(parent))
    expect(required(result)).toMatchObject({ state: "admitted" })
    expect(compacted).toEqual([["cliproxyapi/claude-haiku-5-5", "cliproxyapi/deepseek-v4.1-flash-cheap"]])
  })
})

test("followup with compactWith arms that one model, not the child's cold list", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child, state, ctx, compacted } = await coldStoppedChild(root, "ses_stopped_cold_explicit")
    const api = createTeamApi(ctx, state)
    await api.followup(followupInput({ run: child.id, compactWith: "cliproxyapi/deepseek-v4.1-flash-cheap" }), callerFor(parent))
    expect(compacted).toEqual([["cliproxyapi/deepseek-v4.1-flash-cheap"]])
  })
})

test("followup on a child stopped by reconcile still admits", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa", {
      state: "stopped",
      // stoppedBy is undefined for reconcile / system stops
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const result = await api.followup(followupInput({ run: child.id }), callerFor(parent))
    expect(required(result)).toMatchObject({ attempt: 2, state: "admitted" })
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
    ) as { attempt: number; state: string; next: string }
    expect(value).toEqual({ attempt: 2, state: "admitted", next: "End your turn: its settlement wakes you." })
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
    ) as { attempt: number; state: string; next: string }
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

test("queue on a working child delivers as a steer and keeps current attempt", async () => {
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
    ) as { attempt: number; state: string; next: string }
    expect(value).toEqual({ attempt: 1, state: "queued", next: "End your turn: its settlement wakes you." })
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]?.delivery).toBe("steer")
    const kept = await loadRun(root, child.id)
    expect(kept?.state).toBe("working")
    expect(kept?.attempts).toHaveLength(1)
    expect(kept?.attempts[0]?.n).toBe(1)
  })
})

test("two queued followups to a working child keep the current attempt and steer both", async () => {
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
    ) as { attempt: number; state: string; next: string }
    const second = required(
      await api.followup(
        followupInput({ run: child.id, requestID: "queue-twice-2", prompt: "Second queued followup while working here." }),
        callerFor(parent),
      ),
    ) as { attempt: number; state: string; next: string }
    expect(first).toEqual({ attempt: 1, state: "queued", next: "End your turn: its settlement wakes you." })
    expect(second).toEqual({ attempt: 1, state: "queued", next: "End your turn: its settlement wakes you." })
    expect(sessions.prompted).toHaveLength(2)
    expect(sessions.prompted[0]?.delivery).toBe("steer")
    expect(sessions.prompted[1]?.delivery).toBe("steer")
    const kept = await loadRun(root, child.id)
    expect(kept?.attempts).toHaveLength(1)
  })
})

test("a followup delivered as a steer to a working child is not repeated when it goes idle", async () => {
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
    ) as { attempt: number; state: string; next: string }
    expect(queued).toEqual({ attempt: 1, state: "queued", next: "End your turn: its settlement wakes you." })
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]?.delivery).toBe("steer")
    // When the session goes idle, the steered message was already delivered so it is not repeated
    await onSessionEvent(ctx, root, { type: "session.idle", properties: { sessionID: String(child.sessionID) } })
    expect(sessions.prompted).toHaveLength(1)
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
    const retried = required(await retryApi.followup(input, callerFor(parent))) as { attempt: number; state: string; next: string }
    expect(retried).toEqual({ attempt: 2, state: "admitted", next: "End your turn: its settlement wakes you." })
    expect(sessions.prompted).toHaveLength(1)
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("working")
    expect(moved?.attempts[moved.attempts.length - 1]?.n).toBe(2)
  })
})

// A parent checkout with a child worktree that committed one file, after
// which the parent's HEAD moved on (a sibling landed). `shared` is a file
// both may change, for the conflict case.
async function rebaseFixture(childChange: Record<string, string>, parentChange: Record<string, string>) {
  const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-followup-rebase-"))
  const main = path.join(scratch, "main")
  const worktree = path.join(scratch, "child")
  await fs.mkdir(main)
  await git(main, ["init", "-q", "-b", "main"])
  await git(main, ["config", "user.name", "team-test"])
  await git(main, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(main, "shared.ts"), "export const shared = 1\n")
  await git(main, ["add", "shared.ts"])
  await git(main, ["commit", "-q", "-m", "feat: initial"])
  const base = await git(main, ["rev-parse", "HEAD"])
  await git(main, ["worktree", "add", "-q", "-b", "team/child", worktree, base])
  const commit = async (dir: string, files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(dir, file), text)
    await git(dir, ["add", ...Object.keys(files)])
    await git(dir, ["commit", "-q", "-m", message])
    return git(dir, ["rev-parse", "HEAD"])
  }
  const childHead = await commit(worktree, childChange, "feat: child work")
  const parentHead = await commit(main, parentChange, "feat: sibling landed")
  return { scratch, main, worktree, base, childHead, parentHead }
}

async function rebaseRuns(root: string, repo: Awaited<ReturnType<typeof rebaseFixture>>, overrides?: Partial<RunRecord>) {
  const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa", {
    directory: repo.worktree,
    branch: "team/child",
    base: repo.base,
    head: repo.childHead,
    ...overrides,
  })
  await saveRun(root, { ...parent, directory: repo.main, head: repo.parentHead })
  await saveRun(root, child)
  await writeBrief(root, child)
  return { parent: { ...parent, directory: repo.main, head: repo.parentHead }, child }
}

test("followup with rebase moves an idle child's commits onto its parent's HEAD and tells it so", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await rebaseFixture({ "child.ts": "export const child = 1\n" }, { "sibling.ts": "export const sibling = 1\n" })
    try {
      const { parent, child } = await rebaseRuns(root, repo)
      const session = recordSession()
      const api = createTeamApi(context({ session: session.domain }), teamState())
      expect(required(await api.followup(followupInput({ rebase: true, prompt: "The export you needed has landed." }), callerFor(parent)))).toMatchObject({
        state: "admitted",
      })
      const tip = await git(repo.worktree, ["rev-parse", "HEAD"])
      // The child's own commit, now on top of the parent's HEAD.
      expect(await git(repo.worktree, ["rev-parse", "HEAD^"])).toBe(repo.parentHead)
      expect(await git(repo.worktree, ["log", "-1", "--format=%s"])).toBe("feat: child work")
      expect(await fs.readFile(path.join(repo.worktree, "sibling.ts"), "utf8")).toBe("export const sibling = 1\n")
      // Its base moves with it, so its diff and finish count only its own commit.
      expect(await loadRun(root, child.id)).toMatchObject({ base: repo.parentHead, head: tip })
      const text = String(session.prompted.at(-1)?.text)
      expect(text).toContain(`Plus moved your commits onto ${repo.parentHead.slice(0, 12)}`)
      expect(text).toContain("The export you needed has landed.")
      // A rebase alone is enough content: it says what happened.
      expect(Schema.decodeUnknownSync(FollowupInput)({ run: child.id, requestID: "r", rebase: true })).toMatchObject({ rebase: true })
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)

test("followup replays conflicts for the same child to resolve, checkpoint, finish and land", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const original = await rebaseFixture({ "shared.ts": "export const shared = 2\n" }, { "shared.ts": "export const shared = 3\n" })
    await Bun.write(path.join(original.worktree, "new.ts"), "export const added = 1\n")
    await Bun.write(path.join(original.worktree, "new.test.ts"), 'import { test, expect } from "bun:test"\nimport { shared } from "./shared"\nimport { added } from "./new"\ntest("combined", () => expect(shared + added).toBeGreaterThan(0))\n')
    await git(original.worktree, ["add", "new.ts", "new.test.ts"])
    await git(original.worktree, ["commit", "-m", "test: cover added export"])
    const repo = { ...original, childHead: await git(original.worktree, ["rev-parse", "HEAD"]) }
    try {
      const { parent, child } = await rebaseRuns(root, repo)
      const briefPath = path.join(root, "runs", child.id, "brief.json")
      await atomicJson(briefPath, { ...await Bun.file(briefPath).json(), scope: { paths: ["shared.ts", "new.ts", "new.test.ts"], forbidden: [] } })
      await atomicJson(path.join(root, "runs", child.id, "checks.json"), [{ id: "combined", argv: ["bun", "test", "new.test.ts"] }])
      const session = recordSession()
      const api = createTeamApi(context({ session: session.domain }), teamState())
      expect(required(await api.followup(followupInput({ rebase: true }), callerFor(parent)))).toMatchObject({ state: "admitted", attempt: 2 })
      expect(await git(repo.worktree, ["rev-parse", "HEAD"])).toBe(repo.parentHead)
      expect(await git(repo.worktree, ["rev-parse", `refs/opencodeplus/replay/${child.id}/${repo.childHead}`])).toBe(repo.childHead)
      expect(await loadRun(root, child.id)).toMatchObject({ base: repo.parentHead, head: repo.parentHead })
      const marked = await Bun.file(path.join(repo.worktree, "shared.ts")).text()
      expect(marked).toContain("<<<<<<< HEAD")
      expect(marked).toContain("=======")
      expect(marked).toContain("export const shared = 2")
      expect(marked).toContain("export const shared = 3")
      expect(await git(repo.worktree, ["status", "--porcelain"])).toBe("M shared.ts\n?? new.test.ts\n?? new.ts")
      expect(await git(repo.worktree, ["diff", "--cached", "--name-only"])).toBe("")
      expect((await gitRaw(repo.worktree, ["rev-parse", "--verify", "MERGE_HEAD"])).code).not.toBe(0)
      const text = String(session.prompted.at(-1)?.text)
      expect(text).toContain(repo.parentHead)
      expect(text).toContain("[shared.ts]")
      expect(text).toContain("[new.test.ts, new.ts, shared.ts]")
      expect(text).toContain("commit the whole change in one call, team_checkpoint with files [new.test.ts, new.ts, shared.ts]")
      expect(required(await api.check({ id: "combined" }, callerFor(child)))).toMatchObject({ passed: false })
      await Bun.write(path.join(repo.worktree, "shared.ts"), "export const shared = 3\nexport const child = 2\n")
      const checkpoint = required(await api.checkpoint({ files: ["shared.ts", "new.ts", "new.test.ts"], message: "fix: preserve both changes" }, callerFor(child))) as { head: string }
      expect(await git(repo.worktree, ["rev-parse", "HEAD^"])).toBe(repo.parentHead)
      expect(await git(repo.worktree, ["status", "--porcelain"])).toBe("")
      const diff = required(await api.diff({ run: child.id, from: "base" }, callerFor(parent))) as { from: string; patch: string }
      expect(diff.from).toBe(repo.parentHead)
      expect(diff.patch).not.toContain("+export const shared = 3")
      expect(diff.patch).toContain("+export const child = 2")
      const finish = required(await api.finish(Schema.decodeUnknownSync(Report)({ status: "done", summary: "Resolved the conflict keeping both changes." }), callerFor(child))) as { commits: unknown[]; checks: { id: string; passed: boolean }[] }
      expect(finish.commits).toHaveLength(1)
      expect(finish.checks).toMatchObject([{ id: "combined", passed: true }])
      expect(required(await api.integrate({ run: child.id }, callerFor(parent)))).toMatchObject({ state: "landed", head: checkpoint.head })
      expect(await Bun.file(path.join(repo.main, "new.ts")).text()).toBe("export const added = 1\n")
      expect(await Bun.file(path.join(repo.main, "shared.ts")).text()).toContain("export const child = 2")
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)

test("followup with rebase refuses a dirty worktree and a working child, and moves nothing", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await rebaseFixture({ "shared.ts": "export const shared = 2\n" }, { "shared.ts": "export const shared = 3\n" })
    try {
      const { parent, child } = await rebaseRuns(root, repo)
      const session = recordSession()
      const api = createTeamApi(context({ session: session.domain }), teamState())
      await fs.writeFile(path.join(repo.worktree, "shared.ts"), "export const shared = 4\n")
      const dirty = rejected(await api.followup(followupInput({ requestID: "r-dirty", rebase: true }), callerFor(parent)))
      expect(dirty.code).toBe("E_DIRTY")
      expect(dirty.message).toContain("[shared.ts]")
      expect(await git(repo.worktree, ["rev-parse", "HEAD"])).toBe(repo.childHead)
      expect(await loadRun(root, child.id)).toMatchObject({ base: repo.base, head: repo.childHead })
      await git(repo.worktree, ["checkout", "--", "shared.ts"])
      await Bun.write(path.join(repo.worktree, "untracked.ts"), "keep me\n")
      expect(rejected(await api.followup(followupInput({ requestID: "r-untracked", rebase: true }), callerFor(parent))).code).toBe("E_DIRTY")
      await saveRun(root, { ...child, state: "working" })
      expect(rejected(await api.followup(followupInput({ requestID: "r-busy", rebase: true }), callerFor(parent))).code).toBe("E_BUSY")
      await saveRun(root, { ...child, state: "blocked_input" })
      expect(rejected(await api.followup(followupInput({ requestID: "r-blocked", rebase: true }), callerFor(parent))).code).toBe("E_BUSY")
      expect(session.prompted).toEqual([])
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)

// A child delegated on the parent's checkout, with one commit and a done
// report, as team_integrate finds it. Its branch follows delegation's naming.
async function landingFixture(root: string) {
  const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-followup-landed-"))
  const main = path.join(scratch, "main")
  const worktree = path.join(scratch, "child")
  await fs.mkdir(main)
  await git(main, ["init", "-q", "-b", "main"])
  await git(main, ["config", "user.name", "team-test"])
  await git(main, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(main, "README.md"), "# landed\n")
  await git(main, ["add", "README.md"])
  await git(main, ["commit", "-q", "-m", "feat: initial"])
  const base = await git(main, ["rev-parse", "HEAD"])
  const branch = "team/implementer/fixab12-20260101-1200"
  await git(main, ["worktree", "add", "-q", "-b", branch, worktree, base])
  await fs.writeFile(path.join(worktree, "child.ts"), "export const child = 1\n")
  await git(worktree, ["add", "child.ts"])
  await git(worktree, ["commit", "-q", "-m", "feat: child work"])
  const childHead = await git(worktree, ["rev-parse", "HEAD"])
  const { parent, child } = parentChild("main-0123456789abcdef", "w-aaaaaaaaaaaaaaaa", { directory: worktree, branch, base, head: childHead, projectDirectory: main })
  const parentRecord = { ...parent, directory: main, branch: "main", base, head: base }
  await saveRun(root, parentRecord)
  await saveRun(root, child)
  await writeBrief(root, child)
  await writeDone(root, child.id, 1)
  return { scratch, main, worktree, base, childHead, parent: parentRecord, child }
}

async function writeDone(root: string, runID: string, n: number) {
  await atomicJson(path.join(root, "runs", runID, `report-${n}.json`), { run: runID, attempt: n, status: "done", summary: "done", commits: [] })
}

function recordMovingSession() {
  const calls: Array<{ call: "move" | "prompt" | "wait"; input: Record<string, unknown> }> = []
  const domain = {
    get: () => Effect.succeed({ id: Session.ID.make("ses_child_001") }),
    move: (input: Record<string, unknown>) => Effect.sync(() => void calls.push({ call: "move", input })),
    prompt: (input: Record<string, unknown>) => Effect.sync(() => void calls.push({ call: "prompt", input })) as never,
    wait: (input: Record<string, unknown>) => Effect.sync(() => void calls.push({ call: "wait", input })),
  } as unknown as SessionDomain
  return { calls, domain }
}

test("a followup to a landed child reopens it at its parent's HEAD, and it can land again", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await landingFixture(root)
    try {
      const session = recordMovingSession()
      const api = createTeamApi(context({ session: session.domain }), teamState())
      expect(required(await api.integrate({ run: repo.child.id }, callerFor(repo.parent)))).toMatchObject({ state: "landed", worktree: "removed" })
      const landedHead = await git(repo.main, ["rev-parse", "HEAD"])
      expect(await loadRun(root, repo.child.id)).toMatchObject({ worktree: "removed", directory: repo.worktree })
      // Only what the followup does counts below (integrate waits for the child too).
      session.calls.length = 0

      expect(
        required(await api.followup(followupInput({ run: repo.child.id, requestID: "more-1", prompt: "Also export a second constant." }), callerFor(repo.parent))),
      ).toMatchObject({ attempt: 2, state: "admitted" })
      const reopened = await loadRun(root, repo.child.id)
      if (reopened === undefined) throw new Error("missing child record")
      // A new worktree under the team's own area, on a new branch named like delegation's.
      expect(reopened.directory).not.toBe(repo.worktree)
      expect(reopened.directory.startsWith(await fs.realpath(path.join(root, "worktrees", "opencode", "implementer")))).toBe(true)
      expect(reopened.branch).toMatch(/^team\/implementer\/fixab12-r2-\d{8}-\d{4}$/)
      expect(reopened).toMatchObject({ base: landedHead, head: landedHead, worktree: "present", state: "working", projectDirectory: repo.main })
      expect(reopened.history.filter((entry) => "trigger" in entry && entry.trigger === "reopened")).toMatchObject([{ from: "idle", to: "idle" }])
      expect(await git(reopened.directory, ["rev-parse", "HEAD"])).toBe(landedHead)
      expect(await fs.readFile(path.join(reopened.directory, "child.ts"), "utf8")).toBe("export const child = 1\n")
      // The chat moves to the new worktree, the empty run the move wakes is
      // waited out, and only then is it prompted there.
      expect(session.calls.map((entry) => entry.call)).toEqual(["move", "wait", "prompt"])
      expect(session.calls[0]?.input).toEqual({ sessionID: repo.child.sessionID, directory: reopened.directory, delivery: "steer" })
      const text = String(session.calls[2]?.input.text)
      expect(text).toContain(`Plus made you a new worktree at ${reopened.directory}, on your parent's current HEAD ${landedHead.slice(0, 12)}`)
      expect(text).toContain("Also export a second constant.")
      // Its earlier landing does not make the reopened generation landed.
      expect(
        required(await api.followup(followupInput({ run: repo.child.id, requestID: "more-2", prompt: "Name it second." }), callerFor(repo.parent))),
      ).toMatchObject({ state: "queued" })
      expect(session.calls.map((entry) => entry.call)).toEqual(["move", "wait", "prompt", "prompt"])

      // The reopened child commits, settles done, and lands and is cleaned up again.
      await fs.writeFile(path.join(reopened.directory, "second.ts"), "export const second = 2\n")
      await git(reopened.directory, ["add", "second.ts"])
      await git(reopened.directory, ["-c", "user.name=team-test", "-c", "user.email=team-test@local", "commit", "-q", "-m", "feat: second constant"])
      const second = await git(reopened.directory, ["rev-parse", "HEAD"])
      await saveRun(root, { ...(await loadRun(root, repo.child.id))!, state: "idle" })
      await writeDone(root, repo.child.id, 2)
      const again = required(await api.integrate({ run: repo.child.id }, callerFor(repo.parent))) as { alreadyLanded?: boolean }
      expect(again).toMatchObject({ state: "landed", head: second, worktree: "removed" })
      expect(again.alreadyLanded).toBeUndefined()
      expect(await git(repo.main, ["rev-parse", "HEAD"])).toBe(second)
      expect(await fs.stat(reopened.directory).then(() => true, () => false)).toBe(false)
      expect(await loadRun(root, repo.child.id)).toMatchObject({ worktree: "removed", branch: reopened.branch, head: second })
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)

test("a landed child is reopened only for a prompt to a live run; otherwise nothing moves", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await landingFixture(root)
    try {
      const session = recordMovingSession()
      const api = createTeamApi(context({ session: session.domain }), teamState())
      required(await api.integrate({ run: repo.child.id }, callerFor(repo.parent)))
      session.calls.length = 0
      const landed = await loadRun(root, repo.child.id)
      if (landed === undefined) throw new Error("missing child record")
      // A budget alone changes the budget and leaves the worktree removed.
      expect(required(await api.followup(followupInput({ run: repo.child.id, requestID: "b-1", prompt: undefined, budget: { tokens: 5 }, reason: "more room" }), callerFor(repo.parent)))).toEqual({ attempt: 1, state: repo.child.state, next: "End your turn: its settlement wakes you." })
      expect((await loadRun(root, repo.child.id))?.budget.tokens).toBe(5)
      expect(await loadRun(root, repo.child.id)).toMatchObject({ worktree: "removed", directory: repo.worktree, branch: repo.child.branch })
      // A terminal run is not reopened.
      await saveRun(root, { ...landed, state: "superseded" })
      expect(rejected(await api.followup(followupInput({ run: repo.child.id, requestID: "t-1" }), callerFor(repo.parent))).code).toBe("E_TERMINAL")
      // A removed worktree whose branch never landed (the landed one was another generation) is refused.
      await saveRun(root, { ...landed, branch: "team/implementer/other-20260101-1300" })
      expect(rejected(await api.followup(followupInput({ run: repo.child.id, requestID: "n-1" }), callerFor(repo.parent))).code).toBe("E_WORKTREE_REMOVED")
      expect(session.calls).toEqual([])
      expect((await git(repo.main, ["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree "))).toEqual([`worktree ${await fs.realpath(repo.main)}`])
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 30000)
