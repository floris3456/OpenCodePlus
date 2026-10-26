// Tavily and Exa over HTTP. The built-in web tools (register.ts) and the
// stand-alone `opencodeplus search-mcp` server (mcp.ts) both call these; the
// keys come from the key files or the environment at call time (keys.ts).
import { readKey } from "./keys.js"

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
