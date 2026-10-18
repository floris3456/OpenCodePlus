// The workspace screen's own behaviour (docs/instructions-redesign.md):
// reveal after create, review jumps, level switching that keeps the place,
// compare, and the live filter's go-to.
import { expect, test } from "bun:test"
import { fingerprint } from "../src/instructions/model.js"
import type { Plus, Snapshot } from "../src/rpc.js"
import { breadcrumb, dispatch, reach, selectedRow, sleep } from "./instructions-nav.js"
import { createSnapshot, createTestTheme, renderInstructionsRoute } from "./tui.js"

const build = { id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const }

test("saved human and tool receipts stack once and expire after live change events", async () => {
  const entries: Plus.LogEntry[] = []
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: [build] })], width: 130, height: 40,
    rpc: { "instructions.log": async () => ({ entries, total: entries.length }) },
  })
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  entries.push(
    { ts: new Date().toISOString(), actor: { type: "tool", agent: "helper" }, op: "layout", target: "tools", summary: "Pasted saved tool configuration", revision: 1 },
    { ts: new Date().toISOString(), actor: { type: "tui" }, op: "edit", target: "description", summary: "Saved shared description", revision: 2 },
  )
  await fixture.emitChanged()
  await fixture.waitForFrame((frame) => frame.includes("helper: Pasted saved tool configuration") && frame.includes("You: Saved shared description"))
  await fixture.emitChanged()
  expect(fixture.captureCharFrame().match(/helper: Pasted saved tool configuration/g)).toHaveLength(1)
  await sleep(4700)
  await fixture.waitForFrame((frame) => !frame.includes("helper: Pasted saved tool configuration") && !frame.includes("You: Saved shared description"))
})

function tool(id: string, title: string, text: string) {
  return { id, kind: "tool" as const, group: "native" as const, title, text, enabled: true, fingerprint: fingerprint(text) }
}

function toolItem(id: string, title: string, extra: Partial<Plus.SnapshotItem>): Plus.SnapshotItem {
  return { ...tool(id, title, "run\n"), ...extra }
}

// bash at Project was edited when upstream read "old"; upstream now reads "new".
function reviewSnapshot(): Snapshot {
  return createSnapshot({
    agents: [build],
    items: [tool("tool:bash", "bash", "new bash text\n"), tool("tool:read", "read", "read files\n")],
    records: [
      {
        type: "customization",
        level: "project",
        agent: "build",
        item: "tool:bash",
        section: null,
        text: "my bash text\n",
        basedOn: fingerprint("old bash text\n"),
        basedOnText: "old bash text\n",
        updated: "2026-09-27T00:00:00.000Z",
      },
    ],
  })
}

test("selected tools keep their marks across navigation and Space applies one resulting value", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({
      agents: [build], items: [tool("tool:read", "read", "Read files"), tool("tool:write", "write", "Write files")],
      records: [{ type: "customization", level: "project", agent: "build", item: "tool:read", section: null, state: "off", basedOn: fingerprint("Read files"), updated: "2026-10-11T00:00:00Z" }],
    })], width: 130, height: 40,
  })
  await reach(fixture, "item:project:build:tool:read", "read")
  expect(dispatch(fixture, "x")).toBe(true)
  expect(dispatch(fixture, "tab")).toBe(true)
  expect(dispatch(fixture, "tab")).toBe(true)
  expect(dispatch(fixture, "down")).toBe(true)
  await fixture.waitForFrame((frame) => selectedRow(frame).includes("write"))
  expect(dispatch(fixture, "x")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("2 selected"))
  expect(dispatch(fixture, "space")).toBe(true)
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.some((input) => input.records.some((record) => record.type === "customization" && record.item === "tool:write" && record.state === "off")))
  const records = fixture.fake.mutateInputs.at(-1)?.records ?? []
  expect(records.filter((record) => record.type === "customization" && ["tool:read", "tool:write"].includes(record.item)).map((record) => record.type === "customization" ? record.state : undefined)).toEqual(["off", "off"])
  expect(dispatch(fixture, "escape")).toBe(true)
  await fixture.waitForFrame((frame) => !frame.includes("2 selected"))
})

