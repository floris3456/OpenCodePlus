import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { controlItems, controlRecord, controlSnapshot } from "./agent-controls-fixture.js"
import { renderInstructionsRoute, type TestFixture } from "./tui.js"

const build = Agent.Info.default(Agent.ID.make("build"))

function dispatch(fixture: TestFixture, key: string): boolean {
  const command = fixture.commands().find((command) => command.bind === key)
  if (command === undefined) return false
  void command.run()
  return true
}

function selected(frame: string): string {
  return frame.split("\n").find((line) => line.includes("›")) ?? ""
}

async function filterTo(fixture: TestFixture, id: string, label: string): Promise<void> {
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  expect(dispatch(fixture, "/")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes(`Filter: id:${id}`))
  for (let step = 0; step < 15; step++) {
    const before = selected(fixture.captureCharFrame())
    if (before.includes(label)) return
    dispatch(fixture, "down")
    await fixture.waitForFrame((frame) => selected(frame) !== before)
  }
  throw new Error(`Did not reach ${id}`)
}

for (const width of [80, 120]) {
  test(`Enter cycles Mode Primary → Subagent → All in the production route at ${width} columns`, async () => {
    const id = "item:project:build:setting:mode"
    await using fixture = await renderInstructionsRoute({
      width,
      snapshots: [
        controlSnapshot(),
        controlSnapshot([controlRecord("setting:mode", { text: "subagent" })], { revision: 2 }),
        controlSnapshot([controlRecord("setting:mode", { text: "all" })], { revision: 3 }),
        controlSnapshot([controlRecord("setting:mode", { text: "primary" })], { revision: 4 }),
      ],
      dialogs: { prompts: [`id:${id}`] },
    })
    await filterTo(fixture, id, "Mode")
    for (const [index, value] of ["subagent", "all", "primary"].entries()) {
      expect(dispatch(fixture, "return")).toBe(true)
      await fixture.waitForFrame((frame) => fixture.fake.mutateInputs.length === index + 1 && selected(frame).includes(value[0].toUpperCase() + value.slice(1)))
      expect(fixture.fake.mutateInputs[index].records).toContainEqual(expect.objectContaining({
        type: "customization", level: "project", agent: "build", item: "setting:mode", text: value,
      }))
      expect(selected(fixture.captureCharFrame())).toContain(value[0].toUpperCase() + value.slice(1))
      expect(fixture.renderer.currentFocusedEditor).toBeNull()
      expect(dispatch(fixture, "e")).toBe(false)
    }
    expect(fixture.fake.mutateInputs.map((input) => input.expectedRevision)).toEqual([1, 2, 3])
  })
}

test("Enter cycles Strategy Auto → Local → Remote and back without deleting saved local customization", async () => {
  const id = "item:project:build:compaction:strategy"
  const saved = [
    controlRecord("compaction:model", { text: "acme/small" }),
    controlRecord("compaction:instructions", { text: "Keep decisions and tests." }),
  ]
  await using fixture = await renderInstructionsRoute({
    snapshots: [
      controlSnapshot(saved),
      ...["local", "remote", "auto"].map((text, index) => controlSnapshot([
        ...saved, controlRecord("compaction:strategy", { text }),
      ], { revision: index + 2 })),
    ],
    dialogs: { prompts: [`id:${id}`] },
  })
  await filterTo(fixture, id, "Strategy")
  for (const [index, text] of ["local", "remote", "auto"].entries()) {
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => fixture.fake.mutateInputs.length === index + 1 && !frame.includes("Loading…"))
    const records = fixture.fake.mutateInputs[index].records
    expect(records).toContainEqual(expect.objectContaining({ item: "compaction:strategy", text }))
    for (const record of saved) expect(records).toContainEqual(record)
  }
})

test("Enter on Mode still cycles after opening its narrow detail pane", async () => {
  const id = "item:project:build:setting:mode"
  await using fixture = await renderInstructionsRoute({
    width: 80,
    snapshots: [
      controlSnapshot(),
      controlSnapshot([controlRecord("setting:mode", { text: "subagent" })], { revision: 2 }),
    ],
    dialogs: { prompts: [`id:${id}`] },
  })
  await filterTo(fixture, id, "Mode")
  dispatch(fixture, "right")
  await fixture.waitForFrame((frame) => frame.includes("back to tree"))
  expect(dispatch(fixture, "return")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("Value: Subagent"))
  expect(fixture.fake.mutateInputs[0].records).toContainEqual(expect.objectContaining({ item: "setting:mode", text: "subagent" }))
})

