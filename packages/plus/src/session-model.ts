import type { Context } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import type { ModelRefLike } from "./instructions/inventory.js"

export function toHostModelRef(wanted: ModelRefLike): Model.Ref {
  return Model.Ref.make({
    providerID: Provider.ID.make(wanted.providerID),
    id: Model.ID.make(wanted.modelID),
    ...(wanted.variant === undefined ? {} : { variant: Model.VariantID.make(wanted.variant) }),
  })
}

export async function currentSessionAgent(ctx: Context, sessionID: string): Promise<string | undefined> {
  const session = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(() => undefined)
  const agent = (session as { agent?: unknown } | undefined)?.agent
  if (typeof agent === "string" && agent.length > 0) return agent
  // Core accepts an omitted agent and resolves the default itself
  // (core/src/session.ts create without agent, core/src/agent.ts
  // resolve/select put the selected default first in list). Mirror that here
  // so a default-agent session still adopts the default agent's model.
  const listed = await Effect.runPromise(ctx.agent.list()).catch(() => undefined)
  const data = (listed as { data?: readonly { id?: unknown }[] } | undefined)?.data
  const first = data?.[0]?.id
  if (typeof first === "string" && first.length > 0) return first
  if (first !== undefined && first !== null) {
    const text = String(first)
    if (text.length > 0) return text
  }
  return undefined
}

export async function currentSessionModel(ctx: Context, sessionID: string): Promise<ModelRefLike | undefined> {
  const session = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(() => undefined)
  const model = (session as { model?: { providerID?: unknown; id?: unknown; variant?: unknown } } | undefined)?.model
  if (model === undefined) return undefined
  const providerID = typeof model.providerID === "string" ? model.providerID : String(model.providerID ?? "")
  const modelID = typeof model.id === "string" ? model.id : String(model.id ?? "")
  if (providerID.length === 0 || modelID.length === 0) return undefined
  if (typeof model.variant === "string" && model.variant.length > 0) return { providerID, modelID, variant: model.variant }
  return { providerID, modelID }
}

// A chat's model memory per agent, from its own history: the last assistant
// message of that agent. The context holds the messages since the last
// completed compaction, so an agent last used before it falls back to its
// active model. A missing or failing context read means no history.
export async function chatModelForAgent(ctx: Context, sessionID: string, agentID: string): Promise<ModelRefLike | undefined> {
  const messages = await Effect.runPromise(
    Effect.suspend(() => ctx.session.context({ sessionID: Session.ID.make(sessionID) })),
  ).catch(() => undefined)
  const last = messages?.findLast((message) => message.type === "assistant" && message.agent === agentID)
  if (last?.type !== "assistant") return undefined
  return {
    providerID: last.model.providerID,
    modelID: last.model.id,
    ...(last.model.variant === undefined ? {} : { variant: last.model.variant }),
  }
}
