import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Customization } from "../src/instructions/model.js"
import { load, save } from "../src/instructions/store.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-store-"))
  roots.push(root)
  return root
}

function recordsPath(directory: string): string {
  return path.join(directory, ".opencodeplus", "instructions", "records.jsonl")
}

async function rawLines(directory: string): Promise<string[]> {
  const text = await Bun.file(recordsPath(directory)).text()
  return text.split("\n").filter((line) => line.length > 0)
}

function makeCustomization(overrides?: Partial<Customization>): Customization {
  return {
    item: "item-1",
    agent: "*",
    state: "inherit",
    basedOn: "fingerprint-1",
    updated: UPDATED,
    ...overrides,
  }
}

test("load returns an empty snapshot when the file is absent", async () => {
  const directory = await tempDir()
  expect(await load(directory)).toEqual({ revision: 0, customizations: [] })
})

test("save then load round-trips customizations", async () => {
  const directory = await tempDir()
  const customizations = [
    makeCustomization({ item: "item-1", agent: "*" }),
    makeCustomization({ agent: "alpha", text: "custom", state: "enabled", reviewed: "fingerprint-0" }),
    makeCustomization({ item: "item-2", agent: "beta", state: "disabled" }),
  ]
  expect(await save(directory, { expectedRevision: 0, customizations })).toEqual({ ok: true, revision: 1 })
  expect(await load(directory)).toEqual({ revision: 1, customizations })
})

test("no-op save keeps the revision and leaves the file untouched", async () => {
  const directory = await tempDir()
  const customizations = [
    makeCustomization({ item: "item-1", agent: "*" }),
    makeCustomization({ item: "item-2", agent: "beta", state: "disabled" }),
  ]
  expect(await save(directory, { expectedRevision: 0, customizations })).toEqual({ ok: true, revision: 1 })
  const before = await Bun.file(recordsPath(directory)).text()
  const reordered = [...customizations].reverse()
  expect(await save(directory, { expectedRevision: 1, customizations: reordered })).toEqual({ ok: true, revision: 1 })
  expect(await Bun.file(recordsPath(directory)).text()).toBe(before)
  expect(await load(directory)).toEqual({ revision: 1, customizations })
})

test("empty save on an empty store is a no-op at revision zero", async () => {
  const directory = await tempDir()
  expect(await save(directory, { expectedRevision: 0, customizations: [] })).toEqual({ ok: true, revision: 0 })
  expect(await load(directory)).toEqual({ revision: 0, customizations: [] })
})

test("stale save is rejected without changing stored content", async () => {
  const directory = await tempDir()
  const first = [makeCustomization({ item: "item-1", agent: "*", text: "first" })]
  expect(await save(directory, { expectedRevision: 0, customizations: first })).toEqual({ ok: true, revision: 1 })
  const before = await Bun.file(recordsPath(directory)).text()

  const second = [makeCustomization({ item: "item-1", agent: "*", text: "second" })]
  const rejected = await save(directory, { expectedRevision: 0, customizations: second })
  expect(rejected).toEqual({ ok: false, reason: "stale", current: { revision: 1, customizations: first } })
  expect(await Bun.file(recordsPath(directory)).text()).toBe(before)
  expect(await load(directory)).toEqual({ revision: 1, customizations: first })
})

test("concurrent saves are serialized into a consistent file", async () => {
  const directory = await tempDir()
  const first = [makeCustomization({ item: "item-1", agent: "*", text: "first" })]
  const second = [makeCustomization({ item: "item-2", agent: "alpha", text: "second" })]
  const [one, two] = await Promise.all([
    save(directory, { expectedRevision: 0, customizations: first }),
    save(directory, { expectedRevision: 0, customizations: second }),
  ])
  expect(one.ok || two.ok).toBe(true)
  expect(one.ok && two.ok).toBe(false)
  const winner = one.ok ? first : second
  const loser = one.ok ? two : one
  if (!loser.ok) expect(loser.current).toEqual({ revision: 1, customizations: winner })
  expect(await load(directory)).toEqual({ revision: 1, customizations: winner })
  const lines = await rawLines(directory)
  expect(lines.length).toBe(winner.length + 1)
  lines.map((line): unknown => JSON.parse(line))
})

test("load skips malformed lines", async () => {
  const directory = await tempDir()
  const customizations = [makeCustomization({ item: "item-1", agent: "*" })]
  expect(await save(directory, { expectedRevision: 0, customizations })).toEqual({ ok: true, revision: 1 })
  const target = recordsPath(directory)
  const raw = await Bun.file(target).text()
  await Bun.write(target, `${raw}{malformed\n`)
  expect(await load(directory)).toEqual({ revision: 1, customizations })
})
