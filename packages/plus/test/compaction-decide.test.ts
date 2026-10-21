// C3a: Plus's `compaction.decide` (plus-1.2.0 B34 / plus-1.1.18 §2 and §4).
// Per-model strategy/model/instructions, cold-cache arming, the CPA
// account-switch replacement and the team compactWith priority.
import { expect, test } from "bun:test"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import type { PacerCache, PacerCacheQuery } from "@opencodeplus/cliproxyapi/server"
import { coldStateOf, decideCompaction, isCold, type ColdCompactionState } from "../src/compaction/decide.js"
import { coldPlanOf } from "../src/compaction/cold-now.js"
import { plusSettings } from "../src/plus-settings.js"
import { armColdCompaction } from "../src/teams/cold-compaction.js"
import { compactionRowsOf } from "../src/compaction/rows.js"
import { createHandlers, createState, decideCompactionFor, warmingStatusFor, type PlusState } from "../src/index.js"
import { warmingStore } from "../src/warming.js"
import type { ModelRecord } from "../src/instructions/model.js"
import { effectiveCompaction, type ModelSettingsRecord } from "../src/instructions/model-settings.js"
import { canonicalJson, sha256 } from "../src/monitor/fingerprint.js"
import type { RequestFingerprintData, RequestRow } from "../src/monitor/ledger.js"
import { agentInfo, context, fullContext } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function decision(overrides: Partial<SessionCompactionDecision> = {}): SessionCompactionDecision {
  return {
    sessionID: Session.ID.make("ses_decide"),
    agent: Agent.ID.make("build"),
    model: Model.Ref.parse("proxy/chat-model"),
    reason: "auto",
    auto: true,
    due: false,
    boundary: { fresh: true, portable: true },
    ...overrides,
  }
}

const settings = (overrides: Partial<ModelSettingsRecord>): ModelSettingsRecord => ({
  type: "modelSettings",
  level: "defaults",
  updated: UPDATED,
  ...overrides,
})

// Cold since its cold moment, one millisecond ago.
const cold = (overrides: Partial<ColdCompactionState> = {}): ColdCompactionState => ({
  compacted: false,
  coldAt: 0,
  now: 1,
  ...overrides,
})

test("a store without the new fields leaves the decision unchanged", () => {
  const event = decision()
  const before = structuredClone(event)
  decideCompaction(event, {})
  expect(event).toEqual(before)
})

test("per-model strategy, model and instructions apply at each level with the right precedence", () => {
  // The agent's own model row wins over every lower level.
  const row = decision()
  decideCompaction(row, {
    rows: {
      compactionStrategy: { value: "local", level: "project" },
      compactionModel: { value: "row/model#high", level: "global" },
      compactionInstructions: { value: "row text", level: "project" },
    },
    agent: { strategy: "remote", model: "agent/model", instructions: "agent text" },
    model: settings({ compactionStrategy: "auto", compactionModel: "defaults/model", compactionInstructions: "defaults text" }),
    every: settings({ compactionStrategy: "remote", compactionModel: "every/model", compactionInstructions: "every text" }),
  })
  expect(row.strategy).toBe("local")
  expect(row.explanation?.strategy).toEqual({ value: "local", source: "project" })
  expect(row.compactionModel).toEqual(Model.Ref.parse("row/model#high"))
  expect(row.system).toBe("row text")

  // The old agent-wide rows still apply over the Defaults › Models rows.
  const agentWide = decision()
  decideCompaction(agentWide, {
    rows: {},
    agent: { strategy: "remote", model: "agent/model", instructions: "agent text" },
    model: settings({ compactionStrategy: "auto", compactionModel: "defaults/model" }),
    every: settings({ compactionModel: "every/model" }),
  })
  expect(agentWide.strategy).toBe("remote")
  expect(agentWide.explanation?.strategy).toEqual({ value: "remote", source: "agent" })
  expect(agentWide.compactionModel).toEqual(Model.Ref.parse("agent/model"))
  expect(agentWide.system).toBe("agent text")

  // Defaults › this model applies over Every model.
  const defaults = decision()
  decideCompaction(defaults, {
    rows: {},
    model: settings({ compactionStrategy: "local", compactionModel: "defaults/model" }),
    every: settings({ compactionStrategy: "remote", compactionModel: "every/model" }),
  })
  expect(defaults.strategy).toBe("local")
  expect(defaults.explanation?.strategy).toEqual({ value: "local", source: "model" })
  expect(defaults.compactionModel).toEqual(Model.Ref.parse("defaults/model"))

  // Every model applies when nothing above it sets the field.
  const every = decision()
  decideCompaction(every, { rows: {}, every: settings({ compactionStrategy: "remote", compactionModel: "every/model", compactionInstructions: "every text" }) })
  expect(every.strategy).toBe("remote")
  expect(every.explanation?.strategy).toEqual({ value: "remote", source: "every" })
  expect(every.compactionModel).toEqual(Model.Ref.parse("every/model"))
  expect(every.system).toBe("every text")

  // Built-in/inherit leaves every field untouched.
  const inherit = decision()
  decideCompaction(inherit, { rows: {}, model: settings({ coldCompact: "on" }) })
  expect(inherit.strategy).toBeUndefined()
  expect(inherit.compactionModel).toBeUndefined()
  expect(inherit.system).toBeUndefined()
})

