// The S1b pick-up move mode through the real route: `m` marks the row, arrows
// preview the new place with no store write, Enter drops as one layout write
// and Esc restores. Ordinary model/tool rows, folders and sidebar owners move;
// cold-cache try order keeps its own mode.
import { afterEach, expect, test } from "bun:test"
import { fingerprint } from "../src/instructions/model.js"
import { createSnapshot, renderInstructionsRoute, type TestFixture } from "./tui.js"
import { category, dispatch, footer, gotoLevel, levelOf, moveTo, selectedRow, sleep, toSidebar } from "./instructions-nav.js"

const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
})

const UPDATED = "2026-01-01T00:00:00.000Z"

function projectAgent(id: string, origin: "native" | "special" | "plus" | "user" = "user") {
  return { id, scope: "project" as const, fileBacked: true, origin }
}

async function until(fixture: TestFixture, predicate: () => boolean, timeout = 4000): Promise<void> {
  for (let waited = 0; waited < timeout; waited += 50) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error("condition never held")
}

function lineOf(frame: string, text: string): number {
  return frame.split("\n").findIndex((line) => line.includes(text) && !line.includes("›"))
}

function firstOf(frame: string, one: string, other: string): string {
  return lineOf(frame, one) <= lineOf(frame, other) ? one : other
}

async function goto(fixture: TestFixture, id: string, label: string): Promise<void> {
  await gotoLevel(fixture, levelOf(id))
  await toSidebar(fixture)
  if (!dispatch(fixture, "/")) throw new Error("no filter key")
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  const query = `id:${id} !id:${id}:`
  await fixture.typeText(query)
  await until(fixture, () => fixture.captureCharFrame().includes(query.slice(-24)))
  await sleep(250)
  await until(fixture, () => footer(fixture.captureCharFrame()).includes("esc clear filter") && selectedRow(fixture.captureCharFrame()).includes(label))
  dispatch(fixture, "return")
  await until(fixture, () => !footer(fixture.captureCharFrame()).includes("esc clear filter") && selectedRow(fixture.captureCharFrame()).includes(label))
}

async function openModels(fixture: TestFixture): Promise<void> {
  await goto(fixture, "agent:project:Implementer", "Implementer")
  dispatch(fixture, "right")
  await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
  await category(fixture, "Models")
}

const MODELS = [
  { type: "model" as const, level: "project" as const, agent: "Implementer", providerID: "openai", modelID: "gpt-4o", active: true as const, updated: UPDATED },
  { type: "model" as const, level: "project" as const, agent: "Implementer", providerID: "anthropic", modelID: "claude-sonnet", updated: UPDATED },
]

test("section arrows preview; Esc restores with zero writes and Enter uses one text mutation", async () => {
  const middleLine = (frame: string, label: string) => frame.split("\n").findIndex((line) => line.split("│")[1]?.includes(label))
  const base = createSnapshot({ agents: [build], items: [tool("tool:read", "read", "## First\nfirst body\n## Second\nsecond body\n")] })
  const fixture = await renderInstructionsRoute({ snapshots: [base], width: 130, height: 45 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:defaults:build", "build")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Tools")
    await moveTo(fixture, "read")
    dispatch(fixture, "right")
    await moveTo(fixture, "Description")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => frame.includes("First") && frame.includes("Second"))
    await moveTo(fixture, "Second")
    dispatch(fixture, "m")
    await fixture.waitForFrame((frame) => footer(frame).includes("reorder siblings"))
    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => middleLine(frame, "Second") < middleLine(frame, "First"))
    expect(fixture.fake.mutateInputs).toHaveLength(0)
    dispatch(fixture, "escape")
    await fixture.waitForFrame((frame) => !footer(frame).includes("drop") && middleLine(frame, "First") < middleLine(frame, "Second"))
    expect(fixture.fake.mutateInputs).toHaveLength(0)
    expect(selectedRow(fixture.captureCharFrame())).toContain("Second")
    dispatch(fixture, "m")
    await fixture.waitForFrame((frame) => footer(frame).includes("drop"))
    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => middleLine(frame, "Second") < middleLine(frame, "First"))
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.mutateInputs.length === 1)
    expect(fixture.fake.layoutWrites).toHaveLength(0)
    expect(fixture.fake.mutateInputs[0]!.records.some((record) => record.type === "customization" && record.text?.indexOf("Second")! < record.text?.indexOf("First")!)).toBe(true)
  } finally {
    fixture.destroy()
  }
})

