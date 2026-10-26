import type { Plugin } from "@opencode/plugin"
import type { Tool } from "@opencode/schema/tool"
import { normaliseBaseURL } from "opencode-pacer/core"
import { Option, Schema } from "effect"

/**
 * Web search through CPA's own search backends, as tools for every chat model.
 *
 * ChatGPT: CPA forwards Codex's standalone search endpoint (`/v1/alpha/search`) to a Codex
 * account. It answers with the found pages' readable text, which the tools return as is.
 *
 * Claude: Anthropic's server-side `web_search` tool on `/v1/messages`. Its results arrive
 * encrypted for Claude, so a Claude model reads them and answers with citations.
 */
export const DEFAULT_CHATGPT_SEARCH_MODEL = "gpt-6-luna"
export const DEFAULT_CLAUDE_SEARCH_MODEL = "claude-haiku-5-5"
const DEFAULT_TOKENS = 2000
const DEFAULT_SEARCHES = 3

const SearchModel = Schema.Struct({
  id: Schema.String,
  kind: Schema.optional(Schema.String),
  ownedBy: Schema.optional(Schema.String),
  providers: Schema.optional(Schema.Array(Schema.String)),
})
export type SearchModel = typeof SearchModel.Type

/** The CPA connection with the models Pacer last read from it. */
export interface WebTarget {
  readonly baseURL: string
  readonly key: string
  readonly models: readonly SearchModel[]
}

const Tokens = Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 16_000 }))).annotate({
  description: `Most page text to return, in tokens (about 4 characters each). Default ${DEFAULT_TOKENS}.`,
})

export const ChatGPTSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "What to search for." }),
  recency: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Only pages from the last this many days.",
  }),
  domains: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: 'Search only these domains, e.g. ["github.com"].',
  }),
  tokens: Tokens,
})
export type ChatGPTSearchInput = typeof ChatGPTSearchInput.Type

export const ChatGPTOpenInput = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "The page to open." }),
  tokens: Tokens,
})
export type ChatGPTOpenInput = typeof ChatGPTOpenInput.Type

export const ClaudeSearchInput = Schema.Struct({
  question: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "What to find out. Claude searches and answers it with sources.",
  }),
  domains: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Search only these domains." }),
  searches: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))).annotate({
    description: `Most searches Claude may run. Default ${DEFAULT_SEARCHES}.`,
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description: `CPA Claude model. Default ${DEFAULT_CLAUDE_SEARCH_MODEL}, else the first Claude model CPA serves from Claude accounts.`,
  }),
})
export type ClaudeSearchInput = typeof ClaudeSearchInput.Type

// Code Mode hands a script the declared output, so it carries the text the model reads too.
const SourceOutput = Schema.Struct({ url: Schema.String, title: Schema.optionalKey(Schema.String) })

export const ChatGPTOutput = Schema.Struct({
  text: Schema.String.annotate({ description: "The pages' text, each with its title and URL." }),
  model: Schema.String,
  sources: Schema.Array(SourceOutput),
})

export const ClaudeOutput = Schema.Struct({
  answer: Schema.String.annotate({ description: "Claude's answer." }),
  model: Schema.String,
  queries: Schema.Array(Schema.String).annotate({ description: "The searches Claude ran." }),
  sources: Schema.Array(SourceOutput).annotate({ description: "The pages Claude cited, else the results it found." }),
  searches: Schema.optionalKey(Schema.Number),
  tokens: Schema.Struct({ input: Schema.Number, output: Schema.Number }),
})

const Source = Schema.Struct({ url: Schema.String, title: Schema.optional(Schema.NullOr(Schema.String)) })
const decodeSource = Schema.decodeUnknownOption(Source)

const ChatGPTReply = Schema.Struct({
  output: Schema.String,
  results: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
})

const ClaudeReply = Schema.Struct({
  stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
      citations: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
      input: Schema.optional(Schema.Unknown),
      content: Schema.optional(Schema.Unknown),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
      cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
      output_tokens: Schema.optional(Schema.Number),
      server_tool_use: Schema.optional(
        Schema.NullOr(Schema.Struct({ web_search_requests: Schema.optional(Schema.Number) })),
      ),
    }),
  ),
})

const CLAUDE_SYSTEM =
  "Answer the user's question from a web search. Be brief and specific: names, versions, dates, figures. Cite the pages you rely on. If the search does not settle it, say so."

// A catalogue without CPA's provider list names only the model's owner.
const OWNER = { codex: "openai", claude: "anthropic" } as const

/** The requested model if CPA serves it from the backend's accounts, else the default or the first such model. */
export function chooseSearchModel(
  models: readonly SearchModel[],
  backend: "codex" | "claude",
  fallback: string,
  requested?: string,
) {
  const served = models.filter(
    (model) =>
      model.kind !== "image" &&
      (model.providers?.length ? model.providers.includes(backend) : model.ownedBy === OWNER[backend]),
  )
  if (requested) return served.find((model) => model.id === requested)?.id
  return (served.find((model) => model.id === fallback) ?? served[0])?.id
}