test("Base sits in the flat System list right after Role/persona, and a reveal lands on its row", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({
      agents: [build],
      items: [
        { ...tool("system:role", "Role/persona", ""), kind: "system", group: "none" },
        { ...tool("base:gpt", "GPT base", "base instructions"), kind: "base", group: "none" },
        { ...tool("system:opencode/date", "Date", "OpenCode adds today's date."), kind: "system", opencodePart: "core/date" },
      ],
    })],
    width: 130, height: 40,
  })
  await reach(fixture, "item:project:build:base:gpt", "GPT base")
  const frame = fixture.captureCharFrame()
  expect(frame).toContain("4 System")
  expect(frame).not.toMatch(/\d Base/)
  expect(frame).not.toContain("switch tab")
  expect(breadcrumb(frame)).toContain("System › Base")
  // One list in request order: up from the base prompt is the Base heading,
  // then Role/persona; below it the next parts, Model prompts and OpenCode's date.
  expect(dispatch(fixture, "up")).toBe(true)
  await fixture.waitForFrame((next) => breadcrumb(next).trimEnd().endsWith("System › Base"))
  expect(dispatch(fixture, "up")).toBe(true)
  await fixture.waitForFrame((next) => breadcrumb(next).trimEnd().endsWith("System › Role/persona"))
  expect(dispatch(fixture, "down")).toBe(true)
  expect(dispatch(fixture, "down")).toBe(true)
  expect(dispatch(fixture, "down")).toBe(true)
  await fixture.waitForFrame((next) => breadcrumb(next).trimEnd().endsWith("System › Model prompts"))
  expect(dispatch(fixture, "down")).toBe(true)
  await fixture.waitForFrame((next) => breadcrumb(next).trimEnd().endsWith("System › Date"))
})

test("successful paste reveals its nested destination row instead of the paste target", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: [build], items: [tool("tool:read", "read", "Read files"), tool("tool:write", "write", "Write files"), { ...tool("param:read:path", "path", "Read path"), kind: "param", paramTool: "read" }] })],
    width: 130, height: 40,
    rpc: { "instructions.run": async () => ({ status: "Pasted one row", rows: ["item:project:build:param:read:path"], consumed: true }) },
  })
  await reach(fixture, "item:project:build:tool:write", "write")
  expect(dispatch(fixture, "ctrl+v")).toBe(true)
  await fixture.waitForFrame((frame) => selectedRow(frame).includes("path") && breadcrumb(frame).includes("read"))
  expect(breadcrumb(fixture.captureCharFrame())).toContain("build › Tools › OpenCode › read › path")
})

test("creating a team selects it in the sidebar once the host shows it", async () => {
  const before = createSnapshot({ agents: [build] })
  const after = createSnapshot({ agents: [build], teams: [{ level: "project", team: "crew", enabled: false, agents: ["reviewer"] }] })
  // The dialog's preset step reads the screen's snapshot from the plugin
  // cache (filled by the initial load), so only the create's own refresh
  // consumes the next RPC answer: the after snapshot.
  await using fixture = await renderInstructionsRoute({
    snapshots: [before, after],
    width: 130,
    height: 45,
    dialogs: { prompts: ["crew"], selects: [""] },
  })
  await reach(fixture, "group:project:teams", "Teams")
  expect(dispatch(fixture, "a")).toBe(true)
  await fixture.waitForFrame((frame) => selectedRow(frame).includes("crew"))
  expect(fixture.fake.teamCreates).toEqual([{ level: "project", team: "crew" }])
  expect(fixture.fake.toasts).toEqual([{ variant: "success", message: "Created team crew" }])
  expect(fixture.captureCharFrame()).toContain("reviewer")
})

