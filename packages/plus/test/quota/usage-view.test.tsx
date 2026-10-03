import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import { createRoot, createSignal } from "solid-js"
import { createUsage } from "../../src/quota/usage-view.js"
import { UsageDefinition, type UsageInput, type UsageResult, type UsageSnapshot } from "../../src/quota/usage.js"

type Layer = ReturnType<Parameters<Plugin.Context["keymap"]["layer"]>[0]>
type Claim = { placement: string; target: string; render: (input: { sessionID: string }) => JSX.Element }
type Read = { input: UsageInput; resolve: (value: UsageResult) => void; signal?: AbortSignal }

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
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
        shared_with: ["Claude B copy"],
        windows: [
          { scope: "all", seconds: 18000, remaining: 61, reset: 103600, observed: 99999, held: false },
          { scope: "all", seconds: 604800, remaining: 12.5, reset: 200000, observed: 99000, held: false },
        ],
      },
    ],
    ...overrides,
  }
}

/** Real createUsage against a host double: slots, router, model, keymap and a manual RPC. */
function fixture(options: { manual?: boolean; interval?: number } = {}) {
  const [route, setRoute] = createSignal<{ type: "home" } | { type: "session"; sessionID: string }>({
    type: "session",
    sessionID: "ses_a",
  })
  const [model, setModel] = createSignal<{ providerID: string; modelID: string } | undefined>({
    providerID: "proxy",
    modelID: "claude-sonnet",
  })
  const state = {
    claims: [] as Claim[],
    layers: [] as Layer[],
    reads: [] as Read[],
    toasts: [] as string[],
    dialogs: 0,
    result: { status: "ready", snapshot: snapshot() } as UsageResult,
  }
  const color = (hex: string) => RGBA.fromHex(hex)
  const stateful = (hex: string) => ({ base: color(hex), selected: color(hex), hovered: color(hex) })
  const context = {
    theme: {
      text: {
        base: color("#eeeeee"),
        muted: color("#888888"),
        formfield: stateful("#00aaff"),
        action: { primary: stateful("#ffaa00"), secondary: stateful("#aaaaaa") },
        feedback: {
          warning: { base: color("#ffff00") },
          error: { base: color("#ff0000") },
          success: { base: color("#00ff00") },
          info: { base: color("#0000ff") },
        },
      },
      background: { raised: { base: color("#111111") } },
      border: { base: color("#333333") },
      scrollbar: { base: color("#444444") },
    },
    client: {
      rpc: (definition: unknown) => {
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
    keymap: { layer: (factory: () => Layer) => state.layers.push(factory()) },
    ui: {
      slot: (claim: Record<string, unknown>) => {
        const placement = ["append", "prepend", "before", "after", "replace"].find((key) => claim[key] !== undefined)!
        const entry = { placement, target: claim[placement] as string, render: claim.render as Claim["render"] }
        state.claims.push(entry)
        return () => state.claims.splice(state.claims.indexOf(entry), 1)
      },
      model: { current: model },
      router: { current: route },
      dialog: {
        show: () => state.dialogs++,
        set: () => undefined,
      },
      toast: { show: (value: { message: string }) => state.toasts.push(value.message) },
    },
  } as unknown as Plugin.Context
  const release = createUsage(context, { interval: options.interval ?? 60_000 })
  cleanups.push(release)
  const claim = (target: string) => state.claims.find((item) => item.target === target)!
  const command = (id: string) => {
    const layer = state.layers.at(-1)!
    return layer.commands!.find((item) => item.id === id)!
  }
  return { state, context, setRoute, setModel, claim, command }
}

async function mount(view: () => JSX.Element, width: number, height = 40) {
  const output = await createTestRenderer({ width, height })
  render(view, output.renderer)
  cleanups.push(() => output.renderer.destroy())
  return output
}

async function frame(output: Awaited<ReturnType<typeof createTestRenderer>>, wait = 10) {
  await Bun.sleep(wait)
  await output.renderOnce()
  return output.captureCharFrame()
}

/** Commands are registered by the app slot inside a reactive owner, like the host does. */
function registerCommands(f: ReturnType<typeof fixture>) {
  createRoot((dispose) => {
    f.claim("app").render({ sessionID: "" })
    cleanups.push(dispose)
  })
}

test("sidebar section shows exact identity, shared quota and aligned bars inside the 42-column sidebar", async () => {
  const f = fixture()
  // Sidebar content width: 42 columns minus padding 2+2 and the scrollbar column.
  const output = await mount(
    () => <box width={37}>{f.claim("sidebar.content").render({ sessionID: "ses_a" })}</box>,
    60,
  )
  const text = await frame(output)
  expect(text).toContain("Usage")
  expect(text).toContain("● model")
  expect(text).toContain("○ all")
  expect(text).toContain("proxy/claude-sonnet")
  expect(text).toContain("Claude B")
  expect(text).toContain("IN USE")
  expect(text).toContain("claude · dummy-b")
  expect(text).toContain("Shared quota with Claude B copy")
  const rows = text
    .split("\n")
    .filter((line) => line.includes("█") || line.includes("░"))
    .map((line) => line.trimEnd())
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatch(/^┃ 5h █+░+  61% {3}1h 0m$/)
  expect(rows[1]).toMatch(/^┃ 7d █+░+  12% {3}STALE$/)
  // Bars and percentages share columns, and nothing escapes the sidebar.
  expect(rows[0]!.indexOf("%")).toBe(rows[1]!.indexOf("%"))
  expect(Math.max(...text.split("\n").map((line) => line.trimEnd().length))).toBeLessThanOrEqual(37)
  expect(f.state.reads.map((read) => read.input)).toEqual([
    { sessionID: "ses_a", providerID: "proxy", modelID: "claude-sonnet", all: false },
  ])
  expect(f.state.dialogs).toBe(0)
})

test("open view refreshes by itself with one shared loop, and disposal stops it", async () => {
  const f = fixture({ interval: 40 })
  registerCommands(f)
  await f.command("plus.usage.open").run("")
  // Sidebar hidden for this chat, so /usage opens the inline panel; both views share one loop.
  const output = await mount(
    () => (
      <box>
        {f.claim("session.composer.top").render({ sessionID: "ses_a" })}
        <box width={37}>{f.claim("sidebar.content").render({ sessionID: "ses_other" })}</box>
      </box>
    ),
    80,
  )
  expect(await frame(output)).toContain("61%")
  f.state.result = {
    status: "ready",
    snapshot: snapshot({
      credentials: [
        { ...snapshot().credentials[0]!, windows: [{ ...snapshot().credentials[0]!.windows[0]!, remaining: 7 }] },
      ],
    }),
  }
  const before = f.state.reads.length
  await Bun.sleep(130)
  const reads = f.state.reads.length - before
  // About three ticks; two independent loops would double this.
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(reads).toBeLessThanOrEqual(4)
  const updated = await frame(output)
  expect(updated).toContain("7%")
  expect(updated).not.toContain("61%")
  output.renderer.destroy()
  const count = f.state.reads.length
  await Bun.sleep(150)
  expect(f.state.reads).toHaveLength(count)
})

test("late responses from an old model or chat are discarded and their request is aborted", async () => {
  const f = fixture({ manual: true })
  const output = await mount(
    () => <box width={37}>{f.claim("sidebar.content").render({ sessionID: "ses_a" })}</box>,
    60,
  )
  await frame(output)
  const first = f.state.reads[0]!
  f.setModel({ providerID: "proxy", modelID: "codex" })
  await frame(output)
  const second = f.state.reads[1]!
  expect(second.input.modelID).toBe("codex")
  expect(first.signal?.aborted).toBe(true)
  first.resolve({
    status: "ready",
    snapshot: snapshot({ credentials: [{ ...snapshot().credentials[0]!, alias: "Stale chat" }] }),
  })
  expect(await frame(output)).not.toContain("Stale chat")
  expect(await frame(output)).toContain("Loading credential quotas")
  second.resolve({
    status: "ready",
    snapshot: snapshot({ credentials: [{ ...snapshot().credentials[0]!, alias: "Codex A" }] }),
  })
  const text = await frame(output)
  expect(text).toContain("Codex A")
  expect(text).not.toContain("Stale chat")
  f.setRoute({ type: "session", sessionID: "ses_b" })
  await frame(output)
  expect(f.state.reads.at(-1)?.input.sessionID).toBe("ses_b")
  // A different chat starts empty rather than showing ses_a's IN USE credential.
  expect(await frame(output)).not.toContain("Codex A")
})

test("transient failures keep the last reading with a retry note, then recover", async () => {
  const f = fixture({ interval: 40 })
  const output = await mount(
    () => <box width={37}>{f.claim("sidebar.content").render({ sessionID: "ses_a" })}</box>,
    60,
  )
  expect(await frame(output)).toContain("61%")
  f.state.result = {
    status: "unavailable",
    message: "The CPA quota bridge could not be reached; usage retries automatically.",
  }
  const failed = await frame(output, 80)
  expect(failed).toContain("61%")
  expect(failed).toContain("retrying")
  expect(failed).toContain("Showing the last reading")
  f.state.result = { status: "ready", snapshot: snapshot() }
  const recovered = await frame(output, 80)
  expect(recovered).not.toContain("retrying")
  expect(recovered).not.toContain("Showing the last reading")
})

test("fresh chat falls back to all credentials without claiming any credential is in use", async () => {
  const f = fixture({ interval: 40 })
  f.state.result = { status: "ready", snapshot: snapshot({ all: true, current: "", active: [] }) }
  const output = await mount(
    () => <box width={37}>{f.claim("sidebar.content").render({ sessionID: "ses_a" })}</box>,
    60,
  )
  const text = await frame(output)
  expect(text).toContain("All credentials · no request from")
  expect(text).not.toContain("IN USE")
  expect(text).not.toContain("LAST USED")
  // A chat that has made requests but that CPA has not bound says so instead.
  f.state.result = {
    status: "ready",
    snapshot: snapshot({ all: true, current: "", active: [] }),
    fallback: "untracked",
  }
  await Bun.sleep(100)
  const untracked = await frame(output)
  expect(untracked).toContain("CPA is not tracking")
  expect(untracked).not.toContain("no request from")
  expect(untracked).not.toContain("IN USE")
  f.state.result = { status: "ready", snapshot: snapshot({ active: [] }) }
})

test("missing, dormant and reset windows are labelled; not-applicable windows are hidden", async () => {
  const f = fixture()
  const window = snapshot().credentials[0]!.windows[0]!
  f.state.result = {
    status: "ready",
    snapshot: snapshot({
      active: [],
      current: "unused",
      credentials: [
        { id: "new", alias: "New", provider: "codex", shared_with: [], windows: [] },
        {
          id: "uncapped",
          alias: "Uncapped",
          provider: "claude",
          shared_with: [],
          windows: [{ ...window, seconds: 604800, scope: "opus", reset: 0, not_applicable: true }],
        },
        {
          id: "unused",
          alias: "Unused",
          provider: "codex",
          shared_with: [],
          windows: [
            { ...window, remaining: 100, reset: 0, dormant: true },
            { ...window, seconds: 604800, reset: 0, not_applicable: true },
            { ...window, seconds: 2592000, scope: "oauth_apps", reset: 99000 },
          ],
        },
      ],
    }),
  }
  const output = await mount(
    () => <box width={37}>{f.claim("sidebar.content").render({ sessionID: "ses_a" })}</box>,
    60,
  )
  const text = await frame(output)
  expect(text).toContain("No quota reading yet.")
  expect(text).toContain("dormant")
  // Provider-reported "not applicable" windows (e.g. no separate weekly Opus cap) carry no capacity.
  expect(text).not.toContain("no limit")
  expect(text).not.toContain("opus")
  expect(text).toContain("No limited quota windows.")
  expect(text).toContain("oauth_apps")
  expect(text.split("\n").map((line) => line.trimEnd())).toContainEqual(
    expect.stringMatching(/30d █+░+  61% {3}reset$/),
  )
  expect(text).toContain("LAST USED")
  expect(text).not.toContain("IN USE")
})

test("/usage reveals a visible sidebar, otherwise opens the inline panel; --all and bad input", async () => {
  const f = fixture()
  registerCommands(f)
  expect(f.command("plus.usage.open").slash).toEqual({ name: "usage", arguments: true })
  expect(f.state.layers.at(-1)!.commands!.every((command) => command.group === "OpenCodePlus")).toBe(true)
  await f.command("plus.usage.open").run("--bogus")
  expect(f.state.toasts).toEqual(["Usage: /usage [--all]"])
  const inline = await mount(() => <box>{f.claim("session.composer.top").render({ sessionID: "ses_a" })}</box>, 80, 24)
  expect((await frame(inline)).trim()).toBe("")
  await f.command("plus.usage.open").run("--all")
  const opened = await frame(inline)
  expect(opened).toContain("▼ Usage")
  expect(opened).toContain("● all")
  expect(f.state.reads.at(-1)?.input.all).toBe(true)
  // Opening the sidebar for this chat moves usage there and hides the inline copy.
  const sidebar = await mount(
    () => <box width={37}>{f.claim("sidebar.content").render({ sessionID: "ses_a" })}</box>,
    60,
  )
  await frame(sidebar)
  expect((await frame(inline)).trim()).toBe("")
  await f.command("plus.usage.open").run("")
  expect(f.state.reads.at(-1)?.input.all).toBe(false)
  expect((await frame(inline)).trim()).toBe("")
  expect(f.state.dialogs).toBe(0)
})

test("inline panel keeps a fixed height across loading and refresh, collapses and closes", async () => {
  const f = fixture({ manual: true })
  registerCommands(f)
  await f.command("plus.usage.open").run("")
  let height = 0
  const output = await mount(
    () => (
      <box
        onSizeChange={function () {
          height = this.height
        }}
      >
        {f.claim("session.composer.top").render({ sessionID: "ses_a" })}
      </box>
    ),
    80,
    24,
  )
  expect(await frame(output)).toContain("Loading credential quotas")
  const loading = height
  expect(loading).toBe(9)
  f.state.reads[0]!.resolve({ status: "ready", snapshot: snapshot() })
  expect(await frame(output)).toContain("61%")
  expect(height).toBe(loading)
  f.command("plus.usage.collapse").run()
  const collapsed = await frame(output)
  expect(height).toBe(1)
  expect(collapsed).toContain("▶ Usage")
  expect(collapsed).toContain("Claude B IN USE  5h 61% · 7d 12%")
  f.command("plus.usage.close").run()
  expect((await frame(output)).trim()).toBe("")
})

test("home screen /usage works before a chat exists, without a model request", async () => {
  const f = fixture()
  f.setRoute({ type: "home" })
  f.state.result = { status: "ready", snapshot: snapshot({ all: true, current: "", active: [] }) }
  registerCommands(f)
  await f.command("plus.usage.open").run("")
  const claim = f.claim("home.footer")
  expect(claim.placement).toBe("before")
  const output = await mount(() => <box>{claim.render({ sessionID: "" })}</box>, 100, 30)
  const text = await frame(output)
  expect(text).toContain("All credentials · no request from this chat yet")
  expect(f.state.reads[0]!.input).toEqual({
    sessionID: undefined,
    providerID: "proxy",
    modelID: "claude-sonnet",
    all: false,
  })
  f.setModel(undefined)
  expect(await frame(output)).toContain("Select a model to view credential usage.")
})

test("details show exact resets, full window names and the identity note", async () => {
  const f = fixture()
  registerCommands(f)
  f.command("plus.usage.details").run()
  const output = await mount(
    () => <box width={37}>{f.claim("sidebar.content").render({ sessionID: "ses_a" })}</box>,
    60,
  )
  const text = await frame(output)
  expect(text).toContain("5 hours · 61% left · resets")
  expect(text).toContain("7 days · 12.5% left · resets")
  expect(text).toContain("IN USE: CPA confirmed")
  expect(text).toContain("● details")
})
