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
  const after = buildTreeMemo(inputWith([record({ providerID: "anthropic", modelID: "claude", warming: "off" })]))
  // Claude warms built in: every 4m for 30m (32m in whole intervals).
  expect(warmingSummaryOf(before, "anthropic/claude")).toBe("32m · every 4m")
  expect(warmingSummaryOf(after, "anthropic/claude")).toBe("off")
  expect(warmingSummaryOf(after, "deepseek/v4-flash")).toBe("off")
})

// Every row opened, so each Defaults › Models row's field rows are emitted.
function openRowsOf(memo: ReturnType<typeof buildTreeMemo>) {
  return treeOf(memo, new Set(collectSkeleton(skeletonOf(memo)).map((node) => node.id)))
}

test("every Defaults › Models row has Compact cold chats first after Compact before cold, as in Settings when unset", () => {
  const rows = openRowsOf(buildTreeMemo(inputWith([])))
  for (const key of ["*", "anthropic/claude", "deepseek/v4-flash"]) {
    const at = rows.findIndex((row) => row.id === `item:defaults:/models:modelsetting:compactWarm:${key}`)
    expect(rows.slice(at, at + 3).map((row) => row.id)).toEqual([
      `item:defaults:/models:modelsetting:compactWarm:${key}`,
      `item:defaults:/models:modelsetting:coldFirst:${key}`,
      `group:defaults:/models:modeldefault:${key}:cold`,
    ])
    const coldFirst = rows[at + 1]
    expect(coldFirst?.label).toBe("Compact cold chats first")
    expect(coldFirst?.depth).toBe(4)
    expect(coldFirst?.badges.value).toBe("as in Settings")
    expect(coldFirst?.badges.modified).toBeUndefined()
    expect(coldFirst?.actions).toEqual({ toggle: true, edit: false, reset: false, remove: false, split: false, pin: false })
  }
})

test("a Defaults › Models Compact cold chats first shows its own value, or Every model's with the source", () => {
  const value = (records: ModelSettingsRecord[], key: string) =>
    openRowsOf(buildTreeMemo(inputWith(records))).find((row) => row.id === `item:defaults:/models:modelsetting:coldFirst:${key}`)
  const every = record({ coldFirst: "on" })
  expect(value([every], "*")?.badges).toMatchObject({ value: "on", modified: true })
  expect(value([every], "*")?.actions?.reset).toBe(true)
  expect(value([every], "anthropic/claude")?.badges.value).toBe("on · every model")
  expect(value([every], "anthropic/claude")?.actions?.reset).toBe(false)
  const claude = record({ providerID: "anthropic", modelID: "claude", coldFirst: "off" })
  expect(value([every, claude], "anthropic/claude")?.badges).toMatchObject({ value: "off", modified: true })
  expect(value([every, claude], "deepseek/v4-flash")?.badges.value).toBe("on · every model")
  // Only this model sets it: the rest still follow the Settings switch.
  expect(value([claude], "deepseek/v4-flash")?.badges.value).toBe("as in Settings")
  expect(value([claude], "*")?.badges.value).toBe("as in Settings")
})

test("a catalogue key with a suffix resolves its group, and a group without tools counts none", () => {
  const memo = buildTreeMemo(inputWith([]))
  expect(toolCountOf(memo, `${MODELS_GROUP_ID}#models`, () => false)).toBeUndefined()
})
