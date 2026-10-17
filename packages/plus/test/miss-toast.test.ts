import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createStore } from "solid-js/store"
import plusPlugin from "../src/tui/index.js"
import type { TestKeymapCommand } from "./tui.js"

interface MissToastHarness {
  readonly context: Plugin.Context
  readonly mountSlot: () => void
  readonly commands: () => readonly TestKeymapCommand[]
  readonly settings: () => readonly TestSetting[]
  readonly toasts: Array<{ variant?: string; message: string }>
  readonly emit: (event: { type: string; data?: Record<string, unknown> }) => Promise<void>
  readonly setRoute: (route: unknown) => void
  readonly setStepResult: (result: unknown) => void
  readonly stepCalls: Array<{ sessionID: string }>
}

type TestSetting = {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly value?: () => string | undefined
  readonly run: () => void | Promise<void>
}

function createHarness(): MissToastHarness {
  const layers: ((() => { commands?: readonly TestKeymapCommand[] }))[] = []
  const slotRenders: ((props: object) => unknown)[] = []
  const settingsRows: TestSetting[] = []
  const toasts: Array<{ variant?: string; message: string }> = []
  const onHandlers = new Map<string, Set<(event: any) => void>>()
  const listeners = new Set<(event: { details: { type: string; data?: Record<string, unknown> } }) => void>()
  const storeCells = new Map<string, unknown>()
  let currentRoute: unknown = { type: "session", sessionID: "ses_1" }
  let currentStepResult: unknown = {
    status: "ready",
    stepID: "msg_1",
    requestID: "req_1",
    miss: true,
    notReused: 384_815,
    cause: "account-changed",
    causeText: "account changed",
  }
  const stepCalls: Array<{ sessionID: string }> = []

  const raw: unknown = {
    app: { version: "0.0.0", channel: "test" },
    location: undefined,
    client: {
      rpc: () => ({
        "team.list": async () => ({ teams: [] }),
        "settings.get": async () => ({ coldCompact: false }),
        "monitor.step": async (input: { sessionID: string }) => {
          stepCalls.push(input)
          return currentStepResult
        },
        events: { on: () => () => {} },
      }),
    },
    data: {
      location: {
        default: () => undefined,
        agent: { list: () => [], sync: async () => {} },
        model: { list: () => [], sync: async () => {} },
      },
      on: (type: string, handler: (event: any) => void) => {
        const set = onHandlers.get(type) ?? new Set()
        onHandlers.set(type, set)
        set.add(handler)
        return () => set.delete(handler)
      },
      listen: (handler: (event: { details: { type: string; data?: Record<string, unknown> } }) => void) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      session: {
        status: () => "idle",
      },
    },
    keymap: {
      layer: (fn: (() => { commands?: readonly TestKeymapCommand[] })) => {
        layers.push(fn)
      },
    },
    storage: {
      store: <T extends object>(key: string, options: { initial: T }) => {
        const initial = (storeCells.get(key) as T | undefined) ?? options.initial
        const [value, setValue] = createStore<T>(initial)
        const rawCell = structuredClone(initial) as T
        const save = async (mutation: (draft: T) => void) => {
          mutation(rawCell)
          setValue(rawCell)
          storeCells.set(key, structuredClone(rawCell))
        }
        return [value, save] as const
      },
    },
    ui: {
      model: { onPick: () => () => {} },
      router: {
        register: () => () => {},
        current: () => currentRoute,
        navigate: () => {},
      },
      slot: (options: { render: (props: object) => unknown }) => {
        slotRenders.push(options.render)
        return () => {}
      },
      prompt: {
        guard: () => () => {},
      },
      dialog: { clear: () => {} },
      toast: {
        show: (toast: { variant?: string; message: string }) => {
          toasts.push(toast)
        },
      },
      agents: {
        groups: () => () => {},
        activeGroup: { current: () => undefined, set: () => {} },
        open: () => {},
        current: () => undefined,
        set: () => {},
      },
      panel: { open: () => false, close: () => {} },
      tabs: { enabled: () => false },
      settings: {
        register: (setting: TestSetting) => {
          settingsRows.push(setting)
          return () => {
            const at = settingsRows.indexOf(setting)
            if (at >= 0) settingsRows.splice(at, 1)
          }
        },
      },
    },
    theme: {},
  }

  const context = raw as Plugin.Context
  return {
    context,
    mountSlot: () => {
      for (const render of slotRenders) render({})
    },
    commands: () => layers.flatMap((fn) => fn().commands ?? []),
    settings: () => settingsRows,
    toasts,
    emit: async (event) => {
      const handlers = onHandlers.get(event.type)
      if (handlers) {
        for (const handler of handlers) {
          handler(event)
        }
      }
      for (const listener of listeners) {
        listener({ details: event })
      }
      // allow microtasks to settle
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    setRoute: (route) => {
      currentRoute = route
    },
    setStepResult: (result) => {
      currentStepResult = result
    },
    stepCalls,
  }
}

test("cache-miss toast lifecycle: miss toast, hits, dedup, route filter, off switch, and settings toggle", async () => {
  const harness = createHarness()
  const cleanup = await plusPlugin.setup(harness.context)
  // Cache-miss notices is a global Settings row, registered at setup, and must
  // not appear in the command list.
  expect(harness.settings().map((setting) => setting.id)).toEqual(["plus.miss-notices", "plus.cold-compact"])
  expect(harness.commands().filter((command) => command.id?.startsWith("plus.miss-notices"))).toHaveLength(0)
  harness.mountSlot()

  // 1. A step-end event for the chat on screen with a miss shows exactly one toast with the exact text
  await harness.emit({
    type: "session.step.ended",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      tokens: { input: 100, output: 20 },
    },
  })

  expect(harness.toasts.length).toBe(1)
  expect(harness.toasts[0]).toEqual({
    variant: "warning",
    message: "Cache shortfall estimate · 384,815 tokens · account changed · type /monitor for details",
  })

  // 2. The same step twice shows only one toast (remember last toasted id per session)
  await harness.emit({
    type: "session.step.ended",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      tokens: { input: 100, output: 20 },
    },
  })
  expect(harness.toasts.length).toBe(1)

  // 3. A hit shows none
  harness.setStepResult({
    status: "ready",
    stepID: "msg_hit",
    requestID: "req_hit",
    miss: false,
    notReused: 0,
    causeText: "unknown",
  })
  await harness.emit({
    type: "session.step.ended",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_hit",
      tokens: { input: 100, output: 20 },
    },
  })
  expect(harness.toasts.length).toBe(1)

  // 4. Another session's step shows none
  harness.setStepResult({
    status: "ready",
    stepID: "msg_other",
    requestID: "req_other",
    miss: true,
    notReused: 50_000,
    cause: "model-switch",
    causeText: "model switched",
  })
  await harness.emit({
    type: "session.step.ended",
    data: {
      sessionID: "ses_other",
      assistantMessageID: "msg_other",
      tokens: { input: 100, output: 20 },
    },
  })
  expect(harness.toasts.length).toBe(1)

  // 5. The Settings row reflects and toggles the global switch
  const notices = () => harness.settings().find((setting) => setting.id === "plus.miss-notices")!
  expect(notices().value?.()).toBe("on")

  await notices().run()
  expect(notices().value?.()).toBe("off")

  // 6. With the switch off, no miss toast is shown
  harness.setStepResult({
    status: "ready",
    stepID: "msg_off",
    requestID: "req_off",
    miss: true,
    notReused: 20_000,
    cause: "cache-expired",
    causeText: "cache expired",
  })
  await harness.emit({
    type: "session.step.ended",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_off",
      tokens: { input: 100, output: 20 },
    },
  })
  // Still only the initial toast plus the "Cache-miss notices: off" info toast
  const warningToasts = harness.toasts.filter((t) => t.variant === "warning")
  expect(warningToasts.length).toBe(1)

  // Toggle back on
  await notices().run()
  expect(notices().value?.()).toBe("on")

  // Now a new miss shows a warning toast again
  harness.setStepResult({
    status: "ready",
    stepID: "msg_on",
    requestID: "req_on",
    miss: true,
    notReused: 12_345,
    cause: "cache-expired",
    causeText: "cache expired",
  })
  await harness.emit({
    type: "session.step.ended",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_on",
      tokens: { input: 100, output: 20 },
    },
  })
  const updatedWarnings = harness.toasts.filter((t) => t.variant === "warning")
  expect(updatedWarnings.length).toBe(2)
  expect(updatedWarnings[1].message).toBe("Cache shortfall estimate · 12,345 tokens · cache expired · type /monitor for details")

  cleanup?.()
})

