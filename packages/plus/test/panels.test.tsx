import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput, SlotClaim } from "@opencode/plugin/tui/context"
import { createComponent, createSignal, For, onCleanup, Show } from "solid-js"
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
  const navigations: Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0][] = []
  const claims: SlotClaim<"session.panel">["render"][] = []
  let monitor!: ReturnType<typeof createMonitor>
  let mounts = 0
  let unmounts = 0
  const report = contractFixtureReport()
  const output = await renderPlusFixture({
    snapshots: [], width: 160, height: 24,
    rpc: {
      "team.list": async () => ({ teams: [] }),
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
            base.keymap.layer(() => {
              const layer = factory()
              const enabled = mounted && (typeof layer.enabled === "function" ? layer.enabled() : layer.enabled ?? true)
              return { ...layer, commands: enabled ? layer.commands : [] }
            })
          },
        },
        ui: {
          ...base.ui,
          router: { ...base.ui.router, current: route, navigate: (destination) => { navigations.push(destination) } },
          panel: {
            open: (name, options) => {
              if (route().type !== "session") return false
              panels.open({ name, plugin: "plus", sessionID: "ses_chat" }, options?.presentation)
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
      monitor = createMonitor(context)
      const team = createActiveTeam(context, { openMonitor: monitor.open })
      onCleanup(() => { team.dispose(); monitor.dispose() })
      const input: PanelInput = {
        get name() { return panels.current()?.name ?? "" },
        sessionID: "ses_chat",
        get width() { return panels.presentation() === "fullscreen" ? 160 : 80 },
        get presentation() { return panels.presentation() },
        get focused() { return focused() },
        focus: () => { setFocused(true) },
        close: panels.close,
        toggleFullscreen: panels.toggleFullscreen,
      }
      return <Show when={panels.current()}>{(_target) => {
        mounts++
        onCleanup(() => { unmounts++ })
        return <box width={input.width} height={20} flexDirection="column">
          <For each={claims}>{(render) => createComponent(render, input)}</For>
        </box>
      }}</Show>
    },
  })
  return { output, panels, monitor: () => monitor, setFocused, setRoute, navigations, mounts: () => mounts, unmounts: () => unmounts }
}

test("Team arrows reveal off-screen rows in both directions, wrap, resize, and retain selection on reopen", async () => {
  const test = await fixture()
  try {
    test.panels.open({ name: "plus.team", plugin: "plus", sessionID: "ses_chat" })
    await test.output.waitForFrame((frame) => frame.includes("run-01"))
    expect(test.output.captureCharFrame()).not.toContain("run-26")
    Array.from({ length: 25 }).forEach(() => dispatch(test.output, "down"))
    await test.output.waitForFrame((frame) => frame.includes("run-26"))
    expect(test.output.captureCharFrame()).not.toContain("run-01")
    dispatch(test.output, "return")
    expect(test.navigations.at(-1)).toEqual({ type: "session", sessionID: "ses_25" })
    test.panels.open({ name: "plus.team", plugin: "plus", sessionID: "ses_chat" })
    await test.output.waitForFrame((frame) => frame.includes("run-26"))
    dispatch(test.output, "f")
    expect(test.panels.presentation()).toBe("fullscreen")
    await test.output.waitForFrame((frame) => frame.includes("run-26"))
    test.setFocused(false)
    expect(dispatch(test.output, "down")).toBe(false)
    test.setFocused(true)
    Array.from({ length: 25 }).forEach(() => dispatch(test.output, "up"))
    await test.output.waitForFrame((frame) => frame.includes("run-01"))
    Array.from({ length: 39 }).forEach(() => dispatch(test.output, "down"))
    await test.output.waitForFrame((frame) => frame.includes("run-40"))
    dispatch(test.output, "down")
    await test.output.waitForFrame((frame) => frame.includes("run-01"))
    expect(test.output.captureCharFrame()).not.toContain("run-40")
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
