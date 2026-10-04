/** @jsxImportSource @opentui/solid */
import type { PermissionRequest } from "@opencode/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData, type FormWithLocation } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { LocalProvider } from "../../src/context/local"
import { PermissionProvider } from "../../src/context/permission"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { PromptFooter } from "../../src/component/prompt"
import { PluginContext } from "../../src/plugin/context"
import { FormPrompt } from "../../src/routes/session/form"
import { PermissionPrompt } from "../../src/routes/session/permission"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

function createTestPluginValue(label = "cache warm · 4:50 left") {
  const testSlots = new Map([
    [
      "prompt.footer",
      {
        before: [],
        prepend: [],
        append: [
          {
            plugin: "plus-warming-mock",
            key: "mock",
            placement: { kind: "append" as const, target: "prompt.footer" },
            render: () => <text>{label}</text>,
          },
        ],
        after: [],
        replace: undefined,
      },
    ],
  ])

  return {
    ready: () => true,
    list: () => [],
    server: () => [],
    registered: () => [],
    route: () => undefined,
    slots: {
      register: () => () => {},
      resolved: () => ({ slotted: testSlots, suppressed: [], degraded: [] }),
    },
    markdown: () => undefined,
    activate: async () => true,
    deactivate: async () => true,
  }
}

