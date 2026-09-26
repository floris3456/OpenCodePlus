import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { teamState } from "./preset-table.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { peek, put } from "../../src/teams/inbox.js"
import { SessionRunEvents, deliverInbox, onSessionEvent, onSessionIdle } from "../../src/teams/lifecycle.js"
import { loadRun, saveRun, updateRun, type RunRecord } from "../../src/teams/run.js"
import { atomicJson } from "../../src/teams/store.js"

// Real run records in a real temp state root, driven by the same synthetic
// event payloads the host publishes. No mocks of the run store: every
// assertion reads run.json and the inbox back through their own modules.
async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-events-"))
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
  const prompted: Array<{ sessionID: string; text: string }> = []
  const domain = {
    prompt: (input: { sessionID: unknown; text: unknown }) => {
      prompted.push({ sessionID: String(input.sessionID), text: String(input.text) })
      return Effect.succeed(undefined as never)
    },
    wait: () => Effect.succeed(undefined),
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
    directory: "/tmp/wt-team-events",
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
    bundle: "team-events-test",
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

function idleEvent(sessionID: string) {
  return { type: "session.idle", properties: { sessionID } }
}

// The host's canonical execution events carry their payload in `data`, and the
// event names come from the schema owner so a rename fails this suite instead
// of silently unsubscribing Plus.
function startedEvent(sessionID: string) {
  return { type: SessionEvent.Execution.Started.type, data: { sessionID } }
}

function succeededEvent(sessionID: string) {
  return { type: SessionEvent.Execution.Succeeded.type, data: { sessionID } }
}

// A stopped/dead record that still carries the stop intent its own stop already
// satisfied, with the last attempt settled terminal.
function intentRun(
  id: string,
  state: "stopped" | "dead",
  sessionID: string,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    state,
    attempts: [{ n: 1, state: "interrupted", startedAt: now, trigger: "delegate", endedAt: now }],
    sessionID,
    stopRequested: true,
    ...overrides,
  })
}

function workingChild(id: string, parent: string | null, sessionID: string): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    parent,
    task: "T1",
    sessionID,
  })
}

test("the subscribed events are the host's canonical execution events plus the deprecated idle alias", () => {
  expect([...SessionRunEvents].toSorted()).toEqual(
    [
      SessionEvent.Execution.Failed.type,
      SessionEvent.Execution.Interrupted.type,
      SessionEvent.Execution.Started.type,
      SessionEvent.Execution.Succeeded.type,
      // Deprecated ephemeral event (packages/schema/src/session-status-event.ts);
      // the host publishes execution.succeeded instead, but harnesses still drive it.
      "session.idle",
    ].toSorted(),
  )
})

test("a turn that ends without finish leaves the run idle and the attempt no_report", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const child = workingChild("w-aaaaaaaaaaaaaaaa", null, "ses_child_001")
    await saveRun(root, child)
    const sessions = recordSession()
    await onSessionEvent(context({ session: sessions.domain }), root, succeededEvent("ses_child_001"))
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("idle")
    expect(moved?.attempts).toHaveLength(1)
    expect(moved?.attempts[0]?.state).toBe("no_report")
    expect(moved?.attempts[0]?.endedAt).toBeDefined()
    expect(sessions.prompted).toHaveLength(0)
  })
})

test("a starting child reaches idle when its first turn ends", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const child = baseRun({
      id: "w-bbbbbbbbbbbbbbbb",
      state: "starting",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      sessionID: "ses_child_002",
    })
    await saveRun(root, child)
    await onSessionEvent(context({ session: recordSession().domain }), root, succeededEvent("ses_child_002"))
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("idle")
    expect(moved?.attempts[0]?.state).toBe("no_report")
    expect(moved?.history[moved.history.length - 1]).toMatchObject({ from: "starting", to: "idle", trigger: "connected" })
  })
})

test("execution.failed settles the attempt failed and the run idle", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const child = workingChild("w-cccccccccccccccc", null, "ses_child_003")
    await saveRun(root, child)
    await onSessionEvent(context({ session: recordSession().domain }), root, {
      type: "session.execution.failed",
      properties: { sessionID: "ses_child_003" },
    })
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("idle")
    expect(moved?.attempts[0]?.state).toBe("failed")
  })
})

