import type { Plugin } from "@opencode/plugin/tui"
import { Definition, type Plus, type TeamRunEntry } from "@opencode/plus/rpc"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, mergeProps, onCleanup, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createActiveTeam } from "../../../../../plus/src/tui/active-team"
import { createMonitor } from "../../../../../plus/src/tui/monitor"
import { PanelHost } from "../../../component/panel-host"
import { PanelProvider, usePanel } from "../../../context/panel"
import { createFixtureReport } from "./monitor"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

function Panels(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const panels = usePanel()
  const [focused, setFocused] = createSignal(true)
  // The chat on screen: opening a run's chat changes it, as the host's route does.
  const [chat, setChat] = createSignal("ses_lead")
  const [message, setMessage] = createSignal("Fixture only: actions never start or stop real runs")
  // A team as the active agent group shows the Monitor's Team tab.
  const [group, setGroup] = createSignal<string | undefined>("team:project:fixture")
  const runs: TeamRunEntry[] = Array.from({ length: 40 }, (_, index) => ({
    id: `run-${String(index + 1).padStart(2, "0")}`,
    role: "worker",
    state: index % 5 === 4 ? "stopped" : "idle",
    sessionID: `fixture-${index}`,
    task: `Task ${index + 1}`,
    head: "fixture",
    worktree: "present",
    lastUsed: "2026-10-11T00:00:00.000Z",
    depth: index % 3,
    parent: "ses_lead",
  }))
  const now = Date.now()
  const context: Plugin.Context = {
    ...props.context,
    client: {
      ...props.context.client,
      rpc: ((definition: unknown) => {
        if (definition !== Definition) throw new Error("Unexpected fixture RPC")
        return {
          "team.list": async () => ({ teams: [{ level: "project", team: "fixture", enabled: true, members: [{ id: "lead" }] }] }),
          "team.runs.list": async () => ({ runs }),
          "checks.suggest": async () => ({
            root: "/fixture",
            current: [
              { id: "check", argv: ["bun", "run", "check"] },
              { id: "core", argv: ["bun", "test"], cwd: "packages/core" },
            ],
            setup: { id: "setup", argv: ["bun", "install"] },
            suggested: [],
          }),
          "checks.save": async () => {
            setMessage("Saved checks (fixture only)")
            return { path: "/fixture/.opencodeplus/checks.json", checks: [] }
          },
          "team.runs.stop": async (input: { run: string }) => {
            setMessage(`Stopped ${input.run} (fixture only)`)
            return { run: input.run, state: "stopped" }
          },
          "monitor.query": async (input: Plus.MonitorQueryInput) => createFixtureReport(input, "prefix", now),
          "monitor.cache": async (input: Plus.MonitorQueryInput) => createFixtureReport(input, "prefix", now),
          "monitor.mark": async (input: Plus.MonitorMarkInput) => ({ id: 1, at: now, label: input.label }),
          events: { on: () => () => {} },
        }
      }) as unknown as Plugin.Context["client"]["rpc"],
    },
    data: { ...props.context.data, listen: () => () => {} },
    storage: {
      ...props.context.storage,
      store: (_key, options) => {
        const [state, setState] = createStore(structuredClone(options.initial))
        return [state, async (mutation) => { setState(produce(mutation)) }]
      },
    },
    ui: {
      ...props.context.ui,
      agents: {
        ...props.context.ui.agents,
        groups: () => () => {},
        activeGroup: { current: group, set: setGroup },
      },
      router: {
        register: () => () => {},
        current: () => ({ type: "session", sessionID: chat() }),
        navigate: (route) => {
          if (route.type === "session") setChat(route.sessionID)
          setMessage(`Navigate to ${route.type === "session" ? route.sessionID : route.type} (fixture only)`)
        },
      },
      panel: {
        open: (name, options) => {
          panels.open({ plugin: "storybook", name: `fixture.${name}`, sessionID: chat() }, options?.presentation)
          setFocused(true)
          return true
        },
        close: panels.close,
        // The plugin's own panel, by the name it opened, as the host answers.
        current: () => {
          const current = panels.current()
          if (!current?.name.startsWith("fixture.")) return undefined
          return { name: current.name.slice(8), sessionID: current.sessionID }
        },
      },
      slot: (claim) => {
        if (claim.append !== "session.panel") return () => {}
        return props.context.ui.slot({
          append: "session.panel",
          render: (panel) => claim.render(mergeProps(panel, {
            get name() { return panel.name.startsWith("fixture.") ? panel.name.slice(8) : "" },
          })),
        })
      },
    },
  }
  const team = createActiveTeam(context)
  const monitor = createMonitor(context, { team: team.activeTeam })
  onCleanup(() => { team.dispose(); monitor.dispose() })
  createEffect(() => panels.setWidth(dimensions().width))
  // A panel belongs to one chat: another chat closes it, as the host does.
  createEffect(() => {
    const current = panels.current()
    if (current !== undefined && current.sessionID !== chat()) panels.close()
  })
  monitor.open()
  const fullscreen = () => panels.presentation() === "fullscreen"
  const width = () => fullscreen() ? dimensions().width : Math.floor(dimensions().width / 2)
  context.keymap.layer(() => ({
    priority: 10,
    commands: [
      { bind: "f1", title: "Open Monitor fixture", run: () => monitor.open() },
      {
        bind: "f2",
        title: "Toggle the active team",
        run: () => setGroup((value) => (value === undefined ? "team:project:fixture" : undefined)),
      },
      { bind: "f3", title: "Toggle panel focus", run: () => setFocused((value) => !value) },
    ],
  }))
  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="column">
      <box flexGrow={1} minHeight={0} flexDirection="row">
        <box visible={!panels.current() || !fullscreen()} flexGrow={1} minWidth={0}>
          <text fg={context.theme.text.muted}>
            Session fixture {chat()} · {focused() ? "panel focused" : "session focused"}
          </text>
        </box>
        <Show when={panels.current()} keyed>
          {(target) => (
            <box width={width()} minHeight={0}>
              <PanelHost panel={target} width={width()} focused={focused()} onFocus={() => setFocused(true)} onTarget={() => {}} />
            </box>
          )}
        </Show>
      </box>
      <StoryFooter context={context} title="Plus panels" message={message()} controls={[
        { shortcut: "F1", label: "Monitor" },
        { shortcut: "F2", label: group() === undefined ? "team off" : "team on" },
        { shortcut: "F3", label: "focus" },
        { shortcut: "F4", label: "reset" },
        { shortcut: "5", label: "Team tab" },
        { shortcut: "↑↓", label: "select/scroll" },
        { shortcut: "M", label: "fullscreen" },
      ]} />
    </box>
  )
}

export const plusPanelsStory: Story = {
  id: "plus-panels",
  title: "Plus Monitor panel and its Team tab",
  render: (context) => {
    const [generation, setGeneration] = createSignal(1)
    context.keymap.layer(() => ({ commands: [
      { bind: "f4", title: "Reset panels fixture", run: () => { setGeneration((value) => value + 1) } },
    ] }))
    return <Show keyed when={generation()}>{(_generation) => <PanelProvider><Panels context={context} /></PanelProvider>}</Show>
  },
}
