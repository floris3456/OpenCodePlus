import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createComponent } from "solid-js"
import { formatMarkdown } from "../src/agents/files.js"
import { createHandlers, createState } from "../src/index.js"
import { resolve, scopesOf } from "../src/instructions/model.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { enable } from "../src/project.js"
import type { Snapshot } from "../src/rpc.js"
import { Definition } from "../src/rpc.js"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import { createSnapshot, renderInstructionsRoute, renderPlusFixture } from "./tui.js"
import type { TestFixture } from "./tui.js"
import { agentInfo, fullContext } from "./harness.js"

const e2eRoots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(e2eRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

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

function selectedRow(frame: string): string {
  const line = frame.split("\n").find((entry) => entry.includes("›"))
  return line ?? ""
}

// Locate rows by label instead of hardcoded moveDown counts from a root, so
// the next structural change does not shift every test. Each step waits for
// the selection to actually move before continuing, so the walk cannot
// outrun the renderer and blow past its target while frames are stale.
async function moveTo(fixture: TestFixture, label: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const before = fixture.captureCharFrame()
    if (selectedRow(before).includes(label)) return
    dispatch(fixture, "down")
    await fixture.waitForFrame((frame) => selectedRow(frame) !== selectedRow(before))
  }
  throw new Error(`never reached row "${label}"`)
}

async function expand(fixture: TestFixture): Promise<void> {
  // Idempotent: only press right when the selected row shows collapsed "+".
  // Roots start expanded ("-"), so a blind right would collapse them.
  const line = selectedRow(fixture.captureCharFrame())
  const rest = line.slice(line.indexOf("›") + 1)
  if (/^\s*- /.test(rest)) return
  dispatch(fixture, "right")
  await sleep(50)
}

// Agents live under their level's Agents group (collapsed by default), so
// every agent-scoped test starts by revealing the named agent row. The
// opening "Instructions" wait doubles as a mount gate, but the agent name
// may already be on screen (the loader resolves between renders), so do not
// require both in one predicate.
async function gotoAgent(fixture: TestFixture, name: string): Promise<void> {
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  await moveTo(fixture, "Agents")
  await expand(fixture)
  await moveTo(fixture, name)
}

// Down-only walk that skips the current row first: used when several rows
// share a label (each level has its own Agents group).
async function moveToNext(fixture: TestFixture, label: string): Promise<void> {
  const before = selectedRow(fixture.captureCharFrame())
  dispatch(fixture, "down")
  await fixture.waitForFrame((frame) => selectedRow(frame) !== before)
  await moveTo(fixture, label)
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
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    // Agents live one level down under each level's Agents group: expand
    // Project's group to reveal Implementer, then the agent itself to reveal
    // its Tools/Base/Skills/System subtree.
    await moveTo(fixture, "Agents")
    await expand(fixture)
    await fixture.waitForFrame((frame) => frame.includes("Implementer"))
    await moveTo(fixture, "Implementer")
    await expand(fixture)
    await fixture.waitForFrame((frame) => frame.includes("Tools"))
    const expanded = fixture.captureCharFrame()
    expect(expanded).toContain("Project")
    expect(expanded).toContain("Global")
    expect(expanded).toContain("Defaults")
    expect(expanded).toContain("Implementer")
    expect(expanded).toContain("Tools")
    expect(expanded).toContain("Base")
    expect(expanded).toContain("Skills")
    expect(expanded).toContain("System")
    // Global's Agents group holds Helper.
    await moveToNext(fixture, "Agents")
    await expand(fixture)
    await fixture.waitForFrame((frame) => frame.includes("Helper"))
    expect(fixture.captureCharFrame()).toContain("Helper")
    expect(fixture.captureCharFrame()).toContain("Agents")
  } finally {
    fixture.destroy()
  }
})

