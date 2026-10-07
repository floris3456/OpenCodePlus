import { expect } from "bun:test"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { State } from "@opencode/core/state"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.live("ctx.batch in effect plugin coalesces registry notifications into one", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins)

    let notifies = 0
    const state = State.create<{ items: string[] }, { add: (item: string) => void }>({
      initial: () => ({ items: [] }),
      editor: (s) => ({ add: (item: string) => s.items.push(item) }),
      notify: () =>
        Effect.sync(() => {
          notifies++
        }),
    })

    // Without batch: 5 transforms produce 5 notifications
    yield* Effect.forEach([1, 2, 3, 4, 5], (n) =>
      state.transform((editor) => {
        editor.add(`item-${n}`)
      }),
    )
    expect(notifies).toBe(5)
    expect(state.get().items.length).toBe(5)

    // With ctx.batch: 5 transforms produce 1 notification
    notifies = 0
    yield* host.batch(
      Effect.forEach([6, 7, 8, 9, 10], (n) =>
        state.transform((editor) => {
          editor.add(`item-${n}`)
        }),
      ),
    )
    expect(notifies).toBe(1)
    expect(state.get().items.length).toBe(10)
  }),
)

it.live("ctx.batch in promise plugin coalesces registry notifications into one", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins)

    let notifies = 0
    const state = State.create<{ items: string[] }, { add: (item: string) => void }>({
      initial: () => ({ items: [] }),
      editor: (s) => ({ add: (item: string) => s.items.push(item) }),
      notify: () =>
        Effect.sync(() => {
          notifies++
        }),
    })

    const customHost: typeof host = {
      ...host,
      tool: {
        ...host.tool,
        transform: state.transform as unknown as typeof host.tool.transform,
      },
    }

    yield* PluginPromise.fromPromise({
      id: "promise-batch-test",
      async setup(context) {
        // Without batch: 5 transforms produce 5 notifications
        for (let i = 1; i <= 5; i++) {
          await context.tool.transform((editor) => {
            ;(editor as unknown as { add: (item: string) => void }).add(`item-${i}`)
          })
        }
        expect(notifies).toBe(5)
        expect(state.get().items.length).toBe(5)

        // With promise ctx.batch: 5 transforms produce 1 notification
        notifies = 0
        await context.batch(async () => {
          for (let i = 6; i <= 10; i++) {
            await context.tool.transform((editor) => {
              ;(editor as unknown as { add: (item: string) => void }).add(`item-${i}`)
            })
          }
        })
        expect(notifies).toBe(1)
        expect(state.get().items.length).toBe(10)
      },
    }).effect(customHost)
  }),
)
