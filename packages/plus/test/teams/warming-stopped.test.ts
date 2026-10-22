import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionWarming } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { createState, decideWarmingFor } from "../../src/index.js"
import { saveRun, updateRun, type RunRecord } from "../../src/teams/run.js"
import { warmingStore } from "../../src/warming.js"

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-warming-teams-"))
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

test("a landed child's removed worktree ends warming and reopening permits a fresh window", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = Date.now()
    const run = baseRun({ id: "w-landed-warm", sessionID: "ses_landed_warm", parent: "main-parent", worktree: "removed" })
    await saveRun(root, run)
    const state = { ...createState(), warmingCheckedAt: now }
    const event: SessionWarming = {
      sessionID: Session.ID.make(run.sessionID!),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "activity", since: now, now,
      settings: { prompt: "ping", interval: 60000, duration: 300000 },
    }
    await warmingStore.decide(event, {})
    for (const phase of ["warm", "resume"] as const) {
      const ping = { ...event, phase }
      await Effect.runPromise(decideWarmingFor(context(), state, ping))
      expect(ping.settings).toBeUndefined()
      expect((await warmingStore.status(event.sessionID, now)).active).toBe(false)
    }
    await updateRun(root, run.id, (current) => ({
      ...current, worktree: "present", directory: path.join(root, "reopened"),
      history: [{ at: new Date(now + 1000).toISOString(), from: "idle", to: "idle", trigger: "reopened" }],
    }))
    const resumed = { ...event, phase: "resume" as const, now: now + 1000 }
    await Effect.runPromise(decideWarmingFor(context(), state, resumed))
    expect(resumed.settings).toBeUndefined()
    const reopened = { ...event, since: now + 1000, now: now + 1000 }
    await Effect.runPromise(decideWarmingFor(context(), state, reopened))
    expect(reopened.settings).toBeDefined()
    const ping = { ...reopened, phase: "warm" as const, now: now + 61000 }
    await Effect.runPromise(decideWarmingFor(context(), state, ping))
    expect(ping.settings).toBeDefined()
    expect((await warmingStore.status(event.sessionID, now + 61000)).active).toBe(true)
  })
})

test("a stopped run keeps warming until expires, and then stops", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = 1000000
    const stoppedRun = baseRun({
      id: "w-stopped-keep-warm",
      state: "stopped",
      sessionID: "ses_stopped_keep_warm",
    })
    await saveRun(root, stoppedRun)

    const dummyState = { ...createState(), warmingCheckedAt: Date.now() }
    const dummyCtx = context()

    const primeEvent = {
      sessionID: Session.ID.make("ses_stopped_keep_warm"),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm" as const,
      since: now,
      now,
      settings: { prompt: "ping", interval: 60000, duration: 300000 },
    }
    await warmingStore.decide(primeEvent, {})

    const midEvent = {
      sessionID: Session.ID.make("ses_stopped_keep_warm"),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm" as const,
      since: now,
      now: now + 60000,
      settings: { prompt: "ping", interval: 60000, duration: 300000 },
    }
    await Effect.runPromise(decideWarmingFor(dummyCtx, dummyState, midEvent))
    expect(midEvent.settings).toBeDefined()
    expect(midEvent.settings?.duration).toBe(300000)

    const expiredEvent = {
      sessionID: Session.ID.make("ses_stopped_keep_warm"),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm" as const,
      since: now,
      now: now + 301000,
      settings: { prompt: "ping", interval: 60000, duration: 300000 },
    }
    await Effect.runPromise(decideWarmingFor(dummyCtx, dummyState, expiredEvent))
    expect(expiredEvent.settings).toBeUndefined()
  })
})

test("a ping into an unloaded folder does not boot it", async () => {
  await withIsolatedTeamsRoot(async () => {
    const now = 1000000
    const dummyState = { ...createState(), warmingCheckedAt: Date.now() }
    // A location whose services are dropped: a warm ping must not boot it.
    const dummyCtx = context({ locations: { evict: () => Effect.void, loaded: () => Effect.succeed(false) } })
    const event = {
      sessionID: Session.ID.make("ses_unloaded_warm"),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm" as const,
      since: now,
      now,
      settings: { prompt: "ping", interval: 60000, duration: 300000 },
    }
    await Effect.runPromise(decideWarmingFor(dummyCtx, dummyState, event))
    expect(event.settings).toBeUndefined()
  })
})

