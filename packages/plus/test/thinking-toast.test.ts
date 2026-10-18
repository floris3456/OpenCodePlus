import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createStore } from "solid-js/store"
import plusPlugin from "../src/tui/index.js"
import type { TestKeymapCommand } from "./tui.js"

interface ThinkingToastHarness {
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

function createHarness(): ThinkingToastHarness {
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
        "monitor.notices": async () => ({ notices: [] }),
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
    droppedThinking: { blocks: 2, first: "messages.3.content.0", reasons: [] },
  })
  await harness.emit({
    type: "session.tool.called",
    data: {
      sessionID: "ses_1",
      id: "call_1",
    },
  })

  expect(harness.stepCalls.length).toBe(2)
  // A cache miss is a cache notice now, never a toast; only the dropped thinking is.
  expect(harness.toasts).toEqual([
    { variant: "warning", message: "Claude dropped 2 earlier thinking blocks and answered without them · type /monitor for details" },
  ])

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

test("dropped thinking alerts once per first dropped block, with cache notices off too", async () => {
  const harness = createHarness()
  const cleanup = await plusPlugin.setup(harness.context)
  harness.mountSlot()
  const step = async (stepID: string, result: Record<string, unknown>) => {
    harness.setStepResult({ status: "ready", stepID, requestID: `req_${stepID}`, notReused: 0, causeText: "unknown", miss: false, ...result })
    await harness.emit({ type: "session.step.ended", data: { sessionID: "ses_1", assistantMessageID: stepID, tokens: { input: 100, output: 20 } } })
  }
  const dropped = { blocks: 12, first: "messages.1.content.0", reasons: ["prefix_binding_mismatch"] }

  // A miss on the same step is left to the cache notices.
  await step("msg_a", { miss: true, notReused: 433_771, cause: "unknown", causeText: "sent prefix unchanged", droppedThinking: dropped })
  expect(harness.toasts).toEqual([
    { variant: "warning", message: "Claude dropped 12 earlier thinking blocks and answered without them · type /monitor for details" },
  ])

  // The same blocks stay dropped on the next steps: no repeat, even as the count grows.
  await step("msg_b", { droppedThinking: { ...dropped, blocks: 13 } })
  expect(harness.toasts).toHaveLength(1)

  // A drop from an earlier block is new; it alerts with cache notices off.
  await harness.settings().find((setting) => setting.id === "plus.miss-notices")!.run()
  harness.toasts.length = 0
  await step("msg_c", { miss: true, notReused: 5_000, causeText: "cache expired", droppedThinking: { blocks: 1, first: "messages.0.content.1", reasons: [] } })
  expect(harness.toasts).toEqual([
    { variant: "warning", message: "Claude dropped 1 earlier thinking block and answered without them · type /monitor for details" },
  ])

  cleanup?.()
})
