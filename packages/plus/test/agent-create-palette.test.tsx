import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { createAgentActions } from "../src/tui/agents/create.js"
import { createSnapshot, renderPlusFixture } from "./tui.js"

// DESIGN §5: the palette "Create agent" is the tree's flow plus a
// Project/Global choice (it has no cursor): name → scope → preset → done. No
// template, prompt, model or mode step.
async function palette(dialogs: { prompts: string[]; selects: string[] }) {
  let actions: ReturnType<typeof createAgentActions> | undefined
  const fixture = await renderPlusFixture({
    snapshots: [createSnapshot()],
    dialogs,
    render: (context) => {
      actions = createAgentActions(context)
      return createComponent(() => <text>palette</text>, {})
    },
  })
  await actions?.createAgent()
  return fixture
}

test("palette Create agent asks name, then Project/Global, then a preset, and creates", async () => {
  const fixture = await palette({ prompts: ["helper"], selects: ["global", "agent:orchestrator"] })
  try {
    expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Create agent"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Agent scope", "Preset"])
    expect(fixture.fake.selectInputs[0]?.options.map((option) => option.value)).toEqual(["project", "global"])
    expect(fixture.fake.selectInputs[1]?.options.at(-1)).toEqual({ title: "None — everything off", value: "__none__" })
    expect(fixture.fake.agentCreates).toEqual([{ scope: "global", id: "helper", preset: { kind: "agent", id: "orchestrator" } }])
    expect(fixture.fake.toasts).toContainEqual({ variant: "success", message: "Created agent helper at /agents/helper.md" })
  } finally {
    fixture.destroy()
  }
})

test("palette Create agent with None creates an unlinked agent", async () => {
  const fixture = await palette({ prompts: ["bare"], selects: ["project", "__none__"] })
  try {
    expect(fixture.fake.agentCreates).toEqual([{ scope: "project", id: "bare" }])
    expect(fixture.fake.dialogPrompts.length).toBe(1)
    expect(fixture.fake.dialogSelects.length).toBe(2)
  } finally {
    fixture.destroy()
  }
})
