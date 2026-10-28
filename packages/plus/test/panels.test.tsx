import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput, SlotClaim } from "@opencode/plugin/tui/context"
import { createComponent, createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { createPanelState } from "../../tui/src/context/panel"
import { createActiveTeam } from "../src/tui/active-team"
import { createMonitor } from "../src/tui/monitor"
import { contractFixtureReport } from "./monitor-fixture"
import { dispatch } from "./instructions-nav"
import { renderPlusFixture } from "./tui"

async function fixture() {
  const panels = createPanelState()
  panels.setWidth(160)
  const [focused, setFocused] = createSignal(true)
  const [route, setRoute] = createSignal<ReturnType<Plugin.Context["ui"]["router"]["current"]>>({ type: "session", sessionID: "ses_chat" })
  // The agent picker's active group: a team id makes that team active.
  const [group, setGroup] = createSignal<string | undefined>()
  const navigations: Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0][] = []
  const claims: SlotClaim<"session.panel">["render"][] = []
  const layers: Parameters<Plugin.Context["keymap"]["layer"]>[0][] = []
  let monitor!: ReturnType<typeof createMonitor>
  let mounts = 0
  let unmounts = 0
  const report = contractFixtureReport()
  const output = await renderPlusFixture({
    snapshots: [], width: 160, height: 24,
    rpc: {
      "team.list": async () => ({ teams: [{ level: "project", team: "alpha", enabled: true, members: [{ id: "lead" }] }] }),
      "checks.suggest": async () => ({
        root: "/repo",
        current: [{ id: "check", argv: ["bun", "run", "check"] }],
        setup: { id: "setup", argv: ["bun", "install"] },
        suggested: [],
      }),
      "team.runs.list": async () => ({ runs: Array.from({ length: 40 }, (_, index) => ({
        id: `run-${String(index + 1).padStart(2, "0")}`, role: "worker", state: "idle",
        sessionID: `ses_${index}`, task: null, head: "fixture", worktree: "present", lastUsed: "", parent: null,
      })) }),
      "monitor.query": async () => ({
        ...report,
        requests: Array.from({ length: 40 }, (_, index) => ({
          ...report.requests![0],
          id: `req_${index}`,
          model: `model-${String(index + 1).padStart(2, "0")}`,
          causeText: `cause-${String(index + 1).padStart(2, "0")}`,
        })),
      }),
      "monitor.cache": async () => report,
      // Forty trees of one session each; the chat's tree heads the list.
      "monitor.sessions": async (input: { first?: string }) => {
        const ids = Array.from({ length: 40 }, (_, index) => `ses_${index}`)
        const ordered = input.first === undefined ? ids : [input.first, ...ids.filter((id) => id !== input.first)]
        return {
          sessions: ordered.map((id) => ({
            sessionID: id, rootID: id, depth: 0, title: `title-${id}`, lastActive: 0, requests: 0, steps: 0,
            input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, misses: 0, active: true, descendants: 0,
          })),
          roots: ordered.length, offset: 0, limit: 100, inactive: 0,
        }
      },
    },
    render: (base) => {
      const context: Plugin.Context = {
        ...base,
        data: { ...base.data, listen: () => () => {} },
        keymap: {
          ...base.keymap,
          layer: (factory) => {
            let mounted = true
            onCleanup(() => { mounted = false })
            layers.push(factory)
            base.keymap.layer(() => {
              const layer = factory()
              const enabled = mounted && (typeof layer.enabled === "function" ? layer.enabled() : layer.enabled ?? true)
              return { ...layer, commands: enabled ? layer.commands : [] }
            })
          },
        },
        ui: {
          ...base.ui,
          router: {
            ...base.ui.router,
            current: route,
            navigate: (destination) => {
              navigations.push(destination)
              setRoute(destination.type === "plugin" ? { ...destination, id: "opencode.plus" } : destination)
            },
          },
          agents: { ...base.ui.agents, groups: () => () => {}, activeGroup: { current: group, set: setGroup } },
          panel: {
            open: (name, options) => {
              const current = route()
              if (current.type !== "session") return false
              panels.open({ name, plugin: "plus", sessionID: current.sessionID }, options?.presentation)
              return true
            },
            current: panels.current,
            close: panels.close,
          },
          slot: (claim) => {
            if (claim.append === "session.panel") claims.push(claim.render)
            return () => {}
          },
        },
      }
      const team = createActiveTeam(context)
      monitor = createMonitor(context, { team: team.activeTeam })
      onCleanup(() => { team.dispose(); monitor.dispose() })
      // The host's panel belongs to one chat: another chat's route closes it.
      createEffect(() => {
        const current = panels.current()
        const at = route()
        if (current !== undefined && (at.type !== "session" || at.sessionID !== current.sessionID)) panels.close()
      })
      const input: PanelInput = {
        get name() { return panels.current()?.name ?? "" },
        get sessionID() { return panels.current()?.sessionID ?? "" },
        get width() { return panels.presentation() === "fullscreen" ? 160 : 80 },
        get presentation() { return panels.presentation() },
        get focused() { return focused() },
        focus: () => { setFocused(true) },
        close: panels.close,
        toggleFullscreen: panels.toggleFullscreen,
      }
      return <Show when={panels.current()} keyed>{(_target) => {
        mounts++
        onCleanup(() => { unmounts++ })
        return <box width={input.width} height={20} flexDirection="column">
          <For each={claims}>{(render) => createComponent(render, input)}</For>
        </box>
      }}</Show>
    },
  })
  return { output, panels, monitor: () => monitor, setFocused, setRoute, setGroup, navigations, layers, mounts: () => mounts, unmounts: () => unmounts }
}