test("a ping into a loaded folder keeps warming", async () => {
  await withIsolatedTeamsRoot(async () => {
    const now = 1000000
    const dummyState = { ...createState(), warmingCheckedAt: Date.now() }
    const dummyCtx = context({ locations: { evict: () => Effect.void, loaded: () => Effect.succeed(true) } })
    const event = {
      sessionID: Session.ID.make("ses_loaded_warm"),
      agent: Agent.ID.make("implementer"),
      model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
      phase: "warm" as const,
      since: now,
      now,
      settings: { prompt: "ping", interval: 60000, duration: 300000 },
    }
    await Effect.runPromise(decideWarmingFor(dummyCtx, dummyState, event))
    expect(event.settings).toBeDefined()
  })
})

test("dead, superseded and reaped runs stop warming immediately", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = 1000000
    for (const state of ["dead", "superseded", "reaped"] as const) {
      const run = baseRun({
        id: `w-${state}-test`,
        state,
        sessionID: `ses_${state}_test`,
      })
      await saveRun(root, run)

      const primeEvent = {
        sessionID: Session.ID.make(`ses_${state}_test`),
        agent: Agent.ID.make("implementer"),
        model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
        phase: "warm" as const,
        since: now,
        now,
        settings: { prompt: "ping", interval: 60000, duration: 300000 },
      }
      await warmingStore.decide(primeEvent, {})

      const dummyState = { ...createState(), warmingCheckedAt: Date.now() }
      const dummyCtx = context()

      const checkEvent = {
        sessionID: Session.ID.make(`ses_${state}_test`),
        agent: Agent.ID.make("implementer"),
        model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("gemini-3.8-flash-high") }),
        phase: "warm" as const,
        since: now,
        now: now + 5000,
        settings: { prompt: "ping", interval: 60000, duration: 300000 },
      }
      await Effect.runPromise(decideWarmingFor(dummyCtx, dummyState, checkEvent))
      expect(checkEvent.settings).toBeUndefined()
    }
  })
})

// Pacer has decided the chat's account cannot serve its next step (it compacts and moves): keep-alives
// would spend the account's last usage on a cache the move does not reuse.
test("a keep-alive on an account Pacer gave up stops, unless the account serves again within 10 minutes", async () => {
  await withIsolatedTeamsRoot(async () => {
    const MINUTE = 60_000
    const now = Date.now()
    const sessionID = Session.ID.make("ses_used_up_warm")
    const model = Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make("claude-opus-5-5") })
    const ping = () => ({
      sessionID,
      agent: Agent.ID.make("build"),
      model,
      phase: "warm" as const,
      since: now - MINUTE,
      now,
      settings: { prompt: "ping", interval: 4 * MINUTE, duration: 32 * MINUTE },
    })
    const ctx = context({ locations: { evict: () => Effect.void, loaded: () => Effect.succeed(true) } })
    const state = { ...createState(), warmingCheckedAt: Date.now() }
    const asked: unknown[] = []
    const keepAlive = async (answer: { servesAt?: number } | undefined) => {
      const event = ping()
      await Effect.runPromise(
        decideWarmingFor(ctx, state, event, async (query) => {
          asked.push(query)
          return answer
        }),
      )
      return event.settings
    }
    await warmingStore.decide(ping(), {})
    // Not used up, or serving again in 8 minutes: the chat keeps warming and may stay on its account.
    expect(await keepAlive(undefined)).toBeDefined()
    expect(await keepAlive({ servesAt: now + 8 * MINUTE })).toBeDefined()
    expect(await keepAlive({ servesAt: now + 10 * MINUTE })).toBeDefined()
    expect((await warmingStore.status(sessionID, now)).active).toBe(true)
    expect(asked[0]).toEqual({ sessionID, providerID: "cliproxyapi", modelID: "claude-opus-5-5" })
    // 11 minutes away: warming stops and its window ends.
    expect(await keepAlive({ servesAt: now + 11 * MINUTE })).toBeUndefined()
    expect((await warmingStore.status(sessionID, now + 1)).active).toBe(false)
    // Pacer does not say when: it stops too.
    await warmingStore.decide(ping(), {})
    expect(await keepAlive({})).toBeUndefined()
    expect((await warmingStore.status(sessionID, now + 1)).active).toBe(false)
  })
})