test("Space toggles an agent and its Enabled row; Hidden stays distinct; ctrl+space preserves agent selection", async () => {
  const agent = "agent:project:build"
  const enabled = "item:project:build:setting:enabled"
  const hidden = "item:project:build:setting:hidden"
  await using fixture = await renderInstructionsRoute({
    agents: [build],
    snapshots: [
      controlSnapshot(),
      controlSnapshot([controlRecord("setting:enabled", { state: "off" })], { revision: 2 }),
      controlSnapshot([controlRecord("setting:enabled", { state: "on" })], { revision: 3 }),
      controlSnapshot([
        controlRecord("setting:enabled", { state: "on" }), controlRecord("setting:hidden", { state: "on" }),
      ], { revision: 4 }),
    ],
    dialogs: { prompts: [`id:${agent}`, `id:${enabled}`, `id:${hidden}`, `id:${agent}`] },
  })
  await filterTo(fixture, agent, "build")
  expect(dispatch(fixture, "ctrl+space")).toBe(true)
  expect(fixture.fake.agentSelects).toEqual(["build"])
  dispatch(fixture, "space")
  await fixture.waitForFrame((frame) => selected(frame).includes("[off]"))
  fixture.emitAgents([])
  expect(fixture.fake.mutateInputs[0].records).toContainEqual(expect.objectContaining({ item: "setting:enabled", state: "off" }))
  expect(dispatch(fixture, "ctrl+space")).toBe(false)
  await filterTo(fixture, enabled, "Enabled")
  dispatch(fixture, "space")
  await fixture.waitForFrame((frame) => selected(frame).includes("[on]"))
  fixture.emitAgents([build])
  expect(fixture.fake.mutateInputs[1].records).toContainEqual(expect.objectContaining({ item: "setting:enabled", state: "on" }))
  await filterTo(fixture, hidden, "Hidden")
  dispatch(fixture, "space")
  await fixture.waitForFrame((frame) => selected(frame).includes("[on]"))
  fixture.emitAgents([{ ...build, hidden: true }])
  await filterTo(fixture, agent, "build")
  expect(selected(fixture.captureCharFrame())).toContain("[hidden]")
  expect(selected(fixture.captureCharFrame())).toContain("[on]")
  expect(dispatch(fixture, "ctrl+space")).toBe(false)
  expect(fixture.fake.agentSelects).toEqual(["build"])
})

for (const level of ["global", "defaults"] as const) {
  for (const control of [
    { item: "setting:enabled", blocked: { state: "off" as const }, restored: { state: "on" as const }, agents: [], badge: "[off]" },
    { item: "setting:hidden", blocked: { state: "on" as const }, restored: { state: "off" as const }, agents: [{ ...build, hidden: true }], badge: "[hidden]" },
    { item: "setting:mode", blocked: { text: "subagent" }, restored: { text: "primary" }, agents: [{ ...build, mode: "subagent" as const }], badge: "[subagent]" },
  ]) {
    test(`${level} selection follows the effective host catalogue when Project ${control.item} blocks it`, async () => {
      const id = `agent:${level}:build`
      await using fixture = await renderInstructionsRoute({
        agents: control.agents,
        snapshots: [controlSnapshot([controlRecord(control.item, control.blocked)])],
        dialogs: { prompts: [`id:${id}`] },
      })
      await filterTo(fixture, id, "build")
      expect(selected(fixture.captureCharFrame())).toContain("[on]")
      expect(selected(fixture.captureCharFrame())).toContain("[primary]")
      expect(selected(fixture.captureCharFrame())).not.toContain("[hidden]")
      expect(fixture.commands().some((command) => command.bind === "space")).toBe(true)
      expect(fixture.captureCharFrame()).not.toContain("ctrl+space select")
      expect(dispatch(fixture, "ctrl+space")).toBe(false)
      expect(fixture.fake.agentSelects).toEqual([])
      expect(fixture.fake.mutateInputs).toEqual([])
    })

    test(`${level} selection follows the effective host catalogue when Project restores ${control.item}`, async () => {
      const id = `agent:${level}:build`
      await using fixture = await renderInstructionsRoute({
        agents: [build],
        snapshots: [controlSnapshot([
          controlRecord(control.item, { level, ...control.blocked }),
          controlRecord(control.item, control.restored),
        ])],
        dialogs: { prompts: [`id:${id}`] },
      })
      await filterTo(fixture, id, "build")
      expect(selected(fixture.captureCharFrame())).toContain(control.badge)
      expect(fixture.captureCharFrame()).toContain("ctrl+space select")
      expect(dispatch(fixture, "ctrl+space")).toBe(true)
      expect(fixture.fake.agentSelects).toEqual(["build"])
      expect(fixture.fake.mutateInputs).toEqual([])
    })
  }
}

