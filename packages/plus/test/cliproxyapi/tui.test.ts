import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import CliproxyapiTui from "../../src/cliproxyapi/tui.js"

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function host(enabled: () => Promise<{ enabled: boolean }>) {
  const [route] = createSignal({ type: "session" as const, sessionID: "ses_a" })
  const [model] = createSignal({ providerID: "cpa", modelID: "m" })
  const state = { slots: [] as string[], layers: 0, probes: 0 }
  const context = {
    client: {
      rpc: () => ({
        enabled: () => {
          state.probes++
          return enabled()
        },
        read: () => new Promise(() => {}),
        status: () => Promise.resolve([]),
      }),
    },
    keymap: { layer: () => state.layers++ },
    ui: {
      slot: (claim: Record<string, unknown>) => {
        const key = ["append", "prepend", "before", "after", "replace"].find((name) => claim[name] !== undefined)!
        state.slots.push(String(claim[key]))
        return () => state.slots.splice(state.slots.indexOf(String(claim[key])), 1)
      },
      model: { current: model },
      router: { current: route },
    },
  } as unknown as Plugin.Context
  const dispose = CliproxyapiTui.setup!(context) as () => void
  cleanups.push(dispose)
  return { state, dispose }
}

test("shows quota and usage UI only when the server half reports CLIProxyAPI configured", async () => {
  const on = host(async () => ({ enabled: true }))
  await Bun.sleep(5)
  expect(on.state.slots).toContain("sidebar.content")
  expect(on.state.slots).toContain("session.composer.top")
  on.dispose()
  expect(on.state.slots).toEqual([])

  const off = host(async () => ({ enabled: false }))
  await Bun.sleep(5)
  expect(off.state.slots).toEqual([])
  expect(off.state.probes).toBe(1)
})

test("a missing server half (plugin removed) shows nothing and stops probing on dispose", async () => {
  const missing = host(() => Promise.reject(new Error("unknown rpc")))
  await Bun.sleep(5)
  expect(missing.state.slots).toEqual([])
  missing.dispose()
  expect(missing.state.probes).toBe(1)
})
