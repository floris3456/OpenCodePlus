import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Mcp } from "@opencode/schema/mcp"
import { Deferred, Effect } from "effect"
import { runRegistration } from "../instructions/apply.js"
import { searchKeysDir } from "./keys.js"

export { searchKeysDir } from "./keys.js"

export async function resolveSearchBinPath(): Promise<string> {
  const tsPath = fileURLToPath(new URL("./bin.ts", import.meta.url))
  if (await Bun.file(tsPath).exists()) return tsPath
  return fileURLToPath(new URL("./bin.js", import.meta.url))
}

export function searchMcpCommand(input: {
  execPath: string
  binPath: string
  binPathExists: boolean
}): string[] {
  if (!input.binPathExists) {
    return [path.resolve(input.execPath), "search-mcp"]
  }
  return [input.execPath, input.binPath]
}

export function isOldGeneratedSearchCommand(command: unknown): boolean {
  if (!Array.isArray(command)) return false
  if (command.length !== 2) return false
  const second = command[1]
  if (typeof second !== "string") return false
  return /(?:^|[\\/])search[\\/]bin\.(?:ts|js)$/.test(second)
}

function isOldGeneratedConfig(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false
  if (!("command" in config)) return false
  return isOldGeneratedSearchCommand((config as { command: unknown }).command)
}

export async function registerSearchMcp(
  ctx: Context,
  binPath?: string,
): Promise<Registration | undefined> {
  const existing = await Effect.runPromise(
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

  if (existing !== undefined && !isOldGeneratedConfig(existing)) {
    await Effect.runPromise(Effect.logInfo("search MCP already configured; not replacing"))
    return undefined
  }

  const resolvedBinPath = binPath ?? (await resolveSearchBinPath())
  const binPathExists = !resolvedBinPath.includes("$bunfs") && (await Bun.file(resolvedBinPath).exists())
  const command = searchMcpCommand({
    execPath: process.execPath,
    binPath: resolvedBinPath,
    binPathExists,
  })

  const registration = await runRegistration(ctx.mcp.transform, (editor) => {
    const current = editor.get("search")
    if (current !== undefined && !isOldGeneratedConfig(current)) return
    editor.set(
      "search",
      new Mcp.LocalConfig({
        type: "local",
        command,
        environment: {
          BUN_BE_BUN: "0",
          OPENCODEPLUS_SEARCH_KEYS_DIR: searchKeysDir(),
        },
      }),
    )
  })

  await Effect.runPromise(ctx.mcp.reload())
  return registration
}
