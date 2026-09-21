import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultSearchKeysDir, readKey, searchKeysDir } from "../../src/search/keys.js"
import { resolveSearchBinPath } from "../../src/search/register.js"

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

// Spawns the server the way registerSearchMcp does — argv [process.execPath, binPath] — from a
// working directory outside the repository, because a real session's cwd is the user's project.
async function withSearchServer<T>(env: Record<string, string>, use: (client: Client) => Promise<T>) {
  const cwd = await mkdtemp(join(tmpdir(), "plus-search-"))
  expect(cwd.startsWith(REPO_ROOT)).toBe(false)

  const command = [process.execPath, await resolveSearchBinPath()]
  const transport = new StdioClientTransport({ command: command[0], args: command.slice(1), cwd, env })
  const client = new Client({ name: "plus-search-test", version: "1.0.0" })
  await client.connect(transport)

  try {
    return await use(client)
  } finally {
    await client.close()
    await transport.close()
    await rm(cwd, { recursive: true, force: true })
  }
}

test(
  "search MCP server starts from a working directory outside the repository",
  async () => {
    const tools = await withSearchServer({ ...process.env, TAVILY_API_KEY: "", EXA_API_KEY: "" }, async (client) => {
      const list = await client.listTools()
      return list.tools.map((tool) => ({ name: tool.name, input: Object.keys(tool.inputSchema.properties ?? {}) }))
    })

    console.log("tools/list:", JSON.stringify(tools, null, 2))
    expect(tools.map((tool) => tool.name).sort()).toEqual(["exa_code_search", "tavily_extract", "tavily_search"])
  },
  30_000,
)

test(
  "search MCP server spawns over stdio, lists tools, and reports missing keys",
  async () => {
    await withSearchServer({ ...process.env, TAVILY_API_KEY: "", EXA_API_KEY: "" }, async (client) => {
      const list = await client.listTools()
      const toolNames = list.tools.map((t) => t.name)
      expect(toolNames).toContain("exa_code_search")
      expect(toolNames).toContain("tavily_search")
      expect(toolNames).toContain("tavily_extract")

      const noKeyTavily = (await client.callTool({
        name: "tavily_search",
        arguments: { query: "test query" },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> }

      expect(noKeyTavily.isError).toBe(true)
      expect(noKeyTavily.content.length).toBeGreaterThan(0)
      const parsedTavily = JSON.parse(noKeyTavily.content[0].text)
      expect(parsedTavily.error).toBe("TAVILY_API_KEY is not set in the host environment")

      const noKeyExa = (await client.callTool({
        name: "exa_code_search",
        arguments: { query: "function test()" },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> }

      expect(noKeyExa.isError).toBe(true)
      expect(noKeyExa.content.length).toBeGreaterThan(0)
      const parsedExa = JSON.parse(noKeyExa.content[0].text)
      expect(parsedExa.error).toBe("EXA_API_KEY is not set in the host environment")
    })
  },
  30_000,
)

test(
  "search MCP server enforces mode 0600 on key files over stdio",
  async () => {
    const keysDir = await mkdtemp(join(tmpdir(), "plus-mcp-keys-"))
    const keyFile = join(keysDir, "exa.key")

    try {
      await writeFile(keyFile, "insecure-key\n", { mode: 0o644 })
      await chmod(keyFile, 0o644)

      await withSearchServer(
        { ...process.env, OPENCODEPLUS_SEARCH_KEYS_DIR: keysDir, EXA_API_KEY: "" },
        async (client) => {
          const res = (await client.callTool({
            name: "exa_code_search",
            arguments: { query: "function test()" },
          })) as { isError?: boolean; content: Array<{ type: string; text: string }> }

          expect(res.isError).toBe(true)
          const parsed = JSON.parse(res.content[0].text)
          expect(parsed.error).toContain("0600")
        },
      )
    } finally {
      await rm(keysDir, { recursive: true, force: true })
    }
  },
  30_000,
)

test("searchKeysDir resolves from OPENCODEPLUS_SEARCH_KEYS_DIR or XDG_DATA_HOME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plus-keys-dir-"))
  try {
    process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
    expect(searchKeysDir()).toBe(dir)

    delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
    process.env.XDG_DATA_HOME = dir
    expect(defaultSearchKeysDir()).toBe(join(dir, "opencode", "opencodeplus", "search"))
    expect(searchKeysDir()).toBe(join(dir, "opencode", "opencodeplus", "search"))
  } finally {
    delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
    delete process.env.XDG_DATA_HOME
    await rm(dir, { recursive: true, force: true })
  }
})

test("key file wins over env for exa", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plus-keys-exa-"))
  try {
    process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
    process.env.EXA_API_KEY = "env-exa-key"

    const keyPath = join(dir, "exa.key")
    await writeFile(keyPath, "file-exa-key\n", { mode: 0o600 })
    await chmod(keyPath, 0o600)

    expect(await readKey("exa")).toBe("file-exa-key")
  } finally {
    delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
    delete process.env.EXA_API_KEY
    await rm(dir, { recursive: true, force: true })
  }
})