test("the Monitor's Team tab shows only with an active team: runs reveal off-screen rows, wrap and open, project checks list", async () => {
  const test = await fixture()
  try {
    test.monitor().open()
    await test.output.waitForFrame((frame) => frame.includes("[4 Sessions]"))
    // No active team: no Team tab, and 5 does nothing.
    expect(test.output.captureCharFrame()).not.toContain("Team]")
    dispatch(test.output, "5")
    await test.output.flush()
    expect(test.output.captureCharFrame()).not.toContain("Project checks")
    test.setGroup("team:project:alpha")
    await test.output.waitForFrame((frame) => frame.includes("[5 Team]"))
    dispatch(test.output, "5")
    await test.output.waitForFrame((frame) => frame.includes("run-01") && frame.includes("Project checks"))
    const opened = test.output.captureCharFrame()
    expect(opened).toContain("bun run check")
    expect(opened).toContain("bun install · fresh worktrees")
    // The 80-column panel gets the short hint line, whole.
    expect(opened.split("\n").find((line) => line.includes("[↑↓]"))?.trim()).toBe("[↑↓] · [⏎] open · [ctrl+a/t] inactive/tree · [ctrl+d] stop · [e] checks")
    expect(opened).not.toContain("run-26")
    // e opens the Project checks editor (the dialog the old /checks opened).
    dispatch(test.output, "e")
    await test.output.waitForFrame(() => test.output.fake.selectInputs.some((input) => input.title === "Project checks"))
    Array.from({ length: 25 }).forEach(() => dispatch(test.output, "down"))
    await test.output.waitForFrame((frame) => frame.includes("run-26"))
    expect(test.output.captureCharFrame()).not.toContain("run-01")
    Array.from({ length: 14 }).forEach(() => dispatch(test.output, "down"))
    await test.output.waitForFrame((frame) => frame.includes("run-40"))
    dispatch(test.output, "down")
    await test.output.waitForFrame((frame) => frame.includes("run-01"))
    // Enter opens the run's chat, and the Monitor opens again in it.
    dispatch(test.output, "return")
    expect(test.navigations.at(-1)).toEqual({ type: "session", sessionID: "ses_0" })
    expect(test.panels.current()).toEqual({ name: "plus.monitor", plugin: "plus", sessionID: "ses_0" })
    await test.output.waitForFrame((frame) => frame.includes("run-01") && frame.includes("Project checks"))
    // The team stops being active: the stored Team tab opens on Cache.
    test.setGroup(undefined)
    test.monitor().open()
    await test.output.waitForFrame((frame) => frame.includes("[4 Sessions]") && !frame.includes("Team]"))
    expect(test.output.captureCharFrame()).not.toContain("Project checks")
  } finally { test.output.destroy() }
})