test("on pending, ask once more on the next session event", async () => {
  const harness = createHarness()
  const cleanup = await plusPlugin.setup(harness.context)
  harness.mountSlot()

  // Step ends, monitor.step says pending
  harness.setStepResult({ status: "pending" })
  await harness.emit({
    type: "session.step.ended",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_pending",
      tokens: { input: 100, output: 20 },
    },
  })

  expect(harness.stepCalls.length).toBe(1)
  expect(harness.toasts.length).toBe(0)

  // Next session event arrives (e.g. session.tool.called) - it asks once more
  harness.setStepResult({
    status: "ready",
    stepID: "msg_pending",
    requestID: "req_pending",
    miss: true,
    notReused: 99_000,
    cause: "agent-switch",
    causeText: "agent switched",
  })
  await harness.emit({
    type: "session.tool.called",
    data: {
      sessionID: "ses_1",
      id: "call_1",
    },
  })

  expect(harness.stepCalls.length).toBe(2)
  expect(harness.toasts.length).toBe(1)
  expect(harness.toasts[0].message).toBe("Cache shortfall estimate · 99,000 tokens · agent switched · type /monitor for details")

  // Another session event arrives: since retry already settled, do not poll while idle
  await harness.emit({
    type: "session.tool.success",
    data: {
      sessionID: "ses_1",
      id: "call_1",
    },
  })
  expect(harness.stepCalls.length).toBe(2)

  cleanup?.()
})

