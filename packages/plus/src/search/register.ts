import { fileURLToPath } from "node:url"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Schema } from "effect"
import { runRegistration } from "../instructions/apply.js"
import { exaSearch, tavily } from "./api.js"
import { searchToolDescription } from "./tools.js"

export { searchKeysDir } from "./keys.js"

// Tavily and Exa as built-in Code Mode tools in core's `web` namespace, beside
// `web.opencode_search` and `web.opencode_fetch`: `tools.web.exa_code_search`,
// `tools.web.tavily_search` and `tools.web.tavily_fetch`. Searches ask the
// `websearch` permission and fetching the `webfetch` one, as core's own do.
const origin = { type: "plugin", name: "opencode.plus" } as const
const searchOptions = { namespace: "web", permission: "websearch" } as const
const fetchOptions = { namespace: "web", permission: "webfetch" } as const

const Count = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

export const ExaCodeSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Natural language describing the code you need; specify language/framework/version",
  }),
  type: Schema.Literals(["fast", "auto", "neural", "keyword"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("fast" as const))),
  numResults: Count(1, 100).pipe(Schema.withDecodingDefaultKey(Effect.succeed(10))),
  includeDomains: Schema.optionalKey(Schema.Array(Schema.String)),
  excludeDomains: Schema.optionalKey(Schema.Array(Schema.String)),
  startPublishedDate: Schema.optionalKey(Schema.String),
  endPublishedDate: Schema.optionalKey(Schema.String),
  contents: Schema.Struct({
    text: Schema.optionalKey(
      Schema.Union([Schema.Boolean, Schema.Struct({ maxCharacters: Schema.Int.check(Schema.isGreaterThan(0)) })]),
    ),
    highlights: Schema.optionalKey(Schema.Boolean),
    summary: Schema.optionalKey(Schema.Boolean),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ highlights: true }))),
})

export const TavilySearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  search_depth: Schema.Literals(["ultra-fast", "fast", "basic", "advanced"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("basic" as const))),
  topic: Schema.Literals(["general", "news", "finance"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("general" as const))),
  max_results: Count(1, 20).pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
  time_range: Schema.optionalKey(Schema.Literals(["day", "week", "month", "year"])),
  include_domains: Schema.optionalKey(Schema.Array(Schema.String)),
  exclude_domains: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const TavilyFetchInput = Schema.Struct({
  urls: Schema.Array(Schema.String.check(Schema.makeFilter((url) => URL.canParse(url) || "must be a URL"))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  extract_depth: Schema.Literals(["basic", "advanced"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("basic" as const))),
  query: Schema.optionalKey(Schema.String),
  chunks_per_source: Schema.optionalKey(Count(1, 5)),
  format: Schema.Literals(["markdown", "text"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("markdown" as const))),
})

export async function registerSearchTools(ctx: Context): Promise<Registration> {
  return runRegistration(ctx.tool.transform, (editor) => {
    editor.add({
      name: "exa_code_search",
      description: searchToolDescription("exa_code_search"),
      input: ExaCodeSearchInput,
      output: Schema.Unknown,
      options: searchOptions,
      origin,
      execute: (input) => call(() => exaSearch(input)),
    })
    editor.add({
      name: "tavily_search",
      description: searchToolDescription("tavily_search"),
      input: TavilySearchInput,
      output: Schema.Unknown,
      options: searchOptions,
      origin,
      execute: (input) => call(() => tavily("search", input)),
    })
    editor.add({
      name: "tavily_fetch",
      description: searchToolDescription("tavily_extract"),
      input: TavilyFetchInput,
      output: Schema.Unknown,
      options: fetchOptions,
      origin,
      execute: (input) => call(() => tavily("extract", input)),
    })
  })
}

function call(request: () => Promise<unknown>) {
  return Effect.tryPromise({
    try: request,
    catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
  }).pipe(Effect.map((output) => ({ output })))
}

/**
 * Plus used to add its search MCP server as `search` (search/bin.ts, later
 * `opencodeplus search-mcp`, both with OPENCODEPLUS_SEARCH_KEYS_DIR). Its tools
 * are built in now, so such an entry would only add them twice: it is left out.
 * A server of the user's own under that name stays.
 */
export async function retireSearchMcp(ctx: Context): Promise<Registration | undefined> {
  const current = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<unknown, never>()
        yield* ctx.mcp.transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed(editor.get("search")))
        })
        return yield* Deferred.await(deferred)
      }),
    ),
  )
  if (!isGeneratedSearchConfig(current)) return undefined
  const registration = await runRegistration(ctx.mcp.transform, (editor) => {
    if (isGeneratedSearchConfig(editor.get("search"))) editor.remove("search")
  })
  await Effect.runPromise(ctx.mcp.reload())
  return registration
}

export function isGeneratedSearchConfig(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false
  const entry = config as { readonly command?: unknown; readonly environment?: Record<string, unknown> }
  if (entry.environment?.OPENCODEPLUS_SEARCH_KEYS_DIR !== undefined) return true
  return isOldGeneratedSearchCommand(entry.command)
}

export function isOldGeneratedSearchCommand(command: unknown): boolean {
  if (!Array.isArray(command)) return false
  if (command.length !== 2) return false
  const second = command[1]
  if (typeof second !== "string") return false
  return /(?:^|[\\/])search[\\/]bin\.(?:ts|js)$/.test(second)
}

/** The stand-alone server's entry point in a source checkout; `opencodeplus search-mcp` in a build. */
export async function resolveSearchBinPath(): Promise<string> {
  const tsPath = fileURLToPath(new URL("./bin.ts", import.meta.url))
  if (await Bun.file(tsPath).exists()) return tsPath
  return fileURLToPath(new URL("./bin.js", import.meta.url))
}
