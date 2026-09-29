import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createComponent } from "solid-js"
import { formatMarkdown } from "../src/agents/files.js"
import { createHandlers, createPlusApi, createState } from "../src/index.js"
import { fingerprint, resolve, scopesOf } from "../src/instructions/model.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { load, save } from "../src/instructions/store.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { expandedTree } from "../src/instructions/tree.js"
import type { PresetRef, Snapshot } from "../src/rpc.js"
import { Definition } from "../src/rpc.js"
import { createInstructionsDialogs } from "../src/tui/instructions/dialogs.js"
import { HELP, HelpDialog } from "../src/tui/instructions/help.js"
import { factsOf, notesOf } from "../src/tui/instructions/inspector.js"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import { createSnapshot, renderInstructionsRoute, renderPlusFixture } from "./tui.js"
import type { TestFixture } from "./tui.js"
import { agentInfo, fullContext } from "./harness.js"
import { binds, breadcrumb, category, dispatch, expand, footer, gotoLevel, levelOf, moveTo, reach, reachCategory, selectedRow, sleep, toSidebar } from "./instructions-nav.js"

const e2eRoots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(e2eRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

// reach() as a user does it (filter by id, enter goes to the row), with two
// differences: `id:` matches by prefix (team:project:crew also matches its
// members), so the negated `<id>:` prefix keeps exactly the row itself; and
// the Presets level's full tree can take longer to filter than
// waitForFrame's 20 passes.
async function goto(fixture: TestFixture, id: string, label: string): Promise<void> {
  await gotoLevel(fixture, levelOf(id))
  await toSidebar(fixture)
  if (!dispatch(fixture, "/")) throw new Error("no filter key")
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  const query = `id:${id} !id:${id}:`
  await fixture.typeText(query)
  await until(fixture, (frame) => frame.includes(query.slice(-24)))
  // Let the debounced filter (150 ms) apply the whole query.
  await sleep(250)
  await until(fixture, (frame) => footer(frame).includes("esc clear filter") && selectedRow(frame).includes(label))
  dispatch(fixture, "return")
  await until(fixture, (frame) => !footer(frame).includes("esc clear filter") && selectedRow(frame).includes(label))
}

// Open the selected item row and the Description group its sections may
// hang under, until the section row `label` shows in the list.
async function showSection(fixture: TestFixture, label: string): Promise<void> {
  await expand(fixture)
  await sleep(50)
  if (!listPane(fixture.captureCharFrame()).includes(label) && listPane(fixture.captureCharFrame()).includes("▸ Description")) {
    await moveTo(fixture, "Description")
    await expand(fixture)
  }
  await fixture.waitForFrame((frame) => listPane(frame).includes(label))
}

// Type into the live filter of the current level and let it apply.
async function filter(fixture: TestFixture, text: string): Promise<void> {
  await toSidebar(fixture)
  expect(dispatch(fixture, "/")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  await fixture.typeText(text)
  await fixture.waitForFrame((frame) => frame.includes(`/ ${text}`))
  await sleep(250)
}

// The filter lands on its first leaf match (often a section below the item
// the words name): walk up to the first result, then down to `label`.
async function moveToResult(fixture: TestFixture, label: string): Promise<void> {
  for (let step = 0; step < 40; step++) {
    const before = selectedRow(fixture.captureCharFrame())
    dispatch(fixture, "up")
    // Long enough for the move to render: a stale frame would stop the
    // walk early or leave moveTo comparing against an old row.
    await sleep(80)
    if (selectedRow(fixture.captureCharFrame()) === before) break
  }
  await moveTo(fixture, label)
}

// waitForFrame gives up after 20 render passes; a create flow's refresh
// through the real handlers can take longer before its row shows.
async function until(fixture: TestFixture, predicate: (frame: string) => boolean, timeout = 4000): Promise<string> {
  for (let waited = 0; waited < timeout; waited += 50) {
    const frame = fixture.captureCharFrame()
    if (predicate(frame)) return frame
    await sleep(50)
  }
  return fixture.waitForFrame(predicate)
}

const SIDEBAR = 30

// The cursor row of the sidebar alone: on a wide frame the same line also
// carries the list (the owner's name, its category tabs).
function sidebarRow(frame: string): string {
  return selectedRow(frame).slice(0, SIDEBAR - 1)
}

// moveTo for the sidebar: Down until the sidebar's cursor row shows `label`.
async function navTo(fixture: TestFixture, label: string): Promise<void> {
  for (let step = 0; step < 80; step++) {
    const before = fixture.captureCharFrame()
    if (sidebarRow(before).includes(label)) return
    dispatch(fixture, "down")
    await fixture.waitForFrame((frame) => sidebarRow(frame) !== sidebarRow(before))
  }
  throw new Error(`never reached sidebar row "${label}"`)
}

// The list column of a wide frame: between the two divider pipes.
function listPane(frame: string): string {
  return frame
    .split("\n")
    .slice(2)
    .map((line) => {
      const owners = line.indexOf("│")
      if (owners === -1) return line.slice(SIDEBAR)
      const inspector = line.indexOf("│", owners + 1)
      return inspector === -1 ? line.slice(owners + 1) : line.slice(owners + 1, inspector)
    })
    .join("\n")
}

// The inspector's text without whitespace, so a fact reads the same however
// the pane wraps it; compare with flat(text).
function inspector(frame: string): string {
  return flat(
    frame
      .split("\n")
      .slice(2)
      .flatMap((line) => {
        const owners = line.indexOf("│", SIDEBAR)
        if (owners === -1) return []
        const at = line.indexOf("│", owners + 1)
        return at === -1 ? [] : [line.slice(at + 1)]
      })
      .join(""),
  )
}

function flat(text: string): string {
  return text.replace(/\s+/g, "")
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

function projectAgent(id: string, origin: "native" | "special" | "plus" | "user" = "user") {
  return { id, scope: "project" as const, fileBacked: true, origin }
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
    // The levels are tabs; the Project sidebar lists Agents › User ›
    // Implementer, and the selected agent's categories are tabs over the list.
    await goto(fixture, "agent:project:Implementer", "Implementer")
    await fixture.waitForFrame((frame) => frame.includes("Tools"))
    const expanded = fixture.captureCharFrame()
    expect(expanded.split("\n")[0]).toContain("Project")
    expect(expanded.split("\n")[0]).toContain("Global")
    expect(expanded.split("\n")[0]).toContain("Defaults")
    expect(breadcrumb(expanded)).toContain("Project › Agents › User › Implementer")
    expect(expanded).toContain("Implementer")
    expect(expanded).toContain("Tools")
    expect(expanded).toContain("Base")
    expect(expanded).toContain("Skills")
    expect(expanded).toContain("System")
    // Global's Agents group holds Helper under its User subgroup.
    await goto(fixture, "agent:global:Helper", "Helper")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("Global › Agents › User › Helper")
    expect(fixture.captureCharFrame()).toContain("Helper")
    expect(fixture.captureCharFrame()).toContain("Agents")
  } finally {
    fixture.destroy()
  }
})

test("structural rows show their description in the inspector", async () => {
  const snapshot = createSnapshot({ agents: [projectAgent("alice", "plus")], items: [toolItem()] })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 160, height: 40 })
  try {
    // The Agents catalogue and an origin subgroup answer with their own line
    // in the right pane, as the muted note the inspector already renders.
    await goto(fixture, "group:project:agents", "Agents")
    await fixture.waitForFrame((frame) =>
      inspector(frame).includes(
        flat(
          "Agents defined for this project. Rows here override Global and Defaults for this project; a stand-alone agent resolves through this catalogue, a team member through Teams.",
        ),
      ),
    )
    await goto(fixture, "group:project:agents:plus", "Plus")
    await fixture.waitForFrame((frame) =>
      inspector(frame).includes(flat("Agents produced by OpenCodePlus teams, including the shipped teams' members. A linked preset decides how a member behaves.")),
    )
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
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    // The live filter replaces the list with the matches and their
    // ancestors; the sidebar keeps listing every owner.
    await filter(fixture, "Implementer")
    await fixture.waitForFrame((frame) => listPane(frame).includes("Implementer"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("/ Implementer")
    expect(footer(frame)).toContain("esc clear filter")
    expect(listPane(frame)).toContain("Implementer")
    expect(listPane(frame)).not.toContain("Helper")
  } finally {
    fixture.destroy()
  }
})

// `?` opens the help dialog (the host dialog, not text in the screen); the
// dialog renders HELP, which lists the keys and the whole filter grammar.
test("help dialog lists keys and leaves the screen untouched", async () => {
  const shown: unknown[] = []
  const fixture = await renderPlusFixture({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    render: (context) => {
      const show = context.ui.dialog.show
      context.ui.dialog.show = ((element: unknown) => {
        shown.push(element)
        return (show as (element: unknown) => unknown)(element)
      }) as typeof show
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    const before = fixture.captureCharFrame()
    expect(binds(fixture)).toContain("?")
    expect(footer(before)).toContain("? help")
    expect(dispatch(fixture, "?")).toBe(true)
    expect(shown.length).toBe(1)
    await sleep(50)
    expect(fixture.captureCharFrame()).not.toContain("keep yours or take the new value")
    expect(footer(fixture.captureCharFrame())).toContain("? help")
  } finally {
    fixture.destroy()
  }
  const keys = new Map(HELP.flatMap(([, entries]) => entries))
  expect(keys.get("space")).toContain("on/off")
  expect(keys.get("p")).toContain("pin a Code Mode tool")
  expect(keys.get("l")).toBe("link an agent, member, team, entry or User preset to a preset (or unlink)")
  expect([...keys.values()].some((label) => label.includes("keep yours or take the new value"))).toBe(true)
  // The filter keys stay discoverable without leaving the TUI: structural
  // keys first, then the slower text-dependent ones.
  const grammar = HELP.find(([group]) => group === "Filter")?.[1].map(([key, label]) => `${key} ${label}`).join("\n") ?? ""
  expect(grammar).toContain("kind item group")
  expect(grammar).toContain("namespace")
  expect(grammar).toContain("pinned")
  expect(grammar).toContain("execute")
  expect(grammar).toContain("has id label updated team acked excluded")
  // The reworked help names the slower keys it can serve (text upstream
  // tokens delta) instead of the old overlay's shadowed/orphan pair.
  expect(grammar).toContain("text upstream tokens delta")
  // The dialog renders that content.
  const dialog = await renderPlusFixture({
    snapshots: [createSnapshot()],
    width: 120,
    height: 60,
    render: (context) => createComponent(HelpDialog, { context }),
  })
  try {
    const frame = await dialog.waitForFrame((next) => next.includes("Filter"))
    expect(frame).toContain("link an agent, member, team, entry or User preset to a preset (or unlink)")
    expect(frame).toContain("keep yours or take the new value")
  } finally {
    dialog.destroy()
  }
})

// DESIGN §5: a → name → preset → done. On the Project Agents group the
// scope comes from the cursor; "None — everything off" creates no link.
test("add agent asks the name, then the preset, on the Project Agents group", async () => {
  const snapshot = createSnapshot({
    agents: [{ id: "Template", scope: "defaults" as const, fileBacked: true }],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { selects: ["member:basic/planner", "__none__"], prompts: ["my-agent", "bare"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    // The `a: add agent` affordance lives on group:project:agents, the
    // sidebar's Agents catalogue.
    await goto(fixture, "group:project:agents", "Agents")
    expect(dispatch(fixture, "a")).toBe(true)
    await sleep(200)
    expect(fixture.fake.agentCreates.length).toBe(1)
    expect(fixture.fake.agentCreates[0]).toEqual({ scope: "project", id: "my-agent", preset: { kind: "member", team: "basic", id: "planner" } })
    expect(fixture.fake.dialogPrompts.map(([title]) => title)).toEqual(["Create agent"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Preset"])
    expect(dispatch(fixture, "a")).toBe(true)
    await sleep(200)
    expect(fixture.fake.agentCreates[1]).toEqual({ scope: "project", id: "bare" })
  } finally {
    fixture.destroy()
  }
})

test("a on an instruction row adds a section with split plus customization records", async () => {
  const body = "# Purpose\n\na\n\n# Usage\n\nb\n"
  const after: Snapshot = createSnapshot({
    // The rebuilt tree still has the agent the section was added under.
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
    // Implementer › System › the item row.
    await goto(fixture, "item:project:Implementer:system:AGENTS.md", "AGENTS.md")
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
    // snapshot carries the same split, so the row renders by name once the
    // item is open.
    await fixture.emitChanged()
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("AGENTS.md") && /[▸▾]/.test(selectedRow(frame)))
    await showSection(fixture, "Notes")
    expect(listPane(fixture.captureCharFrame())).toContain("Notes")
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
    dialogs: { selects: ["section"], prompts: ["Flags", "extra flags"] },
  })
  try {
    // Implementer › Tools › OpenCode › the item.
    await goto(fixture, "item:project:Implementer:tool:bash", "bash")
    await fixture.waitForFrame((frame) => frame.includes("run commands"))
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes('Added "Flags"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    // The tool row hosts both sections and rules, so `a` offers the choice.
    expect(fixture.fake.dialogSelects.length).toBe(1)
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
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("bash") && /[▸▾]/.test(selectedRow(frame)))
    await showSection(fixture, "Flags")
    expect(listPane(fixture.captureCharFrame())).toContain("Flags")
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
    await reachCategory(fixture, "group:defaults::tools", "Tools")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.skillCreates.length === 1)
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
    await reachCategory(fixture, "group:defaults::base", "Base")
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
    await reachCategory(fixture, "group:defaults::tools", "Tools")
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
    await reachCategory(fixture, "group:defaults::tools", "Tools")
    expect(dispatch(fixture, "a")).toBe(true)
    await sleep(200)
    expect(fixture.fake.skillImports.length).toBe(1)
    expect(fixture.fake.skillImports[0]).toMatchObject({ path: "path/to/SKILL.md" })
  } finally {
    fixture.destroy()
  }
})

// OpenCodePlus: AGENTS.md handling is disabled pending the Context catalogue
// (src/instructions/discover.ts), so instruction.create is not offered from
// the System category: its synthesized Role/persona row owns `a` (a section)
// and the category's own add never gets reached. Skipped, not deleted, so the
// rework re-enables it with the feature (see the other instruction.create
// test below).
test.skip("add instruction prompts for name and text", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    dialogs: { selects: ["instruction"], prompts: ["AGENTS.md", "guide text"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // With instruction adds enabled again, this should reach the System
    // category and prompt for name and text; today the category's
    // synthesized Role/persona row owns `a` and the category's own
    // add:"instruction" is never reached (see the skip comment).
    await reach(fixture, "group:defaults::system", "System")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.instructionCreates.length === 1)
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
    await reachCategory(fixture, "group:defaults::mcp", "MCP")
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
    await goto(fixture, "agent:project:Implementer", "Implementer")
    expect(binds(fixture)).toContain("d")
    expect(footer(fixture.captureCharFrame())).toContain("d delete")
    expect(dispatch(fixture, "d")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Deleted agent Implementer"))
    expect(fixture.fake.agentDeletes.length).toBe(1)
    expect(fixture.fake.dialogConfirms.length).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("defaults agent row offers no d delete", async () => {
  // Defaults agents cannot be deleted (removalPlan refuses scope defaults),
  // so the row must not bind `d` or advertise it in the footer.
  const snapshot = createSnapshot({ agents: [{ id: "Template", scope: "defaults" as const, fileBacked: true }] })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:defaults:Template", "Template")
    expect(binds(fixture)).toContain("d")
    expect(footer(fixture.captureCharFrame())).not.toContain("d delete")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes("cannot be deleted"))
    expect(fixture.fake.agentDeletes.length).toBe(0)
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
    // Defaults › Every agent › Skills › Project › the item.
    await reach(fixture, "item:defaults::skill:proj-one", "proj-one")
    await fixture.waitForFrame((frame) => frame.includes("project skill"))
    expect(binds(fixture)).toContain("d")
    expect(footer(fixture.captureCharFrame())).toContain("d delete")
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
    // OpenCode skills hang under Defaults → Every agent → Skills → OpenCode.
    await reach(fixture, "item:defaults::skill:native-one", "native-one")
    await fixture.waitForFrame((frame) => frame.includes("upstream skill"))
    expect(binds(fixture)).toContain("d")
    expect(footer(fixture.captureCharFrame())).not.toContain("d delete")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes("cannot be deleted"))
    expect(fixture.fake.skillDeletes.length).toBe(0)
    expect(fixture.fake.agentDeletes.length).toBe(0)
    expect(fixture.fake.mcpRemoves.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

// OpenCodePlus: AGENTS.md handling is disabled pending the Context catalogue
// (src/instructions/discover.ts). Tests that exist only to exercise AGENTS.md
// rows, their apply, or instruction.create/delete are skipped, not deleted, so
// the rework re-enables them with the feature.
test.skip("created project instruction deletes through instruction.delete and the row disappears", async () => {
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
    await reach(fixture, "item:defaults::system:AGENTS.md", "AGENTS.md")
    await fixture.waitForFrame((frame) => frame.includes("Follow the guide."))
    expect(binds(fixture)).toContain("d")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes("Deleted instruction AGENTS.md"))
    expect(instructionDeletes).toEqual([{ name: "AGENTS.md" }])
    await fixture.waitForFrame((frame) => !frame.includes("Follow the guide."))
    await reach(fixture, "item:defaults::system:../AGENTS.md", "../AGENTS.md")
    expect(binds(fixture)).toContain("d")
    expect(footer(fixture.captureCharFrame())).not.toContain("d delete")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes("cannot be deleted"))
  } finally {
    fixture.destroy()
  }
})

test("tool row does not offer d delete", async () => {
  const snapshot = createSnapshot({
    agents: [{ id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const }],
    items: [
      {
        id: "tool:read",
        kind: "tool" as const,
        group: "native" as const,
        title: "read",
        text: "read file",
        enabled: true,
        fingerprint: "fp-read",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Defaults › build › Tools › OpenCode › read.
    await goto(fixture, "item:defaults:build:tool:read", "read")
    expect(binds(fixture)).toContain("d")
    expect(footer(fixture.captureCharFrame())).toContain("space toggle")
    expect(footer(fixture.captureCharFrame())).not.toContain("d delete")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes("cannot be deleted"))
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
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], agents: [agentInfo("Implementer")], width: 120, height: 40 })
  try {
    // A structural row (the sidebar's Agents catalogue): no space/r/s; d
    // produces a status refusal.
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "group:project:agents", "Agents")
    const rootBinds = binds(fixture)
    expect(rootBinds).toContain("a")
    expect(rootBinds).toContain("d")
    expect(rootBinds).not.toContain("space")
    expect(rootBinds).not.toContain("r")
    expect(rootBinds).not.toContain("s")
    // Agent row: Space toggles Enabled; ctrl+space selects without a write.
    await goto(fixture, "agent:project:Implementer", "Implementer")
    const agentBinds = binds(fixture)
    expect(agentBinds).toContain("d")
    expect(agentBinds).toContain("space")
    expect(agentBinds).toContain("ctrl+space")
    expect(footer(fixture.captureCharFrame())).toContain("ctrl+space select")
    dispatch(fixture, "ctrl+space")
    expect(fixture.fake.agentSelects).toEqual(["Implementer"])
    expect(fixture.fake.mutateInputs.length).toBe(0)
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

// Defaults › Every agent › MCP › the server's item.
async function gotoMcpItem(fixture: TestFixture): Promise<void> {
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  await goto(fixture, "item:defaults::mcp:sample", "sample")
}

// A clean merge: mine appended a line, upstream changed another line with a
// gap between them, so the Take result applies both.
function mergeSnapshot(): Snapshot {
  return createSnapshot({
    items: [
      mcpItem({
        text: "one\ntwo upstream\nthree\nfour\n",
        fingerprint: fingerprint("one\ntwo upstream\nthree\nfour\n"),
      }),
    ],
    records: [
      {
        type: "customization" as const,
        level: "defaults" as const,
        agent: null,
        item: "mcp:sample",
        section: null,
        text: "one\ntwo\nthree\nfour\ncustom tail\n",
        basedOn: "fp-old",
        basedOnText: "one\ntwo\nthree\nfour\n",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
}

// A fast-forward: mine equals the original, so the merge is exactly the new
// upstream and t can only drop the override.
function fastForwardSnapshot(): Snapshot {
  return createSnapshot({
    items: [mcpItem({ text: "one\ntwo upstream\n", fingerprint: fingerprint("one\ntwo upstream\n") })],
    records: [
      {
        type: "customization" as const,
        level: "defaults" as const,
        agent: null,
        item: "mcp:sample",
        section: null,
        text: "one\ntwo\n",
        basedOn: "fp-old",
        basedOnText: "one\ntwo\n",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
}

// Narrow: the sidebar and the owner are two pages; the inspector sits under
// the list. Esc goes back to the sidebar page, → on the owner opens it again.
test("narrow list page opens with right and closes with escape", async () => {
  const snapshot = createSnapshot({ items: [mcpItem()] })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 80, height: 40 })
  try {
    await gotoMcpItem(fixture)
    await fixture.waitForFrame((frame) => frame.includes("sample-config") && footer(frame).includes("esc sidebar"))
    expect(fixture.captureCharFrame()).not.toContain("Every member")
    dispatch(fixture, "escape")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc close") && !frame.includes("sample-config"))
    expect(fixture.captureCharFrame()).toContain("Every member")
    expect(selectedRow(fixture.captureCharFrame())).toContain("Every agent")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => frame.includes("sample-config") && footer(frame).includes("esc sidebar"))
    expect(selectedRow(fixture.captureCharFrame())).toContain("sample")
  } finally {
    fixture.destroy()
  }
})

test("enter on a yellow node opens the three-pane diff and k keeps mine", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [reviewSnapshot()], width: 120, height: 40 })
  try {
    await gotoMcpItem(fixture)
    expect(selectedRow(fixture.captureCharFrame())).toContain("!")
    expect(footer(fixture.captureCharFrame())).toContain("enter review")
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("1 Upstream change")
    expect(frame).toContain("2 Your change")
    expect(frame).toContain("3 Take result")
    expect(frame).toContain("k keep mine")
    dispatch(fixture, "k")
    await fixture.waitForFrame((frame) => frame.includes('Kept "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ type: "customization", item: "mcp:sample" })
  } finally {
    fixture.destroy()
  }
})

test("t on a conflicted Take result opens the merged editor and cannot save until resolved", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [reviewSnapshot()], width: 120, height: 40 })
  try {
    await gotoMcpItem(fixture)
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    dispatch(fixture, "t")
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    // The same proposal e opens: both sides changed the only line, so the
    // markers are present and nothing has been persisted or acknowledged.
    expect(editor?.plainText).toBe("<<<<<<< yours\nmine\n=======\nnew-upstream\n>>>>>>> upstream")
    expect(fixture.captureCharFrame()).toContain("cannot be applied automatically")
    expect(fixture.fake.mutateInputs).toEqual([])
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes("Conflict markers remain"))
    expect(fixture.fake.mutateInputs).toEqual([])
    editor?.setText("merged text")
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes('Edited "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ type: "customization", text: "merged text" })
  } finally {
    fixture.destroy()
  }
})

test("t on a clean merge persists the merged text and clears the review only after t", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [mergeSnapshot()], width: 120, height: 40 })
  try {
    await gotoMcpItem(fixture)
    expect(selectedRow(fixture.captureCharFrame())).toContain("!")
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    // Computing and reading the Take result resolves nothing by itself.
    dispatch(fixture, "3")
    await fixture.waitForFrame((frame) => frame.includes("yours → merged result"))
    expect(fixture.captureCharFrame()).toContain("needs review")
    expect(fixture.fake.mutateInputs).toEqual([])
    dispatch(fixture, "t")
    await fixture.waitForFrame((frame) => frame.includes('Merged "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({
      type: "customization",
      item: "mcp:sample",
      text: "one\ntwo upstream\nthree\nfour\ncustom tail\n",
      basedOn: fingerprint("one\ntwo upstream\nthree\nfour\n"),
      basedOnText: "one\ntwo upstream\nthree\nfour\n",
      acknowledged: fingerprint("one\ntwo upstream\nthree\nfour\n"),
    })
  } finally {
    fixture.destroy()
  }
})

test("t on a clean fast-forward drops the override only after t", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [fastForwardSnapshot()], width: 120, height: 40 })
  try {
    await gotoMcpItem(fixture)
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    // Still under review until the user presses t; nothing has been written.
    expect(fixture.captureCharFrame()).toContain("needs review")
    expect(fixture.fake.mutateInputs).toEqual([])
    dispatch(fixture, "t")
    await fixture.waitForFrame((frame) => frame.includes("Took upstream"))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records.some((record) => record.type === "customization")).toBe(false)
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
    // The diff pane mounts its own e edit editor; wait for it before typing.
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    dispatch(fixture, "e")
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    expect(editor).toBeDefined()
    // e edits a merge of the upstream change onto yours; both changed the
    // same line, so the draft carries conflict markers and cannot be saved.
    expect(editor?.plainText).toBe("<<<<<<< yours\nmine\n=======\nnew-upstream\n>>>>>>> upstream")
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes("Conflict markers remain"))
    expect(fixture.fake.mutateInputs.length).toBe(0)
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
    // Defaults tools branch: Defaults › Every agent › Tools › OpenCode › the item.
    await goto(fixture, "item:defaults::tool:bash", "bash")
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
  })
  try {
    // The tool row starts hidden in another category (the list shows
    // Implementer's Settings); filtering must reveal it with its ancestor chain.
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    expect(fixture.captureCharFrame()).not.toContain("zz-unique-tool")
    await filter(fixture, "zz-unique")
    await fixture.waitForFrame((frame) => listPane(frame).includes("zz-unique-tool"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("/ zz-unique")
    expect(listPane(frame)).toContain("zz-unique-tool")
    expect(listPane(frame)).toContain("Implementer")
    expect(listPane(frame)).toContain("Tools")
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
    // Right expands the item row itself; the section rows appear in the list
    // with their on/off glyph.
    await expand(fixture)
    await fixture.waitForFrame((frame) => listPane(frame).includes("● Purpose"))
    await moveTo(fixture, "Purpose")
    expect(selectedRow(fixture.captureCharFrame())).toContain("● Purpose")
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

test("a lone H1 wrapper is not repeated: Introduction shows only its own body", async () => {
  const text = "# Title\nintro\n## A\na\n## B\nb\n"
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ items: [mcpItem({ text })] })],
    width: 120,
    height: 40,
  })
  try {
    await gotoMcpItem(fixture)
    await expand(fixture)
    await fixture.waitForFrame((frame) => listPane(frame).includes("● A"))
    const frame = fixture.captureCharFrame()
    // The wrapper's title is not an extra row; its body is Introduction.
    expect(listPane(frame)).toContain("● Introduction")
    expect(listPane(frame)).not.toContain("Title")
    await moveTo(fixture, "Introduction")
    await fixture.waitForFrame((next) => inspector(next).includes("intro") && !inspector(next).includes("## A"))
    const selected = fixture.captureCharFrame()
    // Only the preamble, never the whole document its section range covers.
    expect(inspector(selected)).toContain("intro")
    expect(inspector(selected)).not.toContain("## A")
    expect(inspector(selected)).not.toContain("## B")
    // Presentation only: no editor for the wrapper's body; space toggles the
    // wrapper's own record, exactly as the old wrapper row did.
    expect(binds(fixture)).not.toContain("e")
    dispatch(fixture, "space")
    await fixture.waitForFrame((next) => next.includes('Disabled "Introduction"'))
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ item: "mcp:sample", section: "title", state: "off" })
  } finally {
    fixture.destroy()
  }
})

