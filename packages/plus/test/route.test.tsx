import { expect, test } from "bun:test"
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

test("delete file-backed item surfaces the RPC contract limitation", async () => {
  const snapshot = createSnapshot({
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
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
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
    await fixture.waitForFrame((frame) => frame.includes("no delete RPC"))
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
    snapshots: [createSnapshot({ items: [mcpItem({ text })] })],
    width: 120,
    height: 40,
  })
  try {
    await gotoReviewRow(fixture)
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
    await fixture.waitForFrame((frame) => frame.includes('Split "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const split = fixture.fake.mutateInputs[0].records.find((record) => record.type === "split")
    expect(split).toMatchObject({ type: "split", item: "mcp:sample" })
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
