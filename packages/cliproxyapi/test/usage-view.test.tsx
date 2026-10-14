import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { PacerRpc, type PacerMeterEvent } from "opencode-pacer/rpc"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import { createRoot, createSignal } from "solid-js"
import { createUsage } from "../src/quota/usage-view.js"
import { UsageDefinition, type UsageInput, type UsageResult, type UsageSnapshot } from "../src/quota/usage.js"

type Layer = ReturnType<Parameters<Plugin.Context["keymap"]["layer"]>[0]>
const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
)

function snapshot(): UsageSnapshot {
  return {
    protocol: 1,
    view: "usage",
    now: Date.now() / 1000,
    max_age_seconds: 90,
    all: true,
    provider: "claude",
    providers: ["claude"],
    model: "claude-sonnet",
    current: "account-0",
    active: [],
    last_used: Date.now() / 1000,
    credentials: Array.from({ length: 10 }, (_, index) => ({
      id: `account-${index}`,
      alias: `Account ${index}`,
      provider: index ? "codex" : "claude",
      shared_with: [],
      windows: [
        {
          scope: "all",
          seconds: 18000,
          remaining: 61 - index,
          reset: Date.now() / 1000 + 3600,
          observed: Date.now() / 1000,
          held: false,
        },
      ],
    })),
  }
}

function fixture(options: { manual?: boolean; interval?: number; current?: string } = {}) {
  const [model, setModel] = createSignal({ providerID: "cliproxyapi", modelID: "claude-sonnet" })
  const [dialog, setDialog] = createSignal<() => JSX.Element>()
  const [status, setStatus] = createSignal<"idle" | "running">("idle")
  const [route, setRoute] = createSignal<{ type: "home" } | { type: "session"; sessionID: string }>({
    type: "session",
    sessionID: "ses_a",
  })
  const state = {
    slots: new Map<string, (input: { sessionID: string }) => JSX.Element>(),
    layers: [] as Layer[],
    reads: [] as { input: UsageInput; resolve: (result: UsageResult) => void; signal?: AbortSignal }[],
    listeners: new Set<(event: { data: PacerMeterEvent }) => void>(),
    result: {
      status: "ready",
      snapshot: { ...snapshot(), ...(options.current !== undefined ? { current: options.current } : {}) },
    } as UsageResult,
  }
  const color = RGBA.fromHex("#cccccc")
  const token = { base: color, selected: color, hovered: color }
  const context = {
    data: { session: { status } },
    theme: {
      text: {
        base: color,
        muted: color,
        formfield: token,
        action: { primary: token, secondary: token },
        feedback: { warning: token, error: token, success: token, info: token },
      },
      background: { raised: token },
      border: token,
      scrollbar: token,
    },
    client: {
      rpc: (definition: unknown) => {
        if (definition === PacerRpc)
          return {
            events: {
              on: (_name: string, listener: (event: { data: PacerMeterEvent }) => void) => {
                state.listeners.add(listener)
                return () => state.listeners.delete(listener)
              },
            },
          }
        expect(definition).toBe(UsageDefinition)
        return {
          read: (input: UsageInput, request?: { signal?: AbortSignal }) =>
            new Promise<UsageResult>((resolve) => {
              state.reads.push({ input, resolve, signal: request?.signal })
              if (!options.manual) resolve(state.result)
            }),
        }
      },
    },
    keymap: { layer: (factory: () => Layer) => state.layers.push(factory()), dispatch: () => {} },
    ui: {
      slot: (claim: { append: string; render: (input: { sessionID: string }) => JSX.Element }) => {
        state.slots.set(claim.append, claim.render)
        return () => state.slots.delete(claim.append)
      },
      model: { current: model },
      router: { current: route },
      dialog: {
        show: (view: () => JSX.Element) => setDialog(() => view),
        clear: () => setDialog(undefined),
        set: () => {},
      },
      toast: { show: () => {} },
    },
  } as unknown as Plugin.Context
  cleanups.push(createUsage(context, { interval: options.interval ?? 60000 }))
  createRoot((dispose) => {
    state.slots.get("app")!({ sessionID: "" })
    cleanups.push(dispose)
  })
  const command = (id: string) =>
    state.layers.flatMap((layer) => layer.commands ?? []).findLast((command) => command.id === id)!
  return { state, context, dialog, setModel, setRoute, setStatus, command }
}

