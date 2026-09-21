import { afterEach, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { MCPDomain } from "@opencode/plugin/effect/mcp"
import type { Tool } from "@opencode/schema/tool"
import { createHandlers, createPlusApi, createState } from "../../src/index.js"
import { registerSearchMcp, resolveSearchBinPath } from "../../src/search/register.js"
import { enable } from "../../src/project.js"
import { registerInstructionTools } from "../../src/tools.js"
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
  expect(after.environment).toBeDefined()
  expect(after.environment.OPENCODEPLUS_SEARCH_KEYS_DIR).toBeDefined()

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
  expect(server.environment).toEqual({
    OPENCODEPLUS_SEARCH_KEYS_DIR: path.join(process.env.XDG_DATA_HOME!, "opencode", "opencodeplus", "search"),
  })
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

test("real-handler server filter: instructions.list where:\"server:search\" returns mcp:search row and tool rows", async () => {
  const project = await tempProject()

  const baseMcp = mcpHarness([])
  const ctx = context({
    ...fullContext({
      directory: project,
      tools: [
        {
          id: "bash",
          description: "Run bash",
        },
      ],
    }),
    mcp: baseMcp.domain,
  })

  await Effect.runPromise(
    Effect.scoped(
      ctx.tool.transform((editor) => {
        editor.add({
          name: "exa_code_search",
          description: "Search code via Exa",
          input: undefined as any,
          origin: { type: "mcp", name: "search" },
          execute: () => Effect.succeed({}),
        } as any)
        editor.add({
          name: "tavily_search",
          description: "Search web via Tavily",
          input: undefined as any,
          origin: { type: "mcp", name: "search" },
          execute: () => Effect.succeed({}),
        } as any)
      }),
    ),
  )

  const state = createState()
  const api = createPlusApi(ctx, state)
  await registerInstructionTools(ctx, api)
  const handlers = createHandlers(ctx, state)

  await Effect.runPromise(handlers["project.enable"](undefined, throwingContext()))

  const tools = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
        yield* ctx.tool.transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
        })
        const list = yield* Deferred.await(deferred)
        return new Map(list.map((t) => [t.id, t]))
      }),
    ),
  )

  const listTool = tools.get("instructions_list")
  expect(listTool).toBeDefined()

  const listOutput = await Effect.runPromise(
    listTool!.execute({ where: "server:search" }, { sessionID: "s1", messageID: "m1", callID: "c1" } as any),
  )

  const output = (listOutput as any).output as { rows: Array<{ id: string }>; total: number }
  const ids = output.rows.map((r) => r.id)

  expect(ids).toContain("item:defaults::mcp:search")
  expect(ids.some((id) => id.includes("tool:exa_code_search"))).toBe(true)
  expect(ids.some((id) => id.includes("tool:tavily_search"))).toBe(true)
  expect(ids.some((id) => id.includes("tool:bash"))).toBe(false)
})
