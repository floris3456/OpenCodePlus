import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Mcp } from "@opencode/schema/mcp"
import { Deferred, Effect } from "effect"
import { fileURLToPath } from "node:url"
import { runRegistration } from "../instructions/apply.js"

export async function resolveSearchBinPath(): Promise<string> {
  const tsPath = fileURLToPath(new URL("./bin.ts", import.meta.url))
  if (await Bun.file(tsPath).exists()) return tsPath
  return fileURLToPath(new URL("./bin.js", import.meta.url))
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

  if (existing !== undefined) {
    await Effect.runPromise(Effect.logInfo("search MCP already configured; not replacing"))
    return undefined
  }

  const resolvedBinPath = binPath ?? (await resolveSearchBinPath())

  const registration = await runRegistration(ctx.mcp.transform, (editor) => {
    if (editor.get("search") !== undefined) return
    editor.set(
      "search",
      new Mcp.LocalConfig({
        type: "local",
        command: [process.execPath, resolvedBinPath],
      }),
    )
  })

  await Effect.runPromise(ctx.mcp.reload())
  return registration
}
