import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { MonitorView, TOOLS_BODY_ROWS } from "./view.js"

// The monitor in the TUI: a Tools tab in the session composer (next to
// Subagents, Shell and Team) for the chat at hand, and a full-screen view
// (the /tools command) for history, grouping and comparisons.
export function createMonitor(context: Plugin.Context) {
  const [previous, setPrevious] = createSignal<ReturnType<Plugin.Context["ui"]["router"]["current"]>>({
    ...context.ui.router.current(),
  })
  const [chat, setChat] = createSignal<string | undefined>()

  const open = (sessionID?: string) => {
    const current = context.ui.router.current()
    if (current.type === "plugin" && current.name === "monitor") return
    setPrevious({ ...current })
    setChat(sessionID ?? (current.type === "session" ? current.sessionID : undefined))
    context.ui.dialog.clear()
    context.ui.router.navigate({ type: "plugin", name: "monitor" })
  }

  const disposeRoute = context.ui.router.register({
    name: "monitor",
    render: () => (
      <MonitorView
        context={context}
        sessionID={chat}
        active={() => {
          const current = context.ui.router.current()
          return current.type === "plugin" && current.name === "monitor"
        }}
        full
        onClose={() => context.ui.router.navigate(previous())}
      />
    ),
  })

  const disposeTab =
    context.ui.composer?.tab({
      id: "monitor",
      label: "Tools",
      height: TOOLS_BODY_ROWS,
      hints: () => [
        { label: "group", shortcut: "g" },
        { label: "scope", shortcut: "s" },
        { label: "window", shortcut: "t" },
        { label: "filter", shortcut: "a/f" },
        { label: "full", shortcut: "M" },
      ],
      render: (input) => (
        <MonitorView
          context={context}
          sessionID={() => input.sessionID}
          active={input.active}
          full={false}
          mode="composer"
          onClose={input.close}
          onOpenFull={() => {
            input.close()
            open(input.sessionID)
          }}
        />
      ),
    }) ?? (() => {})

  return {
    open,
    dispose: () => {
      disposeTab()
      disposeRoute()
    },
  }
}
