/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { DialogUpdate } from "../../src/component/dialog-update"
import { ConfigProvider } from "../../src/config"
import type { UpdateState } from "../../src/context/update-notification"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("installation progress replaces checking while the update job is still pending", async () => {
  await using temporary = await tmpdir()
  const [state, setState] = createSignal<UpdateState>()
  const pending = Promise.withResolvers<string | undefined>()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <DialogUpdate
                    check={() => pending.promise}
                    state={state}
                    skip={() => {}}
                    install={() => Promise.resolve()}
                    restart={() => {}}
                  />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Checking for updates"))
    setState({ type: "installing", version: "2.0.0" })
    await app.waitForFrame(
      (frame) =>
        frame.includes("Updating OpenCode") &&
        frame.includes("Installing OpenCode 2.0.0") &&
        !frame.includes("Checking"),
    )
    expect(app.captureCharFrame()).not.toContain("Skip")
    pending.reject(new Error("Update service unavailable"))
    await app.waitForFrame((frame) => frame.includes("Update service unavailable") && !frame.includes("Installing"))
  } finally {
    pending.resolve(undefined)
    app.renderer.destroy()
  }
})

test("names the product and version it installs and shows the step the update is on", async () => {
  await using temporary = await tmpdir()
  const [state, setState] = createSignal<UpdateState>({ type: "available", version: "2.0.18-plus-1.0.1" })
  const describe = (version: string) => (version === "2.0.18-plus-1.0.1" ? "OpenCodePlus 1.0.1 (opencode 2.0.18)" : version)
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <DialogUpdate
                    product="OpenCodePlus"
                    describe={describe}
                    state={state}
                    skip={() => {}}
                    install={() => Promise.resolve()}
                    restart={() => {}}
                  />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame(
      (frame) =>
        frame.includes("OpenCodePlus 1.0.1 (opencode 2.0.18) is available") &&
        frame.includes("restart OpenCodePlus") &&
        frame.includes("Update"),
    )
    setState({ type: "installing", version: "2.0.18-plus-1.0.1" })
    await app.waitForFrame(
      (frame) => frame.includes("Updating OpenCodePlus") && frame.includes("Installing OpenCodePlus 1.0.1 (opencode 2.0.18)"),
    )
    setState({ type: "installing", version: "2.0.18-plus-1.0.1", message: "Waiting for 2 running chats to finish…" })
    await app.waitForFrame((frame) => frame.includes("Waiting for 2 running chats to finish"))
    setState({ type: "installed", version: "2.0.18-plus-1.0.1" })
    await app.waitForFrame((frame) => frame.includes("Restart") && frame.includes("A restart is required"))
  } finally {
    app.renderer.destroy()
  }
})