test("execution.interrupted settles the attempt interrupted and the run idle", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const child = workingChild("w-dddddddddddddddd", null, "ses_child_004")
    await saveRun(root, child)
    await onSessionEvent(context({ session: recordSession().domain }), root, {
      type: "session.execution.interrupted",
      properties: { sessionID: "ses_child_004" },
    })
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("idle")
    expect(moved?.attempts[0]?.state).toBe("interrupted")
  })
})

test("an attempt whose report is already written is left to finish", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const child = workingChild("w-eeeeeeeeeeeeeeee", null, "ses_child_005")
    await saveRun(root, child)
    await atomicJson(path.join(root, "runs", child.id, "report-1.json"), { status: "done", summary: "Landed." })
    await onSessionEvent(context({ session: recordSession().domain }), root, succeededEvent("ses_child_005"))
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("idle")
    expect(moved?.attempts[0]?.state).toBe("streaming")
  })
})

test("a session with no run and an unknown event type are both ignored", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const child = workingChild("w-ffffffffffffffff", null, "ses_child_006")
    await saveRun(root, child)
    const ctx = context({ session: recordSession().domain })
    expect(await onSessionEvent(ctx, root, idleEvent("ses_not_a_run"))).toBeUndefined()
    expect(await onSessionEvent(ctx, root, { type: "session.created", properties: { sessionID: "ses_child_006" } })).toBeUndefined()
    expect((await loadRun(root, child.id))?.state).toBe("working")
  })
})

test("a superseded run is not moved by a late idle event", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const child = baseRun({
      id: "w-1111111111111111",
      state: "superseded",
      attempts: [{ n: 1, state: "interrupted", startedAt: now, trigger: "delegate", endedAt: now }],
      sessionID: "ses_child_007",
    })
    await saveRun(root, child)
    await onSessionEvent(context({ session: recordSession().domain }), root, idleEvent("ses_child_007"))
    expect((await loadRun(root, child.id))?.state).toBe("superseded")
  })
})

test("a followup queued while working is delivered as a new attempt on idle", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const child = workingChild("w-2222222222222222", null, "ses_child_008")
    await saveRun(root, child)
    await put(root, child.id, { kind: "followup", from: "main-0123456789abcdef", text: "Also cover the empty-list case." })
    const sessions = recordSession()
    await onSessionEvent(context({ session: sessions.domain }), root, succeededEvent("ses_child_008"))
    const moved = await loadRun(root, child.id)
    expect(moved?.state).toBe("working")
    expect(moved?.attempts).toHaveLength(2)
    expect(moved?.attempts[0]?.state).toBe("no_report")
    expect(moved?.attempts[1]).toMatchObject({ n: 2, state: "admitted", trigger: "followup" })
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]?.sessionID).toBe("ses_child_008")
    expect(sessions.prompted[0]?.text).toBe("Also cover the empty-list case.")
    expect(await peek(root, child.id)).toEqual([])
  })
})

test("two queued followups arrive as one prompt and one attempt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const child = workingChild("w-3333333333333333", null, "ses_child_009")
    await saveRun(root, child)
    await put(root, child.id, { kind: "followup", from: "main-0123456789abcdef", text: "First correction." })
    await put(root, child.id, { kind: "followup", from: "main-0123456789abcdef", text: "Second correction." })
    const sessions = recordSession()
    await onSessionEvent(context({ session: sessions.domain }), root, succeededEvent("ses_child_009"))
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]?.text).toBe("First correction.\n\nSecond correction.")
    expect((await loadRun(root, child.id))?.attempts).toHaveLength(2)
  })
})