test("cold arming fires on a cold fresh step with #1, #2… and optional", () => {
  const event = decision()
  decideCompaction(event, {
    every: settings({ coldModels: ["proxy/one#high", "proxy/two", "proxy/three"] }),
    cold: cold(),
  })
  expect(event.compact).toBe(true)
  expect(event.portable).toBe(true)
  expect(event.compactionModel).toEqual(Model.Ref.parse("proxy/one#high"))
  expect(event.compactionFallbacks).toEqual([Model.Ref.parse("proxy/two"), Model.Ref.parse("proxy/three")])
  expect(event.optional).toBe(true)
  expect(event.explanation?.trigger).toBe("cold")
  expect(event.metadata).toEqual({ "plus.cold": { models: ["proxy/one#high", "proxy/two", "proxy/three"] } })
})

test("cold arming does not fire when the chat is warm, its cold moment is unknown, it was just compacted, cold is not consulted, or its list is empty", () => {
  const fires = (state: ColdCompactionState | undefined) => {
    const event = decision()
    decideCompaction(event, {
      every: settings({ coldModels: ["proxy/one"] }),
      ...(state === undefined ? {} : { cold: state }),
    })
    return event.compact === true
  }
  // warm: its cold moment has not come.
  expect(fires(cold({ coldAt: 1_000, now: 100 }))).toBe(false)
  // unknown: nothing says when it goes cold (or a window keeps it warm).
  expect(fires({ compacted: false, now: 10_000_000 })).toBe(false)
  // compacted since its last request, or a step retried after its summary.
  expect(fires(cold({ compacted: true }))).toBe(false)
  // cold is not consulted: Compact cold chats first is off for the chat's model.
  expect(fires(undefined)).toBe(false)
  // the retired per-model switch, still stored as off, no longer gates it.
  {
    const event = decision()
    decideCompaction(event, { every: settings({ coldCompact: "off", coldModels: ["proxy/one"] }), cold: cold() })
    expect(event.compact).toBe(true)
  }
  // an empty list does nothing.
  {
    const event = decision()
    decideCompaction(event, { every: settings({}), cold: cold() })
    expect(event.compact).toBeUndefined()
  }
  // past its cold moment it is cold.
  expect(fires(cold({ coldAt: 1_000, now: 2_000 }))).toBe(true)
})

test("isCold: cold from its cold moment on; never when just compacted or when the moment is unknown", () => {
  expect(isCold(cold())).toBe(true)
  expect(isCold(cold({ coldAt: 5, now: 5 }))).toBe(true)
  expect(isCold(cold({ coldAt: 6, now: 5 }))).toBe(false)
  expect(isCold(cold({ compacted: true }))).toBe(false)
  expect(isCold({ compacted: false, now: 5 })).toBe(false)
})

