// The Instructions route: presets and links, state and model reviews, model fields.
import { expect, test } from "bun:test"
import { fingerprint, resolve } from "../src/instructions/model.js"
import { save } from "../src/instructions/store.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { expandedTree } from "../src/instructions/tree.js"
import { factsOf, notesOf } from "../src/tui/instructions/inspector.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"
import { binds, breadcrumb, category, dispatch, expand, footer, moveTo, reach, selectedRow } from "./instructions-nav.js"
import { goto, filter, until, sidebarRow, navTo, listPane, inspector, flat, toolItem, projectAgent, PRESET_UPDATED, linkTo, basicOrchestrator, basicPlanner, bashItem, reviewedBash, gotoBash } from "./route-helpers.js"

test("a on Global Agents → User asks the name, then a grouped preset, and creates and selects at global", async () => {
  const before = createSnapshot({ agents: [projectAgent("alpha")] })
  const after = createSnapshot({ agents: [projectAgent("alpha"), { id: "helper", scope: "global" as const, fileBacked: true, origin: "user" as const }] })
  const fixture = await renderInstructionsRoute({
    snapshots: [before, after],
    dialogs: { prompts: ["helper"], selects: ["member:basic/planner"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "group:global:agents:user", "User")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.agentCreates.length === 1)
    expect(fixture.fake.agentCreates[0]).toEqual({
      scope: "global",
      id: "helper",
      preset: { kind: "member", team: "basic", id: "planner" },
    })
    expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Create agent"])
    // No scope question: the cursor's root decides.
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Preset"])
    const picker = fixture.fake.selectInputs[0]
    const categories = [...new Set(picker.options.map((option) => option.category))]
    expect(categories).toEqual(["Agent presets · OpenCode", "Team preset members", undefined])
    expect(picker.options.find((option) => option.value === "agent:build")?.category).toBe("Agent presets · OpenCode")
    expect(picker.options.find((option) => option.value === "member:basic/orchestrator")?.title).toBe("Basic › orchestrator")
    expect(picker.options.find((option) => option.value === "member:basic/planner")?.title).toBe("Basic › planner")
    expect(picker.options.some((option) => option.value === "team:basic")).toBe(false)
    expect(picker.options.at(-1)).toEqual({ title: "None — everything off", value: "__none__" })
    // The new agent row is revealed and selected.
    await until(fixture, (frame) => sidebarRow(frame).includes("helper"))
  } finally {
    fixture.destroy()
  }
})

test("the preset picker lists User agent presets in their own group", async () => {
  const snapshot = createSnapshot({
    presets: [{ type: "preset", level: "preset", kind: "agent", id: "mine", updated: PRESET_UPDATED }],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], dialogs: { prompts: ["x"], selects: ["agent:mine"] } })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "group:project:agents", "Agents")
    dispatch(fixture, "a")
    await until(fixture, () => fixture.fake.agentCreates.length === 1)
    expect(fixture.fake.agentCreates[0]).toEqual({ scope: "project", id: "x", preset: { kind: "agent", id: "mine" } })
    expect(fixture.fake.selectInputs[0].options.find((option) => option.value === "agent:mine")?.category).toBe("Agent presets · User")
  } finally {
    fixture.destroy()
  }
})

