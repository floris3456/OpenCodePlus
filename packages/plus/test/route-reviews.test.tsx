// The Instructions route: reviews and merges, the splitter, sections, Code Mode, Models and provenance.
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { save } from "../src/instructions/store.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"
import { agentInfo, fullContext } from "./harness.js"
import { binds, breadcrumb, category, dispatch, expand, footer, moveTo, reach, selectedRow } from "./instructions-nav.js"
import { goto, showSection, filter, moveToResult, until, listPane, inspector, flat, mcpItem, toolItem, projectAgent, reviewSnapshot, gotoMcpItem, mergeSnapshot, fastForwardSnapshot, codemodeSnapshot } from "./route-helpers.js"

const e2eRoots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(e2eRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

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

test("t on a both-changed unit saves yours as the merge, with no markers", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [reviewSnapshot()], width: 120, height: 40 })
  try {
    await gotoMcpItem(fixture)
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(fixture.fake.mutateInputs).toEqual([])
    dispatch(fixture, "t")
    await fixture.waitForFrame((frame) => frame.includes('Merged "sample"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    expect(fixture.fake.mutateInputs[0].records[0]).toMatchObject({ type: "customization", text: "mine" })
    expect(JSON.stringify(fixture.fake.mutateInputs[0].records)).not.toContain("<<<<<<<")
  } finally {
    fixture.destroy()
  }
})

test("t on a both-changed paragraph saves yours and clears the review only after t", async () => {
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
      text: "one\ntwo\nthree\nfour\ncustom tail",
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
    // e edits the merged rows as the include set renders them; both sides
    // changed the one unit, so yours is the draft: no markers, and it saves.
    expect(editor?.plainText).toBe("mine")
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
    // Right expands the item, then its Description into editable sections.
    await showSection(fixture, "Purpose")
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
    await showSection(fixture, "Introduction")
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
    await showSection(fixture, "Purpose")
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
    // Models is the agent's first category: key 1.
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    expect(dispatch(fixture, "1")).toBe(true)
    await fixture.waitForFrame((frame) => breadcrumb(frame).includes("Implementer › Models"))
    // The rows sit in the acme › Other group.
    await moveTo(fixture, "Other")
    await expand(fixture)
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