for (const level of ["project", "global", "defaults"]) {
  for (const mode of ["primary", "all"] as const) {
    test(`${mode} host agents can be selected from the ${level} row`, async () => {
      const id = `agent:${level}:build`
      await using fixture = await renderInstructionsRoute({
        agents: [{ ...build, mode }],
        snapshots: [controlSnapshot([controlRecord("setting:mode", { text: mode })])],
        dialogs: { prompts: [`id:${id}`] },
      })
      await filterTo(fixture, id, "build")
      expect(dispatch(fixture, "ctrl+space")).toBe(true)
      expect(fixture.fake.agentSelects).toEqual(["build"])
      expect(fixture.fake.mutateInputs).toEqual([])
    })
  }
}

for (const [id, agent, label] of [
  ["agent:preset:build", "build", "Build"],
  ["team:preset:starter:planner", "planner", "planner"],
  ["agent:defaults:worker", "worker", "worker"],
]) {
  test(`a matching host agent does not make preset or entry ${id} selectable`, async () => {
    await using fixture = await renderInstructionsRoute({
      agents: [Agent.Info.default(Agent.ID.make(agent))],
      snapshots: [controlSnapshot([], {
        entries: [{ type: "entry", level: "defaults", catalogue: "agents", name: "worker", updated: "2026-09-26" }],
      })],
      dialogs: { prompts: [`id:${id}`] },
    })
    await filterTo(fixture, id, label)
    expect(dispatch(fixture, "ctrl+space")).toBe(false)
    expect(fixture.fake.agentSelects).toEqual([])
  })
}

test("host catalogue updates recheck selection commands without changing tier badges or toggles", async () => {
  const id = "agent:global:build"
  await using fixture = await renderInstructionsRoute({
    snapshots: [controlSnapshot()],
    dialogs: { prompts: [`id:${id}`] },
  })
  await filterTo(fixture, id, "build")
  expect(dispatch(fixture, "ctrl+space")).toBe(false)
  fixture.emitAgents([build])
  await fixture.waitForFrame((frame) => frame.includes("ctrl+space select"))
  const select = fixture.commands().find((command) => command.bind === "ctrl+space")
  expect(select).toBeDefined()
  fixture.emitAgents([])
  await fixture.waitForFrame((frame) => !frame.includes("ctrl+space select"))
  void select?.run()
  expect(fixture.fake.agentSelects).toEqual([])
  expect(selected(fixture.captureCharFrame())).toContain("[on]")
  expect(dispatch(fixture, "space")).toBe(true)
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  expect(fixture.fake.mutateInputs[0].records).toContainEqual(expect.objectContaining({ level: "global", item: "setting:enabled", state: "off" }))
})

for (const [item, label, text] of [
  ["setting:description", "Description", "A careful reviewer"],
  ["setting:color", "Color", "#123456"],
  ["setting:steps", "Steps", "12"],
  ["compaction:model", "Model", "acme/compact#fast"],
  ["compaction:instructions", "Instructions", "Keep test evidence.\nKeep pending tasks."],
]) {
  test(`${label} uses the standard detail editor and persists ${item} through state`, async () => {
    const id = `item:project:build:${item}`
    await using fixture = await renderInstructionsRoute({
      snapshots: [controlSnapshot(), controlSnapshot([controlRecord(item, { text })], { revision: 2 })],
      dialogs: { prompts: [`id:${id}`] },
    })
    await filterTo(fixture, id, label)
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    expect(editor).toBeDefined()
    editor?.setText(text)
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes(`Saved "${label}"`) && !frame.includes("ctrl+s save"))
    expect(fixture.fake.mutateInputs[0].records).toContainEqual(expect.objectContaining({ item, text, section: null }))
  })
}

