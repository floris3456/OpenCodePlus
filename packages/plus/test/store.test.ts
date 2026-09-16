import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { globalRecordsPath, projectRecordsPath } from "../src/instructions/paths.js"
import { load, save, stable, type StoredRecord } from "../src/instructions/store.js"
import { Plus } from "../src/rpc.js"

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

function customization(overrides?: Partial<Extract<StoredRecord, { type: "customization" }>>): StoredRecord {
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
  expect(await load(project)).toEqual({ projectRevision: 0, globalRevision: 0, records: [], migrated: false })
})

test("save then load round-trips project and global records", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    customization({ agent: "alpha", text: "custom" }),
    customization({ level: "defaults", agent: null, item: "system:role", text: "shared" }),
    customization({ level: "global", agent: "beta", item: "skill:x", state: "off" }),
  ]
  const saved = await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  expect(saved).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: true, global: true } })
  const loaded = await load(project)
  expect(loaded.projectRevision).toBe(1)
  expect(loaded.globalRevision).toBe(1)
  expect(loaded.migrated).toBe(false)
  expect([...loaded.records].sort(compareForTest)).toEqual([...records].sort(compareForTest))
})

test("records route into project vs global files", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    customization({ agent: "alpha", text: "p" }),
    customization({ level: "global", agent: "beta", item: "tool:other", text: "g" }),
    customization({ level: "defaults", agent: null, item: "system:role", text: "d" }),
  ]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
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
  const records: StoredRecord[] = [customization({ text: "custom" })]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  const beforeProject = await Bun.file(projectRecordsPath(project)).text()
  expect(await save(project, { expectedProjectRevision: 1, expectedGlobalRevision: 0, records: [...records].reverse() })).toEqual({
    ok: true,
    projectRevision: 1,
    globalRevision: 0,
    changed: { project: false, global: false },
  })
  expect(await Bun.file(projectRecordsPath(project)).text()).toBe(beforeProject)
  // A project-only save never creates the global file.
  expect(await Bun.file(globalRecordsPath()).exists()).toBe(false)
})

test("stale save is rejected without changing stored content", async () => {
  const { project } = await isolated()
  const first: StoredRecord[] = [customization({ text: "first" })]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: first })
  const before = await Bun.file(projectRecordsPath(project)).text()
  const rejected = await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: [customization({ text: "second" })] })
  expect(rejected.ok).toBe(false)
  if (!rejected.ok) {
    expect(rejected.store).toBe("project")
    expect(rejected.current.records).toHaveLength(1)
  }
  expect(await Bun.file(projectRecordsPath(project)).text()).toBe(before)
})

test("split records round-trip", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    {
      type: "split",
      level: "defaults",
      agent: null,
      item: "tool:bash",
      boundaries: [{ id: "purpose", name: "Purpose", start: 0 }],
      updated: UPDATED,
    },
  ]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
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
  expect(loaded.projectRevision).toBe(3)
  expect(loaded.globalRevision).toBe(0)
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
  const saved = await save(project, { expectedProjectRevision: 3, expectedGlobalRevision: 0, records: loaded.records })
  expect(saved).toEqual({ ok: true, projectRevision: 4, globalRevision: 1, changed: { project: true, global: true } })
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
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: [customization({ text: "kept" })] })
  const target = projectRecordsPath(project)
  await Bun.write(target, `${await Bun.file(target).text()}{malformed\n`)
  expect((await load(project)).records).toHaveLength(1)
})

test("project-only save leaves the global revision untouched and vice versa", async () => {
  const { project } = await isolated()
  const projectOnly: StoredRecord[] = [customization({ agent: "alpha", text: "p1" })]
  const first = await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: projectOnly })
  expect(first).toEqual({ ok: true, projectRevision: 1, globalRevision: 0, changed: { project: true, global: false } })
  const globalOnly: StoredRecord[] = [
    ...projectOnly,
    customization({ level: "global", agent: "beta", item: "tool:other", text: "g1" }),
  ]
  const second = await save(project, { expectedProjectRevision: 1, expectedGlobalRevision: 0, records: globalOnly })
  expect(second).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: false, global: true } })
  const loaded = await load(project)
  expect(loaded.projectRevision).toBe(1)
  expect(loaded.globalRevision).toBe(1)
})

