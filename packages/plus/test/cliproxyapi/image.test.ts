import { afterEach, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Catalogue } from "../../src/cliproxyapi/catalog.js"
import { chooseImageModel, generateImage, outputPath, type ImageTarget } from "../../src/cliproxyapi/image.js"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const PNG = Buffer.from("89504e470d0a1a0a", "hex")
const catalogue: Catalogue = {
  source: "details",
  hash: "h",
  models: [
    {
      id: "chat",
      name: "Chat",
      kind: "chat",
      input: ["text"],
      outputModalities: ["text"],
      reasoning: { mode: "none", levels: [] },
      tiers: [],
    },
    {
      id: "gpt-image-2",
      name: "GPT Image 2",
      kind: "image",
      input: ["text"],
      outputModalities: ["image"],
      reasoning: { mode: "none", levels: [] },
      tiers: [],
    },
  ],
}

test("model choice and output path stay within the catalogue and the project", () => {
  const target: ImageTarget = { providerID: "cpa", baseURL: "http://x/v1", key: "k", catalogue }
  expect(chooseImageModel([target], undefined)?.model).toBe("gpt-image-2")
  expect(chooseImageModel([target], "chat")).toBeUndefined()
  expect(outputPath("/p", undefined, "A red Square!", new Date("2026-10-03T01:02:03Z"))).toBe(
    "/p/generated-images/20261003T010203-a-red-square.png",
  )
  expect(outputPath("/p", "art/x.png", "x")).toBe("/p/art/x.png")
  expect(outputPath("/p", "../escape.png", "x")).toBeUndefined()
  expect(outputPath("/p", "/etc/x.png", "x")).toBeUndefined()
})

test("generates through CPA's images endpoint with the provider key and saves the PNG", async () => {
  const seen: { auth?: string; body?: Record<string, unknown>; path?: string } = {}
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.auth = request.headers.get("authorization") ?? undefined
      seen.path = new URL(request.url).pathname
      seen.body = (await request.json()) as Record<string, unknown>
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }] })
    },
  })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cpa-image-"))
  cleanups.push(
    () => void server.stop(true),
    () => fs.rm(directory, { recursive: true, force: true }),
  )
  const target: ImageTarget = { providerID: "cpa", baseURL: `${server.url.origin}/v1`, key: "fixture-key", catalogue }
  const result = await Effect.runPromise(
    generateImage({ prompt: "red square", size: "1024x1024", path: "out/red.png" }, directory, () =>
      Effect.succeed([target]),
    ),
  )
  expect(seen).toEqual({
    auth: "Bearer fixture-key",
    path: "/v1/images/generations",
    body: { model: "gpt-image-2", prompt: "red square", n: 1, response_format: "b64_json", size: "1024x1024" },
  })
  expect(await fs.readFile(path.join(directory, "out/red.png"))).toEqual(PNG)
  expect(result.output).toEqual({ path: "out/red.png", model: "gpt-image-2", provider: "cpa", bytes: PNG.length })

  // A non-image model and a path outside the project are refused before any request.
  seen.path = undefined
  const refused = await Effect.runPromiseExit(
    generateImage({ prompt: "x", model: "chat" }, directory, () => Effect.succeed([target])),
  )
  const escaped = await Effect.runPromiseExit(
    generateImage({ prompt: "x", path: "../x.png" }, directory, () => Effect.succeed([target])),
  )
  expect(Exit.isFailure(refused) && Exit.isFailure(escaped)).toBe(true)
  expect(seen.path).toBeUndefined()
})
