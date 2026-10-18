import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import type { ActiveTeamInfo } from "../active-team.js"
import { MonitorView, type MonitorTarget } from "./view.js"

// Sessions use the host's panel, including its in-place fullscreen toggle.
// The route also makes Monitor available from Home, where panels cannot open.
// With a team active, both show its Team tab.
export function createMonitor(context: Plugin.Context, options: { readonly team?: () => ActiveTeamInfo | undefined } = {}) {
  const [previous, setPrevious] = createSignal<ReturnType<Plugin.Context["ui"]["router"]["current"]>>({
    ...context.ui.router.current(),
  })
  const [chat, setChat] = createSignal<string | undefined>()
  // A cache notice waiting for the view that opens (or is open) to take it.
  const [target, setTarget] = createSignal<MonitorTarget>()

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

  /** Opens the monitor on one request of one session: a cache notice's miss. */
  const openAt = (next: MonitorTarget) => {
    setTarget({ sessionID: next.sessionID, requestID: next.requestID })
    open()
  }

  const disposeRoute = context.ui.router.register({
    name: "monitor",
    render: (route) => (
      <MonitorView
        context={context}
        sessionID={() => (route?.data as { sessionID?: string } | undefined)?.sessionID ?? chat()}
        active={() => {
          const current = context.ui.router.current()
          return current.type === "plugin" && current.name === "monitor"
        }}
        full
        initialSession
        target={target}
        onTarget={() => setTarget(undefined)}
        onClose={() => context.ui.router.navigate(previous())}
        {...(options.team === undefined ? {} : { team: options.team })}
      />
    ),
  })

  const disposePanel = context.ui.slot({
    append: "session.panel",
    render: (panel) => (
      <Show when={panel.name === "plus.monitor"}>
        <MonitorView
          context={context}
          sessionID={() => panel.sessionID}
          active={() => panel.focused}
          full
          initialSession
          width={panel.width}
          focus={panel.focus}
          target={target}
          onTarget={() => setTarget(undefined)}
          onClose={panel.close}
          onToggleFullscreen={panel.toggleFullscreen}
          {...(options.team === undefined ? {} : { team: options.team })}
        />
      </Show>
    ),
  })

  return {
    open,
    openAt,
    dispose: () => {
      disposePanel()
      disposeRoute()
    },
  }
}