test("filtered hidden match can be selected and toggled", async () => {
  // The first match is the native `build` agent's row: Defaults "for every
  // agent" itself falls back to off (DESIGN §3.3), a native agent's row keeps
  // its native "on", so space turns it off.
  const snapshot = createSnapshot({
    agents: [projectAgent("build", "native")],
    items: [toolItem({ title: "zz-unique-tool", id: "tool:zz-unique", text: "zz-unique-body" })],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    await filter(fixture, "zz-unique")
    // The results walk to the revealed tool row by label; ctrl+space toggles
    // a result in place (space types into the filter).
    await moveToResult(fixture, "zz-unique-tool")
    await fixture.waitForFrame((frame) => frame.includes("zz-unique-body"))
    expect(binds(fixture)).toContain("ctrl+space")
    dispatch(fixture, "ctrl+space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "zz-unique-tool"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ item: "tool:zz-unique", state: "off" })
  } finally {
    fixture.destroy()
  }
})

// DESIGN §3.3: a user agent's shared rows fall back to off unless a preset
// sets them. Implementer stands for an agent created from the Native `build`
// preset, so its Code Mode row keeps its native "on".
function codemodeSnapshot(): Snapshot {
  return createSnapshot({
    agents: [projectAgent("Implementer")],
    links: [{ type: "link", level: "project", agent: "Implementer", preset: { kind: "agent", id: "build" }, updated: "2026-09-14T00:00:00.000Z" }],
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

test("Code Mode rows toggle and edit like any other tool", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [codemodeSnapshot()], width: 120, height: 40 })
  try {
    // Implementer › Tools › OpenCode › Code Mode › the item row, then its
    // auto-derived sections.
    await goto(fixture, "item:project:Implementer:tool:coder", "coder")
    expect(selectedRow(fixture.captureCharFrame())).not.toContain("unsupported")
    expect(selectedRow(fixture.captureCharFrame())).toContain("● coder")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("Tools › OpenCode › Code Mode › coder")
    expect(binds(fixture)).toContain("space")
    expect(binds(fixture)).toContain("p")
    expect(binds(fixture)).toContain("s")
    // Enter opens the editor for a live Code Mode row.
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(fixture.captureCharFrame()).toContain("ctrl+s save")
    dispatch(fixture, "escape")
    await fixture.waitForFrame((frame) => !frame.includes("ctrl+s save") && selectedRow(frame).includes("coder"))
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "coder"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ item: "tool:coder", state: "off" })
    await expand(fixture)
    // Several sections hang under the tool's Description group.
    await fixture.waitForFrame((frame) => listPane(frame).includes("Description"))
    await moveTo(fixture, "Description")
    await expand(fixture)
    // The inspector already shows "# Alpha" (every section combined), so
    // wait for the section row itself.
    await fixture.waitForFrame((frame) => listPane(frame).includes("● Alpha"))
    await moveTo(fixture, "Alpha")
    expect(selectedRow(fixture.captureCharFrame())).toContain("● Alpha")
    expect(binds(fixture)).toContain("space")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "Alpha"'))
    expect(fixture.fake.mutateInputs.length).toBe(2)
  } finally {
    fixture.destroy()
  }
})

