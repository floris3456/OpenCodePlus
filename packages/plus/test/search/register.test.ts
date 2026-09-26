import { afterEach, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { MCPDomain } from "@opencode/plugin/effect/mcp"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { createHandlers, createPlusApi, createState } from "../../src/index.js"
import { readKey } from "../../src/search/keys.js"
import { isOldGeneratedSearchCommand, registerSearchMcp, resolveSearchBinPath, searchMcpCommand } from "../../src/search/register.js"
import { enable } from "../../src/project.js"
import { registerInstructionTools } from "../../src/tools.js"
import { agentInfo, context, fullContext, mcpHarness, toolInfo } from "../harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME
const priorKeysDir = process.env.OPENCODEPLUS_SEARCH_KEYS_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  if (priorKeysDir === undefined) delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
  else process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = priorKeysDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-search-register-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
  return path.join(root, "project")
}

function throwingContext(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      throw data === undefined ? { type, message } : { type, message, data }
    },
  }
}

function toolContext(agent = "alpha"): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_tools_test"),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_tools_test"),
    id: Tool.CallID.make("call_tools_test"),
    progress: () => Effect.void,
  }
}

async function readTools(ctx: Context): Promise<Map<string, Tool.Info & { readonly id: string }>> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
        yield* ctx.tool.transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
        })
        const list = yield* Deferred.await(deferred)
        return new Map(list.map((tool) => [tool.id, tool]))
      }),
    ),
  )
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
  expect(after.environment.BUN_BE_BUN).toBe("0")
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
    BUN_BE_BUN: "0",
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
      agents: [agentInfo("alpha", "upstream role")],
      tools: [
        {
          id: "bash",
          description: "Run bash",
        },
      ],
      // alpha is an unlinked user agent: its shared rows fall back to off
      // (DESIGN §3.3), so the publish installs its context hook.
      session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
    }),
    mcp: baseMcp.domain,
  })

  const exaTool: Tool.Info = {
    ...toolInfo("exa_code_search", "Search code via Exa"),
    origin: { type: "mcp", name: "search" },
  }
  const tavilyTool: Tool.Info = {
    ...toolInfo("tavily_search", "Search web via Tavily"),
    origin: { type: "mcp", name: "search" },
  }

  await Effect.runPromise(
    Effect.scoped(
      ctx.tool.transform((editor) => {
        editor.add(exaTool)
        editor.add(tavilyTool)
      }),
    ),
  )

  const state = createState()
  const api = createPlusApi(ctx, state)
  await registerInstructionTools(ctx, api)
  const handlers = createHandlers(ctx, state)

  await Effect.runPromise(handlers["project.enable"](undefined, throwingContext()))

  const tools = await readTools(ctx)
  const listTool = tools.get("instructions_list")
  expect(listTool).toBeDefined()

  const listOutput = await Effect.runPromise(
    listTool!.execute({ where: "server:search" }, toolContext()),
  )

  const output = listOutput.output as { rows: readonly { id: string }[]; total: number }
  console.log("ACTUAL_INSTRUCTIONS_LIST_OUTPUT:\n" + JSON.stringify(output, null, 2))

  const ids = output.rows.map((r) => r.id)
  expect(ids).toContain("item:defaults::mcp:search")
  expect(ids.some((id) => id.includes("tool:exa_code_search"))).toBe(true)
  expect(ids.some((id) => id.includes("tool:tavily_search"))).toBe(true)
  expect(ids.some((id) => id.includes("tool:bash"))).toBe(false)
})

