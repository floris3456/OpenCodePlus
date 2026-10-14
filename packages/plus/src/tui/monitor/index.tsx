import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { CacheScreen } from "./cache-screen.js"

// Sessions use the host's panel, including its in-place fullscreen toggle.
// The route also makes Monitor available from Home, where panels cannot open.
export function createMonitor(context: Plugin.Context) {
  const [previous, setPrevious] = createSignal<ReturnType<Plugin.Context["ui"]["router"]["current"]>>({
    ...context.ui.router.current(),
  })
  const [chat, setChat] = createSignal<string | undefined>()

  const open = (sessionID?: string) => {
    const current = context.ui.router.current()
    if (current.type === "session") {
      context.ui.dialog.clear()
      context.ui.panel.open("plus.monitor")
      return
    }
    if (current.type === "plugin" && current.name === "monitor") return
    setPrevious({ ...current })
    setChat(sessionID)
    context.ui.dialog.clear()
    context.ui.router.navigate({ type: "plugin", name: "monitor" })
  }

  const disposeRoute = context.ui.router.register({
    name: "monitor",
    render: (route) => (
      <CacheScreen
        context={context}
        sessionID={() => (route?.data as { sessionID?: string } | undefined)?.sessionID ?? chat()}
        active={() => {
          const current = context.ui.router.current()
          return current.type === "plugin" && current.name === "monitor"
        }}
        onClose={() => context.ui.router.navigate(previous())}
      />
    ),
  })

  const disposePanel = context.ui.slot({
    append: "session.panel",
    render: (panel) => (
      <Show when={panel.name === "plus.monitor"}>
        <CacheScreen
          context={context}
          sessionID={() => panel.sessionID}
          active={() => panel.focused}
          width={panel.width}
          focus={panel.focus}
          onClose={panel.close}
          onToggleFullscreen={panel.toggleFullscreen}
        />
      </Show>
    ),
  })

  return {
    open,
    dispose: () => {
      disposePanel()
      disposeRoute()
    },
  }
}