test("a on Defaults Agents asks a name or pattern, then a preset, and creates an entry", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    dialogs: { prompts: ["*orchestrator*"], selects: ["member:basic/orchestrator"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "group:defaults:agents", "Agents")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.entryCreates.length === 1)
    expect(fixture.fake.entryCreates[0]).toEqual({ catalogue: "agents", name: "*orchestrator*", preset: { kind: "member", team: "basic", id: "orchestrator" } })
    expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Agent name or pattern"])
    expect(fixture.fake.promptInputs[0]?.description).toContain("* and % match any text, case-insensitive (e.g. *orchestrator*)")
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Preset"])
    expect(fixture.fake.agentCreates.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("Presets → Agents → User and Teams → User create User presets from a base; a team preset row adds members", async () => {
  const snapshot = createSnapshot({
    presets: [{ type: "preset", level: "preset", kind: "team", id: "squad", updated: PRESET_UPDATED }],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    height: 60,
    dialogs: { prompts: ["mine", "crew", "lead"], selects: ["member:basic/planner", "", "member:basic/orchestrator"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "group:preset:agents:user", "User")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.presetCreates.length === 1)
    expect(fixture.fake.presetCreates[0]).toEqual({ kind: "agent", id: "mine", from: { kind: "member", team: "basic", id: "planner" } })
    expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Preset name"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Base preset"])
    expect(fixture.fake.selectInputs[0].options.at(-1)).toEqual({ title: "None — everything off", value: "__none__" })

    await goto(fixture, "group:preset:teams:user", "User")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.presetCreates.length === 2)
    expect(fixture.fake.presetCreates[1]).toEqual({ kind: "team", id: "crew" })
    expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Preset name", "Team preset name"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Base preset", "Team preset"])
    expect(fixture.fake.selectInputs[1].options.at(-1)).toEqual({ title: "Empty team", value: "" })
    // The create reveals Presets → Teams → User (where the new preset lands).
    await until(fixture, () => fixture.fake.toasts.some((toast) => toast.message === "Created team preset crew"))
    await until(fixture, (frame) => /^\s+▾ User/.test(selectedRow(frame)) && breadcrumb(frame).includes("Presets › Teams › User"))

    await navTo(fixture, "squad")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.presetAddMembers.length === 1)
    expect(fixture.fake.presetAddMembers[0]).toEqual({ team: "squad", id: "lead", from: { kind: "member", team: "basic", id: "orchestrator" } })
    expect(fixture.fake.promptInputs.at(-1)?.title).toBe("Member name")
    expect(fixture.fake.dialogSelects.at(-1)).toEqual(["Preset"])
  } finally {
    fixture.destroy()
  }
})

test("a on a member preset's Models group adds a team-scoped model at level preset", async () => {
  const snapshot = createSnapshot({
    presets: [
      { type: "preset", level: "preset", kind: "team", id: "squad", updated: PRESET_UPDATED },
      { type: "preset", level: "preset", kind: "agent", id: "lead", team: "squad", updated: PRESET_UPDATED },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    height: 60,
    models: [{ providerID: "acme", modelID: "nova", name: "Nova" }],
    dialogs: { selects: ["model", "acme", "nova"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Presets › Teams › User › squad › lead (sidebar), then its Models.
    await goto(fixture, "team:preset:squad:lead", "lead")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Models")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.modelAdds.length === 1)
    expect(fixture.fake.modelAdds[0]).toEqual({
      level: "preset",
      agent: "lead",
      team: { level: "preset", team: "squad" },
      providerID: "acme",
      modelID: "nova",
    })
    // No scope or agent prompts: the group names the preset.
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Add", "Model provider", "Model"])
    expect(fixture.fake.promptInputs).toEqual([])
  } finally {
    fixture.destroy()
  }
})

test("l relinks an agent to another preset with the current link preselected, and unlinks", async () => {
  const snapshot = createSnapshot({ agents: [projectAgent("alice")], links: [linkTo("alice", basicOrchestrator)] })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { selects: ["member:basic/planner", "__none__"] },
  })
  try {
    await goto(fixture, "agent:project:alice", "alice")
    // l is secondary, so the bar leaves it to the help dialog; the key works.
    expect(binds(fixture)).toContain("l")
    expect(dispatch(fixture, "l")).toBe(true)
    await until(fixture, () => fixture.fake.linkSets.length === 1)
    expect(fixture.fake.linkSets[0]).toEqual({ level: "project", agent: "alice", preset: basicPlanner })
    const picker = fixture.fake.selectInputs[0]
    expect(picker.title).toBe("Link to preset")
    expect(picker.current).toBe("member:basic/orchestrator")
    expect(picker.options.at(-1)).toEqual({ title: "None — unlink", value: "__none__" })
    expect(fixture.fake.toasts).toContainEqual({ variant: "success", message: "Linked alice to Basic › planner (Plus)" })
    expect(dispatch(fixture, "l")).toBe(true)
    await until(fixture, () => fixture.fake.linkSets.length === 2)
    expect(fixture.fake.linkSets[1]).toEqual({ level: "project", agent: "alice", preset: null })
    expect(fixture.fake.toasts).toContainEqual({ variant: "success", message: "Unlinked alice" })
  } finally {
    fixture.destroy()
  }
})

test("l on a team relinks to a team preset; l is not offered on rows that take no link", async () => {
  const snapshot = createSnapshot({ agents: [projectAgent("alice")], teams: [{ level: "project", team: "crew", enabled: false, agents: [] }] })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], height: 60, dialogs: { selects: ["basic"] } })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // A group row has no owner.
    await goto(fixture, "group:project:agents", "Agents")
    expect(binds(fixture)).not.toContain("l")
    await goto(fixture, "team:project:crew", "crew")
    expect(dispatch(fixture, "l")).toBe(true)
    await until(fixture, () => fixture.fake.linkSets.length === 1)
    expect(fixture.fake.linkSets[0]).toEqual({
      level: "project",
      agent: null,
      team: { level: "project", team: "crew" },
      preset: { kind: "team", id: "basic" },
    })
    expect(fixture.fake.selectInputs[0]?.title).toBe("Link to team preset")
    expect(fixture.fake.selectInputs[0]?.options.at(-1)).toEqual({ title: "None — unlink", value: "" })
    // Native and Plus presets are read-only: no l.
    await goto(fixture, "agent:preset:build", "Build")
    expect(binds(fixture)).not.toContain("l")
  } finally {
    fixture.destroy()
  }
})

