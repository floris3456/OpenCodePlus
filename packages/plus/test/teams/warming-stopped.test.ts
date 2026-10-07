import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { decideWarmingFor, type PlusState } from "../../src/index.js"
import { saveRun, type RunRecord } from "../../src/teams/run.js"
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

test("a stopped run keeps warming until expires, and then stops", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const now = 1000000
    const stoppedRun = baseRun({
      id: "w-stopped-keep-warm",
      state: "stopped",
      sessionID: "ses_stopped_keep_warm",
    })
    await saveRun(root, stoppedRun)

    const dummyState = {
      warmingCheckedAt: now,
      cachedAgents: [],
      cachedModels: [],
      cachedModelSettings: [],
      cachedScopes: [],
    } as unknown as PlusState
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
    const dummyState = {
      warmingCheckedAt: now,
      cachedAgents: [],
      cachedModels: [],
      cachedModelSettings: [],
      cachedScopes: [],
    } as unknown as PlusState
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
    const dummyState = {
      warmingCheckedAt: now,
      cachedAgents: [],
      cachedModels: [],
      cachedModelSettings: [],
      cachedScopes: [],
    } as unknown as PlusState
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

      const dummyState = {
        warmingCheckedAt: now,
        cachedAgents: [],
        cachedModels: [],
        cachedModelSettings: [],
        cachedScopes: [],
      } as unknown as PlusState
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