test("a followup already delivered to an idle child is not prompted twice", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const parent = baseRun({
      id: "main-0123456789abcdef",
      role: "opus-orchestrator",
      kind: "main",
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      sessionID: "ses_parent_010",
      children: ["w-4444444444444444"],
    })
    const child = baseRun({
      id: "w-4444444444444444",
      state: "idle",
      attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
      parent: parent.id,
      sessionID: "ses_child_010",
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const ctx = context({ session: sessions.domain })
    const api = createTeamApi(ctx, teamState())
    const queued = await api.followup(
      { run: child.id, requestID: "dup-1", prompt: "Continue in place: tighten the error message." },
      callerFor(parent),
    )
    expect(queued.ok).toBe(true)
    expect(sessions.prompted).toHaveLength(1)
    await onSessionEvent(ctx, root, succeededEvent("ses_child_010"))
    const moved = await loadRun(root, child.id)
    expect(sessions.prompted).toHaveLength(1)
    expect(moved?.state).toBe("idle")
    expect(moved?.attempts).toHaveLength(2)
    expect(moved?.attempts[1]?.state).toBe("no_report")
    expect(await peek(root, child.id)).toEqual([])
  })
})

test("a settled child puts exactly one child.settled item in a working parent's inbox", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const parent = baseRun({
      id: "main-0123456789abcdef",
      role: "opus-orchestrator",
      kind: "main",
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      sessionID: "ses_parent_011",
      children: ["w-5555555555555555"],
    })
    const child = workingChild("w-5555555555555555", parent.id, "ses_child_011")
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const ctx = context({ session: sessions.domain })
    await onSessionEvent(ctx, root, succeededEvent("ses_child_011"))
    const items = await peek(root, parent.id)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("child.settled")
    expect(items[0]?.from).toBe(child.id)
    expect(items[0]?.text).toContain(child.id)
    expect(items[0]?.text).toContain("attempt 1 no_report")
    expect(items[0]?.text).toContain("report: none")
    // A working parent is not prompted; its own idle drain delivers this.
    expect(sessions.prompted).toHaveLength(0)
    expect((await loadRun(root, child.id))?.attempts[0]?.notified).toBe(true)
    await onSessionEvent(ctx, root, succeededEvent("ses_child_011"))
    expect(await peek(root, parent.id)).toHaveLength(1)
  })
})

test("the settlement names the report status and path when the child reported", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const parent = baseRun({
      id: "main-0123456789abcdef",
      role: "opus-orchestrator",
      kind: "main",
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      sessionID: "ses_parent_012",
      children: ["w-6666666666666666"],
    })
    const child = baseRun({
      id: "w-6666666666666666",
      state: "idle",
      attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
      parent: parent.id,
      task: "T7",
      sessionID: "ses_child_012",
    })
    await saveRun(root, parent)
    await saveRun(root, child)
    await atomicJson(path.join(root, "runs", child.id, "report-1.json"), {
      status: "done",
      summary: "Filter fixed and covered.\nmore detail",
    })
    await onSessionEvent(context({ session: recordSession().domain }), root, succeededEvent("ses_child_012"))
    const items = await peek(root, parent.id)
    expect(items).toHaveLength(1)
    expect(items[0]?.text).toContain("settled: done")
    expect(items[0]?.text).toContain("summary: Filter fixed and covered.")
    expect(items[0]?.text).toContain(path.join(root, "runs", child.id, "report-1.md"))
  })
})

test("an idle parent is prompted with the settlement immediately", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const parent = baseRun({
      id: "main-0123456789abcdef",
      role: "opus-orchestrator",
      kind: "main",
      state: "idle",
      attempts: [{ n: 1, state: "no_report", startedAt: now, trigger: "prepare", endedAt: now }],
      sessionID: "ses_parent_013",
      children: ["w-7777777777777777"],
    })
    const child = workingChild("w-7777777777777777", parent.id, "ses_child_013")
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    await onSessionEvent(context({ session: sessions.domain }), root, succeededEvent("ses_child_013"))
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]?.sessionID).toBe("ses_parent_013")
    expect(sessions.prompted[0]?.text).toContain(child.id)
    const movedParent = await loadRun(root, parent.id)
    expect(movedParent?.state).toBe("working")
    expect(movedParent?.attempts).toHaveLength(2)
    expect(movedParent?.attempts[1]).toMatchObject({ n: 2, state: "admitted", trigger: "followup" })
    expect(await peek(root, parent.id)).toEqual([])
  })
})

