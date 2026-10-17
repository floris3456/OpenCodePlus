// The Instructions route: rendering, filter, help, add and delete, reset and toggle.
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createComponent } from "solid-js"
import { createHandlers, createState } from "../src/index.js"
import { fingerprint, resolve, scopesOf } from "../src/instructions/model.js"
import type { Snapshot } from "../src/rpc.js"
import { Definition } from "../src/rpc.js"
import { HELP, HelpDialog } from "../src/tui/instructions/help.js"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import { createSnapshot, renderInstructionsRoute, renderPlusFixture } from "./tui.js"
import { agentInfo, fullContext } from "./harness.js"
import { binds, breadcrumb, category, dispatch, expand, footer, moveTo, reach, reachCategory, selectedRow, sleep } from "./instructions-nav.js"
import { goto, showSection, filter, until, listPane, inspector, flat, mcpItem, toolItem, projectAgent, gotoMcpItem, PRESET_UPDATED } from "./route-helpers.js"

const e2eRoots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(e2eRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

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
    expect(expanded).toContain("System")
    // Skills have their own tab, between Tools and System.
    expect(expanded.split("\n").find((line) => line.includes("Settings") && line.includes("System"))).toMatch(/Tools.*Skills.*System/)
    dispatch(fixture, "right")
    await category(fixture, "System")
    expect(fixture.captureCharFrame()).toContain("Base")
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
    height: 90,
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
  const body = "guide body text\n"
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

test("a on a section row opens the add-section dialog directly without category fallback", async () => {
  const headingText = "## Main\nMain content.\n"
  const before = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "system:guide",
        kind: "system",
        group: "project",
        title: "Guide",
        text: headingText,
        enabled: true,
        fingerprint: "fp-guide",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [before],
    width: 120,
    height: 40,
    dialogs: { prompts: ["SubSection", "sub content"] },
  })
  try {
    await goto(fixture, "item:project:Implementer:system:guide", "Guide")
    await showSection(fixture, "Main")
    await goto(fixture, "section:project:Implementer:system:guide:main", "Main")
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes('Added "SubSection"'))
    expect(fixture.fake.dialogSelects.length).toBe(0)
    expect(fixture.fake.dialogPrompts.map((entry) => entry[0])).toEqual(["Section name", "Section text"])
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
      // Core always registers the skill tool beside the skills.
      { id: "tool:skill", kind: "tool" as const, group: "native" as const, title: "skill", text: "Load a skill", enabled: true, fingerprint: "fp-skill" },
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
  const after = createSnapshot({
    items: [{ id: "tool:skill", kind: "tool" as const, group: "native" as const, title: "skill", text: "Load a skill", enabled: true, fingerprint: "fp-skill" }],
  })
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
      // Core always registers the skill tool beside the skills.
      { id: "tool:skill", kind: "tool" as const, group: "native" as const, title: "skill", text: "Load a skill", enabled: true, fingerprint: "fp-skill" },
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

// T7: `r` resets a model field. A previous `shift+r,R` rename binding
// registered a bare lowercase `r` (the keymap lowercases every binding token),
// so it shadowed the reset command on every row. The rename key must not
// normalize onto `r`.
test("no model field command binding normalizes onto the reset key r", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("alice")],
    records: [
      { type: "model" as const, level: "project" as const, agent: "alice", providerID: "acme", modelID: "nova-1", warming: "45m", updated: PRESET_UPDATED },
    ],
    hostModels: [{ providerID: "acme", modelID: "nova-1", variants: ["low", "high"] }],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 160 })
  try {
    await goto(fixture, "item:project:alice:model:acme/nova-1", "acme/nova-1")
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => listPane(frame).includes("Effort"))
    // The Warming group row, then its Warming field row inside it.
    await moveTo(fixture, "Warming")
    await expand(fixture)
    dispatch(fixture, "down")
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("Warming"))
    // The keymap lowercases each comma-separated token: a bind of "R" is a
    // second `r` and would win over the reset command.
    const tokens = binds(fixture).flatMap((bind) => bind.split(",")).map((token) => token.trim().toLowerCase())
    expect(tokens.filter((token) => token === "r")).toHaveLength(1)
    expect(binds(fixture).some((bind) => bind.split(",").some((token) => token.trim() === "R"))).toBe(false)
    // The rename command is still reachable on shift+r.
    expect(binds(fixture).some((bind) => bind.split(",").some((token) => token.trim() === "shift+r"))).toBe(true)
    // And `r` really resets the field through the real command.
    dispatch(fixture, "r")
    await until(fixture, () => fixture.fake.mutateInputs.length === 1)
    const own = fixture.fake.mutateInputs[0].records.filter((entry) => entry.type === "model" && entry.agent === "alice" && entry.removed !== true)
    expect(own).toEqual([expect.objectContaining({ providerID: "acme", modelID: "nova-1" })])
    expect(own[0]).not.toHaveProperty("warming")
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
    // The sidebar's Agents catalogue group toggles its agents' Enabled rows
    // (plus-1.1.17 group toggle); r/s still do not apply to it, and d on it
    // produces a status refusal.
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "group:project:agents", "Agents")
    const rootBinds = binds(fixture)
    expect(rootBinds).toContain("a")
    expect(rootBinds).toContain("d")
    expect(rootBinds).toContain("space")
    expect(footer(fixture.captureCharFrame())).toContain("space toggle")
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
