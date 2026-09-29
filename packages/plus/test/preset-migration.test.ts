// The retired-plus-preset migration: the Basic team preset replaced the six
// Plus agent presets and the three shipped team presets, so a store written
// before that must keep working with no user action. The exact record shapes
// below are copied from a real store (`records.jsonl`: links to build-seat and
// reviewer, user presets linked to orchestrator/implementer/scout/reviewer,
// and a preset-level customization on planner).
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../src/index.js"
import { globalLogPath, projectTeamsPath } from "../src/instructions/paths.js"
import { load, migrateRemovedPresets, save, type StoredRecord } from "../src/instructions/store.js"
import { fullContext } from "./harness.js"

const UPDATED = "2026-09-26T11:34:13.520Z"
const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function isolated(): Promise<{ project: string }> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-preset-migration-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

function throwingContext(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      throw data === undefined ? { type, message } : { type, message, data }
    },
  }
}

// The retired shapes a real store holds: every link the old catalogue served.
function retiredRecords(): StoredRecord[] {
  return [
    { type: "link", level: "global", agent: "DeepSeek-Build", preset: { kind: "agent", id: "build-seat" }, updated: UPDATED },
    { type: "link", level: "global", agent: "Gemini-Build", preset: { kind: "agent", id: "build-seat" }, updated: UPDATED },
    { type: "link", level: "global", agent: "astra-reviewer", preset: { kind: "agent", id: "reviewer" }, updated: UPDATED },
    { type: "link", level: "preset", agent: "field-lead-26", preset: { kind: "agent", id: "orchestrator" }, updated: UPDATED },
    { type: "link", level: "preset", agent: "field-maker-26", preset: { kind: "agent", id: "implementer" }, updated: UPDATED },
    { type: "link", level: "preset", agent: "field-reader-26", preset: { kind: "agent", id: "scout" }, updated: UPDATED },
    { type: "link", level: "preset", agent: "field-review-26", preset: { kind: "agent", id: "reviewer" }, updated: UPDATED },
    {
      type: "customization",
      level: "preset",
      agent: "planner",
      item: "compaction:strategy",
      section: null,
      text: "auto",
      basedOn: "929260ad9b9ea9fe0f3553dd964f4ff3deb5792efd031a2b90f573fe91f012bb",
      basedOnText: "auto",
      updated: "2026-09-29T09:42:03.604Z",
    },
  ]
}

const basic = (id: string) => ({ kind: "member" as const, team: "basic", id })

test("migrateRemovedPresets moves every retired agent link to its Basic member", () => {
  const once = migrateRemovedPresets(retiredRecords())
  expect(once.migrated).toBe(true)
  const links = once.records.filter((record) => record.type === "link")
  expect(links.map((link) => [link.agent, link.preset])).toEqual([
    ["DeepSeek-Build", basic("build-seat")],
    ["Gemini-Build", basic("build-seat")],
    ["astra-reviewer", basic("reviewer")],
    ["field-lead-26", basic("orchestrator")],
    ["field-maker-26", basic("implementer")],
    ["field-reader-26", basic("scout")],
    ["field-review-26", basic("reviewer")],
  ])
  // The preset-level customization moves onto the Basic planner member preset.
  expect(once.records.find((record) => record.type === "customization")).toMatchObject({
    level: "preset",
    agent: "planner",
    team: { level: "preset", team: "basic" },
    item: "compaction:strategy",
    text: "auto",
  })
})

test("migrateRemovedPresets maps retired team-preset members and leaves everything else alone", () => {
  const records: StoredRecord[] = [
    { type: "link", level: "global", agent: "fable-planner", team: { level: "global", team: "crew" }, preset: { kind: "member", team: "opencodeplus-team", id: "fable-planner" }, updated: UPDATED },
    { type: "link", level: "global", agent: "helper", team: { level: "global", team: "crew" }, preset: { kind: "member", team: "starter", id: "helper" }, updated: UPDATED },
    { type: "link", level: "global", agent: "editor", team: { level: "global", team: "crew" }, preset: { kind: "member", team: "review", id: "editor" }, updated: UPDATED },
    // A team-preset link is not a member link: it stays and reads as missing.
    { type: "link", level: "global", agent: null, team: { level: "global", team: "crew" }, preset: { kind: "team", id: "starter" }, updated: UPDATED },
    // An unknown member id has no Basic counterpart: it stays too.
    { type: "link", level: "global", agent: "ghost", team: { level: "global", team: "crew" }, preset: { kind: "member", team: "opencodeplus-team", id: "ghost" }, updated: UPDATED },
    // A Basic link and a user preset link are untouched.
    { type: "link", level: "global", agent: "worker", preset: basic("planner"), updated: UPDATED },
    { type: "link", level: "preset", agent: "mine", preset: { kind: "agent", id: "build" }, updated: UPDATED },
    // A team-scoped customization of a retired preset is user data: left alone.
    {
      type: "customization",
      level: "preset",
      agent: "fable-planner",
      team: { level: "preset", team: "opencodeplus-team" },
      item: "system:role",
      section: null,
      text: "mine",
      basedOn: "",
      updated: UPDATED,
    },
  ]
  const once = migrateRemovedPresets(records)
  expect(once.migrated).toBe(true)
  const links = once.records.filter((record) => record.type === "link")
  expect(links.map((link) => link.preset)).toEqual([
    basic("planner"),
    basic("implementer"),
    basic("implementer"),
    { kind: "team", id: "starter" },
    { kind: "member", team: "opencodeplus-team", id: "ghost" },
    basic("planner"),
    { kind: "agent", id: "build" },
  ])
  expect(once.records.find((record) => record.type === "customization")?.team).toEqual({ level: "preset", team: "opencodeplus-team" })
  // Idempotent: a second pass finds nothing to move.
  const twice = migrateRemovedPresets(once.records)
  expect(twice.migrated).toBe(false)
  expect(twice.records).toEqual(once.records)
})

