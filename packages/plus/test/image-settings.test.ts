// Instructions › a model › Images: what each choice asks of core, how a value is checked, and how a chat's model
// resolves it.
import { expect, test } from "bun:test"
import type { SessionImage } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { chooseImage, imageFieldOf, imageWord, visualTokensFor } from "../src/image-settings.js"
import { chooseImageFor, createState } from "../src/index.js"
import { compactionFieldsOf, effectiveImages, imageFieldChoices, type ModelSettingsRecord } from "../src/instructions/model-settings.js"
import { fullContext } from "./harness.js"

/** An image arriving with core's default limits. */
const arriving = (): SessionImage => ({
  sessionID: Session.ID.make("ses_images"),
  resource: "screenshot.png",
  maxWidth: 2_000,
  maxHeight: 2_000,
  maxVisualTokens: 4_784,
  format: "webp",
  quality: 90,
})

const chosen = (choice: { imageConvert?: string; imageShrink?: string }) => {
  const event = arriving()
  chooseImage(event, choice)
  return event
}

const settings = (fields: Partial<ModelSettingsRecord>): ModelSettingsRecord => ({ type: "modelSettings", level: "defaults", updated: "2026-10-18", ...fields })

test("a field no row sets leaves core's own configuration as it is", () => {
  expect(chosen({})).toEqual(arriving())
})

test("each conversion asks core for its encoding", () => {
  expect(chosen({ imageConvert: "webp-90" })).toMatchObject({ format: "webp", quality: 90 })
  expect(chosen({ imageConvert: "webp-75" })).toMatchObject({ format: "webp", quality: 75 })
  expect(chosen({ imageConvert: "webp-lossless" })).toMatchObject({ format: "webp-lossless" })
  expect(chosen({ imageConvert: "original" })).toMatchObject({ format: "original" })
})

test("a size sets the edges and the image-token budget that goes with it, larger ones too", () => {
  expect(chosen({ imageShrink: "2000" })).toMatchObject({ maxWidth: 2_000, maxHeight: 2_000, maxVisualTokens: 4_784 })
  expect(chosen({ imageShrink: "1568" })).toMatchObject({ maxWidth: 1_568, maxHeight: 1_568, maxVisualTokens: 1_600 })
  expect(chosen({ imageShrink: "1000" })).toMatchObject({ maxWidth: 1_000, maxVisualTokens: 1_296 })
  // A custom size for a self-hosted model may go past what core does on its own.
  expect(chosen({ imageShrink: "4096" })).toMatchObject({ maxWidth: 4_096, maxHeight: 4_096, maxVisualTokens: visualTokensFor(4_096) })
  // 1,000 px is about a quarter of the image tokens of 2,000 px, as its description says (a 1920x1080 screenshot:
  // 69 x 39 blocks at full size, 36 x 21 at 1,000 px).
  expect((36 * 21) / (69 * 39)).toBeCloseTo(0.28, 2)
})

test("a value is checked when it is set: choices only, sizes in pixels", () => {
  expect(imageFieldOf("imageConvert", "WebP-75")).toBe("webp-75")
  expect(imageFieldOf("imageConvert", "avif")).toEqual({ error: expect.stringContaining("webp-90, webp-75, webp-lossless, original") })
  expect(imageFieldOf("imageShrink", "2,576 px")).toBe("2576")
  expect(imageFieldOf("imageShrink", "100")).toEqual({ error: expect.stringContaining("256 to 65535") })
  expect(imageFieldOf("imagesFull", "error")).toBe("error")
  expect(imageFieldOf("imagesFull", "")).toBeNull()
  expect(compactionFieldsOf({ imageShrink: "3000", imagesFull: "leave-out" })).toEqual({ fields: { imageShrink: "3000", imagesFull: "leave-out" } })
  expect(compactionFieldsOf({ imagesFull: "delete" })).toMatchObject({ error: expect.stringContaining("When image context is full") })
})

test("each field resolves the agent's row, then this model, then Every model, then the built-in value", () => {
  expect(effectiveImages({})).toEqual({
    imageConvert: { value: "webp-90", from: "built-in" },
    imageShrink: { value: "2000", from: "built-in" },
    imagesFull: { value: "compact", from: "built-in" },
  })
  const resolved = effectiveImages({
    row: { imageShrink: { value: "1568", level: "project" } },
    model: settings({ providerID: "p", modelID: "m", imageConvert: "webp-lossless", imageShrink: "1000" }),
    every: settings({ imageConvert: "original", imagesFull: "error" }),
  })
  expect(resolved).toEqual({
    imageConvert: { value: "webp-lossless", from: "model" },
    imageShrink: { value: "1568", from: "project" },
    imagesFull: { value: "error", from: "every" },
  })
})

test("the rows show what each value means, and the dropdown offers Inherit, the choices and a custom size", () => {
  expect(imageWord("imageConvert", "webp-90")).toBe("WebP 90")
  expect(imageWord("imageShrink", "2000")).toBe("Max: 2,000 px")
  expect(imageWord("imageShrink", "2576")).toBe("2,576 px (custom)")
  expect(imageWord("imagesFull", "error")).toBe("Stop with an error")
  expect(imageFieldChoices("imageShrink", "Max: 2,000 px · built-in").map((choice) => choice.title)).toEqual([
    "Inherit (now Max: 2,000 px · built-in)",
    "Max: 2,000 px",
    "1,568 px",
    "1,000 px",
    "Custom…",
  ])
  expect(imageFieldChoices("imagesFull", "").map((choice) => choice.value)).toEqual(["", "compact", "leave-out", "error"])
})

test("an arriving image takes the settings of the chat's agent on its model", async () => {
  const session = { id: Session.ID.make("ses_images"), agent: Agent.ID.make("build"), model: { providerID: "proxy", id: "chat-model" } }
  const ctx = fullContext({ directory: "/workspace", session: { get: () => Effect.succeed(session as never) } })
  const state = {
    ...createState(),
    cachedModelSettings: [settings({ imageConvert: "original" }), settings({ providerID: "proxy", modelID: "chat-model", imageShrink: "1000" })],
  }
  const event = arriving()
  await Effect.runPromise(chooseImageFor(ctx, state, event))
  expect(event).toMatchObject({ format: "original", maxWidth: 1_000, maxVisualTokens: 1_296 })
  // A chat that cannot be read leaves the image to core.
  const unknown = arriving()
  const missing = fullContext({ directory: "/workspace", session: { get: () => Effect.die("no session") } })
  await Effect.runPromise(chooseImageFor(missing, state, unknown))
  expect(unknown).toEqual(arriving())
})