test("the cold state reads the footer's status: a running window is warm, an ended one cold from its end", () => {
  const boundary = { fresh: false, portable: true }
  expect(coldStateOf({ status: { active: true, expires: 10 }, boundary, now: 20 })).toEqual({ compacted: false, now: 20 })
  expect(coldStateOf({ status: { active: false, expires: 10 }, boundary, now: 20 })).toEqual({ compacted: false, coldAt: 10, now: 20 })
  // A chat warming does not keep warm (switched off mid-window, or never on): its cold moment.
  expect(coldStateOf({ status: { active: false, expires: 30, coldAt: 12 }, boundary, now: 20 })).toMatchObject({ coldAt: 12 })
  // Core's boundary is the checkpoint its summary wrote: nothing new to summarize.
  expect(coldStateOf({ status: { active: false, expires: 10 }, boundary: { ...boundary, checkpoint: "msg_summary" }, now: 20 }).compacted).toBe(true)
})

test("the team compactWith arming takes priority over per-model settings and cold arming", () => {
  const event = decision()
  decideCompaction(event, {
    armed: ["team/summary#high"],
    rows: { compactionStrategy: { value: "local", level: "project" } },
    every: settings({ coldModels: ["proxy/one", "proxy/two"] }),
    cold: cold(),
  })
  expect(event.compact).toBe(true)
  expect(event.portable).toBe(true)
  expect(event.compactionModel).toEqual(Model.Ref.parse("team/summary#high"))
  expect(event.compactionFallbacks).toBeUndefined()
  expect(event.optional).toBeUndefined()
  expect(event.metadata).toBeUndefined()
})

test("an armed list of three: #1 writes, #2 and #3 fall back, and no optional (a manual compaction reports failure)", () => {
  const event = decision()
  decideCompaction(event, { armed: ["proxy/one#high", "proxy/two", "proxy/three"], cold: cold({ coldAt: 10, now: 1 }) })
  expect(event.compact).toBe(true)
  expect(event.portable).toBe(true)
  expect(event.compactionModel).toEqual(Model.Ref.parse("proxy/one#high"))
  expect(event.compactionFallbacks).toEqual([Model.Ref.parse("proxy/two"), Model.Ref.parse("proxy/three")])
  expect(event.optional).toBeUndefined()
})

// A chat on build and proxy/chat-model, as a team followup reads it.
function wiringSession(sessionID: string) {
  return context({
    session: {
      get: () => Effect.succeed({ id: Session.ID.make(sessionID), agent: "build", model: { providerID: "proxy", id: "chat-model" } }),
    } as unknown as SessionDomain,
  })
}

test("the cold plan names the chat's list, and the chat's own model to compact with", async () => {
  const sessionID = "ses_cold_plan"
  expect(await coldPlanOf(wiringSession(sessionID), coldState(["proxy/one", "proxy/two"]), sessionID)).toMatchObject({
    models: ["proxy/one", "proxy/two"],
  })
  expect(await coldPlanOf(wiringSession(sessionID), coldState([]), sessionID)).toEqual({
    models: [],
    model: "proxy/chat-model",
  })
})

test("an armed list is consumed by the next decision: only that one compacts", async () => {
  const sessionID = "ses_armed_once"
  const state = coldState(["proxy/one", "proxy/two", "proxy/three"])
  const ledger = fakeLedger(requestRow(Date.now()))
  const ctx = wiringSession(sessionID)
  armColdCompaction(sessionID, ["proxy/one", "proxy/two", "proxy/three"])
  const first = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
  await Effect.runPromise(decideCompactionFor(ctx, state, first, ledger))
  expect(first.compactionModel).toEqual(Model.Ref.parse("proxy/one"))
  expect(first.compactionFallbacks).toEqual([Model.Ref.parse("proxy/two"), Model.Ref.parse("proxy/three")])
  expect(first.optional).toBeUndefined()
  const second = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
  await Effect.runPromise(decideCompactionFor(ctx, state, second, ledger))
  expect(second.compact).toBeUndefined()
})

test("a quota.switch decision takes the chat model's list when it is not empty", () => {
  // CPA armed its own models and marked the decision.
  const event = decision({ metadata: { "quota.switch": true } })
  event.compact = true
  event.portable = true
  event.compactionModel = Model.Ref.parse("proxy/cpa-model")
  event.compactionFallback = Model.Ref.parse("proxy/cpa-fallback")
  decideCompaction(event, { every: settings({ coldModels: ["proxy/plus-one", "proxy/plus-two"] }) })
  expect(event.compactionModel).toEqual(Model.Ref.parse("proxy/plus-one"))
  expect(event.compactionFallbacks).toEqual([Model.Ref.parse("proxy/plus-two")])
  // The whole list replaces CPA's single fallback.
  expect(event.compactionFallback).toBeUndefined()
  expect(event.metadata?.["quota.switch"]).toBe(true)
})

