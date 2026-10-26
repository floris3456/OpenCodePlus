// Tools that changed id when OpenCode's web search and fetch, OpenCodePlus's
// Tavily and Exa tools (once the `search` MCP server) and the CLIProxyAPI
// page tool moved into Code Mode's `web` namespace (OpenCodePlus 1.3.30).
// Stored rows, requires markers and rules that name an old id follow the tool.
// The `search_*` ids are what core named the tools of Plus's former `search`
// MCP server; a server of the user's own under that name with the same tool
// names would be taken for it.

/** Old tool id → current tool id. */
export const renamedTools: Readonly<Record<string, string>> = {
  webfetch: "web_opencode_fetch",
  websearch: "web_opencode_search",
  search_exa_code_search: "web_exa_code_search",
  search_tavily_search: "web_tavily_search",
  search_tavily_extract: "web_tavily_fetch",
  web_chatgpt_open: "web_chatgpt_fetch",
}

export function currentToolId(tool: string): string {
  return renamedTools[tool] ?? tool
}

/**
 * A row id (or a `requires` entry, `!` kept) with a renamed tool's id replaced:
 * `tool:<id>`, `toolmode:<id>`, `param:<id>:<name>` and `perm:<id>:<rule>`.
 * Every other id is returned as it is.
 */
export function currentRowId(id: string): string {
  const match = /^(!?)(tool|toolmode|param|perm):([^:]+)(.*)$/.exec(id)
  const renamed = match === null ? undefined : renamedTools[match[3]!]
  if (match === null || renamed === undefined) return id
  return `${match[1]}${match[2]}:${renamed}${match[4]}`
}
