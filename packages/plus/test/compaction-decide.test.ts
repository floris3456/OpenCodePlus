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
import {
  coldStateOf,
  consumePromptAdmitted,
  decideCompaction,
  isCold,
  markPromptAdmitted,
  type ColdCompactionState,
} from "../src/compaction/decide.js"
import { compactColdNow } from "../src/compaction/cold-now.js"
import { compactionRowsOf } from "../src/compaction/rows.js"
import { createState, decideCompactionFor, type PlusState } from "../src/index.js"
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
    every: settings({ coldCompact: "on", coldModels: ["proxy/one#high", "proxy/two", "proxy/three"] }),
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

test("cold arming does not fire when the chat is warm, running, unknown-lifetime, compacted, off/gated, or empty", () => {
  const fires = (state: ColdCompactionState | undefined) => {
    const event = decision()
    decideCompaction(event, {
      every: settings({ coldCompact: "on", coldModels: ["proxy/one"] }),
      ...(state === undefined ? {} : { cold: state }),
    })
    return event.compact === true
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
  // the prompt mark was not consumed for this decision (a later step of the
  // turn, or a chat that has not been prompted): cold is not consulted.
  expect(fires(undefined)).toBe(false)
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
    armed: ["team/summary#high"],
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

test("an armed list of three: #1 writes, #2 and #3 fall back, and no optional (a manual compaction reports failure)", () => {
  const event = decision()
  decideCompaction(event, { armed: ["proxy/one#high", "proxy/two", "proxy/three"], cold: cold({ active: true }) })
  expect(event.compact).toBe(true)
  expect(event.portable).toBe(true)
  expect(event.compactionModel).toEqual(Model.Ref.parse("proxy/one#high"))
  expect(event.compactionFallbacks).toEqual([Model.Ref.parse("proxy/two"), Model.Ref.parse("proxy/three")])
  expect(event.optional).toBeUndefined()
})

// The `compaction.cold` RPC's logic: a chat on build and proxy/chat-model whose
// session records each manual compaction it is asked for.
function wiringSession(sessionID: string, onCompact: (input: unknown) => void) {
  return context({
    session: {
      get: () => Effect.succeed({ id: Session.ID.make(sessionID), agent: "build", model: { providerID: "proxy", id: "chat-model" } }),
      compact: (input: unknown) => {
        onCompact(input)
        return Effect.succeed(undefined)
      },
    } as unknown as SessionDomain,
  })
}

test("compaction.cold arms the chat's list and asks core for one manual compaction", async () => {
  const sessionID = "ses_cold_now"
  const asked: unknown[] = []
  const result = await compactColdNow(wiringSession(sessionID, (input) => asked.push(input)), coldState(["proxy/one", "proxy/two"]), sessionID)
  expect(result).toEqual({ ok: true, models: ["proxy/one", "proxy/two"] })
  expect(asked).toEqual([{ sessionID: Session.ID.make(sessionID) }])
})

test("compaction.cold with no list says where to add one and asks core for nothing", async () => {
  const sessionID = "ses_cold_none"
  const asked: unknown[] = []
  const result = await compactColdNow(wiringSession(sessionID, (input) => asked.push(input)), coldState([]), sessionID)
  expect(result).toEqual({
    ok: false,
    reason: "no-list",
    where: "Instructions › build › proxy/chat-model › Warming › Compact cold caches with another model (a adds one)",
  })
  expect(asked).toEqual([])
})

test("an armed list is consumed by the next decision: only that one compacts", async () => {
  const sessionID = "ses_armed_once"
  const state = coldState(["proxy/one", "proxy/two", "proxy/three"])
  const ledger = fakeLedger(requestRow(Date.now()))
  const ctx = wiringSession(sessionID, () => {})
  await compactColdNow(ctx, state, sessionID)
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
    cachedModelSettings: [settings({ providerID: "proxy", modelID: "chat-model", coldCompact: "on", coldModels })],
  }
}

test("cold arming fires for a chat with earlier output once a prompt was admitted and it is cold", async () => {
  const sessionID = "ses_wire"
  markPromptAdmitted(sessionID)
  const event = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
  // 10 minutes idle, but this model's cache is 1h: still warm.
  const stillWarm = { ...event }
  await Effect.runPromise(
    decideCompactionFor(
      wiringContext(),
      coldState(["proxy/one", "proxy/two"]),
      stillWarm,
      fakeLedger(requestRow(Date.now() - 10 * 60_000), oneHourFingerprint()),
    ),
  )
  expect(stillWarm.compact).toBeUndefined()
  // The mark was consumed even though nothing armed: a later step must not consult cold.
  expect(consumePromptAdmitted(sessionID)).toBe(false)

  // A new prompt, now 70 minutes idle: the 1h cache is cold and it arms.
  markPromptAdmitted(sessionID)
  const coldEvent = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
  await Effect.runPromise(
    decideCompactionFor(
      wiringContext(),
      coldState(["proxy/one", "proxy/two"]),
      coldEvent,
      fakeLedger(requestRow(Date.now() - 70 * 60_000), oneHourFingerprint()),
    ),
  )
  expect(coldEvent.compact).toBe(true)
  expect(coldEvent.portable).toBe(true)
  expect(coldEvent.compactionModel).toEqual(Model.Ref.parse("proxy/one"))
  expect(coldEvent.compactionFallbacks).toEqual([Model.Ref.parse("proxy/two")])
  expect(coldEvent.optional).toBe(true)
})

test("the second auto decision without a new prompt does not consult cold and does not arm", async () => {
  const sessionID = "ses_wire2"
  markPromptAdmitted(sessionID)
  const ctx = wiringContext()
  const state = coldState(["proxy/one"])
  const ledger = fakeLedger(requestRow(Date.now() - 70 * 60_000), oneHourFingerprint())
  const first = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
  await Effect.runPromise(decideCompactionFor(ctx, state, first, ledger))
  expect(first.compact).toBe(true)

  // A second auto decision in the same turn: no new prompt, so no cold arming.
  const second = decision({ sessionID: Session.ID.make(sessionID), model: Model.Ref.parse("proxy/chat-model") })
  await Effect.runPromise(decideCompactionFor(ctx, state, second, ledger))
  expect(second.compact).toBeUndefined()
})

test("a 1h-TTL fingerprint is cold only past an hour, not after ten minutes", () => {
  const status = { active: false }
  const cold10 = coldStateOf({ status, now: 10 * 60_000, last: requestRow(0), fingerprint: oneHourFingerprint() })
  expect(cold10.lifetime).toBe(3_600_000)
  expect(isCold(cold10)).toBe(false)
  const cold70 = coldStateOf({ status, now: 70 * 60_000, last: requestRow(0), fingerprint: oneHourFingerprint() })
  expect(isCold(cold70)).toBe(true)
  // Without a fingerprint the lifetime is unknown: never cold.
  expect(isCold(coldStateOf({ status, now: 70 * 60_000, last: requestRow(0) }))).toBe(false)
})