async function mount(f: ReturnType<typeof fixture>, width = 80, height = 24) {
  const output = await createTestRenderer({ width, height })
  render(
    () => (
      <box>
        <box width={37}>{f.state.slots.get("sidebar.content")!({ sessionID: "ses_a" })}</box>
        {f.dialog()?.()}
      </box>
    ),
    output.renderer,
  )
  cleanups.push(() => output.renderer.destroy())
  return output
}

async function frame(output: Awaited<ReturnType<typeof createTestRenderer>>) {
  await Bun.sleep(10)
  await output.renderOnce()
  return output.captureCharFrame()
}

test("live IN USE replaces LAST USED, and NEXT USE remains an independent expiring marker", async () => {
  const f = fixture()
  f.setStatus("running")
  f.state.result = {
    status: "ready",
    snapshot: {
      ...snapshot(),
      active: ["account-0"],
      providers: ["claude", "codex"],
      next_use: {
        v: 1,
        at_ms: Date.now(),
        expires_ms: Date.now() + 30000,
        model: "claude-sonnet",
        provider: "codex",
        auth: "account-1",
        mode: "dry-run",
        reason: "cold_move",
        forced: false,
      },
    },
  }
  const output = await mount(f)
  let text = await frame(output)
  expect(text).toContain("IN USE")
  expect(text).not.toContain("LAST USED")
  expect(text).toContain("NEXT USE")
  f.setStatus("idle")
  text = await frame(output)
  expect(text).not.toContain("IN USE")
  expect(text).toContain("LAST USED")
})

test("FORCE USE marks where a forced move sends the chat and wins over NEXT USE; the chat's own credential has none", async () => {
  const f = fixture()
  const preview = (next: Partial<NonNullable<UsageSnapshot["next_use"]>>) => {
    f.state.result = {
      status: "ready",
      snapshot: {
        ...snapshot(),
        providers: ["claude", "codex"],
        next_use: {
          v: 1,
          at_ms: Date.now(),
          expires_ms: Date.now() + 30000,
          model: "claude-sonnet",
          provider: "codex",
          mode: "active",
          reason: "cold_move",
          forced: false,
          ...next,
        },
      },
    }
  }
  preview({ auth: "account-1", warm: true, force_auth: "account-2", force_reason: "soon" })
  const output = await mount(f, 80, 40)
  let lines = (await frame(output)).split("\n")
  expect(lines.find((line) => line.includes("Account 1"))).toContain("NEXT USE")
  expect(lines.find((line) => line.includes("Account 2"))).toContain("FORCE USE")
  preview({ auth: "account-2", force_auth: "account-2", force_reason: "now", reason: "forced_move", forced: true })
  f.setModel({ providerID: "cliproxyapi", modelID: "claude-sonnet-x" })
  f.setModel({ providerID: "cliproxyapi", modelID: "claude-sonnet" })
  lines = (await frame(output)).split("\n")
  expect(lines.find((line) => line.includes("Account 2"))).toContain("FORCE USE")
  expect(lines.join("\n")).not.toContain("NEXT USE")
})

test("sidebar only shows the selected model's providers, never unrelated credentials", async () => {
  const f = fixture()
  const output = await mount(f)
  const text = await frame(output)
  expect(text).toContain("Account 0")
  expect(text).toContain("61%")
  expect(text).not.toContain("Account 1")
  expect(text.split("\n").filter((line) => line.trim()).length).toBeLessThanOrEqual(3)
  expect([...f.state.slots.keys()]).toEqual(["sidebar.content", "app"])
})

test("selecting a model populates the sidebar before any request", async () => {
  const f = fixture({ current: "" })
  const text = await frame(await mount(f))
  expect(text).toContain("Account 0")
  expect(text).toContain("61%")
  expect(text).not.toContain("Account 1")
})

test("provider credentials survive response completion and follow a model change", async () => {
  const f = fixture({ current: "" })
  const output = await mount(f)
  expect(await frame(output)).toContain("Account 0")
  const now = Date.now()
  const data: PacerMeterEvent = {
    snapshot: {
      v: 1,
      served: {},
      credentials: [
        {
          id: "account-0",
          alias: "Account 0",
          provider: "claude",
          shared_with: [],
          at_ms: now,
          windows: [
            {
              scope: "all",
              seconds: 18000,
              left: 37,
              reset_ms: now + 3600000,
              read_ms: now,
              state: "current",
              applies: true,
            },
          ],
        },
      ],
    },
  }
  f.state.listeners.forEach((listener) => listener({ data }))
  const completed = await frame(output)
  expect(completed).toContain("Account 0")
  expect(completed).toContain("37%")
  f.state.result = {
    status: "ready",
    snapshot: { ...snapshot(), provider: "codex", providers: ["codex"], current: "" },
  }
  f.setModel({ providerID: "cliproxyapi", modelID: "gpt-5" })
  const changed = await frame(output)
  expect(changed).toContain("Account 1")
  expect(changed).not.toContain("Account 0")
})