test("Monitor uses a session panel, keeps filters and selection across fullscreen, and uses the route from Home", async () => {
  const test = await fixture()
  try {
    test.monitor().open()
    await test.output.waitForFrame((frame) => frame.includes("Monitor") && frame.includes("Scope:"))
    expect(test.panels.current()?.name).toBe("plus.monitor")
    expect(test.navigations).toEqual([])
    dispatch(test.output, "3")
    dispatch(test.output, "g")
    dispatch(test.output, "1")
    await test.output.waitForFrame((frame) => frame.includes("row 1 of"))
    Array.from({ length: 25 }).forEach(() => dispatch(test.output, "down"))
    await test.output.waitForFrame((frame) => frame.includes("cause-15"))
    await test.output.flush()
    const settings = structuredClone(test.output.storeValue("monitor"))
    const mounts = test.mounts()
    dispatch(test.output, "shift+m")
    expect(test.panels.presentation()).toBe("fullscreen")
    await test.output.flush()
    expect(test.mounts()).toBe(mounts)
    expect(test.unmounts()).toBe(0)
    expect(test.output.storeValue("monitor")).toEqual(settings)
    expect(test.output.captureCharFrame()).toContain("row 26 of")
    expect(test.output.captureCharFrame()).toContain("cause-15")
    dispatch(test.output, "shift+m")
    expect(test.panels.presentation()).toBe("panel")
    await test.output.flush()
    expect(test.unmounts()).toBe(0)
    expect(test.output.captureCharFrame()).toContain("row 26 of")
    expect(test.output.captureCharFrame()).toContain("cause-15")
    dispatch(test.output, "escape")
    await test.output.flush()
    expect(test.panels.current()).toBeUndefined()
    expect(test.unmounts()).toBe(1)
    test.setRoute({ type: "home" })
    test.monitor().open()
    expect(test.panels.current()).toBeUndefined()
    expect(test.navigations.at(-1)).toEqual({ type: "plugin", name: "monitor" })
  } finally { test.output.destroy() }
})

const runLines = (frame: string) => frame.split("\n").filter((line) => /run-\d\d/.test(line)).map((line) => line.trim())

test("a run's chat opened from the Team tab keeps the Monitor open there, on the same scope, row and scroll", async () => {
  const test = await fixture()
  try {
    test.setGroup("team:project:alpha")
    test.monitor().open()
    await test.output.waitForFrame((frame) => frame.includes("[5 Team]"))
    dispatch(test.output, "5")
    await test.output.waitForFrame((frame) => frame.includes("run-01"))
    Array.from({ length: 25 }).forEach(() => dispatch(test.output, "down"))
    await test.output.waitForFrame((frame) => frame.includes("run-26") && !frame.includes("run-01"))
    const before = runLines(test.output.captureCharFrame())
    expect(before.at(-1)).toStartWith("run-26")
    const mounts = test.mounts()

    dispatch(test.output, "return")
    expect(test.navigations.at(-1)).toEqual({ type: "session", sessionID: "ses_25" })
    expect(test.panels.current()).toEqual({ name: "plus.monitor", plugin: "plus", sessionID: "ses_25" })
    expect(test.mounts()).toBe(mounts + 1)
    // The new chat's Monitor shows the same runs at the same scroll offset,
    // still scoped to the chat it was opened from.
    const after = await test.output.waitForFrame((frame) => runLines(frame).join("\n") === before.join("\n"))
    expect(after).toContain("[5 Team]")
    // ses_chat's title; the new chat (ses_25) would show its id.
    expect(after.split("\n").find((line) => line.includes("Scope:"))).toContain("This session: Test Chat")
    // The selection is still run-26: the next row down opens run-27's chat.
    dispatch(test.output, "down")
    dispatch(test.output, "return")
    expect(test.navigations.at(-1)).toEqual({ type: "session", sessionID: "ses_26" })

    // The chat already open stays put with the Monitor as it is.
    const navigations = test.navigations.length
    const at = test.mounts()
    dispatch(test.output, "return")
    await test.output.flush()
    expect(test.navigations.length).toBe(navigations)
    expect(test.mounts()).toBe(at)

    // Opened again by hand, the Monitor starts fresh: this chat's scope, the first run.
    dispatch(test.output, "escape")
    expect(test.panels.current()).toBeUndefined()
    test.monitor().open()
    await test.output.waitForFrame((frame) => frame.includes("This session: ses_26"))
    dispatch(test.output, "5")
    await test.output.waitForFrame((frame) => frame.includes("run-01"))
  } finally { test.output.destroy() }
})

