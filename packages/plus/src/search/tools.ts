// The Tavily and Exa tools' names and descriptions: the built-in web tools
// (register.ts, where tavily_extract is web.tavily_fetch) and the stand-alone
// `opencodeplus search-mcp` server (mcp.ts) both describe them so.
// Dependency-free: the plugin imports it without the MCP SDK.
export const searchTools = [
  {
    name: "exa_code_search",
    description:
      "Search billions of GitHub repos, docs, Stack Overflow, and dev blogs for real, working code examples via Exa. Be specific about language, framework, and version. Prefer highlights over full text to get targeted code snippets.",
  },
  {
    name: "tavily_search",
    description:
      "Search the web via Tavily. Returns LLM-optimized results with content snippets and relevance scores. Prefer specific queries under 400 chars.",
  },
  {
    name: "tavily_extract",
    description:
      "Extract clean content from up to 20 URLs via Tavily. Provide a query with chunks_per_source to return only the most relevant chunks and avoid context bloat.",
  },
] as const

export function searchToolDescription(name: (typeof searchTools)[number]["name"]): string {
  return searchTools.find((tool) => tool.name === name)?.description ?? ""
}
