/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { ConfigProvider } from "../src/config"
import { ArgsProvider } from "../src/context/args"
import { AttentionProvider } from "../src/context/attention"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { EditorContextProvider } from "../src/context/editor"
import { ExitProvider } from "../src/context/exit"
import { LocalProvider, useLocal } from "../src/context/local"
import { LocationProvider } from "../src/context/location"
import { PanelProvider } from "../src/context/panel"
import { PermissionProvider } from "../src/context/permission"
import { PromptRefProvider } from "../src/context/prompt"
import { RouteProvider, useRoute } from "../src/context/route"
import { TuiAppProvider, TuiLifecycleProvider } from "../src/context/runtime"
import { SessionTabsProvider } from "../src/context/session-tabs"
import { StorageProvider } from "../src/context/storage"
import { ThemeProvider } from "../src/context/theme"
import { ToastProvider } from "../src/ui/toast"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { PluginProvider } from "../src/plugin/context"
import { Prompt, type PromptRef } from "../src/component/prompt"
import { FrecencyProvider } from "../src/prompt/frecency"
import { PromptHistoryProvider } from "../src/prompt/history"
import { PromptStashProvider } from "../src/prompt/stash"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createApi, createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"

const SESSION_ID = "ses_test"

function model(id: string) {
  return {
    id,
    modelID: id,
    providerID: "provider",
    name: id,
    status: "active" as const,
    enabled: true,
    capabilities: { input: ["text"], output: ["text"], tools: true },
    cost: [],
    limit: { context: 10000, output: 1000 },
    time: { released: 0 },
    variants: [],
  }
}

function agent(id: string) {
  return {
    id,
    name: id,
    mode: "primary" as const,
    hidden: false,
    permissions: [],
    request: { settings: {}, headers: {}, body: {} },
  }
}

function Spy(input: { calls: string[]; label: string }) {
  Keymap.createLayer(() => ({
    priority: -1,
    commands: [
      {
        bind: "escape",
        title: input.label,
        group: "Test",
        run: () => {
          input.calls.push(input.label)
        },
      },
    ],
  }))
  return null
}

async function renderEscapeHarness(input: {
  status: "running" | "idle"
  spyLabel?: string
}) {
  const temporary = await tmpdir()
  await Bun.write(path.join(temporary.path, "model.json"), JSON.stringify({}))
  const events = createEventStream()
  const interruptCalls: string[] = []
  const spyCalls: string[] = []
  const calls = createFetch(async (url, request) => {
    const interrupt = url.pathname.match(/^\/api\/session\/([^/]+)\/interrupt$/)
    if (interrupt && request.method === "POST") {
      interruptCalls.push(interrupt[1]!)
      return json({ interrupted: true })
    }
    const location = { directory: url.searchParams.get("location[directory]") ?? directory }
    if (url.pathname === "/api/agent") return json({ location, data: [agent("build")] })
    if (url.pathname === "/api/model") return json({ location, data: [model("first")] })
  }, events)

  let data!: ReturnType<typeof useData>
  let local!: ReturnType<typeof useLocal>
  let route!: ReturnType<typeof useRoute>
  let dialog!: ReturnType<typeof useDialog>
  let promptRefValue: PromptRef | undefined

  function Probe() {
    data = useData()
    local = useLocal()
    route = useRoute()
    dialog = useDialog()
    return null
  }

  const spyLabel = input.spyLabel

  function Content() {
    return (
      <>
        <Prompt sessionID={SESSION_ID} visible={true} ref={(ref) => (promptRefValue = ref ?? undefined)} />
        {spyLabel ? <Spy calls={spyCalls} label={spyLabel} /> : null}
        <Probe />
      </>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <TuiLifecycleProvider value={{ add: () => () => {} }}>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig()}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider initialRoute={{ type: "home" }}>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider>
                          <DataProvider directory={directory}>
                            <LocationProvider>
                              <StorageProvider>
                                <SessionTabsProvider>
                                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                                    <LocalProvider>
                                      <PromptStashProvider>
                                        <DialogProvider>
                                          <FrecencyProvider>
                                            <PromptHistoryProvider>
                                              <PromptRefProvider>
                                                <EditorContextProvider>
                                                  <ExitProvider exit={() => {}}>
                                                    <AttentionProvider>
                                                      <PanelProvider>
                                                        <PluginProvider
                                                          packages={{ prepare: async () => ({ directory: "" }) }}
                                                          directories={[]}
                                                        >
                                                          <Content />
                                                        </PluginProvider>
                                                      </PanelProvider>
                                                    </AttentionProvider>
                                                  </ExitProvider>
                                                </EditorContextProvider>
                                              </PromptRefProvider>
                                            </PromptHistoryProvider>
                                          </FrecencyProvider>
                                        </DialogProvider>
                                      </PromptStashProvider>
                                    </LocalProvider>
                                  </ThemeProvider>
                                </SessionTabsProvider>
                              </StorageProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </TuiLifecycleProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  await app.waitFor(() => local !== undefined && local.model.ready)
  await data.location.sync()
  data.session.setStatus(SESSION_ID, input.status)
  await app.waitFor(() => promptRefValue?.focused === true)
  await app.renderOnce()
  return {
    app,
    data,
    local,
    route,
    dialog,
    interruptCalls,
    spyCalls,
    promptRef: () => promptRefValue,
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

test("esc esc interrupts a running session when the prompt is focused", async () => {
  await using harness = await renderEscapeHarness({ status: "running" })
  expect(harness.promptRef()?.focused).toBe(true)
  harness.app.mockInput.pressEscape()
  await harness.app.waitForFrame((frame) => frame.includes("again to interrupt"))
  expect(harness.interruptCalls).toEqual([])
  harness.app.mockInput.pressEscape()
  await harness.app.waitFor(() => harness.interruptCalls.length === 1)
  expect(harness.interruptCalls).toEqual([SESSION_ID])
})

test("escape falls through when the session is idle", async () => {
  await using harness = await renderEscapeHarness({ status: "idle", spyLabel: "lower" })
  harness.app.mockInput.pressEscape()
  await harness.app.waitFor(() => harness.spyCalls.length === 1)
  expect(harness.spyCalls).toEqual(["lower"])
  expect(harness.interruptCalls).toEqual([])
})

test("escape reaches a newer back layer instead of arming interrupt when running", async () => {
  await using harness = await renderEscapeHarness({ status: "running", spyLabel: "back" })
  // Instructions-style overlay takes focus: the prompt blurs so `!input.focused`
  // holds and session.interrupt must reject (return false) instead of swallowing.
  harness.promptRef()?.blur()
  await harness.app.waitFor(() => harness.promptRef()?.focused === false)
  harness.app.mockInput.pressEscape()
  await harness.app.waitFor(() => harness.spyCalls.length === 1)
  expect(harness.spyCalls).toEqual(["back"])
  expect(harness.interruptCalls).toEqual([])
  expect(harness.app.captureCharFrame().includes("again to interrupt")).toBe(false)
})

test("escape closes a dialog instead of arming interrupt when running", async () => {
  await using harness = await renderEscapeHarness({ status: "running" })
  harness.dialog.replace(() => (
    <box>
      <text>Dialog marker</text>
    </box>
  ))
  await harness.app.waitForFrame((frame) => frame.includes("Dialog marker"))
  expect(harness.dialog.stack.length).toBe(1)
  harness.app.mockInput.pressEscape()
  await harness.app.waitFor(() => harness.dialog.stack.length === 0)
  expect(harness.interruptCalls).toEqual([])
})