test("a quota.switch decision with an empty chat-model list keeps CPA's own models", () => {
  const event = decision({ metadata: { "quota.switch": true } })
  event.compactionModel = Model.Ref.parse("proxy/cpa-model")
  event.compactionFallback = Model.Ref.parse("proxy/cpa-fallback")
  decideCompaction(event, { every: settings({ coldCompact: "on" }) })
  expect(event.compactionModel).toEqual(Model.Ref.parse("proxy/cpa-model"))
  expect(event.compactionFallback).toEqual(Model.Ref.parse("proxy/cpa-fallback"))
  expect(event.compactionFallbacks).toBeUndefined()
})

test("cold, compactWith and account-switch summaries are local under a remote strategy; a threshold handoff stays remote", () => {
  const remote = { rows: { compactionStrategy: { value: "remote", level: "project" as const } } }
  const coldEvent = decision()
  decideCompaction(coldEvent, { ...remote, every: settings({ coldModels: ["proxy/cheap"] }), cold: cold() })
  expect(coldEvent).toMatchObject({ strategy: "local", portable: true, compactionModel: Model.Ref.parse("proxy/cheap") })
  const armed = decision()
  decideCompaction(armed, { ...remote, armed: ["team/cheap"] })
  expect(armed).toMatchObject({ strategy: "local", compactionModel: Model.Ref.parse("team/cheap") })
  // A switch keeps CPA's own models when the chat model has no cold list, and is still local.
  const switching = decision({ metadata: { "quota.switch": true }, compact: true, portable: true })
  switching.compactionModel = Model.Ref.parse("proxy/cpa-model")
  decideCompaction(switching, remote)
  expect(switching).toMatchObject({ strategy: "local", compactionModel: Model.Ref.parse("proxy/cpa-model") })
  // CPA's threshold handoff: the account still has usage, so the chat's own strategy decides.
  const handoff = decision({ metadata: { "quota.handoff": "intent" }, compact: true, portable: true })
  decideCompaction(handoff, remote)
  expect(handoff.strategy).toBe("remote")
})

test("compaction.window answers the input threshold the agent and model resolve, for the TUI's context %", async () => {
  const state: PlusState = {
    ...createState(),
    cachedAgents: [{ id: "alpha", scope: "project" as const }],
    cachedModels: [{ type: "model", level: "project", agent: "alpha", providerID: "anthropic", modelID: "claude", compactionInput: "90000", updated: UPDATED }],
    cachedModelSettings: [settings({ compactionInput: "150000" }), settings({ providerID: "anthropic", modelID: "opus", compactionInput: "off" })],
    cachedScopes: { global: new Set<string>(), defaults: new Set<string>() },
  }
  const window = createHandlers(fullContext({ directory: "/workspace" }), state, { builtins: [] })["compaction.window"]
  const ask = (input: { agent: string; providerID: string; modelID: string }) =>
    Effect.runPromise(window(input, { error: (type: string, message: string, data?: unknown): never => { throw { type, message, data } } }))
  // The agent's own model row, then Every model; this model's off turns it off.
  expect(await ask({ agent: "alpha", providerID: "anthropic", modelID: "claude" })).toEqual({ input: 90_000 })
  expect(await ask({ agent: "beta", providerID: "anthropic", modelID: "claude" })).toEqual({ input: 150_000 })
  expect(await ask({ agent: "alpha", providerID: "anthropic", modelID: "opus" })).toEqual({})
})

