/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount, type JSX } from "solid-js"
import { ConfigProvider, resolve, type Info, type Interface } from "../../../src/config"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { DialogConfig, registerSetting } from "../../../src/component/dialog-config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { emptyThemeSource } from "../../fixture/fixture"

function config() {
  let current: Info = {}
  const service: Interface = {
    get: async () => current,
    update: async (update) => {
      const draft = structuredClone(current)
      update(draft)
      current = draft
      return current
    },
  }
  return service
}

async function renderDialog(component: () => JSX.Element) {
  function Fixture() {
    const dialog = useDialog()
    onMount(() => dialog.replace(component))
    return null
  }
  return testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={resolve({}, { terminalSuspend: true })} service={config()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
}

test("a plugin setting shows in the Settings window under its category and runs on Enter", async () => {
  let ran = 0
  let value = "on"
  const unregister = registerSetting({
    id: "test.example",
    title: "Example plugin setting",
    category: "OpenCodePlus",
    value: () => value,
    run: () => {
      ran += 1
      value = value === "on" ? "off" : "on"
    },
  })
  const app = await renderDialog(() => <DialogConfig />)
  app.renderer.start()
  try {
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    for (const key of "example plugin") app.mockInput.pressKey(key)
    await app.waitForFrame((frame) => frame.includes("Example plugin setting"))
    app.mockInput.pressEnter()
    await app.waitFor(() => ran === 1)
    expect(value).toBe("off")
  } finally {
    app.renderer.destroy()
    unregister()
  }
})

test("the Commands window search finds a plugin setting and opens it", async () => {
  const unregister = registerSetting({
    id: "test.searchable",
    title: "Searchable plugin setting",
    category: "OpenCodePlus",
    value: () => "on",
    run: () => {},
  })
  const app = await renderDialog(() => <CommandPaletteDialog />)
  app.renderer.start()
  try {
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    for (const key of "searchable plugin") app.mockInput.pressKey(key)
    await app.waitForFrame((frame) => frame.includes("Searchable plugin setting"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Settings") && frame.includes("Searchable plugin setting"))
  } finally {
    app.renderer.destroy()
    unregister()
  }
})
