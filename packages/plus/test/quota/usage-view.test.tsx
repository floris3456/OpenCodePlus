import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import { createRoot } from "solid-js"
import { createUsage, UsageView, usageArguments } from "../../src/quota/usage-view.js"
import { UsageDefinition, type UsageInput, type UsageResult } from "../../src/quota/usage.js"

type Layer = ReturnType<Parameters<Plugin.Context["keymap"]["layer"]>[0]>
const input: UsageInput = { sessionID: "ses_usage", providerID: "proxy", modelID: "claude-sonnet", all: false }
function fixture() {
  const state = {
    layers: [] as Layer[],
    reads: [] as UsageInput[],
    toasts: [] as string[],
    size: "medium",
    centered: false,
    selected: true,
    disposed: false,
    slot: undefined as (() => JSX.Element) | undefined,
    dialog: undefined as (() => JSX.Element) | undefined,
    result: {
      status: "ready",
      snapshot: {
        protocol: 1,
        view: "usage",
        now: 100000,
        max_age_seconds: 90,
        all: false,
        provider: "claude",
        model: "claude-sonnet",
        current: "dummy-b",
        active: ["dummy-b"],
        last_used: 99999,
        credentials: [
          {
            id: "dummy-b",
            alias: "Claude B",
            provider: "claude",
            shared_with: ["dummy-copy"],
            windows: [
              { scope: "all", seconds: 18000, remaining: 61, reset: 103600, observed: 99999, held: false },
              { scope: "all", seconds: 604800, remaining: 12.5, reset: 200000, observed: 99000, held: false },
            ],
          },
        ],
      },
    } as UsageResult,
  }
  const white = RGBA.fromHex("#ffffff")
  const context = {
    theme: {
      text: {
        base: white,
        muted: white,
        feedback: { warning: { base: white }, error: { base: white }, success: { base: white } },
      },
    },
    client: {
      rpc: (definition: unknown) => {
        expect(definition).toBe(UsageDefinition)
        return {
          read: async (next: UsageInput) => {
            state.reads.push(next)
            return state.result
          },
        }
      },
    },
    keymap: { layer: (factory: () => Layer) => state.layers.push(factory()) },
    ui: {
      slot: (options: { append: string; render(): JSX.Element }) => {
        expect(options.append).toBe("app")
        state.slot = options.render
        return () => {
          state.disposed = true
        }
      },
      model: { current: () => (state.selected ? { providerID: input.providerID, modelID: input.modelID } : undefined) },
      router: { current: () => ({ type: "session", sessionID: input.sessionID }) },
      dialog: {
        show: (view: () => JSX.Element) => {
          state.dialog = view
          state.size = "medium"
          state.centered = false
        },
        set: (options: { size: string; centered: boolean }) => {
          state.size = options.size
          state.centered = options.centered
        },
      },
      toast: { show: (options: { message: string }) => state.toasts.push(options.message) },
    },
  } as unknown as Plugin.Context
  return { state, context }
}

async function frame(output: Awaited<ReturnType<typeof createTestRenderer>>) {
  await new Promise((resolve) => setTimeout(resolve, 10))
  await output.renderOnce()
  return output.captureCharFrame()
}

test("production dialog renders actual credential, shared bars, reset and stale evidence", async () => {
  const f = fixture()
  const output = await createTestRenderer({ width: 100, height: 40 })
  try {
    render(() => <UsageView context={f.context} input={input} />, output.renderer)
    const text = await frame(output)
    expect(text).toContain("Claude B · claude  [IN USE]")
    expect(text).toContain("Credential: dummy-b")
    expect(text).toContain("Shares quota with: dummy-copy")
    expect(text).toContain("61% remaining")
    expect(text).toContain("12.5% remaining · STALE")
    expect(text).toContain("Resets in 1h")
    expect(text).toContain("█")
    expect(f.state.reads).toEqual([input])
    expect(f.state.layers[0]?.mode).toBe("modal")
    f.state.result = { status: "ready", snapshot: { ...f.state.result.snapshot!, active: [] } }
    await f.state.layers[0]!.commands!.find((command) => command.bind === "r")!.run()
    const idle = await frame(output)
    expect(idle).toContain("[LAST USED]")
    expect(idle).not.toContain("[IN USE]")
    await f.state.layers[0]!.commands!.find((command) => command.bind === "a")!.run()
    expect(await frame(output)).toContain("Credential usage · all")
    expect(f.state.reads.at(-1)?.all).toBe(true)
  } finally {
    output.renderer.destroy()
  }
})