test("compactionRowsOf resolves the agent model row down the store chain", () => {
  const modelRecord = (overrides: Partial<ModelRecord>): ModelRecord => ({
    type: "model",
    level: "project",
    agent: "alpha",
    providerID: "anthropic",
    modelID: "claude",
    updated: UPDATED,
    ...overrides,
  })
  const scopes = { global: new Set<string>(), defaults: new Set<string>() }
  const state = {
    cachedAgents: [{ id: "alpha", scope: "project" as const }],
    cachedModels: [
      modelRecord({ compactionStrategy: "local", compactionInstructions: "row text" }),
      modelRecord({ level: "global", compactionStrategy: "remote" }),
    ],
    cachedModelSettings: [settings({ providerID: "anthropic", modelID: "claude", compactionStrategy: "auto", compactionModel: "defaults/model" })],
    cachedScopes: scopes,
  }
  const rows = compactionRowsOf(state, "alpha", { providerID: "anthropic", id: "claude" })
  expect(rows.compactionStrategy).toEqual({ value: "local", level: "project" })
  expect(rows.compactionInstructions).toEqual({ value: "row text", level: "project" })
  // Defaults › this model fills the field the row chain does not set.
  const effective = effectiveCompaction({ row: rows, model: state.cachedModelSettings[0] })
  expect(effective.model).toEqual({ value: "defaults/model", from: "model" })
  // The decision carries both.
  const event = decision()
  decideCompaction(event, { rows, model: state.cachedModelSettings[0] as ModelSettingsRecord })
  expect(event.strategy).toBe("local")
  expect(event.system).toBe("row text")
  expect(event.compactionModel).toEqual(Model.Ref.parse("defaults/model"))
})

// The wiring gate and the TTL reading: a real ledger is replaced by a fake so
// the tests never touch monitor.db. A fingerprint with a 1h TTL proves the
// cache lifetime is read, not assumed to be 5 minutes.
const requestRow = (started: number, overrides: Partial<RequestRow> = {}): RequestRow => ({
  id: "req_last",
  sessionID: "ses_wire",
  kind: "primary",
  isTitle: false,
  provider: "proxy",
  model: "chat-model",
  started,
  status: "completed",
  inputTokens: 100,
  outputTokens: 10,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  created: started,
  ...overrides,
})

const oneHourFingerprint = (): RequestFingerprintData =>
  ({
    requestID: "req_last",
    sessionID: "ses_wire",
    protocol: "openai-chat",
    systemParts: [],
    tools: [],
    optionsHash: "",
    optionsKeys: { "prompt_cache_options.ttl": sha256(canonicalJson("1h")) },
    messagePrefixes: [],
    bodyHash: "",
  }) satisfies RequestFingerprintData

const fakeLedger = (row: RequestRow, fingerprint?: RequestFingerprintData) => ({
  getRequests: () => [row],
  getFingerprint: (requestID: string) => (requestID === row.id ? fingerprint : undefined),
})

// A context whose agent record exists: decideCompactionFor reads the agent's
// old agent-wide compaction policy from core.
function wiringContext() {
  const base = fullContext({ directory: process.env.OPENCODE_CONFIG_DIR ?? "/workspace" })
  return {
    ...base,
    agent: {
      ...base.agent,
      get: () =>
        Effect.succeed({
          location: base.location,
          data: agentInfo("build"),
        }),
    },
  }
}

function coldState(coldModels: string[]): PlusState {
  return {
    ...createState(),
    cachedAgents: [{ id: "build", scope: "project" as const }],
    cachedModels: [],
    cachedModelSettings: [settings({ providerID: "proxy", modelID: "chat-model", coldModels })],
  }
}

// The global Settings switch lives in a file (the test process's own data
// home); these wiring tests turn it on and leave it off for the next test.
async function withColdSwitch(run: () => Promise<void>) {
  await plusSettings.update({ coldCompact: true })
  try {
    await run()
  } finally {
    await plusSettings.update({ coldCompact: false })
  }
}

test("Images › When image context is full reaches core's decision from the chat model's rows; unset leaves it to core", async () => {
  const event = () => decision({ sessionID: Session.ID.make("ses_images_full"), boundary: { fresh: false, portable: true } })
  const ledger = fakeLedger(requestRow(Date.now()), oneHourFingerprint())
  const byDefault = event()
  await Effect.runPromise(decideCompactionFor(wiringContext(), coldState([]), byDefault, ledger))
  expect(byDefault.images).toBeUndefined()
  // Every model says stop; this chat's model says leave new images out, and its row wins.
  const state = {
    ...coldState([]),
    cachedModelSettings: [settings({ imagesFull: "error" }), settings({ providerID: "proxy", modelID: "chat-model", imagesFull: "leave-out" })],
  }
  const leaving = event()
  await Effect.runPromise(decideCompactionFor(wiringContext(), state, leaving, ledger))
  expect(leaving.images).toBe("leave-out")
  const other = decision({ sessionID: Session.ID.make("ses_images_other"), model: Model.Ref.parse("proxy/other-model"), boundary: { fresh: false, portable: true } })
  await Effect.runPromise(decideCompactionFor(wiringContext(), state, other, ledger))
  expect(other.images).toBe("error")
})

