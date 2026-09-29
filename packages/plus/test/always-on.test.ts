import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState } from "../src/index.js"
import { globalRecordsPath, projectRecordsPath } from "../src/instructions/paths.js"
import { load, type CustomizationRecord } from "../src/instructions/store.js"
import type { Plus } from "../src/rpc.js"
import { fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME

afterAll(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function isolate(root: string): { project: string } {
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  return { project: path.join(root, "project") }
}

// A temp root under TMPDIR (the workspace's own tmp directory is approved).
async function tempRoot(): Promise<{ root: string; project: string }> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-always-on-"))
  roots.push(root)
  return { root, ...isolate(root) }
}

// Does any directory at or above `base` carry a `.opencodeplus/project.json`?
// Used only to pick a fixture base with no ambient config, never as an
// assertion about Plus behaviour.
async function hasConfigAbove(base: string): Promise<boolean> {
  let current = path.resolve(base)
  for (;;) {
    if (await Bun.file(path.join(current, ".opencodeplus", "project.json")).exists()) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

// A project directory guaranteed to have no `.opencodeplus` config at or
// above it, so `ensure` really writes one. TMPDIR sits under the development
// checkout, whose own root carries a config in this workspace, so fall back
// to the system temp root when it does.
async function bareProject(): Promise<{ project: string }> {
  for (const base of [process.env.TMPDIR ?? os.tmpdir(), "/tmp"]) {
    if (await hasConfigAbove(base)) continue
    const root = await fs.mkdtemp(path.join(base, "plus-always-on-"))
    roots.push(root)
    return isolate(root)
  }
  throw new Error("no temp base without an ancestor .opencodeplus/project.json")
}

const UPDATED = "2026-09-14T00:00:00.000Z"

function customization(agent: string, overrides?: Partial<Plus.SnapshotCustomizationRecord>): Plus.SnapshotCustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent,
    item: "tool:reader",
    section: null,
    text: "mine",
    basedOn: "fp-upstream",
    updated: UPDATED,
    ...overrides,
  }
}

const toolActor: Plus.Actor = { type: "tool", agent: "alpha", sessionID: "ses_a", messageID: "msg_a" }

test("a fresh directory's snapshot works and creates nothing", async () => {
  const { project } = await bareProject()
  const api = createPlusApi(fullContext({ directory: project }), createState())
  const snapshot = await api.snapshot()
  expect(snapshot.ok).toBe(true)
  expect(await Bun.file(path.join(project, ".opencodeplus")).exists()).toBe(false)
  // Control: the same directory after a project-level write does hold the
  // on-demand project file, so the absence above is not vacuous.
  const written = await api.mutate({
    expectedRevision: snapshot.value.revision,
    expectedGlobalRevision: snapshot.value.globalRevision,
    records: [customization("alpha")],
  })
  expect(written.ok).toBe(true)
  expect(await Bun.file(path.join(project, ".opencodeplus", "project.json")).exists()).toBe(true)
})

test("a project-level write creates the project file, records, log and team directory on demand", async () => {
  const { project } = await bareProject()
  const api = createPlusApi(fullContext({ directory: project }), createState())
  const before = await api.snapshot()
  const written = await api.mutate({
    expectedRevision: before.value.revision,
    expectedGlobalRevision: before.value.globalRevision,
    records: [customization("alpha")],
  })
  expect(written.ok).toBe(true)
  const configPath = path.join(project, ".opencodeplus", "project.json")
  expect(JSON.parse(await Bun.file(configPath).text())).toEqual({ version: 1, protectedAgents: [] })
  expect(await Bun.file(path.join(project, ".opencodeplus", "instructions", "records.jsonl")).exists()).toBe(true)
  expect(await Bun.file(path.join(project, ".opencodeplus", "instructions", "log.jsonl")).exists()).toBe(true)
  const team = await api.createTeam({ level: "project", team: "crew" })
  expect(team).toEqual({ ok: true, value: { level: "project", team: "crew", enabled: false } })
  expect((await Bun.file(path.join(project, ".opencodeplus", "teams", "crew")).stat()).isDirectory()).toBe(true)
  // Control: the same store write routed to the global store in a sibling
  // directory leaves that directory without any project file.
  const sibling = await bareProject()
  const siblingApi = createPlusApi(fullContext({ directory: sibling.project }), createState())
  const siblingBefore = await siblingApi.snapshot()
  const globalWrite = await siblingApi.mutate({
    expectedRevision: siblingBefore.value.revision,
    expectedGlobalRevision: siblingBefore.value.globalRevision,
    records: [{ ...customization("alpha"), level: "global" }],
  })
  expect(globalWrite.ok).toBe(true)
  expect(await Bun.file(path.join(sibling.project, ".opencodeplus")).exists()).toBe(false)
})

test("a project-level team create is the write that creates the config", async () => {
  const { project } = await bareProject()
  const api = createPlusApi(fullContext({ directory: project }), createState())
  const created = await api.createTeam({ level: "project", team: "crew" })
  expect(created.ok).toBe(true)
  expect(await Bun.file(path.join(project, ".opencodeplus", "project.json")).exists()).toBe(true)
})

test("a project-level team addAgent is the write that creates the config", async () => {
  const { project } = await bareProject()
  // The team directory exists (discovery needs it) but no config does.
  await fs.mkdir(path.join(project, ".opencodeplus", "teams", "crew"), { recursive: true })
  const api = createPlusApi(fullContext({ directory: project }), createState())
  const added = await api.addTeamAgent({ level: "project", team: "crew", id: "alpha" })
  expect(added.ok).toBe(true)
  expect(await Bun.file(path.join(project, ".opencodeplus", "project.json")).exists()).toBe(true)
})

test("a refused project team create creates nothing", async () => {
  const { project } = await bareProject()
  const api = createPlusApi(fullContext({ directory: project }), createState())
  // A name the filesystem cannot create: mkdir fails after validation, and
  // the parent chain it made is removed again.
  const refused = await api.createTeam({ level: "project", team: "a".repeat(300) })
  expect(refused.ok).toBe(false)
  if (refused.ok) throw new Error("expected the create to be refused")
  expect(refused.error.code).toBe("team.create")
  expect(await Bun.file(path.join(project, ".opencodeplus")).exists()).toBe(false)
  // Control: a valid create in the same directory does create it.
  const created = await api.createTeam({ level: "project", team: "crew" })
  expect(created.ok).toBe(true)
  expect((await Bun.file(path.join(project, ".opencodeplus", "teams", "crew")).stat()).isDirectory()).toBe(true)
  // A duplicate create is refused before writing anything either.
  const duplicate = await api.createTeam({ level: "project", team: "crew" })
  expect(duplicate.ok).toBe(false)
  if (duplicate.ok) throw new Error("expected the duplicate to be refused")
  expect(duplicate.error.code).toBe("team.exists")
})

test("a project-scoped log write creates the config without a store save", async () => {
  const { project } = await bareProject()
  const api = createPlusApi(fullContext({ directory: project }), createState())
  // skill.create writes `.opencode/skill` and a project log line, and never
  // touches the project store, so only appendForLevel's ensure can create the
  // config here.
  const created = await api.createSkill({ name: "notes", body: "Take notes." })
  expect(created.ok).toBe(true)
  expect(await Bun.file(path.join(project, ".opencodeplus", "project.json")).exists()).toBe(true)
  expect(await Bun.file(path.join(project, ".opencodeplus", "instructions", "log.jsonl")).exists()).toBe(true)
  // Control: a global-scope skill leaves a sibling project directory alone.
  const sibling = await bareProject()
  const siblingApi = createPlusApi(fullContext({ directory: sibling.project }), createState())
  const global = await siblingApi.createSkill({ name: "notes", body: "Take notes.", scope: "global" })
  expect(global.ok).toBe(true)
  expect(await Bun.file(path.join(sibling.project, ".opencodeplus")).exists()).toBe(false)
})

test("a global-only write creates nothing in the project directory", async () => {
  const { project } = await bareProject()
  const api = createPlusApi(fullContext({ directory: project }), createState())
  const before = await api.snapshot()
  const written = await api.mutate({
    expectedRevision: before.value.revision,
    expectedGlobalRevision: before.value.globalRevision,
    records: [{ ...customization("alpha"), level: "global" }],
  })
  expect(written.ok).toBe(true)
  expect(await Bun.file(path.join(project, ".opencodeplus")).exists()).toBe(false)
  // Control: a project-level write in the same directory does create it.
  const afterGlobal = await api.snapshot()
  const projectWrite = await api.mutate({
    expectedRevision: afterGlobal.value.revision,
    expectedGlobalRevision: afterGlobal.value.globalRevision,
    records: [customization("alpha")],
  })
  expect(projectWrite.ok).toBe(true)
  expect(await Bun.file(path.join(project, ".opencodeplus", "project.json")).exists()).toBe(true)
})

test("a legacy enabled:false config is still the nearest config", async () => {
  const { root } = await tempRoot()
  const ancestor = path.join(root, "repo")
  const nested = path.join(ancestor, "nested")
  await fs.mkdir(nested, { recursive: true })
  await fs.mkdir(path.join(ancestor, ".opencodeplus"), { recursive: true })
  await fs.writeFile(
    path.join(ancestor, ".opencodeplus", "project.json"),
    `${JSON.stringify({ version: 1, protectedAgents: ["x"], enabled: false }, null, 2)}\n`,
  )
  const api = createPlusApi(fullContext({ directory: nested }), createState())
  const before = await api.snapshot()
  // The marker is ignored: the config still applies and still stops the walk.
  expect(before.value.protectedAgents).toEqual(["x"])
  const written = await api.mutate({
    expectedRevision: before.value.revision,
    expectedGlobalRevision: before.value.globalRevision,
    records: [customization("y")],
  })
  expect(written.ok).toBe(true)
  expect(await Bun.file(path.join(nested, ".opencodeplus", "project.json")).exists()).toBe(false)
})

test("under an ancestor config a child write makes no child project file and keeps protectedAgents", async () => {
  const { root } = await tempRoot()
  const ancestor = path.join(root, "repo")
  const child = path.join(ancestor, "packages", "plus")
  await fs.mkdir(child, { recursive: true })
  await fs.mkdir(path.join(ancestor, ".opencodeplus"), { recursive: true })
  await fs.writeFile(
    path.join(ancestor, ".opencodeplus", "project.json"),
    `${JSON.stringify({ version: 1, protectedAgents: ["x"] }, null, 2)}\n`,
  )
  const api = createPlusApi(fullContext({ directory: child }), createState())
  const before = await api.snapshot()
  expect(before.value.protectedAgents).toEqual(["x"])
  const written = await api.mutate({
    expectedRevision: before.value.revision,
    expectedGlobalRevision: before.value.globalRevision,
    records: [customization("y")],
  })
  expect(written.ok).toBe(true)
  // The store lands in the child; the config stays the ancestor's.
  expect(await Bun.file(path.join(child, ".opencodeplus", "instructions", "records.jsonl")).exists()).toBe(true)
  expect(await Bun.file(path.join(child, ".opencodeplus", "project.json")).exists()).toBe(false)
  // The ancestor's protectedAgents refuse a tool actor writing agent x...
  const refused = await api.createAgent({ scope: "project", id: "x", actor: toolActor })
  expect(refused.ok).toBe(false)
  if (refused.ok) throw new Error("expected the protected write to be refused")
  expect(refused.error.code).toBe("agent.protected")
  // ...while a non-protected agent is allowed (the control).
  const allowed = await api.createAgent({ scope: "project", id: "y", actor: toolActor })
  expect(allowed.ok).toBe(true)
})

// A v1 global store with one shared Defaults row and one project-level row:
// the shared row triggers the catalogue migration on the next load, and the
// project row has no project store of its own yet.
async function writeV1GlobalStore(): Promise<void> {
  const file = globalRecordsPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    [
      JSON.stringify({ revision: 7 }),
      JSON.stringify({ item: "tool:reader", agent: "*", state: "enabled", basedOn: "fp-shared", updated: UPDATED }),
      JSON.stringify({ item: "tool:reader", agent: "alpha", text: "mine", state: "enabled", basedOn: "fp-alpha", updated: UPDATED }),
    ].join("\n") + "\n",
  )
}

