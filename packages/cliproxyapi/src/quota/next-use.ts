import { chatUsage, type NextUse } from "opencode-pacer/core"
import { Schema } from "effect"
import { Stored } from "./protocol.js"
import type { UsageInput } from "./usage.js"

/** Plus owns its claim capability; stock switch handling is disabled. UI reads
 * reuse that existing capability and never enroll or wake a chat. */
export function createNextUse(io: { read(key: string): Promise<unknown>; fetch: typeof fetch; now(): number }) {
  const cache = new Map<string, { at: number; result: Promise<NextUse | undefined> }>()
  return (origin: string | undefined, input: UsageInput): Promise<NextUse | undefined> => {
    if (!origin || !input.sessionID) return Promise.resolve(undefined)
    const key = JSON.stringify([origin, input.sessionID, input.providerID, input.modelID])
    const previous = cache.get(key)
    if (previous && io.now() - previous.at < 15_000) return previous.result
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    const result = (async () => {
      const stored = Schema.decodeUnknownOption(Stored)(
        await io.read(`quota/${input.sessionID}/${input.providerID}/${input.modelID}`),
      )
      if (stored._tag === "None") return
      const view = await chatUsage(io.fetch, origin, stored.value.capability, `${input.providerID}/${input.modelID}`)
      if (view.next_use?.model !== input.modelID || view.next_use.expires_ms <= io.now()) return
      return view.next_use
    })().catch(() => undefined)
    cache.set(key, { at: io.now(), result })
    return result
  }
}
