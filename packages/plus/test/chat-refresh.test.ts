import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { activate, createHandlers, createState } from "../src/index.js"
import { agentHarness, agentInfo, context, fullContext, toolHarness } from "./harness.js"

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
