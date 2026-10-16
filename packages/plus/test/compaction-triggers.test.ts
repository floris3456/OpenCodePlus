import { expect, test } from "bun:test"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { decideCompactionTriggers } from "../src/compaction/triggers.js"
import { decideCompaction } from "../src/compaction/decide.js"
import type { ModelSettingsRecord } from "../src/instructions/model-settings.js"

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

test("either inclusive early threshold arms only compaction, preserving strategy, model and system", () => {
  for (const triggers of [{ input: 100 }, { output: 30 }]) {
    const event = decision({
      strategy: "remote",
      system: "Original system",
      compactionModel: Model.Ref.parse("test/summary"),
    })
    const before = structuredClone(event)
    decideCompactionTriggers(event, triggers)
    expect(event.compact).toBe(true)
    expect(event.explanation).toEqual({
      trigger: "input" in triggers ? "input-threshold" : "output-threshold",
      threshold: "input" in triggers ? 100 : 30,
    })
    expect(event).toEqual({ ...before, compact: true, explanation: event.explanation })
  }
  const event = decision()
  decideCompactionTriggers(event, { input: 101, output: 31 })
  expect(event.compact).toBeUndefined()
  decideCompactionTriggers(event, {})
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
    decideCompactionTriggers(event, { input: 1, output: 1 })
    expect(event).toEqual(before)
  }
})

test("model thresholds fire inclusively, the agent's model row and this model override Every model per field, and off suppresses", () => {
  const every: ModelSettingsRecord = { type: "modelSettings", level: "defaults", updated: "2026-10-11", compactionInput: "100", compactionOutput: "30" }
  const input = decision()
  decideCompaction(input, { every })
  expect(input.explanation).toMatchObject({ trigger: "input-threshold", threshold: 100 })
  // Defaults › Models › this model raises only the input threshold: output still fires.
  const output = decision()
  decideCompaction(output, { every, model: { ...every, compactionInput: "101", compactionOutput: undefined } })
  expect(output.explanation).toMatchObject({ trigger: "output-threshold", threshold: 30 })
  // The agent's model row raises both: nothing fires.
  const row = decision()
  decideCompaction(row, { every, rows: { compactionInput: { value: "101", level: "project" }, compactionOutput: { value: "31", level: "project" } } })
  expect(row.compact).toBeUndefined()
  const off = decision()
  decideCompaction(off, { every, rows: { compactionInput: { value: "off", level: "project" }, compactionOutput: { value: "off", level: "global" } } })
  expect(off.compact).toBeUndefined()
  for (const overrides of [{ auto: false }, { reason: "manual" as const }, { reason: "overflow" as const }, { due: true }, { metrics: { input: 100, output: 30, advanced: false } }]) {
    const event = decision(overrides)
    decideCompaction(event, { every })
    expect(event.compact).toBeUndefined()
  }
})