test("with Compact cold chats first off, a cold chat does not arm", async () => {
  const sessionID = "ses_wire_off"
  const event = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
  await Effect.runPromise(
    decideCompactionFor(wiringContext(), coldState(["proxy/one"]), event, fakeLedger(requestRow(Date.now() - 70 * 60_000, { sessionID }), oneHourFingerprint()), noPacer),
  )
  expect(event.compact).toBeUndefined()
})

test("cold arming fires before a step once the chat's cache lifetime passed, not before", () => withColdSwitch(async () => {
  const sessionID = "ses_wire"
  const event = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
  // 10 minutes idle, but this model's cache is 1h: still warm.
  const stillWarm = { ...event }
  await Effect.runPromise(
    decideCompactionFor(
      wiringContext(),
      coldState(["proxy/one", "proxy/two"]),
      stillWarm,
      fakeLedger(requestRow(Date.now() - 10 * 60_000), oneHourFingerprint()),
      noPacer,
    ),
  )
  expect(stillWarm.compact).toBeUndefined()

  // Now 70 minutes idle: the 1h cache is cold and it arms.
  const coldEvent = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
  await Effect.runPromise(
    decideCompactionFor(
      wiringContext(),
      coldState(["proxy/one", "proxy/two"]),
      coldEvent,
      fakeLedger(requestRow(Date.now() - 70 * 60_000), oneHourFingerprint()),
      noPacer,
    ),
  )
  expect(coldEvent.compact).toBe(true)
  expect(coldEvent.portable).toBe(true)
  expect(coldEvent.compactionModel).toEqual(Model.Ref.parse("proxy/one"))
  expect(coldEvent.compactionFallbacks).toEqual([Model.Ref.parse("proxy/two")])
  expect(coldEvent.optional).toBe(true)
}))

// Anthropic's default cache: a 5-minute ephemeral marker.
const fiveMinuteFingerprint = (): RequestFingerprintData =>
  ({
    ...oneHourFingerprint(),
    protocol: "anthropic-messages",
    optionsKeys: {},
    cacheControl: [{ target: "system", type: "ephemeral" }],
  }) satisfies RequestFingerprintData

test("a chat warming does not keep warm is cold once its cache lifetime passed, not right after its reply, as its footer says", () =>
  withColdSwitch(async () => {
    // Its last request with warming off: no window, only a cold moment.
    const replied = async (sessionID: string, at: number) =>
      warmingStore.decide(
        {
          sessionID: Session.ID.make(sessionID),
          agent: Agent.ID.make("build"),
          model: Model.Ref.parse("proxy/chat-model"),
          phase: "activity",
          kind: "primary",
          since: at,
          now: at,
          settings: undefined,
        },
        {},
      )
    const prompt = async (sessionID: string, at: number, fingerprint: RequestFingerprintData) => {
      const ledger = fakeLedger(requestRow(at, { sessionID }), fingerprint)
      const event = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
      await Effect.runPromise(decideCompactionFor(wiringContext(), coldState(["proxy/one"]), event, ledger, noPacer))
      return { compact: event.compact, coldAt: (await warmingStatusFor(sessionID, Date.now(), ledger, noPacer)).coldAt }
    }
    const now = Date.now()

    // Thirty seconds after its reply the cache is warm: no compaction, and the footer counts on.
    await replied("ses_unwarmed_warm", now - 30_000)
    expect(await prompt("ses_unwarmed_warm", now - 30_000, fiveMinuteFingerprint())).toEqual({ compact: undefined, coldAt: now - 30_000 + 5 * 60_000 })

    // Six minutes after, past the 5-minute cache: it compacts with the cold-cache model first.
    await replied("ses_unwarmed_cold", now - 6 * 60_000)
    expect(await prompt("ses_unwarmed_cold", now - 6 * 60_000, fiveMinuteFingerprint())).toEqual({ compact: true, coldAt: now - 60_000 })

    // A 1-hour cache ten minutes on is still warm, though one keep-alive interval passed.
    await replied("ses_unwarmed_hour", now - 10 * 60_000)
    expect(await prompt("ses_unwarmed_hour", now - 10 * 60_000, oneHourFingerprint())).toEqual({ compact: undefined, coldAt: now + 50 * 60_000 })
  }))

