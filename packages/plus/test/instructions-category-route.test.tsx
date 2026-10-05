import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createSnapshot, renderInstructionsRoute, type TestFixture } from "./tui.js"
import {
  binds,
  breadcrumb,
  category,
  dispatch,
  footer,
  gotoLevel,
  levelOf,
  moveTo,
  selectedRow,
  sleep,
  toSidebar,
} from "./instructions-nav.js"

const e2eRoots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(e2eRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function until(fixture: TestFixture, predicate: (frame: string) => boolean, timeout = 4000): Promise<string> {
  for (let waited = 0; waited < timeout; waited += 50) {
    const frame = fixture.captureCharFrame()
    if (predicate(frame)) return frame
    await sleep(50)
  }
  return fixture.waitForFrame(predicate)
}

async function goto(fixture: TestFixture, id: string, label: string): Promise<void> {
  await gotoLevel(fixture, levelOf(id))
  await toSidebar(fixture)
  if (!dispatch(fixture, "/")) throw new Error("no filter key")
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await sleep(20)
  const query = `id:${id} !id:${id}:`
  await fixture.typeText(query)
  await until(fixture, (frame) => frame.includes(query.slice(-24)))
  await sleep(250)
  await until(fixture, (frame) => footer(frame).includes("esc clear filter") && selectedRow(frame).includes(label))
  dispatch(fixture, "return")
  await until(fixture, (frame) => !footer(frame).includes("esc clear filter") && selectedRow(frame).includes(label))
}

function projectAgent(id: string, origin: "native" | "special" | "plus" | "user" = "user") {
  return { id, scope: "project" as const, fileBacked: true, origin }
}

test("a in Models offers Category and Model; picking Model preserves context without scope prompt", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    records: [
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "openai",
        modelID: "gpt-4o",
        active: true,
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    models: [{ providerID: "acme", modelID: "nova", name: "Nova" }],
    dialogs: { selects: ["model", "acme", "nova"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:project:Implementer", "Implementer")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Models")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.modelAdds.length === 1)
    expect(fixture.fake.modelAdds[0]).toEqual({
      level: "project",
      agent: "Implementer",
      providerID: "acme",
      modelID: "nova",
    })
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Add", "Model provider", "Model"])
    const addSelect = fixture.fake.selectInputs[0]
    expect(addSelect.options).toEqual([
      { title: "Model", value: "model" },
      { title: "Category", value: "category" },
    ])
  } finally {
    fixture.destroy()
  }
})

test("a in Models offers Category; picking Category prompts for name and creates category", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    records: [
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "openai",
        modelID: "gpt-4o",
        active: true,
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { selects: ["category"], prompts: ["Work"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:project:Implementer", "Implementer")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Models")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.categoryMutates.length === 1)
    expect(fixture.fake.categoryMutates[0]).toEqual({
      action: "create",
      name: "Work",
    })
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Add"])
    expect(fixture.fake.dialogPrompts.map(([title]) => title)).toEqual(["Category name"])
  } finally {
    fixture.destroy()
  }
})