test("m picks a model row up: arrows preview with no write, Enter drops once, Esc restores", async () => {
  const base = createSnapshot({ agents: [projectAgent("Implementer")], records: MODELS })
  const fixture = await renderInstructionsRoute({ snapshots: [base], width: 100, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await openModels(fixture)
    await fixture.waitForFrame((frame) => frame.includes("gpt-4o") && frame.includes("claude-sonnet"))
    const first = firstOf(fixture.captureCharFrame(), "gpt-4o", "claude-sonnet")
    const second = first === "gpt-4o" ? "claude-sonnet" : "gpt-4o"
    await moveTo(fixture, second)

    expect(dispatch(fixture, "m")).toBe(true)
    await fixture.waitForFrame((frame) => footer(frame).includes("drop") && footer(frame).includes("cancel"))
    expect(footer(fixture.captureCharFrame())).toContain("→ into folder")
    expect(fixture.captureCharFrame()).toContain("↕")

    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => firstOf(frame, "gpt-4o", "claude-sonnet") === second)
    expect(fixture.fake.layoutWrites.length).toBe(0)
    expect(firstOf(fixture.captureCharFrame(), "gpt-4o", "claude-sonnet")).toBe(second)

    // A second row card: Esc restores the original order and writes nothing.
    dispatch(fixture, "escape")
    await fixture.waitForFrame((frame) => !footer(frame).includes("drop") && firstOf(frame, "gpt-4o", "claude-sonnet") === first)
    expect(fixture.fake.layoutWrites.length).toBe(0)
    expect(firstOf(fixture.captureCharFrame(), "gpt-4o", "claude-sonnet")).toBe(first)
  } finally {
    fixture.destroy()
  }
})

test("Enter drops the previewed order as one layout write over an order record", async () => {
  const base = createSnapshot({ agents: [projectAgent("Implementer")], records: MODELS })
  const fixture = await renderInstructionsRoute({ snapshots: [base], width: 100, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await openModels(fixture)
    await fixture.waitForFrame((frame) => frame.includes("gpt-4o") && frame.includes("claude-sonnet"))
    const first = firstOf(fixture.captureCharFrame(), "gpt-4o", "claude-sonnet")
    const second = first === "gpt-4o" ? "claude-sonnet" : "gpt-4o"
    const moved = second === "gpt-4o" ? "model:openai/gpt-4o" : "model:anthropic/claude-sonnet"
    const other = first === "gpt-4o" ? "model:openai/gpt-4o" : "model:anthropic/claude-sonnet"
    await moveTo(fixture, second)
    dispatch(fixture, "m")
    await fixture.waitForFrame((frame) => footer(frame).includes("drop"))
    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => firstOf(frame, "gpt-4o", "claude-sonnet") === second)

    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.layoutWrites.length === 1)
    const write = fixture.fake.layoutWrites[0]
    expect(write?.orders.find((record) => record.scope === "group:group:project:Implementer:models")?.items).toEqual([moved, other])
    expect(write?.folders).toEqual([])
    // Cursor stays on the moved row after the write.
    await fixture.waitForFrame((frame) => !footer(frame).includes("drop") && selectedRow(frame).includes(second))
    expect(selectedRow(fixture.captureCharFrame())).toContain(second)
  } finally {
    fixture.destroy()
  }
})

test("a sidebar owner reorders through a group order, with no write until Enter", async () => {
  const orders = [
    {
      type: "order" as const,
      level: "global" as const,
      scope: "group:group:project:agents:user",
      items: ["agent:project:Helper", "agent:project:Implementer"],
      updated: UPDATED,
    },
  ]
  const base = createSnapshot({ agents: [projectAgent("Implementer"), projectAgent("Helper")], records: [], orders })
  const reloaded = createSnapshot({ agents: [projectAgent("Implementer"), projectAgent("Helper")], records: [], orders })
  const fixture = await renderInstructionsRoute({ snapshots: [base, reloaded], width: 100, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await gotoLevel(fixture, "project")
    await toSidebar(fixture)
    await moveTo(fixture, "Help")
    expect(selectedRow(fixture.captureCharFrame())).toContain("Help")
    expect(lineOf(fixture.captureCharFrame(), "Helper")).toBeLessThan(lineOf(fixture.captureCharFrame(), "Implementer"))
    dispatch(fixture, "m")
    await fixture.waitForFrame((frame) => footer(frame).includes("drop"))
    dispatch(fixture, "down")
    await fixture.waitForFrame((frame) => lineOf(frame, "Implementer") < lineOf(frame, "Helper"))
    expect(fixture.fake.layoutWrites.length).toBe(0)
    const preview = fixture.captureCharFrame()
    expect(lineOf(preview, "Implementer")).toBeLessThan(lineOf(preview, "Helper"))

    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.layoutWrites.length === 1)
    const write = fixture.fake.layoutWrites[0]
    expect(write?.orders.find((record) => record.scope === "group:group:project:agents:user")?.items).toEqual([
      "agent:project:Implementer",
      "agent:project:Helper",
    ])
    // The reloaded snapshot carries the order; the cursor stays on the moved owner.
    await fixture.waitForFrame((frame) => !footer(frame).includes("drop") && selectedRow(frame).includes("Help"))
  } finally {
    fixture.destroy()
  }
})