test("p key writes a pin through the same status path as toggle", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [codemodeSnapshot()], width: 120, height: 40 })
  try {
    await goto(fixture, "item:project:Implementer:tool:coder", "coder")
    expect(binds(fixture)).toContain("p")
    expect(footer(fixture.captureCharFrame())).toContain("p pin")
    dispatch(fixture, "p")
    await fixture.waitForFrame((frame) => frame.includes('Pinned "coder"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ item: "tool:coder", pin: true })
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
    await goto(fixture, "item:project:Implementer:system:role", "Role/persona")
    // The whole-row lock is one inspector line, not a row badge.
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("always live (exclude sections instead)")))
    expect(binds(fixture)).not.toContain("space")
    expect(dispatch(fixture, "space")).toBe(false)
    expect(fixture.fake.mutateInputs.length).toBe(0)
    // Section toggles under the same role still apply: exclusions assemble.
    await expand(fixture)
    await fixture.waitForFrame((frame) => listPane(frame).includes("● Purpose"))
    await moveTo(fixture, "Purpose")
    expect(binds(fixture)).toContain("space")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "Purpose"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    // Whole base row: same refusal, on the Defaults Agents-catalogue Base
    // category.
    await reach(fixture, "item:defaults::base:gpt", "gpt.txt")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("always live (exclude sections instead)")))
    expect(binds(fixture)).not.toContain("space")
    expect(dispatch(fixture, "space")).toBe(false)
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const frame = fixture.captureCharFrame()
    expect(frame).not.toContain('Disabled "gpt.txt"')
  } finally {
    fixture.destroy()
  }
})

