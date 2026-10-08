// I2c: Defaults › Models rows are built once per memo (one memo per snapshot),
// so a second pass over the same memo and a pass on a fresh memo with the same
// store read the same views, and a store write shows on the row it changed.
import { expect, test } from "bun:test"
import { MODELS_GROUP_ID, type HostModel, type ModelSettingsRecord } from "../src/instructions/model-settings.js"
import { buildTreeMemo, collectSkeleton, skeletonOf, treeOf, type MemoInput } from "../src/instructions/tree.js"
import { toolCountOf } from "../src/tui/instructions/workspace.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

const record = (overrides: Partial<ModelSettingsRecord>): ModelSettingsRecord => ({
  type: "modelSettings",
  level: "defaults",
  updated: UPDATED,
  ...overrides,
})

const host = (overrides: Partial<HostModel>): HostModel => ({
  providerID: "anthropic",
  modelID: "claude",
  variants: [],
  ...overrides,
})

function inputWith(modelSettings: ModelSettingsRecord[]): MemoInput {
  return {
    items: [],
    records: [],
    agents: [],
    modelSettings,
    hostModels: [host({}), host({ providerID: "deepseek", modelID: "v4-flash" })],
  }
}

// The Defaults › Models rows: the Models group opened, so each model row is emitted.
function modelRowsOf(memo: ReturnType<typeof buildTreeMemo>) {
  const open = new Set(["root:defaults", MODELS_GROUP_ID])
  return treeOf(memo, open).filter((row) => row.id.startsWith("item:defaults:/models:modeldefault:"))
}

// A model's Warming group, whose value is its summary: every row opened so the group is emitted.
function warmingSummaryOf(memo: ReturnType<typeof buildTreeMemo>, model: string): string | undefined {
  const open = new Set(collectSkeleton(skeletonOf(memo)).map((node) => node.id))
  return treeOf(memo, open).find((row) => row.label === "Warming" && row.id.includes(model))?.badges.value
}

test("building the Defaults › Models rows twice on one memo computes each row's view once", () => {
  const memo = buildTreeMemo(inputWith([record({ providerID: "anthropic", modelID: "claude", warming: "on", interval: "4m" })]))
  const first = modelRowsOf(memo)
  expect(first.map((row) => row.label)).toEqual(["Every model", "anthropic/claude", "deepseek/v4-flash"])
  const views = new Map(memo.modelViewCache)
  expect(views.size).toBe(3)

  const second = modelRowsOf(memo)
  expect(second.map((row) => row.badges.value)).toEqual(first.map((row) => row.badges.value))
  for (const [id, view] of views) expect(memo.modelViewCache?.get(id)).toBe(view)
})

test("a store write that changes one model's settings shows on that row in the next memo only", () => {
  const before = buildTreeMemo(inputWith([]))
  const after = buildTreeMemo(inputWith([record({ providerID: "anthropic", modelID: "claude", warming: "on", interval: "4m" })]))
  expect(warmingSummaryOf(before, "anthropic/claude")).toBe("off")
  expect(warmingSummaryOf(after, "anthropic/claude")).toContain("every 4m")
  expect(warmingSummaryOf(after, "deepseek/v4-flash")).toBe("off")
})

test("a catalogue key with a suffix resolves its group, and a group without tools counts none", () => {
  const memo = buildTreeMemo(inputWith([]))
  expect(toolCountOf(memo, `${MODELS_GROUP_ID}#models`, () => false)).toBeUndefined()
})
