import { expect, test } from "bun:test"
import { DialogModel } from "../../src/component/dialog-model"
import { agent, model, renderLocal } from "../fixture/local"

// DialogModel only emits on the paths that do not open the variant dialog:
// the model has no variants, or its remembered variant is still valid.

test("picking a model with no variants emits one pick", async () => {
  await using setup = await renderLocal({
    models: [model("first")],
    agents: [agent("build")],
  })
  const picks: unknown[] = []
  setup.local.model.onPick((pick) => picks.push(pick))
  setup.dialog.replace(() => <DialogModel />)
  await setup.waitForFrame((frame) => frame.includes("Select model"))
  await setup.mockInput.typeText("first")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.dialog.stack.length === 0)
  expect(setup.local.model.current()).toMatchObject({ providerID: "provider", modelID: "first" })
  expect(picks).toEqual([
    { agent: "build", providerID: "provider", modelID: "first", location: undefined },
  ])
})

test("a remembered valid variant emits one pick with that variant and opens no dialog", async () => {
  await using setup = await renderLocal({
    models: [model("first", ["low", "high"])],
    agents: [agent("build", { providerID: "provider", id: "first", variant: "high" })],
  })
  expect(setup.local.model.variant.current()).toBe("high")
  const picks: unknown[] = []
  setup.local.model.onPick((pick) => picks.push(pick))
  setup.dialog.replace(() => <DialogModel />)
  await setup.waitForFrame((frame) => frame.includes("Select model"))
  await setup.mockInput.typeText("first")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.dialog.stack.length === 0)
  expect(picks).toEqual([
    { agent: "build", providerID: "provider", modelID: "first", variant: "high", location: undefined },
  ])
})
