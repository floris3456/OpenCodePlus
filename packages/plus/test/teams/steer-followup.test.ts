import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { teamState } from "./preset-table.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { warmingStore } from "../../src/warming.js"
import { consumeColdCompaction, isSessionWarm } from "../../src/teams/cold-compaction.js"

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-steer-"))
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp
  try {
    return await fn(path.join(tmp, "opencode", "opencodeplus", "teams"))
  } finally {
    if (prior === undefined) delete process.env.XDG_DATA_HOME
    if (prior !== undefined) process.env.XDG_DATA_HOME = prior
    await fs.rm(tmp, { recursive: true, force: true })
  }
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
    bundle: "team-test",
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

test("followup to a working child is delivered as a steer at next step boundary", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = new Date().toISOString()
    const child = baseRun({
      id: "w-working-child",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_working_child",
      state: "working",
      attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)

    const prompted: Array<{ sessionID: unknown; text: unknown; delivery: unknown }> = []
    const ctx = context({
      session: {
        get: () => Effect.succeed({ id: Session.ID.make(child.sessionID!) }),
        prompt: (req: { sessionID: unknown; text: unknown; delivery?: unknown }) => {
          prompted.push({ sessionID: req.sessionID, text: req.text, delivery: req.delivery })
          return Effect.succeed(undefined as never)
        },
      } as unknown as SessionDomain,
    })

    const api = createTeamApi(ctx, teamState())
    const res = await api.followup(
      { run: child.id, requestID: "f-steer-1", prompt: "Nudge: steer this now" },
      callerFor(parent),
    )

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value).toEqual({ attempt: 1, state: "queued", next: "End your turn: its settlement wakes you." })
    }

    expect(prompted).toHaveLength(1)
    expect(prompted[0]?.delivery).toBe("steer")
    expect(prompted[0]?.text).toBe("Nudge: steer this now")
  })
})

test("warm stopped child resumes with followup without compaction", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = Date.now()
    const child = baseRun({
      id: "w-stopped-warm",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_stopped_warm",
      state: "stopped",
      stoppedBy: parent.id,
      attempts: [{ n: 1, state: "failed", startedAt: new Date(now - 10000).toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)

    const event = {
      sessionID: Session.ID.make(child.sessionID!),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm" as const,
      since: now - 5000,
      now,
      settings: { prompt: "ping", interval: 60000, duration: 300000 },
    }
    await warmingStore.decide(event, {})

    let compactCalled = false
    let promptCalled = false
    const ctx = context({
      session: {
        get: () => Effect.succeed({ id: Session.ID.make(child.sessionID!) }),
        compact: () => {
          compactCalled = true
          return Effect.succeed(undefined as never)
        },
        prompt: () => {
          promptCalled = true
          return Effect.succeed(undefined as never)
        },
      } as unknown as SessionDomain,
    })

    const api = createTeamApi(ctx, teamState())
    const res = await api.followup(
      { run: child.id, requestID: "f-warm-1", prompt: "Resume warm child" },
      callerFor(parent),
    )

    expect(res.ok).toBe(true)
    expect(compactCalled).toBe(false)
    expect(promptCalled).toBe(true)
    const updated = await loadRun(root, child.id)
    expect(updated?.state).toBe("working")
    expect(updated?.attempts).toHaveLength(2)
  })
})

test("cold stopped child without compactWith is refused naming compactWith", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = Date.now()
    const child = baseRun({
      id: "w-stopped-cold",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_stopped_cold",
      state: "stopped",
      stoppedBy: parent.id,
      attempts: [{ n: 1, state: "failed", startedAt: new Date(now - 500000).toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)

    const event = {
      sessionID: Session.ID.make(child.sessionID!),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm" as const,
      since: now - 400000,
      now: now - 400000,
      settings: { prompt: "ping", interval: 60000, duration: 120000 },
    }
    await warmingStore.decide(event, {})

    const ctx = context({
      session: {
        get: () => Effect.succeed({ id: Session.ID.make(child.sessionID!) }),
      } as unknown as SessionDomain,
    })

    const api = createTeamApi(ctx, teamState())
    const res = await api.followup(
      { run: child.id, requestID: "f-cold-1", prompt: "Resume cold child without compactWith" },
      callerFor(parent),
    )

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe("E_STOPPED")
      expect(res.error.message).toContain("compactWith")
    }
  })
})

test("cold stopped child with compactWith runs one compaction then resumes", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = Date.now()
    const child = baseRun({
      id: "w-stopped-cold-compact",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_stopped_cold_compact",
      state: "stopped",
      stoppedBy: parent.id,
      attempts: [{ n: 1, state: "failed", startedAt: new Date(now - 500000).toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)

    const event = {
      sessionID: Session.ID.make(child.sessionID!),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm" as const,
      since: now - 400000,
      now: now - 400000,
      settings: { prompt: "ping", interval: 60000, duration: 120000 },
    }
    await warmingStore.decide(event, {})

    let compactionModelsUsed: readonly string[] | undefined
    let promptCalled = false
    const ctx = context({
      session: {
        get: () => Effect.succeed({ id: Session.ID.make(child.sessionID!) }),
        compact: () => {
          compactionModelsUsed = consumeColdCompaction(child.sessionID!)
          return Effect.succeed(undefined as never)
        },
        prompt: () => {
          promptCalled = true
          return Effect.succeed(undefined as never)
        },
      } as unknown as SessionDomain,
    })

    const api = createTeamApi(ctx, teamState())
    const res = await api.followup(
      {
        run: child.id,
        requestID: "f-cold-compact-1",
        prompt: "Resume cold child after compacting",
        compactWith: "cliproxyapi/deepseek-v4.1-flash-cheap",
      },
      callerFor(parent),
    )

    expect(res.ok).toBe(true)
    expect(compactionModelsUsed).toEqual(["cliproxyapi/deepseek-v4.1-flash-cheap"])
    expect(promptCalled).toBe(true)
    const updated = await loadRun(root, child.id)
    expect(updated?.state).toBe("working")
    expect(updated?.attempts).toHaveLength(2)
  })
})

test("child whose model has no warming configured counts as warm", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = Date.now()
    const child = baseRun({
      id: "w-stopped-no-warming",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_no_warming",
      state: "stopped",
      stoppedBy: parent.id,
      attempts: [{ n: 1, state: "failed", startedAt: new Date(now - 500000).toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)

    const warm = await isSessionWarm(child.sessionID!)
    expect(warm).toBe(true)

    let compactCalled = false
    let promptCalled = false
    const ctx = context({
      session: {
        get: () => Effect.succeed({ id: Session.ID.make(child.sessionID!) }),
        compact: () => {
          compactCalled = true
          return Effect.succeed(undefined as never)
        },
        prompt: () => {
          promptCalled = true
          return Effect.succeed(undefined as never)
        },
      } as unknown as SessionDomain,
    })

    const api = createTeamApi(ctx, teamState())
    const res = await api.followup(
      { run: child.id, requestID: "f-no-warm-1", prompt: "Resume stopped child without warming" },
      callerFor(parent),
    )

    expect(res.ok).toBe(true)
    expect(compactCalled).toBe(false)
    expect(promptCalled).toBe(true)
  })
})
