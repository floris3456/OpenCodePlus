/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { RouteProvider } from "../../src/context/route"
import { StorageProvider } from "../../src/context/storage"
import { SessionTerminalsProvider } from "../../src/context/session-terminals"
import { ThemeProvider } from "../../src/context/theme"
import { Composer, composerPluginTabs } from "../../src/routes/session/composer"
import { COMPOSER_TAB_BODY_HEIGHT } from "../../src/routes/session/composer/context"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { createApi, createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TuiAppProvider } from "../../src/context/runtime"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  composerPluginTabs.reset()
})

const testSession = {
  id: "parent",
  title: "Parent Session",
  projectID: "proj_test",
  created: Date.now(),
  updated: Date.now(),
}

async function createTestComposer(input: {
  onClose?: () => void
  open?: boolean
}) {
  const temp = await tmpdir()
  const events = createEventStream()
  const ready = Promise.withResolvers<void>()
  const calls = createFetch((url, request) => {
    if (url.pathname === "/api/session/active") {
      return json({ data: {} })
    }
    if (url.pathname === "/api/session/parent") {
      return json({ data: testSession })
    }
    if (url.pathname === "/api/shell" && request.method === "GET") {
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [],
      })
    }
    if (url.pathname.includes("/pty")) {
      return json({ data: [] })
    }
  }, events)

  function Content() {
    const data = useData()
    onMount(() => {
      void Promise.all([data.session.sync("parent"), data.shell.sync()])
        .then(() => ready.resolve(), ready.reject)
    })
    return (
      // The composer is anchored at the bottom of the chat, as in the session
      // route: its height changes move the header row it is measured by.
      <box flexDirection="column" height="100%">
        <box flexGrow={1} />
        <Composer
          sessionID="parent"
          open={input.open ?? true}
          onClose={input.onClose}
        />
      </box>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory} paths={{ state: temp.path, home: temp.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <ConfigProvider
            config={createTuiResolvedConfig({
              keybinds: {
                "composer.subagent.up": "up",
                "composer.subagent.down": "down",
                "composer.shell.up": "up",
                "composer.shell.down": "down",
                "composer.terminal.up": "up",
                "composer.terminal.down": "down",
              },
            })}
          >
            <StorageProvider>
              <Keymap.Provider>
                <ClientProvider api={createApi(calls.fetch)}>
                  <DataProvider directory={process.cwd()}>
                    <LocationProvider>
                      <RouteProvider initialRoute={{ type: "session", sessionID: "parent" }}>
                        <SessionTerminalsProvider>
                          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                            <ToastProvider>
                              <DialogProvider>
                                <Content />
                              </DialogProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </SessionTerminalsProvider>
                      </RouteProvider>
                    </LocationProvider>
                  </DataProvider>
                </ClientProvider>
              </Keymap.Provider>
            </StorageProvider>
          </ConfigProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 20, kittyKeyboard: true },
  )

  await ready.promise
  await app.renderOnce()
  return {
    app,
    cleanup: async () => {
      await temp[Symbol.asyncDispose]()
    },
  }
}

/** The composer's tab header row: the only line that names every tab. */
function headerRow(frame: string): number {
  return frame
    .split("\n")
    .findIndex((line) => line.includes("Subagents") && line.includes("Terminals"))
}

/** The composer's footer row with the tab hint. */
function footerRow(frame: string): number {
  return frame.split("\n").findIndex((line) => line.includes("tabs") && line.includes("←/→"))
}

/**
 * A plugin body that starts as a one-line placeholder and grows to more rows
 * than the composer body holds, the way a real tab fetches over RPC. The gate
 * lets the test capture the intermediate frame deterministically.
 */
function GrowTab(props: { gate: Promise<void> }) {
  const [rows, setRows] = createSignal(1)
  void props.gate.then(() => setRows(10))
  return (
    <box flexDirection="column">
      <Show when={rows() > 1} fallback={<text>grow loading</text>}>
        <For each={Array.from({ length: 10 }, (_, index) => index)}>
          {(index) => <text>{`grow row ${index}`}</text>}
        </For>
      </Show>
    </box>
  )
}

/** A plugin body whose state only survives if the component is never remounted. */
function StatefulTab(props: { mount: () => number; onCleanup: () => void }) {
  const [label] = createSignal(`state ${props.mount()}`)
  onCleanup(props.onCleanup)
  return <text>{label()}</text>
}

