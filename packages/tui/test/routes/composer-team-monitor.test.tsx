/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"
import { createSignal, onCleanup, onMount } from "solid-js"
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
      <Composer
        sessionID="parent"
        open={input.open ?? true}
        onClose={input.onClose}
      />
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
              session: { terminal: true },
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
      const active = input.active()
      activeState = active
      onCleanup(() => {
        activeState = false
      })
      return (
        <box>
          <text>Custom Tab Content: active={String(active)}</text>
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
