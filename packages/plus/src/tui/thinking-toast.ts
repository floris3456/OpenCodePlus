import type { Plugin } from "@opencode/plugin/tui"
import { Definition } from "../rpc.js"

// Claude dropping earlier thinking blocks: a toast for the chat on screen.
// Cache misses and partial reuse are cache notices (cache-notices.tsx).
export function createThinkingToast(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)

  function screenSessionID(): string | undefined {
    const route = context.ui.router.current()
    if (route.type !== "session") return undefined
    return route.sessionID
  }

  const droppedBySession = new Map<string, string>()
  const pendingRetry = new Set<string>()

  async function checkStep(sessionID: string) {
    if (screenSessionID() !== sessionID) return
    const res = await plus["monitor.step"]({ sessionID }).catch(() => undefined)
    if (!res) return
    if (res.status === "pending") {
      pendingRetry.add(sessionID)
      return
    }
    // A rewrite of the ledger file has no answer yet; the next poll asks again.
    if (res.status === "compacting") return
    pendingRetry.delete(sessionID)
    // Dropped thinking stays dropped on every later step, so it alerts once per first dropped block.
    const dropped =
      res.droppedThinking && droppedBySession.get(sessionID) !== (res.droppedThinking.first ?? "")
        ? res.droppedThinking
        : undefined
    if (!dropped) return
    droppedBySession.set(sessionID, dropped.first ?? "")
    if (screenSessionID() !== sessionID) return
    context.ui.toast.show({
      variant: "warning",
      message: `Claude dropped ${dropped.blocks.toLocaleString("en-US")} earlier thinking block${dropped.blocks === 1 ? "" : "s"} and answered without them · type /monitor for details`,
    })
  }

  const unsubscribeStep = context.data.on("session.step.ended", (event) => {
    if (event.data.sessionID !== screenSessionID()) return
    void checkStep(event.data.sessionID)
  })

  const unsubscribeNext = context.data.listen((event) => {
    const sessionID = screenSessionID()
    if (sessionID === undefined || !pendingRetry.has(sessionID)) return
    if ("sessionID" in event.details.data && event.details.data.sessionID !== sessionID) return
    pendingRetry.delete(sessionID)
    void checkStep(sessionID)
  })

  return {
    dispose: () => {
      unsubscribeStep()
      unsubscribeNext()
    },
  }
}
