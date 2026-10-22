import { afterEach, expect, test } from "bun:test"
import { chooseSearchModel, openChatGPT, searchChatGPT, searchClaude, type SearchModel, type WebTarget } from "../src/web.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

// Pacer's catalogue: the CPA providers serving each model.
const models: SearchModel[] = [
  { id: "claude-sonnet-4-6", kind: "chat", ownedBy: "antigravity", providers: ["antigravity"] },
  { id: "claude-opus-5-5", kind: "chat", ownedBy: "anthropic", providers: ["claude"] },
  { id: "claude-haiku-5-5", kind: "chat", ownedBy: "anthropic", providers: ["claude"] },
  { id: "codex-auto-review", kind: "chat", ownedBy: "openai", providers: ["codex"] },
  { id: "gpt-6-luna", kind: "chat", ownedBy: "openai", providers: ["codex"] },
  { id: "gpt-image-2", kind: "image", ownedBy: "openai", providers: ["codex"] },
]

interface Seen {
  path?: string
  auth?: string | null
  version?: string | null
  session?: string | null
  body?: Record<string, unknown>
}

function cpa(reply: () => Response) {
  const seen: Seen = {}
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.path = new URL(request.url).pathname
      seen.auth = request.headers.get("authorization")
      seen.version = request.headers.get("anthropic-version")
      seen.session = request.headers.get("x-session-id")
      seen.body = (await request.json()) as Record<string, unknown>
      return reply()
    },
  })
  cleanups.push(() => void server.stop(true))
  const target: WebTarget = { baseURL: `${server.url.origin}/v1`, key: "fixture-key", models }
  return { seen, target }
}

test("search models come from the backend's own accounts", () => {
  expect(chooseSearchModel(models, "codex", "gpt-6-luna")).toBe("gpt-6-luna")
  expect(chooseSearchModel(models, "codex", "gone")).toBe("codex-auto-review")
  expect(chooseSearchModel(models, "claude", "claude-haiku-5-5")).toBe("claude-haiku-5-5")
  expect(chooseSearchModel(models, "claude", "gone")).toBe("claude-opus-5-5")
  // Served through Antigravity, not a Claude account: never a Claude search model.
  expect(chooseSearchModel(models, "claude", "claude-haiku-5-5", "claude-sonnet-4-6")).toBeUndefined()
  expect(chooseSearchModel(models, "codex", "gpt-6-luna", "gpt-image-2")).toBeUndefined()
  // A catalogue without CPA's provider list falls back to the owner.
  expect(chooseSearchModel([{ id: "claude-x", ownedBy: "anthropic" }], "claude", "gone")).toBe("claude-x")
  expect(chooseSearchModel([], "codex", "gpt-6-luna")).toBeUndefined()
})

test("ChatGPT search posts Codex's search command and returns the page text without ChatGPT's markers", async () => {
  const fixture = cpa(() =>
    Response.json({
      encrypted_output: "ciphertext",
      output:
        "Releases · router-for-me/CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI/releases)\n\ue200cite\ue202turn0search0\ue201 [wordlim: 200] # v8.0.37",
      results: [
        { type: "text_result", ref_id: "turn0search0", title: "Releases", url: "https://github.com/x/releases" },
        { type: "text_result", ref_id: "turn0search1", url: "https://github.com/x/releases" },
        { type: "image_result" },
      ],
    }),
  )
  const result = await searchChatGPT(
    { query: "CLIProxyAPI latest release", recency: 7, domains: ["github.com"] },
    "ses_1",
    fixture.target,
  )
  expect(fixture.seen).toMatchObject({ path: "/v1/alpha/search", auth: "Bearer fixture-key" })
  expect(fixture.seen.body).toEqual({
    id: "ses_1-search",
    model: "gpt-6-luna",
    commands: { search_query: [{ q: "CLIProxyAPI latest release", recency: 7, domains: ["github.com"] }] },
    max_output_tokens: 2000,
  })
  expect(result.content).toBe(
    "Releases · router-for-me/CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI/releases)\n [wordlim: 200] # v8.0.37",
  )
  expect(result.output).toEqual({
    text: result.content,
    model: "gpt-6-luna",
    // The first of a URL's results wins; it carries the title.
    sources: [{ url: "https://github.com/x/releases", title: "Releases" }],
  })
})