test("a run with no session is never prompted and keeps its pending inbox", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const child = baseRun({
      id: "w-8888888888888888",
      state: "idle",
      attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
      sessionID: null,
    })
    await saveRun(root, child)
    await put(root, child.id, { kind: "followup", from: "main-0123456789abcdef", text: "Never delivered." })
    const sessions = recordSession()
    await onSessionIdle(context({ session: sessions.domain }), root, child)
    expect(sessions.prompted).toHaveLength(0)
    expect(await peek(root, child.id)).toHaveLength(1)
  })
})

test("session.execution.started moves an idle run to working", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const run = baseRun({
      id: "w-idle-001",
      state: "idle",
      sessionID: "ses_idle_001",
    })
    await saveRun(root, run)
    const sessions = recordSession()
    const moved = await onSessionEvent(context({ session: sessions.domain }), root, {
      type: "session.execution.started",
      properties: { sessionID: "ses_idle_001" },
    })
    expect(moved?.state).toBe("working")
    const loaded = await loadRun(root, run.id)
    expect(loaded?.state).toBe("working")
    expect(loaded?.history[loaded.history.length - 1]?.from).toBe("idle")
    expect(loaded?.history[loaded.history.length - 1]?.to).toBe("working")
  })
})

test("session.execution.started moves a starting run to working", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const run = baseRun({
      id: "w-starting-001",
      state: "starting",
      sessionID: "ses_starting_001",
    })
    await saveRun(root, run)
    const sessions = recordSession()
    const moved = await onSessionEvent(context({ session: sessions.domain }), root, {
      type: "session.execution.started",
      properties: { sessionID: "ses_starting_001" },
    })
    expect(moved?.state).toBe("working")
    const loaded = await loadRun(root, run.id)
    expect(loaded?.state).toBe("working")
    expect(loaded?.history[loaded.history.length - 1]?.from).toBe("starting")
    expect(loaded?.history[loaded.history.length - 1]?.to).toBe("working")
  })
})

test("session.execution.started resumes a stopped run to working", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const run = baseRun({
      id: "w-stopped-001",
      state: "stopped",
      sessionID: "ses_stopped_001",
    })
    await saveRun(root, run)
    const sessions = recordSession()
    const moved = await onSessionEvent(context({ session: sessions.domain }), root, {
      type: "session.execution.started",
      properties: { sessionID: "ses_stopped_001" },
    })
    expect(moved?.state).toBe("working")
    const loaded = await loadRun(root, run.id)
    expect(loaded?.state).toBe("working")
    expect(loaded?.history[loaded.history.length - 1]?.from).toBe("stopped")
    expect(loaded?.history[loaded.history.length - 1]?.to).toBe("working")
  })
})

test("session.execution.started resumes a dead run to working", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const run = baseRun({
      id: "w-dead-001",
      state: "dead",
      sessionID: "ses_dead_001",
    })
    await saveRun(root, run)
    const sessions = recordSession()
    const moved = await onSessionEvent(context({ session: sessions.domain }), root, {
      type: "session.execution.started",
      properties: { sessionID: "ses_dead_001" },
    })
    expect(moved?.state).toBe("working")
    const loaded = await loadRun(root, run.id)
    expect(loaded?.state).toBe("working")
    expect(loaded?.history[loaded.history.length - 1]?.from).toBe("dead")
    expect(loaded?.history[loaded.history.length - 1]?.to).toBe("working")
  })
})

test("session.execution.started on a working run is a no-op", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const workingRun = baseRun({
      id: "w-working-001",
      state: "working",
      sessionID: "ses_working_001",
    })
    await saveRun(root, workingRun)
    const sessions = recordSession()
    const result = await onSessionEvent(context({ session: sessions.domain }), root, {
      type: "session.execution.started",
      properties: { sessionID: "ses_working_001" },
    })
    expect(result).toBeUndefined()
    const loaded = await loadRun(root, workingRun.id)
    expect(loaded?.state).toBe("working")
    expect(loaded?.history).toHaveLength(0)
  })
})