test("l toasts the server's refusal of a cycle", async () => {
  const snapshot = createSnapshot({
    presets: [{ type: "preset", level: "preset", kind: "agent", id: "mine", updated: PRESET_UPDATED }],
  })
  const message = "Linking agent:mine to agent:other would make it reach itself (agent:other → agent:mine)"
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { selects: ["member:basic/planner"] },
    rpcErrors: { "link.set": { type: "link.cycle", message, data: { preset: basicPlanner, through: [] } } },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:preset:mine", "mine")
    expect(dispatch(fixture, "l")).toBe(true)
    await until(fixture, () => fixture.fake.toasts.length === 1)
    expect(fixture.fake.linkSets[0]).toEqual({ level: "preset", agent: "mine", preset: basicPlanner })
    expect(fixture.fake.toasts).toEqual([{ variant: "error", message }])
  } finally {
    fixture.destroy()
  }
})

test("d on a User preset in use toasts who uses it", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("alice")],
    presets: [{ type: "preset", level: "preset", kind: "agent", id: "mine", updated: PRESET_UPDATED }],
    links: [linkTo("alice", { kind: "agent", id: "mine" })],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { confirms: [true] },
    rpcErrors: {
      "preset.delete": {
        type: "preset.inUse",
        message: "Preset agent:mine is in use; relink or delete them first",
        data: { ref: { kind: "agent", id: "mine" }, users: ["agent:project:alice"] },
      },
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:preset:mine", "mine")
    expect(footer(fixture.captureCharFrame())).toContain("d delete")
    expect(dispatch(fixture, "d")).toBe(true)
    await until(fixture, () => fixture.fake.toasts.length === 1)
    expect(fixture.fake.presetDeletes).toEqual([{ ref: { kind: "agent", id: "mine" } }])
    expect(fixture.fake.toasts[0]).toEqual({
      variant: "error",
      message: "Preset agent:mine is in use; relink or delete them first (used by agent:project:alice)",
    })
  } finally {
    fixture.destroy()
  }
})

test("rows show the from-label suffix and the inspector its provenance and link", async () => {
  const snapshot = createSnapshot({ agents: [projectAgent("alice")], items: [bashItem()], links: [linkTo("alice", basicOrchestrator)] })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 160 })
  try {
    await goto(fixture, "agent:project:alice", "alice")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("preset Basic › orchestrator (Plus)")))
    await goto(fixture, "item:project:alice:tool:bash", "bash")
    const frame = await fixture.waitForFrame((next) => inspector(next).includes(flat("source from preset Basic › orchestrator")))
    expect(selectedRow(frame)).toMatch(/● bash\s+from preset Basic › orchestrator/)
  } finally {
    fixture.destroy()
  }
})

