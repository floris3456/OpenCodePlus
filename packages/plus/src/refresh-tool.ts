import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Effect, Schema } from "effect"
import { runRegistration } from "./instructions/apply.js"
import type { PlusApi } from "./index.js"

// The /refresh tool: rebuild what this chat sends from the current settings and
// files. The same meaning as the TUI command, so an agent does not need the
// shell for it. It lives in core's `opencode` namespace as `refresh`, next to
// session_move and models.
const namespace = "opencode"
const origin = { type: "plugin", name: "opencode.plus" } as const
const options = { namespace, codemode: true, permission: "opencode_refresh" } as const

export const RefreshDescription =
  "Rebuild what this chat sends from the current settings and files: this folder's config, agents, skills, commands and MCP servers, and any pending Instructions change. This may rebuild a cached prompt prefix, so the next request re-reads its input; the result names that cost. Normal use never needs it — a new chat or a compaction folds changes in already.\n" +
  "dryRun:true reports the cost without reloading."

const RefreshInput = Schema.Struct({
  /** Only report the cost; do not reload. */
  dryRun: Schema.optionalKey(Schema.Boolean),
})

export async function registerRefreshTool(ctx: Context, api: PlusApi): Promise<Registration> {
  return runRegistration(ctx.tool.transform, (editor) => {
    editor.add({
      name: "refresh",
      description: RefreshDescription,
      input: RefreshInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input, context) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            api.chatRefresh({ sessionID: String(context.sessionID), ...(input.dryRun === true ? { dryRun: true } : {}) }),
          )
          const value = result.value
          const tokens = Math.round(value.reReadTokens / 1000)
          const cost =
            value.reReadTokens === 0
              ? "no measured last request"
              : `re-reads about ${tokens}k tokens${value.withoutCache ? " without cache" : ""}`
          return {
            output: value,
            content: input.dryRun === true ? `Refresh would ${cost}.` : `Refreshed: ${cost}.`,
          }
        }),
    })
  })
}
