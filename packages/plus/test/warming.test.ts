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
import { warmingRowsOf } from "../src/index.js"
import type { ModelSettingsRecord } from "../src/instructions/model-settings.js"
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

const defaultsRecord = (overrides: Partial<ModelSettingsRecord>): ModelSettingsRecord => ({
  type: "modelSettings",
  level: "defaults",
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

test("the per-chat switch beats the model rows, which beat the host configuration", () => {
  const twoHours = { warming: { value: "2h", level: "project" as const } }
  // Nothing set: core's proposal passes through untouched, including "off".
  expect(decideWarming({ configured, rows: {}, chat: undefined })).toEqual({ settings: configured, source: "config" })
  expect(decideWarming({ configured: undefined, rows: {}, chat: undefined })).toEqual({ settings: undefined, source: "config" })
  // The model row switches it off, or sets the total time over the configuration.
  expect(decideWarming({ configured, rows: { row: { warming: { value: "off", level: "project" } } }, chat: undefined })).toEqual({
    settings: undefined,
    source: "model",
    level: "project",
  })
  expect(decideWarming({ configured, rows: { row: twoHours }, chat: undefined }).settings).toEqual({ ...configured, duration: 120 * MINUTE })
  expect(decideWarming({ configured, rows: { row: { warming: { value: "on", level: "project" } } }, chat: undefined }).settings).toEqual(configured)
  // A model row turns warming on where the configuration leaves it off, with core's defaults.
  expect(decideWarming({ configured: undefined, rows: { row: twoHours }, chat: undefined }).settings).toEqual({
    ...WARMING_DEFAULTS,
    duration: 120 * MINUTE,
  })
  // The chat switch wins both ways and keeps the row's total time when on.
  expect(decideWarming({ configured, rows: { row: twoHours }, chat: "off" })).toEqual({ settings: undefined, source: "chat" })
  expect(decideWarming({ configured, rows: { row: { warming: { value: "off", level: "project" } } }, chat: "on" })).toEqual({
    settings: configured,
    source: "chat",
  })
  expect(decideWarming({ configured: undefined, rows: { row: twoHours }, chat: "on" }).settings?.duration).toBe(120 * MINUTE)
})

test("the interval and the keep-alive prompt resolve per field, row over Defaults over the host", () => {
  const row = {
    warming: { value: "2h", level: "project" as const },
    interval: { value: "3m30s", level: "project" as const },
    prompt: { value: "ping", level: "project" as const },
  }
  // 2h is not a whole number of 3m30s pings: it warms 35 of them, 2h2m30s.
  expect(decideWarming({ configured, rows: { row }, chat: undefined }).settings).toEqual({
    prompt: "ping",
    interval: 3.5 * MINUTE,
    duration: 122.5 * MINUTE,
  })
  // Defaults › Models › this model: the agent row still wins over it, field by field.
  const modelRow = defaultsRecord({ interval: "5m" })
  expect(decideWarming({ configured, rows: { row: { interval: row.interval }, model: modelRow }, chat: undefined }).settings?.interval).toBe(3.5 * MINUTE)
  expect(decideWarming({ configured, rows: { model: modelRow }, chat: undefined }).settings).toEqual({
    prompt: configured.prompt,
    interval: 5 * MINUTE,
    duration: configured.duration,
  })
  expect(decideWarming({ configured, rows: { model: modelRow }, chat: undefined })).toMatchObject({
    source: "model",
    level: "defaults",
  })
  // The model's Defaults row wins over Every model, and Every model over the host.
  const everyRow = defaultsRecord({ warming: "on", interval: "25m", prompt: "keep" })
  expect(
    decideWarming({ configured, rows: { model: defaultsRecord({ warming: "off" }), every: everyRow }, chat: undefined }),
  ).toEqual({ settings: undefined, source: "model", level: "defaults" })
  const every = decideWarming({ configured, rows: { every: everyRow }, chat: undefined })
  expect(every).toMatchObject({ source: "model", level: "defaults" })
  // The host's 30m with Every model's 25m ping rounds up to two pings.
  expect(every.settings).toEqual({ prompt: "keep", interval: 25 * MINUTE, duration: 50 * MINUTE })
  // A Defaults row that only sets the interval does not switch warming on where the host left it off.
  expect(decideWarming({ configured: undefined, rows: { model: modelRow }, chat: undefined })).toEqual({
    settings: undefined,
    source: "model",
    level: "defaults",
  })
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
    cachedModelSettings: [],
    cachedScopes: scopes,
  }
  const model = { providerID: "anthropic", id: "claude" }
  expect(warmingRowsOf(state, "alpha", model).row?.warming?.value).toBe("45m")
  expect(warmingRowsOf(state, "beta", model).row?.warming?.value).toBe("2h")
  expect(warmingRowsOf(state, "unknown", model).row).toBeUndefined()
})

test("the hook rows include the Defaults › Models rows for the session's model", () => {
  const state = {
    cachedAgents: [{ id: "alpha", scope: "project" as const }],
    cachedModels: [],
    cachedModelSettings: [
      defaultsRecord({ interval: "25m" }),
      defaultsRecord({ providerID: "anthropic", modelID: "claude", warming: "2h" }),
    ],
    cachedScopes: scopes,
  }
  const rows = warmingRowsOf(state, "alpha", { providerID: "anthropic", id: "claude" })
  expect(rows.row).toBeUndefined()
  expect(rows.model).toMatchObject({ warming: "2h" })
  expect(rows.every).toMatchObject({ interval: "25m" })
  const decision = decideWarming({ configured, rows, chat: undefined })
  expect(decision).toMatchObject({ source: "model", level: "defaults" })
  // 2h with a 25m ping: five whole pings, 2h5m.
  expect(decision.settings).toEqual({ prompt: configured.prompt, interval: 25 * MINUTE, duration: 125 * MINUTE })
  // A model with no row of its own still sees Every model.
  const other = warmingRowsOf(state, "alpha", { providerID: "openai", id: "gpt" })
  expect(other.model).toBeUndefined()
  expect(other.every).toMatchObject({ interval: "25m" })
  // No Defaults rows at all leaves core's proposal in charge.
  const bare = warmingRowsOf({ ...state, cachedModelSettings: [] }, "alpha", { providerID: "anthropic", id: "claude" })
  expect(bare).toEqual({})
})

test("the store applies the decision to the hook event and records the window for the countdown", async () => {
  const store = createWarmingStore(await tempFile())
  const activity = event({})
  expect(await store.decide(activity, { row: { warming: { value: "2h", level: "project" } } })).toBe(true)
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
  // After the window ends the chat shows as not warming, and keeps the ended
  // window so the footer can say the cache went cold.
  expect(await store.status("ses_warm", 1_000_000 + 121 * MINUTE)).toMatchObject({
    active: false,
    expires: 1_000_000 + 120 * MINUTE,
  })
  // A model row switched off stops warming at the next decision.
  const warm = event({ phase: "warm", now: 1_000_000 + 2 * MINUTE })
  await store.decide(warm, { row: { warming: { value: "off", level: "global" } } })
  expect(warm.settings).toBeUndefined()
  expect((await store.status("ses_warm", 1_000_000 + 3 * MINUTE)).active).toBe(false)
})

test("the per-chat switch persists across a restart and stops warming before the next request", async () => {
  const file = await tempFile()
  const store = createWarmingStore(file)
  await store.decide(event({}), {})
  expect((await store.status("ses_warm", 1_000_000)).active).toBe(true)
  const off = await store.setChat("ses_warm", "off")
  expect(off).toMatchObject({ chat: "off", active: false })
  // A new process reads the switch back and refuses the next warming request.
  const restarted = createWarmingStore(file)
  expect((await restarted.status("ses_warm")).chat).toBe("off")
  const warm = event({ phase: "warm", now: 1_000_000 + 4 * MINUTE })
  await restarted.decide(warm, { row: { warming: { value: "2h", level: "project" } } })
  expect(warm.settings).toBeUndefined()
  // Control: another chat with no switch keeps the configuration.
  const other = event({ sessionID: Session.ID.make("ses_other") })
  await restarted.decide(other, {})
  expect(other.settings).toEqual(configured)
  // Switching on beats a model row set to off; "default" returns to the row.
  await restarted.setChat("ses_warm", "on")
  const on = event({})
  await restarted.decide(on, { row: { warming: { value: "off", level: "project" } } })
  expect(on.settings).toEqual(configured)
  await restarted.setChat("ses_warm", "default")
  const follows = event({})
  await restarted.decide(follows, { row: { warming: { value: "off", level: "project" } } })
  expect(follows.settings).toBeUndefined()
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({})
})

test("the footer counts down to the end of the window, then shows the cache cold, and the switch flips the visible state", () => {
  const base = { sessionID: "ses_warm", chat: "default" as const, now: 0 }
  const running = { ...base, active: true, since: 0, expires: 23 * MINUTE + 41_000, interval: 4 * MINUTE }
  expect(formatRemaining(65 * MINUTE + 9_000)).toBe("1:05:09")
  expect(formatRemaining(7_000)).toBe("0:07")
  expect(warmingLabel(running, 0)).toEqual({ text: "cache warm · 23:41 left", tone: "muted" })
  // The window ran out: the footer stays and warns that the cache is cold.
  expect(warmingLabel(running, 23 * MINUTE + 41_000)).toEqual({ text: "cache cold", tone: "warning" })
  expect(warmingLabel({ ...running, active: false }, 24 * MINUTE)).toEqual({ text: "cache cold", tone: "warning" })
  expect(warmingLabel({ ...running, chat: "on", active: false }, 24 * MINUTE)).toEqual({
    text: "cache cold · warming starts after the next reply",
    tone: "warning",
  })
  // Control: a chat that never had a window shows nothing, and off stays off.
  expect(warmingLabel({ ...base, active: false }, 0)).toBeUndefined()
  expect(warmingLabel({ ...base, chat: "off", active: false }, 0)).toEqual({ text: "cache warming off", tone: "muted" })
  expect(warmingLabel({ ...running, chat: "off", active: false }, 24 * MINUTE)).toEqual({
    text: "cache warming off",
    tone: "muted",
  })
  expect(warmingLabel({ ...base, chat: "on", active: false }, 0)).toEqual({
    text: "cache warming on · starts after the next reply",
    tone: "muted",
  })
  expect(nextChatSwitch(running, 0)).toBe("off")
  expect(nextChatSwitch({ ...base, active: false }, 0)).toBe("on")
  expect(nextChatSwitch({ ...base, chat: "off", active: false }, 0)).toBe("on")
  expect(nextChatSwitch({ ...base, chat: "on", active: false }, 0)).toBe("off")
})

// Compact before cold: a fake clock and timers stand in for setTimeout.
function fakeClock(start: number) {
  const timers = new Map<number, { readonly run: () => void; readonly at: number }>()
  const state = { now: start, next: 0 }
  return {
    get now() {
      return state.now
    },
    set now(value: number) {
      state.now = value
    },
    options: {
      now: () => state.now,
      setTimer: (run: () => void, ms: number) => {
        state.next += 1
        timers.set(state.next, { run, at: state.now + ms })
        return state.next
      },
      clearTimer: (timer: unknown) => {
        timers.delete(timer as number)
      },
    },
    pending: () => [...timers.values()].map((timer) => timer.at),
    /** Advance to the earliest timer and run it. */
    async fire() {
      const [id, timer] = [...timers.entries()].toSorted((left, right) => left[1].at - right[1].at)[0] ?? []
      if (id === undefined || timer === undefined) throw new Error("no timer")
      timers.delete(id)
      state.now = timer.at
      timer.run()
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
  }
}

test("compact before cold is off in a new chat and, switched on, compacts an idle chat once when its warming window ends", async () => {
  const file = await tempFile()
  const clock = fakeClock(1_000_000)
  const store = createWarmingStore(file, clock.options)
  const compacted: string[] = []
  const compact = async (sessionID: string) => {
    compacted.push(sessionID)
  }
  // Off by default: a reply schedules nothing.
  await store.decide(event({}), {}, compact)
  expect(clock.pending()).toEqual([])
  expect(await store.status("ses_warm")).toMatchObject({ compact: false, active: true })
  // On: the compaction waits for the end of the warming window (30m after the reply).
  expect(await store.setCompact("ses_warm", true)).toMatchObject({ compact: true, compactAt: 1_000_000 + 30 * MINUTE })
  // A later reply moves it, leaving one scheduled compaction.
  clock.now = 1_000_000 + 5 * MINUTE
  expect(await store.decide(event({ since: clock.now, now: clock.now }), {}, compact)).toBe(true)
  expect(clock.pending()).toEqual([1_000_000 + 35 * MINUTE])
  // A keep-alive inside the window keeps it where it is.
  clock.now = 1_000_000 + 7 * MINUTE
  await store.decide(event({ phase: "warm", since: 1_000_000 + 5 * MINUTE, now: clock.now }), {}, compact)
  expect(clock.pending()).toEqual([1_000_000 + 35 * MINUTE])
  await clock.fire()
  expect(compacted).toEqual(["ses_warm"])
  expect((await store.status("ses_warm")).compactAt).toBeUndefined()
  // Its own request stops warming and schedules no further compaction.
  const own = event({ kind: "compaction", since: clock.now, now: clock.now })
  await store.decide(own, {}, compact)
  expect(own.settings).toBeUndefined()
  expect(clock.pending()).toEqual([])
  expect(await store.status("ses_warm", clock.now + MINUTE)).toMatchObject({ active: false, compact: true })
  expect((await store.status("ses_warm", clock.now + MINUTE)).expires).toBeUndefined()
  // The next real request schedules again; the switch survives a restart and
  // another chat stays off.
  expect(JSON.parse(await fs.readFile(path.join(path.dirname(file), "compact.json"), "utf8"))).toEqual(["ses_warm"])
  const restarted = createWarmingStore(file, clock.options)
  await restarted.decide(event({ since: clock.now, now: clock.now }), {}, compact)
  expect((await restarted.status("ses_warm")).compactAt).toBe(clock.now + 30 * MINUTE)
  expect((await restarted.status("ses_other")).compact).toBe(false)
  restarted.dispose()
  store.dispose()
})

test("compact before cold skips a running chat, a manual compaction, a cold cache, and stops when switched off", async () => {
  const clock = fakeClock(1_000_000)
  const store = createWarmingStore(await tempFile(), clock.options)
  const compacted: string[] = []
  const compact = async (sessionID: string) => {
    compacted.push(sessionID)
  }
  await store.setCompact("ses_warm", true)
  // Warming off for the chat: the cache goes cold one interval after the reply.
  await store.setChat("ses_warm", "off")
  const off = event({})
  await store.decide(off, { row: { interval: { value: "4m", level: "project" } } }, compact)
  expect(off.settings).toBeUndefined()
  expect(clock.pending()).toEqual([1_000_000 + 4 * MINUTE])
  // A running chat is using its cache: the timer passes without compacting.
  store.running("ses_warm", true)
  await clock.fire()
  expect(compacted).toEqual([])
  store.running("ses_warm", false)
  // A manual compaction's request schedules nothing and keeps the chat's warming decision.
  await store.setChat("ses_warm", "default")
  const manual = event({ kind: "compaction", since: clock.now, now: clock.now })
  await store.decide(manual, {}, compact)
  expect(manual.settings).toEqual(configured)
  expect(clock.pending()).toEqual([])
  // Switching on after the window ended leaves the cold cache alone.
  await store.setCompact("ses_warm", false)
  await store.decide(event({ since: clock.now, now: clock.now }), {}, compact)
  clock.now += 31 * MINUTE
  await store.setCompact("ses_warm", true)
  expect(clock.pending()).toEqual([])
  // Switched off, a scheduled compaction is dropped.
  await store.decide(event({ since: clock.now, now: clock.now }), {}, compact)
  expect(clock.pending()).toHaveLength(1)
  expect((await store.setCompact("ses_warm", false)).compact).toBe(false)
  expect(clock.pending()).toEqual([])
  // A refused compaction does not stop warming after the next compaction request.
  await store.setCompact("ses_warm", true)
  await store.decide(event({ since: clock.now, now: clock.now }), {}, async () => {
    throw new Error("refused")
  })
  await clock.fire()
  const later = event({ kind: "compaction", since: clock.now, now: clock.now })
  await store.decide(later, {}, compact)
  expect(later.settings).toEqual(configured)
  store.dispose()
})