test("two projects saving global records concurrently keep both records", async () => {
  const root = await tempRoot()
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const projectA = path.join(root, "project-a")
  const projectB = path.join(root, "project-b")
  const startedAt = performance.now()
  const baseA = await load(projectA)
  const baseB = await load(projectB)
  const recordA = customization({ level: "global", agent: "alpha", item: "tool:aaa", text: "from-a" })
  const recordB = customization({ level: "global", agent: "beta", item: "tool:bbb", text: "from-b" })
  // Start both saves concurrently: neither awaits the other first.
  const pendingA = save(projectA, {
    expectedProjectRevision: baseA.projectRevision,
    expectedGlobalRevision: baseA.globalRevision,
    records: [recordA],
  })
  const pendingB = save(projectB, {
    expectedProjectRevision: baseB.projectRevision,
    expectedGlobalRevision: baseB.globalRevision,
    records: [recordB],
  })
  const [resultA, resultB] = await Promise.all([pendingA, pendingB])
  const elapsedMs = performance.now() - startedAt
  const stale = [resultA, resultB].find((result) => !result.ok)
  if (stale !== undefined && !stale.ok) expect(stale.store).toBe("global")
  // Retry the loser (if any) against a fresh read so both records land.
  const loserProject = !resultA.ok ? projectA : !resultB.ok ? projectB : undefined
  if (loserProject !== undefined) {
    const loserRecord = loserProject === projectA ? recordA : recordB
    const fresh = await load(loserProject)
    const retry = await save(loserProject, {
      expectedProjectRevision: fresh.projectRevision,
      expectedGlobalRevision: fresh.globalRevision,
      records: [...fresh.records, loserRecord],
    })
    expect(retry.ok).toBe(true)
  }
  const merged = await load(projectA)
  const texts = merged.records.map((record) => (record.type === "customization" ? record.text : undefined))
  expect(texts).toContain("from-a")
  expect(texts).toContain("from-b")
  // A silent lost update must fail: both global records are present.
  expect(merged.records.filter((record) => record.level !== "project")).toHaveLength(2)
  expect(elapsedMs).toBeGreaterThanOrEqual(0)
})

test("save reports per-store changed flags and a stale save reports none", async () => {
  const { project } = await isolated()
  const projectOnly = await save(project, {
    expectedProjectRevision: 0,
    expectedGlobalRevision: 0,
    records: [customization({ text: "p" })],
  })
  expect(projectOnly).toEqual({ ok: true, projectRevision: 1, globalRevision: 0, changed: { project: true, global: false } })
  const globalOnly = await save(project, {
    expectedProjectRevision: 1,
    expectedGlobalRevision: 0,
    records: [customization({ text: "p" }), customization({ level: "global", agent: "beta", item: "tool:other", text: "g" })],
  })
  expect(globalOnly).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: false, global: true } })
  const noop = await save(project, {
    expectedProjectRevision: 1,
    expectedGlobalRevision: 1,
    records: (await load(project)).records,
  })
  expect(noop).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: false, global: false } })
  const stale = await save(project, {
    expectedProjectRevision: 0,
    expectedGlobalRevision: 1,
    records: [customization({ text: "other" })],
  })
  expect(stale.ok).toBe(false)
})

function compareForTest(left: StoredRecord, right: StoredRecord): number {
  return JSON.stringify(left) < JSON.stringify(right) ? -1 : 1
}

function team(overrides?: Partial<Extract<StoredRecord, { type: "team" }>>): StoredRecord {
  return {
    type: "team",
    level: "project",
    team: "crew",
    enabled: true,
    updated: UPDATED,
    ...overrides,
  }
}

