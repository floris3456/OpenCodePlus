import { afterEach, expect, test } from "bun:test"
import { Deferred, Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { MCPDomain } from "@opencode/plugin/effect/mcp"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { activate, createHandlers, createState } from "../../src/index.js"
import { readKey } from "../../src/search/keys.js"
import {
  isOldGeneratedSearchCommand,
  registerSearchTools,
  retireSearchMcp,
  TavilyFetchInput,
  TavilySearchInput,
} from "../../src/search/register.js"
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

test("Tavily and Exa are built-in Code Mode web tools that ask the web permissions", async () => {
  const ctx = context({ ...fullContext({ directory: "/tmp/test" }), mcp: mcpHarness([]).domain })
  const registration = await registerSearchTools(ctx)
  const tools = await readTools(ctx)
  const shape = (id: string) => {
    const tool = tools.get(id)
    return tool && { name: tool.name, options: tool.options, origin: tool.origin }
  }
  expect(shape("web_exa_code_search")).toEqual({
    name: "exa_code_search",
    options: { namespace: "web", permission: "websearch" },
    origin: { type: "plugin", name: "opencode.plus" },
  })
  expect(shape("web_tavily_search")).toMatchObject({ name: "tavily_search", options: { namespace: "web", permission: "websearch" } })
  expect(shape("web_tavily_fetch")).toMatchObject({ name: "tavily_fetch", options: { namespace: "web", permission: "webfetch" } })
  // Defaults the server applied before are part of the input schemas.
  expect(Schema.decodeUnknownSync(TavilySearchInput)({ query: "bun" })).toEqual({
    query: "bun",
    search_depth: "basic",
    topic: "general",
    max_results: 5,
  })
  expect(Schema.decodeUnknownSync(TavilyFetchInput)({ urls: ["https://bun.sh"] })).toEqual({
    urls: ["https://bun.sh"],
    extract_depth: "basic",
    format: "markdown",
  })
  expect(() => Schema.decodeUnknownSync(TavilyFetchInput)({ urls: ["not a url"] })).toThrow()
  await Effect.runPromise(registration.dispose)
  expect((await readTools(ctx)).has("web_tavily_search")).toBe(false)
})

test("a search tool without its key answers with a tool error naming the key", async () => {
  const project = await tempProject()
  process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = path.join(project, "no-keys")
  const priorTavily = process.env.TAVILY_API_KEY
  delete process.env.TAVILY_API_KEY
  try {
    const ctx = context({ ...fullContext({ directory: "/tmp/test" }), mcp: mcpHarness([]).domain })
    await registerSearchTools(ctx)
    const tool = (await readTools(ctx)).get("web_tavily_search")!
    const exit = await Effect.runPromiseExit(tool.execute({ query: "bun" }, toolContext()))
    expect(JSON.stringify(exit)).toContain("TAVILY_API_KEY is not set")
  } finally {
    if (priorTavily !== undefined) process.env.TAVILY_API_KEY = priorTavily
  }
})

test("the search MCP entry Plus used to add is left out; a user's own search server stays", async () => {
  const generated = {
    type: "local" as const,
    command: ["/opt/opencodeplus/bin/opencodeplus", "search-mcp"],
    environment: { BUN_BE_BUN: "0", OPENCODEPLUS_SEARCH_KEYS_DIR: "/keys" },
  }
  const old = { type: "local" as const, command: ["/path/to/bun", "/work/packages/plus/src/search/bin.ts"] }
  for (const config of [generated, old]) {
    const mcp = mcpHarness([["search", config]])
    const ctx = context({ ...fullContext({ directory: "/tmp/test" }), mcp: mcp.domain })
    const registration = await retireSearchMcp(ctx)
    expect(registration).toBeDefined()
    expect(await getServer(mcp.domain, "search")).toBeUndefined()
    await Effect.runPromise(registration!.dispose)
    expect(await getServer(mcp.domain, "search")).toEqual(config)
  }
  for (const own of [
    { type: "remote" as const, url: "https://custom-search.example.com/mcp" },
    { type: "local" as const, command: ["my-custom-search-tool", "--query-param"], environment: { CUSTOM_ENV: "1" } },
  ]) {
    const mcp = mcpHarness([["search", own]])
    const ctx = context({ ...fullContext({ directory: "/tmp/test" }), mcp: mcp.domain })
    expect(await retireSearchMcp(ctx)).toBeUndefined()
    expect(await getServer(mcp.domain, "search")).toEqual(own)
  }
})

test("full activation adds the web tools and no search MCP server", async () => {
  const project = await tempProject()
  const baseMcp = mcpHarness([])
  const ctx = context({
    ...fullContext({ directory: project }),
    mcp: baseMcp.domain,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  await Effect.runPromise(activate(ctx, state))
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  expect(snapshot.items.some((item) => item.id === "mcp:search")).toBe(false)
  expect(await getServer(baseMcp.domain, "search")).toBeUndefined()
  const tools = await readTools(ctx)
  expect(["web_exa_code_search", "web_tavily_search", "web_tavily_fetch"].every((id) => tools.has(id))).toBe(true)
})

test("real-handler server filter: instructions.find where:\"server:search\" returns mcp:search row and tool rows", async () => {
  const project = await tempProject()

  const baseMcp = mcpHarness([["search", { type: "remote", url: "https://custom-search.example.com/mcp" }]])
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
  await Effect.runPromise(activate(ctx, state))

  const tools = await readTools(ctx)
  const listTool = tools.get("instructions_find")
  expect(listTool).toBeDefined()

  const listOutput = await Effect.runPromise(
    listTool!.execute({ where: "server:search" }, toolContext()),
  )

  const output = listOutput.output as { rows: readonly string[]; total: number }
  console.log("ACTUAL_INSTRUCTIONS_LIST_OUTPUT:\n" + JSON.stringify(output, null, 2))

  const ids = output.rows.map((row) => row.split(" | ")[0] ?? "")
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

test("isOldGeneratedSearchCommand matches only the old search/bin entry point", () => {
  expect(isOldGeneratedSearchCommand(["/path/to/bun", "/work/packages/plus/src/search/bin.ts"])).toBe(true)
  expect(isOldGeneratedSearchCommand(["bun", "C:\\work\\search\\bin.js"])).toBe(true)
  expect(isOldGeneratedSearchCommand(["opencodeplus", "search-mcp"])).toBe(false)
  expect(isOldGeneratedSearchCommand("bun search/bin.ts")).toBe(false)
})
