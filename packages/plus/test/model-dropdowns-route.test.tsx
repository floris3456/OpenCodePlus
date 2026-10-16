// The model-row dropdowns in the production route (plus-1.2.0 B32, I2b): the
// options each one offers and the write each pick makes, on an agent model
// row and on a Defaults › Models row; and OI-2, `d` on a Defaults cold-list item.
import { expect, test } from "bun:test"
import { controlItems } from "./agent-controls-fixture.js"
import { dispatch, expand, moveTo, reach, sleep } from "./instructions-nav.js"
import { createSnapshot, renderInstructionsRoute, type TestFixture } from "./tui.js"

const agent = [{ id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const }]
const agentModel = (providerID: string, modelID: string, fields: { coldCompact?: string; coldModels?: string[] } = {}) => ({
  type: "model" as const,
  level: "project" as const,
  agent: "build",
  providerID,
  modelID,
  ...fields,
  updated: "2026-09-26T00:00:00.000Z",
})
const titles = (options: readonly { readonly title: string }[]) => options.map((option) => option.title)

// Open a row, open its group, and leave the cursor on the group's first field
// and then on `field` (a group named like its field starts on the group).
async function reachField(fixture: TestFixture, row: string, group: string, field: string): Promise<void> {
  await reach(fixture, row, row.endsWith(":*") ? "Every model" : row.split(":").at(-1))
  dispatch(fixture, "return")
  await sleep(80)
  await moveTo(fixture, group)
  await expand(fixture)
  dispatch(fixture, "down")
  await sleep(50)
  await moveTo(fixture, field)
}

const anthropic = "item:defaults:/models:modeldefault:anthropic/claude"
const hostAnthropic = [{ providerID: "anthropic", modelID: "claude", variants: ["high", "low"] }]

test.each([
  { row: anthropic, name: "Input token threshold", field: "compactionInput", value: "120000" },
  { row: "item:defaults:/models:modeldefault:*", name: "Output token threshold", field: "compactionOutput", value: "off" },
])("Defaults Compaction edits $field on $row", async ({ row, name, field, value }) => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ hostModels: hostAnthropic })],
    dialogs: { prompts: [value] },
  })
  await reachField(fixture, row, "Compaction", name)
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(fixture.fake.modelSettingsSets[0]).toMatchObject({ [field]: value })
  expect(fixture.fake.promptInputs[0]?.description).toContain("Empty inherits")
})

test.each([
  { field: "compactionInput", name: "Input token threshold", value: "120000" },
  { field: "compactionOutput", name: "Output token threshold", value: "off" },
])("agent Compaction edits $field through the production route", async ({ field, name, value }) => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: agent, items: controlItems(), records: [{ ...agentModel("acme", "nova"), prompt: "CANARY" }], revision: 1 })],
    dialogs: { prompts: [value] },
  })
  await reachField(fixture, "item:project:build:model:acme/nova", "Compaction", name)
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  expect(fixture.fake.mutateInputs[0]?.records).toContainEqual(expect.objectContaining({ type: "model", agent: "build", [field]: value, prompt: "CANARY" }))
})

test("Defaults › Ping every opens a dropdown of the model's lifetime list, Inherit naming the value below, and writes the pick", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ hostModels: hostAnthropic })],
    dialogs: { selects: ["2m"] },
  })
  await reachField(fixture, anthropic, "Warming", "Ping every")
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(fixture.fake.selectInputs[0]?.title).toBe("Ping every · anthropic/claude")
  expect(titles(fixture.fake.selectInputs[0]?.options ?? [])).toEqual([
    "Inherit (now 4m · built-in)", "1m", "2m", "3m", "4m", "4m30s", "Custom…",
  ])
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ providerID: "anthropic", modelID: "claude", interval: "2m" }))
  expect(fixture.fake.promptInputs).toEqual([])
})

test("Defaults › Warming offers the fixed times and writes Inherit as a cleared field, Off as off", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ hostModels: hostAnthropic })],
    dialogs: { selects: ["", "off"] },
  })
  await reachField(fixture, anthropic, "Warming", "Warming")
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(titles(fixture.fake.selectInputs[0]?.options ?? [])).toEqual([
    "Inherit", "Off", "On", "15m", "30m", "45m", "1h", "1h30m", "2h", "4h", "8h", "Custom…",
  ])
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ warming: null }))
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 2)
  expect(fixture.fake.modelSettingsSets[1]).toEqual(expect.objectContaining({ warming: "off" }))
})

test("Defaults › Warming Custom… opens the one-line prompt and writes what it returns", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ hostModels: hostAnthropic })],
    dialogs: { selects: ["custom…"], prompts: ["45m"] },
  })
  await reachField(fixture, anthropic, "Warming", "Warming")
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Warming · anthropic/claude"])
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ warming: "45m" }))
})

test("Defaults › Effort opens the model's variants as its dropdown and writes the pick", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ hostModels: hostAnthropic })],
    dialogs: { selects: ["low"] },
  })
  await reach(fixture, anthropic, "claude")
  dispatch(fixture, "return")
  await sleep(80)
  await moveTo(fixture, "Effort")
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(titles(fixture.fake.selectInputs[0]?.options ?? [])).toEqual(["(inherit / none)", "high", "low"])
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ effort: "low" }))
})

test("Defaults › Compaction › Model opens a picker with Inherit first; Inherit clears the field", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ hostModels: hostAnthropic })],
    models: [{ providerID: "openai", modelID: "gpt-6", name: "GPT 6" }],
    dialogs: { selects: [""] },
  })
  await reachField(fixture, anthropic, "Compaction", "Model")
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(fixture.fake.selectInputs[0]?.title).toBe("Model provider")
  expect(titles(fixture.fake.selectInputs[0]?.options ?? [])).toEqual(["Inherit", "openai"])
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ compactionModel: null }))
  expect(fixture.fake.promptInputs).toEqual([])
})