test("load reports presetsMigrated; ensureCatalogues persists it in one revision with one log line", async () => {
  const { project } = await isolated()
  const stored = await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: retiredRecords() })
  if (!stored.ok) throw new Error("expected the initial save to succeed")
  // The raw file still holds the retired refs; load applies the move in memory.
  const raw = await Bun.file(path.join(process.env.OPENCODE_CONFIG_DIR ?? "", "opencodeplus", "instructions", "records.jsonl")).text()
  expect(raw).toContain(`"id":"build-seat"`)
  const first = await load(project)
  expect(first.presetsMigrated).toBe(true)
  const deepseek = first.records.find((record): record is StoredRecord & { type: "link" } => record.type === "link" && record.agent === "DeepSeek-Build")
  expect(deepseek?.preset).toEqual(basic("build-seat"))

  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const persisted = await load(project)
  expect(persisted.presetsMigrated).toBe(false)
  expect(persisted.globalRevision).toBe(first.globalRevision + 1)
  const persistedLinks = persisted.records.filter((record) => record.type === "link")
  expect(persistedLinks.map((link) => link.preset)).not.toContainEqual({ kind: "agent", id: "build-seat" })
  const lines = (await Bun.file(globalLogPath()).text()).split("\n").filter((line) => line.trim().length > 0)
  const migrations = lines.map((line) => JSON.parse(line)).filter((entry) => entry.op === "migrate.presets")
  expect(migrations).toHaveLength(1)
  expect(migrations[0].target).toBe("root:preset")
  expect(migrations[0].revision).toBe(persisted.globalRevision)
  // A second snapshot logs nothing new.
  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const after = (await Bun.file(globalLogPath()).text()).split("\n").filter((line) => line.trim().length > 0)
  expect(after.map((line) => JSON.parse(line)).filter((entry) => entry.op === "migrate.presets")).toHaveLength(1)
})

// A team created from the old `opencodeplus-team` data is user data on disk:
// its files and links must keep working after the catalogue change. The member
// files are written by hand in the old team.create's shape; the links are the
// old member refs.
test("a team created from the old opencodeplus-team data still loads and its members resolve", async () => {
  const { project } = await isolated()
  const crew = path.join(projectTeamsPath(project), "crew")
  await fs.mkdir(crew, { recursive: true })
  const oldMembers = ["fable-planner", "sol-orchestrator", "muse-implementer", "astra-reviewer", "scout"] as const
  for (const id of oldMembers)
    await Bun.write(path.join(crew, `${id}.md`), "---\nmode: primary\ndescription: old member\n---\n")
  const loaded = await load(project)
  const records: StoredRecord[] = [
    { type: "team", level: "project", team: "crew", enabled: true, updated: UPDATED },
    ...oldMembers.map(
      (id): StoredRecord => ({
        type: "link",
        level: "project",
        agent: id,
        team: { level: "project", team: "crew" },
        preset: { kind: "member", team: "opencodeplus-team", id },
        updated: UPDATED,
      }),
    ),
    { type: "link", level: "project", agent: null, team: { level: "project", team: "crew" }, preset: { kind: "team", id: "starter" }, updated: UPDATED },
  ]
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records,
  })
  if (!saved.ok) throw new Error("expected the save to succeed")

  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  expect(snapshot.teams?.find((team) => team.team === "crew")).toEqual({
    level: "project",
    team: "crew",
    enabled: true,
    agents: [...oldMembers].toSorted(),
  })
  // The member links now name the Basic member preset each old member carried.
  const links = (snapshot.links ?? []).filter((link) => link.agent !== null)
  expect(Object.fromEntries(links.map((link) => [link.agent, link.preset]))).toEqual({
    "fable-planner": basic("planner"),
    "sol-orchestrator": basic("orchestrator"),
    "muse-implementer": basic("implementer"),
    "astra-reviewer": basic("reviewer"),
    scout: basic("scout"),
  })
  // The team-preset link stays, marked missing; nothing was silently dropped.
  expect((snapshot.links ?? []).find((link) => link.agent === null)?.preset).toEqual({ kind: "team", id: "starter" })
})