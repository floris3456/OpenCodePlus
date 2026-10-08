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
    if (route && typeof route === "object" && "type" in route && route.type === "session" && "sessionID" in route && typeof route.sessionID === "string") {
      return route.sessionID
    }
    return undefined
  }

  const lastToastedBySession = new Map<string, string>()
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
    if (!res.miss) return
    const stepID = res.stepID ?? res.requestID
    if (lastToastedBySession.get(sessionID) === stepID) return
    lastToastedBySession.set(sessionID, stepID)
    if (!enabled()) return
    if (screenSessionID() !== sessionID) return
    context.ui.toast.show({
      variant: "warning",
      message: `Cache miss · ${res.notReused.toLocaleString("en-US")} tokens not reused · ${res.causeText} · type /monitor for details`,
    })
  }

  function handleEvent(event: { type?: string; data?: unknown }) {
    if (!event || typeof event.type !== "string") return
    const data = (event.data ?? {}) as Record<string, unknown>
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return
    if (screenSessionID() !== sessionID) return

    const isStepEnd =
      (event.type === "session.step.ended" || event.type === "session.step.failed") &&
      data.tokens !== null &&
      typeof data.tokens === "object"

    if (isStepEnd) {
      void checkStep(sessionID)
      return
    }

    if (pendingRetry.has(sessionID)) {
      pendingRetry.delete(sessionID)
      void checkStep(sessionID)
    }
  }

  let unsubscribeData: (() => void) | undefined = undefined
  if (typeof context.data?.listen === "function") {
    unsubscribeData = context.data.listen((event: { details?: { type?: string; data?: unknown }; type?: string; data?: unknown }) => {
      handleEvent(event.details ?? event)
    })
  } else if (typeof context.data?.on === "function") {
    const onMethod = context.data.on as unknown as (type: string, handler: (event: unknown) => void) => () => void
    unsubscribeData = onMethod("session.step.ended", (event: unknown) => handleEvent(event as { type?: string; data?: unknown }))
  }

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "plus.miss-notices.toggle",
        title: `Cache-miss notices: turn ${enabled() ? "off" : "on"}`,
        group: "OpenCodePlus",
        palette: true,
        slash: { name: "miss-notices" },
        run: () => void toggle(),
      },
    ],
  }))

  function dispose() {
    unsubscribeData?.()
  }

  return {
    enabled,
    toggle,
    dispose,
  }
}