export function searchChatGPT(input: ChatGPTSearchInput, sessionID: string, target: WebTarget, signal?: AbortSignal) {
  return alphaSearch(target, sessionID, signal, input.tokens, {
    search_query: [
      {
        q: input.query,
        ...(input.recency !== undefined ? { recency: input.recency } : {}),
        ...(input.domains?.length ? { domains: input.domains } : {}),
      },
    ],
  })
}

export function openChatGPT(input: ChatGPTOpenInput, sessionID: string, target: WebTarget, signal?: AbortSignal) {
  // The endpoint takes a `lineno` but always answers from the page's top (2026-10-22), so only
  // `tokens` decides how much of a page arrives.
  return alphaSearch(target, sessionID, signal, input.tokens, { open: [{ ref_id: input.url }] })
}

export async function searchClaude(
  input: ClaudeSearchInput,
  sessionID: string,
  target: WebTarget,
  signal?: AbortSignal,
): Promise<Tool.Result> {
  const model = chooseSearchModel(target.models, "claude", DEFAULT_CLAUDE_SEARCH_MODEL, input.model)
  if (!model)
    throw new Error(
      input.model
        ? `${input.model} is not a Claude model CLIProxyAPI serves from Claude accounts`
        : "CLIProxyAPI lists no Claude model from Claude accounts",
    )
  const reply = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeReply))(
    await post(target, "/messages", {
      signal,
      headers: { "anthropic-version": "2023-06-01", "X-Session-ID": searchSession(sessionID) },
      timeout: 180_000,
      body: {
        model,
        max_tokens: 2000,
        // With thinking on, Haiku spent its whole budget thinking and wrote no answer.
        thinking: { type: "disabled" },
        system: CLAUDE_SYSTEM,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: input.searches ?? DEFAULT_SEARCHES,
            ...(input.domains?.length ? { allowed_domains: input.domains } : {}),
          },
        ],
        messages: [{ role: "user", content: input.question }],
      },
    }),
  )
  const answer = reply.content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("")
    .trim()
  const queries = reply.content.flatMap((block) =>
    block.type === "server_tool_use"
      ? Option.toArray(Schema.decodeUnknownOption(Schema.Struct({ query: Schema.String }))(block.input)).map(
          (item) => item.query,
        )
      : [],
  )
  const results = reply.content.filter((block) => block.type === "web_search_tool_result")
  const errors = results.flatMap((block) =>
    Option.toArray(Schema.decodeUnknownOption(Schema.Struct({ error_code: Schema.String }))(block.content)).map(
      (item) => item.error_code,
    ),
  )
  if (!answer)
    throw new Error(
      `Claude wrote no answer (stop: ${reply.stop_reason ?? "unknown"}${errors.length ? `; search errors: ${errors.join(", ")}` : ""})`,
    )
  const cited = unique(
    reply.content.flatMap((block) => (block.citations ?? []).flatMap((item) => Option.toArray(decodeSource(item)))),
  )
  const sources = cited.length
    ? cited
    : unique(
        results.flatMap((block) =>
          Array.isArray(block.content) ? block.content.flatMap((item) => Option.toArray(decodeSource(item))) : [],
        ),
      )
  const usage = reply.usage
  const searches = usage?.server_tool_use?.web_search_requests
  return {
    output: {
      answer,
      model,
      queries,
      sources,
      ...(searches === undefined ? {} : { searches }),
      tokens: {
        input:
          (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
        output: usage?.output_tokens ?? 0,
      },
    },
    content: [
      answer,
      sources.length
        ? `${cited.length ? "Sources" : "Results"}:\n${sources.map((item) => `- ${item.title ? `${item.title} ` : ""}(${item.url})`).join("\n")}`
        : "",
      `${model} searched: ${queries.map((query) => JSON.stringify(query)).join("; ") || "nothing"}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  }
}

/** The tools, on the `/connect` login's CPA, with the model catalogue Pacer saved for it. */
export function registerWebTools(ctx: Plugin.Context) {
  const target = async () => {
    const found = await webTarget(ctx)
    if (!found) throw new Error("Connect CLIProxyAPI through /connect to search the web through it.")
    return found
  }
  // Core's web namespace, beside its own opencode_search and opencode_fetch. The permission
  // actions are core's: searches ask as websearch, opening a page as webfetch.
  const searchOptions = { namespace: "web", permission: "websearch" }
  const fetchOptions = { namespace: "web", permission: "webfetch" }
  const origin = { type: "plugin" as const, name: "opencode-pacer" }
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "chatgpt_search",
      description:
        "Search the web with ChatGPT's search engine (through CLIProxyAPI). Returns the found pages' text, each with its title and URL. `tokens` caps the text (default 2000, about 8000 characters).",
      input: ChatGPTSearchInput,
      output: ChatGPTOutput,
      options: searchOptions,
      origin,
      execute: async (input, context) => searchChatGPT(input, context.sessionID, await target(), context.signal),
    })
    editor.add({
      name: "chatgpt_fetch",
      description:
        "Open a web page through ChatGPT's search engine (through CLIProxyAPI) and return its text from the top, as numbered lines (L0, L1, …) with the page's total line count. `tokens` caps the text (default 2000, about 8000 characters); raise it to read further down a long page.",
      input: ChatGPTOpenInput,
      output: ChatGPTOutput,
      options: fetchOptions,
      origin,
      execute: async (input, context) => openChatGPT(input, context.sessionID, await target(), context.signal),
    })
    editor.add({
      name: "claude_search",
      description:
        "Ask a Claude model (through CLIProxyAPI) to search the web and answer a question with sources. Claude's search results are readable only by Claude, so this returns its short answer, the pages it cited and the queries it ran. Costs Claude tokens: roughly 10-20k input per question.",
      input: ClaudeSearchInput,
      output: ClaudeOutput,
      options: searchOptions,
      origin,
      execute: async (input, context) => searchClaude(input, context.sessionID, await target(), context.signal),
    })
  })
}

const Saved = Schema.Struct({
  baseURL: Schema.String,
  catalogue: Schema.optional(Schema.Struct({ models: Schema.Array(SearchModel) })),
})

// Pacer resolves the same login and saves its catalogue under `catalogue` with the URL it came from.
async function webTarget(ctx: Plugin.Context): Promise<WebTarget | undefined> {
  const active = await ctx.integration.connection.active("cliproxyapi").catch(() => undefined)
  if (active?.type !== "credential") return undefined
  const credential = await ctx.integration.connection.resolve(active).catch(() => undefined)
  if (credential?.type !== "key" || !credential.key) return undefined
  const raw = credential.configuration?.baseURL
  const baseURL = typeof raw === "string" ? normaliseBaseURL(raw) : undefined
  if (!baseURL) return undefined
  const saved = Schema.decodeUnknownOption(Saved)(await ctx.storage.get("catalogue"))
  const models = saved._tag === "Some" && saved.value.baseURL === baseURL ? (saved.value.catalogue?.models ?? []) : []
  return { baseURL, key: credential.key, models }
}

// ChatGPT's citation markers (U+E200 … U+E201) only mean something to ChatGPT.
const CITATION_MARKER = /\ue200[^\ue201]*\ue201/g

async function alphaSearch(
  target: WebTarget,
  sessionID: string,
  signal: AbortSignal | undefined,
  tokens: number | undefined,
  commands: Record<string, unknown>,
): Promise<Tool.Result> {
  const model = chooseSearchModel(target.models, "codex", DEFAULT_CHATGPT_SEARCH_MODEL)
  if (!model) throw new Error("CLIProxyAPI lists no ChatGPT model from Codex accounts")
  const reply = Schema.decodeUnknownSync(Schema.fromJsonString(ChatGPTReply))(
    await post(target, "/alpha/search", {
      signal,
      timeout: 90_000,
      // CPA keys the Codex account choice on `id`.
      body: { id: searchSession(sessionID), model, commands, max_output_tokens: tokens ?? DEFAULT_TOKENS },
    }),
  )
  const text = reply.output.replace(CITATION_MARKER, "").trim() || "ChatGPT's search returned no text."
  return {
    output: {
      text,
      model,
      sources: unique((reply.results ?? []).flatMap((item) => Option.toArray(decodeSource(item)))),
    },
    content: text,
  }
}

// A chat's searches stay on one account, under their own ID: Pacer keys a chat's state (its
// account and cache warmth) on the chat's ID, and a search must not count as the chat's request.
function searchSession(sessionID: string) {
  return `${sessionID}-search`
}

function unique(sources: readonly (typeof Source.Type)[]) {
  return sources
    .filter((item, index) => sources.findIndex((other) => other.url === item.url) === index)
    .map((item) => ({ url: item.url, ...(item.title ? { title: item.title } : {}) }))
}

async function post(
  target: WebTarget,
  path: string,
  request: {
    readonly body: unknown
    readonly headers?: Record<string, string>
    readonly timeout: number
    readonly signal?: AbortSignal
  },
) {
  const timeout = AbortSignal.timeout(request.timeout)
  const response = await fetch(`${target.baseURL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...request.headers,
    },
    body: JSON.stringify(request.body),
    signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
    redirect: "error",
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`CPA ${path} HTTP ${response.status}: ${text.slice(0, 300)}`)
  return text
}