test("Models group is first and space activates the candidate", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "model:acme/nova-1",
        kind: "model" as const,
        group: "none" as const,
        title: "acme/nova-1",
        text: "acme/nova-1",
        enabled: true,
        fingerprint: "fp-nova-1",
        agents: ["Implementer"],
      },
      {
        id: "model:acme/nova-2",
        kind: "model" as const,
        group: "none" as const,
        title: "acme/nova-2",
        text: "acme/nova-2",
        enabled: true,
        fingerprint: "fp-nova-2",
        agents: ["Implementer"],
      },
    ],
    records: [
      {
        type: "model" as const,
        level: "project" as const,
        agent: "Implementer",
        providerID: "acme",
        modelID: "nova-1",
        active: true as const,
        updated: "2026-09-14T00:00:00.000Z",
      },
      {
        type: "model" as const,
        level: "project" as const,
        agent: "Implementer",
        providerID: "acme",
        modelID: "nova-2",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await goto(fixture, "agent:project:Implementer", "Implementer")
    // Models is the first category after the agent's own Settings: key 2.
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    expect(dispatch(fixture, "2")).toBe(true)
    await fixture.waitForFrame((frame) => breadcrumb(frame).includes("Implementer › Models"))
    await moveTo(fixture, "acme/nova-2")
    expect(binds(fixture)).toContain("space")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Activated "acme/nova-2"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const models = fixture.fake.mutateInputs[0].records.filter((record) => record.type === "model")
    expect(models.length).toBeGreaterThan(0)
  } finally {
    fixture.destroy()
  }
})

test("filter matching a Code Mode section reveals a live editable row", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [codemodeSnapshot()],
    width: 120,
    height: 40,
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    // Code Mode sections are live, so the filter reveals the section with its
    // ancestor chain as a selectable row that toggles in place.
    await filter(fixture, "Alpha")
    await fixture.waitForFrame((frame) => listPane(frame).includes("Alpha"))
    await moveToResult(fixture, "Alpha")
    expect(selectedRow(fixture.captureCharFrame())).toContain("● Alpha")
    expect(binds(fixture)).toContain("ctrl+space")
    dispatch(fixture, "ctrl+space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled "Alpha"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ item: "tool:coder", section: "alpha", state: "off" })
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
  // The native `build` agent owns the first coder row: Defaults "for every
  // agent" itself falls back to off (DESIGN §3.3), a native agent's row keeps
  // its native "on".
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "")],
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
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await filter(fixture, "coder")
    await fixture.waitForFrame((frame) => listPane(frame).includes("coder"))
    await moveToResult(fixture, "coder")
    const toolRow = selectedRow(fixture.captureCharFrame())
    expect(toolRow).toContain("coder")
    expect(toolRow).not.toContain("unsupported")
    expect(toolRow).toContain("● coder")
    // Go to the result: its keys are the list's.
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => !footer(frame).includes("esc clear filter") && selectedRow(frame).includes("coder"))
    const keys = binds(fixture)
    expect(keys).toContain("space")
    expect(keys).toContain("s")
    expect(keys).toContain("p")
    await fixture.waitForFrame((frame) => frame.includes("code mode tool"))
    expect(fixture.captureCharFrame()).not.toContain("unsupported")
    expect(inspector(fixture.captureCharFrame())).not.toContain(flat("always live"))
    await filter(fixture, "Custom.txt")
    await fixture.waitForFrame((frame) => listPane(frame).includes("Custom.txt"))
    await moveToResult(fixture, "Custom.txt")
    const baseRow = selectedRow(fixture.captureCharFrame())
    expect(baseRow).toContain("Custom.txt")
    expect(baseRow).toContain("inactive")
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => !footer(frame).includes("esc clear filter") && selectedRow(frame).includes("Custom.txt"))
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
    // The sidebar's Teams catalogue lists the crew container and its members.
    await goto(fixture, "team:project:crew", "crew")
    // The disabled row renders its glyph in the visible frame.
    expect(sidebarRow(fixture.captureCharFrame())).toContain("○ crew")
    expect(binds(fixture)).toContain("space")
    await expand(fixture)
    await fixture.waitForFrame((frame) => frame.includes("nested/beta"))
    expect(fixture.captureCharFrame()).toContain("alpha")
    // Space calls the real team.setEnabled with the inverted state.
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Enabled team "crew"'))
    expect(teamToggles).toEqual([{ level: "project", team: "crew", enabled: true }])
    // The toggle republishes: refresh pulls a fresh snapshot whose teams
    // entry reads enabled, and the rebuilt tree shows the new badge.
    await fixture.waitForFrame((frame) => sidebarRow(frame).includes("● crew"))
    expect(sidebarRow(fixture.captureCharFrame())).toContain("● crew")
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
    await fixture.waitForFrame((frame) => sidebarRow(frame).includes("○ crew"))
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
  const ctx = fullContext({ directory: project })
  // Empty built-in registry: this test pins the disk-only team universe, not
  // the shipped roster (covered by the dedicated well-formedness test).
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const teamCreates: { level: string; team: string; preset?: string }[] = []
  const wrappedTeamCreate = async (input: { level: "project" | "global"; team: string; preset?: string }) => {
    teamCreates.push({ ...input })
    return Effect.runPromise(handlers["team.create"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams ?? []).toEqual([])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["fresh"], selects: [""] },
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
    // The empty Teams catalogue is always present beside Agents: `a` on it
    // prompts for a name then a team preset, taking project scope from the cursor.
    await goto(fixture, "group:project:teams", "Teams")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamCreates.length === 1)
    const call = teamCreates[0]
    expect(teamCreates).toEqual([{ level: "project", team: "fresh" }])
    expect("preset" in call).toBe(false)
    expect(fixture.fake.dialogPrompts.map(([title]) => title)).toEqual(["Team name"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Team preset"])
    expect(fixture.captureCharFrame()).not.toContain("Team scope")
    // The create republishes: refresh pulls a fresh snapshot whose teams
    // entry reads disabled, and the rebuilt tree reveals and selects the new
    // off row.
    await until(fixture, () => (liveSnapshots[liveSnapshots.length - 1].teams ?? []).length === 1)
    expect(liveSnapshots[liveSnapshots.length - 1].teams).toEqual([
      { level: "project", team: "fresh", enabled: false, agents: [] },
    ])
    await until(fixture, (frame) => sidebarRow(frame).includes("○ fresh"))
    expect(sidebarRow(fixture.captureCharFrame())).toContain("○ fresh")
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
    // Reviewer › System › Role item (Implementer has its own Role row).
    await goto(fixture, "item:project:Reviewer:system:role", "Role/persona")
    await fixture.waitForFrame((frame) => frame.includes("reviewer-prompt"))
    expect(breadcrumb(fixture.captureCharFrame())).toContain("Reviewer › System")
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

test("a on a tool row offers Section or Permission rule and creates without scope prompts", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { selects: ["rule"], prompts: ["No force pushes", "git push --force *", "", "force pushes are not allowed here"] },
  })
  try {
    await goto(fixture, "item:project:Implementer:tool:shell", "shell")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.ruleAdds.length === 1)
    expect(fixture.fake.ruleAdds[0]).toMatchObject({
      level: "project",
      agent: "Implementer",
      tool: "shell",
      label: "No force pushes",
      message: "force pushes are not allowed here",
    })
    expect(fixture.fake.ruleAdds[0]?.patterns).toEqual(["git push --force *"])
    expect(fixture.fake.dialogPrompts.map((entry) => entry[0])).toContain("Message shown on refusal (optional)")
    expect(fixture.fake.dialogSelects.length).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("a on a generic row prompts for rule scope and creates a per-agent rule", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    dialogs: {
      selects: ["rule", "project"],
      prompts: ["shell", "No force pushes", "git push --force *", "", "", "my-agent"],
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await reachCategory(fixture, "group:defaults::tools", "Tools")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.ruleAdds.length === 1)
    expect(fixture.fake.ruleAdds[0]).toMatchObject({
      level: "project",
      agent: "my-agent",
      tool: "shell",
      label: "No force pushes",
    })
    expect(fixture.fake.ruleAdds[0]?.patterns).toEqual(["git push --force *"])
  } finally {
    fixture.destroy()
  }
})

