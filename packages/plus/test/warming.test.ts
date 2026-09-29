import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SessionWarming } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import {
  formatWarming,
  parseWarming,
  resolveModelWarming,
  setModelWarming,
  type ModelRecord,
} from "../src/instructions/model.js"
import { setModelWarmingRow } from "../src/instructions/ops.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"
import { warmingRowOf } from "../src/index.js"
import { createWarmingStore, decideWarming, WARMING_DEFAULTS } from "../src/warming.js"
import { formatRemaining, nextChatSwitch, warmingLabel } from "../src/tui/warming.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const MINUTE = 60_000
const configured = { prompt: "configured", interval: 2 * MINUTE, duration: 30 * MINUTE }

const record = (overrides: Partial<ModelRecord>): ModelRecord => ({
  type: "model",
  level: "project",
  agent: "alpha",
  providerID: "anthropic",
  modelID: "claude",
  updated: UPDATED,
  ...overrides,
})

const scopes = { global: new Set<string>(), defaults: new Set<string>() }
const claude = { providerID: "anthropic", modelID: "claude" }

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})
const tempFile = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plus-warming-"))
  temps.push(dir)
  return path.join(dir, "warming", "chats.json")
}

const event = (overrides: Partial<SessionWarming>): SessionWarming => ({
  sessionID: Session.ID.make("ses_warm"),
  agent: Agent.ID.make("alpha"),
  model: Model.Ref.make({ providerID: Provider.ID.make("anthropic"), id: Model.ID.make("claude") }),
  phase: "activity",
  since: 1_000_000,
  now: 1_000_000,
  settings: { ...configured },
  ...overrides,
})

test("warming values parse to off, on, or a total time between 1m and 24h", () => {
  expect(parseWarming("off")).toEqual({ on: false })
  expect(parseWarming(" On ")).toEqual({ on: true })
  expect(parseWarming("45m")).toEqual({ on: true, duration: 45 * MINUTE })
  expect(parseWarming("2h")).toEqual({ on: true, duration: 120 * MINUTE })
  expect(parseWarming("1h 30m")).toEqual({ on: true, duration: 90 * MINUTE })
  expect(formatWarming({ on: true, duration: 90 * MINUTE })).toBe("1h30m")
  expect(formatWarming({ on: true })).toBe("on")
  expect(formatWarming({ on: false })).toBe("off")
  // Refusals: not a time, below a minute, above a day.
  expect("error" in parseWarming("soon")).toBe(true)
  expect("error" in parseWarming("30s")).toBe(true)
  expect("error" in parseWarming("25h")).toBe(true)
  expect("error" in parseWarming("")).toBe(true)
})

test("the per-chat switch beats the model row, which beats the host configuration", () => {
  const twoHours = { on: true, duration: 120 * MINUTE } as const
  // Nothing set: core's proposal passes through untouched, including "off".
  expect(decideWarming({ configured, row: undefined, chat: undefined })).toEqual({ settings: configured, source: "config" })
  expect(decideWarming({ configured: undefined, row: undefined, chat: undefined })).toEqual({ settings: undefined, source: "config" })
  // The model row switches it off, or sets the total time over the configuration.
  expect(decideWarming({ configured, row: { on: false }, chat: undefined })).toEqual({ settings: undefined, source: "model" })
  expect(decideWarming({ configured, row: twoHours, chat: undefined }).settings).toEqual({ ...configured, duration: 120 * MINUTE })
  expect(decideWarming({ configured, row: { on: true }, chat: undefined }).settings).toEqual(configured)
  // A model row turns warming on where the configuration leaves it off, with core's defaults.
  expect(decideWarming({ configured: undefined, row: twoHours, chat: undefined }).settings).toEqual({
    ...WARMING_DEFAULTS,
    duration: 120 * MINUTE,
  })
  // The chat switch wins both ways and keeps the row's total time when on.
  expect(decideWarming({ configured, row: twoHours, chat: "off" })).toEqual({ settings: undefined, source: "chat" })
  expect(decideWarming({ configured, row: { on: false }, chat: "on" })).toEqual({ settings: configured, source: "chat" })
  expect(decideWarming({ configured: undefined, row: twoHours, chat: "on" }).settings?.duration).toBe(120 * MINUTE)
})