test("session.execution.started on superseded or reaped runs keeps state unchanged", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const superseded = baseRun({ id: "w-superseded-001", state: "superseded", sessionID: "ses_sup_001" })
    const reaped = baseRun({ id: "w-reaped-001", state: "reaped", sessionID: "ses_reap_001" })
    await saveRun(root, superseded)
    await saveRun(root, reaped)
    const sessions = recordSession()
    const res1 = await onSessionEvent(context({ session: sessions.domain }), root, {
      type: "session.execution.started",
      properties: { sessionID: "ses_sup_001" },
    })
    const res2 = await onSessionEvent(context({ session: sessions.domain }), root, {
      type: "session.execution.started",
      properties: { sessionID: "ses_reap_001" },
    })
    expect(res1).toBeUndefined()
    expect(res2).toBeUndefined()
    expect((await loadRun(root, superseded.id))?.state).toBe("superseded")
    expect((await loadRun(root, reaped.id))?.state).toBe("reaped")
  })
})

test("a resumed stopped run consumes the stop intent its stop already satisfied", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const parent = baseRun({
      id: "main-0000000000000001",
      role: "opus-orchestrator",
      kind: "main",
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      sessionID: "ses_parent_intent_001",
      children: ["w-0000000000000001"],
    })
    const child = intentRun("w-0000000000000001", "stopped", "ses_intent_001", { parent: parent.id, task: "T4" })
    await saveRun(root, parent)
    await saveRun(root, child)
    const sessions = recordSession()
    const ctx = context({ session: sessions.domain })

    const resumed = await onSessionEvent(ctx, root, startedEvent("ses_intent_001"))
    expect(resumed?.state).toBe("working")
    expect(resumed?.history[resumed.history.length - 1]).toMatchObject({
      from: "stopped",
      to: "working",
      trigger: "resume",
    })
    expect((await loadRun(root, child.id))?.stopRequested).toBeUndefined()

    const settled = await onSessionEvent(ctx, root, succeededEvent("ses_intent_001"))
    expect(settled?.state).toBe("idle")
    const stored = await loadRun(root, child.id)
    expect(stored?.state).toBe("idle")
    expect(stored?.stopRequested).toBeUndefined()
    expect(stored?.attempts[0]?.state).toBe("interrupted")
    expect(stored?.attempts[0]?.notified).toBe(true)

    const items = await peek(root, parent.id)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("child.settled")
    expect(items[0]?.from).toBe(child.id)
    expect(items[0]?.text).toContain("attempt 1 interrupted")

    // A repeated success neither re-stops the run nor notifies the parent twice.
    await onSessionEvent(ctx, root, succeededEvent("ses_intent_001"))
    expect((await loadRun(root, child.id))?.state).toBe("idle")
    expect(await peek(root, parent.id)).toHaveLength(1)
    expect(sessions.prompted).toHaveLength(0)
  })
})

test("a resumed dead run consumes the stop intent and settles idle after success", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const run = intentRun("w-0000000000000002", "dead", "ses_intent_002")
    await saveRun(root, run)
    const sessions = recordSession()
    const ctx = context({ session: sessions.domain })
    const resumed = await onSessionEvent(ctx, root, startedEvent("ses_intent_002"))
    expect(resumed?.state).toBe("working")
    expect(resumed?.history[resumed.history.length - 1]).toMatchObject({
      from: "dead",
      to: "working",
      trigger: "resume",
    })
    expect((await loadRun(root, run.id))?.stopRequested).toBeUndefined()
    const settled = await onSessionEvent(ctx, root, succeededEvent("ses_intent_002"))
    expect(settled?.state).toBe("idle")
    expect((await loadRun(root, run.id))?.state).toBe("idle")
  })
})

test("a resumed run stays usable: its queued followup starts the next attempt after success", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const run = intentRun("w-0000000000000003", "stopped", "ses_intent_003")
    await saveRun(root, run)
    await put(root, run.id, { kind: "followup", from: "main-0000000000000002", text: "Continue with the second half." })
    const sessions = recordSession()
    const ctx = context({ session: sessions.domain })

    await onSessionEvent(ctx, root, startedEvent("ses_intent_003"))
    const settled = await onSessionEvent(ctx, root, succeededEvent("ses_intent_003"))
    expect(settled?.state).toBe("working")
    expect(settled?.stopRequested).toBeUndefined()
    expect(settled?.attempts).toHaveLength(2)
    expect(settled?.attempts[1]).toMatchObject({ n: 2, state: "admitted", trigger: "followup" })
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]?.sessionID).toBe("ses_intent_003")
    expect(sessions.prompted[0]?.text).toBe("Continue with the second half.")
    expect(await peek(root, run.id)).toEqual([])

    const done = await onSessionEvent(ctx, root, succeededEvent("ses_intent_003"))
    expect(done?.state).toBe("idle")
    expect(done?.stopRequested).toBeUndefined()
    expect(done?.attempts[1]?.state).toBe("no_report")
  })
})