test("team records round-trip through save then load", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    team({ level: "project", team: "crew", enabled: true }),
    team({ level: "global", team: "ops", enabled: false }),
    team({ level: "defaults", team: "shipped", enabled: true }),
  ]
  const saved = await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  expect(saved).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: true, global: true } })
  const loaded = await load(project)
  expect(loaded.migrated).toBe(false)
  expect([...loaded.records].sort(compareForTest)).toEqual([...records].sort(compareForTest))
})

test("team records land in the project vs global files", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    team({ level: "project", team: "crew", enabled: true }),
    team({ level: "global", team: "ops", enabled: false }),
    team({ level: "defaults", team: "shipped", enabled: true }),
  ]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  const projectText = await Bun.file(projectRecordsPath(project)).text()
  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(projectText).toContain(`"type":"team"`)
  expect(projectText).toContain(`"team":"crew"`)
  expect(projectText).not.toContain(`"team":"ops"`)
  expect(projectText).not.toContain(`"team":"shipped"`)
  expect(globalText).toContain(`"type":"team"`)
  expect(globalText).toContain(`"team":"ops"`)
  expect(globalText).toContain(`"team":"shipped"`)
  expect(globalText).not.toContain(`"team":"crew"`)
})

test("team-only save bumps only the store it wrote", async () => {
  const { project } = await isolated()
  const projectOnly: StoredRecord[] = [team({ level: "project", team: "crew" })]
  const first = await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: projectOnly })
  expect(first).toEqual({ ok: true, projectRevision: 1, globalRevision: 0, changed: { project: true, global: false } })
  expect(await Bun.file(globalRecordsPath()).exists()).toBe(false)
  const both: StoredRecord[] = [...projectOnly, team({ level: "global", team: "ops" })]
  const second = await save(project, { expectedProjectRevision: 1, expectedGlobalRevision: 0, records: both })
  expect(second).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: false, global: true } })
})

test("unchanged save containing teams is a no-op", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    team({ level: "project", team: "crew" }),
    team({ level: "global", team: "ops", enabled: false }),
  ]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  const beforeProject = await Bun.file(projectRecordsPath(project)).text()
  const beforeGlobal = await Bun.file(globalRecordsPath()).text()
  expect(await save(project, { expectedProjectRevision: 1, expectedGlobalRevision: 1, records: [...records].reverse() })).toEqual({
    ok: true,
    projectRevision: 1,
    globalRevision: 1,
    changed: { project: false, global: false },
  })
  expect(await Bun.file(projectRecordsPath(project)).text()).toBe(beforeProject)
  expect(await Bun.file(globalRecordsPath()).text()).toBe(beforeGlobal)
})

test("load skips malformed team lines but keeps defaults teams", async () => {
  const { project } = await isolated()
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: [team({ team: "kept" })] })
  const target = projectRecordsPath(project)
  const malformed = JSON.stringify({ type: "team", level: "project", enabled: true, updated: UPDATED })
  const defaults = JSON.stringify({ type: "team", level: "defaults", team: "shipped", enabled: true, updated: UPDATED })
  await Bun.write(target, `${await Bun.file(target).text()}${malformed}\n${defaults}\n`)
  const loaded = await load(project)
  expect(loaded.records).toHaveLength(2)
  expect(loaded.records).toContainEqual(team({ team: "kept" }))
  expect(loaded.records).toContainEqual(team({ level: "defaults", team: "shipped", enabled: true }))
})

