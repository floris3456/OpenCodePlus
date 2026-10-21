import type { Plugin } from "@opencode/plugin/tui"
import type { UsageWindowInput } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { Definition } from "../rpc.js"

// The footer's and sidebar's context % against Compaction › Input token
// threshold when the chat's agent and model set one (ui.usage.window): the
// server resolves it per agent and model, and an Instructions change asks
// again for every pair already shown.

export function createUsageWindow(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  // undefined: not asked yet; null: no threshold (or a server without the call).
  const [thresholds, setThresholds] = createSignal<ReadonlyMap<string, number | null>>(new Map())
  const asked = new Map<string, Omit<UsageWindowInput, "sessionID">>()
  const pending = new Set<string>()

  const keyOf = (input: Omit<UsageWindowInput, "sessionID">) =>
    `${input.agent}\u0000${input.providerID}/${input.modelID}#${input.variant ?? ""}`
  const load = (key: string) => {
    const input = asked.get(key)
    if (input === undefined || pending.has(key)) return
    pending.add(key)
    void plus["compaction.window"]({
      agent: input.agent,
      providerID: input.providerID,
      modelID: input.modelID,
      ...(input.variant === undefined ? {} : { variant: input.variant }),
    })
      .then(
        (window) => window.input ?? null,
        () => null,
      )
      .then((threshold) => {
        pending.delete(key)
        setThresholds((current) => new Map(current).set(key, threshold))
      })
  }

  const disposeProvider = context.ui.usage.window((input) => {
    const key = keyOf(input)
    const known = thresholds().get(key)
    if (known !== undefined) return known ?? undefined
    // Asked outside the reading computation; its answer updates the signal it reads.
    if (!asked.has(key)) {
      asked.set(key, { agent: input.agent, providerID: input.providerID, modelID: input.modelID, ...(input.variant === undefined ? {} : { variant: input.variant }) })
      queueMicrotask(() => load(key))
    }
    return undefined
  })
  const disposeEvents = plus.events.on("instructions.changed", () => [...asked.keys()].forEach(load))

  return {
    dispose() {
      disposeProvider()
      disposeEvents()
    },
  }
}