test("Defaults › Compaction › Model picks a catalogue model", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ hostModels: hostAnthropic })],
    models: [{ providerID: "openai", modelID: "gpt-6", name: "GPT 6" }],
    dialogs: { selects: ["openai", "gpt-6"] },
  })
  await reachField(fixture, anthropic, "Compaction", "Model")
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(titles(fixture.fake.selectInputs[1]?.options ?? [])).toEqual(["GPT 6 (gpt-6)"])
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ compactionModel: "openai/gpt-6" }))
})

for (const [providerID, modelID, options] of [
  ["acme", "nova", ["Inherit (now 4m · built-in)", "1m", "2m", "3m", "4m", "4m30s", "Custom…"]],
  // Provider/model names alone do not establish a cache lifetime.
  ["openai", "gpt-6", ["Inherit (now 4m · built-in)", "1m", "2m", "3m", "4m", "4m30s", "Custom…"]],
] as const) {
  test(`agent ${providerID}/${modelID} Ping every opens its lifetime's dropdown and writes the pick on the row`, async () => {
    const row = `item:project:build:model:${providerID}/${modelID}`
    await using fixture = await renderInstructionsRoute({
      snapshots: [createSnapshot({ agents: agent, items: controlItems(), records: [agentModel(providerID, modelID)], revision: 1 })],
      dialogs: { selects: [options[2]] },
    })
    await reachField(fixture, row, "Warming", "Ping every")
    dispatch(fixture, "return")
    await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
    expect(titles(fixture.fake.selectInputs[0]?.options ?? [])).toEqual([...options])
    expect(fixture.fake.mutateInputs[0]?.records).toContainEqual(expect.objectContaining({ type: "model", agent: "build", providerID, modelID, interval: options[2] }))
  })
}

test("agent Warming writes On as the pick", async () => {
  const row = "item:project:build:model:acme/nova"
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: agent, items: controlItems(), records: [agentModel("acme", "nova")], revision: 1 })],
    dialogs: { selects: ["on"] },
  })
  await reachField(fixture, row, "Warming", "Warming")
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  expect(fixture.fake.selectInputs[0]?.options.map((option) => option.title).slice(0, 3)).toEqual(["Inherit", "Off", "On"])
  expect(fixture.fake.mutateInputs[0]?.records).toContainEqual(expect.objectContaining({ type: "model", providerID: "acme", modelID: "nova", warming: "on" }))
})

test("agent Warming Inherit clears a stored warming value", async () => {
  const row = "item:project:build:model:acme/nova"
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: agent, items: controlItems(), records: [{ ...agentModel("acme", "nova"), warming: "on" }], revision: 1 })],
    dialogs: { selects: [""] },
  })
  await reachField(fixture, row, "Warming", "Warming")
  dispatch(fixture, "return")
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  expect(fixture.fake.mutateInputs[0]?.records.find((record) => record.type === "model")?.warming).toBeUndefined()
})

test("agent Ping every Custom… opens the prompt, and its validation still refuses a bad time", async () => {
  const row = "item:project:build:model:acme/nova"
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: agent, items: controlItems(), records: [agentModel("acme", "nova")], revision: 1 })],
    dialogs: { selects: ["custom…"], prompts: ["soon"] },
  })
  await reachField(fixture, row, "Warming", "Ping every")
  dispatch(fixture, "return")
  await fixture.waitForFrame((frame) => frame.includes("not an interval"))
  expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Ping every · acme/nova"])
  expect(fixture.fake.mutateInputs).toEqual([])
})

test("OI-2: d on a Defaults › Models cold-list item removes that model and writes the rest", async () => {
  const cold = "item:defaults:/models:modelcold:anthropic/claude:cold:0"
  await using fixture = await renderInstructionsRoute({
    snapshots: [
      createSnapshot({
        hostModels: hostAnthropic,
        modelSettings: [{ type: "modelSettings" as const, level: "defaults" as const, providerID: "anthropic", modelID: "claude", coldCompact: "on", coldModels: ["a/one", "b/two"], updated: "2026-09-26T00:00:00.000Z" }],
      }),
    ],
  })
  await reach(fixture, cold, "a/one")
  dispatch(fixture, "d")
  await fixture.waitForFrame(() => fixture.fake.modelSettingsSets.length === 1)
  expect(fixture.fake.modelSettingsSets[0]).toEqual(expect.objectContaining({ providerID: "anthropic", modelID: "claude", coldModels: ["b/two"] }))
  expect(fixture.captureCharFrame()).not.toContain("is not a Defaults › Models row")
})

test("d on an agent model's cold-list item still removes that one model", async () => {
  const list = ["a/one", "b/two"]
  const row = "item:project:build:model:acme/nova"
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: agent, items: controlItems(), records: [agentModel("acme", "nova", { coldCompact: "on", coldModels: list })], revision: 1 })],
  })
  await reach(fixture, row, "acme/nova")
  dispatch(fixture, "return")
  await sleep(80)
  await moveTo(fixture, "Warming")
  await expand(fixture)
  await moveTo(fixture, "Cold-cache models")
  await expand(fixture)
  await moveTo(fixture, "1 a/one")
  dispatch(fixture, "d")
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  expect(fixture.fake.mutateInputs[0]?.records.find((record) => record.type === "model")?.coldModels).toEqual(["b/two"])
})
