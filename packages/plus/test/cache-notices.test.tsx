import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { createCacheNotices } from "../src/tui/cache-notices.js"
import type { Plus } from "../src/rpc.js"
import { sleep } from "./instructions-nav.js"
import { renderPlusFixture } from "./tui.js"

const NOW = Date.now()

const notice = (requestID: string, rootID: string, overrides: Partial<Plus.MonitorNotice> = {}): Plus.MonitorNotice => ({
  requestID,
  sessionID: `ses_${requestID}`,
  rootID,
  title: `Subagent ${requestID}`,
  agent: "general",
  model: "claude-opus-5-5",
  verdict: "partial",
  missTokens: 352_607,
  causeText: "Sent content changed: messages[352].content",
  at: NOW - 4 * 60_000,
  ...overrides,
})

type Setting = Parameters<Plugin.Context["ui"]["settings"]["register"]>[0]

async function render(options: {
  notices: Plus.MonitorNotice[]
  dismiss?: Plus.PlusSettings["noticeDismiss"]
  route?: unknown
  storage?: Map<string, unknown>
  selects?: unknown[]
}) {
  const opened: Plus.MonitorNotice[] = []
  const dismissed: string[] = []
  const writes: Plus.PlusSettingsInput[] = []
  const settings: Setting[] = []
  const server: Plus.PlusSettings = {
    coldCompact: false,
    noticeMinutes: 15,
    noticeMinTokens: 0,
    noticeKinds: "misses-and-partials",
    noticeDismiss: options.dismiss ?? "everywhere",
  }
  const notices = { list: options.notices }
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 140,
    height: 30,
    route: options.route ?? { type: "session", sessionID: "ses_chat" },
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.selects === undefined ? {} : { dialogs: { selects: options.selects } }),
    rpc: {
      "monitor.notices": async () => ({ notices: notices.list.filter((entry) => !dismissed.includes(entry.requestID)) }),
      "monitor.dismiss": async (input: Plus.MonitorDismissInput) => {
        dismissed.push(input.requestID)
      },
      "settings.get": async () => ({ ...server }),
      "settings.set": async (input: Plus.PlusSettingsInput) => {
        writes.push(input)
        Object.assign(server, input)
        return { ...server }
      },
    },
    render: (context) => {
      // The fixture renders no slots and keeps no Settings rows; collect them here.
      const claims: ((input: never) => JSX.Element)[] = []
      const wrapped = {
        ...context,
        data: {
          ...context.data,
          on: () => () => {},
          session: { ...context.data.session, get: (id: string) => (id === "ses_child" ? { id, parentID: "ses_chat" } : undefined) },
        },
        ui: {
          ...context.ui,
          slot: (claim: { render: (input: never) => JSX.Element }) => {
            claims.push(claim.render)
            return () => {}
          },
          settings: {
            register: (setting: Setting) => {
              settings.push(setting)
              return () => {}
            },
          },
        },
      } as unknown as Plugin.Context
      createCacheNotices(wrapped, { open: (entry) => opened.push(entry) })
      return <box flexDirection="column">{claims.map((claim) => claim({} as never))}</box>
    },
  })
  return { fixture, opened, dismissed, writes, settings, notices }
}

test("every session's notices stack in the corner; opening one shows it in the monitor and removes it from every TUI", async () => {
  const { fixture, opened, dismissed } = await render({
    notices: [
      notice("newest", "ses_other", { verdict: "miss", missTokens: 470_325, title: "Round 2: scene authoring kit" }),
      notice("older", "ses_chat", { title: "Round 2: scene visuals" }),
    ],
  })
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("scene visuals"))
    expect(frame).toContain("Cache miss · 470k tokens not reused")
    expect(frame).toContain("Partial cache reuse · 353k tokens not reused")
    expect(frame).toContain("4 min ago")
    expect(frame).toContain("Round 2: scene authoring kit · general · claude-opus-5-5")
    expect(frame).toContain("Sent content changed: messages[352].content")
    // Newest on top.
    expect(frame.indexOf("scene authoring kit")).toBeLessThan(frame.indexOf("scene visuals"))

    const lines = frame.split("\n")
    expect(lines.find((line) => line.includes("Cache miss"))).toContain("×")
    expect(lines.find((line) => line.includes("Partial cache reuse"))).toContain("×")
    const row = lines.findIndex((line) => line.includes("scene visuals"))
    await fixture.mockMouse.click(lines[row]!.indexOf("scene visuals"), row)
    await sleep(50)
    expect(opened.map((entry) => entry.requestID)).toEqual(["older"])
    expect(dismissed).toEqual(["older"])
    const after = await fixture.waitForFrame((text) => !text.includes("scene visuals"))
    // The other notice stays.
    expect(after).toContain("scene authoring kit")
  } finally {
    fixture.destroy()
  }
})

