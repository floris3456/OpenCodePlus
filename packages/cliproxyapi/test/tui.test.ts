import { afterEach, expect, jest, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import CliproxyapiTui, { REPROBE } from "../src/tui.js"

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

// /usage is registered at once so it is never sent as a prompt; its sidebar renders nothing until quota is on.
const USAGE = ["sidebar.content", "app"]

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
  expect(off.state.slots).toEqual(USAGE)
  expect(off.state.probes).toBe(1)
})

test("Usage appears without a restart once quota turns on, and asking stops on dispose", async () => {
  jest.useFakeTimers()
  cleanups.push(() => jest.useRealTimers())
  const answer = { enabled: false }
  const later = host(async () => answer)
  await flush()
  expect(later.state.probes).toBe(1)
  jest.advanceTimersByTime(REPROBE - 1)
  await flush()
  expect(later.state.probes).toBe(1)
  jest.advanceTimersByTime(1)
  await flush()
  expect(later.state.probes).toBe(2)
  expect(later.state.slots).toEqual(USAGE)

  // CPA's quota-handoff is detected: the next answer mounts quota and Usage.
  answer.enabled = true
  jest.advanceTimersByTime(REPROBE)
  await flush()
  expect(later.state.probes).toBe(3)
  expect(later.state.slots).toContain("sidebar.content")
  expect(later.state.slots).toContain("session.composer.top")
  // Once on, it stops asking.
  jest.advanceTimersByTime(REPROBE * 3)
  await flush()
  expect(later.state.probes).toBe(3)

  const disposed = host(async () => ({ enabled: false }))
  await flush()
  disposed.dispose()
  jest.advanceTimersByTime(REPROBE * 3)
  await flush()
  expect(disposed.state.probes).toBe(1)
})

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test("a missing server half (plugin removed) shows nothing and stops probing on dispose", async () => {
  const missing = host(() => Promise.reject(new Error("unknown rpc")))
  await Bun.sleep(5)
  expect(missing.state.slots).toEqual(USAGE)
  missing.dispose()
  expect(missing.state.slots).toEqual([])
  expect(missing.state.probes).toBe(1)
})
