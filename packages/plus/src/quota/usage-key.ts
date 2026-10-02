import type { Context } from "@opencode/plugin/effect/plugin"
import { Provider } from "@opencode/schema/provider"
import { Effect } from "effect"
import type { UsageInput } from "./usage.js"

/** Resolve the same configured connection used by model calls, entirely inside the host. */
export function usageKey(ctx: Context, input: UsageInput, origin: string) {
  return Effect.gen(function* () {
    const provider = (yield* ctx.provider.get({ providerID: Provider.ID.make(input.providerID) })).data
    const models = (yield* ctx.model.list()).data
    const model = models.find((value) => value.providerID === input.providerID && value.id === input.modelID)
    if (!model) return
    const connection = yield* ctx.integration.connection.active(provider.integrationID ?? provider.id)
    const credential = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
    const configuration = credential?.type === "key" ? credential.configuration : undefined
    const settings = { ...provider.settings, ...model.settings, ...credential?.metadata, ...configuration }
    const baseURL = settings.baseURL
    // Never send a provider key to a separately configured quota origin.
    if (typeof baseURL !== "string" || new URL(baseURL).origin !== new URL(origin).origin) return
    const key = credential?.type === "key" ? credential.key : settings.apiKey
    return typeof key === "string" && key.length > 0 ? key : undefined
  })
}