test("reproducible key file read metadata with disposable sentinel", async () => {
  const project = await tempProject()
  const keysDir = path.join(project, "search")
  await fs.mkdir(keysDir, { recursive: true })
  process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = keysDir

  const sentinelExa = "sentinel-exa-" + crypto.randomUUID()
  const exaKeyPath = path.join(keysDir, "exa.key")
  await fs.writeFile(exaKeyPath, `${sentinelExa}\n`, { mode: 0o600 })
  await fs.chmod(exaKeyPath, 0o600)

  const sentinelTavily = "sentinel-tavily-" + crypto.randomUUID()
  const tavilyKeyPath = path.join(keysDir, "tavily.key")
  await fs.writeFile(tavilyKeyPath, `${sentinelTavily}\n`, { mode: 0o600 })
  await fs.chmod(tavilyKeyPath, 0o600)

  const exaStat = await fs.stat(exaKeyPath)
  const exaRead = await readKey("exa")

  const tavilyStat = await fs.stat(tavilyKeyPath)
  const tavilyRead = await readKey("tavily")

  const metadata = {
    exa: {
      path: exaKeyPath,
      mode: `0${(exaStat.mode & 0o777).toString(8)}`,
      size: exaStat.size,
      mtime: exaStat.mtime.toISOString(),
      sentinelMatch: exaRead === sentinelExa,
      value: "[REDACTED (sentinel matched)]",
    },
    tavily: {
      path: tavilyKeyPath,
      mode: `0${(tavilyStat.mode & 0o777).toString(8)}`,
      size: tavilyStat.size,
      mtime: tavilyStat.mtime.toISOString(),
      sentinelMatch: tavilyRead === sentinelTavily,
      value: "[REDACTED (sentinel matched)]",
    },
  }

  console.log("ACTUAL_KEY_METADATA:\n" + JSON.stringify(metadata, null, 2))
  expect(metadata.exa.sentinelMatch).toBe(true)
  expect(metadata.exa.mode).toBe("0600")
  expect(metadata.tavily.sentinelMatch).toBe(true)
  expect(metadata.tavily.mode).toBe("0600")
})

test("searchMcpCommand: compiled branch produces [<absolute exec path>, 'search-mcp']", () => {
  const relCmd = searchMcpCommand({
    execPath: "opencodeplus",
    binPath: "/embedded/path/bin.ts",
    binPathExists: false,
  })
  expect(relCmd).toEqual([path.resolve("opencodeplus"), "search-mcp"])
  expect(path.isAbsolute(relCmd[0])).toBe(true)

  const absCmd = searchMcpCommand({
    execPath: "/usr/local/bin/opencodeplus",
    binPath: "/embedded/path/bin.ts",
    binPathExists: false,
  })
  expect(absCmd).toEqual(["/usr/local/bin/opencodeplus", "search-mcp"])
})

test("searchMcpCommand: development branch keeps the on-disk path form", () => {
  const devCmd = searchMcpCommand({
    execPath: process.execPath,
    binPath: "/repos/opencode/packages/plus/src/search/bin.ts",
    binPathExists: true,
  })
  expect(devCmd).toEqual([process.execPath, "/repos/opencode/packages/plus/src/search/bin.ts"])
})

test("migration: old generated command is migrated to new command", async () => {
  const oldCommand = ["/path/to/bun", "/work/packages/plus/src/search/bin.ts"]
  const oldConfig = {
    type: "local" as const,
    command: oldCommand,
    environment: {
      OPENCODEPLUS_SEARCH_KEYS_DIR: "/some/keys/dir",
    },
  }
  const baseMcp = mcpHarness([["search", oldConfig]])
  const ctx = context({
    ...fullContext({ directory: "/tmp/test" }),
    mcp: baseMcp.domain,
  })

  const before = await getServer(baseMcp.domain, "search")
  expect(before.command).toEqual(oldCommand)

  const binPath = await resolveSearchBinPath()
  const registration = await registerSearchMcp(ctx, binPath)
  expect(registration).toBeDefined()

  const after = await getServer(baseMcp.domain, "search")
  expect(after.command).toEqual([process.execPath, binPath])
  expect(after.environment.BUN_BE_BUN).toBe("0")
})

test("custom command is preserved untouched", async () => {
  const customConfig = {
    type: "local" as const,
    command: ["my-custom-search-tool", "--query-param"],
    environment: {
      CUSTOM_ENV: "1",
    },
  }
  const baseMcp = mcpHarness([["search", customConfig]])
  const ctx = context({
    ...fullContext({ directory: "/tmp/test" }),
    mcp: baseMcp.domain,
  })

  const before = await getServer(baseMcp.domain, "search")
  expect(before).toEqual(customConfig)

  const binPath = await resolveSearchBinPath()
  const registration = await registerSearchMcp(ctx, binPath)
  expect(registration).toBeUndefined()

  const after = await getServer(baseMcp.domain, "search")
  expect(after).toEqual(customConfig)
})
