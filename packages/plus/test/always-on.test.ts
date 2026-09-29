import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState } from "../src/index.js"
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
