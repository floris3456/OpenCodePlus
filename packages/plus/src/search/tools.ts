// The search server's tool names and descriptions: the server registers them
// (mcp.ts), and discovery knows them before the server has connected
// (instructions/mcp-tools.ts), so a member's "off" row denies them from the
// first request. Dependency-free: discovery imports it without the MCP SDK.
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
