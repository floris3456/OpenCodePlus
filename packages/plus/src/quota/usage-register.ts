import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import type { Config } from "./protocol.js"
import { usageKey } from "./usage-key.js"
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
              key: (input, origin) => Effect.runPromise(usageKey(ctx, input, origin)),
            },
            input,
          ),
        ),
      enabled: () => Effect.succeed({ enabled: config !== undefined }),
    })
    .pipe(Effect.orDie)
}
