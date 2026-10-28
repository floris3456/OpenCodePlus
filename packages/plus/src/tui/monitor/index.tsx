import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup, Show } from "solid-js"
import type { ActiveTeamInfo } from "../active-team.js"
import { MonitorView, type MonitorPlace, type MonitorTarget } from "./view.js"

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
  // Where the Monitor was when it opened a chat. The panel belongs to one chat,
  // so the chat it opens mounts a new view, which takes this place.
  let place: MonitorPlace | undefined
  const takePlace = () => {
    const next = place
    place = undefined
    return next
  }

  const open = (sessionID?: string) => {
    place = undefined
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

  /** Opens a chat from the Monitor and keeps the Monitor open there, on the same tab and row. */
  const openSession = (sessionID: string, next: MonitorPlace) => {
    const current = context.ui.router.current()
    if (current.type === "session" && current.sessionID === sessionID) return
    place = next
    context.ui.router.navigate({ type: "session", sessionID })
    if (!context.ui.panel.open("plus.monitor")) place = undefined
  }

  // The panel's own keys stop once the chat beside it has the focus (typing in
  // the prompt, a click outside the panel); Esc still closes it then, before
  // the prompt's interrupt of a running reply (priority 0) can take it. A
  // dialog, autocomplete, the composer and forms push their own keymap mode,
  // which turns this layer off, so they keep Esc. While the panel has the
  // focus its view's own Esc runs instead (the Prompt tab steps back first).
  const [panelInput, setPanelInput] = createSignal<PanelInput>()
  context.keymap.layer(() => ({
    enabled: () => context.ui.panel.current()?.name === "plus.monitor" && panelInput()?.focused !== true,
    priority: 1,
    commands: [{ bind: "escape", title: "Close monitor", group: "Monitor", run: () => context.ui.panel.close() }],
  }))

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
        onOpenSession={openSession}
        onClose={() => context.ui.router.navigate(previous())}
        {...(options.team === undefined ? {} : { team: options.team })}
      />
    ),
  })

  const disposePanel = context.ui.slot({
    append: "session.panel",
    render: (panel) => {
      setPanelInput(panel)
      onCleanup(() => setPanelInput((current) => (current === panel ? undefined : current)))
      return (
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
          onOpenSession={openSession}
          place={takePlace}
          onClose={panel.close}
          onToggleFullscreen={panel.toggleFullscreen}
          {...(options.team === undefined ? {} : { team: options.team })}
        />
      </Show>
      )
    },
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