test("ChatGPT open asks for the page with the token cap", async () => {
  const fixture = cpa(() => Response.json({ output: "Page (https://x.dev)\nL0: top", results: [] }))
  const result = await openChatGPT({ url: "https://x.dev", tokens: 500 }, "ses_1", fixture.target)
  expect(fixture.seen.body).toEqual({
    id: "ses_1-search",
    model: "gpt-6-luna",
    commands: { open: [{ ref_id: "https://x.dev" }] },
    max_output_tokens: 500,
  })
  expect(result.content).toBe("Page (https://x.dev)\nL0: top")
})

test("Claude search lets a Claude model search without thinking and returns its answer, citations and queries", async () => {
  const fixture = cpa(() =>
    Response.json({
      stop_reason: "end_turn",
      content: [
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "CLIProxyAPI latest release" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srv_1",
          content: [{ type: "web_search_result", url: "https://old.example", title: "Old", encrypted_content: "e" }],
        },
        { type: "text", text: "The latest release is " },
        {
          type: "text",
          text: "v8.0.37",
          citations: [
            {
              type: "web_search_result_location",
              url: "https://github.com/x/releases",
              title: "Releases",
              cited_text: "v8.0.37",
            },
          ],
        },
        { type: "text", text: ", published 21 Oct." },
      ],
      usage: {
        input_tokens: 6,
        cache_creation_input_tokens: 16225,
        cache_read_input_tokens: 2998,
        output_tokens: 349,
        server_tool_use: { web_search_requests: 1 },
      },
    }),
  )
  const result = await searchClaude(
    { question: "Latest CLIProxyAPI release?", domains: ["github.com"], searches: 2 },
    "ses_1",
    fixture.target,
  )
  expect(fixture.seen).toMatchObject({
    path: "/v1/messages",
    auth: "Bearer fixture-key",
    version: "2023-06-01",
    session: "ses_1-search",
  })
  expect(fixture.seen.body).toMatchObject({
    model: "claude-haiku-5-5",
    thinking: { type: "disabled" },
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2, allowed_domains: ["github.com"] }],
    messages: [{ role: "user", content: "Latest CLIProxyAPI release?" }],
  })
  expect(result.content).toBe(
    [
      "The latest release is v8.0.37, published 21 Oct.",
      "Sources:\n- Releases (https://github.com/x/releases)",
      'claude-haiku-5-5 searched: "CLIProxyAPI latest release"',
    ].join("\n\n"),
  )
  expect(result.output).toEqual({
    answer: "The latest release is v8.0.37, published 21 Oct.",
    model: "claude-haiku-5-5",
    queries: ["CLIProxyAPI latest release"],
    sources: [{ url: "https://github.com/x/releases", title: "Releases" }],
    searches: 1,
    tokens: { input: 19229, output: 349 },
  })
})

test("Claude search without an answer, a CPA error or an unserved model fails the call", async () => {
  const silent = cpa(() =>
    Response.json({
      stop_reason: "max_tokens",
      content: [
        { type: "thinking", thinking: "…" },
        { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
      ],
    }),
  )
  await expect(searchClaude({ question: "q" }, "ses_1", silent.target)).rejects.toThrow(
    "Claude wrote no answer (stop: max_tokens; search errors: unavailable)",
  )

  const refused = cpa(() => new Response("quota exhausted", { status: 429 }))
  await expect(searchChatGPT({ query: "q" }, "ses_1", refused.target)).rejects.toThrow(
    "CPA /alpha/search HTTP 429: quota exhausted",
  )

  const unserved = cpa(() => Response.json({}))
  await expect(searchClaude({ question: "q", model: "claude-sonnet-4-6" }, "ses_1", unserved.target)).rejects.toThrow(
    "claude-sonnet-4-6 is not a Claude model CLIProxyAPI serves from Claude accounts",
  )
  expect(unserved.seen.path).toBeUndefined()
})
