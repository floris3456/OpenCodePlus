import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveSearchBinPath } from "../../src/search/register.js"
import "./keys.test.js"

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
  "search MCP server enforces mode 0600 and key file precedence over env",
  async () => {
    const keysDir = await mkdtemp(join(tmpdir(), "plus-mcp-keys-"))
    const keyFile = join(keysDir, "exa.key")

    try {
      // 1. Insecure mode 0644 returns error
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

      // 2. Mode 0600 is accepted and key file wins over env
      await chmod(keyFile, 0o600)
      await withSearchServer(
        { ...process.env, OPENCODEPLUS_SEARCH_KEYS_DIR: keysDir, EXA_API_KEY: "different-env-key" },
        async (client) => {
          const res = (await client.callTool({
            name: "exa_code_search",
            arguments: { query: "function test()" },
          })) as { isError?: boolean; content: Array<{ type: string; text: string }> }

          expect(res.isError).toBe(true)
          const parsed = JSON.parse(res.content[0].text)
          expect(parsed.error).not.toBe("EXA_API_KEY is not set in the host environment")
          expect(parsed.error).toContain("Exa search failed")
        },
      )
    } finally {
      await rm(keysDir, { recursive: true, force: true })
    }
  },
  30_000,
)

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