test("canonical order sorts mixed customization, split, and team records through save and load", async () => {
  const { project } = await isolated()
  const customRec: StoredRecord = customization({ level: "project", agent: "alpha", item: "tool:bash" })
  const splitRec: StoredRecord = {
    type: "split",
    level: "project",
    agent: "alpha",
    item: "tool:bash",
    boundaries: [{ id: "flags", name: "Flags", start: 0 }],
    updated: UPDATED,
  }
  const teamRec: StoredRecord = team({ level: "project", team: "crew", enabled: true })

  // Save in arbitrary non-canonical order: team, split, customization
  await save(project, {
    expectedProjectRevision: 0,
    expectedGlobalRevision: 0,
    records: [teamRec, splitRec, customRec],
  })

  // Loaded records preserve canonical order: customization < split < team
  const loaded = await load(project)
  expect(loaded.records).toEqual([customRec, splitRec, teamRec])

  // Saving again in loaded order is an unchanged no-op
  const reSave = await save(project, {
    expectedProjectRevision: 1,
    expectedGlobalRevision: 0,
    records: loaded.records,
  })
  expect(reSave).toEqual({ ok: true, projectRevision: 1, globalRevision: 0, changed: { project: false, global: false } })
})

test("pin survives a save/load round trip and stable() keys it next to state", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    customization({ agent: "alpha", pin: true }),
    customization({ level: "global", agent: "beta", item: "tool:other", pin: false }),
  ]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  const loaded = await load(project)
  expect(loaded.records).toContainEqual(customization({ agent: "alpha", pin: true }))
  expect(loaded.records).toContainEqual(customization({ level: "global", agent: "beta", item: "tool:other", pin: false }))
  const ordered = Object.keys(stable(customization({ text: "x", state: "off", pin: true })))
  expect(ordered).toEqual(["type", "level", "agent", "item", "section", "text", "state", "pin", "basedOn", "updated"])
  const withoutPin = Object.keys(stable(customization({ text: "x" })))
  expect(withoutPin).not.toContain("pin")
})

test("unchanged save with a pin is a no-op and a changed pin writes", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [customization({ pin: true })]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  const beforeProject = await Bun.file(projectRecordsPath(project)).text()
  expect(await save(project, { expectedProjectRevision: 1, expectedGlobalRevision: 0, records: [...records].reverse() })).toEqual({
    ok: true,
    projectRevision: 1,
    globalRevision: 0,
    changed: { project: false, global: false },
  })
  expect(await Bun.file(projectRecordsPath(project)).text()).toBe(beforeProject)
  const flipped: StoredRecord[] = [customization({ pin: false })]
  const changed = await save(project, { expectedProjectRevision: 1, expectedGlobalRevision: 0, records: flipped })
  expect(changed).toEqual({ ok: true, projectRevision: 2, globalRevision: 0, changed: { project: true, global: false } })
  expect((await load(project)).records).toContainEqual(customization({ pin: false }))
})

function model(overrides?: Partial<Extract<StoredRecord, { type: "model" }>>): StoredRecord {
  return {
    type: "model",
    level: "project",
    agent: "alpha",
    providerID: "openai",
    modelID: "gpt-5",
    updated: UPDATED,
    ...overrides,
  }
}

function rule(overrides?: Partial<Extract<StoredRecord, { type: "rule" }>>): StoredRecord {
  return {
    type: "rule",
    level: "project",
    agent: "alpha",
    tool: "shell",
    id: "git-push",
    label: "Git push",
    patterns: ["git push *"],
    keywords: ["git push"],
    updated: UPDATED,
    ...overrides,
  }
}

test("model and rule records round-trip through save then load", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    model({ active: true, variant: "high" }),
    model({ level: "global", agent: "beta", providerID: "anthropic", modelID: "claude-4" }),
    rule({}),
    rule({ level: "defaults", agent: null, tool: "read", id: "env", label: ".env files", patterns: ["*.env*"], keywords: ["env"] }),
  ]
  const saved = await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  expect(saved).toEqual({ ok: true, projectRevision: 1, globalRevision: 1, changed: { project: true, global: true } })
  const loaded = await load(project)
  expect(loaded.migrated).toBe(false)
  expect([...loaded.records].sort(compareForTest)).toEqual([...records].sort(compareForTest))
})

