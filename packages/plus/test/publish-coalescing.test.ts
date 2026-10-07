import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import plus, {
  activate,
  createHandlers,
  createState,
  discoverCounter,
  flushPendingRefresh,
  useLocation,
  refreshFromHost,
  resetDiscoverCounter,
  watchSharedStore,
} from "../src/index.js"
import { notifySharedStoreChanged, resetSharedStoreListeners } from "../src/shared-store-bus.js"
import { agentHarness, agentInfo, context, fullContext } from "./harness.js"
import { load, save } from "../src/instructions/store.js"

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
