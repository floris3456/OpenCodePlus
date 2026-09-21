import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { readKey } from "./keys.js"

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] }
}

export async function tavily(endpoint: "search" | "extract", body: unknown) {
  const key = await readKey("tavily")
  if (!key) throw new Error("TAVILY_API_KEY is not set in the host environment")
  const res = await fetch(`https://api.tavily.com/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Tavily ${endpoint} failed (${res.status}): ${text}`)
  return JSON.parse(text)
}

export async function exaSearch(body: unknown) {
  const key = await readKey("exa")
  if (!key) throw new Error("EXA_API_KEY is not set in the host environment")
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Exa search failed (${res.status}): ${text}`)
  return JSON.parse(text)
}

export function registerExaTools(server: McpServer) {
  server.registerTool(
    "exa_code_search",
    {
      description:
        "Search billions of GitHub repos, docs, Stack Overflow, and dev blogs for real, working code examples via Exa. Be specific about language, framework, and version. Prefer highlights over full text to get targeted code snippets.",
      inputSchema: {
        query: z.string().min(1).describe("Natural language describing the code you need; specify language/framework/version"),
        type: z.enum(["fast", "auto", "neural", "keyword"]).default("fast"),
        numResults: z.number().int().min(1).max(100).default(10),
        includeDomains: z.array(z.string()).optional(),
        excludeDomains: z.array(z.string()).optional(),
        startPublishedDate: z.string().optional(),
        endPublishedDate: z.string().optional(),
        contents: z
          .object({
            text: z.union([z.boolean(), z.object({ maxCharacters: z.number().int().positive() })]).optional(),
            highlights: z.boolean().optional(),
            summary: z.boolean().optional(),
          })
          .default({ highlights: true }),
      },
    },
    async (args) => {
      try {
        return result(await exaSearch(args))
      } catch (e) {
        return { ...result({ error: e instanceof Error ? e.message : String(e) }), isError: true }
      }
    },
  )
}

export function registerTavilyTools(server: McpServer) {
  server.registerTool(
    "tavily_search",
    {
      description:
        "Search the web via Tavily. Returns LLM-optimized results with content snippets and relevance scores. Prefer specific queries under 400 chars.",
      inputSchema: {
        query: z.string().min(1).max(400),
        search_depth: z.enum(["ultra-fast", "fast", "basic", "advanced"]).default("basic"),
        topic: z.enum(["general", "news", "finance"]).default("general"),
        max_results: z.number().int().min(1).max(20).default(5),
        time_range: z.enum(["day", "week", "month", "year"]).optional(),
        include_domains: z.array(z.string()).optional(),
        exclude_domains: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        return result(await tavily("search", args))
      } catch (e) {
        return { ...result({ error: e instanceof Error ? e.message : String(e) }), isError: true }
      }
    },
  )
  server.registerTool(
    "tavily_extract",
    {
      description:
        "Extract clean content from up to 20 URLs via Tavily. Provide a query with chunks_per_source to return only the most relevant chunks and avoid context bloat.",
      inputSchema: {
        urls: z.array(z.string().url()).min(1).max(20),
        extract_depth: z.enum(["basic", "advanced"]).default("basic"),
        query: z.string().optional(),
        chunks_per_source: z.number().int().min(1).max(5).optional(),
        format: z.enum(["markdown", "text"]).default("markdown"),
      },
    },
    async (args) => {
      try {
        return result(await tavily("extract", args))
      } catch (e) {
        return { ...result({ error: e instanceof Error ? e.message : String(e) }), isError: true }
      }
    },
  )
}

export function createSearchServer(): McpServer {
  const server = new McpServer({ name: "opencodeplus-search", version: "1.0.0" })
  registerExaTools(server)
  registerTavilyTools(server)
  return server
}