test("enter on a state review offers keep yours / take from the preset; keep re-records the value above", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("alice")],
    items: [bashItem()],
    links: [linkTo("alice", basicOrchestrator)],
    records: [reviewedBash()],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 160, dialogs: { selects: ["keep"] } })
  try {
    await gotoBash(fixture)
    const frame = await fixture.waitForFrame((next) => inspector(next).includes(flat("review to review (state)")))
    expect(selectedRow(frame)).toMatch(/bash.*!/)
    expect(footer(frame)).toContain("enter review")
    expect(dispatch(fixture, "return")).toBe(true)
    await until(fixture, () => fixture.fake.mutateInputs.length === 1)
    const choice = fixture.fake.selectInputs[0]
    expect(choice.title).toBe('Review "bash"')
    expect(choice.options.map((option) => [option.title, option.value])).toEqual([
      ["Keep yours (off)", "keep"],
      ["Take from preset Basic › orchestrator (on)", "take"],
    ])
    const record = fixture.fake.mutateInputs[0].records.find((entry) => entry.type === "customization" && entry.item === "tool:bash")
    expect(record).toMatchObject({ state: "off", basedOnState: "on" })
    // State only: no three-way diff follows.
    expect(fixture.captureCharFrame()).not.toContain("k keep mine")
  } finally {
    fixture.destroy()
  }
})

test("take on a state review drops yours; with text under review too the diff follows for the text", async () => {
  const taken = createSnapshot({
    agents: [projectAgent("alice")],
    items: [bashItem()],
    links: [linkTo("alice", basicOrchestrator)],
    records: [reviewedBash()],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [taken], width: 160, dialogs: { selects: ["take"] } })
  try {
    await gotoBash(fixture)
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.mutateInputs.length === 1)
    expect(fixture.fake.mutateInputs[0].records.some((entry) => entry.type === "customization" && entry.item === "tool:bash")).toBe(false)
  } finally {
    fixture.destroy()
  }
  const both = createSnapshot({
    agents: [projectAgent("alice")],
    items: [bashItem()],
    links: [linkTo("alice", basicOrchestrator)],
    records: [reviewedBash({ text: "mine", basedOnText: "old", basedOn: "fp-old" })],
  })
  const second = await renderInstructionsRoute({ snapshots: [both], width: 160, dialogs: { selects: ["take"] } })
  try {
    await gotoBash(second)
    await second.waitForFrame((frame) => inspector(frame).includes(flat("review to review (text, state)")))
    expect(selectedRow(second.captureCharFrame())).toMatch(/bash.*!/)
    dispatch(second, "return")
    await until(second, () => second.fake.mutateInputs.length === 1)
    // The state is dropped, the text stays for its own review.
    const record = second.fake.mutateInputs[0].records.find((entry) => entry.type === "customization" && entry.item === "tool:bash")
    expect(record).toMatchObject({ text: "mine", basedOnText: "old" })
    expect(record !== undefined && "state" in record).toBe(false)
    await until(second, (frame) => frame.split("\n").some((line) => line.includes("k keep mine") && line.includes("t save merged")))
  } finally {
    second.destroy()
  }
})

test("enter on a model review offers keep yours / take the model above", async () => {
  const models = (active: { basedOn?: string }) =>
    createSnapshot({
      agents: [projectAgent("alice")],
      records: [
        { type: "model" as const, level: "defaults" as const, agent: null, providerID: "acme", modelID: "base", active: true, updated: PRESET_UPDATED },
        {
          type: "model" as const,
          level: "project" as const,
          agent: "alice",
          providerID: "acme",
          modelID: "mine",
          active: true,
          ...active,
          updated: PRESET_UPDATED,
        },
      ],
    })
  for (const [pick, expected] of [
    ["keep", { active: true, basedOn: "acme/base" }],
    ["take", {}],
  ] as const) {
    const fixture = await renderInstructionsRoute({ snapshots: [models({ basedOn: "acme/old" })], width: 160, dialogs: { selects: [pick] } })
    try {
      await goto(fixture, "item:project:alice:model:acme/mine", "acme/mine")
      expect(selectedRow(fixture.captureCharFrame())).toMatch(/acme\/mine.*!/)
      await fixture.waitForFrame((frame) => inspector(frame).includes(flat("review to review")))
      dispatch(fixture, "return")
      await until(fixture, () => fixture.fake.mutateInputs.length === 1)
      expect(fixture.fake.selectInputs[0].options.map((option) => option.title)).toEqual([
        "Keep yours (acme/mine)",
        "Take from Defaults (every agent) (acme/base)",
      ])
      const own = fixture.fake.mutateInputs[0].records.find((entry) => entry.type === "model" && entry.agent === "alice")
      expect(own).toMatchObject({ modelID: "mine" })
      if (pick === "take") expect(own !== undefined && "active" in own && own.active === true).toBe(false)
      else expect(own).toMatchObject(expected)
    } finally {
      fixture.destroy()
    }
  }
})

