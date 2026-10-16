import { expect, test } from "bun:test"
import { CliRenderEvents, InputRenderable } from "@opentui/core"
import { once } from "node:events"
import { DialogVariant } from "../../src/component/dialog-variant"
import { agent, model, renderLocal } from "../fixture/local"

test("variant picker can explicitly reset an agent variant", async () => {
  await using setup = await renderLocal({
    models: [model("first", ["low", "high"])],
    agents: [agent("build", { providerID: "provider", id: "first", variant: "high" })],
  })
  expect(setup.local.model.variant.current()).toBe("high")
  setup.dialog.replace(() => <DialogVariant />)
  await setup.waitForFrame((frame) => frame.includes("Select variant") && frame.includes("Default"))
  // The dialog paints before its deferred filter focus is ready for typing.
  if (!(setup.renderer.currentFocusedRenderable instanceof InputRenderable))
    await once(setup.renderer, CliRenderEvents.FOCUSED_RENDERABLE)
  expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(InputRenderable)
  await setup.mockInput.typeText("Default")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.dialog.stack.length === 0)
  expect(setup.local.model.variant.current()).toBeUndefined()
})

test("selecting a variant completes exactly one pick with the chosen variant", async () => {
  await using setup = await renderLocal({
    models: [model("first", ["low", "high"])],
    agents: [agent("build", { providerID: "provider", id: "first", variant: "high" })],
  })
  const picks: unknown[] = []
  setup.local.model.onPick((pick) => picks.push(pick))
  setup.dialog.replace(() => <DialogVariant />)
  await setup.waitForFrame((frame) => frame.includes("Select variant"))
  // The dialog paints before its deferred filter focus is ready for typing.
  if (!(setup.renderer.currentFocusedRenderable instanceof InputRenderable))
    await once(setup.renderer, CliRenderEvents.FOCUSED_RENDERABLE)
  await setup.mockInput.typeText("low")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.dialog.stack.length === 0)
  expect(setup.local.model.variant.current()).toBe("low")
  expect(picks).toEqual([
    { agent: "build", providerID: "provider", modelID: "first", variant: "low", location: undefined },
  ])
})

test("closing the variant dialog without a selection still emits one pick", async () => {
  await using setup = await renderLocal({
    models: [model("first", ["low", "high"])],
    agents: [agent("build", { providerID: "provider", id: "first", variant: "high" })],
  })
  const picks: unknown[] = []
  setup.local.model.onPick((pick) => picks.push(pick))
  setup.dialog.replace(() => <DialogVariant />)
  await setup.waitForFrame((frame) => frame.includes("Select variant"))
  setup.mockInput.pressEscape()
  await setup.waitFor(() => setup.dialog.stack.length === 0)
  // The model was set before the dialog opened; Escape keeps the variant it had.
  expect(picks).toEqual([
    { agent: "build", providerID: "provider", modelID: "first", variant: "high", location: undefined },
  ])
})