// The v2 equivalent: a mixed store whose shared Defaults row predates the
// catalogue split (no catalogue key) and whose project row has no project
// store, so the catalogue migration still triggers on the next load.
async function writeV2MixedGlobalStore(): Promise<void> {
  const file = globalRecordsPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    [
      JSON.stringify({ version: 2, revision: 3 }),
      JSON.stringify({ type: "customization", level: "defaults", agent: null, item: "tool:reader", section: null, state: "on", basedOn: "fp-shared", updated: UPDATED }),
      JSON.stringify({ type: "customization", level: "project", agent: "alpha", item: "tool:reader", section: null, text: "mine", state: "on", basedOn: "fp-alpha", updated: UPDATED }),
    ].join("\n") + "\n",
  )
}

test("a read-triggered migration creates no project store and keeps the migrated row", async () => {
  for (const seed of [writeV1GlobalStore, writeV2MixedGlobalStore]) {
    const { project } = await bareProject()
    await seed()
    const api = createPlusApi(fullContext({ directory: project }), createState())
    const snapshot = await api.snapshot()
    // The migrated view is returned in memory...
    const row = snapshot.value.records.find(
      (record): record is Plus.SnapshotCustomizationRecord =>
        record.type === "customization" && record.level === "project" && record.agent === "alpha",
    )
    expect(row?.text).toBe("mine")
    // ...without creating anything in the project directory...
    expect(await Bun.file(path.join(project, ".opencodeplus")).exists()).toBe(false)
    // ...and the global store still holds the project row: nothing moved into a
    // project store that does not exist.
    const global = await Bun.file(globalRecordsPath()).text()
    expect(global).toContain('"agent":"alpha"')
    expect(global).toContain('"version":2')
  }
})

