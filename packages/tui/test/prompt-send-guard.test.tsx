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

import type { PromptSendInput } from "@opencode/plugin/tui/context"
import { promptSendGuards } from "../src/component/prompt/send-guard"

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

async function renderSendHarness() {
  const temporary = await tmpdir()
  await Bun.write(path.join(temporary.path, "model.json"), JSON.stringify({}))
  const events = createEventStream()
  const requests: string[] = []
  const calls = createFetch(async (url, request) => {
    requests.push(`${request.method} ${url.pathname}`)
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

  function Content() {
    return (
      <>
        <Prompt sessionID={SESSION_ID} visible={true} ref={(ref) => (promptRefValue = ref ?? undefined)} />
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
  data.session.setStatus(SESSION_ID, "idle")
  await app.waitFor(() => promptRefValue?.focused === true)
  await app.renderOnce()
  return {
    app,
    data,
    local,
    route,
    dialog,
    requests,
    promptRef: () => promptRefValue,
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await temporary[Symbol.asyncDispose]()
    },
  }
}


// The send runs after the keypress resolves asynchronously: poll in wall time.
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!check() && Date.now() < deadline) await Bun.sleep(20)
  expect(check()).toBe(true)
}

// A plugin's ui.prompt.guard may hold a send: the Cache warming footer holds a
// message into a cold cache until a second submit. Held means nothing reaches
// the server and the text stays in the prompt.
test("a guard that holds keeps the text and sends nothing; the next submit sends", async () => {
  const seen: PromptSendInput[] = []
  const unregister = promptSendGuards.register((input) => {
    seen.push(input)
    return seen.length > 1
  })
  try {
    await using harness = await renderSendHarness()
    await harness.app.mockInput.typeText("hello cache")
    await harness.app.renderOnce()
    harness.app.mockInput.pressEnter()
    await until(() => seen.length === 1)
    await Bun.sleep(100)
    expect(seen[0]).toEqual({ sessionID: SESSION_ID, mode: "normal", delivery: "steer" })
    // Held: the send never began (it starts by reading the chat it sends into) and the text stays.
    const sending = () => harness.requests.filter((request) => request.includes(`/api/session/${SESSION_ID}`))
    expect(sending()).toEqual([])
    expect(harness.promptRef()?.current.text).toBe("hello cache")
    // The second submit passes the guard and the send begins.
    harness.app.mockInput.pressEnter()
    await until(() => sending().length > 0)
    expect(seen).toHaveLength(2)
  } finally {
    unregister()
  }
}, 15_000)

test("every guard runs for each send, and one hold is enough", () => {
  const calls: string[] = []
  const first = promptSendGuards.register(() => (calls.push("first"), false))
  const second = promptSendGuards.register(() => (calls.push("second"), true))
  try {
    expect(promptSendGuards.allows({ sessionID: SESSION_ID, mode: "normal", delivery: "steer" })).toBe(false)
    expect(calls).toEqual(["first", "second"])
  } finally {
    first()
    second()
  }
  expect(promptSendGuards.allows({ mode: "normal", delivery: "steer" })).toBe(true)
}, 15_000)