test("a running agent's later step is consulted too; once its summary is the checkpoint it does not compact again", () => withColdSwitch(async () => {
  const sessionID = "ses_wire2"
  const ctx = wiringContext()
  const state = coldState(["proxy/one"])
  // The agent waited 70 minutes on a tool: its 1h cache went cold mid-turn.
  const ledger = fakeLedger(requestRow(Date.now() - 70 * 60_000, { sessionID }), oneHourFingerprint())
  const later = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model"), boundary: { fresh: false, portable: true } })
  await Effect.runPromise(decideCompactionFor(ctx, state, later, ledger, noPacer))
  expect(later.compact).toBe(true)
  expect(later.compactionModel).toEqual(Model.Ref.parse("proxy/one"))

  // Its summary completed, and the step is decided again (a retry): nothing new to summarize.
  const retried = decision({
    sessionID: Session.ID.make(sessionID),
    model: Model.Ref.parse("proxy/chat-model"),
    boundary: { fresh: false, portable: true, checkpoint: "msg_summary" },
  })
  await Effect.runPromise(decideCompactionFor(ctx, state, retried, ledger, noPacer))
  expect(retried.compact).toBeUndefined()
}))

test("a 1h-TTL fingerprint is cold only past an hour, not after ten minutes; without a known lifetime never", async () => {
  const sessionID = "ses_ttl"
  const now = Date.now()
  const coldAfter = async (minutes: number, fingerprint?: RequestFingerprintData) =>
    isCold(
      coldStateOf({
        status: await warmingStatusFor(sessionID, now, fakeLedger(requestRow(now - minutes * 60_000, { sessionID }), fingerprint), noPacer),
        boundary: { fresh: false, portable: true },
        now,
      }),
    )
  expect(await coldAfter(10, oneHourFingerprint())).toBe(false)
  expect(await coldAfter(70, oneHourFingerprint())).toBe(true)
  // No fingerprint and a model whose cache lifetime is unknown: never cold.
  expect(await coldAfter(70)).toBe(false)
})

const noPacer = async (): Promise<PacerCache | undefined> => undefined

const MINUTE = 60_000

const rowsLedger = (rows: RequestRow[], fingerprints: Record<string, RequestFingerprintData>) => ({
  getRequests: () => rows,
  getFingerprint: (requestID: string) => fingerprints[requestID],
})

test("failed requests do not keep a cache warm: an agent whose steps fail is cold once its last answer's lifetime passed", () =>
  withColdSwitch(async () => {
    const sessionID = "ses_failed_steps"
    const now = Date.now()
    const answered = requestRow(now - 8 * MINUTE, { id: "req_ok", sessionID, ended: now - 8 * MINUTE + 20_000 })
    const failing = [
      requestRow(now - 2 * MINUTE, { id: "req_err1", sessionID, status: "error" }),
      requestRow(now - MINUTE, { id: "req_err2", sessionID, status: "error" }),
    ]
    const ledger = rowsLedger([answered, ...failing], { req_ok: fiveMinuteFingerprint(), req_err2: fiveMinuteFingerprint() })
    expect((await warmingStatusFor(sessionID, now, ledger, noPacer)).warmUntil).toBe(now - 3 * MINUTE)
    const retry = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model"), boundary: { fresh: false, portable: true } })
    await Effect.runPromise(decideCompactionFor(wiringContext(), coldState(["proxy/one"]), retry, ledger, noPacer))
    expect(retry.compact).toBe(true)

    // A failed request the provider still counted cache tokens for did touch the cache.
    const counted = rowsLedger([answered, failing[0]!, { ...failing[1]!, cacheReadTokens: 900 }], { req_ok: fiveMinuteFingerprint(), req_err2: fiveMinuteFingerprint() })
    expect((await warmingStatusFor(sessionID, now, counted, noPacer)).warmUntil).toBe(now + 4 * MINUTE)
  }))

