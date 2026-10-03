import { Plugin } from "@opencode/plugin/tui"
import { createQuota } from "../quota/tui.js"
import { UsageDefinition } from "../quota/usage.js"
import { createUsage } from "../quota/usage-view.js"

/**
 * TUI half of opencode.plus.cliproxyapi: quota notices and the credential usage
 * views. Nothing is shown unless the server half is running and CLIProxyAPI is
 * configured, so hosts without CPA (or with the plugin removed) see no Usage UI.
 */
export default Plugin.define({
  id: "opencode.plus.cliproxyapi",
  setup(context) {
    const disposers: (() => void)[] = []
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
      if (!result.enabled) return
      disposers.push(createQuota(context), createUsage(context))
    }
    void probe(0)
    return () => {
      state.disposed = true
      disposers.splice(0).forEach((dispose) => dispose())
    }
  },
})