test("n jumps to the row under review, opening its owner, category and subgroup", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [reviewSnapshot()], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("Project !1"))
  expect(dispatch(fixture, "n")).toBe(true)
  await fixture.waitForFrame((frame) => selectedRow(frame).includes("bash"))
  expect(selectedRow(fixture.captureCharFrame())).toContain("!")
  expect(breadcrumb(fixture.captureCharFrame())).toContain("build › Tools › OpenCode › bash")
  expect(fixture.captureCharFrame()).toContain("Review 1 of 1")
  // Enter reviews it: the real diff, then keep.
  expect(dispatch(fixture, "return")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("Upstream change") && frame.includes("new bash text"))
  expect(dispatch(fixture, "k")).toBe(true)
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  expect(fixture.fake.mutateInputs[0]?.records).toContainEqual(
    // Keep acknowledges the new upstream and keeps your text.
    expect.objectContaining({ item: "tool:bash", text: "my bash text\n", acknowledged: fingerprint("new bash text\n") }),
  )
})

test("n with nothing to review says so", async () => {
  await using fixture = await renderInstructionsRoute({ snapshots: [createSnapshot({ agents: [build] })], width: 130, height: 45 })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  dispatch(fixture, "n")
  await fixture.waitForFrame((frame) => frame.includes("Nothing to review in Project"))
})

test("< and > switch the level and keep the agent, category and row", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: [build], items: [tool("tool:bash", "bash", "run\n"), tool("tool:read", "read", "read\n")] })],
    width: 130,
    height: 45,
  })
  await reach(fixture, "item:project:build:tool:read", "read")
  expect(dispatch(fixture, ">")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Global"))
  expect(breadcrumb(fixture.captureCharFrame())).toContain("Global › Agents › OpenCode › build › Tools › OpenCode › read")
  expect(selectedRow(fixture.captureCharFrame())).toContain("read")
  expect(dispatch(fixture, "<")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).trimStart().startsWith("Project"))
  expect(selectedRow(fixture.captureCharFrame())).toContain("read")
})

test("c compares a row you edited with upstream, read-only", async () => {
  const text = "run commands\n"
  await using fixture = await renderInstructionsRoute({
    snapshots: [
      createSnapshot({
        agents: [build],
        items: [tool("tool:bash", "bash", text)],
        records: [
          {
            type: "customization",
            level: "project",
            agent: "build",
            item: "tool:bash",
            section: null,
            text: "run commands carefully\n",
            basedOn: fingerprint(text),
            basedOnText: text,
            updated: "2026-09-27T00:00:00.000Z",
          },
        ],
      }),
    ],
    width: 130,
    height: 45,
  })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(selectedRow(fixture.captureCharFrame())).toContain("◆")
  expect(dispatch(fixture, "c")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("Your change") && frame.includes("run commands carefully"))
  expect(fixture.captureCharFrame()).toContain("compare")
  expect(fixture.captureCharFrame()).not.toContain("Upstream change")
  expect(dispatch(fixture, "k")).toBe(false)
  expect(dispatch(fixture, "escape")).toBe(true)
  await fixture.waitForFrame((frame) => !frame.includes("Your change"))
  expect(fixture.fake.mutateInputs).toEqual([])
})

test("c on a row with no text of its own explains instead of opening an empty diff", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: [build], items: [tool("tool:bash", "bash", "run\n")] })],
    width: 130,
    height: 45,
  })
  await reach(fixture, "item:project:build:tool:bash", "bash")
  expect(dispatch(fixture, "c")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes('"bash" has no text of its own at this level to compare'))
})

test("the filter lands on the match, toggles it in place with ctrl+space, and enter goes to it", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: [build], items: [tool("tool:bash", "bash", "run\n"), tool("tool:read", "read", "read\n")] })],
    width: 130,
    height: 45,
  })
  await fixture.waitForFrame((frame) => frame.includes("esc close"))
  expect(dispatch(fixture, "/")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  await fixture.typeText("read")
  await fixture.waitForFrame((frame) => frame.includes("esc clear filter") && selectedRow(frame).includes("read"))
  // Ancestors show for context; the cursor sits on the match itself.
  expect(fixture.captureCharFrame()).toContain("Tools")
  expect(fixture.captureCharFrame()).not.toContain("bash")
  expect(dispatch(fixture, "ctrl+space")).toBe(true)
  await fixture.waitForFrame(() => fixture.fake.mutateInputs.length === 1)
  expect(fixture.fake.mutateInputs[0]?.records).toContainEqual(expect.objectContaining({ item: "tool:read", state: "off" }))
  expect(dispatch(fixture, "return")).toBe(true)
  await fixture.waitForFrame((frame) => !frame.includes("esc clear filter") && selectedRow(frame).includes("read"))
  expect(breadcrumb(fixture.captureCharFrame())).toContain("build › Tools › OpenCode › read")
})