test("Esc closes the Monitor panel while the chat beside it has the focus, before the chat's interrupt", async () => {
  const test = await fixture()
  try {
    test.monitor().open()
    await test.output.waitForFrame((frame) => frame.includes("Monitor") && frame.includes("Scope:"))
    const escape = () => test.layers
      .map((factory) => factory())
      .find((layer) => layer.commands?.some((command) => command.bind === "escape" && command.title === "Close monitor") && layer.mode === undefined && layer.priority === 1)
    // Above the prompt's interrupt (priority 0), so a running reply's first Esc
    // closes the Monitor and never arms the interrupt. In the base mode only:
    // dialogs, autocomplete, the composer and forms push their own mode and
    // keep Esc (packages/tui/test/escape-fallthrough.test.tsx).
    expect(escape()).toBeDefined()
    // While the panel has the focus its view's Esc runs, not this one.
    expect((escape()?.enabled as () => boolean)()).toBe(false)
    test.setFocused(false)
    await test.output.flush()
    expect((escape()?.enabled as () => boolean)()).toBe(true)
    // The panel's own keys are off: no Monitor key but its Esc is reachable.
    expect(dispatch(test.output, "t")).toBe(false)
    expect(dispatch(test.output, "escape")).toBe(true)
    expect(test.panels.current()).toBeUndefined()
    // With no Monitor open the layer is off and Esc is left alone.
    expect(dispatch(test.output, "escape")).toBe(false)
  } finally { test.output.destroy() }
})

const sessionLines = (frame: string) => frame.split("\n").filter((line) => /title-ses_\d+/.test(line)).map((line) => line.trim())

test("Enter on a Sessions row opens its chat and keeps the Monitor open there, on the same row", async () => {
  const test = await fixture()
  try {
    test.monitor().open()
    await test.output.waitForFrame((frame) => frame.includes("[4 Sessions]"))
    dispatch(test.output, "4")
    await test.output.waitForFrame((frame) => frame.includes("title-ses_0"))
    expect(test.output.captureCharFrame()).toContain("[⏎] open")
    // ses_chat heads the list; the fourth row down is ses_3.
    Array.from({ length: 4 }).forEach(() => dispatch(test.output, "down"))
    await test.output.waitForFrame((frame) => frame.includes("row 5 of"))
    const mounts = test.mounts()

    dispatch(test.output, "return")
    expect(test.navigations.at(-1)).toEqual({ type: "session", sessionID: "ses_3" })
    expect(test.panels.current()).toEqual({ name: "plus.monitor", plugin: "plus", sessionID: "ses_3" })
    expect(test.mounts()).toBe(mounts + 1)
    // The new chat's Monitor is on Sessions, with ses_3 (now the head of the list) selected.
    await test.output.waitForFrame((frame) => frame.includes("row 1 of") && sessionLines(frame)[0]?.includes("title-ses_3") === true)
    dispatch(test.output, "down")
    dispatch(test.output, "return")
    expect(test.navigations.at(-1)).toEqual({ type: "session", sessionID: "ses_0" })

    // The chat already open stays put with the Monitor as it is.
    await test.output.waitForFrame((frame) => frame.includes("[4 Sessions]") && sessionLines(frame)[0]?.includes("title-ses_0") === true)
    const navigations = test.navigations.length
    dispatch(test.output, "return")
    await test.output.flush()
    expect(test.navigations.length).toBe(navigations)
  } finally { test.output.destroy() }
})