test("dropped thinking alerts once per first dropped block, with the miss switch off too", async () => {
  const harness = createHarness()
  const cleanup = await plusPlugin.setup(harness.context)
  harness.mountSlot()
  const step = async (stepID: string, result: Record<string, unknown>) => {
    harness.setStepResult({ status: "ready", stepID, requestID: `req_${stepID}`, notReused: 0, causeText: "unknown", miss: false, ...result })
    await harness.emit({ type: "session.step.ended", data: { sessionID: "ses_1", assistantMessageID: stepID, tokens: { input: 100, output: 20 } } })
  }
  const dropped = { blocks: 12, first: "messages.1.content.0", reasons: ["prefix_binding_mismatch"] }

  // With a miss on the same step, one toast names both.
  await step("msg_a", { miss: true, notReused: 433_771, cause: "unknown", causeText: "sent prefix unchanged", droppedThinking: dropped })
  expect(harness.toasts).toEqual([
    {
      variant: "warning",
      message: "Claude dropped 12 earlier thinking blocks and answered without them · Cache shortfall estimate · 433,771 tokens · sent prefix unchanged · type /monitor for details",
    },
  ])

  // The same blocks stay dropped on the next steps: no repeat, even as the count grows.
  await step("msg_b", { droppedThinking: { ...dropped, blocks: 13 } })
  expect(harness.toasts).toHaveLength(1)

  // A drop from an earlier block is new; it alerts with cache-miss notices off.
  await harness.settings().find((setting) => setting.id === "plus.miss-notices")!.run()
  harness.toasts.length = 0
  await step("msg_c", { miss: true, notReused: 5_000, causeText: "cache expired", droppedThinking: { blocks: 1, first: "messages.0.content.1", reasons: [] } })
  expect(harness.toasts).toEqual([
    { variant: "warning", message: "Claude dropped 1 earlier thinking block and answered without them · type /monitor for details" },
  ])

  cleanup?.()
})
