import { expect, test } from "bun:test"
import { resolve, scopesOf } from "../src/instructions/model.js"
import type { Snapshot } from "../src/rpc.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"
import type { TestFixture } from "./tui.js"

function dispatch(fixture: TestFixture, key: string): boolean {
  for (const cmd of fixture.commands()) {
    if (typeof cmd.bind === "string" && cmd.bind.split(",").includes(key)) {
      void cmd.run()
      return true
    }
  }
  return false
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function moveDown(fixture: TestFixture, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    dispatch(fixture, "down")
    await sleep(20)
  }
}

function binds(fixture: TestFixture): string[] {
  return fixture.commands().map((cmd) => cmd.bind as string)
}

function mcpItem(overrides?: Record<string, unknown>) {
  return {
    id: "mcp:sample",
    kind: "mcp" as const,
    group: "none" as const,
    title: "sample",
    text: "sample-config",
    enabled: true,
    fingerprint: "fp-sample",
    ...overrides,
  }
}

function toolItem(overrides?: Record<string, unknown>) {
  return {
    id: "tool:bash",
    kind: "tool" as const,
    group: "native" as const,
    title: "bash",
    text: "run commands",
    enabled: true,
    fingerprint: "fp-bash",
    ...overrides,
  }
}

function projectAgent(id: string) {
  return { id, scope: "project" as const, fileBacked: true }
}

test("roots render with agents and subtree groups", async () => {
  const snapshot = createSnapshot({
    revision: 1,
    globalRevision: 1,
    agents: [
      projectAgent("Implementer"),
      { id: "Helper", scope: "global" as const, fileBacked: true },
      { id: "Template", scope: "defaults" as const, fileBacked: true },
    ],
    items: [toolItem()],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project agents"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("Project agents")
    expect(frame).toContain("Global agents")
    expect(frame).toContain("Defaults")
    expect(frame).toContain("Implementer")
    expect(frame).toContain("Helper")
    expect(frame).toContain("Agents")
    // Expand the project agent to reveal its identical subtree.
    await moveDown(fixture, 1)
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => frame.includes("Tools"))
    const expanded = fixture.captureCharFrame()
    expect(expanded).toContain("Tools")
    expect(expanded).toContain("Base")
    expect(expanded).toContain("Skills")
    expect(expanded).toContain("System")
  } finally {
    fixture.destroy()
  }
})

test("filter narrows visible rows", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer"), projectAgent("Helper")],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { prompts: ["Implementer"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Implementer"))
    expect(dispatch(fixture, "/")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Filter:"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("Filter:")
    expect(frame).toContain("Implementer")
    expect(frame).not.toContain("Helper")
  } finally {
    fixture.destroy()
  }
})

test("help overlay lists keys and closes", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [createSnapshot()], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    dispatch(fixture, "?")
    await fixture.waitForFrame((frame) => frame.includes("space toggle include/exclude"))
    expect(fixture.captureCharFrame()).toContain("space toggle include/exclude")
    dispatch(fixture, "escape")
    await fixture.waitForFrame((frame) => frame.includes("arrows move") && !frame.includes("space toggle include/exclude"))
    expect(fixture.captureCharFrame()).not.toContain("space toggle include/exclude")
  } finally {
    fixture.destroy()
  }
})