test("a global-only write after the migration keeps the held project row", async () => {
  const { project } = await bareProject()
  await writeV1GlobalStore()
  const api = createPlusApi(fullContext({ directory: project }), createState())
  const before = await api.snapshot()
  const written = await api.mutate({
    expectedRevision: before.value.revision,
    expectedGlobalRevision: before.value.globalRevision,
    records: [...before.value.records, { ...customization("gamma"), level: "global" as const }],
  })
  expect(written.ok).toBe(true)
  // The read-only held row survived a global-only save...
  const after = await api.snapshot()
  const alpha = after.value.records.find(
    (record): record is Plus.SnapshotCustomizationRecord =>
      record.type === "customization" && record.level === "project" && record.agent === "alpha",
  )
  expect(alpha?.text).toBe("mine")
  // ...and the save still created no project store.
  expect(await Bun.file(path.join(project, ".opencodeplus")).exists()).toBe(false)
})

test("a real project write after the migration creates the project store and loses nothing", async () => {
  const { project } = await bareProject()
  await writeV1GlobalStore()
  const api = createPlusApi(fullContext({ directory: project }), createState())
  const before = await api.snapshot()
  const written = await api.mutate({
    expectedRevision: before.value.revision,
    expectedGlobalRevision: before.value.globalRevision,
    records: [...before.value.records, customization("beta", { text: "beta text" })],
  })
  expect(written.ok).toBe(true)
  const stored = await load(project)
  const textOf = (agent: string) =>
    stored.records.find(
      (record): record is CustomizationRecord => record.type === "customization" && record.agent === agent,
    )?.text
  expect(textOf("alpha")).toBe("mine")
  expect(textOf("beta")).toBe("beta text")
  expect(await Bun.file(projectRecordsPath(project)).exists()).toBe(true)
  // The moved row no longer rides the global file.
  expect(await Bun.file(globalRecordsPath()).text()).not.toContain('"agent":"alpha"')
})