test("plugin tab appears fourth after Subagents, Shell, and Terminals, and activates with right", async () => {
  let activeState = false
  let receivedSessionID = ""
  let closeCalled = false

  const unregister = composerPluginTabs.register({
    id: "test-tab",
    label: "CustomTab",
    hints: () => [{ label: "custom_hint", shortcut: "ctrl+k" }],
    render(input) {
      receivedSessionID = input.sessionID
      createEffect(() => {
        activeState = input.active()
      })
      onCleanup(() => {
        activeState = false
      })
      return (
        <box>
          <text>Custom Tab Content: active={String(input.active())}</text>
        </box>
      )
    },
  })

  let closedCount = 0
  const { app, cleanup } = await createTestComposer({
    onClose: () => {
      closedCount++
    },
  })

  try {
    const frame1 = app.captureCharFrame()
    // Verify all four tabs appear in correct order
    expect(frame1).toContain("Subagents")
    expect(frame1).toContain("Shell")
    expect(frame1).toContain("Terminals")
    expect(frame1).toContain("CustomTab")

    // The fourth tab appears after the three built-ins in the frame
    const subagentsIdx = frame1.indexOf("Subagents")
    const shellIdx = frame1.indexOf("Shell")
    const terminalsIdx = frame1.indexOf("Terminals")
    const customIdx = frame1.indexOf("CustomTab")
    expect(subagentsIdx).toBeLessThan(shellIdx)
    expect(shellIdx).toBeLessThan(terminalsIdx)
    expect(terminalsIdx).toBeLessThan(customIdx)

    // Initially active tab is Subagents (first tab)
    expect(activeState).toBe(false)
    expect(frame1).not.toContain("Custom Tab Content")

    // Press right -> moves to Shell (second tab)
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(activeState).toBe(false)

    // Press right -> moves to Terminals (third tab)
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(activeState).toBe(false)

    // Press right -> moves to CustomTab (fourth tab)
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(activeState).toBe(true)
    expect(receivedSessionID).toBe("parent")
    const frame4 = app.captureCharFrame()
    expect(frame4).toContain("Custom Tab Content: active=true")
    expect(frame4).toContain("custom_hint")
    expect(frame4).toContain("ctrl+k")

    // Press left -> moves back to Terminals (third tab)
    app.mockInput.pressArrow("left")
    await app.renderOnce()
    expect(activeState).toBe(false)
    expect(app.captureCharFrame()).not.toContain("Custom Tab Content")

    // Press right -> moves back to CustomTab
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(activeState).toBe(true)

    // Press right on fourth tab -> wraps around to Subagents (first tab)
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(activeState).toBe(false)
    expect(app.captureCharFrame()).not.toContain("Custom Tab Content")

    // Press left on first tab -> wraps around to CustomTab (fourth tab)
    app.mockInput.pressArrow("left")
    await app.renderOnce()
    expect(activeState).toBe(true)
    expect(app.captureCharFrame()).toContain("Custom Tab Content: active=true")

    // Press escape -> closes composer
    app.mockInput.pressEscape()
    await app.renderOnce()
    expect(closedCount).toBe(1)
  } finally {
    unregister()
    app.renderer.destroy()
    await cleanup()
  }
})

test("unregistering a plugin tab removes it cleanly", async () => {
  const unregister = composerPluginTabs.register({
    id: "removable-tab",
    label: "Removable",
    render: () => <text>Removable</text>,
  })

  const { app, cleanup } = await createTestComposer({})
  try {
    expect(app.captureCharFrame()).toContain("Removable")
    unregister()
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Removable")
    expect(app.captureCharFrame()).toContain("Subagents")
    expect(app.captureCharFrame()).toContain("Shell")
    expect(app.captureCharFrame()).toContain("Terminals")
  } finally {
    app.renderer.destroy()
    await cleanup()
  }
})

test("the composer header row never moves while walking plugin tabs at the native height", async () => {
  const gate = Promise.withResolvers<void>()
  const unregisterGrow = composerPluginTabs.register({
    id: "grow-tab",
    label: "Grow",
    render: () => <GrowTab gate={gate.promise} />,
  })
  const unregisterEmpty = composerPluginTabs.register({
    id: "empty-tab",
    label: "Empty",
    render: () => <></>,
  })

  const { app, cleanup } = await createTestComposer({})
  try {
    const baselineFrame = app.captureCharFrame()
    const baseline = headerRow(baselineFrame)
    expect(baseline).toBeGreaterThan(-1)
    // The number is not assumed: the native body is measured here (header,
    // gap, body, gap, footer) and must be the height the plugin container
    // derives from it.
    expect(footerRow(baselineFrame) - baseline - 3).toBe(COMPOSER_TAB_BODY_HEIGHT)

    const captures: { step: string; frame: string }[] = []
    for (const lap of [1, 2]) {
      for (let press = 1; press <= 5; press++) {
        app.mockInput.pressArrow("right")
        await app.renderOnce()
        captures.push({ step: `lap ${lap} press ${press} pending`, frame: app.captureCharFrame() })
        // Grow is the fourth tab: the placeholder frame is captured above,
        // then its data arrives the way a real RPC would.
        if (lap === 1 && press === 3) gate.resolve()
        await app.renderOnce()
        captures.push({ step: `lap ${lap} press ${press} settled`, frame: app.captureCharFrame() })
      }
    }

    for (const capture of captures) expect(headerRow(capture.frame)).toBe(baseline)

    // Both the placeholder frame and the tall settled frame were captured:
    // the tall body is clipped and the placeholder shares the same height.
    expect(captures.some((capture) => capture.frame.includes("grow loading"))).toBe(true)
    expect(captures.some((capture) => capture.frame.includes("grow row 4"))).toBe(true)
    expect(captures.some((capture) => capture.frame.includes("grow row 5"))).toBe(false)
  } finally {
    unregisterGrow()
    unregisterEmpty()
    app.renderer.destroy()
    await cleanup()
  }
})

