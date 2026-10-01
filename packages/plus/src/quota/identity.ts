import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { randomBytes } from "node:crypto"

// Locations in the same workspace share plugin storage. Serialize first creation
// so concurrently starting child locations cannot mint different installations.
const pending = new Map<string, Promise<string>>()

export function installationIdentity(ctx: Context) {
  const key = ctx.location.workspaceID ?? "local"
  const previous = pending.get(key)
  if (previous) return previous
  const created = Effect.runPromise(
    Effect.gen(function* () {
      const stored = yield* ctx.storage.get("quota/installation")
      if (stored !== undefined) {
        if (typeof stored !== "string" || stored.length < 32)
          throw new Error("Invalid stored quota installation identity")
        return stored
      }
      const identity = randomBytes(24).toString("hex")
      yield* ctx.storage.set("quota/installation", identity)
      return identity
    }),
  )
  pending.set(key, created)
  return created
}
