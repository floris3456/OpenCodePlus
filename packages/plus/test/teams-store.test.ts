import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../src/index.js"
import { load, save, type StoredRecord } from "../src/instructions/store.js"
import { enable } from "../src/project.js"
import { fullContext } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-teams-store-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

function throwingContext(captured: { current?: unknown }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

const TEAM: StoredRecord = { type: "team", level: "project", team: "crew", enabled: true, updated: UPDATED }

test("snapshot excludes team records and a mutate round-trip preserves them without moving revisions", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const seeded = await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: [TEAM] })
  expect(seeded.ok).toBe(true)

  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.records.some((record) => (record as { type: string }).type === "team")).toBe(false)
  expect(snapshot.records).toEqual([])

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [...snapshot.records] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // Unchanged save stays a no-op: preserved teams must not move revisions.
  expect(mutated.revision).toBe(snapshot.revision)
  expect(mutated.globalRevision).toBe(snapshot.globalRevision)

  const stored = await load(project)
  expect(stored.records).toContainEqual(TEAM)
})