test("narrow dialog handles missing, dormant and non-applicable quotas without invented resets", async () => {
  const f = fixture()
  const base = f.state.result.snapshot!
  const window = base.credentials[0]!.windows[0]!
  f.state.result = {
    status: "ready",
    snapshot: {
      ...base,
      active: [],
      current: "",
      credentials: [
        { id: "new", alias: "New", provider: "codex", shared_with: [], windows: [] },
        {
          id: "unused",
          alias: "Unused",
          provider: "codex",
          shared_with: [],
          windows: [
            { ...window, remaining: 100, reset: 0, dormant: true },
            { ...window, seconds: 604800, reset: 0, not_applicable: true },
          ],
        },
      ],
    },
  }
  const output = await createTestRenderer({ width: 54, height: 40 })
  try {
    render(() => <UsageView context={f.context} input={{ ...input, all: true }} />, output.renderer)
    const text = await frame(output)
    expect(text).toContain("No quota reading available.")
    expect(text).toContain("Window has not started")
    expect(text).toContain("Not applicable")
    expect(text).toContain("No limit for this window")
    expect(text).not.toContain("STALE")
    expect(text).not.toContain("[LAST USED]")
    expect(text).not.toContain("Resets in")
  } finally {
    output.renderer.destroy()
  }
})

test("slash registration carries --all and rejects unknown arguments before opening", async () => {
  const f = fixture()
  const release = createUsage(f.context)
  const dispose = createRoot((dispose) => {
    f.state.slot!()
    return dispose
  })
  const command = f.state.layers[0]!.commands![0]!
  expect(command.slash).toEqual({ name: "usage", arguments: true })
  expect(usageArguments(" --all ")).toBe(true)
  expect(usageArguments("")).toBe(false)
  expect(usageArguments("--all trailing")).toBeUndefined()
  await command.run("--unknown")
  expect(f.state.dialog).toBeUndefined()
  expect(f.state.toasts).toEqual(["Usage: /usage [--all]"])
  await command.run("--all")
  expect(f.state.size).toBe("large")
  expect(f.state.centered).toBe(true)
  const output = await createTestRenderer({ width: 100, height: 40 })
  try {
    render(f.state.dialog!, output.renderer)
    await frame(output)
    expect(f.state.reads).toEqual([{ ...input, all: true }])
  } finally {
    output.renderer.destroy()
    dispose()
    release()
  }
  expect(f.state.disposed).toBe(true)
})

test("disabled bridge guidance is displayed and closing stops polling", async () => {
  const f = fixture()
  f.state.result = { status: "disabled", message: "Configure the CPA quota bridge to view usage." }
  const output = await createTestRenderer({ width: 100, height: 24 })
  render(() => <UsageView context={f.context} input={input} />, output.renderer)
  expect(await frame(output)).toContain("Configure the CPA quota bridge")
  output.renderer.destroy()
  const count = f.state.reads.length
  await new Promise((resolve) => setTimeout(resolve, 5100))
  expect(f.state.reads).toHaveLength(count)
}, 10000)

test("all credential bars remain reachable by keyboard scrolling in a short terminal", async () => {
  const f = fixture()
  const base = f.state.result.snapshot!
  f.state.result = {
    status: "ready",
    snapshot: {
      ...base,
      all: true,
      credentials: Array.from({ length: 6 }, (_, index) => ({
        ...base.credentials[0]!,
        id: `dummy-${index}`,
        alias: `Account ${index}`,
      })),
    },
  }
  const output = await createTestRenderer({ width: 80, height: 24 })
  try {
    render(() => <UsageView context={f.context} input={{ ...input, all: true }} />, output.renderer)
    expect(await frame(output)).toContain("Account 0")
    for (let index = 0; index < 10; index++) output.mockInput.pressKey("\u001b[6~")
    expect(await frame(output)).toContain("Account 5")
  } finally {
    output.renderer.destroy()
  }
})