test("usage opens a bounded popup with pages, and closing it keeps the sidebar compact", async () => {
  const f = fixture()
  const output = await mount(f)
  await frame(output)
  await f.command("plus.usage.open").run("--all")
  const text = await frame(output)
  expect(text).toContain("Credential usage")
  expect(text).toContain("All credentials")
  expect(text).toContain("1/3")
  expect(text).toContain("Account 3")
  expect(text).not.toContain("Account 4")
  await f.command("plus.usage.next").run()
  const next = await frame(output)
  expect(next).toContain("2/3")
  expect(next).toContain("Account 4")
  await f.command("plus.usage.close").run()
  const closed = await frame(output)
  expect(closed).toContain("Account 0")
  expect(closed).not.toContain("Account 4")
  expect(closed).not.toContain("Credential usage")
  expect(f.state.reads.at(-1)?.input.all).toBe(false)
})

test("usage opens a popup on the home screen too", async () => {
  const f = fixture()
  f.setRoute({ type: "home" })
  const output = await mount(f, 120, 42)
  await f.command("plus.usage.open").run("--all")
  expect(await frame(output)).toContain("Credential usage")
})

test.each([14, 24])("Antigravity quota windows stay paired by model in a %i-row popup", async (height) => {
  const f = fixture({ current: "" })
  const base = snapshot()
  f.state.result = {
    status: "ready",
    snapshot: {
      ...base,
      current: "",
      credentials: [
        {
          ...base.credentials[0]!,
          provider: "antigravity",
          windows: [
            { ...base.credentials[0]!.windows[0]!, scope: "gemini", seconds: 604800 },
            { ...base.credentials[0]!.windows[0]!, scope: "claude_gpt", seconds: 18000 },
            { ...base.credentials[0]!.windows[0]!, scope: "gemini", seconds: 18000 },
            { ...base.credentials[0]!.windows[0]!, scope: "claude_gpt", seconds: 604800 },
          ],
        },
      ],
    },
  }
  const output = await mount(f, 80, height)
  await f.command("plus.usage.open").run("--all")
  const first = await frame(output)
  expect(first.indexOf("5h claude_gpt")).toBeGreaterThan(-1)
  expect(first.indexOf("7d claude_gpt")).toBeGreaterThan(first.indexOf("5h claude_gpt"))
  if (height === 14) {
    expect(first).not.toContain("gemini")
    await f.command("plus.usage.next").run()
  }
  const next = await frame(output)
  expect(next.indexOf("5h gemini")).toBeGreaterThan(-1)
  expect(next.indexOf("7d gemini")).toBeGreaterThan(next.indexOf("5h gemini"))
  if (height === 24) expect(next.indexOf("5h gemini")).toBeGreaterThan(next.indexOf("7d claude_gpt"))
})

test("pushed percentages render without another RPC and survive an older pending read", async () => {
  const f = fixture({ manual: true })
  const output = await mount(f)
  await frame(output)
  const now = Date.now()
  const data: PacerMeterEvent = {
    snapshot: {
      v: 1,
      served: { ses_a: { auth: "account", at_ms: now } },
      credentials: [
        {
          id: "account",
          alias: "Live account",
          provider: "claude",
          shared_with: [],
          at_ms: now,
          windows: [
            {
              scope: "all",
              seconds: 18000,
              left: 37,
              reset_ms: now + 3600000,
              read_ms: now - 1800000,
              state: "current",
              applies: true,
            },
          ],
        },
      ],
    },
  }
  f.state.listeners.forEach((listener) => listener({ data }))
  expect(await frame(output)).toContain("37%")
  expect(await frame(output)).not.toContain("STALE")
  f.state.reads[0]!.resolve(f.state.result)
  expect(await frame(output)).toContain("37%")
  expect(f.state.reads).toHaveLength(1)
  output.renderer.destroy()
  expect(f.state.listeners.size).toBe(0)
})

test("changing models aborts and discards an older selection's read", async () => {
  const f = fixture({ manual: true })
  const output = await mount(f)
  await frame(output)
  const first = f.state.reads[0]!
  f.setModel({ providerID: "cliproxyapi", modelID: "deepseek-flash" })
  await frame(output)
  expect(first.signal?.aborted).toBe(true)
  first.resolve(f.state.result)
  expect(await frame(output)).not.toContain("Account 0")
})
