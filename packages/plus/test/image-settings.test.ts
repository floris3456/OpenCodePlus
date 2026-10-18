// Settings › Images: what each choice asks of core, and how the choice is stored.
import { expect, test } from "bun:test"
import type { SessionImage } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chooseImage, IMAGE_FORMATS, IMAGE_SIZES, IMAGES_FULL } from "../src/image-settings.js"
import { createPlusSettings } from "../src/plus-settings.js"
import { ImageFormat, ImagesFull, ImageSize } from "../src/rpc.js"

/** An image arriving with core's default limits, or the ones given. */
const arriving = (limits: Partial<SessionImage> = {}): SessionImage => ({
  sessionID: Session.ID.make("ses_images"),
  resource: "screenshot.png",
  maxWidth: 2_000,
  maxHeight: 2_000,
  maxVisualTokens: 4_784,
  format: "webp",
  quality: 90,
  ...limits,
})

const chosen = (imageFormat: (typeof ImageFormat.literals)[number], imageSize: (typeof ImageSize.literals)[number], limits?: Partial<SessionImage>) => {
  const event = arriving(limits)
  chooseImage(event, { imageFormat, imageSize })
  return event
}

test("the defaults leave core's own configuration as it is", () => {
  expect(chosen("webp", "full")).toEqual(arriving())
  // Configured elsewhere to something else: still left alone.
  expect(chosen("webp", "full", { maxWidth: 1_200, quality: 80 })).toEqual(arriving({ maxWidth: 1_200, quality: 80 }))
})

test("each format asks core for its encoding", () => {
  expect(chosen("webp-small", "full")).toMatchObject({ format: "webp", quality: 75 })
  expect(chosen("webp-lossless", "full")).toMatchObject({ format: "webp-lossless" })
  expect(chosen("original", "full")).toMatchObject({ format: "original" })
})

test("a smaller size only ever lowers the limits", () => {
  expect(chosen("webp", "medium")).toMatchObject({ maxWidth: 1_568, maxHeight: 1_568, maxVisualTokens: 1_600 })
  expect(chosen("webp", "small")).toMatchObject({ maxWidth: 1_092, maxHeight: 1_092, maxVisualTokens: 800 })
  expect(chosen("webp", "medium", { maxWidth: 1_000, maxVisualTokens: 900 })).toMatchObject({
    maxWidth: 1_000,
    maxHeight: 1_568,
    maxVisualTokens: 900,
  })
})

test("every stored value has a choice in Settings, and every choice is a stored value", () => {
  expect(IMAGE_FORMATS.map((choice) => choice.value)).toEqual([...ImageFormat.literals])
  expect(IMAGE_SIZES.map((choice) => choice.value)).toEqual([...ImageSize.literals])
  expect(IMAGES_FULL.map((choice) => choice.value)).toEqual([...ImagesFull.literals])
})

test("the choices are kept in the settings file, and a value the file cannot hold falls back to the default", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plus-image-settings-"))
  try {
    const file = path.join(dir, "settings.json")
    expect(await createPlusSettings(file).read()).toMatchObject({ imageFormat: "webp", imageSize: "full", imagesFull: "compact" })
    await createPlusSettings(file).update({ imageFormat: "webp-lossless", imageSize: "small", imagesFull: "leave-out" })
    expect(await createPlusSettings(file).read()).toMatchObject({ imageFormat: "webp-lossless", imageSize: "small", imagesFull: "leave-out" })
    await Bun.write(file, JSON.stringify({ imageFormat: "avif", imageSize: 3, imagesFull: "delete" }))
    expect(await createPlusSettings(file).read()).toMatchObject({ imageFormat: "webp", imageSize: "full", imagesFull: "compact" })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