test("add agent chooses Defaults template then id and scope", async () => {
  const snapshot = createSnapshot({
    agents: [{ id: "Template", scope: "defaults" as const, fileBacked: true }],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { selects: ["Template", "project"], prompts: ["my-agent", "hello prompt"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project agents"))
    expect(dispatch(fixture, "a")).toBe(true)
    await sleep(200)
    expect(fixture.fake.agentCreates.length).toBe(1)
    expect(fixture.fake.agentCreates[0]).toMatchObject({ scope: "project", id: "my-agent", template: "Template" })
  } finally {
    fixture.destroy()
  }
})

test("a on an instruction row adds a section with split plus customization records", async () => {
  const body = "# Purpose\n\na\n\n# Usage\n\nb\n"
  const after: Snapshot = createSnapshot({
    items: [
      {
        id: "system:AGENTS.md",
        kind: "system" as const,
        group: "none" as const,
        title: "AGENTS.md",
        text: body,
        enabled: true,
        fingerprint: "fp-guide",
      },
    ],
    records: [
      {
        type: "split" as const,
        level: "project" as const,
        agent: "Implementer",
        item: "system:AGENTS.md",
        boundaries: [
          { id: "existing", name: "AGENTS.md", start: 0 },
          { id: "notes", name: "Notes", start: body.length },
        ],
        updated: "2026-09-14T00:00:00.000Z",
      },
      {
        type: "customization" as const,
        level: "project" as const,
        agent: "Implementer",
        item: "system:AGENTS.md",
        section: "notes",
        text: "follow the guide",
        basedOn: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        basedOnText: "",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
  const before = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "system:AGENTS.md",
        kind: "system" as const,
        group: "none" as const,
        title: "AGENTS.md",
        text: body,
        enabled: true,
        fingerprint: "fp-guide",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [before, after],
    width: 120,
    height: 40,
    dialogs: { prompts: ["Notes", "follow the guide"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Implementer"))
    // Project agent subtree: agent(1) right, System group(4) right, item(1).
    await moveDown(fixture, 1)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 4)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes(body.split("\n")[0]))
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes('Added "Notes"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const records = fixture.fake.mutateInputs[0].records
    const split = records.find((record) => record.type === "split")
    const customization = records.find((record) => record.type === "customization")
    expect(split).toMatchObject({
      type: "split",
      level: "project",
      agent: "Implementer",
      item: "system:AGENTS.md",
    })
    if (split?.type !== "split") throw new Error("expected a split record")
    expect(split.boundaries).toHaveLength(2)
    expect(split.boundaries[1]).toMatchObject({ name: "Notes", start: body.length })
    expect(customization).toMatchObject({
      type: "customization",
      level: "project",
      agent: "Implementer",
      item: "system:AGENTS.md",
      section: split.boundaries[1].id,
      text: "follow the guide",
    })
    // Both halves of the boundary contract land together: the boundary id
    // exists in the split record and the customization targets exactly it.
    const boundaryIds = new Set(split.boundaries.map((boundary) => boundary.id))
    if (customization?.type !== "customization") throw new Error("expected a customization record")
    expect(customization.section).not.toBeNull()
    expect(boundaryIds.has(customization.section ?? "")).toBe(true)
    // Rebuilt tree shows the new section row under the item: the emitted
    // snapshot carries the same split, so the row renders by name.
    await fixture.emitChanged()
    await fixture.waitForFrame((frame) => frame.includes("Notes"))
    expect(fixture.captureCharFrame()).toContain("Notes")
    // The assembled host text carries the new section content after the old
    // body: resolve the emitted snapshot exactly like apply does.
    const written = fixture.fake.mutateInputs[0].records
    const customizations = written.flatMap((record) =>
      record.type === "customization"
        ? [
            {
              type: "customization" as const,
              level: record.level,
              agent: record.agent,
              item: record.item,
              section: record.section,
              ...(record.text === undefined ? {} : { text: record.text }),
              ...(record.state === undefined ? {} : { state: record.state }),
              basedOn: record.basedOn,
              ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
              ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
              updated: record.updated,
            },
          ]
        : [],
    )
    const splits = written.flatMap((record) =>
      record.type === "split"
        ? [
            {
              type: "split" as const,
              level: record.level,
              agent: record.agent,
              item: record.item,
              boundaries: [...record.boundaries],
              updated: record.updated,
            },
          ]
        : [],
    )
    const upstream = before.items.find((item) => item.id === "system:AGENTS.md")
    if (!upstream) throw new Error("expected system:AGENTS.md upstream")
    const assembled = resolve({
      upstream: {
        id: upstream.id,
        kind: upstream.kind,
        group: upstream.group,
        title: upstream.title,
        text: upstream.text,
        enabled: upstream.enabled,
        fingerprint: upstream.fingerprint,
      },
      records: customizations,
      splits,
      scopes: scopesOf([{ id: "Implementer", scope: "project" }]),
      address: { level: "project", agent: "Implementer", item: "system:AGENTS.md", section: null },
    }).assembled
    expect(assembled).toContain("follow the guide")
    expect(assembled.indexOf(body.split("\n")[0])).toBeLessThan(assembled.indexOf("follow the guide"))
  } finally {
    fixture.destroy()
  }
})

test("a on a tool row adds a section", async () => {
  const before = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [toolItem()],
  })
  const body = "run commands"
  const after: Snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [toolItem()],
    records: [
      {
        type: "split" as const,
        level: "project" as const,
        agent: "Implementer",
        item: "tool:bash",
        boundaries: [
          { id: "existing", name: "bash", start: 0 },
          { id: "flags", name: "Flags", start: body.length },
        ],
        updated: "2026-09-14T00:00:00.000Z",
      },
      {
        type: "customization" as const,
        level: "project" as const,
        agent: "Implementer",
        item: "tool:bash",
        section: "flags",
        text: "extra flags",
        basedOn: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        basedOnText: "",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [before, after],
    width: 120,
    height: 40,
    dialogs: { prompts: ["Flags", "extra flags"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Implementer"))
    // Project agent subtree: agent(1) right, Tools group(1) right, Native(1) right, item(1).
    await moveDown(fixture, 1)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("run commands"))
    expect(fixture.fake.dialogSelects.length).toBe(0)
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes('Added "Flags"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.dialogSelects.length).toBe(0)
    const records = fixture.fake.mutateInputs[0].records
    const split = records.find((record) => record.type === "split")
    const customization = records.find((record) => record.type === "customization")
    expect(split).toMatchObject({ type: "split", item: "tool:bash" })
    if (split?.type !== "split") throw new Error("expected a split record")
    expect(split.boundaries[1]).toMatchObject({ name: "Flags", start: body.length })
    expect(customization).toMatchObject({
      type: "customization",
      item: "tool:bash",
      section: split.boundaries[1].id,
      text: "extra flags",
    })
    await fixture.emitChanged()
    await fixture.waitForFrame((frame) => frame.includes("Flags"))
    expect(fixture.captureCharFrame()).toContain("Flags")
  } finally {
    fixture.destroy()
  }
})

test("a on a row without section support keeps the generic picker", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    dialogs: { selects: ["skill", "create"], prompts: ["my-skill", "skill body"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // group:defaults::tools has no add, so a opens the generic picker.
    await moveDown(fixture, 4)
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame(() => fixture.fake.skillCreates.length === 1)
    expect(fixture.fake.skillCreates.length).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("add base prompts for id, title, and text", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    dialogs: { prompts: ["gpt", "gpt.txt", "base text"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // group:defaults::base is index 5 from root:project.
    await moveDown(fixture, 5)
    expect(dispatch(fixture, "a")).toBe(true)
    await sleep(200)
    expect(fixture.fake.baseCreates.length).toBe(1)
    expect(fixture.fake.baseCreates[0]).toMatchObject({ id: "gpt", title: "gpt.txt", text: "base text" })
  } finally {
    fixture.destroy()
  }
})

test("add skill offers create with name and body", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    dialogs: { selects: ["skill", "create"], prompts: ["my-skill", "skill body"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // group:defaults::tools has no add, so a opens the generic picker.
    await moveDown(fixture, 4)
    expect(dispatch(fixture, "a")).toBe(true)
    await sleep(200)
    expect(fixture.fake.skillCreates.length).toBe(1)
    expect(fixture.fake.skillCreates[0]).toMatchObject({ name: "my-skill", body: "skill body" })
  } finally {
    fixture.destroy()
  }
})

test("add skill offers import from SKILL.md path", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    dialogs: { selects: ["skill", "import"], prompts: ["path/to/SKILL.md"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveDown(fixture, 4)
    expect(dispatch(fixture, "a")).toBe(true)
    await sleep(200)
    expect(fixture.fake.skillImports.length).toBe(1)
    expect(fixture.fake.skillImports[0]).toMatchObject({ path: "path/to/SKILL.md" })
  } finally {
    fixture.destroy()
  }
})

test("add instruction prompts for name and text", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    dialogs: { selects: ["instruction"], prompts: ["guide.md", "guide text"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveDown(fixture, 4)
    expect(dispatch(fixture, "a")).toBe(true)
    await sleep(200)
    expect(fixture.fake.instructionCreates.length).toBe(1)
    expect(fixture.fake.instructionCreates[0]).toMatchObject({ name: "guide.md", text: "guide text" })
  } finally {
    fixture.destroy()
  }
})

test("add mcp prompts for name and JSON config", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    dialogs: { prompts: ["srv", '{"command":"npx"}'] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveDown(fixture, 8)
    expect(dispatch(fixture, "a")).toBe(true)
    await sleep(200)
    expect(fixture.fake.mcpAdds.length).toBe(1)
    expect(fixture.fake.mcpAdds[0].name).toBe("srv")
  } finally {
    fixture.destroy()
  }
})

test("delete agent asks for confirmation", async () => {
  const snapshot = createSnapshot({ agents: [projectAgent("Implementer")] })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { confirms: [true] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Implementer"))
    await moveDown(fixture, 1)
    expect(binds(fixture)).toContain("d")
    expect(dispatch(fixture, "d")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Deleted agent Implementer"))
    expect(fixture.fake.agentDeletes.length).toBe(1)
    expect(fixture.fake.dialogConfirms.length).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("delete project skill calls skill.delete and the row disappears", async () => {
  const before = createSnapshot({
    items: [
      {
        id: "skill:proj-one",
        kind: "skill" as const,
        group: "project" as const,
        title: "proj-one",
        text: "project skill",
        enabled: true,
        fingerprint: "fp-proj",
      },
    ],
  })
  const after = createSnapshot({ items: [] })
  const fixture = await renderInstructionsRoute({
    snapshots: [before, after],
    width: 120,
    height: 40,
    dialogs: { confirms: [true] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Navigate the Defaults shared-skills branch: group:defaults::skills is
    // index 6, expand, Project subgroup (index 3 within skills), expand, item.
    await moveDown(fixture, 6)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 4)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("project skill"))
    expect(binds(fixture)).toContain("d")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes("Deleted skill proj-one"))
    expect(fixture.fake.skillDeletes.length).toBe(1)
    expect(fixture.fake.skillDeletes[0]).toMatchObject({ id: "proj-one" })
    await fixture.emitChanged()
    await fixture.waitForFrame((frame) => !frame.includes("proj-one"))
  } finally {
    fixture.destroy()
  }
})

test("delete upstream skill refuses without calling skill.delete", async () => {
  const snapshot = createSnapshot({
    items: [
      {
        id: "skill:native-one",
        kind: "skill" as const,
        group: "native" as const,
        title: "native-one",
        text: "upstream skill",
        enabled: true,
        fingerprint: "fp-native",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Native skills are not removable, so they hang directly under
    // group:defaults::skills (index 6): expand, move to the Native subgroup
    // row, expand it, then move to the item.
    await moveDown(fixture, 6)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("upstream skill"))
    expect(binds(fixture)).toContain("d")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes("is not project-owned"))
    expect(fixture.fake.skillDeletes.length).toBe(0)
    expect(fixture.fake.agentDeletes.length).toBe(0)
    expect(fixture.fake.mcpRemoves.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("reset asks for confirmation and clears the override", async () => {
  const snapshot = createSnapshot({
    items: [mcpItem()],
    records: [
      {
        type: "customization" as const,
        level: "defaults" as const,
        agent: null,
        item: "mcp:sample",
        section: null,
        state: "off" as const,
        basedOn: "fp-sample",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { confirms: [true] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveDown(fixture, 8)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("sample-config"))
    expect(binds(fixture)).toContain("r")
    dispatch(fixture, "r")
    await fixture.waitForFrame((frame) => frame.includes('Reset "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("space toggle sends both expected revisions", async () => {
  const snapshot = createSnapshot({
    revision: 3,
    globalRevision: 7,
    items: [mcpItem()],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveDown(fixture, 8)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("sample-config"))
    expect(binds(fixture)).toContain("space")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].expectedRevision).toBe(3)
    expect(fixture.fake.mutateInputs[0].expectedGlobalRevision).toBe(7)
  } finally {
    fixture.destroy()
  }
})

test("stale dual revisions adopt the snapshot and ask to retry", async () => {
  const initial = createSnapshot({ revision: 1, globalRevision: 1, items: [mcpItem()] })
  const latest: Snapshot = createSnapshot({
    revision: 2,
    globalRevision: 2,
    items: [mcpItem({ text: "newer-config" })],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [initial],
    width: 120,
    height: 40,
    mutateResult: { ok: false, reason: "stale", snapshot: latest },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveDown(fixture, 8)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("sample-config"))
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes("Revision changed"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("1/1")
    expect(frame).toContain("2/2")
    expect(frame).toContain("retry")
    await fixture.waitForFrame((frame) => frame.includes("newer-config"))
  } finally {
    fixture.destroy()
  }
})

test("key availability follows the selected row", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [mcpItem()],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Implementer"))
    // Root row: structural, no space/d/r/s.
    const rootBinds = binds(fixture)
    expect(rootBinds).toContain("a")
    expect(rootBinds).not.toContain("space")
    expect(rootBinds).not.toContain("d")
    expect(rootBinds).not.toContain("r")
    expect(rootBinds).not.toContain("s")
    // Agent row: removable, so d appears but space still does not.
    await moveDown(fixture, 1)
    const agentBinds = binds(fixture)
    expect(agentBinds).toContain("d")
    expect(agentBinds).not.toContain("space")
  } finally {
    fixture.destroy()
  }
})

test("disabled project mode hides actions and keys", async () => {
  const snapshot = createSnapshot({ agents: [projectAgent("Implementer")], items: [toolItem()] })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Implementer"))
    await fixture.emitProjectChanged({ enabled: false })
    await fixture.waitForFrame((frame) => frame.includes("Project mode is disabled"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("Project mode is disabled for this directory")
    const after = binds(fixture)
    expect(after).not.toContain("space")
    expect(after).not.toContain("a")
    expect(after).not.toContain("d")
    expect(after).not.toContain("r")
    expect(after).not.toContain("s")
  } finally {
    fixture.destroy()
  }
})

function reviewSnapshot(): Snapshot {
  return createSnapshot({
    items: [mcpItem({ text: "new-upstream" })],
    records: [
      {
        type: "customization" as const,
        level: "defaults" as const,
        agent: null,
        item: "mcp:sample",
        section: null,
        text: "mine",
        basedOn: "fp-old",
        basedOnText: "old-upstream",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
}

async function gotoReviewRow(fixture: TestFixture): Promise<void> {
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  await moveDown(fixture, 8)
  dispatch(fixture, "right")
  await sleep(50)
  await moveDown(fixture, 1)
  await fixture.waitForFrame((frame) => frame.includes("sample"))
}

test("narrow detail opens with right and closes with escape", async () => {
  const snapshot = createSnapshot({ items: [mcpItem()] })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 80, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveDown(fixture, 8)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("sample"))
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => frame.includes("back to tree"))
    expect(fixture.captureCharFrame()).toContain("sample-config")
    dispatch(fixture, "escape")
    await fixture.waitForFrame((frame) => frame.includes("arrows move") && !frame.includes("back to tree"))
    expect(fixture.captureCharFrame()).not.toContain("back to tree")
  } finally {
    fixture.destroy()
  }
})

test("enter on a yellow node opens the three-pane diff and k keeps mine", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [reviewSnapshot()], width: 120, height: 40 })
  try {
    await gotoReviewRow(fixture)
    await fixture.waitForFrame((frame) => frame.includes("review"))
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("Original upstream"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("Original upstream")
    expect(frame).toContain("Yours")
    expect(frame).toContain("New upstream")
    expect(frame).toContain("k keep mine")
    dispatch(fixture, "k")
    await fixture.waitForFrame((frame) => frame.includes('Kept "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ type: "customization", item: "mcp:sample" })
  } finally {
    fixture.destroy()
  }
})

test("enter on a yellow node resolves t take upstream", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [reviewSnapshot()], width: 120, height: 40 })
  try {
    await gotoReviewRow(fixture)
    await fixture.waitForFrame((frame) => frame.includes("review"))
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("Original upstream"))
    dispatch(fixture, "t")
    await fixture.waitForFrame((frame) => frame.includes("Took upstream"))
    expect(fixture.fake.mutateInputs.length).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("enter on a yellow node resolves e edit through the route", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [reviewSnapshot()],
    width: 120,
    height: 40,
    dialogs: { prompts: ["merged text"] },
  })
  try {
    await gotoReviewRow(fixture)
    await fixture.waitForFrame((frame) => frame.includes("review"))
    // The diff pane mounts its own e edit editor; wait for it before typing.
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("Original upstream"))
    dispatch(fixture, "e")
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    expect(editor).toBeDefined()
    expect(editor?.plainText).toBe("mine")
    editor?.setText("merged text")
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes('Edited "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ type: "customization", text: "merged text" })
  } finally {
    fixture.destroy()
  }
})

test("s opens the manual splitter and saves two named sections", async () => {
  const text = "Purpose tells when.\n\nQuoting details here.\n"
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ items: [toolItem({ text })] })],
    width: 120,
    height: 40,
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Defaults tools branch: group:defaults::tools is index 4, expand it,
    // move to the Native subgroup, expand, then move to the item.
    await moveDown(fixture, 4)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("Purpose tells when."))
    expect(binds(fixture)).toContain("s")
    dispatch(fixture, "s")
    await fixture.waitForFrame((frame) => frame.includes("split into sections"))
    dispatch(fixture, "b")
    await fixture.waitForFrame((frame) => frame.includes("Name section"))
    fixture.renderer.currentFocusedEditor?.setText("Purpose")
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes("Purpose") && !frame.includes("Name section"))
    dispatch(fixture, "down")
    dispatch(fixture, "down")
    dispatch(fixture, "b")
    await fixture.waitForFrame((frame) => frame.includes("Name section"))
    fixture.renderer.currentFocusedEditor?.setText("Quoting")
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes("Quoting"))
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes('Split "bash"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const split = fixture.fake.mutateInputs[0].records.find((record) => record.type === "split")
    expect(split).toMatchObject({ type: "split", item: "tool:bash" })
    if (split?.type !== "split") throw new Error("expected a split record")
    expect(split.boundaries.map((boundary) => boundary.name)).toEqual(["Purpose", "Quoting"])
    expect(split.boundaries.map((boundary) => boundary.start)).toEqual([0, text.indexOf("Quoting")])
  } finally {
    fixture.destroy()
  }
})

test("mutation leaves an untouched split record updated unchanged", async () => {
  const splitUpdated = "2026-01-02T00:00:00.000Z"
  const snapshot = createSnapshot({
    items: [mcpItem(), toolItem()],
    records: [
      {
        type: "split" as const,
        level: "defaults" as const,
        agent: null,
        item: "tool:bash",
        boundaries: [{ id: "a", name: "A", start: 0 }],
        updated: splitUpdated,
      },
    ],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveDown(fixture, 8)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("sample-config"))
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const split = fixture.fake.mutateInputs[0].records.find((record) => record.type === "split")
    expect(split).toMatchObject({ type: "split", item: "tool:bash", updated: splitUpdated })
  } finally {
    fixture.destroy()
  }
})

test("normal-mode keys are arrows without j/k/h/l aliases", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [createSnapshot()], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    const all = binds(fixture)
    expect(all).toContain("up")
    expect(all).toContain("down")
    expect(all).toContain("left")
    expect(all).toContain("right")
    for (const key of ["j", "k", "h", "l"]) {
      expect(dispatch(fixture, key)).toBe(false)
    }
    const full = all.join(",")
    expect(full).not.toContain("up,k")
    expect(full).not.toContain("left,h")
  } finally {
    fixture.destroy()
  }
})

test("filter reveals a match nested under collapsed ancestors", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [toolItem({ title: "zz-unique-tool", id: "tool:zz-unique", text: "zz-unique-body" })],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { prompts: ["zz-unique"] },
  })
  try {
    // The tool row starts hidden under collapsed ancestors; filtering must
    // reveal it with its ancestor chain.
    await fixture.waitForFrame((frame) => frame.includes("Project agents"))
    expect(fixture.captureCharFrame()).not.toContain("zz-unique-tool")
    expect(dispatch(fixture, "/")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Filter:"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("Filter:")
    expect(frame).toContain("zz-unique-tool")
    expect(frame).toContain("Implementer")
  } finally {
    fixture.destroy()
  }
})

test("right on an item row reveals its sections for select and toggle", async () => {
  const text = "# Purpose\n\na\n\n# Usage\n\nb\n"
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ items: [mcpItem({ text })] })],
    width: 120,
    height: 40,
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveDown(fixture, 8)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("Purpose"))
    // Right expands the item row itself; the section rows appear in the tree
    // with their on/off badge (the detail pane uses [included] instead).
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => frame.includes("Purpose [on]"))
    await moveDown(fixture, 1)
    expect(binds(fixture)).toContain("space")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "Purpose"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({
      item: "mcp:sample",
      section: "purpose",
      state: "off",
    })
  } finally {
    fixture.destroy()
  }
})

test("filtered hidden match can be selected and toggled", async () => {
  const snapshot = createSnapshot({
    items: [toolItem({ title: "zz-unique-tool", id: "tool:zz-unique", text: "zz-unique-body" })],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { prompts: ["zz-unique"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project agents"))
    expect(dispatch(fixture, "/")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Filter:"))
    // Filtered list is root, Tools, Native, then the revealed tool row.
    await moveDown(fixture, 4)
    await fixture.waitForFrame((frame) => frame.includes("zz-unique-body"))
    expect(binds(fixture)).toContain("space")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "zz-unique-tool"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ item: "tool:zz-unique", state: "off" })
  } finally {
    fixture.destroy()
  }
})

test("reviewer persona shows its own prompt and saves only its record", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer"), projectAgent("Reviewer")],
    items: [
      {
        id: "system:role",
        kind: "system" as const,
        group: "none" as const,
        title: "Role/persona",
        text: "implementer-prompt",
        enabled: true,
        fingerprint: "fp-implementer",
        agents: ["Implementer"],
      },
      {
        id: "system:role",
        kind: "system" as const,
        group: "none" as const,
        title: "Role/persona",
        text: "reviewer-prompt",
        enabled: true,
        fingerprint: "fp-reviewer",
        agents: ["Reviewer"],
      },
    ],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Reviewer"))
    await moveDown(fixture, 2)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 4)
    dispatch(fixture, "right")
    await sleep(50)
    await moveDown(fixture, 1)
    await fixture.waitForFrame((frame) => frame.includes("reviewer-prompt"))
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    expect(editor).toBeDefined()
    expect(editor?.plainText).toBe("reviewer-prompt")
    editor?.setText("reviewer-prompt v2")
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes('Saved "Role/persona"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const records = fixture.fake.mutateInputs[0].records
    expect(records.length).toBe(1)
    expect(records[0]).toMatchObject({ agent: "Reviewer", item: "system:role", text: "reviewer-prompt v2" })
  } finally {
    fixture.destroy()
  }
})
