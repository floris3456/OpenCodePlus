import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { createQuota } from "./quota/tui.js"
import { UsageDefinition } from "./quota/usage.js"
import { createUsage } from "./quota/usage-view.js"

/** How often the TUI asks again while quota is off, so Usage appears without a restart. */
export const REPROBE = 30_000

/**
 * TUI half of opencode-pacer: quota notices and the credential usage
 * views. Nothing is shown unless the server half is running and quota is on for
 * a provider, so hosts without CPA (or with the plugin removed) see no Usage UI.
 */
export default Plugin.define({
  id: "opencode-pacer",
  setup(context) {
    const [enabled, setEnabled] = createSignal(false)
    // Register /usage immediately, before discovery, so it is never submitted as a model prompt.
    const disposers = [createUsage(context, { enabled })]
    const state = { disposed: false }
    const rpc = context.client.rpc(UsageDefinition)
    const probe = async (attempt: number): Promise<void> => {
      if (state.disposed) return
      // The server half may register after the TUI starts; retry briefly.
      const result = await rpc.enabled({}).catch(() => undefined)
      if (state.disposed) return
      if (result === undefined) {
        if (attempt < 15) setTimeout(() => void probe(attempt + 1), 2000).unref?.()
        return
      }
      // The server cannot push the change (plugins have no event publish), so ask again.
      if (!result.enabled) {
        setTimeout(() => void probe(0), REPROBE).unref?.()
        return
      }
      setEnabled(true)
      disposers.push(createQuota(context))
    }
    void probe(0)
    return () => {
      state.disposed = true
      disposers.splice(0).forEach((dispose) => dispose())
    }
  },
})
