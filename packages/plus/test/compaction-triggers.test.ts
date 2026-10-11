import { expect, test } from "bun:test"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import { decideCompactionTriggers } from "../src/compaction/triggers.js"
import { decideCompaction } from "../src/compaction/decide.js"
import type { ModelSettingsRecord } from "../src/instructions/model-settings.js"
import { Plus } from "../src/rpc.js"

const decision = (overrides: Partial<SessionCompactionDecision> = {}): SessionCompactionDecision => ({
  sessionID: Session.ID.make("ses_threshold"),
  agent: Agent.ID.make("build"),
  model: Model.Ref.parse("test/model"),
  reason: "auto",
  auto: true,
  due: false,
  boundary: { fresh: true, portable: true },
  metrics: { input: 100, output: 30, advanced: true },
  ...overrides,
})

test("RPC threshold schema accepts positive integers, null clears and absent preserves, refusing invalid counts", () => {
  const decode = Schema.decodeUnknownSync(Plus.CompactionTriggersSetInput)
  expect(decode({ sessionID: "ses_threshold" })).toEqual({ sessionID: "ses_threshold" })
  expect(decode({ sessionID: "ses_threshold", input: 1, output: null })).toEqual({
    sessionID: "ses_threshold",
    input: 1,
    output: null,
  })
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "", "100"])
    for (const field of ["input", "output"])
      expect(() => decode({ sessionID: "ses_threshold", [field]: value })).toThrow()
  expect(Schema.encodeSync(Plus.CompactionTriggers)({ sessionID: "ses_threshold" })).toEqual({
    sessionID: "ses_threshold",
  })
})

test("either inclusive early threshold arms only compaction, preserving strategy, model and system", () => {
  for (const triggers of [{ input: 100 }, { output: 30 }]) {
    const event = decision({
      strategy: "remote",
      system: "Original system",
      compactionModel: Model.Ref.parse("test/summary"),
    })
    const before = structuredClone(event)
    decideCompactionTriggers(event, { sessionID: event.sessionID, ...triggers })
    expect(event.compact).toBe(true)
    expect(event.explanation).toEqual({
      trigger: "input" in triggers ? "input-threshold" : "output-threshold",
      threshold: "input" in triggers ? 100 : 30,
    })
    expect(event).toEqual({ ...before, compact: true, explanation: event.explanation })
  }
  const event = decision()
  decideCompactionTriggers(event, { sessionID: event.sessionID, input: 101, output: 31 })
  expect(event.compact).toBeUndefined()
  decideCompactionTriggers(event, { sessionID: event.sessionID })
  expect(event.compact).toBeUndefined()
})

test("manual, overflow, safety threshold, auto:false, cold/armed/quota and fresh native checkpoints retain precedence", () => {
  for (const overrides of [
    { reason: "manual" as const },
    { reason: "overflow" as const },
    { auto: false },
    { due: true },
    { compact: true, explanation: { trigger: "cold" as const } },
    { compact: true, explanation: { trigger: "armed" as const } },
    { compact: true, metadata: { "quota.switch": true }, explanation: { trigger: "handoff" as const } },
    { metrics: { input: 100, output: 30, advanced: false }, boundary: { fresh: false, portable: false } },
    { metrics: undefined },
  ]) {
    const event = decision(overrides)
    const before = structuredClone(event)
    decideCompactionTriggers(event, { sessionID: event.sessionID, input: 1, output: 1 })
    expect(event).toEqual(before)
  }
})

test("model thresholds fire inclusively, chat values override per field, and off suppresses inherited triggers", () => {
  const every: ModelSettingsRecord = { type: "modelSettings", level: "defaults", updated: "2026-10-11", compactionInput: "100", compactionOutput: "30" }
  const input = decision()
  decideCompaction(input, { every })
  expect(input.explanation).toMatchObject({ trigger: "input-threshold", threshold: 100 })
  const output = decision()
  decideCompaction(output, { every, triggers: { input: 101 } })
  expect(output.explanation).toMatchObject({ trigger: "output-threshold", threshold: 30 })
  const chat = decision()
  decideCompaction(chat, { every, triggers: { input: 101, output: 31 } })
  expect(chat.compact).toBeUndefined()
  const off = decision()
  decideCompaction(off, { every, rows: { compactionInput: { value: "off", level: "project" }, compactionOutput: { value: "off", level: "global" } } })
  expect(off.compact).toBeUndefined()
  const overridden = decision()
  decideCompaction(overridden, { model: { ...every, compactionInput: "off", compactionOutput: "off" }, triggers: { output: 30 } })
  expect(overridden.explanation).toMatchObject({ trigger: "output-threshold", threshold: 30 })
  for (const overrides of [{ auto: false }, { reason: "manual" as const }, { reason: "overflow" as const }, { due: true }, { metrics: { input: 100, output: 30, advanced: false } }]) {
    const event = decision(overrides)
    decideCompaction(event, { every })
    expect(event.compact).toBeUndefined()
  }
})
