import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { globalRecordsPath, projectRecordsPath } from "../src/instructions/paths.js"
import { canonical, load, migrateCatalogues, save, stable, type StoredRecord } from "../src/instructions/store.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function isolated(): Promise<{ project: string }> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-store-presets-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

function records(): StoredRecord[] {
  return [
    {
      type: "link",
      level: "project",
      agent: "opus-orchestrator",
      preset: { kind: "agent", id: "orchestrator" },
      updated: UPDATED,
    },
    {
      type: "link",
      level: "global",
      agent: "scout",
      team: { level: "global", team: "crew" },
      preset: { kind: "member", team: "opencodeplus-team", id: "scout" },
      updated: UPDATED,
    },
    { type: "link", level: "global", agent: null, team: { level: "global", team: "crew" }, preset: { kind: "team", id: "starter" }, updated: UPDATED },
    { type: "link", level: "preset", agent: "mine", preset: { kind: "agent", id: "build" }, updated: UPDATED },
    { type: "link", level: "defaults", agent: "*orchestrator*", catalogue: "agents", preset: { kind: "agent", id: "mine" }, updated: UPDATED },
    { type: "entry", level: "defaults", catalogue: "agents", name: "*orchestrator*", updated: UPDATED },
    { type: "entry", level: "defaults", catalogue: "teams", team: "cr*", name: "sc%", updated: UPDATED },
    {
      type: "preset",
      level: "preset",
      kind: "agent",
      id: "mine",
      fields: { mode: "primary", description: "My agent" },
      updated: UPDATED,
    },
    { type: "preset", level: "preset", kind: "team", id: "my-team", updated: UPDATED },
    { type: "preset", level: "preset", kind: "agent", id: "lead", team: "my-team", fields: {}, updated: UPDATED },
    {
      type: "customization",
      level: "preset",
      agent: "mine",
      item: "tool:bash",
      section: null,
      state: "off",
      basedOn: "fp",
      updated: UPDATED,
    },
    {
      type: "customization",
      level: "project",
      agent: "opus-orchestrator",
      item: "tool:bash",
      section: null,
      state: "on",
      pin: true,
      basedOn: "fp",
      basedOnState: "off",
      basedOnPin: false,
      updated: UPDATED,
    },
    {
      type: "model",
      level: "project",
      agent: "opus-orchestrator",
      providerID: "openai",
      modelID: "gpt",
      active: true,
      basedOn: "anthropic/opus",
      updated: UPDATED,
    },
  ]
}

test("links, Defaults entries, presets and the review fields round-trip", async () => {
  const { project } = await isolated()
  const saved = await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: records() })
  expect(saved).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: true, global: true } })
  const loaded = await load(project)
  expect(loaded.migrated).toBe(false)
  expect(loaded.cataloguesMigrated).toBe(false)
  expect(canonical(loaded.records).map(stable)).toEqual(canonical(records()).map(stable))
})

test("preset, entry and non-project link records live in the global file", async () => {
  const { project } = await isolated()
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: records() })
  const projectLines = (await Bun.file(projectRecordsPath(project)).text()).trim().split("\n").slice(1)
  const globalLines = (await Bun.file(globalRecordsPath()).text()).trim().split("\n").slice(1)
  expect(projectLines.every((line) => line.includes(`"level":"project"`))).toBe(true)
  expect(projectLines).toHaveLength(3)
  expect(globalLines.filter((line) => line.startsWith(`{"type":"preset"`))).toHaveLength(3)
  expect(globalLines.filter((line) => line.startsWith(`{"type":"entry"`))).toHaveLength(2)
  expect(globalLines.filter((line) => line.startsWith(`{"type":"link"`))).toHaveLength(4)
  expect(globalLines.some((line) => line.includes(`"level":"preset","agent":"mine","item":"tool:bash"`))).toBe(true)
})