test("perm rows list under the tool's Permissions and category, and enter opens the rule editor", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
    ],
  })
  const liveSnapshots: Snapshot[] = [snapshot]
  const ruleUpdates: { level: string; agent: string | null; tool: string; id: string; label: string; patterns: string[]; message?: string }[] = []
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["No force pushes", "git push --force *", "", "force pushes are not allowed here"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => liveSnapshots[liveSnapshots.length - 1],
        "rule.update": async (input: { level: "project" | "global" | "defaults"; agent: string | null; tool: string; id: string; label: string; patterns: string[]; keywords?: string[]; message?: string }) => {
          ruleUpdates.push({
            level: input.level,
            agent: input.agent,
            tool: input.tool,
            id: input.id,
            label: input.label,
            patterns: [...input.patterns],
            ...(input.message === undefined ? {} : { message: input.message }),
          })
          return { level: input.level, agent: input.agent, tool: input.tool, id: input.id, label: input.label }
        },
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await goto(fixture, "item:project:Implementer:tool:shell", "shell")
    // Rule rows are editable leaves under the tool's Permissions group and
    // their category; enter offers the rule editor.
    await reach(fixture, "item:project:Implementer:perm:shell:git-push", "Git push")
    expect(listPane(fixture.captureCharFrame())).toContain("Permissions")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("shell › Permissions › Commands › Git push")
    await fixture.waitForFrame((frame) => footer(frame).includes("enter edit rule"))
    expect(footer(fixture.captureCharFrame())).toContain("enter edit rule")
    expect(dispatch(fixture, "return")).toBe(true)
    await until(fixture, () => ruleUpdates.length === 1)
    expect(ruleUpdates[0]).toMatchObject({
      level: "project",
      agent: "Implementer",
      tool: "shell",
      id: "git-push",
      label: "No force pushes",
      message: "force pushes are not allowed here",
    })
    expect(ruleUpdates[0]?.patterns).toEqual(["git push --force *"])
  } finally {
    fixture.destroy()
  }
})

test("a on a Defaults Teams tool row creates the rule in the Teams catalogue", async () => {
  const snapshot = createSnapshot({
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { selects: ["rule"], prompts: ["No force pushes", "git push --force *", "", "force pushes are not allowed here"] },
  })
  try {
    // Defaults › Every member › Tools › OpenCode › shell.
    await goto(fixture, "item:defaults:/teams:tool:shell", "shell")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("Defaults › Teams › Tools")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.ruleAdds.length === 1)
    expect(fixture.fake.ruleAdds[0]).toMatchObject({
      level: "defaults",
      agent: null,
      catalogue: "teams",
      tool: "shell",
      label: "No force pushes",
      message: "force pushes are not allowed here",
    })
    // The shared Defaults row addressed the scope: the only select is the
    // Section/Permission-rule choice.
    expect(fixture.fake.dialogSelects.length).toBe(1)
    expect(fixture.fake.dialogPrompts.map((entry) => entry[0])).toEqual([
      "Rule label",
      "Rule patterns",
      "Rule keywords",
      "Message shown on refusal (optional)",
    ])
  } finally {
    fixture.destroy()
  }
})

test("enter on a Defaults Teams perm row sends the Teams catalogue with rule.update", async () => {
  const snapshot = createSnapshot({
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
    ],
  })
  const liveSnapshots: Snapshot[] = [snapshot]
  const ruleUpdates: {
    level: string
    agent: string | null
    catalogue?: string
    tool: string
    id: string
    label: string
    patterns: string[]
    message?: string
  }[] = []
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["No force pushes", "git push --force *", "", "force pushes are not allowed here"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => liveSnapshots[liveSnapshots.length - 1],
        "rule.update": async (input: { level: "project" | "global" | "defaults"; agent: string | null; catalogue?: "agents" | "teams"; tool: string; id: string; label: string; patterns: string[]; keywords?: string[]; message?: string }) => {
          ruleUpdates.push({
            level: input.level,
            agent: input.agent,
            ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }),
            tool: input.tool,
            id: input.id,
            label: input.label,
            patterns: [...input.patterns],
            ...(input.message === undefined ? {} : { message: input.message }),
          })
          return { level: input.level, agent: input.agent, tool: input.tool, id: input.id, label: input.label }
        },
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await goto(fixture, "item:defaults:/teams:tool:shell", "shell")
    await reach(fixture, "item:defaults:/teams:perm:shell:git-push", "Git push")
    expect(dispatch(fixture, "return")).toBe(true)
    await until(fixture, () => ruleUpdates.length === 1)
    expect(ruleUpdates[0]).toMatchObject({
      level: "defaults",
      agent: null,
      catalogue: "teams",
      tool: "shell",
      id: "git-push",
      label: "No force pushes",
      message: "force pushes are not allowed here",
    })
    expect(ruleUpdates[0]?.patterns).toEqual(["git push --force *"])
  } finally {
    fixture.destroy()
  }
})

test("e starts text editing on a tool row but not on a permission rule", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
  })
  try {
    await goto(fixture, "item:project:Implementer:tool:shell", "shell")
    // Tool row: 'e' is bound and starts text editing.
    expect(binds(fixture)).toContain("e")
    expect(dispatch(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(fixture.captureCharFrame()).toContain("ctrl+s save")
    // Cancel editing to return to navigation.
    expect(dispatch(fixture, "escape")).toBe(true)
    await fixture.waitForFrame((frame) => !frame.includes("ctrl+s save"))

    // Navigate to the permission rule under Permissions → Commands.
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("shell"))
    await reach(fixture, "item:project:Implementer:perm:shell:git-push", "Git push")
    // Permission row: 'e' is unavailable and does not start text editing.
    expect(binds(fixture)).not.toContain("e")
    expect(dispatch(fixture, "e")).toBe(false)
    expect(fixture.captureCharFrame()).not.toContain("ctrl+s save")
  } finally {
    fixture.destroy()
  }
})

test("inspector shows a rule's refusal message, curated or user-set", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
      {
        id: "perm:shell:my-rule",
        kind: "perm" as const,
        group: "none" as const,
        title: "My rule",
        text: "My rule\nmine *",
        enabled: true,
        fingerprint: "fp-mine",
        permTool: "shell",
        ruleId: "my-rule",
        patterns: ["mine *"],
        keywords: ["mine"],
        provenance: [],
        custom: true,
      },
    ],
    records: [
      {
        type: "rule" as const,
        level: "project" as const,
        agent: "Implementer",
        tool: "shell",
        id: "my-rule",
        label: "My rule",
        patterns: ["mine *"],
        keywords: ["mine"],
        message: "mine is not allowed here",
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
  })
  try {
    await goto(fixture, "item:project:Implementer:tool:shell", "shell")
    await reach(fixture, "item:project:Implementer:perm:shell:git-push", "Git push")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("message pushing is not allowed here")))
    expect(inspector(fixture.captureCharFrame())).toContain(flat("message pushing is not allowed here"))
    await moveTo(fixture, "My rule")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("message mine is not allowed here")))
    expect(inspector(fixture.captureCharFrame())).toContain(flat("message mine is not allowed here"))
  } finally {
    fixture.destroy()
  }
})