test("model and rule records land in the project vs global files by level", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    model({ agent: "alpha" }),
    rule({ agent: "alpha" }),
    model({ level: "global", agent: "beta", providerID: "anthropic", modelID: "claude-4" }),
    model({ level: "defaults", agent: null }),
    rule({ level: "defaults", agent: null, tool: "read", id: "env", label: ".env files", patterns: ["*.env*"], keywords: ["env"] }),
  ]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  const projectText = await Bun.file(projectRecordsPath(project)).text()
  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(projectText).toContain(`"type":"model"`)
  expect(projectText).toContain(`"type":"rule"`)
  expect(projectText).not.toContain(`"level":"global"`)
  expect(projectText).not.toContain(`"level":"defaults"`)
  expect(globalText).toContain(`"type":"model"`)
  expect(globalText).toContain(`"type":"rule"`)
  expect(globalText).not.toContain(`"level":"project"`)
})

test("unchanged save containing models and rules is a no-op", async () => {
  const { project } = await isolated()
  const records: StoredRecord[] = [
    model({ active: true, variant: "high" }),
    model({ level: "global", agent: "beta", providerID: "anthropic", modelID: "claude-4" }),
    rule({}),
    rule({ level: "defaults", agent: null, tool: "read", id: "env", label: ".env files", patterns: ["*.env*"], keywords: ["env"] }),
  ]
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })
  const beforeProject = await Bun.file(projectRecordsPath(project)).text()
  const beforeGlobal = await Bun.file(globalRecordsPath()).text()
  expect(await save(project, { expectedProjectRevision: 1, expectedGlobalRevision: 1, records: [...records].reverse() })).toEqual({
    ok: true,
    projectRevision: 1,
    globalRevision: 1,
    changed: { project: false, global: false },
  })
  expect(await Bun.file(projectRecordsPath(project)).text()).toBe(beforeProject)
  expect(await Bun.file(globalRecordsPath()).text()).toBe(beforeGlobal)
})

test("stable() omits unset model keys and round-trips set ones", async () => {
  const { project } = await isolated()
  const bare = model()
  expect("variant" in stable(bare)).toBe(false)
  expect("active" in stable(bare)).toBe(false)
  const full = model({ variant: "high", active: true })
  expect(stable(full)).toEqual(full)
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: [bare, rule({})] })
  const projectText = await Bun.file(projectRecordsPath(project)).text()
  expect(projectText).not.toContain(`"variant"`)
  expect(projectText).not.toContain(`"active"`)
  expect((await load(project)).records).toContainEqual(bare)
})

test("model and rule records sort canonically and survive a load round-trip in order", async () => {
  const { project } = await isolated()
  const first = rule({ tool: "shell", id: "aaa" })
  const second = model({ providerID: "anthropic", modelID: "claude-4" })
  const third = model({ providerID: "openai", modelID: "gpt-5" })
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: [third, first, second] })
  const loaded = await load(project)
  expect(loaded.records).toEqual([second, third, first])
  const reSave = await save(project, { expectedProjectRevision: 1, expectedGlobalRevision: 0, records: loaded.records })
  expect(reSave).toEqual({ ok: true, projectRevision: 1, globalRevision: 0, changed: { project: false, global: false } })
})

test("snapshot record schemas accept model and rule records over the RPC boundary", async () => {
  const decode = Schema.decodeUnknownSync(Plus.SnapshotRecord)
  expect(decode({ type: "model", level: "project", agent: "alpha", providerID: "openai", modelID: "gpt-5", updated: UPDATED }).type).toBe("model")
  expect(
    decode({ type: "model", level: "project", agent: "alpha", providerID: "openai", modelID: "gpt-5", variant: "high", active: true, updated: UPDATED }),
  ).toMatchObject({ variant: "high", active: true })
  expect(
    decode({ type: "rule", level: "project", agent: "alpha", tool: "shell", id: "git-push", label: "Git push", patterns: ["git push *"], keywords: ["git push"], updated: UPDATED }),
  ).toMatchObject({ tool: "shell", id: "git-push" })
})
