import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { AttentionNotifyOptions } from "@opencode/plugin/tui/context"
import { DEFAULT_ATTENTION } from "../src/attention-settings.js"
import type { Plus } from "../src/rpc.js"
import { createAttention } from "../src/tui/attention.js"

type Setting = Parameters<Plugin.Context["ui"]["settings"]["register"]>[0]

function lab(options: { readonly route?: unknown; readonly tabs?: readonly string[]; readonly selects?: unknown[]; readonly prompts?: string[] } = {}) {
  const shown: AttentionNotifyOptions[] = []
  const writes: Plus.PlusSettingsInput[] = []
  const toasts: string[] = []
  const settings: Setting[] = []
  const handlers: ((event: { data: Plus.Attention }) => void)[] = []
  const server = { attention: DEFAULT_ATTENTION }
  const parents: Record<string, string> = { ses_sub: "ses_chat" }
  const context = {
    client: {
      rpc: () => ({
        "settings.get": async () => server,
        "settings.set": async (input: Plus.PlusSettingsInput) => {
          writes.push(input)
          return server
        },
        "attention.test": async (input: Plus.AttentionTestInput) => attention({ kind: input.kind, test: true, notify: true, sound: "yup-02" }),
        events: {
          on: (_name: string, handler: (event: { data: Plus.Attention }) => void) => {
            handlers.push(handler)
            return () => {}
          },
        },
      }),
    },
    ui: {
      router: { current: () => options.route ?? { type: "session", sessionID: "ses_sub" } },
      tabs: { enabled: () => options.tabs !== undefined, list: () => (options.tabs ?? []).map((sessionID) => ({ sessionID })) },
      settings: {
        register: (setting: Setting) => {
          settings.push(setting)
          return () => {}
        },
      },
      dialog: {
        select: async () => options.selects?.shift(),
        prompt: async () => options.prompts?.shift(),
        clear: () => {},
      },
      toast: { show: (toast: { message: string }) => toasts.push(toast.message) },
      format: { path: (value: string) => value },
    },
    data: { session: { get: (id: string) => (parents[id] === undefined ? { id } : { id, parentID: parents[id] }) } },
    attention: {
      notify: async (input: AttentionNotifyOptions) => {
        shown.push(input)
        return { ok: true, notification: true, sound: true }
      },
    },
  } as unknown as Plugin.Context
  const created = createAttention(context)
  return { created, shown, writes, toasts, settings, emit: (data: Plus.Attention) => handlers.forEach((handler) => handler({ data })) }
}

function attention(fields: Partial<Plus.Attention>): Plus.Attention {
  return {
    id: "evt",
    kind: "done",
    sessionID: "ses_chat",
    rootID: "ses_chat",
    depth: 0,
    title: "Fix the parser",
    message: "Done",
    notify: true,
    sound: "bip-bop-01",
    player: false,
    at: 1,
    ...fields,
  }
}

test("events of the open chat's tree show while unfocused; others and tests do not", () => {
  const tui = lab()
  tui.emit(attention({ id: "a" }))
  tui.emit(attention({ id: "b", sessionID: "ses_elsewhere", rootID: "ses_elsewhere" }))
  tui.emit(attention({ id: "c", test: true }))
  tui.emit(attention({ id: "d", kind: "question", sessionID: "ses_sub", depth: 1, notify: false, message: "Which branch?" }))
  expect(tui.shown).toEqual([
    { title: "Fix the parser", message: "Done", notification: { when: "blurred" }, sound: { file: "bip-bop-01", when: "always" } },
    { title: "Fix the parser", message: "Which branch?", notification: false, sound: { file: "bip-bop-01", when: "always" } },
  ])
  tui.created.dispose()
})

test("open tabs count; with a sound player connected the TUI leaves the sound to it", () => {
  const tui = lab({ route: { type: "home" }, tabs: ["ses_other"] })
  tui.emit(attention({ sessionID: "ses_other", rootID: "ses_other", player: true }))
  tui.emit(attention({ sessionID: "ses_chat" }))
  expect(tui.shown).toEqual([{ title: "Fix the parser", message: "Done", notification: { when: "blurred" }, sound: false }])
  tui.created.dispose()
})

test("Settings › Notifications edits the global settings: switches, sounds, a file, levels and a test", async () => {
  const tui = lab({ selects: ["nope-07", "\u0000file", 4, "child"], prompts: ["relative.wav"] })
  // The global settings arrive from the server first.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const run = (id: string) => tui.settings.find((setting) => setting.id === id)!.run()
  expect(tui.settings.map((setting) => setting.id)).toContain("plus.attention.cacheMiss.sound")
  await run("plus.attention.done.notify")
  await run("plus.attention.error.sound")
  await run("plus.attention.reply.sound")
  await run("plus.attention.child.depth")
  expect(tui.writes).toEqual([
    { attention: { done: { notify: false } } },
    { attention: { error: { sound: "nope-07" } } },
    { attention: { child: { depth: 4 } } },
  ])
  // A relative path is refused before it reaches the server.
  expect(tui.toasts[0]).toContain("absolute file path")
  await run("plus.attention.test")
  expect(tui.shown.at(-1)).toEqual({ title: "Fix the parser", message: "Done", notification: { when: "always" }, sound: { file: "yup-02", when: "always" } })
  tui.created.dispose()
})
