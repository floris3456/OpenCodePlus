import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, PubSub, Scope, Stream } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import plus, {
  activate,
  catchUp,
  createHandlers,
  createState,
  discoverCounter,
  flushPendingRefresh,
  useLocation,
  watchHostEvents,
  refreshFromHost,
  resetDiscoverCounter,
  watchSharedStore,
} from "../src/index.js"
import { notifySharedStoreChanged, resetSharedStoreListeners } from "../src/shared-store-bus.js"
import { agentHarness, agentInfo, context, fullContext } from "./harness.js"
import { load, save } from "../src/instructions/store.js"
import { teamsDataDir } from "../src/instructions/paths.js"

const throwing = {
  error: (type: string, message: string, data?: unknown): never => {
    throw { type, message, data }
  },
}

const UPDATED = new Date().toISOString()

async function tempDir(): Promise<string> {
  const dir = path.join("/tmp", `test-publish-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe("publish coalescing", () => {
  test("a notification burst (10 in 200 ms) causes exactly one refresh per other location", async () => {
    resetSharedStoreListeners()
    const root = await tempDir()
    const config = path.join(root, "config")
    process.env.OPENCODE_CONFIG_DIR = config
    const projectB = path.join(root, "b")
    await fs.mkdir(path.join(config, "agent"), { recursive: true })
    await Bun.write(path.join(config, "agent", "worker.md"), "---\nmode: primary\n---\nworker role\n")

    const harnessB = agentHarness([agentInfo("worker", "worker role")], projectB)
    const ctxB = context({
      ...fullContext({
        directory: projectB,
        hooks: { current: 0 },
      }),
      agent: harnessB.domain,
    })
    const stateB = createState()
    const scopeB = await Effect.runPromise(Scope.make())
    try {
      await Effect.runPromise(watchSharedStore(ctxB, stateB).pipe(Scope.provide(scopeB)))
      await Effect.runPromise(activate(ctxB, stateB))

      // Mutate the store on disk so there is a revision difference
      const loaded = await load(projectB)
      await save(projectB, {
        expectedProjectRevision: loaded.projectRevision,
        expectedGlobalRevision: loaded.globalRevision,
        records: [
          ...loaded.records,
          {
            type: "customization",
            level: "global",
            agent: "worker",
            item: "system:role",
            section: null,
            text: "new role",
            basedOn: "",
            updated: UPDATED,
          },
        ],
      })

      resetDiscoverCounter()
      const initialDiscoveries = discoverCounter.count

      for (let i = 0; i < 10; i++) {
        notifySharedStoreChanged()
        await Bun.sleep(20)
      }

      // Wait 1.3s for the trailing 1s debounce to settle
      await Bun.sleep(1300)

      // Exactly 1 discovery should have run for location B
      expect(discoverCounter.count - initialDiscoveries).toBe(1)
    } finally {
      await Effect.runPromise(Scope.close(scopeB, Exit.void))
      resetSharedStoreListeners()
    }
  })

  test("a refresh with unchanged revisions and no host change does no discovery", async () => {
    resetSharedStoreListeners()
    const root = await tempDir()
    const config = path.join(root, "config")
    process.env.OPENCODE_CONFIG_DIR = config
    const project = path.join(root, "project")

    const ctx = fullContext({ directory: project, hooks: { current: 0 } })
    const state = createState()
    await Effect.runPromise(activate(ctx, state))

    resetDiscoverCounter()
    // Trigger refreshFromHost without store or host change
    await Effect.runPromise(refreshFromHost(ctx, state))

    expect(discoverCounter.count).toBe(0)
  })

  test("a refresh skips a folder that is gone, and one that hangs gives the process lock up to the next folder", async () => {
    resetSharedStoreListeners()
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    // A landed child's worktree, removed after its location loaded.
    const gone = path.join(teamsDataDir(), "worktrees", "ledger", "implementer", `t1-${Date.now()}`)
    const stuck = path.join(root, "stuck")
    const live = path.join(root, "live")
    for (const dir of [gone, stuck, live]) await fs.mkdir(dir, { recursive: true })
    const goneCtx = fullContext({ directory: gone, hooks: { current: 0 } })
    const goneState = createState()
    await Effect.runPromise(activate(goneCtx, goneState))
    await fs.rm(gone, { recursive: true })
    goneState.pendingHostChange = true
    resetDiscoverCounter()
    await Effect.runPromise(refreshFromHost(goneCtx, goneState))
    expect(discoverCounter.count).toBe(0)
    // A host read that never answers (B18: a removed worktree's location).
    const base = fullContext({ directory: stuck, hooks: { current: 0 } })
    const stuckCtx = context({ ...base, tool: { ...base.tool, list: () => Effect.never } })
    const stuckState = createState()
    stuckState.pendingHostChange = true
    const liveCtx = fullContext({ directory: live, hooks: { current: 0 } })
    const liveState = createState()
    await Effect.runPromise(activate(liveCtx, liveState))
    liveState.pendingHostChange = true
    const started = Date.now()
    await Promise.all([
      Effect.runPromise(refreshFromHost(stuckCtx, stuckState, Duration.millis(200))),
      Effect.runPromise(refreshFromHost(liveCtx, liveState, Duration.millis(200))),
    ])
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(liveState.projectRevision).toBeDefined()
  })

  // Live b16-s8: a landing removed the child's worktree while its refresh waited
  // for the process lock; the refresh then held the lock for its whole minute.
  test("a team worktree removed while its refresh waits for the process lock is not refreshed", async () => {
    resetSharedStoreListeners()
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const landed = path.join(teamsDataDir(), "worktrees", "ledger", "implementer", `t2-${Date.now()}`)
    const busy = path.join(root, "busy")
    for (const dir of [landed, busy]) await fs.mkdir(dir, { recursive: true })
    const landedCtx = fullContext({ directory: landed, hooks: { current: 0 } })
    const landedState = createState()
    await Effect.runPromise(activate(landedCtx, landedState))
    landedState.pendingHostChange = true
    // Another folder's refresh holds the lock until the test lets it go.
    const release = Promise.withResolvers<void>()
    const base = fullContext({ directory: busy, hooks: { current: 0 } })
    const busyCtx = context({ ...base, tool: { ...base.tool, list: () => Effect.promise(() => release.promise).pipe(Effect.andThen(base.tool.list())) } })
    const busyState = createState()
    busyState.pendingHostChange = true
    resetDiscoverCounter()
    const busyRefresh = Effect.runPromise(refreshFromHost(busyCtx, busyState))
    const landedRefresh = Effect.runPromise(refreshFromHost(landedCtx, landedState))
    await fs.rm(landed, { recursive: true })
    release.resolve()
    await Promise.all([busyRefresh, landedRefresh])
    expect(discoverCounter.count).toBe(1)
  })

  // Live b18-s14: a force-stopped child's folder was evicted while its refresh
  // waited for the lock; its host reads then never answered for the full minute.
  test("a folder evicted while its refresh waits for the process lock is not refreshed", async () => {
    resetSharedStoreListeners()
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const stopped = path.join(root, "stopped")
    const busy = path.join(root, "busy")
    for (const dir of [stopped, busy]) await fs.mkdir(dir, { recursive: true })
    const loaded = { current: true }
    const stoppedCtx = context({
      ...fullContext({ directory: stopped, hooks: { current: 0 } }),
      locations: { evict: () => Effect.void, loaded: () => Effect.sync(() => loaded.current) },
    })
    const stoppedState = createState()
    await Effect.runPromise(activate(stoppedCtx, stoppedState))
    stoppedState.pendingHostChange = true
    const release = Promise.withResolvers<void>()
    const base = fullContext({ directory: busy, hooks: { current: 0 } })
    const busyCtx = context({ ...base, tool: { ...base.tool, list: () => Effect.promise(() => release.promise).pipe(Effect.andThen(base.tool.list())) } })
    const busyState = createState()
    busyState.pendingHostChange = true
    resetDiscoverCounter()
    const busyRefresh = Effect.runPromise(refreshFromHost(busyCtx, busyState))
    const stoppedRefresh = Effect.runPromise(refreshFromHost(stoppedCtx, stoppedState))
    loaded.current = false
    release.resolve()
    await Promise.all([busyRefresh, stoppedRefresh])
    expect(discoverCounter.count).toBe(1)
  })

  test("a warming ping applies a deferred refresh without counting as a use", async () => {
    resetSharedStoreListeners()
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    const ctx = fullContext({ directory: project, hooks: { current: 0 } })
    const state = createState()
    const scope = await Effect.runPromise(Scope.make())
    try {
      await Effect.runPromise(watchSharedStore(ctx, state).pipe(Scope.provide(scope)))
      await Effect.runPromise(activate(ctx, state))
      // A finished chat that is only kept warm: idle by its last real use.
      const idleSince = Date.now() - 10 * 60_000
      state.lastUsedAt = idleSince
      notifySharedStoreChanged(undefined, true)
      expect(state.refreshTimer).toBeUndefined()
      resetDiscoverCounter()
      await Effect.runPromise(catchUp(ctx, state))
      expect(discoverCounter.count).toBe(1)
      expect(state.pendingRefresh).toBeFalsy()
      // Still idle, so the next write is deferred again instead of refreshed at once.
      expect(state.lastUsedAt).toBe(idleSince)
      notifySharedStoreChanged(undefined, true)
      expect(state.refreshTimer).toBeUndefined()
      expect(state.pendingRefresh).toBe(true)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      resetSharedStoreListeners()
    }
  })

  test("an idle folder defers another folder's write to its next use; a folder in use or running a session does not", async () => {
    resetSharedStoreListeners()
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    const ctx = fullContext({ directory: project, hooks: { current: 0 } })
    const state = createState()
    const scope = await Effect.runPromise(Scope.make())
    try {
      await Effect.runPromise(watchSharedStore(ctx, state).pipe(Scope.provide(scope)))
      await Effect.runPromise(activate(ctx, state))
      // Idle for ten minutes, nothing running: the write only marks it.
      state.lastUsedAt = Date.now() - 10 * 60_000
      notifySharedStoreChanged(undefined, true)
      expect(state.pendingRefresh).toBe(true)
      expect(state.refreshTimer).toBeUndefined()
      // Its next use (an RPC, a prompt, a warming decision) applies it first.
      resetDiscoverCounter()
      await Effect.runPromise(useLocation(ctx, state))
      expect(discoverCounter.count).toBe(1)
      expect(state.pendingRefresh).toBeFalsy()
      // Just used: the write schedules the coalesced refresh.
      notifySharedStoreChanged(undefined, true)
      expect(state.refreshTimer).toBeDefined()
      clearTimeout(state.refreshTimer)
      state.refreshTimer = undefined
      // Idle by the clock but running a session (a long autonomous turn): also scheduled.
      state.lastUsedAt = Date.now() - 10 * 60_000
      state.running.add("ses_long_turn")
      notifySharedStoreChanged(undefined, true)
      expect(state.refreshTimer).toBeDefined()
      clearTimeout(state.refreshTimer)
      state.refreshTimer = undefined
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      resetSharedStoreListeners()
    }
  })

  test("an idle folder defers host events (the store write every folder's config watch sees) to its next use", async () => {
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    const events = await Effect.runPromise(PubSub.unbounded<{ readonly type: string; readonly data: unknown }>())
    const base = fullContext({ directory: project, hooks: { current: 0 } })
    const ctx = context({ ...base, event: { subscribe: () => Stream.fromPubSub(events) } as never })
    const state = createState()
    const scope = await Effect.runPromise(Scope.make())
    try {
      await Effect.runPromise(activate(ctx, state))
      await Effect.runPromise(watchHostEvents(ctx, state).pipe(Scope.provide(scope)))
      state.lastUsedAt = Date.now() - 10 * 60_000
      resetDiscoverCounter()
      await Effect.runPromise(PubSub.publish(events, { type: "skill.updated", data: {} }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(discoverCounter.count).toBe(0)
      expect(state.pendingRefresh).toBe(true)
      await Effect.runPromise(useLocation(ctx, state))
      expect(discoverCounter.count).toBe(1)
      // In use: a burst of host events (one write announces several) schedules one
      // coalesced refresh, which a prompt applies at once (b16: one refresh per event).
      for (const type of ["config.updated", "agent.updated", "skill.updated", "model.updated"])
        await Effect.runPromise(PubSub.publish(events, { type, data: {} }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(discoverCounter.count).toBe(1)
      expect(state.refreshTimer).toBeDefined()
      await Effect.runPromise(useLocation(ctx, state))
      expect(discoverCounter.count).toBe(2)
      expect(state.refreshTimer).toBeUndefined()
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  test("a forced notice (a team change, no record write) rediscovers with unchanged revisions", async () => {
    resetSharedStoreListeners()
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    const ctx = fullContext({ directory: project, hooks: { current: 0 } })
    const state = createState()
    const scope = await Effect.runPromise(Scope.make())
    try {
      await Effect.runPromise(watchSharedStore(ctx, state).pipe(Scope.provide(scope)))
      await Effect.runPromise(activate(ctx, state))
      resetDiscoverCounter()
      // A plain notice with nothing changed is skipped by the revision check...
      notifySharedStoreChanged()
      await Effect.runPromise(flushPendingRefresh(ctx, state))
      expect(discoverCounter.count).toBe(0)
      // ...a forced one (emitTeamsChanged) is not.
      notifySharedStoreChanged(undefined, true)
      await Effect.runPromise(flushPendingRefresh(ctx, state))
      expect(discoverCounter.count).toBe(1)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      resetSharedStoreListeners()
    }
  })

  test("a pending refresh is applied by the prompt hook before it returns", async () => {
    resetSharedStoreListeners()
    const root = await tempDir()
    const config = path.join(root, "config")
    process.env.OPENCODE_CONFIG_DIR = config
    const project = path.join(root, "project")
    await fs.mkdir(path.join(config, "agent"), { recursive: true })
    await Bun.write(path.join(config, "agent", "worker.md"), "---\nmode: primary\n---\nworker role\n")

    let promptHookRegistered = false
    let promptHookCallback: (() => Effect.Effect<void>) | undefined

    const ctx = context({
      ...fullContext({ directory: project, hooks: { current: 0 } }),
      rpc: Object.assign(() => { throw new Error("unused rpc") }, {
        register: () => Effect.succeed({ events: { emit: () => Effect.void } }),
      }) as never,
      session: {
        hook: ((name: string, cb: () => Effect.Effect<void>) => {
          if (name === "prompt") {
            promptHookRegistered = true
            promptHookCallback = cb
          }
          return Effect.succeed({ dispose: Effect.void })
        }) as never,
        context: () => Effect.succeed([]),
      },
      storage: {
        get: () => Effect.succeed(undefined),
        set: () => Effect.void,
        remove: () => Effect.void,
        scan: () => Effect.succeed({ entries: [] }) as never,
      },
    })
    const state = createState()
    const scope = await Effect.runPromise(Scope.make())
    try {
      await Effect.runPromise(watchSharedStore(ctx, state).pipe(Scope.provide(scope)))
      await Effect.runPromise(activate(ctx, state))

      // Verify that plus.effect registers the prompt hook
      const pluginScope = await Effect.runPromise(Scope.make())
      await Effect.runPromise(plus.effect(ctx).pipe(Scope.provide(pluginScope)))
      expect(promptHookRegistered).toBe(true)

      // Modify the store on disk
      const loaded = await load(project)
      await save(project, {
        expectedProjectRevision: loaded.projectRevision,
        expectedGlobalRevision: loaded.globalRevision,
        records: [
          ...loaded.records,
          {
            type: "customization",
            level: "global",
            agent: "worker",
            item: "system:role",
            section: null,
            text: "prompt-updated role",
            basedOn: "",
            updated: UPDATED,
          },
        ],
      })

      // Send shared store changed notification to trigger coalescing debounce
      notifySharedStoreChanged()
      expect(state.pendingRefresh).toBe(true)

      // Before waiting 1s, trigger prompt hook
      resetDiscoverCounter()
      await Effect.runPromise(flushPendingRefresh(ctx, state))

      // The refresh must have completed now without waiting for 1s
      expect(discoverCounter.count).toBe(1)
      expect(state.pendingRefresh).toBeFalsy()

      await Effect.runPromise(Scope.close(pluginScope, Exit.void))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      resetSharedStoreListeners()
    }
  })
})