test("two agents on the same model in one project resolve their own total times", () => {
  const models = [
    record({ agent: "alpha", warming: "45m" }),
    record({ agent: "beta", warming: "2h" }),
    record({ agent: "gamma", modelID: "other", warming: "off" }),
  ]
  expect(resolveModelWarming({ models, scopes, level: "project", agent: "alpha" }, claude)).toEqual({ value: "45m", level: "project" })
  expect(resolveModelWarming({ models, scopes, level: "project", agent: "beta" }, claude)).toEqual({ value: "2h", level: "project" })
  // Another model of the same agent is unaffected; an agent with no row inherits nothing.
  expect(resolveModelWarming({ models, scopes, level: "project", agent: "alpha" }, { ...claude, modelID: "other" })).toBeUndefined()
  expect(resolveModelWarming({ models, scopes, level: "project", agent: "gamma" }, claude)).toBeUndefined()
})

test("a project row overrides the global row, and another project without one keeps the global value", () => {
  const global = record({ level: "global", warming: "30m" })
  const projectA = [global, record({ warming: "3h" })]
  const projectB = [global]
  const at = (models: ModelRecord[]) =>
    resolveModelWarming({ models, scopes: { global: new Set(["alpha"]), defaults: new Set<string>() }, level: "project", agent: "alpha" }, claude)
  expect(at(projectA)).toEqual({ value: "3h", level: "project" })
  expect(at(projectB)).toEqual({ value: "30m", level: "global" })
})

test("a variant row wins over the model's variant-less row, which still covers other variants", () => {
  const models = [record({ warming: "1h" }), record({ variant: "high", warming: "off" })]
  expect(resolveModelWarming({ models, scopes, level: "project", agent: "alpha" }, { ...claude, variant: "high" })?.value).toBe("off")
  expect(resolveModelWarming({ models, scopes, level: "project", agent: "alpha" }, { ...claude, variant: "low" })?.value).toBe("1h")
})

test("setting warming plants an inactive candidate where the model is inherited, and clearing removes only warming", () => {
  const inherited = [record({ level: "global", active: true })]
  const planted = setModelWarming(inherited, { level: "project", agent: "alpha" }, claude, "2h", UPDATED)
  expect(planted).toHaveLength(2)
  expect(planted[1]).toMatchObject({ level: "project", agent: "alpha", warming: "2h" })
  expect(planted[1]?.active).toBeUndefined()
  const cleared = setModelWarming(planted, { level: "project", agent: "alpha" }, claude, undefined, UPDATED)
  expect(cleared[1]?.warming).toBeUndefined()
  expect("warming" in (cleared[1] ?? {})).toBe(false)
  // Clearing where nothing is stored changes nothing.
  expect(setModelWarming(inherited, { level: "project", agent: "beta" }, claude, undefined, UPDATED)).toEqual(inherited)
})

test("warming on a Models row writes that agent's row at that level and refuses bad input", () => {
  const input: MemoInput = {
    items: [],
    records: [record({ level: "project", agent: "alpha" }), record({ level: "project", agent: "beta" })],
    agents: [
      { id: "alpha", scope: "project" },
      { id: "beta", scope: "project" },
    ],
  }
  const rows = expandedTree(input)
  const alpha = rows.find((row) => row.id === "item:project:alpha:model:anthropic/claude")
  expect(alpha).toBeDefined()
  const set = setModelWarmingRow(input, "item:project:alpha:model:anthropic/claude", "90m")
  if ("refusal" in set) throw new Error(set.refusal)
  expect(set.models.find((entry) => entry.agent === "alpha")?.warming).toBe("1h30m")
  expect(set.models.find((entry) => entry.agent === "beta")?.warming).toBeUndefined()
  // The row now shows its value.
  const shown = expandedTree({ ...input, records: set.models }).find((row) => row.id === "item:project:alpha:model:anthropic/claude")
  expect(shown?.badges.warming).toBe("1h30m")
  expect(shown?.badges.warmingFrom).toBe("project")
  // Refusals: a malformed time, and clearing a row with nothing set.
  const bad = setModelWarmingRow(input, "item:project:alpha:model:anthropic/claude", "forever")
  expect("refusal" in bad && bad.refusal).toContain("not a warming time")
  const nothing = setModelWarmingRow(input, "item:project:beta:model:anthropic/claude", "")
  expect("refusal" in nothing).toBe(true)
})

