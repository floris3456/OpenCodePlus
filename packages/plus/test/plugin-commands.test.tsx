import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import plusPlugin from "../src/tui/index.js"
import type { TestKeymapCommand } from "./tui.js"

type Setting = Parameters<Plugin.Context["ui"]["settings"]["register"]>[0]

interface CommandsHarness {
  readonly context: Plugin.Context
  /** Run the plugin slot's render callback, which registers the keymap layer. */
  readonly mountSlot: () => void
  readonly commands: () => readonly TestKeymapCommand[]
  readonly settings: () => readonly Setting[]
  /** What `settings.set` received; the fake server keeps the last value. */
  readonly settingWrites: unknown[]
  readonly navigations: unknown[]
  readonly setCurrent: (route: unknown) => void
}

// The TUI plugin's setup only registers commands through the slot's render
// callback, so the harness collects `ui.slot` and runs the callback itself.
function createHarness(): CommandsHarness {
  const layers: (Parameters<Plugin.Context["keymap"]["layer"]>[0])[] = []
  const navigations: unknown[] = []
  const settings: Setting[] = []
  const settingWrites: unknown[] = []
  const server = {
    coldCompact: false,
    noticeMinutes: 15,
    noticeMinTokens: 0,
    noticeKinds: "misses-and-partials",
    noticeDismiss: "everywhere",
  }
  // Slot renders receive the slot's input; the prompt footer's carries no session here.
  const slotRenders: ((props: object) => unknown)[] = []
  let current: unknown = { type: "session", sessionID: "ses_1" }

  const raw: {} = {
    app: { version: "0.0.0", channel: "test" },
    location: undefined,
    client: {
      rpc: () => ({
        "team.list": async () => ({ teams: [] }),
        "settings.get": async () => ({ ...server }),
        "settings.set": async (input: { coldCompact?: boolean }) => {
          settingWrites.push(input)
          if (input.coldCompact !== undefined) server.coldCompact = input.coldCompact
          return { ...server }
        },
        "monitor.notices": async () => ({ notices: [] }),
        "attention.open": async () => ({ tuis: 1 }),
        events: { on: () => () => {} },
      }),
    },
    data: {
      on: () => () => {},
      listen: () => () => {},
      session: { get: () => undefined },
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
      // model.pick registers its pick listener at setup (tui/model-pick.ts);
      // these command tests never pick a model.
      model: { onPick: () => () => {} },
      router: {
        register: () => () => {},
        current: () => current,
        navigate: (route: unknown) => {
          navigations.push(route)
        },
      },
      slot: (options: { render: (props: object) => unknown }) => {
        slotRenders.push(options.render)
        return () => {}
      },
      // The warming footer registers a send guard at setup (warming.tsx); the
      // harness only needs the registration to succeed, not the guard to run.
      prompt: {
        guard: () => () => {},
      },
      // The context % provider (usage-window.ts) registers at setup too.
      usage: {
        window: () => () => {},
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
      settings: {
        register: (setting: Setting) => {
          settings.push(setting)
          return () => {}
        },
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
      for (const render of slotRenders) render({})
    },
    commands: () => layers.flatMap((fn) => fn().commands ?? []),
    settings: () => settings,
    settingWrites,
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

test("the Monitor command exposes /monitor with the lowercase /tools alias", async () => {
  const harness = createHarness()
  const cleanup = await plusPlugin.setup(harness.context)
  harness.mountSlot()
  try {
    const commands = harness.commands()
    const open = commands.find((command) => command.id === "plus.monitor.open")
    expect(open).toBeDefined()
    // The old spelling remains an alias of the same command, not a duplicate.
    expect(open?.slash?.name).toBe("monitor")
    expect(open?.slash?.aliases).toEqual(["tools"])
    expect(open?.title).toBe("Open monitor")
    expect(open?.bind).toBe("<leader>o")
    expect(open?.palette).toBe(true)
    // The command id stays stable so existing configs keep binding it.
    expect(commands.filter((command) => command.id === "plus.monitor.open")).toHaveLength(1)
  } finally {
    await cleanup?.()
  }
})

test("Compact cold chats first is a global OpenCodePlus setting that reads and writes the server switch", async () => {
  const harness = createHarness()
  const cleanup = await plusPlugin.setup(harness.context)
  try {
    const row = harness.settings().find((setting) => setting.id === "plus.cold-compact")
    expect(row).toMatchObject({ title: "Compact cold chats first", category: "OpenCodePlus" })
    await Bun.sleep(0)
    expect(row?.value?.()).toBe("off")
    await row?.run()
    expect(harness.settingWrites).toEqual([{ coldCompact: true }])
    expect(row?.value?.()).toBe("on")
    await row?.run()
    expect(harness.settingWrites.at(-1)).toEqual({ coldCompact: false })
    expect(row?.value?.()).toBe("off")
  } finally {
    await cleanup?.()
  }
})

test("the Commands window lists five short OpenCodePlus commands and nothing else", async () => {
  const harness = createHarness()
  const cleanup = await plusPlugin.setup(harness.context)
  harness.mountSlot()
  try {
    const commands = harness.commands()
    const palette = commands
      .filter((command) => command.palette)
      .map((command) => [command.title, command.bind ?? command.description, command.group])
    expect(palette).toEqual([
      ["Open instructions", "<leader>p", "OpenCodePlus"],
      ["Open monitor", "<leader>o", "OpenCodePlus"],
      ["Refresh", "Reload settings and files", "OpenCodePlus"],
      ["Toggle cache warming", "<leader>k", "OpenCodePlus"],
      ["Toggle compact before cold", "<leader>j", "OpenCodePlus"],
    ])
    expect(commands.filter((command) => !command.palette)).toEqual([])
    // The settings, agent and one-off compaction commands are gone, slash forms
    // included; the team runs and project checks live in the Monitor's Team tab.
    for (const name of ["compact-triggers", "compact-cold", "team", "checks"])
      expect(commands.some((command) => command.slash?.name === name)).toBe(false)
  } finally {
    await cleanup?.()
  }
})