test("selectAgent expands the Agents group chain for any scope", async () => {
  const snapshot = createSnapshot({ agents: [projectAgent("Implementer")] })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    data: { agent: "Implementer" },
  })
  try {
    // Route data drives selectAgent: it must expand root + Agents group so
    // the agent row is revealed and selected. Without the group expansion
    // the row never appears and this times out.
    await fixture.waitForFrame((frame) => frame.includes("Implementer"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("Implementer")
    expect(selectedRow(frame)).toContain("Implementer")
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
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    // Agents start collapsed under group:project:agents; expand it first.
    await moveTo(fixture, "Agents")
    await expand(fixture)
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
    // The overlay lists the filter keys so the grammar is discoverable
    // without leaving the TUI: structural keys grouped, then the slower
    // text-dependent ones.
    expect(fixture.captureCharFrame()).toContain("keys: kind item group")
    expect(fixture.captureCharFrame()).toContain("has id label updated team acked excluded")
    expect(fixture.captureCharFrame()).toContain("slow text:")
    expect(fixture.captureCharFrame()).toContain("shadowed orphan")
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
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    // The `a: add agent` affordance lives on group:project:agents now.
    await moveTo(fixture, "Agents")
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
    // Agent subtree by label: Agents group, agent, System group, item row.
    await gotoAgent(fixture, "Implementer")
    await expand(fixture)
    await moveTo(fixture, "System")
    await expand(fixture)
    await moveTo(fixture, "AGENTS.md")
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
    // Agent subtree by label: Agents group, agent, Tools, subgroup, item.
    await gotoAgent(fixture, "Implementer")
    await expand(fixture)
    await moveTo(fixture, "Tools")
    await expand(fixture)
    await moveToNext(fixture, "Native")
    await expand(fixture)
    await moveTo(fixture, "bash")
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
    await moveTo(fixture, "Tools")
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
    // group:defaults::base carries the add:base affordance.
    await moveTo(fixture, "Base")
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
    await moveTo(fixture, "Tools")
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
    await moveTo(fixture, "Tools")
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
    dialogs: { selects: ["instruction"], prompts: ["AGENTS.md", "guide text"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveTo(fixture, "System")
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame(() => fixture.fake.instructionCreates.length === 1)
    expect(fixture.fake.instructionCreates.length).toBe(1)
    expect(fixture.fake.instructionCreates[0]).toMatchObject({ name: "AGENTS.md", text: "guide text" })
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
    // group:defaults::mcp carries the add:mcp affordance.
    await moveTo(fixture, "MCP")
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
    await gotoAgent(fixture, "Implementer")
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
    // Defaults group order from root:project: Agents, Global, Defaults —
    // expand Defaults, then drill into Skills, the group row, and the item.
    await moveTo(fixture, "Defaults")
    await expand(fixture)
    await moveTo(fixture, "Skills")
    await expand(fixture)
    await moveTo(fixture, "Project")
    await expand(fixture)
    await moveTo(fixture, "proj-one")
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
    // Native skills hang under Defaults → Skills → Native.
    await moveTo(fixture, "Defaults")
    await expand(fixture)
    await moveTo(fixture, "Skills")
    await expand(fixture)
    await moveTo(fixture, "Native")
    await expand(fixture)
    await moveTo(fixture, "native-one")
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

test("created project instruction deletes through instruction.delete and the row disappears", async () => {
  // End to end through the production path: real instruction.create writes
  // <project>/AGENTS.md, real instructions.snapshot discovers it with
  // project-owned group, the route renders it with a d binding, d calls the
  // real instruction.delete, and the refreshed snapshot drops the row.
  // The group:"project" item is the project-owned AGENTS.md; the
  // group:"none" item is an ancestor file outside the project and must offer
  // no delete.
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-instruction-delete-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await enable(project)
  const ctx = fullContext({ directory: project, agents: [agentInfo("alpha", "upstream")] })
  const handlers = createHandlers(ctx, createState())
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["instruction.create"]({ name: "AGENTS.md", text: "Follow the guide." }, throwing))
  const before = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
  const owned = before.items.find((item) => item.id === "system:AGENTS.md")
  expect(owned?.text).toContain("Follow the guide.")
  expect(owned?.group).toBe("project")
  expect(before.items.some((item) => item.id === "system:AGENTS.md" && item.group !== "project")).toBe(false)
  const ancestor: Snapshot = {
    ...before,
    items: [
      ...before.items,
      {
        id: "system:../AGENTS.md",
        kind: "system",
        group: "none",
        title: "../AGENTS.md",
        text: "ancestor guide",
        enabled: true,
        fingerprint: "fp-ancestor",
      },
    ],
  }
  const afterCreate = await Effect.runPromise(handlers["instruction.delete"]({ name: "AGENTS.md" }, throwing))
  expect(afterCreate).toEqual({ id: "system:AGENTS.md", path: path.join(project, "AGENTS.md") })
  const afterDelete = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
  expect(afterDelete.items.some((item) => item.id === "system:AGENTS.md")).toBe(false)
  // Re-create so the route renders the row, then delete through the UI.
  await Effect.runPromise(handlers["instruction.create"]({ name: "AGENTS.md", text: "Follow the guide." }, throwing))
  const live = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
  const liveSnapshots: Snapshot[] = [{ ...live, items: [...live.items, ancestor.items[ancestor.items.length - 1]] }]
  const ancestorItem = liveSnapshots[0].items[liveSnapshots[0].items.length - 1]
  if (ancestorItem === undefined) throw new Error("expected the injected ancestor item")
  const instructionDeletes: { name: string }[] = []
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { confirms: [true] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          const fresh = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
          // The ancestor row is synthetic (the real project has no ancestor
          // file): keep it across the refresh so the refusal half of this
          // test still has a row to navigate to.
          liveSnapshots.push(
            fresh.items.some((item) => item.id === ancestorItem.id) ? fresh : { ...fresh, items: [...fresh.items, ancestorItem] },
          )
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "instruction.delete": async (input: { name: string }) => {
          instructionDeletes.push({ ...input })
          return Effect.runPromise(handlers["instruction.delete"](input, throwing))
        },
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Project-owned row offers d and deletes through the real handler.
    await moveTo(fixture, "Defaults")
    await expand(fixture)
    await moveTo(fixture, "System")
    await expand(fixture)
    await moveTo(fixture, "AGENTS.md")
    await fixture.waitForFrame((frame) => frame.includes("Follow the guide."))
    expect(binds(fixture)).toContain("d")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes("Deleted instruction AGENTS.md"))
    expect(instructionDeletes).toEqual([{ name: "AGENTS.md" }])
    await fixture.waitForFrame((frame) => !frame.includes("Follow the guide."))
    // Ancestor row offers d only as a refusal path: the handler would reject
    // traversal, so state.remove refuses without calling instruction.delete.
    await moveTo(fixture, "../AGENTS.md")
    expect(binds(fixture)).toContain("d")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes("is not project-owned"))
    expect(instructionDeletes).toEqual([{ name: "AGENTS.md" }])
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
    await gotoMcpItem(fixture)
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
    await gotoMcpItem(fixture)
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
    await gotoMcpItem(fixture)
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
    // Root row: structural, no space/d/r/s. Goto gates the mount first.
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    const rootBinds = binds(fixture)
    expect(rootBinds).toContain("a")
    expect(rootBinds).not.toContain("space")
    expect(rootBinds).not.toContain("d")
    expect(rootBinds).not.toContain("r")
    expect(rootBinds).not.toContain("s")
    // Agent row: removable, so d appears but space still does not. The agent
    // hides under its Agents group; the initial Implementer frame only gates
    // the mount, then gotoAgent reveals the row.
    await gotoAgent(fixture, "Implementer")
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
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
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

// Defaults MCP inventory: expand Defaults, the MCP group, then move through
// the per-server subgroup rows to the item. waitForFrame only polls up to 20
// frames (~a second), so each navigation step must also wait for the *frame*
// to catch up, not just sleep: the final wait targets the item row directly.
async function gotoMcpItem(fixture: TestFixture): Promise<void> {
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  await moveTo(fixture, "Defaults")
  await expand(fixture)
  await moveTo(fixture, "MCP")
  await expand(fixture)
  await moveTo(fixture, "sample")
  await fixture.waitForFrame((frame) => selectedRow(frame).includes("sample"))
}

test("narrow detail opens with right and closes with escape", async () => {
  const snapshot = createSnapshot({ items: [mcpItem()] })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 80, height: 40 })
  try {
    await gotoMcpItem(fixture)
    dispatch(fixture, "right")
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
    await gotoMcpItem(fixture)
    dispatch(fixture, "right")
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
    await gotoMcpItem(fixture)
    dispatch(fixture, "right")
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
    await gotoMcpItem(fixture)
    dispatch(fixture, "right")
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
    // Defaults tools branch: expand Defaults, Tools, the Native subgroup,
    // then move to the item.
    await moveTo(fixture, "Defaults")
    await expand(fixture)
    await moveTo(fixture, "Tools")
    await expand(fixture)
    await moveTo(fixture, "Native")
    await expand(fixture)
    await moveTo(fixture, "bash")
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
    await gotoMcpItem(fixture)
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
    await fixture.waitForFrame((frame) => frame.includes("Project"))
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
    await gotoMcpItem(fixture)
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
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    expect(dispatch(fixture, "/")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Filter:"))
    // Filtered list walks to the revealed tool row by label.
    await moveTo(fixture, "zz-unique-tool")
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

function codemodeSnapshot(): Snapshot {
  return createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "tool:coder",
        kind: "tool" as const,
        group: "native" as const,
        title: "coder",
        text: "# Alpha\n\na\n\n# Beta\n\nb\n",
        enabled: true,
        fingerprint: "fp-coder",
        codemode: true,
      },
    ],
  })
}

test("Code Mode sections refuse toggle and edit without saving", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [codemodeSnapshot()], width: 120, height: 40 })
  try {
    // Navigate INTO the Code Mode tool by label: agent subtree, Tools group,
    // Native subgroup, item row, then its auto-derived sections.
    await gotoAgent(fixture, "Implementer")
    await expand(fixture)
    await moveTo(fixture, "Tools")
    await expand(fixture)
    await moveToNext(fixture, "Native")
    await expand(fixture)
    await moveTo(fixture, "coder")
    expect(selectedRow(fixture.captureCharFrame())).toContain("[unsupported]")
    expect(binds(fixture)).not.toContain("space")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => frame.includes("Alpha"))
    await moveTo(fixture, "Alpha")
    expect(selectedRow(fixture.captureCharFrame())).toContain("[unsupported]")
    expect(binds(fixture)).not.toContain("space")
    // No space binding: the keypress cannot reach state.toggle at all.
    expect(dispatch(fixture, "space")).toBe(false)
    expect(fixture.fake.mutateInputs.length).toBe(0)
    // Enter must not open the editor for a gated section either.
    dispatch(fixture, "return")
    await sleep(100)
    expect(fixture.captureCharFrame()).not.toContain("ctrl+s save")
    expect(fixture.fake.mutateInputs.length).toBe(0)
    expect(fixture.captureCharFrame()).not.toContain("Saved")
    expect(fixture.captureCharFrame()).not.toContain("Disabled")
  } finally {
    fixture.destroy()
  }
})