// DESIGN §3.3: a user agent's shared rows fall back to off unless a preset
// sets them. alpha (no agent file, so addressed at Defaults) stands for an
// agent created from the Native `build` preset, so publishing installs nothing
// for rows the test does not touch.
async function linkAlphaToBuild(project: string): Promise<void> {
  const loaded = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: [
      ...loaded.records,
      { type: "link", level: "defaults", agent: "alpha", preset: { kind: "agent", id: "build" }, updated: "2026-01-01T00:00:00.000Z" },
    ],
  })
  if (!saved.ok) throw new Error("link save was stale")
}

test("addRule cancelling any prompt writes nothing, blank keywords saves with defaults", async () => {
  async function runAdd(prompts: readonly (string | undefined)[]) {
    const parent = process.env.TMPDIR ?? os.tmpdir()
    const root = await fs.mkdtemp(path.join(parent, "plus-add-cancel-"))
    e2eRoots.push(root)
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await linkAlphaToBuild(project)
    const realCtx = fullContext({
      directory: project,
      agents: [agentInfo("alpha", "upstream role")],
      tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    })
    const state = createState()
    const handlers = createHandlers(realCtx, state)
    const throwing = { error: (type: string, message: string, data?: unknown): never => { throw { type, message, data } } }
    const promptQueue = [...prompts]
    let addCalls = 0
    let refreshCalls = 0
    const fakeContext = {
      location: realCtx.location,
      client: {
        rpc: () => ({
          "rule.add": async (input: never) => {
            addCalls++
            return Effect.runPromise(handlers["rule.add"](input, throwing))
          },
        }),
      },
      ui: {
        dialog: {
          prompt: async () => promptQueue.shift(),
          select: async () => undefined,
          clear: () => {},
        },
        toast: { show: () => {} },
        router: { navigate: () => {} },
      },
    } as unknown as import("@opencode/plugin/tui").Plugin.Context
    const fakeState = {
      snapshot: () => undefined,
      refresh: async () => {
        refreshCalls++
      },
    } as unknown as import("../src/tui/instructions/state.js").InstructionsState
    const dialogs = createInstructionsDialogs(fakeContext, fakeState)
    const toolNode = {
      id: "tool-node",
      kind: "item",
      label: "shell",
      depth: 0,
      address: { level: "project", agent: "my-agent", item: "tool:shell", section: null },
      badges: {},
    } as unknown as import("../src/instructions/tree.js").TreeNode
    await dialogs.addRule(toolNode)
    const api = createPlusApi(realCtx, state)
    const snap = await api.snapshot()
    if (!snap.ok) throw new Error("snapshot failed")
    const logged = await api.log({})
    if (!logged.ok) throw new Error("log failed")
    return { addCalls, refreshCalls, records: snap.value.records, logTotal: logged.value.total }
  }
  for (const prompts of [[undefined], ["My Rule", undefined], ["My Rule", "git push *", undefined], ["My Rule", "git push *", "", undefined]] as const) {
    const result = await runAdd(prompts)
    expect(result.addCalls).toBe(0)
    expect(result.records).toEqual([])
    expect(result.logTotal).toBe(0)
    expect(result.refreshCalls).toBe(0)
  }
  const saved = await runAdd(["My Rule", "git push --force *", "", ""])
  expect(saved.addCalls).toBe(1)
  expect(saved.records).toHaveLength(1)
  const rule = saved.records.find((record) => record.type === "rule")
  if (rule === undefined || rule.type !== "rule") throw new Error("expected rule")
  expect(rule.keywords.length).toBeGreaterThan(0)
  expect(saved.logTotal).toBe(1)
  expect(saved.refreshCalls).toBe(1)
})

test("editRule cancelling any prompt writes nothing, blank keywords saves with defaults", async () => {
  async function runEdit(prompts: readonly (string | undefined)[]) {
    const parent = process.env.TMPDIR ?? os.tmpdir()
    const root = await fs.mkdtemp(path.join(parent, "plus-edit-cancel-"))
    e2eRoots.push(root)
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await linkAlphaToBuild(project)
    const realCtx = fullContext({
      directory: project,
      agents: [agentInfo("alpha", "upstream role")],
      tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    })
    const state = createState()
    const handlers = createHandlers(realCtx, state)
    const throwing = { error: (type: string, message: string, data?: unknown): never => { throw { type, message, data } } }
    await Effect.runPromise(
      handlers["rule.add"](
        { level: "project", agent: "alpha", tool: "shell", id: "my-rule", label: "Original", patterns: ["orig *"], keywords: ["old-key"] },
        throwing,
      ),
    )
    const fresh = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
    const promptQueue = [...prompts]
    let updateCalls = 0
    let refreshCalls = 0
    const fakeContext = {
      location: realCtx.location,
      client: {
        rpc: () => ({
          "rule.update": async (input: never) => {
            updateCalls++
            return Effect.runPromise(handlers["rule.update"](input, throwing))
          },
        }),
      },
      ui: {
        dialog: {
          prompt: async () => promptQueue.shift(),
          select: async () => undefined,
          clear: () => {},
        },
        toast: { show: () => {} },
        router: { navigate: () => {} },
      },
    } as unknown as import("@opencode/plugin/tui").Plugin.Context
    const fakeState = {
      snapshot: () => fresh,
      refresh: async () => {
        refreshCalls++
      },
    } as unknown as import("../src/tui/instructions/state.js").InstructionsState
    const dialogs = createInstructionsDialogs(fakeContext, fakeState)
    const permNode = {
      id: "perm-node",
      kind: "item",
      label: "My rule",
      depth: 0,
      address: { level: "project", agent: "alpha", item: "perm:shell:my-rule", section: null },
      badges: {},
    } as unknown as import("../src/instructions/tree.js").TreeNode
    await dialogs.editRule(permNode)
    const api = createPlusApi(realCtx, state)
    const snap = await api.snapshot()
    if (!snap.ok) throw new Error("snapshot failed")
    const persisted = snap.value.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "my-rule")
    if (persisted === undefined || persisted.type !== "rule") throw new Error("expected rule to persist")
    const logged = await api.log({ where: "op:rule.update" })
    if (!logged.ok) throw new Error("log failed")
    return { updateCalls, refreshCalls, persisted, logTotal: logged.value.total }
  }
  for (const prompts of [[undefined], ["New label", undefined], ["New label", "new *", undefined], ["New label", "new *", "", undefined]] as const) {
    const result = await runEdit(prompts)
    expect(result.updateCalls).toBe(0)
    expect(result.persisted.label).toBe("Original")
    expect(result.persisted.patterns).toEqual(["orig *"])
    expect(result.persisted.keywords).toEqual(["old-key"])
    expect(result.logTotal).toBe(0)
    expect(result.refreshCalls).toBe(0)
  }
  const saved = await runEdit(["New label", "new pattern *", "", ""])
  expect(saved.updateCalls).toBe(1)
  expect(saved.persisted.label).toBe("New label")
  expect(saved.persisted.patterns).toEqual(["new pattern *"])
  expect(saved.persisted.keywords).not.toEqual(["old-key"])
  expect(saved.persisted.keywords.length).toBeGreaterThan(0)
  expect(saved.logTotal).toBe(1)
  expect(saved.refreshCalls).toBe(1)
})

