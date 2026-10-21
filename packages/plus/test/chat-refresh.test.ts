import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { activate, createHandlers, createState, refreshFolderForNewChat } from "../src/index.js"
import { createPlanSet, SessionPinManager } from "../src/instructions/cache-safe.js"
import { agentHarness, agentInfo, context, fullContext, memoryStorage, toolHarness } from "./harness.js"

const throwing = {
  error: (type: string, message: string, data?: unknown): never => {
    throw { type, message, data }
  },
}

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "plus-chat-refresh-"))
  return dir
}

describe("chat.refresh", () => {
  test("reloads this folder's config-backed domains and reports the re-read cost", async () => {
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })

    const harness = agentHarness([agentInfo("build", "build role")], project)
    const ctx = context({
      ...fullContext({ directory: project, hooks: { current: 0 } }),
      agent: harness.domain,
    })
    const state = createState()
    await Effect.runPromise(activate(ctx, state))
    const handlers = createHandlers(ctx, state)

    const reloadsBefore = harness.reloads
    const result = await Effect.runPromise(handlers["chat.refresh"]({ sessionID: "ses_refresh" }, throwing))
    // A refresh reloads the host's config-backed domains; the agent reload is
    // one of them. A domain the harness cannot reload is skipped and logged,
    // not allowed to abort the others.
    expect(harness.reloads).toBeGreaterThan(reloadsBefore)
    expect(result.reloaded).toContain("config")
    expect(result.reloaded).toContain("agents")
    expect(result.reloaded).toContain("skills")
    expect(result.reloaded).toContain("mcp")
    expect(typeof result.revision).toBe("number")
    expect(typeof result.globalRevision).toBe("number")
    // With no measured last request, the cost is zero and names no cache.
    expect(result.reReadTokens).toBe(0)
    expect(result.withoutCache).toBe(false)
  })

  test("a refresh makes the chat's next request pin what it published, even after Plus re-activates", async () => {
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })

    const harness = agentHarness([agentInfo("build", "build role")], project)
    const ctx = context({
      ...fullContext({ directory: project, hooks: { current: 0 } }),
      agent: harness.domain,
    })
    const { storage } = memoryStorage()
    const state = createState(storage)
    await Effect.runPromise(activate(ctx, state))
    const plans = state.currentPlanSet ?? createPlanSet({
      roles: new Map(),
      base: [],
      native: [],
      instructions: [],
      scrubByAgent: new Map(),
      needsNarrowing: false,
      permissions: { toolEnabled: () => false, rows: () => [], toolRows: () => [], ruleRows: () => [], teamMembers: new Set(), describe: () => undefined },
      customByAgent: new Set(),
    })
    const model = { providerID: "anthropic", id: "claude-3-5-sonnet" }
    // The chat was pinned by an earlier Plus instance, and is not in this one's memory.
    const earlier = new SessionPinManager(storage)
    await Effect.runPromise(earlier.save(earlier.pinSession("ses_refresh_pin", model, plans), "build"))
    const handlers = createHandlers(ctx, state)

    await Effect.runPromise(handlers["chat.refresh"]({ sessionID: "ses_refresh_pin", dryRun: true }, throwing))
    expect((await Effect.runPromise(new SessionPinManager(storage).load("ses_refresh_pin", plans)))?.rebuildNeeded).toBeUndefined()

    await Effect.runPromise(handlers["chat.refresh"]({ sessionID: "ses_refresh_pin" }, throwing))
    expect((await Effect.runPromise(new SessionPinManager(storage).load("ses_refresh_pin", plans)))?.rebuildNeeded).toBe(true)
  })

  test("a dry run reports the cost without reloading", async () => {
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })

    const harness = agentHarness([agentInfo("build", "build role")], project)
    const ctx = context({
      ...fullContext({ directory: project, hooks: { current: 0 } }),
      agent: harness.domain,
    })
    const state = createState()
    await Effect.runPromise(activate(ctx, state))
    const handlers = createHandlers(ctx, state)

    const reloadsBefore = harness.reloads
    const result = await Effect.runPromise(
      handlers["chat.refresh"]({ sessionID: "ses_refresh", dryRun: true }, throwing),
    )
    expect(harness.reloads).toBe(reloadsBefore)
    expect(result.reloaded).toEqual([])
  })

  test("a refresh re-reads this folder's config first, forced", async () => {
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })

    const calls: unknown[] = []
    const ctx = context({
      ...fullContext({ directory: project, hooks: { current: 0 } }),
      config: { reload: (options) => Effect.sync(() => { calls.push(options) }) },
    })
    const state = createState()
    await Effect.runPromise(activate(ctx, state))
    const handlers = createHandlers(ctx, state)

    const result = await Effect.runPromise(handlers["chat.refresh"]({ sessionID: "ses_refresh" }, throwing))
    // Config reloads before every domain reload so discovery reads fresh
    // host state, and forced so file additions no document changed for still
    // rescan (item 4.6: no per-folder watchers, /refresh applies them).
    expect(calls).toEqual([{ force: true }])
    expect(result.reloaded[0]).toBe("config")
    expect(result.reloaded).toContain("instruction")
  })

  test("the refresh tool registers in the opencode namespace with its own permission row", async () => {
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })

    const tools = toolHarness([])
    const ctx = context({
      ...fullContext({ directory: project, hooks: { current: 0 } }),
      tool: tools.domain,
    })
    const state = createState()
    await Effect.runPromise(activate(ctx, state))
    const refresh = tools.tools.get("opencode_refresh")
    expect(refresh).toBeDefined()
    expect(refresh?.options?.namespace).toBe("opencode")
    expect(refresh?.options?.permission).toBe("opencode_refresh")
    expect(refresh?.options?.codemode).toBe(true)
  })
})

describe("a new chat", () => {
  test("re-reads the folder's files once, before its first request, unless the folder has just loaded", async () => {
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    const forced: (boolean | undefined)[] = []
    const harness = agentHarness([agentInfo("build", "build role")], project)
    const ctx = context({
      ...fullContext({ directory: project, hooks: { current: 0 } }),
      agent: harness.domain,
      config: { reload: (options?: { readonly force?: boolean }) => Effect.sync(() => void forced.push(options?.force)) },
    })
    // A folder loaded a minute ago: its files may have changed since.
    const loaded = { ...createState(), loadedAt: Date.now() - 60_000 }
    const agentReloads = harness.reloads
    await Effect.runPromise(refreshFolderForNewChat(ctx, loaded, "ses_one"))
    expect(forced).toEqual([true])
    expect(harness.reloads).toBe(agentReloads + 1)
    // The same chat's next prompt keeps what it started with.
    await Effect.runPromise(refreshFolderForNewChat(ctx, loaded, "ses_one"))
    expect(forced).toEqual([true])
    // Another new chat re-reads again.
    await Effect.runPromise(refreshFolderForNewChat(ctx, loaded, "ses_two"))
    expect(forced).toEqual([true, true])
    // A folder that has just loaded (a team worker's first prompt) read them already.
    await Effect.runPromise(refreshFolderForNewChat(ctx, createState(), "ses_three"))
    expect(forced).toEqual([true, true])
  })
})
