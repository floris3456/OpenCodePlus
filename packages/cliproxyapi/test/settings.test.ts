import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createSettings } from "../src/settings.js"

type Row = {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly value?: () => string | undefined
  readonly run: () => void | Promise<void>
}

function harness(input: {
  readonly plugins?: unknown[]
  readonly models?: ReadonlyArray<{ providerID: string; modelID: string; name: string }>
  readonly picks?: ReadonlyArray<string | undefined>
}) {
  let config: { plugins?: unknown[] } = { plugins: structuredClone(input.plugins ?? []) }
  const rows: Row[] = []
  const toasts: string[] = []
  const picks = [...(input.picks ?? [])]
  const context = {
    config: {
      get data() {
        return config
      },
      async update(mutate: (draft: { plugins?: unknown[] }) => void) {
        const draft = structuredClone(config)
        mutate(draft)
        config = draft
        return config
      },
    },
    data: { location: { model: { list: () => input.models ?? [] } } },
    ui: {
      settings: {
        register: (setting: Row) => {
          rows.push(setting)
          return () => {}
        },
      },
      dialog: { select: async () => picks.shift() },
      toast: { show: (toast: { message: string }) => toasts.push(toast.message) },
    },
  } as unknown as Plugin.Context
  return { context, rows, config: () => config, toasts }
}

test("the Pacer settings are three Pacer rows reading the plugin options", () => {
  const h = harness({})
  createSettings(h.context)
  expect(h.rows.map((row) => row.id)).toEqual([
    "pacer.account-switch",
    "pacer.compaction-model",
    "pacer.compaction-fallback",
  ])
  expect(h.rows.every((row) => row.category === "Pacer")).toBe(true)
  expect(h.rows[0].value?.()).toBe("on")
  expect(h.rows[1].value?.()).toBe("agent default")
  expect(h.rows[2].value?.()).toBe("none")
})

test("account switch toggles the plugin option, creating the entry when absent", async () => {
  const h = harness({})
  createSettings(h.context)
  await h.rows[0].run()
  expect(h.config()).toEqual({ plugins: [{ package: "opencode-pacer", options: { accountSwitch: false } }] })
  expect(h.rows[0].value?.()).toBe("off")
  await h.rows[0].run()
  expect(h.rows[0].value?.()).toBe("on")
})

test("a bare string entry becomes the options object without losing its place", async () => {
  const h = harness({ plugins: ["something", "opencode-pacer", "other"] })
  createSettings(h.context)
  await h.rows[0].run()
  expect(h.config()).toEqual({
    plugins: ["something", { package: "opencode-pacer", options: { accountSwitch: false } }, "other"],
  })
})

test("the model rows pick provider and model", async () => {
  const h = harness({
    plugins: [{ package: "opencode-pacer", options: { compactionModel: "old/model" } }],
    models: [{ providerID: "cliproxyapi", modelID: "cheap", name: "Cheap" }],
    picks: ["cliproxyapi", "cheap"],
  })
  createSettings(h.context)
  expect(h.rows[1].value?.()).toBe("old/model")
  await h.rows[1].run()
  expect(h.rows[1].value?.()).toBe("cliproxyapi/cheap")
  expect(h.config()).toEqual({
    plugins: [{ package: "opencode-pacer", options: { compactionModel: "cliproxyapi/cheap" } }],
  })
})

test("the picker's follow option clears the field", async () => {
  const h = harness({
    plugins: [{ package: "opencode-pacer", options: { compactionModel: "old/model" } }],
    models: [{ providerID: "cliproxyapi", modelID: "cheap", name: "Cheap" }],
    picks: [""],
  })
  createSettings(h.context)
  await h.rows[1].run()
  expect(h.rows[1].value?.()).toBe("agent default")
  expect(h.config()).toEqual({ plugins: [{ package: "opencode-pacer", options: {} }] })
})

test("a cancelled picker changes nothing", async () => {
  const h = harness({ models: [{ providerID: "cliproxyapi", modelID: "cheap", name: "Cheap" }], picks: [undefined] })
  createSettings(h.context)
  await h.rows[1].run()
  expect(h.rows[1].value?.()).toBe("agent default")
  expect(h.config().plugins).toEqual([])
})

test("an empty catalogue warns instead of writing", async () => {
  const h = harness({ models: [] })
  createSettings(h.context)
  await h.rows[1].run()
  expect(h.toasts).toEqual(["No models are available to pick"])
  expect(h.config().plugins).toEqual([])
})

test("dispose unregisters every Pacer row", () => {
  const removed: string[] = []
  const context = {
    config: { data: { plugins: [] }, update: async () => {} },
    data: { location: { model: { list: () => [] } } },
    ui: {
      settings: {
        register: (setting: Row) => {
          removed.push(setting.id)
          return () => {
            const at = removed.indexOf(setting.id)
            if (at >= 0) removed.splice(at, 1)
          }
        },
      },
      dialog: { select: async () => undefined },
      toast: { show: () => {} },
    },
  } as unknown as Plugin.Context
  const dispose = createSettings(context)
  expect(removed).toHaveLength(3)
  dispose()
  expect(removed).toEqual([])
})