test("m moves inactive candidate into category, and m offers back to home category", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    categories: [
      {
        type: "category",
        level: "global",
        name: "Work",
        order: 1,
        items: [],
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
    records: [
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "openai",
        modelID: "gpt-4o",
        active: true,
        updated: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "anthropic",
        modelID: "claude-sonnet",
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { selects: ["Work"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:project:Implementer", "Implementer")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Models")
    await moveTo(fixture, "claude-sonnet")
    expect(dispatch(fixture, "m")).toBe(true)
    await until(fixture, () => fixture.fake.categoryMutates.length === 1)
    expect(fixture.fake.categoryMutates[0]).toEqual({
      action: "assign",
      item: "model:anthropic/claude-sonnet",
      category: "Work",
    })
    const moveSelect = fixture.fake.selectInputs[0]
    expect(moveSelect.options[0].title).toContain("home")
    expect(moveSelect.options.some((opt) => opt.value === "Work")).toBe(true)
  } finally {
    fixture.destroy()
  }
})

test("content d on model inside user category removes model, does not delete category", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    categories: [
      {
        type: "category",
        level: "global",
        name: "Work",
        order: 1,
        items: ["model:anthropic/claude-sonnet"],
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
    records: [
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "openai",
        modelID: "gpt-4o",
        active: true,
        updated: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "anthropic",
        modelID: "claude-sonnet",
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { confirms: [true] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:project:Implementer", "Implementer")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Work")
    // Navigate to the model row (down from header)
    dispatch(fixture, "down")
    await until(fixture, (frame) => selectedRow(frame).includes("claude-sonnet"))
    expect(dispatch(fixture, "d")).toBe(true)
    await until(fixture, () => fixture.fake.dialogConfirms.length === 1)
    const confirmInput = fixture.fake.dialogConfirms[0][0] as { title?: string; message?: string }
    expect(confirmInput.title).toContain("Remove")
    expect(confirmInput.title).not.toContain("Delete category")
    await until(fixture, () => fixture.fake.modelRemoves.length === 1)
    expect(fixture.fake.modelRemoves[0]).toEqual({
      level: "project",
      agent: "Implementer",
      providerID: "anthropic",
      modelID: "claude-sonnet",
    })
    expect(fixture.fake.categoryMutates.some((m) => m.action === "delete")).toBe(false)
    await until(fixture, (frame) => frame.includes('Removed "anthropic/claude-sonnet"') && breadcrumb(frame).includes("Work"))
  } finally {
    fixture.destroy()
  }
})

test("effective d inside user category retains original refusal and does not delete category", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    categories: [
      {
        type: "category",
        level: "global",
        name: "Work",
        order: 1,
        items: ["model:openai/gpt-4o"],
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
    records: [
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "openai",
        modelID: "gpt-4o",
        active: true,
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:project:Implementer", "Implementer")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Work")
    // Move down to the active model row
    dispatch(fixture, "down")
    await until(fixture, (frame) => selectedRow(frame).includes("gpt-4o"))
    expect(dispatch(fixture, "d")).toBe(true)
    await sleep(200)
    expect(fixture.fake.dialogConfirms.length).toBe(0)
    expect(fixture.fake.categoryMutates.length).toBe(0)
    await until(fixture, (frame) => frame.includes("active model here"))
  } finally {
    fixture.destroy()
  }
})

test("sidebar d deletes owner agent, not selected user category", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer"), projectAgent("Helper")],
    categories: [
      {
        type: "category",
        level: "global",
        name: "Work",
        order: 1,
        items: [],
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { confirms: [true] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:project:Implementer", "Implementer")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Work")
    await toSidebar(fixture)
    await until(fixture, (frame) => footer(frame).includes("tab list") || footer(frame).includes("esc close"))
    expect(dispatch(fixture, "d")).toBe(true)
    await until(fixture, () => fixture.fake.dialogConfirms.length === 1)
    const confirmInput = fixture.fake.dialogConfirms[0][0] as { title?: string }
    expect(confirmInput.title).toContain("Implementer")
    expect(confirmInput.title).not.toContain("Work")
    await until(fixture, () => fixture.fake.agentDeletes.length === 1)
    expect(fixture.fake.agentDeletes[0]).toEqual({ scope: "project", id: "Implementer" })
    expect(fixture.fake.categoryMutates.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("explicit category header d cancel makes no change; confirm deletes category", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    categories: [
      {
        type: "category",
        level: "global",
        name: "Work",
        order: 1,
        items: ["model:openai/gpt-4o"],
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
    records: [
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "openai",
        modelID: "gpt-4o",
        active: true,
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixtureCancel = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { confirms: [false] },
  })
  try {
    await fixtureCancel.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixtureCancel, "agent:project:Implementer", "Implementer")
    dispatch(fixtureCancel, "right")
    await fixtureCancel.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixtureCancel, "Work")
    await until(fixtureCancel, (frame) => selectedRow(frame).includes("Work"))
    expect(dispatch(fixtureCancel, "d")).toBe(true)
    await until(fixtureCancel, () => fixtureCancel.fake.dialogConfirms.length === 1)
    const confirmInput = fixtureCancel.fake.dialogConfirms[0][0] as { title?: string }
    expect(confirmInput.title).toContain('Delete category "Work"?')
    expect(fixtureCancel.fake.categoryMutates.length).toBe(0)
    await until(fixtureCancel, (frame) => frame.includes("cancelled"))
  } finally {
    fixtureCancel.destroy()
  }

  const fixtureConfirm = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { confirms: [true] },
  })
  try {
    await fixtureConfirm.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixtureConfirm, "agent:project:Implementer", "Implementer")
    dispatch(fixtureConfirm, "right")
    await fixtureConfirm.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixtureConfirm, "Work")
    await until(fixtureConfirm, (frame) => selectedRow(frame).includes("Work"))
    expect(dispatch(fixtureConfirm, "d")).toBe(true)
    await until(fixtureConfirm, () => fixtureConfirm.fake.dialogConfirms.length === 1)
    await until(fixtureConfirm, () => fixtureConfirm.fake.categoryMutates.length === 1)
    expect(fixtureConfirm.fake.categoryMutates[0]).toEqual({
      action: "delete",
      name: "Work",
      confirm: true,
    })
  } finally {
    fixtureConfirm.destroy()
  }
})

test("key bindings have explicit shift+r rename and lowercase r reset without bare R collision", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    records: [
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "openai",
        modelID: "gpt-4o",
        active: true,
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    const activeBinds = binds(fixture)
    expect(activeBinds.includes("shift+r")).toBe(true)
    expect(activeBinds.includes("R")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("filter category:<name> reaches user category and focuses list header", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    categories: [
      {
        type: "category",
        level: "global",
        name: "Work",
        order: 1,
        items: ["model:openai/gpt-4o"],
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
    records: [
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "openai",
        modelID: "gpt-4o",
        active: true,
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await toSidebar(fixture)
    expect(dispatch(fixture, "/")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
    await sleep(20)
    await fixture.typeText("category:Work")
    await sleep(250)
    await until(fixture, (frame) => frame.includes("esc clear filter") && selectedRow(frame).includes("gpt-4o"))
    dispatch(fixture, "return")
    await until(fixture, (frame) => !frame.includes("esc clear filter") && breadcrumb(frame).includes("Work"))
    expect(footer(fixture.captureCharFrame())).toContain("esc sidebar")
  } finally {
    fixture.destroy()
  }
})
