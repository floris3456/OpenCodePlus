import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const limits = { maxWidth: 2_000, maxHeight: 2_000, maxVisualTokens: 4_784 }
const blocks = (size: { width: number; height: number }) => Math.ceil(size.width / 28) * Math.ceil(size.height / 28)

describe("Image.fitSize", () => {
  test("keeps a screenshot the high-resolution tier reads whole", () => {
    // 69 x 68 = 4,692 blocks: Claude Opus reads this one at full size, so it must arrive at full size.
    expect(Image.fitSize(1_920, 1_890, limits)).toEqual({ width: 1_920, height: 1_890 })
  })

  test("caps the long edge at 2,000 px, which a request with more than 20 images allows", () => {
    expect(Image.fitSize(2_576, 1_449, limits)).toEqual({ width: 2_000, height: 1_125 })
  })

  test("shrinks a square that fits the edges but not the visual-token budget", () => {
    const size = Image.fitSize(2_000, 2_000, limits)
    expect(blocks(size)).toBeLessThanOrEqual(4_784)
    expect(size.width).toBe(size.height)
    expect(size.width).toBeGreaterThan(1_900)
  })
})

/** A 1200x900 rendering-like picture: smooth gradients with a little noise, which PNG stores poorly. */
const rendering = (format: "png" | "jpeg") =>
  Effect.promise(async () => {
    const photon = await import("@silvia-odwyer/photon-node")
    const width = 1_200
    const height = 900
    const seed = { value: 7 }
    const noise = () => {
      seed.value = (seed.value * 1_103_515_245 + 12_345) % 2 ** 31
      return seed.value % 24
    }
    const pixels = Uint8Array.from({ length: width * height * 4 }, (_, index) => {
      const channel = index % 4
      if (channel === 3) return 255
      const pixel = Math.floor(index / 4)
      const x = pixel % width
      const y = Math.floor(pixel / width)
      return Math.min(255, Math.floor(((x + y * (channel + 1)) / (width + height * 3)) * 230) + noise())
    })
    const image = new photon.PhotonImage(pixels, width, height)
    const bytes = format === "png" ? image.get_bytes() : image.get_bytes_jpeg(95)
    image.free()
    return {
      uri: `file:///render.${format}`,
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64" as const,
      mime: `image/${format}`,
    }
  })

describe("Image.normalize", () => {
  const it = testEffect(AppNodeBuilder.build(Image.node))

  it.effect("stores a large PNG as a WebP at the same size, the same way every time", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const png = yield* rendering("png")
      expect(png.content.length).toBeGreaterThan(512 * 1024)
      const stored = yield* image.normalize("render.png", png)
      expect(stored.mime).toBe("image/webp")
      expect(stored.content.length).toBeLessThanOrEqual(png.content.length * 0.75)
      const metadata = yield* Effect.promise(() => new Bun.Image(Buffer.from(stored.content, "base64")).metadata())
      expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 1_200, height: 900 })
      // Same image in, same bytes out: an image stored once never changes the chat afterwards.
      expect(yield* image.normalize("render.png", png)).toEqual(stored)
    }),
  )

  it.effect("leaves a small PNG and a JPEG as they are", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const pixel = {
        uri: "file:///pixel.png",
        content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        encoding: "base64" as const,
        mime: "image/png",
      }
      expect(yield* image.normalize("pixel.png", pixel)).toEqual(pixel)
      // A JPEG is already lossy; a second lossy pass would only add artifacts.
      const jpeg = yield* rendering("jpeg")
      expect(jpeg.content.length).toBeGreaterThan(512 * 1024)
      expect(yield* image.normalize("render.jpeg", jpeg)).toEqual(jpeg)
    }),
  )
})