test("retries agent selection when the agent arrives in a later snapshot", async () => {
  const without = createSnapshot({ agents: [] })
  const withAgent = createSnapshot({ agents: [projectAgent("LateAgent")] })
  const toasts: { variant?: string; message: string }[] = []
  const fixture = await renderPlusFixture({
    snapshots: [without, withAgent],
    width: 120,
    height: 40,
    render: (context) => {
      const original = context.ui.toast.show
      context.ui.toast.show = ((toast: { variant?: string; message: string }) => {
        toasts.push(toast)
        return (original as (toast: unknown) => unknown)(toast)
      }) as typeof original
      return createComponent(InstructionsRoute, { context, onClose: () => {}, data: { agent: "LateAgent" } })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    expect(fixture.captureCharFrame()).not.toContain("LateAgent")
    await fixture.emitChanged()
    await fixture.waitForFrame((frame) => frame.includes("LateAgent") && selectedRow(frame).includes("LateAgent"))
    expect(selectedRow(fixture.captureCharFrame())).toContain("LateAgent")
    expect(toasts.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("gives up waiting for a missing agent and toasts once", async () => {
  const toasts: { variant?: string; message: string }[] = []
  const fixture = await renderPlusFixture({
    snapshots: [createSnapshot({ agents: [] })],
    width: 120,
    height: 40,
    render: (context) => {
      const original = context.ui.toast.show
      context.ui.toast.show = ((toast: { variant?: string; message: string }) => {
        toasts.push(toast)
        return (original as (toast: unknown) => unknown)(toast)
      }) as typeof original
      return createComponent(InstructionsRoute, {
        context,
        onClose: () => {},
        data: { agent: "Missing" },
        initialAgentTimeoutMs: 50,
      })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    for (let i = 0; i < 20 && toasts.length === 0; i++) await sleep(20)
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toMatchObject({ variant: "warning", message: "Agent Missing not visible yet" })
    await sleep(100)
    expect(toasts.length).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("a on a team row adds through the real team.addAgent without the generic picker", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-add-agent-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: [] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["newbie"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew", "crew")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "crew", id: "newbie" })
    expect("preset" in (teamAdds[0] as Record<string, unknown>)).toBe(false)
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")?.agents ?? []).includes("newbie"),
    )
    expect(liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")).toEqual({
      level: "project",
      team: "crew",
      enabled: false,
      agents: ["newbie"],
    })
    // The member row appears in the sidebar under its team.
    await until(fixture, (frame) => frame.includes("newbie"))
    await navTo(fixture, "newbie")
    expect(selectedRow(fixture.captureCharFrame())).toContain("newbie")
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("a on a colon team row calls team.addAgent with the full name", async () => {
  // Team names allow colons; the old `[^:]+` dispatch fell through to the
  // ordinary agent flow. The row identity (kind team + add:agent) must route
  // to team.addAgent with the entire remainder as the team name.
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-colon-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "release:review" }, throwing))
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "release:review", enabled: false, agents: [] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["newbie"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:release:review", "release:review")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "release:review", id: "newbie" })
    // Never opened the ordinary agent-creation flow.
    expect(fixture.fake.agentCreates.length).toBe(0)
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("a on a team row with an internal newline calls team.addAgent with the multiline name", async () => {
  // Team names allow internal newlines; validateTeamName accepts them as valid
  // single path segments. The row identity (kind team + add:agent) must route
  // to team.addAgent with the entire multiline name, not ordinary agent creation.
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-newline-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "release\nreview" }, throwing))
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "release\nreview", enabled: false, agents: [] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["newbie"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // The id holds a newline the filter input cannot take: walk the sidebar.
    await goto(fixture, "group:project:teams", "Teams")
    await navTo(fixture, "release")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "release\nreview", id: "newbie" })
    // Never opened the ordinary agent-creation flow.
    expect(fixture.fake.agentCreates.length).toBe(0)
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

// DESIGN §5: a on a Teams group → team name → team preset → done; the
// cursor's root decides the level, so no scope question.
test("team create on group:project:teams asks the name, then a grouped team preset, at the cursor level", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-template-project-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const teamCreates: { level: string; team: string; preset?: string }[] = []
  const wrappedTeamCreate = async (input: { level: "project" | "global"; team: string; preset?: string }) => {
    teamCreates.push({ ...input })
    return Effect.runPromise(handlers["team.create"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["crew"], selects: ["basic"] },
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
    await goto(fixture, "group:project:teams", "Teams")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamCreates.length === 1)
    expect(teamCreates).toEqual([{ level: "project", team: "crew", preset: "basic" }])
    expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Team name"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Team preset"])
    // Grouped by origin, Plus team presets first here (OpenCode ships none);
    // the empty team is the last option, without a group.
    const picker = fixture.fake.selectInputs[0]
    expect(picker.options.filter((option) => option.category === "Plus").map((option) => option.value)).toContain("basic")
    expect(picker.options.some((option) => option.category === "OpenCode" || option.category === "Native")).toBe(false)
    expect(picker.options.at(-1)).toEqual({ title: "Empty team", value: "" })
    expect(fixture.captureCharFrame()).not.toContain("Team scope")
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams ?? []).some((t) => t.level === "project" && t.team === "crew" && !t.enabled),
    )
    // The new team row is revealed and selected.
    await until(fixture, (frame) => sidebarRow(frame).includes("○ crew"))
  } finally {
    fixture.destroy()
  }
})

// DESIGN §4/§5: Defaults → Teams takes team entries. A team pattern is a row
// only while it has a member entry, so the flow asks both patterns, then the
// preset; `a` on the entry rows then adds member entries to that PATTERN.
test("a on Defaults Teams asks team pattern, member pattern, preset; a on its entry rows adds to the pattern", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-entry-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "defaults"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["*review*", "*orchestrator*", "*reviewer*", "*editor*"], selects: ["member:basic/orchestrator", "__none__", "member:basic/reviewer"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "group:defaults:teams", "Teams")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toEqual({ level: "defaults", team: "*review*", id: "*orchestrator*", preset: { kind: "member", team: "basic", id: "orchestrator" } })
    expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Team name or pattern", "Member name or pattern"])
    expect(fixture.fake.promptInputs[0]?.description).toContain("* and % match any text, case-insensitive")
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Preset"])
    // The member entry row is revealed and selected under its team pattern.
    await until(fixture, (frame) => sidebarRow(frame).includes("*orchestrator*"))
    // a on the member entry row: the team is the PATTERN, never "<pattern>:<member>".
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 2)
    expect(teamAdds[1]).toEqual({ level: "defaults", team: "*review*", id: "*reviewer*" })
    await until(fixture, (frame) => sidebarRow(frame).includes("*reviewer*"))
    // a on the team pattern row itself adds to the same pattern.
    dispatch(fixture, "up")
    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => sidebarRow(frame).includes("*review*") && !sidebarRow(frame).includes("*reviewer*") && !sidebarRow(frame).includes("*orch"))
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 3)
    expect(teamAdds[2]).toEqual({ level: "defaults", team: "*review*", id: "*editor*", preset: { kind: "member", team: "basic", id: "reviewer" } })
    expect(fixture.fake.promptInputs.slice(2).map((input) => input.title)).toEqual(["Member name or pattern", "Member name or pattern"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).not.toContain("Team scope")
    await until(fixture, () => (liveSnapshots.at(-1)?.entries ?? []).length === 3)
    expect((liveSnapshots.at(-1)?.entries ?? []).map((entry) => `${entry.team} ${entry.name}`).toSorted()).toEqual([
      "*review* *editor*",
      "*review* *orchestrator*",
      "*review* *reviewer*",
    ])
  } finally {
    fixture.destroy()
  }
})

test("a on a team member row adds through the real team.addAgent without the generic picker", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-member-add-agent-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwing),
  )
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha"] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["bravo"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew:alpha", "alpha")
    expect(selectedRow(fixture.captureCharFrame())).toContain("alpha")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "crew", id: "bravo" })
    expect("preset" in (teamAdds[0] as Record<string, unknown>)).toBe(false)
    expect(fixture.fake.agentCreates.length).toBe(0)
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
    expect(fixture.captureCharFrame()).not.toContain("Select what to add")
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")?.agents ?? []).includes("bravo"),
    )
    expect(liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")).toEqual({
      level: "project",
      team: "crew",
      enabled: false,
      agents: ["alpha", "bravo"],
    })
  } finally {
    fixture.destroy()
  }
})

test("a on a colon team member row calls team.addAgent with the full team name", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-colon-member-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew:alpha" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew:alpha", id: "firstmate" }, throwing),
  )
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["secondmate"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew:alpha:firstmate", "firstmate")
    expect(selectedRow(fixture.captureCharFrame())).toContain("firstmate")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "crew:alpha", id: "secondmate" })
    expect(fixture.fake.agentCreates.length).toBe(0)
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("a on ambiguous team member row surfaces error toast and calls no team.addAgent", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-ambiguous-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew:alpha" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwing),
  )
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const toasts: { variant?: string; message: string }[] = []
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["secondmate"] },
    render: (context) => {
      const originalToastShow = context.ui.toast.show
      context.ui.toast.show = ((toast: { variant?: string; message: string }) => {
        toasts.push(toast)
        return (originalToastShow as (t: unknown) => unknown)(toast)
      }) as unknown as typeof context.ui.toast.show
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // team:project:crew:alpha names both the team crew:alpha and crew's
    // member alpha: walk the sidebar to the member row under crew.
    await goto(fixture, "team:project:crew", "crew")
    await navTo(fixture, "alpha")
    expect(sidebarRow(fixture.captureCharFrame())).toMatch(/^\s+● alpha/)
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => toasts.length >= 1)
    expect(toasts).toContainEqual({
      variant: "error",
      message: '"crew:alpha" is ambiguous: it matches both a team and a member of team "crew". Rename one to continue.',
    })
    expect(teamAdds.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("d on a member row with the real handler wired removes the row", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-member-remove-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwing),
  )
  const teamRemoves: { level: string; team: string; id: string }[] = []
  const wrappedTeamRemoveAgent = async (input: { level: "project" | "global" | "defaults"; team: string; id: string }) => {
    teamRemoves.push({ ...input })
    return Effect.runPromise(handlers["team.removeAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha"] }])
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
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.removeAgent": wrappedTeamRemoveAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew:alpha", "alpha")
    expect(selectedRow(fixture.captureCharFrame())).toContain("alpha")
    expect(binds(fixture)).toContain("d")
    expect(dispatch(fixture, "d")).toBe(true)
    await until(fixture, () => teamRemoves.length === 1)
    expect(teamRemoves[0]).toEqual({ level: "project", team: "crew", id: "alpha" })
    await fixture.waitForFrame((frame) => frame.includes("Deleted team member alpha"))
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")?.agents ?? []).length === 0,
    )
    expect(liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")?.agents).toEqual([])
    expect(selectedRow(fixture.captureCharFrame())).not.toContain("alpha")
  } finally {
    fixture.destroy()
  }
})

test("d on a team row with the real handler wired removes the row and wires team.delete", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-remove-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwing),
  )
  const teamDeletes: { level: "project" | "global"; team: string }[] = []
  const wrappedTeamDelete = async (input: { level: "project" | "global"; team: string }) => {
    teamDeletes.push({ ...input })
    return Effect.runPromise(handlers["team.delete"](input, throwing))
  }
  let confirmOptions: unknown = undefined
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha"] }])
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
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.delete": wrappedTeamDelete,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      const baseConfirm = context.ui.dialog.confirm
      context.ui.dialog.confirm = async (input) => {
        confirmOptions = input
        return baseConfirm(input)
      }
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew", "crew")
    expect(selectedRow(fixture.captureCharFrame())).toContain("crew")
    expect(binds(fixture)).toContain("d")
    expect(dispatch(fixture, "d")).toBe(true)
    await until(fixture, () => teamDeletes.length === 1)
    expect(teamDeletes[0]).toEqual({ level: "project", team: "crew" })
    expect(confirmOptions).toMatchObject({
      title: "Delete team crew?",
      message: 'Delete project team "crew" and its 1 member file(s)? It is currently disabled. This cannot be undone.',
    })
    await fixture.waitForFrame((frame) => frame.includes("Deleted team crew"))
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")) === undefined,
    )
    expect(liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")).toBeUndefined()
    expect(selectedRow(fixture.captureCharFrame())).not.toContain("crew")
  } finally {
    fixture.destroy()
  }
})