test("Remote fields show retained values and refuse Enter, e, Space and reset in the route", async () => {
  const id = "item:project:build:compaction:model"
  await using fixture = await renderInstructionsRoute({
    snapshots: [controlSnapshot([
      controlRecord("compaction:strategy", { text: "remote" }),
      controlRecord("compaction:model", { text: "acme/small" }),
    ])],
    dialogs: { prompts: [`id:${id}`] },
  })
  await filterTo(fixture, id, "Model")
  expect(fixture.captureCharFrame()).toContain("acme/small")
  expect(fixture.captureCharFrame()).toContain("retained")
  expect(dispatch(fixture, "return")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("choose Auto or Local"))
  expect(dispatch(fixture, "e")).toBe(false)
  expect(dispatch(fixture, "space")).toBe(false)
  expect(dispatch(fixture, "r")).toBe(false)
  expect(fixture.fake.mutateInputs).toEqual([])
})

test("r removes only the current Mode override and exposes global provenance", async () => {
  const id = "item:project:build:setting:mode"
  const global = controlRecord("setting:mode", { level: "global", text: "subagent" })
  await using fixture = await renderInstructionsRoute({
    snapshots: [
      controlSnapshot([global, controlRecord("setting:mode", { text: "all" })]),
      controlSnapshot([global], { revision: 2 }),
    ],
    dialogs: { prompts: [`id:${id}`], confirms: [true] },
  })
  await filterTo(fixture, id, "Mode")
  dispatch(fixture, "r")
  await fixture.waitForFrame((frame) => frame.includes('Reset "Mode"') && frame.includes("from global"))
  expect(fixture.fake.mutateInputs[0].records).toEqual([global])
})

test("r on an agent resets its scoped Settings and Compaction together, retaining global controls", async () => {
  const id = "agent:project:build"
  const global = controlRecord("setting:description", { level: "global", text: "Inherited description" })
  await using fixture = await renderInstructionsRoute({
    snapshots: [
      controlSnapshot([
        global,
        controlRecord("setting:mode", { text: "all" }),
        controlRecord("setting:hidden", { state: "on" }),
        controlRecord("compaction:model", { text: "acme/compact#fast" }),
        controlRecord("compaction:instructions", { text: "Keep tests." }),
      ]),
      controlSnapshot([global], { revision: 2 }),
    ],
    dialogs: { prompts: [`id:${id}`], confirms: [true] },
  })
  await filterTo(fixture, id, "build")
  expect(dispatch(fixture, "r")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes('Reset agent controls for "build"'))
  expect(fixture.fake.mutateInputs[0].records).toEqual([global])
})

test("r on a member-preset entity resets all nine scoped controls while retaining other preset records", async () => {
  const id = "team:preset:starter:planner"
  const retained = [
    controlRecord("setting:description", { level: "preset", agent: "planner", text: "Agent preset" }),
    controlRecord("setting:description", { level: "preset", agent: "planner", team: { level: "preset", team: "other" }, text: "Other member preset" }),
  ]
  await using fixture = await renderInstructionsRoute({
    snapshots: [
      controlSnapshot([
        ...retained,
        ...controlItems().map((item) => controlRecord(item.id, {
          level: "preset", agent: "planner", team: { level: "preset", team: "starter" },
          ...(item.id === "setting:enabled" || item.id === "setting:hidden" ? { state: "off" } : { text: item.text }),
        })),
      ]),
      controlSnapshot(retained, { revision: 2 }),
    ],
    dialogs: { prompts: [`id:${id}`], confirms: [true] },
  })
  await filterTo(fixture, id, "planner")
  expect(dispatch(fixture, "r")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes('Reset agent controls for "planner"'))
  expect(fixture.fake.mutateInputs[0].records).toEqual(retained)
  expect(dispatch(fixture, "r")).toBe(false)
})

test("saving empty compaction instructions creates an explicit empty prompt instead of resetting", async () => {
  const id = "item:project:build:compaction:instructions"
  const global = controlRecord("compaction:instructions", { level: "global", text: "Inherited summary prompt" })
  await using fixture = await renderInstructionsRoute({
    snapshots: [controlSnapshot([global]), controlSnapshot([global, controlRecord("compaction:instructions", { text: "" })], { revision: 2 })],
    dialogs: { prompts: [`id:${id}`] },
  })
  await filterTo(fixture, id, "Instructions")
  dispatch(fixture, "return")
  await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
  fixture.renderer.currentFocusedEditor?.setText("")
  dispatch(fixture, "ctrl+s")
  await fixture.waitForFrame((frame) => frame.includes("Value: Empty prompt"))
  expect(fixture.fake.mutateInputs[0].records).toContainEqual(expect.objectContaining({ item: "compaction:instructions", level: "project", text: "" }))
  expect(fixture.fake.mutateInputs[0].records).toContainEqual(global)
})
