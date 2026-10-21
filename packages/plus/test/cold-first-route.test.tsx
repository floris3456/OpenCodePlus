// Compact cold chats first per model in the production route: Space on the
// switch row writes on/off from what the row shows ("as in Settings" counts as
// off), and r clears it, on an agent model row and on a Defaults › Models row.
import { expect, test } from "bun:test"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { expandedTree } from "../src/instructions/tree.js"
import { notesOf } from "../src/tui/instructions/inspector.js"
import { controlItems } from "./agent-controls-fixture.js"
import { dispatch, reach, selectedRow } from "./instructions-nav.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"

const agent = [{ id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const }]
const agentModel = (fields: { coldFirst?: string } = {}) => ({
  type: "model" as const,
  level: "project" as const,
  agent: "build",
  providerID: "acme",
  modelID: "nova",
  prompt: "CANARY",
  ...fields,
  updated: "2026-09-26T00:00:00.000Z",
})
const hostAnthropic = [{ providerID: "anthropic", modelID: "claude", variants: [] }]
const settings = (fields: { providerID?: string; modelID?: string; coldFirst: string }) => ({
  type: "modelSettings" as const,
  level: "defaults" as const,
  ...fields,
  updated: "2026-09-26T00:00:00.000Z",
})
const agentRow = "item:project:build:modelfield:coldFirst:acme/nova"
// Wide enough that the nested agent field row shows its whole label and value.
const width = 160
const defaultsRow = "item:defaults:/models:modelsetting:coldFirst:anthropic/claude"

test("the inspector says the Settings switch decides below the model rows, not a built-in value", () => {
  const snapshot = createSnapshot({ agents: agent, items: controlItems(), records: [agentModel()], hostModels: hostAnthropic })
  const nodes = expandedTree(memoInputOf(snapshot))
  for (const id of [agentRow, defaultsRow]) {
    const node = nodes.find((entry) => entry.id === id)
    if (node === undefined) throw new Error(`missing ${id}`)
    const notes = notesOf(node, snapshot).join(" ")
    expect(notes).toContain("it overrides Settings › OpenCodePlus › Compact cold chats first; where no row sets it, that switch decides (as in Settings)")
    expect(notes).toContain("Space switches it on or off; r restores inheritance.")
    expect(notes).not.toContain("built-in")
    expect(notes).not.toContain("Enter edits")
  }
})

test("Space on an agent model's Compact cold chats first writes on from as in Settings", async () => {
  await using fixture = await renderInstructionsRoute({
    width,
    snapshots: [createSnapshot({ agents: agent, items: controlItems(), records: [agentModel()], revision: 1 })],
  })
  await reach(fixture, agentRow, "Compact cold chats first")
  expect(selectedRow(fixture.captureCharFrame())).toContain("as in Settings")
  expect(dispatch(fixture, "space")).toBe(true)
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  expect(fixture.fake.mutateInputs[0]?.records).toContainEqual(expect.objectContaining({ type: "model", agent: "build", modelID: "nova", coldFirst: "on", prompt: "CANARY" }))
})

test("Space on an agent model's own on writes off", async () => {
  await using fixture = await renderInstructionsRoute({
    width,
    snapshots: [createSnapshot({ agents: agent, items: controlItems(), records: [agentModel({ coldFirst: "on" })], revision: 1 })],
  })
  await reach(fixture, agentRow, "Compact cold chats first")
  dispatch(fixture, "space")
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  expect(fixture.fake.mutateInputs[0]?.records.find((record) => record.type === "model")).toMatchObject({ coldFirst: "off", prompt: "CANARY" })
})

test("r on an agent model's Compact cold chats first drops it and keeps the rest of the row", async () => {
  await using fixture = await renderInstructionsRoute({
    width,
    snapshots: [createSnapshot({ agents: agent, items: controlItems(), records: [agentModel({ coldFirst: "off" })], revision: 1 })],
  })
  await reach(fixture, agentRow, "Compact cold chats first")
  expect(selectedRow(fixture.captureCharFrame())).toMatch(/Compact cold chats first\s+off/)
  expect(dispatch(fixture, "r")).toBe(true)
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  const reset = fixture.fake.mutateInputs[0]?.records.find((record) => record.type === "model")
  expect(reset).not.toHaveProperty("coldFirst")
  expect(reset).toMatchObject({ providerID: "acme", modelID: "nova", prompt: "CANARY" })
})

test("Space on a Defaults › Models Compact cold chats first writes on from as in Settings", async () => {
  await using fixture = await renderInstructionsRoute({ width, snapshots: [createSnapshot({ hostModels: hostAnthropic })] })
  await reach(fixture, defaultsRow, "Compact cold chats first")
  expect(selectedRow(fixture.captureCharFrame())).toContain("as in Settings")
  expect(dispatch(fixture, "space")).toBe(true)
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ providerID: "anthropic", modelID: "claude", coldFirst: "on" }))
})

test("Space on a Defaults › Models Compact cold chats first inheriting on from Every model writes off", async () => {
  await using fixture = await renderInstructionsRoute({ width, snapshots: [createSnapshot({ hostModels: hostAnthropic, modelSettings: [settings({ coldFirst: "on" })] })] })
  await reach(fixture, defaultsRow, "Compact cold chats first")
  expect(selectedRow(fixture.captureCharFrame())).toContain("on · every model")
  dispatch(fixture, "space")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ providerID: "anthropic", modelID: "claude", coldFirst: "off" }))
})

test("r on a Defaults › Models Compact cold chats first clears it", async () => {
  await using fixture = await renderInstructionsRoute({
    width,
    snapshots: [createSnapshot({ hostModels: hostAnthropic, modelSettings: [settings({ providerID: "anthropic", modelID: "claude", coldFirst: "off" })] })],
  })
  await reach(fixture, defaultsRow, "Compact cold chats first")
  dispatch(fixture, "r")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ providerID: "anthropic", modelID: "claude", coldFirst: null }))
})
