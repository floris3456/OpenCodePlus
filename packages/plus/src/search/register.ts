import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Deferred, Effect } from "effect"
import fsSync from "node:fs"
import { fileURLToPath } from "node:url"
import { runRegistration } from "../instructions/apply.js"

export function resolveSearchBinPath(): string {
  const tsPath = fileURLToPath(new URL("./bin.ts", import.meta.url))
  const jsPath = fileURLToPath(new URL("./bin.js", import.meta.url))
  return fsSync.existsSync(tsPath) ? tsPath : jsPath
}

export async function registerSearchMcp(
  ctx: Context,
  binPath = resolveSearchBinPath(),
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

  const registration = await runRegistration(ctx.mcp.transform, (editor) => {
    if (editor.get("search") !== undefined) return
    editor.set("search", {
      type: "local",
      command: [process.execPath, binPath],
      enabled: true,
    } as any)
  })

  await Effect.runPromise(ctx.mcp.reload())
  return registration
}
