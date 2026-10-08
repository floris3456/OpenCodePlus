// C3a: Plus's `compaction.decide` (plus-1.2.0 B34 / plus-1.1.18 §2 and §4).
// Per-model strategy/model/instructions, cold-cache arming, the CPA
// account-switch replacement and the team compactWith priority.
import { expect, test } from "bun:test"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { decideCompaction, isCold, type ColdCompactionState } from "../src/compaction/decide.js"
import { compactionRowsOf } from "../src/index.js"
import type { ModelRecord } from "../src/instructions/model.js"
import { effectiveCompaction, type ModelSettingsRecord } from "../src/instructions/model-settings.js"

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

const cold = (overrides: Partial<ColdCompactionState> = {}): ColdCompactionState => ({
  running: false,
  ready: true,
  active: false,
  compacted: false,
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
  expect(defaults.compactionModel).toEqual(Model.Ref.parse("defaults/model"))

  // Every model applies when nothing above it sets the field.
  const every = decision()
  decideCompaction(every, { rows: {}, every: settings({ compactionStrategy: "remote", compactionModel: "every/model", compactionInstructions: "every text" }) })
  expect(every.strategy).toBe("remote")
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
    every: settings({ coldCompact: "on", coldModels: ["proxy/one#high", "proxy/two", "proxy/three"] }),
    cold: cold(),
  })
  expect(event.compact).toBe(true)
  expect(event.portable).toBe(true)
  expect(event.compactionModel).toEqual(Model.Ref.parse("proxy/one#high"))
  expect(event.compactionFallbacks).toEqual([Model.Ref.parse("proxy/two"), Model.Ref.parse("proxy/three")])
  expect(event.optional).toBe(true)
  expect(event.metadata).toEqual({ "plus.cold": { models: ["proxy/one#high", "proxy/two", "proxy/three"] } })
})

test("cold arming does not fire when the chat is warm, running, unknown-lifetime, compacted, not first step, off or empty", () => {
  const context = (state: ColdCompactionState | undefined, overrides: Partial<SessionCompactionDecision> = {}) => ({
    every: settings({ coldCompact: "on", coldModels: ["proxy/one"] }),
    ...(state === undefined ? {} : { cold: state }),
    __event: decision(overrides),
  })
  const fires = (state: ColdCompactionState | undefined, overrides: Partial<SessionCompactionDecision> = {}) => {
    const { __event, ...rest } = context(state, overrides)
    decideCompaction(__event, rest)
    return __event.compact === true
  }
  // warm: the window still runs.
  expect(fires(cold({ active: true }))).toBe(false)
  // warm: a window-less chat within its cache lifetime.
  expect(fires(cold({ ready: false, idleMs: 100, lifetime: 1_000 }))).toBe(false)
  // running.
  expect(fires(cold({ running: true }))).toBe(false)
  // no window and an unknown lifetime is never cold.
  expect(fires(cold({ ready: false, idleMs: 10_000_000 }))).toBe(false)
  // compacted since its last request.
  expect(fires(cold({ compacted: true }))).toBe(false)
  // not the first step of a new prompt.
  expect(fires(cold(), { boundary: { fresh: false, portable: true } })).toBe(false)
  expect(fires(cold(), { reason: "manual" })).toBe(false)
  // the setting is off.
  {
    const event = decision()
    decideCompaction(event, { every: settings({ coldCompact: "off", coldModels: ["proxy/one"] }), cold: cold() })
    expect(event.compact).toBeUndefined()
  }
  // an empty list does nothing.
  {
    const event = decision()
    decideCompaction(event, { every: settings({ coldCompact: "on" }), cold: cold() })
    expect(event.compact).toBeUndefined()
  }
  // a window-less chat past its cache lifetime is cold.
  expect(fires(cold({ ready: false, idleMs: 2_000, lifetime: 1_000 }))).toBe(true)
})

test("isCold treats a running, warm, compacted or unknown-lifetime chat as not cold", () => {
  expect(isCold(cold())).toBe(true)
  expect(isCold(cold({ active: true }))).toBe(false)
  expect(isCold(cold({ running: true }))).toBe(false)
  expect(isCold(cold({ compacted: true }))).toBe(false)
  expect(isCold(cold({ ready: false, idleMs: 5 }))).toBe(false)
  expect(isCold(cold({ ready: false, idleMs: 5, lifetime: 1 }))).toBe(true)
})

test("the team compactWith arming takes priority over per-model settings and cold arming", () => {
  const event = decision()
  decideCompaction(event, {
    teamModel: "team/summary#high",
    rows: { compactionStrategy: { value: "local", level: "project" } },
    every: settings({ coldCompact: "on", coldModels: ["proxy/one", "proxy/two"] }),
    cold: cold(),
  })
  expect(event.compact).toBe(true)
  expect(event.portable).toBe(true)
  expect(event.compactionModel).toEqual(Model.Ref.parse("team/summary#high"))
  expect(event.compactionFallbacks).toBeUndefined()
  expect(event.optional).toBeUndefined()
  expect(event.metadata).toBeUndefined()
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