test("key file wins over env for tavily", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plus-keys-tavily-"))
  try {
    process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
    process.env.TAVILY_API_KEY = "env-tavily-key"

    const keyPath = join(dir, "tavily.key")
    await writeFile(keyPath, "  file-tavily-key  \n", { mode: 0o600 })
    await chmod(keyPath, 0o600)

    expect(await readKey("tavily")).toBe("file-tavily-key")
  } finally {
    delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
    delete process.env.TAVILY_API_KEY
    await rm(dir, { recursive: true, force: true })
  }
})

test("env fallback when key file is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plus-keys-fallback-"))
  try {
    process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
    process.env.EXA_API_KEY = "fallback-exa-key"
    process.env.TAVILY_API_KEY = "fallback-tavily-key"

    expect(await readKey("exa")).toBe("fallback-exa-key")
    expect(await readKey("tavily")).toBe("fallback-tavily-key")
  } finally {
    delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
    delete process.env.EXA_API_KEY
    delete process.env.TAVILY_API_KEY
    await rm(dir, { recursive: true, force: true })
  }
})

test("returns undefined when key is missing in both file and env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plus-keys-missing-"))
  try {
    process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
    delete process.env.EXA_API_KEY
    delete process.env.TAVILY_API_KEY

    expect(await readKey("exa")).toBeUndefined()
    expect(await readKey("tavily")).toBeUndefined()
  } finally {
    delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
    await rm(dir, { recursive: true, force: true })
  }
})

test("mode 0600 is enforced on key files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plus-keys-mode-"))
  try {
    process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir

    const keyPath = join(dir, "exa.key")
    await writeFile(keyPath, "insecure-key\n", { mode: 0o644 })
    await chmod(keyPath, 0o644)

    await expect(readKey("exa")).rejects.toThrow("0600")
  } finally {
    delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
    await rm(dir, { recursive: true, force: true })
  }
})

test("key value is trimmed of leading and trailing whitespace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plus-keys-trim-"))
  try {
    process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir

    const keyPath = join(dir, "exa.key")
    await writeFile(keyPath, "\n\t  trimmed-key  \r\n", { mode: 0o600 })
    await chmod(keyPath, 0o600)

    expect(await readKey("exa")).toBe("trimmed-key")
  } finally {
    delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
    await rm(dir, { recursive: true, force: true })
  }
})

test(
  "search MCP server performs real call when TAVILY_API_KEY is present",
  async () => {
    const realKey = process.env.TAVILY_API_KEY
    if (!realKey) {
      console.log("Skipping real Tavily call: TAVILY_API_KEY is not set in the test env")
      return
    }

    await withSearchServer({ ...process.env, TAVILY_API_KEY: realKey }, async (client) => {
      const result = (await client.callTool({
        name: "tavily_search",
        arguments: { query: "opencode" },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> }

      expect(result.isError).toBeFalsy()
      expect(result.content.length).toBeGreaterThan(0)
    })
  },
  60_000,
)
