import type { Plugin } from "@opencode/plugin/tui"
import { Definition } from "../rpc.js"

// The /refresh command: rebuild what this chat sends from the current settings
// and files, naming the cost first. The same action as tools.opencode.refresh().
export function createChatRefresh(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)

  async function run(): Promise<void> {
    const route = context.ui.router.current()
    if (route.type !== "session") {
      context.ui.toast.show({ variant: "warning", message: "Open a chat to refresh it" })
      return
    }
    const sessionID = route.sessionID
    // Name the cost before reloading, from the chat's last request.
    const dry = await plus["chat.refresh"]({ sessionID, dryRun: true }).catch(() => undefined)
    const tokens = dry === undefined ? 0 : Math.round(dry.reReadTokens / 1000)
    const cost =
      dry === undefined || dry.reReadTokens === 0
        ? "no measured last request"
        : `re-reads about ${tokens}k tokens${dry.withoutCache ? " without cache" : ""}`
    const next = await plus["chat.refresh"]({ sessionID }).catch((error: unknown) => {
      context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
      return undefined
    })
    if (next === undefined) return
    context.ui.toast.show({
      variant: "info",
      message: `Refreshed: ${cost}.`,
      duration: 5000,
    })
  }

  return { run }
}