test("an arrow that cannot apply says why and writes nothing", async () => {
  const base = createSnapshot({ agents: [projectAgent("Implementer")], records: MODELS })
  const fixture = await renderInstructionsRoute({ snapshots: [base], width: 100, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await openModels(fixture)
    await moveTo(fixture, "gpt-4o")
    dispatch(fixture, "m")
    await fixture.waitForFrame((frame) => footer(frame).includes("drop"))
    // A model row is not inside a folder, so left refuses with a reason.
    dispatch(fixture, "left")
    await fixture.waitForFrame((frame) => frame.includes("not inside a folder"))
    expect(fixture.fake.layoutWrites.length).toBe(0)
    dispatch(fixture, "escape")
  } finally {
    fixture.destroy()
  }
})

const build = { id: "build", scope: "defaults" as const, fileBacked: false, origin: "native" as const }

function tool(id: string, title: string, text: string) {
  return { id, kind: "tool" as const, group: "native" as const, title, text, enabled: true, fingerprint: fingerprint(text) }
}

// A System row moves a part of the request: arrows step over whole parts
// (Role/persona and Base are one), there is no folder step, and Enter writes the
// owner's complete System order.
test("m on a System row moves its part in the request with one layout write", async () => {
  const middleLine = (frame: string, label: string) => frame.split("\n").findIndex((line) => line.split("│")[1]?.includes(label))
  const items = [
    { ...tool("system:role", "Role/persona", ""), kind: "system" as const, group: "none" as const },
    { ...tool("base:gpt", "GPT base", "base instructions"), kind: "base" as const, group: "none" as const },
    { ...tool("system:opencode/date", "Date", "OpenCode adds today's date."), kind: "system" as const, opencodePart: "core/date" },
  ]
  const fixture = await renderInstructionsRoute({ snapshots: [createSnapshot({ agents: [build], items })], width: 130, height: 45 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:defaults:build", "build")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "System")
    await fixture.waitForFrame((frame) => middleLine(frame, "Role/persona") < middleLine(frame, "Date"))
    await moveTo(fixture, "Date")
    dispatch(fixture, "m")
    await fixture.waitForFrame((frame) => footer(frame).includes("move in the request") && !footer(frame).includes("into folder"))
    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => middleLine(frame, "Date") < middleLine(frame, "Role/persona") && middleLine(frame, "Role/persona") < middleLine(frame, "GPT base"))
    expect(fixture.fake.layoutWrites).toHaveLength(0)
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.layoutWrites.length === 1)
    expect(fixture.fake.layoutWrites[0]?.orders.find((record) => record.scope === "group:group:defaults:build:system")?.items.slice(0, 3)).toEqual([
      "core/date",
      "first",
      "core/identity",
    ])
  } finally {
    fixture.destroy()
  }
})

// A tool row's display order is durable: after Enter writes the order, the
// reloaded snapshot (which carries it) shows the same order with no further
// write. The row stays selected across the reload.
test("an ordinary tool reorder survives a snapshot reload with no second write", async () => {
  const order = {
    type: "order" as const,
    level: "global" as const,
    scope: "group:group:defaults:build:tools:native",
    items: ["tool:read", "tool:bash"],
    updated: UPDATED,
  }
  const items = [tool("tool:bash", "bash", "run\n"), tool("tool:read", "read", "read\n")]
  const base = createSnapshot({ agents: [build], items })
  const reloaded = createSnapshot({ agents: [build], items, orders: [order] })
  const fixture = await renderInstructionsRoute({ snapshots: [base, reloaded], width: 130, height: 45 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:defaults:build", "build")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Tools")
    await fixture.waitForFrame((frame) => frame.includes("bash") && frame.includes("read"))
    expect(lineOf(fixture.captureCharFrame(), "bash")).toBeLessThan(lineOf(fixture.captureCharFrame(), "read"))
    await moveTo(fixture, "read")
    dispatch(fixture, "m")
    await fixture.waitForFrame((frame) => footer(frame).includes("drop"))
    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => lineOf(frame, "read") < lineOf(frame, "bash"))
    expect(fixture.fake.layoutWrites.length).toBe(0)
    dispatch(fixture, "return")
    await until(fixture, () => fixture.fake.layoutWrites.length === 1)
    expect(fixture.fake.layoutWrites[0]?.orders.find((record) => record.scope === "group:group:defaults:build:tools:native")?.items).toEqual([
      "tool:read",
      "tool:bash",
    ])
    // The reloaded snapshot carries the order; the moved row stays selected.
    await fixture.waitForFrame(
      (frame) => !footer(frame).includes("drop") && lineOf(frame, "read") < lineOf(frame, "bash") && selectedRow(frame).includes("read"),
    )
    expect(fixture.fake.layoutWrites.length).toBe(1)
  } finally {
    fixture.destroy()
  }
})