test("a stop intent on a starting run is not consumed by execution.started", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = new Date().toISOString()
    const run = baseRun({
      id: "w-0000000000000004",
      state: "starting",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      sessionID: "ses_intent_004",
      stopRequested: true,
    })
    await saveRun(root, run)
    const sessions = recordSession()
    const ctx = context({ session: sessions.domain })
    const working = await onSessionEvent(ctx, root, startedEvent("ses_intent_004"))
    expect(working?.state).toBe("working")
    expect((await loadRun(root, run.id))?.stopRequested).toBe(true)
    const stopped = await onSessionEvent(ctx, root, succeededEvent("ses_intent_004"))
    expect(stopped?.state).toBe("stopped")
    expect(stopped?.attempts[0]?.state).toBe("no_report")
  })
})

test("a stop intent on a working run still stops it when its turn succeeds", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const run = workingChild("w-0000000000000005", null, "ses_intent_005")
    await saveRun(root, { ...run, stopRequested: true })
    const sessions = recordSession()
    const stopped = await onSessionEvent(
      context({ session: sessions.domain }),
      root,
      succeededEvent("ses_intent_005"),
    )
    expect(stopped?.state).toBe("stopped")
    expect(stopped?.attempts[0]?.state).toBe("no_report")
    expect(sessions.prompted).toHaveLength(0)
  })
})

test("deliverInbox cannot resurrect a worktree another writer removed before save", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const child = baseRun({
      id: "w-6666666666666666",
      role: "muse-implementer",
      state: "idle",
      sessionID: "ses_child_resurrect_001",
      worktree: "present",
      attempts: [{ n: 1, state: "succeeded", startedAt: new Date().toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, child)
    await put(root, child.id, { kind: "followup", from: "main-0123456789abcdef", text: "New instructions." })

    const handed = await loadRun(root, child.id)
    expect(handed?.worktree).toBe("present")

    // The removal lands between the record deliverInbox was handed and its save
    await updateRun(root, child.id, (current) => ({ ...current, worktree: "removed" }))
    expect((await loadRun(root, child.id))?.worktree).toBe("removed")

    const sessions = recordSession()
    await deliverInbox(context({ session: sessions.domain }), root, handed!)

    const stored = await loadRun(root, child.id)
    expect(stored?.worktree).toBe("removed")
    expect(stored?.state).toBe("working")
    expect(stored?.attempts).toHaveLength(2)
    expect(stored?.attempts[1]?.state).toBe("admitted")
  })
})

test("deliverInbox prompt error path cannot resurrect a worktree removed while in flight", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const child = baseRun({
      id: "w-7777777777777777",
      role: "muse-implementer",
      state: "idle",
      sessionID: "ses_child_resurrect_002",
      worktree: "present",
      attempts: [{ n: 1, state: "succeeded", startedAt: new Date().toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, child)
    await put(root, child.id, { kind: "followup", from: "main-0123456789abcdef", text: "Failing instructions." })

    const handed = await loadRun(root, child.id)
    expect(handed?.worktree).toBe("present")

    // The prompt fails, and while prompt is in flight, a removal lands
    const failingSession = {
      prompt: () =>
        Effect.promise(async () => {
          await updateRun(root, child.id, (current) => ({ ...current, worktree: "removed" }))
          throw new Error("simulated prompt failure")
        }),
      wait: () => Effect.succeed(undefined),
    } as unknown as SessionDomain

    await deliverInbox(context({ session: failingSession }), root, handed!).catch(() => undefined)

    const stored = await loadRun(root, child.id)
    expect(stored?.worktree).toBe("removed")
    expect(stored?.state).toBe("idle")
    expect(stored?.attempts).toHaveLength(1)
  })
})