test("whole Role/persona and whole base rows refuse toggle without saving", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "system:role",
        kind: "system" as const,
        group: "none" as const,
        title: "Role",
        text: "# Purpose\n\na\n\n# Usage\n\nb\n",
        enabled: true,
        fingerprint: "fp-role",
        agents: ["Implementer"],
      },
      {
        id: "base:gpt",
        kind: "base" as const,
        group: "none" as const,
        title: "gpt.txt",
        text: "gpt base",
        enabled: true,
        fingerprint: "fp-gpt",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await gotoAgent(fixture, "Implementer")
    await expand(fixture)
    await moveTo(fixture, "System")
    await expand(fixture)
    await moveTo(fixture, "Role/persona")
    expect(selectedRow(fixture.captureCharFrame())).toContain("[unsupported]")
    expect(binds(fixture)).not.toContain("space")
    expect(dispatch(fixture, "space")).toBe(false)
    expect(fixture.fake.mutateInputs.length).toBe(0)
    // Section toggles under the same role still apply: exclusions assemble.
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => frame.includes("Purpose"))
    await moveTo(fixture, "Purpose")
    expect(binds(fixture)).toContain("space")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "Purpose"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    // Whole base row: same refusal, navigated by label through Base.
    await moveTo(fixture, "Base")
    await expand(fixture)
    await moveTo(fixture, "gpt.txt")
    expect(selectedRow(fixture.captureCharFrame())).toContain("[unsupported]")
    expect(binds(fixture)).not.toContain("space")
    expect(dispatch(fixture, "space")).toBe(false)
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const frame = fixture.captureCharFrame()
    expect(frame).not.toContain('Disabled "gpt.txt"')
  } finally {
    fixture.destroy()
  }
})