test("records serialize in canonical key order whatever order they were built in", async () => {
  const { project } = await isolated()
  const shuffled: StoredRecord[] = [
    { updated: UPDATED, preset: { id: "orchestrator", kind: "agent" }, agent: "a", level: "project", type: "link" },
    { name: "x*", updated: UPDATED, catalogue: "teams", team: "t", level: "defaults", type: "entry" },
    { updated: UPDATED, fields: { description: "d", mode: "subagent" }, id: "p", kind: "agent", level: "preset", type: "preset" },
  ]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: shuffled })
  const projectText = await Bun.file(projectRecordsPath(project)).text()
  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(projectText.split("\n")[1]).toBe(
    `{"type":"link","level":"project","agent":"a","preset":{"kind":"agent","id":"orchestrator"},"updated":"${UPDATED}"}`,
  )
  expect(globalText.split("\n").slice(1, 3)).toEqual([
    `{"type":"entry","level":"defaults","catalogue":"teams","team":"t","name":"x*","updated":"${UPDATED}"}`,
    `{"type":"preset","level":"preset","kind":"agent","id":"p","fields":{"mode":"subagent","description":"d"},"updated":"${UPDATED}"}`,
  ])
})

test("an unchanged save is a no-op: no revision moves, no byte changes", async () => {
  const { project } = await isolated()
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: records() })
  const projectBefore = await Bun.file(projectRecordsPath(project)).text()
  const globalBefore = await Bun.file(globalRecordsPath()).text()
  const loaded = await load(project)
  const again = await save(project, { expectedProjectRevision: 1, expectedGlobalRevision: 1, records: loaded.records })
  expect(again).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: false, global: false } })
  // Reversed input order is the same content.
  const reversed = await save(project, {
    expectedProjectRevision: 1,
    expectedGlobalRevision: 1,
    records: [...records()].reverse(),
  })
  expect(reversed).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: false, global: false } })
  expect(await Bun.file(projectRecordsPath(project)).text()).toBe(projectBefore)
  expect(await Bun.file(globalRecordsPath()).text()).toBe(globalBefore)
})

test("invalid new-type lines are dropped like any malformed record", async () => {
  const { project } = await isolated()
  const target = globalRecordsPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  const lines = [
    JSON.stringify({ version: 2, revision: 3 }),
    // An entry is always at level defaults; a preset always at level preset.
    JSON.stringify({ type: "entry", level: "global", catalogue: "agents", name: "x", updated: UPDATED }),
    JSON.stringify({ type: "preset", level: "global", kind: "agent", id: "p", updated: UPDATED }),
    // Team records never live at level preset (team presets are PresetRecords).
    JSON.stringify({ type: "team", level: "preset", team: "t", enabled: true, updated: UPDATED }),
    JSON.stringify({ type: "link", level: "global", agent: "a", preset: { kind: "nope", id: "x" }, updated: UPDATED }),
    JSON.stringify({ type: "entry", level: "defaults", catalogue: "agents", name: "ok", updated: UPDATED }),
  ]
  await Bun.write(target, lines.join("\n") + "\n")
  const loaded = await load(project)
  expect(loaded.globalRevision).toBe(3)
  expect(loaded.records).toEqual([{ type: "entry", level: "defaults", catalogue: "agents", name: "ok", updated: UPDATED }])
})

test("the catalogue migration ignores links, entries and presets", () => {
  const shared: StoredRecord = {
    type: "customization",
    level: "defaults",
    agent: null,
    item: "tool:bash",
    section: null,
    state: "off",
    basedOn: "fp",
    updated: UPDATED,
  }
  // An Agents entry carries a catalogue, but it does not make the store post-split.
  const before = [shared, ...records().filter((record) => record.type === "entry" || record.type === "link" || record.type === "preset")]
  const once = migrateCatalogues(before)
  expect(once.migrated).toBe(true)
  expect(once.records).toHaveLength(before.length + 1)
  expect(once.records.at(-1)).toEqual({ ...shared, catalogue: "teams" })
  expect(migrateCatalogues(once.records).migrated).toBe(false)
  // A store with only the new record types has nothing to migrate.
  const only = records().filter((record) => record.type === "entry" || record.type === "link" || record.type === "preset")
  expect(migrateCatalogues(only)).toEqual({ records: only, migrated: false })
})