test("a plugin tab may ask for a taller body; natives and default-height tabs keep the native height", async () => {
  const unregisterTall = composerPluginTabs.register({
    id: "tall-tab",
    label: "Tall",
    height: 10,
    render: () => (
      <box flexDirection="column">
        <For each={Array.from({ length: 10 }, (_, index) => index)}>
          {(index) => <text>{`tall row ${index}`}</text>}
        </For>
      </box>
    ),
  })
  // Team and the natives ask for no height: the host's native five rows.
  const unregisterTeam = composerPluginTabs.register({
    id: "team-tab",
    label: "Team",
    render: () => <text>team body</text>,
  })

  const { app, cleanup } = await createTestComposer({})
  try {
    const baselineFrame = app.captureCharFrame()
    const baseline = headerRow(baselineFrame)
    expect(baseline).toBeGreaterThan(-1)
    expect(footerRow(baselineFrame) - baseline - 3).toBe(COMPOSER_TAB_BODY_HEIGHT)

    // Subagents -> Shell -> Terminals keep the native height.
    for (let press = 0; press < 2; press++) {
      app.mockInput.pressArrow("right")
      await app.renderOnce()
      expect(headerRow(app.captureCharFrame())).toBe(baseline)
    }

    // Next is Tall: the composer grows by exactly the extra rows in one step.
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    const tallFrame = app.captureCharFrame()
    expect(headerRow(tallFrame)).toBe(baseline - (10 - COMPOSER_TAB_BODY_HEIGHT))
    expect(footerRow(tallFrame) - headerRow(tallFrame) - 3).toBe(10)
    expect(tallFrame).toContain("tall row 9")

    // Back to a default-height tab: the hidden taller body must not reserve
    // space, so the header returns to the native row.
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    const teamFrame = app.captureCharFrame()
    expect(teamFrame).toContain("team body")
    expect(headerRow(teamFrame)).toBe(baseline)
    expect(footerRow(teamFrame) - baseline - 3).toBe(COMPOSER_TAB_BODY_HEIGHT)

    // And back to Tall: one clean step again.
    app.mockInput.pressArrow("left")
    await app.renderOnce()
    expect(headerRow(app.captureCharFrame())).toBe(baseline - (10 - COMPOSER_TAB_BODY_HEIGHT))
  } finally {
    unregisterTall()
    unregisterTeam()
    app.renderer.destroy()
    await cleanup()
  }
})

test("plugin tab components mount once and stay mounted until unregistered", async () => {
  let renders = 0
  let mounts = 0
  let cleanups = 0
  const unregister = composerPluginTabs.register({
    id: "stateful-tab",
    label: "Stateful",
    render: () => {
      renders++
      return <StatefulTab mount={() => ++mounts} onCleanup={() => cleanups++} />
    },
  })

  const { app, cleanup } = await createTestComposer({})
  try {
    for (let press = 0; press < 3; press++) {
      app.mockInput.pressArrow("right")
      await app.renderOnce()
    }
    expect(renders).toBe(1)
    expect(mounts).toBe(1)
    expect(app.captureCharFrame()).toContain("state 1")

    // Leaving the tab hides it but does not dispose it.
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("state 1")
    expect(renders).toBe(1)
    expect(cleanups).toBe(0)

    // Coming back shows the state the first visit kept.
    app.mockInput.pressArrow("left")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("state 1")
    expect(renders).toBe(1)
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)

    // Only unregistering the tab disposes the component.
    unregister()
    await app.renderOnce()
    expect(cleanups).toBe(1)
    expect(app.captureCharFrame()).not.toContain("state 1")
  } finally {
    unregister()
    app.renderer.destroy()
    await cleanup()
  }
})