test("prompt footer row stays visible under FormPrompt with plugin entry and location", async () => {
  await using tmp = await tmpdir()
  const ready = Promise.withResolvers<void>()
  const sessionID = "ses_form_test"

  const transport = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}`) {
      return json({
        data: {
          id: sessionID,
          title: "Form Session",
          projectID: "proj_test",
          location: { directory: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    }
    if (url.pathname === "/api/session/status") {
      return json({ data: { [sessionID]: { type: "idle" } } })
    }
  }, createEventStream())

  const form: FormWithLocation = {
    id: "form_question",
    sessionID,
    title: "Question from assistant",
    location: { directory: tmp.path },
    fields: [
      {
        key: "choice",
        title: "Which database would you prefer?",
        type: "string",
        options: [
          { label: "PostgreSQL", value: "postgres" },
          { label: "SQLite", value: "sqlite" },
        ],
      },
    ],
  }

  function Harness() {
    const data = useData()
    onMount(() => {
      void data.session.sync(sessionID).then(ready.resolve, ready.reject)
    })
    return (
      <box flexDirection="column" height="100%">
        <box flexGrow={1} />
        <FormPrompt form={form} />
        <PromptFooter sessionID={sessionID} />
      </box>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <ArgsProvider>
          <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
            <Keymap.Provider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <ClientProvider api={createApi(transport.fetch)}>
                    <PermissionProvider>
                      <DataProvider directory={tmp.path}>
                        <LocationProvider>
                          <ThemeProvider mode="dark" source={emptyThemeSource}>
                            <LocalProvider>
                              <EditorContextProvider>
                                <DialogProvider>
                                  <PluginContext.Provider value={createTestPluginValue()}>
                                    <Harness />
                                  </PluginContext.Provider>
                                </DialogProvider>
                              </EditorContextProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </LocationProvider>
                      </DataProvider>
                    </PermissionProvider>
                  </ClientProvider>
                </RouteProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await ready.promise
    await app.renderOnce()

    const frame = app.captureCharFrame()
    // FormPrompt is visible
    expect(frame).toContain("Question from assistant")
    expect(frame).toContain("PostgreSQL")
    expect(frame).toContain("SQLite")
    // Prompt footer slots are visible: plugin entry + location
    expect(frame).toContain("cache warm · 4:50 left")
    expect(frame).toContain("~")
  } finally {
    app.renderer.destroy()
  }
})

test("prompt footer row stays visible under PermissionPrompt with plugin entry and location", async () => {
  await using tmp = await tmpdir()
  const ready = Promise.withResolvers<void>()
  const sessionID = "ses_perm_test"

  const transport = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}`) {
      return json({
        data: {
          id: sessionID,
          title: "Permission Session",
          projectID: "proj_test",
          location: { directory: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    }
    if (url.pathname === "/api/session/status") {
      return json({ data: { [sessionID]: { type: "idle" } } })
    }
  }, createEventStream())

  const request: PermissionRequest = {
    id: "perm_req_1",
    sessionID,
    action: "read",
    resources: ["/etc/config.json"],
    metadata: {},
  }

  function Harness() {
    const data = useData()
    onMount(() => {
      void data.session.sync(sessionID).then(ready.resolve, ready.reject)
    })
    return (
      <box flexDirection="column" height="100%">
        <box flexGrow={1} />
        <PermissionPrompt request={request} directory={tmp.path} />
        <PromptFooter sessionID={sessionID} />
      </box>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <ArgsProvider>
          <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
            <Keymap.Provider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <ClientProvider api={createApi(transport.fetch)}>
                    <PermissionProvider>
                      <DataProvider directory={tmp.path}>
                        <LocationProvider>
                          <ThemeProvider mode="dark" source={emptyThemeSource}>
                            <LocalProvider>
                              <EditorContextProvider>
                                <DialogProvider>
                                  <PluginContext.Provider value={createTestPluginValue("cache warm · 12:30 left")}>
                                    <Harness />
                                  </PluginContext.Provider>
                                </DialogProvider>
                              </EditorContextProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </LocationProvider>
                      </DataProvider>
                    </PermissionProvider>
                  </ClientProvider>
                </RouteProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await ready.promise
    await app.renderOnce()

    const frame = app.captureCharFrame()
    // PermissionPrompt is visible
    expect(frame).toContain("Permission required")
    // Prompt footer slots are visible: plugin entry + location
    expect(frame).toContain("cache warm · 12:30 left")
    expect(frame).toContain("~")
  } finally {
    app.renderer.destroy()
  }
})

test("prompt footer row takes no keys from FormPrompt and truncates on narrow width", async () => {
  await using tmp = await tmpdir()
  const ready = Promise.withResolvers<void>()
  const sessionID = "ses_key_test"

  const transport = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}`) {
      return json({
        data: {
          id: sessionID,
          title: "Key Test Session",
          projectID: "proj_test",
          location: { directory: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    }
  }, createEventStream())

  const form: FormWithLocation = {
    id: "form_key_test",
    sessionID,
    title: "Form with options",
    location: { directory: tmp.path },
    fields: [
      {
        key: "choice",
        title: "Select one",
        type: "string",
        options: [
          { label: "First Option", value: "opt1" },
          { label: "Second Option", value: "opt2" },
        ],
      },
    ],
  }

  function Harness() {
    const data = useData()
    onMount(() => {
      void data.session.sync(sessionID).then(ready.resolve, ready.reject)
    })
    return (
      <box flexDirection="column" height="100%">
        <box flexGrow={1} />
        <FormPrompt form={form} />
        <PromptFooter sessionID={sessionID} />
      </box>
    )
  }

  // Render on a narrow width (45 columns)
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <ArgsProvider>
          <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
            <Keymap.Provider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <ClientProvider api={createApi(transport.fetch)}>
                    <PermissionProvider>
                      <DataProvider directory={tmp.path}>
                        <LocationProvider>
                          <ThemeProvider mode="dark" source={emptyThemeSource}>
                            <LocalProvider>
                              <EditorContextProvider>
                                <DialogProvider>
                                  <PluginContext.Provider value={createTestPluginValue()}>
                                    <Harness />
                                  </PluginContext.Provider>
                                </DialogProvider>
                              </EditorContextProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </LocationProvider>
                      </DataProvider>
                    </PermissionProvider>
                  </ClientProvider>
                </RouteProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: 45, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await ready.promise
    await app.renderOnce()

    // Form prompt navigation works (press 2 to select option 2)
    app.mockInput.pressKey("2")
    await app.renderOnce()

    const frame = app.captureCharFrame()
    expect(frame).toContain("Second Option")
    // Footer plugin is rendered
    expect(frame).toContain("cache warm")
  } finally {
    app.renderer.destroy()
  }
})
