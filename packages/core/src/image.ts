export * as Image from "./image.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { FileSystem } from "./filesystem.js"
import { State } from "./state.js"

export class ResizerUnavailableError extends Schema.TaggedError<ResizerUnavailableError>()(
  "Image.ResizerUnavailableError",
  {},
) {}

export class DecodeError extends Schema.TaggedError<DecodeError>()("Image.DecodeError", {
  resource: Schema.String,
}) {
  override get message() {
    return `Image could not be decoded: ${this.resource}`
  }
}

export class SizeError extends Schema.TaggedError<SizeError>()("Image.SizeError", {
  resource: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
  maxWidth: Schema.Number,
  maxHeight: Schema.Number,
  maxBytes: Schema.Number,
}) {
  override get message() {
    return `Image ${this.resource} is ${this.width}x${this.height} with base64 size ${this.bytes}, exceeding configured limits ${this.maxWidth}x${this.maxHeight}/${this.maxBytes} bytes`
  }
}

export type Limits = {
  autoResize: boolean
  maxWidth: number
  maxHeight: number
  maxBase64Bytes: number
  /** Claude reads images in 28x28-pixel blocks and downsizes beyond this many (its high-resolution tier). */
  maxVisualTokens: number
}

/**
 * The largest size, at the image's aspect ratio, within the edge limits and the visual-token budget. The edge
 * limit of 2,000 px is also what a request with more than 20 images allows each of them.
 */
export const fitSize = (
  width: number,
  height: number,
  limits: Pick<Limits, "maxWidth" | "maxHeight" | "maxVisualTokens">,
) => {
  const sized = (scale: number) => ({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  })
  const fits = (scale: number) => {
    const size = sized(scale)
    return Math.ceil(size.width / 28) * Math.ceil(size.height / 28) <= limits.maxVisualTokens
  }
  const edge = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
  if (fits(edge)) return sized(edge)
  // Start from the area the budget covers, then step down until the rounded-up blocks fit.
  const start = Math.min(edge, Math.sqrt((limits.maxVisualTokens * 28 * 28) / (width * height)))
  const steps = Array.from({ length: 400 }, (_, index) => start * (1 - index * 0.0025))
  return sized(steps.find(fits) ?? steps.at(-1)!)
}

// A large PNG is stored as WebP when that saves at least a quarter. It happens once, when the image arrives, and
// the same bytes always give the same result, so a stored image never changes and the prompt cache holds.
const COMPACT_FROM_BASE64_BYTES = 512 * 1024
const COMPACT_QUALITY = 90
const COMPACT_KEEPS_AT_MOST = 0.75

export type Editor = {
  configure: (limits: Partial<Limits>) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly normalize: (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
  ) => Effect.Effect<
    FileSystem.Content & { readonly encoding: "base64" },
    ResizerUnavailableError | DecodeError | SizeError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Limits, Editor>({
      name: "image",
      initial: () => ({
        autoResize: true,
        maxWidth: 2_000,
        maxHeight: 2_000,
        maxBase64Bytes: 5 * 1024 * 1024,
        maxVisualTokens: 4_784,
      }),
      editor: (editor) => ({
        configure: (limits) => {
          if (limits.autoResize !== undefined) editor.autoResize = limits.autoResize
          if (limits.maxWidth !== undefined) editor.maxWidth = limits.maxWidth
          if (limits.maxHeight !== undefined) editor.maxHeight = limits.maxHeight
          if (limits.maxBase64Bytes !== undefined) editor.maxBase64Bytes = limits.maxBase64Bytes
          if (limits.maxVisualTokens !== undefined) editor.maxVisualTokens = limits.maxVisualTokens
        },
      }),
    })
    const loadAdapter = yield* Effect.cached(
      Effect.tryPromise({
        try: () => import("./image/photon.js"),
        catch: () => new ResizerUnavailableError(),
      }).pipe(Effect.flatMap((adapter) => adapter.make)),
    )
    const normalize = Effect.fn("Image.normalize")(function* (
      resource: string,
      content: FileSystem.Content & { readonly encoding: "base64" },
    ) {
      const normalize = yield* loadAdapter
      return yield* compact(yield* normalize(resource, content, state.get()))
    })
    return Service.of({ transform: state.transform, reload: state.reload, normalize })
  }),
)

/** Bun's encoder writes the WebP; elsewhere the image stays as the adapter left it. */
const compact = (content: FileSystem.Content & { readonly encoding: "base64" }) => {
  if (content.mime !== "image/png" || content.content.length < COMPACT_FROM_BASE64_BYTES) return Effect.succeed(content)
  if (typeof Bun === "undefined" || typeof Bun.Image !== "function") return Effect.succeed(content)
  return Effect.tryPromise(() =>
    new Bun.Image(Buffer.from(content.content, "base64")).webp({ quality: COMPACT_QUALITY }).bytes(),
  ).pipe(
    Effect.map((encoded) => {
      const base64 = Buffer.from(encoded).toString("base64")
      if (base64.length > content.content.length * COMPACT_KEEPS_AT_MOST) return content
      return { ...content, content: base64, mime: "image/webp" }
    }),
    Effect.orElseSucceed(() => content),
  )
}

export const node = makeLocationNode({ service: Service, layer, deps: [] })