test("filter matching a Code Mode section exposes no editable row", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [codemodeSnapshot()],
    width: 120,
    height: 40,
    dialogs: { prompts: ["Alpha"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    expect(dispatch(fixture, "/")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Filter:"))
    // The gated section label matches, but the filter path must not expose
    // it as a selectable row: the tree keeps only the ancestor chain, so no
    // row can carry the section into space/enter.
    await fixture.waitForFrame((frame) => frame.includes("No instructions found"))
    const frame = fixture.captureCharFrame()
    expect(frame).not.toContain("›")
    expect(binds(fixture)).not.toContain("space")
    expect(dispatch(fixture, "space")).toBe(false)
    expect(fixture.fake.mutateInputs.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("provenance flags travel real discovery -> snapshot -> rendered rows", async () => {
  // End to end through the production path: a real tool registry entry with
  // default options (Code Mode) and a real user base template on disk, read
  // by real discovery, encoded by the real toSnapshot, rendered by the route.
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-e2e-"))
  e2eRoots.push(root)
  const config = path.join(root, "config")
  process.env.OPENCODE_CONFIG_DIR = config
  const project = path.join(root, "project")
  await enable(project)
  const ctx = fullContext({
    directory: project,
    tools: [
      { id: "coder", description: "code mode tool" },
      { id: "reader", description: "native tool", options: { codemode: false } },
    ],
  })
  const handlers = createHandlers(ctx, createState())
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(
    handlers["base.create"]({ id: "custom", title: "Custom.txt", text: "custom base" }, throwing),
  )
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
  expect(snapshot.items.find((item) => item.id === "base:custom")?.userBase).toBe(true)
  expect(snapshot.items.find((item) => item.id === "tool:coder")?.codemode).toBe(true)
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await moveTo(fixture, "Defaults")
    await expand(fixture)
    // Shared-group order is Tools before Base, and moveTo only walks down.
    await moveTo(fixture, "Tools")
    await expand(fixture)
    await moveTo(fixture, "Native")
    await expand(fixture)
    await moveTo(fixture, "coder")
    const toolRow = selectedRow(fixture.captureCharFrame())
    expect(toolRow).toContain("coder")
    expect(toolRow).toContain("[unsupported]")
    const keys = binds(fixture)
    expect(keys).not.toContain("space")
    expect(keys).not.toContain("s")
    await fixture.waitForFrame((frame) => frame.includes("code mode tool"))
    expect(fixture.captureCharFrame()).toContain("[unsupported]")
    await moveTo(fixture, "Base")
    await expand(fixture)
    await moveTo(fixture, "Custom.txt")
    const baseRow = selectedRow(fixture.captureCharFrame())
    expect(baseRow).toContain("Custom.txt")
    expect(baseRow).toContain("[inactive]")
    expect(binds(fixture)).toContain("d")
  } finally {
    fixture.destroy()
  }
})
test("team row toggles through the real team.setEnabled and the rebuilt tree shows the new state", async () => {
  // End to end through the production path: a real team on disk, a real
  // snapshot carrying `teams`, the real route rendering it, the real
  // team.setEnabled handler toggling it, and the refreshed snapshot
  // rebuilding the tree. The fixture has no team RPC mock, so the route's
  // `team.setEnabled` call is wired to the real handlers and every wire is
  // asserted: the call arguments, the stored record, and the rebuilt row.
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-teams-e2e-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await enable(project)
  const teamDir = path.join(projectTeamsPath(project), "crew")
  await fs.mkdir(path.join(teamDir, "nested"), { recursive: true })
  await Bun.write(
    path.join(teamDir, "alpha.md"),
    formatMarkdown({ description: "crew/alpha" }, "alpha role"),
  )
  await Bun.write(
    path.join(teamDir, "nested", "beta.md"),
    formatMarkdown({ description: "crew/nested/beta" }, "beta role"),
  )
  const ctx = fullContext({ directory: project })
  // Empty built-in registry: this test pins the disk-only team universe, not
  // the shipped roster (covered by the dedicated well-formedness test).
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const teamToggles: { level: string; team: string; enabled: boolean }[] = []
  const wrappedTeamSetEnabled = async (input: { level: "project" | "global"; team: string; enabled: boolean }) => {
    teamToggles.push({ ...input })
    return Effect.runPromise(handlers["team.setEnabled"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha", "nested/beta"] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.setEnabled": wrappedTeamSetEnabled,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Navigate by label: Project root, its Teams group (beside Agents), the
    // crew row, then its member rows.
    await moveTo(fixture, "Teams")
    await expand(fixture)
    await moveTo(fixture, "crew")
    // The disabled row renders its badge in the visible frame.
    expect(selectedRow(fixture.captureCharFrame())).toContain("[off]")
    expect(binds(fixture)).toContain("space")
    await expand(fixture)
    await fixture.waitForFrame((frame) => frame.includes("nested/beta"))
    expect(fixture.captureCharFrame()).toContain("alpha")
    await moveTo(fixture, "crew")
    // Space calls the real team.setEnabled with the inverted state.
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Enabled team "crew"'))
    expect(teamToggles).toEqual([{ level: "project", team: "crew", enabled: true }])
    // The toggle republishes: refresh pulls a fresh snapshot whose teams
    // entry reads enabled, and the rebuilt tree shows the new badge.
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("crew") && selectedRow(frame).includes("[on]"))
    const selected = selectedRow(fixture.captureCharFrame())
    expect(selected).toContain("crew")
    expect(selected).toContain("[on]")
    expect(liveSnapshots[liveSnapshots.length - 1].teams).toEqual([
      { level: "project", team: "crew", enabled: true, agents: ["alpha", "nested/beta"] },
    ])
    // Toggle back off through the same path: the call inverts again.
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled team "crew"'))
    expect(teamToggles).toEqual([
      { level: "project", team: "crew", enabled: true },
      { level: "project", team: "crew", enabled: false },
    ])
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("crew") && selectedRow(frame).includes("[off]"))
  } finally {
    fixture.destroy()
  }
})

test("a on the Teams group creates through the real team.create and the rebuilt tree shows the disabled row", async () => {
  // End to end through the production path: no team on disk, the always-
  // present Teams group still offers `a`, the real team.create handler makes
  // the directory DISABLED, and the refreshed snapshot rebuilds the tree with
  // the new off row. Mirrors the add-agent picker test (name then scope) and
  // the team-toggle rebuild test (real RPC plus live snapshots).
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-create-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await enable(project)
  const ctx = fullContext({ directory: project })
  // Empty built-in registry: this test pins the disk-only team universe, not
  // the shipped roster (covered by the dedicated well-formedness test).
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const teamCreates: { level: string; team: string }[] = []
  const wrappedTeamCreate = async (input: { level: "project" | "global"; team: string }) => {
    teamCreates.push({ ...input })
    return Effect.runPromise(handlers["team.create"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams ?? []).toEqual([])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["fresh"], selects: ["project"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.create": wrappedTeamCreate,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // The empty Teams group is always present beside Agents: `a` on it
    // prompts for a name then a project/global scope.
    await moveTo(fixture, "Teams")
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame(() => teamCreates.length === 1)
    expect(teamCreates).toEqual([{ level: "project", team: "fresh" }])
    // The create republishes: refresh pulls a fresh snapshot whose teams
    // entry reads disabled, and the rebuilt tree shows the new off row.
    await fixture.waitForFrame(() => (liveSnapshots[liveSnapshots.length - 1].teams ?? []).length === 1)
    expect(liveSnapshots[liveSnapshots.length - 1].teams).toEqual([
      { level: "project", team: "fresh", enabled: false, agents: [] },
    ])
    await moveTo(fixture, "Teams")
    await expand(fixture)
    await moveTo(fixture, "fresh")
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("fresh") && selectedRow(frame).includes("[off]"))
    const selected = selectedRow(fixture.captureCharFrame())
    expect(selected).toContain("fresh")
    expect(selected).toContain("[off]")
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
    // Agent subtree by label: Agents group, agent, System group, Role item.
    // The Implementer agent sorts first inside the group; move past it.
    await gotoAgent(fixture, "Implementer")
    await moveToNext(fixture, "Reviewer")
    await expand(fixture)
    await moveTo(fixture, "System")
    await expand(fixture)
    await moveTo(fixture, "Role/persona")
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