test("the hook row lookup follows the session's agent", () => {
  const state = {
    cachedAgents: [
      { id: "alpha", scope: "project" as const },
      { id: "beta", scope: "project" as const },
    ],
    cachedModels: [record({ agent: "alpha", warming: "45m" }), record({ agent: "beta", warming: "2h" })],
    cachedScopes: scopes,
  }
  const model = { providerID: "anthropic", id: "claude" }
  expect(warmingRowOf(state, "alpha", model)?.value).toBe("45m")
  expect(warmingRowOf(state, "beta", model)?.value).toBe("2h")
  expect(warmingRowOf(state, "unknown", model)).toBeUndefined()
})

test("the store applies the decision to the hook event and records the window for the countdown", async () => {
  const store = createWarmingStore(await tempFile())
  const activity = event({})
  expect(await store.decide(activity, { value: "2h", level: "project" })).toBe(true)
  expect(activity.settings?.duration).toBe(120 * MINUTE)
  const status = await store.status("ses_warm", 1_000_000 + MINUTE)
  expect(status).toMatchObject({
    chat: "default",
    active: true,
    source: "model",
    level: "project",
    since: 1_000_000,
    expires: 1_000_000 + 120 * MINUTE,
  })
  // After the window ends the chat shows as not warming.
  expect((await store.status("ses_warm", 1_000_000 + 121 * MINUTE)).active).toBe(false)
  // A model row switched off stops warming at the next decision.
  const warm = event({ phase: "warm", now: 1_000_000 + 2 * MINUTE })
  await store.decide(warm, { value: "off", level: "global" })
  expect(warm.settings).toBeUndefined()
  expect((await store.status("ses_warm", 1_000_000 + 3 * MINUTE)).active).toBe(false)
})

test("the per-chat switch persists across a restart and stops warming before the next request", async () => {
  const file = await tempFile()
  const store = createWarmingStore(file)
  await store.decide(event({}), undefined)
  expect((await store.status("ses_warm", 1_000_000)).active).toBe(true)
  const off = await store.setChat("ses_warm", "off")
  expect(off).toMatchObject({ chat: "off", active: false })
  // A new process reads the switch back and refuses the next warming request.
  const restarted = createWarmingStore(file)
  expect((await restarted.status("ses_warm")).chat).toBe("off")
  const warm = event({ phase: "warm", now: 1_000_000 + 4 * MINUTE })
  await restarted.decide(warm, { value: "2h", level: "project" })
  expect(warm.settings).toBeUndefined()
  // Control: another chat with no switch keeps the configuration.
  const other = event({ sessionID: Session.ID.make("ses_other") })
  await restarted.decide(other, undefined)
  expect(other.settings).toEqual(configured)
  // Switching on beats a model row set to off; "default" returns to the row.
  await restarted.setChat("ses_warm", "on")
  const on = event({})
  await restarted.decide(on, { value: "off", level: "project" })
  expect(on.settings).toEqual(configured)
  await restarted.setChat("ses_warm", "default")
  const follows = event({})
  await restarted.decide(follows, { value: "off", level: "project" })
  expect(follows.settings).toBeUndefined()
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({})
})

test("the footer counts down to the end of the window and the switch flips the visible state", () => {
  const base = { sessionID: "ses_warm", chat: "default" as const, now: 0 }
  const running = { ...base, active: true, since: 0, expires: 23 * MINUTE + 41_000, interval: 4 * MINUTE }
  expect(formatRemaining(65 * MINUTE + 9_000)).toBe("1:05:09")
  expect(formatRemaining(7_000)).toBe("0:07")
  expect(warmingLabel(running, 0)).toBe("cache warm · 23:41 left")
  expect(warmingLabel(running, 23 * MINUTE + 41_000)).toBeUndefined()
  expect(warmingLabel({ ...base, active: false }, 0)).toBeUndefined()
  expect(warmingLabel({ ...base, chat: "off", active: false }, 0)).toBe("cache warming off")
  expect(warmingLabel({ ...base, chat: "on", active: false }, 0)).toBe("cache warming on · starts after the next reply")
  expect(nextChatSwitch(running, 0)).toBe("off")
  expect(nextChatSwitch({ ...base, active: false }, 0)).toBe("on")
  expect(nextChatSwitch({ ...base, chat: "off", active: false }, 0)).toBe("on")
  expect(nextChatSwitch({ ...base, chat: "on", active: false }, 0)).toBe("off")
})