test("defaults team row offers no d delete", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-defaults-team-refusal-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const registry = [{ name: "starter", members: [{ id: "planner", body: "planner body" }] }]
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: registry })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
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
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:defaults:starter", "starter")
    expect(selectedRow(fixture.captureCharFrame())).toContain("starter")
    // `d` is bound on every row so undeletable rows answer with the honest
    // refusal instead of swallowing the key; the hint line still offers
    // `d delete` only where the row can actually be deleted.
    expect(binds(fixture)).toContain("d")
    expect(footer(fixture.captureCharFrame())).not.toContain("d delete")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes('"starter" cannot be deleted: team "starter" is built in'))
  } finally {
    fixture.destroy()
  }
})

test("a on a Special row or special-agent row under a team shows status refusal", async () => {
  const snapshot: Snapshot = {
    ...createSnapshot({
      agents: [
        { id: "alpha", scope: "project" as const, fileBacked: true },
        { id: "title", scope: "defaults" as const, origin: "special" as const, fileBacked: false },
      ],
    }),
    teams: [{ level: "project" as const, team: "crew", enabled: true, agents: ["alpha"] }],
  }
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew:special", "Special")
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Special agents are built in; add is not available here"))
    expect(fixture.fake.dialogSelects.length).toBe(0)

    await expand(fixture)
    await navTo(fixture, "title")
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Special agents are built in; add is not available here"))
    expect(fixture.fake.dialogSelects.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("space on a Models row under a team special persists the team-scoped record", async () => {
  const snapshot: Snapshot = {
    ...createSnapshot({
      agents: [
        { id: "alpha", scope: "project" as const, fileBacked: true },
        { id: "title", scope: "defaults" as const, origin: "special" as const, fileBacked: false },
      ],
      items: [
        {
          id: "model:acme/nova-2",
          kind: "model" as const,
          group: "none" as const,
          title: "acme/nova-2",
          text: "acme/nova-2",
          enabled: true,
          fingerprint: "fp-nova-2",
          agents: ["title"],
        },
      ],
      records: [
        {
          type: "model" as const,
          level: "defaults" as const,
          agent: null,
          providerID: "acme",
          modelID: "nova-2",
          updated: "2026-09-14T00:00:00.000Z",
        },
        // A team special agent resolves through the Teams catalogue, which is
        // where the store migration puts the second copy of every shared row.
        {
          type: "model" as const,
          level: "defaults" as const,
          agent: null,
          catalogue: "teams" as const,
          providerID: "acme",
          modelID: "nova-2",
          updated: "2026-09-14T00:00:00.000Z",
        },
      ],
    }),
    teams: [{ level: "project" as const, team: "crew", enabled: true, agents: ["alpha"] }],
  }
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Teams › crew › Special › title (sidebar) › Models › the candidate.
    await goto(fixture, "item:project:crew/:special:title:model:acme/nova-2", "acme/nova-2")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("crew › Special › title › Models")
    expect(binds(fixture)).toContain("space")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Activated "acme/nova-2"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const models = fixture.fake.mutateInputs[0].records.filter((record) => record.type === "model")
    expect(models.length).toBeGreaterThan(0)
    const teamModel = models.find((m) => m.type === "model" && m.agent === "title" && m.team?.team === "crew")
    expect(teamModel).toBeDefined()
    expect(teamModel?.team).toEqual({ level: "project", team: "crew" })
    expect(teamModel?.active).toBe(true)
  } finally {
    fixture.destroy()
  }
})

test("ctrl+space selects an Agents-group agent through the core picker, never special or team member rows", async () => {
  const snapshot: Snapshot = {
    ...createSnapshot({
      agents: [
        { id: "alpha", scope: "project" as const, origin: "user" as const, fileBacked: true },
        { id: "title", scope: "defaults" as const, origin: "special" as const, fileBacked: false },
      ],
    }),
    teams: [{ level: "project" as const, team: "crew", enabled: true, agents: ["mate"] }],
  }
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], agents: [agentInfo("alpha")], width: 120, height: 40 })
  try {
    await goto(fixture, "agent:project:alpha", "alpha")
    expect(binds(fixture)).toContain("ctrl+space")
    expect(footer(fixture.captureCharFrame())).toContain("ctrl+space select")
    expect(dispatch(fixture, "ctrl+space")).toBe(true)
    expect(fixture.fake.agentSelects).toEqual(["alpha"])
    expect(fixture.fake.mutateInputs.length).toBe(0)

    // Team member rows keep their own (non-select) behaviour.
    await goto(fixture, "team:project:crew:mate", "mate")
    expect(binds(fixture)).toContain("space")
    expect(binds(fixture)).not.toContain("ctrl+space")
    expect(fixture.fake.agentSelects).toEqual(["alpha"])

    // Special agents are not offered by the picker: no select bind. They sit
    // under Defaults → Agents → OpenCode → Special.
    await goto(fixture, "agent:defaults:title", "title")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("Defaults › Agents › OpenCode › Special › title")
    expect(binds(fixture)).toContain("space")
    expect(binds(fixture)).not.toContain("ctrl+space")
    expect(fixture.fake.agentSelects).toEqual(["alpha"])
  } finally {
    fixture.destroy()
  }
})

// ---------------------------------------------------------------------------
// Phase 4: create flows (a → name → preset → done), relink (l), delete of
// presets and entries, from-labels, and state/pin/model review choices.

const PRESET_UPDATED = "2026-09-25T00:00:00.000Z"

function linkTo(agent: string, preset: PresetRef, level: "project" | "global" = "project") {
  return { type: "link" as const, level, agent, preset, updated: PRESET_UPDATED }
}

const basicOrchestrator: PresetRef = { kind: "member", team: "basic", id: "orchestrator" }
const basicPlanner: PresetRef = { kind: "member", team: "basic", id: "planner" }

function bashItem() {
  return toolItem({ id: "tool:bash", title: "bash" })
}

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
    dialogs: { selects: ["acme", "nova"] },
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
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Model provider", "Model"])
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
    expect(binds(fixture)).toContain("l")
    expect(footer(fixture.captureCharFrame())).toContain("l link")
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

function reviewedBash(overrides?: Record<string, unknown>) {
  return {
    type: "customization" as const,
    level: "project" as const,
    agent: "alice",
    item: "tool:bash",
    section: null,
    state: "off" as const,
    basedOnState: "off" as const,
    basedOn: "",
    updated: PRESET_UPDATED,
    ...overrides,
  }
}

async function gotoBash(fixture: TestFixture): Promise<void> {
  await goto(fixture, "item:project:alice:tool:bash", "bash")
}

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
    await until(second, (frame) => frame.split("\n").some((line) => line.includes("k keep mine") && line.includes("t take merged")))
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

// D: enter on a model row opens the edit dialog (model, variant, warming).
// Inherited rows are listed, so editing one plants a local record; the
// dialog validates the model against the host catalog and shows the
// inherited warming.
test("enter on a model row edits model, variant and warming; w is no longer bound", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("alice")],
    records: [
      { type: "model" as const, level: "project" as const, agent: "alice", providerID: "acme", modelID: "nova-1", updated: PRESET_UPDATED },
    ],
  })
  const models = [
    { providerID: "acme", modelID: "nova-1", name: "Nova 1" },
    { providerID: "acme", modelID: "nova-2", name: "Nova 2" },
  ]
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 160,
    models,
    dialogs: { prompts: ["acme/nova-2", "high", "45m"] },
  })
  try {
    await goto(fixture, "item:project:alice:model:acme/nova-1", "acme/nova-1")
    // The model-row warming key is gone; enter is the editor.
    expect(fixture.commands().some((command) => command.bind === "w")).toBe(false)
    expect(footer(fixture.captureCharFrame())).toContain("enter edit model")
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.mutateInputs.length === 1)
    // The prompts prefill the current model and variant; warming starts empty
    // (the dialogs fixture answers each in order).
    expect(fixture.fake.promptInputs.map((input) => [input.title, input.value ?? ""])).toEqual([
      ["Model", "acme/nova-1"],
      ["Variant", ""],
      ["Cache warming · acme/nova-1", ""],
    ])
    const own = fixture.fake.mutateInputs[0].records.filter((entry) => entry.type === "model" && entry.agent === "alice")
    expect(own).toEqual([
      expect.objectContaining({ providerID: "acme", modelID: "nova-2", variant: "high", warming: "45m" }),
    ])
  } finally {
    fixture.destroy()
  }
})

test("enter on a model row refuses a model outside the host catalog", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("alice")],
    records: [
      { type: "model" as const, level: "project" as const, agent: "alice", providerID: "acme", modelID: "nova-1", updated: PRESET_UPDATED },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 160,
    models: [{ providerID: "acme", modelID: "nova-1", name: "Nova 1" }],
    dialogs: { prompts: ["acme/ghost", "", ""] },
  })
  try {
    await goto(fixture, "item:project:alice:model:acme/nova-1", "acme/nova-1")
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.toasts.some((toast) => toast.message.includes("is not a model in the host catalog")))
    expect(fixture.fake.mutateInputs).toEqual([])
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
