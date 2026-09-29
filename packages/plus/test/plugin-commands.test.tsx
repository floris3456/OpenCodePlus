import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import plusPlugin from "../src/tui/index.js"
import type { TestKeymapCommand } from "./tui.js"

interface CommandsHarness {
  readonly context: Plugin.Context
  /** Run the plugin slot's render callback, which registers the keymap layer. */
  readonly mountSlot: () => void
  readonly commands: () => readonly TestKeymapCommand[]
  readonly navigations: unknown[]
  readonly setCurrent: (route: unknown) => void
}

// The TUI plugin's setup only registers commands through the slot's render
// callback, so the harness collects `ui.slot` and runs the callback itself.
function createHarness(): CommandsHarness {
  const layers: (Parameters<Plugin.Context["keymap"]["layer"]>[0])[] = []
  const navigations: unknown[] = []
  const slotRenders: (() => unknown)[] = []
  let current: unknown = { type: "session", sessionID: "ses_1" }

  const raw: {} = {
    app: { version: "0.0.0", channel: "test" },
    location: undefined,
    client: {
      rpc: () => ({
        "team.list": async () => ({ teams: [] }),
        events: { on: () => () => {} },
      }),
    },
    data: {
      location: {
        default: () => undefined,
        agent: { list: () => [], sync: async () => {} },
        model: { list: () => [], sync: async () => {} },
      },
    },
    keymap: {
      layer: (fn: (typeof layers)[number]) => {
        layers.push(fn)
      },
    },
    storage: {
      store: (_key: string, options: { initial: object }) => [options.initial, async () => {}] as const,
    },
    ui: {
      router: {
        register: () => () => {},
        current: () => current,
        navigate: (route: unknown) => {
          navigations.push(route)
        },
      },
      slot: (options: { render: () => unknown }) => {
        slotRenders.push(options.render)
        return () => {}
      },
      dialog: { clear: () => {} },
      toast: { show: () => {} },
      agents: {
        groups: () => () => {},
        activeGroup: { current: () => undefined, set: () => {} },
        open: () => {},
        current: () => undefined,
        set: () => {},
      },
      panel: { open: () => false, close: () => {} },
      tabs: { enabled: () => false },
    },
    theme: {},
  }

  const context = raw as Plugin.Context
  return {
    context,
    mountSlot: () => {
      for (const render of slotRenders) render()
    },
    commands: () => layers.flatMap((fn) => fn().commands ?? []),
    navigations,
    setCurrent: (route) => {
      current = route
    },
  }
}

test("<leader>p opens Instructions and no plus.project command exists", async () => {
  const harness = createHarness()
  const cleanup = await plusPlugin.setup(harness.context)
  harness.mountSlot()
  try {
    const commands = harness.commands()
    const open = commands.find((command) => command.id === "plus.instructions.open")
    expect(open).toBeDefined()
    expect(open?.bind).toBe("<leader>p")
    expect(open?.slash?.name).toBe("instructions")
    expect(open?.palette).toBe(true)
    // Nothing else claims <leader>p, and no project-mode command survives.
    expect(commands.filter((command) => command.bind === "<leader>p")).toHaveLength(1)
    expect(commands.filter((command) => command.id?.startsWith("plus.project"))).toHaveLength(0)
    // With another route current, running it navigates to Instructions.
    harness.setCurrent({ type: "session", sessionID: "ses_1" })
    await open?.run()
    expect(harness.navigations).toEqual([{ type: "plugin", name: "instructions" }])
    // Pressed while Instructions is already open it stays a no-op.
    harness.setCurrent({ type: "plugin", id: "opencode.plus", name: "instructions" })
    await open?.run()
    expect(harness.navigations).toHaveLength(1)
  } finally {
    await cleanup?.()
  }
})
