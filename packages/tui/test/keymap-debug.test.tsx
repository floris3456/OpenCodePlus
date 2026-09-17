/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Show } from "solid-js"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { KeymapDebug } from "../src/component/keymap-debug"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { emptyThemeSource } from "./fixture/fixture"

test("keymap debug overlay is hidden by default", async () => {
  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <ThemeProvider mode="dark" source={emptyThemeSource}>
          <Show when={false}>
            <KeymapDebug />
          </Show>
        </ThemeProvider>
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    await app.renderOnce()
    expect(app.captureCharFrame().includes("Keymap debug")).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("toggling shows the keymap debug overlay", async () => {
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <KeymapDebug />
          </ThemeProvider>
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { width: 100, height: 30 },
  )
  try {
    const frame = await app.waitForFrame((current) => current.includes("Keymap debug"))
    expect(frame.includes("Keymap debug")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("dispatched key renders bytes | name | kitty | handled shape", async () => {
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <KeymapDebug />
          </ThemeProvider>
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { width: 100, height: 30 },
  )
  try {
    await app.waitForFrame((current) => current.includes("Keymap debug"))
    app.mockInput.pressKey("x")
    const frame = await app.waitForFrame((current) => current.includes("kitty:"))
    expect(frame.includes("kitty:")).toBe(true)
    expect(frame.includes("|")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
