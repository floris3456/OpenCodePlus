import type { Plugin } from "@opencode/plugin/tui"
import { Definition } from "../rpc.js"

export interface MissToast {
  readonly enabled: () => boolean
  readonly toggle: () => Promise<void>
  readonly dispose: () => void
}

export function createMissToast(context: Plugin.Context): MissToast {
  const plus = context.client.rpc(Definition)

  const [settings, saveSettings] = context.storage.store<{ enabled?: boolean }>("opencode.plus.miss-notices", {
    initial: { enabled: true },
  })

  const enabled = () => settings.enabled ?? true

  async function toggle() {
    const next = !enabled()
    await saveSettings((draft) => {
      draft.enabled = next
    })
    context.ui.toast.show({
      variant: "info",
      message: `Cache-miss notices: ${next ? "on" : "off"}`,
    })
  }

  function screenSessionID(): string | undefined {
    const route = context.ui.router.current()
    if (route.type !== "session") return undefined
    return route.sessionID
  }

  const lastToastedBySession = new Map<string, string>()
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
    pendingRetry.delete(sessionID)
    // Dropped thinking stays dropped on every later step, so it alerts once per first dropped block.
    // This alert does not follow the cache-miss notice switch.
    const dropped =
      res.droppedThinking && droppedBySession.get(sessionID) !== (res.droppedThinking.first ?? "")
        ? res.droppedThinking
        : undefined
    if (dropped) droppedBySession.set(sessionID, dropped.first ?? "")
    const stepID = res.stepID ?? res.requestID
    const miss = res.miss && lastToastedBySession.get(sessionID) !== stepID
    if (miss) lastToastedBySession.set(sessionID, stepID)
    if (screenSessionID() !== sessionID) return
    const notices = [
      ...(dropped
        ? [
            `Claude dropped ${dropped.blocks.toLocaleString("en-US")} earlier thinking block${dropped.blocks === 1 ? "" : "s"} and answered without them`,
          ]
        : []),
      ...(miss && enabled()
        ? [`Cache shortfall estimate · ${res.notReused.toLocaleString("en-US")} tokens · ${res.causeText}`]
        : []),
    ]
    if (notices.length === 0) return
    context.ui.toast.show({
      variant: "warning",
      message: `${notices.join(" · ")} · type /monitor for details`,
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

  function dispose() {
    unsubscribeStep()
    unsubscribeNext()
  }

  return {
    enabled,
    toggle,
    dispose,
  }
}
