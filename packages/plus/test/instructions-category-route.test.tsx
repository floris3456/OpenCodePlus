// Folders in the Instructions route (plus-1.2.0 S1a): `a` offers a folder next to
// a model, `m` moves a row into a folder of its tab through one layout write, and
// the key bindings keep shift+r for rename. The user category tabs are gone.
import { afterEach, expect, test } from "bun:test"
import { createSnapshot, renderInstructionsRoute, type TestFixture } from "./tui.js"
import { binds, category, dispatch, footer, gotoLevel, levelOf, moveTo, selectedRow, sleep, toSidebar } from "./instructions-nav.js"

const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
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

const UPDATED = "2026-01-01T00:00:00.000Z"

test("a in Models offers Folder and Model; picking Model preserves context without scope prompt", async () => {
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
        updated: UPDATED,
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
      { title: "Folder", value: "folder" },
    ])
  } finally {
    fixture.destroy()
  }
})

test("m moves a model row into a folder of its tab through one layout write", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    folders: [{ type: "folder", level: "global", tab: "models", id: "models:work", name: "Work", items: [], updated: UPDATED }],
    records: [
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "openai",
        modelID: "gpt-4o",
        active: true,
        updated: UPDATED,
      },
      {
        type: "model",
        level: "project",
        agent: "Implementer",
        providerID: "anthropic",
        modelID: "claude-sonnet",
        updated: UPDATED,
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    dialogs: { selects: ["folder:models:work"] },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "agent:project:Implementer", "Implementer")
    dispatch(fixture, "right")
    await fixture.waitForFrame((frame) => footer(frame).includes("esc sidebar"))
    await category(fixture, "Models")
    await moveTo(fixture, "claude-sonnet")
    expect(dispatch(fixture, "m")).toBe(true)
    await until(fixture, () => fixture.fake.layoutWrites.length === 1)
    const write = fixture.fake.layoutWrites[0]
    expect(write?.folders.find((folder) => folder.id === "models:work")?.items).toEqual(["model:anthropic/claude-sonnet"])
    expect(fixture.fake.selectInputs[0].options.map((option) => option.title)).toEqual(["Top level of models", "Work"])
  } finally {
    fixture.destroy()
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
        updated: UPDATED,
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