test("sidebar owners and the Tools tab carry the switched-on count beside the owner header's split", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [
      createSnapshot({
        agents: [build],
        items: [
          toolItem("tool:shell", "shell", {}),
          toolItem("tool:coder", "coder", { codemode: true }),
          toolItem("tool:writer", "writer", { codemode: true, pinned: true }),
        ],
      }),
    ],
    width: 130,
    height: 45,
  })
  // The owner header reflows its own line: 3 on, the pinned Code Mode tool
  // counted direct, the unpinned one through Code Mode.
  await fixture.waitForFrame((frame) => frame.includes("3 tools on (2 direct, 1 through Code Mode)"))
  const frame = fixture.captureCharFrame()
  // The sidebar is 30 columns at this width; the row's number is right-aligned.
  expect(selectedRow(frame).slice(0, 29).trimEnd().endsWith("3")).toBe(true)
  expect(frame).toContain("Tools 3")
})

test("an owner with nothing switched on warns no tools and says how to turn some on", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({ agents: [build] })],
    width: 130,
    height: 45,
  })
  await fixture.waitForFrame((frame) => frame.includes("no tools on · link a preset (l) or turn tools on (2)"))
  const spans = fixture.captureSpans().lines.flatMap((line) => line.spans)
  const sidebar = spans.find((span) => span.text === "no tools ")
  expect(sidebar).toBeDefined()
  expect(sidebar?.fg.equals(createTestTheme().text.feedback.warning.base)).toBe(true)
  expect(fixture.captureCharFrame()).toContain("Tools 0")
})

test("enter or → on an OpenCode System row set up in another tab goes to that tab and highlights the row", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot({
      agents: [build],
      items: [
        tool("tool:read", "read", "Read a file."),
        { ...tool("skill:notes", "notes", "Take notes."), kind: "skill" },
        { ...tool("system:opencode/tools", "Tools", "OpenCode sends the definitions of the tools."), kind: "system", opencodePart: "tools" },
        { ...tool("system:opencode/skills", "Skills", "OpenCode lists the skills."), kind: "system", opencodePart: "core/skill-guidance" },
        { ...tool("system:opencode/date", "Date", "OpenCode adds today's date."), kind: "system", opencodePart: "core/date" },
      ],
    })],
    width: 130, height: 40,
  })
  await reach(fixture, "item:project:build:system:opencode/skills", "Skills")
  expect(fixture.captureCharFrame()).toContain("settings    Skills · enter or → goes")
  expect(fixture.captureCharFrame()).toContain("enter → go to Skills")
  expect(dispatch(fixture, "return")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).includes("build › Skills"))
  expect(fixture.captureCharFrame()).toContain('Went to Skills: "Skills" in System is built from it')
  await reach(fixture, "item:project:build:system:opencode/tools", "Tools")
  expect(dispatch(fixture, "right")).toBe(true)
  await fixture.waitForFrame((frame) => breadcrumb(frame).includes("build › Tools") && selectedRow(frame).includes("OpenCode"))
  // A row set up nowhere keeps its usual keys: enter does not leave System.
  await reach(fixture, "item:project:build:system:opencode/date", "Date")
  expect(fixture.captureCharFrame()).not.toContain("enter or → goes")
  dispatch(fixture, "return")
  await sleep(100)
  expect(breadcrumb(fixture.captureCharFrame())).toContain("System › Date")
})
