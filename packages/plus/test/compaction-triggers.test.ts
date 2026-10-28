import { expect, test } from "bun:test"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { decideCompactionTriggers } from "../src/compaction/triggers.js"
import { decideCompaction } from "../src/compaction/decide.js"
import type { ModelSettingsRecord } from "../src/instructions/model-settings.js"
import { TEAM_CONTEXT_TOKENS } from "../src/teams/schema.js"

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

test("a team member with no threshold row compacts at the team's 400k, an explicit row still decides, a non-team agent is unchanged", () => {
  const every = (overrides: Partial<ModelSettingsRecord>): ModelSettingsRecord => ({
    type: "modelSettings",
    level: "defaults",
    updated: "2026-10-11",
    ...overrides,
  })
  const at = (input: number, context: Parameters<typeof decideCompaction>[1] = {}) => {
    const event = decision({ metrics: { input, output: 0, advanced: true } })
    decideCompaction(event, context)
    return event.compact === true
  }
  // No row: the team default, inclusively.
  expect(at(TEAM_CONTEXT_TOKENS - 1, { team: true })).toBe(false)
  expect(at(TEAM_CONTEXT_TOKENS, { team: true })).toBe(true)
  expect(at(900_000, { team: true })).toBe(true)
  // An explicit row at any level wins, including off.
  const row = { compactionInput: { value: "750000", level: "project" as const } }
  expect(at(TEAM_CONTEXT_TOKENS, { team: true, rows: row })).toBe(false)
  expect(at(750_000, { team: true, rows: row })).toBe(true)
  expect(at(900_000, { team: true, rows: { compactionInput: { value: "off", level: "project" as const } } })).toBe(false)
  expect(at(750_000, { team: true, every: every({ compactionInput: "750000" }) })).toBe(true)
  // A non-team agent keeps today's behaviour: no row, no early trigger.
  expect(at(900_000, {})).toBe(false)
  expect(at(900_000, { team: false })).toBe(false)
  expect(at(750_000, { every: every({ compactionInput: "750000" }) })).toBe(true)
  // Off is no threshold for a non-team agent too.
  expect(at(900_000, { every: every({ compactionInput: "off" }) })).toBe(false)
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