test("keep-alives that do not go through end the window where its cache went cold; the agent's next step compacts first", () =>
  withColdSwitch(async () => {
    const sessionID = Session.ID.make("ses_offline")
    const now = Date.now()
    const start = now - 9 * MINUTE
    const settings = { prompt: "ok", interval: 4 * MINUTE, duration: 30 * MINUTE }
    const warming = {
      sessionID,
      agent: Agent.ID.make("build"),
      model: Model.Ref.parse("proxy/chat-model"),
      phase: "activity" as const,
      kind: "primary" as const,
      since: start,
      now: start,
      settings,
    }
    await warmingStore.decide(warming, {})
    // The keep-alive at four minutes did not go through.
    await warmingStore.decide({ ...warming, phase: "warm", now: start + 4 * MINUTE, settings: { ...settings } }, {})
    expect(warmingStore.warmed(sessionID, start + 4 * MINUTE + 500, "Unable to connect")).toBe(true)
    const ledger = fakeLedger(requestRow(start, { sessionID, ended: start + 10_000 }), fiveMinuteFingerprint())

    // Half a minute later the cache is still warm, for half a minute.
    const failing = await warmingStatusFor(sessionID, start + 4.5 * MINUTE, ledger, noPacer)
    expect(failing).toMatchObject({ active: true, warmUntil: start + 5 * MINUTE, warmBy: "monitor", pingFailed: { at: start + 4 * MINUTE + 500, error: "Unable to connect" } })
    // Past that the window reads as ended there.
    const offline = await warmingStatusFor(sessionID, now, ledger, noPacer)
    expect(offline).toMatchObject({ active: false, expires: start + 5 * MINUTE, warmUntil: start + 5 * MINUTE })
    const step = decision({ sessionID, model: Model.Ref.parse("proxy/chat-model"), boundary: { fresh: false, portable: true } })
    await Effect.runPromise(decideCompactionFor(wiringContext(), coldState(["proxy/one"]), step, ledger, noPacer))
    expect(step.compact).toBe(true)

    // Warming stops there: the store's window ends at the cold moment.
    expect(warmingStore.cool(sessionID, start + 5 * MINUTE)).toBe(true)
    expect(await warmingStore.status(sessionID, now)).toMatchObject({ active: false, expires: start + 5 * MINUTE })
    warmingStore.stop(sessionID)
  }))

test("Pacer's confirmed reading decides once it can know the chat's latest request; before that, or a guess, leaves it to the Monitor", async () => {
  const sessionID = "ses_pacer"
  const now = Date.now()
  const asked: PacerCacheQuery[] = []
  const pacer = (evidence: PacerCache["evidence"], until: number) => async (query: PacerCacheQuery): Promise<PacerCache> => {
    asked.push(query)
    return { warm: until > now, evidence, until, at: now }
  }
  // The last step ended three minutes ago on a 5-minute cache: by the Monitor, warm for 1:40 more.
  const ledger = fakeLedger(requestRow(now - 3 * MINUTE - 20_000, { sessionID, ended: now - 3 * MINUTE }), fiveMinuteFingerprint())
  // Pacer saw CPA send a 1-hour TTL.
  expect(await warmingStatusFor(sessionID, now, ledger, pacer("confirmed", now + 57 * MINUTE))).toMatchObject({ warmUntil: now + 57 * MINUTE, warmBy: "pacer" })
  expect(asked[0]).toMatchObject({ sessionID, providerID: "proxy", modelID: "chat-model", after: now - 2 * MINUTE })
  // Its cold verdict counts too.
  expect(await warmingStatusFor(sessionID, now, ledger, pacer("confirmed", now - 1))).toMatchObject({ warmUntil: now - 1, warmBy: "pacer" })
  // An assumed reading is Pacer's guess.
  expect(await warmingStatusFor(sessionID, now, ledger, pacer("assumed", now - 1))).toMatchObject({ warmUntil: now + 100_000, warmBy: "monitor" })
  // Within a minute of the latest answer Pacer cannot know it yet, and is not asked.
  asked.length = 0
  const recent = fakeLedger(requestRow(now - 30_000, { sessionID, ended: now - 20_000 }), fiveMinuteFingerprint())
  expect(await warmingStatusFor(sessionID, now, recent, pacer("confirmed", now - 1))).toMatchObject({ warmUntil: now + 4.5 * MINUTE, warmBy: "monitor" })
  expect(asked).toEqual([])
})