test("× dismisses a notice in every TUI without opening the monitor; the body of the notice still opens it", async () => {
  const { fixture, opened, dismissed } = await render({
    notices: [notice("newest", "ses_other", { verdict: "miss", title: "Round 2: scene authoring kit" }), notice("older", "ses_chat", { title: "Round 2: scene visuals" })],
  })
  try {
    const frame = await fixture.waitForFrame((text) => text.includes("scene visuals"))
    const lines = frame.split("\n")
    const row = lines.findIndex((line) => line.includes("Partial cache reuse"))
    await fixture.mockMouse.click(lines[row]!.indexOf("×"), row)
    await sleep(50)
    expect(opened).toEqual([])
    expect(dismissed).toEqual(["older"])
    const after = await fixture.waitForFrame((text) => !text.includes("scene visuals"))
    expect(after).toContain("scene authoring kit")

    const rest = after.split("\n")
    const body = rest.findIndex((line) => line.includes("scene authoring kit"))
    await fixture.mockMouse.click(rest[body]!.indexOf("scene authoring kit"), body)
    await sleep(50)
    expect(opened.map((entry) => entry.requestID)).toEqual(["newest"])
  } finally {
    fixture.destroy()
  }
})

test("× with dismissal kept per TUI keeps the dismissal on this TUI and does not open the monitor", async () => {
  const storage = new Map<string, unknown>()
  const { fixture, opened, dismissed } = await render({
    dismiss: "this-tui",
    storage,
    notices: [notice("theirs", "ses_other", { title: "Their subagent" })],
  })
  try {
    // The server's dismissal mode arrives with the first settings read.
    await sleep(50)
    const frame = await fixture.waitForFrame((text) => text.includes("Their subagent"))
    const lines = frame.split("\n")
    const row = lines.findIndex((line) => line.includes("Their subagent")) - 1
    await fixture.mockMouse.click(lines[row]!.indexOf("×"), row)
    await fixture.waitForFrame((text) => !text.includes("Their subagent"))
    await sleep(50)
    expect(opened).toEqual([])
    expect(dismissed).toEqual([])
    expect(Object.keys((storage.get("opencode.plus.miss-notices") as { dismissed: Record<string, number> }).dismissed)).toEqual(["theirs"])
  } finally {
    fixture.destroy()
  }
})

test("with dismissal kept per TUI, an opened notice stays on the server; the chat filter and the switch hide notices", async () => {
  const storage = new Map<string, unknown>()
  const { fixture, opened, dismissed, settings } = await render({
    dismiss: "this-tui",
    storage,
    selects: ["chat"],
    notices: [notice("mine", "ses_chat", { title: "My subagent" }), notice("theirs", "ses_other", { title: "Their subagent" })],
  })
  try {
    // The server's dismissal mode arrives with the first settings read.
    await sleep(50)
    const frame = await fixture.waitForFrame((text) => text.includes("Their subagent"))
    const lines = frame.split("\n")
    const row = lines.findIndex((line) => line.includes("Their subagent"))
    await fixture.mockMouse.click(lines[row]!.indexOf("Their subagent"), row)
    await fixture.waitForFrame((text) => !text.includes("Their subagent"))
    expect(opened.map((entry) => entry.requestID)).toEqual(["theirs"])
    expect(dismissed).toEqual([])
    expect(Object.keys((storage.get("opencode.plus.miss-notices") as { dismissed: Record<string, number> }).dismissed)).toEqual(["theirs"])

    const row2 = (id: string) => settings.find((setting) => setting.id === id)!
    expect(row2("plus.notices.from").value?.()).toBe("every session on this server")
    await row2("plus.notices.from").run()
    expect(row2("plus.notices.from").value?.()).toBe("this chat and its subagents")
    expect(await fixture.waitForFrame((text) => text.includes("My subagent"))).not.toContain("Their subagent")

    await row2("plus.miss-notices").run()
    expect(row2("plus.miss-notices").value?.()).toBe("off")
    await fixture.waitForFrame((text) => !text.includes("My subagent"))
  } finally {
    fixture.destroy()
  }
})

test("the server-wide notice settings are Settings rows that write the server's settings", async () => {
  const { fixture, settings, writes } = await render({ notices: [], selects: [60, 10_000, "misses", "this-tui"] })
  try {
    await sleep(50)
    const row = (id: string) => settings.find((setting) => setting.id === id)!
    expect(settings.map((setting) => [setting.id, setting.title, setting.category])).toEqual([
      ["plus.miss-notices", "Cache notices", "OpenCodePlus"],
      ["plus.notices.from", "Cache notices from", "OpenCodePlus"],
      ["plus.notices.minutes", "Cache notice lifetime", "OpenCodePlus"],
      ["plus.notices.minimum", "Cache notice minimum", "OpenCodePlus"],
      ["plus.notices.kinds", "Cache notices for", "OpenCodePlus"],
      ["plus.notices.dismiss", "Opened cache notice disappears", "OpenCodePlus"],
    ])
    expect(row("plus.notices.minutes").value?.()).toBe("15 minutes")
    expect(row("plus.notices.minimum").value?.()).toBe("any loss")
    await row("plus.notices.minutes").run()
    await row("plus.notices.minimum").run()
    await row("plus.notices.kinds").run()
    await row("plus.notices.dismiss").run()
    expect(writes).toEqual([{ noticeMinutes: 60 }, { noticeMinTokens: 10_000 }, { noticeKinds: "misses" }, { noticeDismiss: "this-tui" }])
    expect(row("plus.notices.minutes").value?.()).toBe("60 minutes")
    expect(row("plus.notices.minimum").value?.()).toBe("10k tokens")
    expect(row("plus.notices.kinds").value?.()).toBe("misses only")
    expect(row("plus.notices.dismiss").value?.()).toBe("only in this TUI")
  } finally {
    fixture.destroy()
  }
})
