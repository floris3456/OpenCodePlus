import { afterEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio"
import { resolveSearchBinPath } from "../../src/search/register.js"

test("search MCP server spawns over stdio, lists tools, and reports missing keys", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolveSearchBinPath()],
    env: {
      ...process.env,
      TAVILY_API_KEY: "",
      EXA_API_KEY: "",
    },
  })
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await client.connect(transport)

  try {
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
  } finally {
    await client.close()
    await transport.close()
  }
})

test("search MCP server performs real call when TAVILY_API_KEY is present", async () => {
  const realKey = process.env.TAVILY_API_KEY
  if (!realKey) {
    console.log("Skipping real Tavily call: TAVILY_API_KEY is not set in the test env")
    return
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolveSearchBinPath()],
    env: {
      ...process.env,
      TAVILY_API_KEY: realKey,
    },
  })
  const client = new Client({ name: "real-test-client", version: "1.0.0" })
  await client.connect(transport)

  try {
    const result = (await client.callTool({
      name: "tavily_search",
      arguments: { query: "opencode" },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> }

    expect(result.isError).toBeFalsy()
    expect(result.content.length).toBeGreaterThan(0)
  } finally {
    await client.close()
    await transport.close()
  }
})