// A team's Special agent reads its team-scoped records: the detail pane's
// active-model lines and scrub preview resolve with the row's team, as the
// tree row itself does, never the team-less agent.
test("inspector: a team's Special agent shows its team-scoped active model and scrub preview", async () => {
  const crew = { level: "project" as const, team: "crew" }
  const snapshot = createSnapshot({
    agents: [{ id: "summary", scope: "defaults" as const, fileBacked: false, origin: "special" as const }],
    items: [
      toolItem({ id: "tool:shell", title: "shell", text: "Run commands.\nUse git push to publish.", fingerprint: "fp-shell" }),
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-git-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
      },
    ],
    records: [
      { type: "model" as const, level: "project" as const, agent: "summary", team: crew, providerID: "acme", modelID: "nova-1", active: true as const, updated: "2026-09-14T00:00:00.000Z" },
      { type: "customization" as const, level: "project" as const, agent: "summary", team: crew, item: "perm:shell:git-push", section: null, state: "off" as const, basedOn: "fp-git-push", updated: "2026-09-14T00:00:00.000Z" },
    ],
    teams: [{ level: "project" as const, team: "crew", enabled: true, agents: [] }],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 160, height: 60 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Teams › crew › Special › summary (sidebar) › Models › the model.
    await goto(fixture, "item:project:crew/:special:summary:model:acme/nova-1", "acme/nova-1")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("from Project · active")))
    await goto(fixture, "item:project:crew/:special:summary:tool:shell", "shell")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("hidden 1 lines hidden by rules: Use git push to publish.")))
  } finally {
    fixture.destroy()
  }
})

// D: enter on a model row opens its field rows; enter on one field edits that
// field alone (T7 removed the whole-row editor). The Model field picks from
// the host catalog, the warming fields prompt; `w` is no longer bound.
test("enter on a model row opens its field rows and one field edits alone; w is no longer bound", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("alice")],
    records: [
      { type: "model" as const, level: "project" as const, agent: "alice", providerID: "acme", modelID: "nova-1", updated: PRESET_UPDATED },
    ],
    hostModels: [{ providerID: "acme", modelID: "nova-1", variants: ["low", "high"] }],
  })
  const models = [
    { providerID: "acme", modelID: "nova-1", name: "Nova 1" },
    { providerID: "acme", modelID: "nova-2", name: "Nova 2" },
  ]
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 160,
    models,
    dialogs: { selects: ["acme", "nova-2", "custom…", "high"], prompts: ["45m"] },
  })
  try {
    await goto(fixture, "item:project:alice:model:acme/nova-1", "acme/nova-1")
    // The model-row warming key is gone; enter opens the field rows.
    expect(fixture.commands().some((command) => command.bind === "w")).toBe(false)
    expect(footer(fixture.captureCharFrame())).toContain("enter open fields")
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => listPane(frame).includes("Effort"))
    const open = listPane(fixture.captureCharFrame())
    // The row shows Model, Effort and the Warming and Compaction groups; the
    // group's fields appear when it opens.
    for (const label of ["Model", "Effort", "Warming", "Compaction"]) expect(open).toContain(label)
    // The Model field picks from the host catalog and writes only that field
    // (the candidate is replaced in place).
    await moveTo(fixture, "Model")
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.mutateInputs.length === 1)
    expect(fixture.fake.selectInputs.map((input) => input.title)).toEqual(["Model provider", "Model"])
    const own = fixture.fake.mutateInputs[0].records.filter((entry) => entry.type === "model" && entry.agent === "alice" && entry.removed !== true)
    expect(own).toEqual([expect.objectContaining({ providerID: "acme", modelID: "nova-2" })])
    // The Warming group opens into its fields; the Warming field is a dropdown
    // whose Custom… asks for its own value and writes it alone.
    await moveTo(fixture, "Warming")
    await expand(fixture)
    await fixture.waitForFrame((frame) => listPane(frame).includes("Ping every"))
    dispatch(fixture, "down")
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("off · built-in"))
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.mutateInputs.length === 2)
    expect(fixture.fake.selectInputs.find((input) => input.title === "Warming · acme/nova-1")?.options.map((option) => option.title)).toEqual([
      "Inherit", "Off", "On", "15m", "30m", "45m", "1h", "1h30m", "2h", "4h", "8h", "Custom…",
    ])
    expect(fixture.fake.promptInputs.at(-1)?.title).toBe("Warming · acme/nova-1")
    const warming = fixture.fake.mutateInputs[1].records.filter((entry) => entry.type === "model" && entry.agent === "alice" && entry.removed !== true)
    expect(warming).toEqual([expect.objectContaining({ providerID: "acme", modelID: "nova-1", warming: "45m" })])
    // The Effort picker names the candidate, not the row label ("Effort"):
    // up from the Warming field passes the Warming group to reach it.
    dispatch(fixture, "up")
    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("Effort"))
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.selectInputs.some((input) => input.title.startsWith("Effort ·")))
    const effort = fixture.fake.selectInputs.find((input) => input.title.startsWith("Effort ·"))
    expect(effort?.title).toBe("Effort · acme/nova-1")
    expect(effort?.options.map((option) => option.title)).toEqual(["(inherit / none)", "high", "low"])
  } finally {
    fixture.destroy()
  }
})

