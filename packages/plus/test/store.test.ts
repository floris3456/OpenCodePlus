import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { globalRecordsPath, projectRecordsPath } from "../src/instructions/paths.js"
import { load, save, type Record } from "../src/instructions/store.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-store-"))
  roots.push(root)
  return root
}

async function isolated(): Promise<{ project: string }> {
  const root = await tempRoot()
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

function customization(overrides?: Partial<Extract<Record, { type: "customization" }>>): Record {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "tool:bash",
    section: null,
    basedOn: "fingerprint-1",
    updated: UPDATED,
    ...overrides,
  }
}

test("load returns empty when both stores are absent", async () => {
  const { project } = await isolated()
  expect(await load(project)).toEqual({ revision: 0, records: [], migrated: false })
})

test("save then load round-trips project and global records", async () => {
  const { project } = await isolated()
  const records: Record[] = [
    customization({ agent: "alpha", text: "custom" }),
    customization({ level: "defaults", agent: null, item: "system:role", text: "shared" }),
    customization({ level: "global", agent: "beta", item: "skill:x", state: "off" }),
  ]
  expect(await save(project, { expectedRevision: 0, records })).toEqual({ ok: true, revision: 1 })
  const loaded = await load(project)
  expect(loaded.revision).toBe(1)
  expect(loaded.migrated).toBe(false)
  expect([...loaded.records].sort(compareForTest)).toEqual([...records].sort(compareForTest))
})

test("records route into project vs global files", async () => {
  const { project } = await isolated()
  const records: Record[] = [
    customization({ agent: "alpha", text: "p" }),
    customization({ level: "global", agent: "beta", item: "tool:other", text: "g" }),
    customization({ level: "defaults", agent: null, item: "system:role", text: "d" }),
  ]
  await save(project, { expectedRevision: 0, records })
  const projectText = await Bun.file(projectRecordsPath(project)).text()
  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(projectText).toContain(`"level":"project"`)
  expect(projectText).not.toContain(`"level":"global"`)
  expect(projectText).not.toContain(`"level":"defaults"`)
  expect(globalText).toContain(`"level":"global"`)
  expect(globalText).toContain(`"level":"defaults"`)
  expect(globalText).not.toContain(`"level":"project"`)
})

test("no-op save keeps the revision and leaves files untouched", async () => {
  const { project } = await isolated()
  const records: Record[] = [customization({ text: "custom" })]
  await save(project, { expectedRevision: 0, records })
  const beforeProject = await Bun.file(projectRecordsPath(project)).text()
  const beforeGlobal = await Bun.file(globalRecordsPath()).text()
  expect(await save(project, { expectedRevision: 1, records: [...records].reverse() })).toEqual({
    ok: true,
    revision: 1,
  })
  expect(await Bun.file(projectRecordsPath(project)).text()).toBe(beforeProject)
  expect(await Bun.file(globalRecordsPath()).text()).toBe(beforeGlobal)
})

test("stale save is rejected without changing stored content", async () => {
  const { project } = await isolated()
  const first: Record[] = [customization({ text: "first" })]
  await save(project, { expectedRevision: 0, records: first })
  const before = await Bun.file(projectRecordsPath(project)).text()
  const rejected = await save(project, { expectedRevision: 0, records: [customization({ text: "second" })] })
  expect(rejected.ok).toBe(false)
  if (!rejected.ok) expect(rejected.current.records).toHaveLength(1)
  expect(await Bun.file(projectRecordsPath(project)).text()).toBe(before)
})

test("split records round-trip", async () => {
  const { project } = await isolated()
  const records: Record[] = [
    {
      type: "split",
      level: "defaults",
      agent: null,
      item: "tool:bash",
      boundaries: [{ id: "purpose", name: "Purpose", start: 0 }],
      updated: UPDATED,
    },
  ]
  await save(project, { expectedRevision: 0, records })
  expect((await load(project)).records).toEqual(records)
})

test("v1 migration maps agents, states, and item ids", async () => {
  const { project } = await isolated()
  const v1 = [
    JSON.stringify({ revision: 3 }),
    JSON.stringify({
      item: "prompt:alpha",
      agent: "alpha",
      text: "custom prompt",
      state: "disabled",
      basedOn: "h0",
      reviewed: "h1",
      updated: UPDATED,
    }),
    JSON.stringify({
      item: "instruction:AGENTS.md",
      agent: "*",
      state: "enabled",
      basedOn: "h0",
      updated: UPDATED,
    }),
    JSON.stringify({ item: "skill:x", agent: "beta", state: "inherit", basedOn: "h0", updated: UPDATED }),
    JSON.stringify({ item: "tool:bash", agent: "gamma", state: "disabled", basedOn: "h0", updated: UPDATED }),
    JSON.stringify({ item: "mcp:server", agent: "delta", state: "enabled", basedOn: "h0", updated: UPDATED }),
  ].join("\n")
  await fs.mkdir(path.dirname(projectRecordsPath(project)), { recursive: true })
  await Bun.write(projectRecordsPath(project), `${v1}\n`)
  const loaded = await load(project)
  expect(loaded.migrated).toBe(true)
  expect(loaded.revision).toBe(3)
  expect(loaded.records).toContainEqual({
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "system:role",
    section: null,
    text: "custom prompt",
    state: "off",
    basedOn: "h0",
    acknowledged: "h1",
    updated: UPDATED,
  })
  expect(loaded.records).toContainEqual({
    type: "customization",
    level: "defaults",
    agent: null,
    item: "system:AGENTS.md",
    section: null,
    state: "on",
    basedOn: "h0",
    updated: UPDATED,
  })
  const inherit = loaded.records.find((record) => record.type === "customization" && record.item === "skill:x")
  expect(inherit).toEqual({
    type: "customization",
    level: "project",
    agent: "beta",
    item: "skill:x",
    section: null,
    basedOn: "h0",
    updated: UPDATED,
  })
  // Defaults-level rows from a v1 project file route into the global store.
  const saved = await save(project, { expectedRevision: 3, records: loaded.records })
  expect(saved).toEqual({ ok: true, revision: 4 })
  const projectText = await Bun.file(projectRecordsPath(project)).text()
  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(projectText.split("\n")[0]).toContain(`"version":2`)
  expect(globalText.split("\n")[0]).toContain(`"version":2`)
  expect(projectText).not.toContain(`"level":"defaults"`)
  expect(globalText).toContain(`"level":"defaults"`)
  // Migration is idempotent: reloading the written v2 files migrates nothing.
  expect((await load(project)).migrated).toBe(false)
})

test("load skips malformed v2 lines", async () => {
  const { project } = await isolated()
  await save(project, { expectedRevision: 0, records: [customization({ text: "kept" })] })
  const target = projectRecordsPath(project)
  await Bun.write(target, `${await Bun.file(target).text()}{malformed\n`)
  expect((await load(project)).records).toHaveLength(1)
})

function compareForTest(left: Record, right: Record): number {
  return JSON.stringify(left) < JSON.stringify(right) ? -1 : 1
}
