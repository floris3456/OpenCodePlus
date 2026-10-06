import { expect, test } from "bun:test"
import { isClaude, parseCodexCatalogue, parseDetails, parsePlainList } from "../src/catalog.js"

// What a CPA without the details catalogue answers to /v1/models (and to ?details=true).
const plain = {
  object: "list",
  data: [
    { id: "gpt-5.5", object: "model", created: 1, owned_by: "OpenAI" },
    { id: "claude-opus-4-7", object: "model", created: 1, owned_by: "anthropic" },
    { id: "gpt-image-2", object: "model", created: 1, owned_by: "openai" },
    { id: "kimi-k3", object: "model" },
  ],
}

test("the plain model list gives every model with IDs and owners only", () => {
  const catalogue = parsePlainList(plain, "hash")
  expect(catalogue?.source).toBe("plain")
  expect(catalogue?.hash).toBe("hash")
  expect(catalogue?.models.map((model) => [model.id, model.kind, model.ownedBy])).toEqual([
    ["gpt-5.5", "chat", "openai"],
    ["claude-opus-4-7", "chat", "anthropic"],
    ["gpt-image-2", "image", "openai"],
    ["kimi-k3", "chat", undefined],
  ])
  const chat = catalogue?.models[0]
  // No levels, limits or modalities are invented.
  expect(chat).toEqual({
    id: "gpt-5.5",
    name: "gpt-5.5",
    kind: "chat",
    ownedBy: "openai",
    input: ["text"],
    outputModalities: ["text"],
    reasoning: { mode: "passthrough", levels: [] },
    tiers: [],
  })
  expect(catalogue?.models[2]?.outputModalities).toEqual(["image"])
  expect(catalogue?.models[2]?.reasoning.mode).toBe("none")
  expect(isClaude(catalogue!.models[1]!)).toBe(true)
})

test("the plain list is never mistaken for the richer catalogues, and an empty list is no catalogue", () => {
  expect(parseDetails(plain)).toBeUndefined()
  expect(parseCodexCatalogue(plain, "hash")).toBeUndefined()
  expect(parsePlainList({ object: "list", data: [] }, "hash")).toBeUndefined()
  expect(parsePlainList({ models: [{ slug: "gpt-5.5" }] }, "hash")).toBeUndefined()
  expect(parsePlainList("<html>", "hash")).toBeUndefined()
})
