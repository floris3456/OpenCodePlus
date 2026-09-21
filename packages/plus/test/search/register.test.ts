import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { MCPDomain } from "@opencode/plugin/effect/mcp"
import { createHandlers, createState } from "../../src/index.js"
import { registerSearchMcp, resolveSearchBinPath } from "../../src/search/register.js"
import { enable } from "../../src/project.js"
import { context, fullContext, mcpHarness } from "../harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-search-register-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  return path.join(root, "project")
}

function throwingContext(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      throw data === undefined ? { type, message } : { type, message, data }
    },
  }
}

async function getServer(domain: MCPDomain, name: string): Promise<any> {
  let found: any = undefined
  await Effect.runPromise(
    Effect.scoped(
      domain.transform((editor) => {
        found = editor.get(name)
      }),
    ),
  )
  return found
}

test("register-when-absent registers search MCP server with local command and reloads", async () => {
  const baseMcp = mcpHarness([])
  const ctx = context({
    ...fullContext({ directory: "/tmp/test" }),
    mcp: baseMcp.domain,
  })

  const before = await getServer(baseMcp.domain, "search")
  expect(before).toBeUndefined()

  const binPath = await resolveSearchBinPath()
  const registration = await registerSearchMcp(ctx, binPath)
  expect(registration).toBeDefined()

  const after = await getServer(baseMcp.domain, "search")
  expect(after).toBeDefined()
  expect(after.type).toBe("local")
  expect(after.command).toEqual([process.execPath, binPath])

  if (registration) {
    await Effect.runPromise(registration.dispose)
    const afterDispose = await getServer(baseMcp.domain, "search")
    expect(afterDispose).toBeUndefined()
  }
})

test("leave-when-present leaves existing search MCP server untouched and returns undefined", async () => {
  const existingConfig = { type: "remote" as const, url: "https://custom-search.example.com/mcp" }
  const baseMcp = mcpHarness([["search", existingConfig]])
  const ctx = context({
    ...fullContext({ directory: "/tmp/test" }),
    mcp: baseMcp.domain,
  })

  const before = await getServer(baseMcp.domain, "search")
  expect(before).toEqual(existingConfig)

  const binPath = await resolveSearchBinPath()
  const registration = await registerSearchMcp(ctx, binPath)
  expect(registration).toBeUndefined()

  const after = await getServer(baseMcp.domain, "search")
  expect(after).toEqual(existingConfig)
})

test("full activation registers search MCP when absent and reflects it in instructions snapshot", async () => {
  const project = await tempProject()

  const baseMcp = mcpHarness([])
  const ctx = context({
    ...fullContext({ directory: project }),
    mcp: baseMcp.domain,
  })

  const state = createState()
  const handlers = createHandlers(ctx, state)

  await Effect.runPromise(handlers["project.enable"](undefined, throwingContext()))

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const searchMcpItem = snapshot.items.find((item) => item.id === "mcp:search")
  expect(searchMcpItem).toBeDefined()

  const server = await getServer(baseMcp.domain, "search")
  expect(server).toBeDefined()
  expect(server.type).toBe("local")
  expect(server.command).toEqual([process.execPath, await resolveSearchBinPath()])
})

test("full activation leaves existing search MCP server when present", async () => {
  const project = await tempProject()

  const existingConfig = { type: "remote" as const, url: "https://custom-search.example.com/mcp" }
  const baseMcp = mcpHarness([["search", existingConfig]])
  const ctx = context({
    ...fullContext({ directory: project }),
    mcp: baseMcp.domain,
  })

  const state = createState()
  const handlers = createHandlers(ctx, state)

  await Effect.runPromise(handlers["project.enable"](undefined, throwingContext()))

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const searchMcpItem = snapshot.items.find((item) => item.id === "mcp:search")
  expect(searchMcpItem).toBeDefined()

  const server = await getServer(baseMcp.domain, "search")
  expect(server).toEqual(existingConfig)
})
