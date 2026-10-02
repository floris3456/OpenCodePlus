import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import type { Config } from "./protocol.js"
import { readUsage, UsageDefinition } from "./usage.js"

export function registerUsage(ctx: Context, config: Config | undefined) {
  return ctx.rpc
    .register(UsageDefinition, {
      read: (input) =>
        Effect.promise(() =>
          readUsage(
            config,
            {
              read: (key) => Effect.runPromise(ctx.storage.get(key)),
              fetch,
            },
            input,
          ),
        ),
    })
    .pipe(Effect.orDie)
}