// Enter on a model row refuses a model outside the host catalog: the Model
// field's picker offers only catalog models, and with an empty catalog it
// toasts and writes nothing.
test("the Model field picker offers only the host catalog and writes nothing when it is empty", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("alice")],
    records: [
      { type: "model" as const, level: "project" as const, agent: "alice", providerID: "acme", modelID: "nova-1", updated: PRESET_UPDATED },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 160,
    models: [],
  })
  try {
    await goto(fixture, "item:project:alice:model:acme/nova-1", "acme/nova-1")
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => listPane(frame).includes("Effort"))
    await moveTo(fixture, "Model")
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.toasts.some((toast) => toast.message.includes("No models in the host catalog")))
    expect(fixture.fake.mutateInputs).toEqual([])
  } finally {
    fixture.destroy()
  }
})

// Enter on a Defaults › Models row edits the four keep-alive fields through
// modelSettings.set (not the inventory mutate).
test("a Defaults › Models row opens into its fields, and enter on a field edits that field alone", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("alice")],
    modelSettings: [
      {
        type: "modelSettings" as const,
        level: "defaults" as const,
        providerID: "acme",
        modelID: "nova-1",
        warming: "30m",
        updated: PRESET_UPDATED,
      },
    ],
    hostModels: [
      {
        providerID: "acme",
        modelID: "nova-1",
        variants: ["low", "high"],
        warming: { on: true, interval: 210_000, duration: 1_800_000 },
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 160,
    dialogs: { selects: ["custom…", "custom…"], prompts: ["5m", "45m"] },
  })
  try {
    await goto(fixture, "item:defaults:/models:modeldefault:acme/nova-1", "acme/nova-1")
    await fixture.waitForFrame((frame) => frame.includes("acme/nova-1"))
    expect(listPane(fixture.captureCharFrame())).not.toContain("Ping every")
    // Enter (like →) opens the row instead of asking for every field in turn.
    expect(dispatch(fixture, "return")).toBe(true)
    await fixture.waitForFrame((frame) => listPane(frame).includes("Warming"))
    // The Warming group opens into its fields.
    await moveTo(fixture, "Warming")
    await expand(fixture)
    await fixture.waitForFrame((frame) => listPane(frame).includes("Keep-alive prompt"))
    const open = listPane(fixture.captureCharFrame())
    for (const label of ["Warming", "Ping every", "Keep-alive prompt", "Effort"]) expect(open).toContain(label)
    // 30m of its own against opencode.json's 3m30s ping warms 31m30s.
    expect(open).toContain("31m30s")
    expect(open).toContain("3m30s · opencode.json")
    expect(fixture.fake.promptInputs).toEqual([])
    await moveTo(fixture, "Ping every")
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.modelSettingsSets.length === 1)
    // Ping every is a dropdown: Inherit names the value below with its source;
    // unknown lifetime offers the 5m list. Custom… asks for the time.
    expect(fixture.fake.selectInputs[0]?.options.map((option) => option.title)).toEqual([
      "Inherit (now 3m30s · opencode.json)", "1m", "2m", "3m", "4m", "4m30s", "Custom…",
    ])
    expect(fixture.fake.promptInputs.map((input) => [input.title, input.value ?? "", input.placeholder ?? ""])).toEqual([
      ["Ping every · acme/nova-1", "", "3m30s"],
    ])
    expect(fixture.fake.modelSettingsSets[0]).toEqual({ providerID: "acme", modelID: "nova-1", interval: "5m" })
    // The warming field prefills the row's own time and sets nothing else.
    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("Warming"))
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.modelSettingsSets.length === 2)
    expect(fixture.fake.promptInputs[1]).toMatchObject({ title: "Warming · acme/nova-1", value: "30m" })
    expect(fixture.fake.modelSettingsSets[1]).toEqual({ providerID: "acme", modelID: "nova-1", warming: "45m" })
    expect(fixture.fake.mutateInputs).toEqual([])
    // ← closes the row again from a field.
    dispatch(fixture, "left")
    dispatch(fixture, "left")
    await fixture.waitForFrame((frame) => !listPane(frame).includes("Keep-alive prompt"))
  } finally {
    fixture.destroy()
  }
})

