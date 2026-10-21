import { expect, test } from "bun:test"
import { controlItems, controlRecord, controlSnapshot } from "./agent-controls-fixture.js"
import { dispatch, reach } from "./instructions-nav.js"
import { flat, goto, inspector, projectAgent, until } from "./route-helpers.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"

// Text an agent reads shows in the sidebar whole and rendered as markdown, an
// agent's Description like a tool's text; the editor renders its draft beside
// it as it is typed. Rendered markdown paints a few frames after the row
// (opentui parses it off the frame loop), so it is awaited with until's
// wall-clock deadline rather than a frame budget.

const description =
  "Reviews **pull requests** for the release.\n\nIt checks the diff, runs the focused tests and reports each finding with its file, line and evidence."

test("the sidebar shows an agent's whole Description, rendered as markdown", async () => {
  await using fixture = await renderInstructionsRoute({
    width: 160,
    height: 50,
    snapshots: [controlSnapshot([controlRecord("setting:description", { text: description })])],
  })
  await reach(fixture, "item:project:build:setting:description", "Reviews")
  await until(fixture, (frame) => inspector(frame).includes(flat("Reviews pull requests for the release.")))
  const shown = inspector(fixture.captureCharFrame())
  // All of it, past the row's 80-character value, and without its markdown markers.
  expect(shown).toContain(flat("its file, line and evidence."))
  expect(shown).not.toContain("**")
  // The text is shown once, not again as a cut value line.
  expect(shown).not.toContain(flat("value Reviews"))
})

test("a tool's text renders as markdown; a model field row shows no item text", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer", "native")],
    items: [
      ...controlItems(),
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "Run **commands** in a shell.\n\n## Usage\n\n- one call per command\n- quote paths",
        enabled: true,
        fingerprint: "fp-shell",
      },
    ],
    records: [{ type: "model" as const, level: "project" as const, agent: "Implementer", providerID: "acme", modelID: "nova", active: true as const, updated: "2026-10-21" }],
  })
  await using fixture = await renderInstructionsRoute({ width: 160, height: 50, snapshots: [snapshot] })
  await fixture.waitForFrame((frame) => frame.includes("Instructions"))
  await goto(fixture, "item:project:Implementer:tool:shell", "shell")
  await until(fixture, (frame) => inspector(frame).includes(flat("Run commands in a shell.")))
  const tool = inspector(fixture.captureCharFrame())
  expect(tool).toContain(flat("Usage"))
  expect(tool).toContain(flat("quote paths"))
  expect(tool).not.toContain("**")
  expect(tool).not.toContain("##")
  await goto(fixture, "item:project:Implementer:modelfield:warming:acme/nova", "Warming")
  await fixture.waitForFrame((frame) => inspector(frame).includes(flat("field warming")))
  expect(inspector(fixture.captureCharFrame())).not.toContain(flat("No item details"))
})

test("the editor renders the draft beside it as it is typed", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer", "native")],
    items: [{ id: "tool:shell", kind: "tool" as const, group: "native" as const, title: "shell", text: "run shell commands", enabled: true, fingerprint: "fp-shell" }],
  })
  await using fixture = await renderInstructionsRoute({ width: 120, height: 40, snapshots: [snapshot] })
  await goto(fixture, "item:project:Implementer:tool:shell", "shell")
  expect(dispatch(fixture, "e")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("ctrl+s save") && frame.includes("rendered"))
  await fixture.typeText(" with **bold** words")
  // The editor keeps the markers; the rendered side hides them, still one
  // paragraph after typing onto it (not the old text plus a new paragraph).
  await until(fixture, (frame) => frame.split("\n").some((line) => line.includes("│ run shell commands with bold words")))
  expect(flat(fixture.captureCharFrame())).toContain(flat("run shell commands with **bold** words"))
})
