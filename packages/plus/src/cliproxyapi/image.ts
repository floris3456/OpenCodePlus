import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import type { Catalogue } from "./catalog.js"

/**
 * CPA serves image models only on /v1/images/generations, never in chat. This
 * tool lets any chat model create an image through them and saves it in the
 * project, so the catalogue's image models are usable from OpenCode.
 */
export const ImageInput = Schema.Struct({
  prompt: Schema.String.annotate({ description: "What the image should show." }),
  model: Schema.optionalKey(
    Schema.String.annotate({ description: "CPA image model, e.g. gpt-image-2. Default: the first one CPA lists." }),
  ),
  size: Schema.optionalKey(
    Schema.String.annotate({ description: "WIDTHxHEIGHT, e.g. 1024x1024. Default: the model's." }),
  ),
  path: Schema.optionalKey(
    Schema.String.annotate({
      description: "Output file inside the project (.png). Default: generated-images/<time>-<prompt>.png.",
    }),
  ),
})
export type ImageInput = typeof ImageInput.Type

const ImageResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ b64_json: Schema.optional(Schema.String), url: Schema.optional(Schema.String) })),
})

export interface ImageTarget {
  readonly providerID: string
  readonly baseURL: string
  readonly key: string
  readonly catalogue: Catalogue
}

/** Picks the model: the requested one if it is an image model in a catalogue, else the first image model. */
export function chooseImageModel(targets: readonly ImageTarget[], requested: string | undefined) {
  for (const target of targets) {
    const images = target.catalogue.models.filter((model) => model.kind === "image")
    const model = requested ? images.find((item) => item.id === requested) : images[0]
    if (model) return { target, model: model.id }
  }
  return undefined
}

/** Resolves the output path inside the project directory; refuses paths that leave it. */
export function outputPath(directory: string, requested: string | undefined, prompt: string, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image"
  const target = path.resolve(directory, requested ?? path.join("generated-images", `${stamp}-${slug}.png`))
  const root = path.resolve(directory)
  if (target !== root && !target.startsWith(root + path.sep)) return undefined
  return target
}

export function generateImage(
  input: ImageInput,
  directory: string,
  targets: () => Effect.Effect<readonly ImageTarget[]>,
): Effect.Effect<Tool.Result, Tool.Error> {
  return Effect.gen(function* () {
    const choice = chooseImageModel(yield* targets(), input.model)
    if (!choice)
      return yield* Effect.fail(
        new Tool.Error({
          message: input.model
            ? `${input.model} is not an image model in the CLIProxyAPI catalogue`
            : "CLIProxyAPI lists no image models",
        }),
      )
    const file = outputPath(directory, input.path, input.prompt)
    if (!file) return yield* Effect.fail(new Tool.Error({ message: "path must stay inside the project directory" }))
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${choice.target.baseURL}/images/generations`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${choice.target.key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model: choice.model,
            prompt: input.prompt,
            n: 1,
            response_format: "b64_json",
            ...(input.size ? { size: input.size } : {}),
          }),
          signal: AbortSignal.timeout(300_000),
          redirect: "error",
        })
        const text = await response.text()
        if (!response.ok) throw new Error(`CPA image generation HTTP ${response.status}: ${text.slice(0, 300)}`)
        const image = Schema.decodeUnknownSync(Schema.fromJsonString(ImageResponse))(text).data[0]
        if (image?.b64_json) return Buffer.from(image.b64_json, "base64")
        if (image?.url) {
          const download = await fetch(image.url, { signal: AbortSignal.timeout(60_000) })
          if (!download.ok) throw new Error(`image download HTTP ${download.status}`)
          return Buffer.from(await download.arrayBuffer())
        }
        throw new Error("CPA returned no image")
      },
      catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
    })
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, bytes)
      },
      catch: (error) => new Tool.Error({ message: `could not save the image: ${String(error)}` }),
    })
    const relative = path.relative(directory, file)
    return {
      output: { path: relative, model: choice.model, provider: choice.target.providerID, bytes: bytes.length },
      content: [
        { type: "text" as const, text: `Saved ${relative} (${choice.model}, ${bytes.length} bytes).` },
        { type: "file" as const, uri: `file://${file}`, mime: "image/png", name: path.basename(file) },
      ],
    }
  })
}

export function imageToolRegistration(ctx: Context, targets: () => Effect.Effect<readonly ImageTarget[]>) {
  return ctx.tool.transform((editor) => {
    editor.namespace({ name: "image", description: "Create images with CLIProxyAPI image models." })
    editor.add({
      name: "generate",
      description:
        "Create an image with a CLIProxyAPI image model (gpt-image-…) and save it as a PNG in the project. Returns the saved path.",
      input: ImageInput,
      output: Schema.Unknown,
      options: { namespace: "image", permission: "image" },
      origin: { type: "plugin", name: "opencode.plus.cliproxyapi" },
      execute: (input) => generateImage(input, ctx.location.directory, targets),
    })
  })
}