test("the filter reaches a Defaults › Models field row inside its closed model row", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("alice")],
    hostModels: [{ providerID: "acme", modelID: "nova-1", variants: [] }],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 160, dialogs: { selects: ["custom…"], prompts: ["low"] } })
  try {
    await goto(fixture, "item:defaults:/models:modelsetting:effort:*", "Effort")
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.modelSettingsSets.length === 1)
    expect(fixture.fake.promptInputs[0]?.title).toBe("Effort · Every model")
    expect(fixture.fake.modelSettingsSets[0]).toEqual({ effort: "low" })
  } finally {
    fixture.destroy()
  }
})

// A: the Project view marks the effective model that a more specific level did
// not choose, names the level that chose it, and never marks the upstream row.
test("the Project view marks an inherited Global active model as active (global)", async () => {
  const snapshot = createSnapshot({
    agents: [{ id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const, model: { providerID: "acme", modelID: "upstream-model" } }],
    records: [
      { type: "model" as const, level: "global" as const, agent: "build", providerID: "acme", modelID: "nova-1", active: true as const, updated: PRESET_UPDATED },
    ],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 160 })
  try {
    await goto(fixture, "item:project:build:model:acme/nova-1", "acme/nova-1")
    expect(selectedRow(fixture.captureCharFrame())).toMatch(/acme\/nova-1.*active \(global\)/)
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("from Global · active (inherited)")))
    // The upstream row is listed for build but not active.
    await goto(fixture, "item:project:build:model:acme/upstream-model", "acme/upstream-model")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("from upstream")))
    expect(selectedRow(fixture.captureCharFrame())).not.toContain("active")
  } finally {
    fixture.destroy()
  }
})

// B: the Defaults view of a native agent must not claim the host model is
// active while a more specific level chose one; the group names the effective
// model instead.
test("the Defaults view of build names the effective model instead of marking upstream active", async () => {
  const snapshot = createSnapshot({
    agents: [{ id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const, model: { providerID: "acme", modelID: "base" } }],
    records: [
      { type: "model" as const, level: "global" as const, agent: "build", providerID: "acme", modelID: "chosen", active: true as const, updated: PRESET_UPDATED },
    ],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 160 })
  try {
    // The Models group of the Defaults view: the effective model is named
    // because it is not one of this level's rows, and the fallback note is
    // there (factsOf/notesOf are what the inspector renders).
    const nodes = expandedTree(memoInputOf(snapshot))
    const group = nodes.find((node) => node.id === "group:defaults:build:models")
    if (group === undefined) throw new Error("missing Defaults Models group")
    expect(factsOf(group, snapshot, []).find((fact) => fact[0] === "effective")?.[1]).toBe("acme/chosen · active at global")
    expect(notesOf(group, snapshot).join(" ")).toContain("falls back to its host configuration")
    // The upstream row of the same group is listed but never active; the row
    // itself names the model in force, so the answer is one keystroke away.
    await goto(fixture, "item:defaults:build:model:acme/base", "acme/base")
    const row = selectedRow(fixture.captureCharFrame())
    expect(row).toContain("acme/base")
    expect(row).not.toContain("active")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("from upstream")))
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("effective acme/chosen · active at global")))
  } finally {
    fixture.destroy()
  }
})
