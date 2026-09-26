import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fingerprint, resolve, type AgentSource, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { globalLogPath } from "../src/instructions/paths.js"
import { load, migrateCatalogues, save, type StoredRecord } from "../src/instructions/store.js"
import { expandedTree, tree, type TreeNode } from "../src/instructions/tree.js"
import { query } from "../src/instructions/query.js"
import { toggle } from "../src/instructions/ops.js"
import { createHandlers, createState } from "../src/index.js"
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

async function isolated(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-catalogues-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

function bashItem(text = "run commands"): Item {
  return { id: "tool:bash", kind: "tool", group: "native", title: "bash", text, enabled: true, fingerprint: fingerprint(text) }
}

function agents(): AgentSource[] {
  return [
    { id: "solo", scope: "project", origin: "user" },
    { id: "mate", scope: "project", origin: "user" },
  ]
}

function sharedOff(catalogue?: "agents" | "teams"): CustomizationRecord {
  return {
    type: "customization",
    level: "defaults",
    agent: null,
    ...(catalogue === undefined ? {} : { catalogue }),
    item: "tool:bash",
    section: null,
    state: "off",
    basedOn: fingerprint("run commands"),
    updated: UPDATED,
  }
}

function expandAll(input: Parameters<typeof expandedTree>[0]): TreeNode[] {
  return expandedTree(input)
}

test("each catalogue owns its six inventory groups under every root's two catalogue roots", () => {
  const nodes = expandAll({ items: [bashItem()], records: [], agents: agents() })
  const ids = nodes.map((node) => node.id)
  for (const level of ["project", "global", "defaults"] as const) {
    expect(ids).toContain(`group:${level}:agents`)
    expect(ids).toContain(`group:${level}:teams`)
  }
  for (const category of ["models", "tools", "base", "skills", "system", "mcp"] as const) {
    expect(ids).toContain(`group:defaults::${category}`)
    expect(ids).toContain(`group:defaults:/teams:${category}`)
  }
  // The shared inventory only exists where the chain terminates.
  expect(ids.some((id) => id.startsWith("group:project:/teams:"))).toBe(false)
  expect(ids.some((id) => id.startsWith("group:global::"))).toBe(false)
})

test("both shared-row id forms resolve and the keyless one means the Agents catalogue", () => {
  const input = { items: [bashItem()], records: [sharedOff(), sharedOff("teams")], agents: agents() }
  const nodes = expandAll(input)
  const agentsRow = nodes.find((node) => node.id === "item:defaults::tool:bash")
  const teamsRow = nodes.find((node) => node.id === "item:defaults:/teams:tool:bash")
  expect(agentsRow?.address).toEqual({ level: "defaults", agent: null, item: "tool:bash", section: null })
  expect(teamsRow?.address).toEqual({ level: "defaults", agent: null, item: "tool:bash", section: null, catalogue: "teams" })
  // Both ids drive ops, and the keyless one still writes a keyless record.
  const flipped = toggle(input, "item:defaults::tool:bash")
  if (!("records" in flipped)) throw new Error(flipped.refusal)
  const written = flipped.records.find((record) => record.item === "tool:bash" && record.agent === null && record.catalogue === undefined)
  expect(written?.state).toBe("on")
  const flippedTeams = toggle(input, "item:defaults:/teams:tool:bash")
  if (!("records" in flippedTeams)) throw new Error(flippedTeams.refusal)
  expect(flippedTeams.records.find((record) => record.catalogue === "teams")?.state).toBe("on")
})

test("a shared row in one catalogue never reaches the other catalogue's agents", () => {
  const item = bashItem()
  const records = [sharedOff()]
  const scopes = { global: new Set<string>(), defaults: new Set<string>() }
  const standalone = resolve({
    upstream: item,
    records,
    splits: [],
    scopes,
    address: { level: "project", agent: "solo", item: item.id, section: null },
  })
  const member = resolve({
    upstream: item,
    records,
    splits: [],
    scopes,
    address: { level: "project", agent: "mate", item: item.id, section: null, catalogue: "teams" },
  })
  expect(standalone.enabled).toBe(false)
  expect(member.enabled).toBe(true)
  // The Teams copy flips exactly the team-member answer, not the stand-alone one.
  const withTeams = resolve({
    upstream: item,
    records: [...records, sharedOff("teams")],
    splits: [],
    scopes,
    address: { level: "project", agent: "mate", item: item.id, section: null, catalogue: "teams" },
  })
  expect(withTeams.enabled).toBe(false)
})

test("a team member row resolves through Teams while its stand-alone row resolves through Agents", () => {
  const nodes = expandAll({
    items: [bashItem()],
    // mate is a user agent, whose unset rows fall back to off (DESIGN §3.3):
    // the Teams "everyone" row turns bash on so the two chains differ.
    records: [sharedOff(), { ...sharedOff("teams"), state: "on" }],
    agents: agents(),
    teams: [{ level: "project", team: "crew", enabled: true, agents: ["mate"] }],
  })
  const standalone = nodes.find((node) => node.id === "item:project:mate:tool:bash")
  const member = nodes.find((node) => node.id === "item:project:crew/:mate:tool:bash")
  expect(standalone?.badges.state).toBe("off")
  expect(member?.badges.state).toBe("on")
  expect(member?.address?.catalogue).toBe("teams")
  // Same records, different chain: the member row still addresses the agent.
  expect(member?.address?.agent).toBe("mate")
})

test("query filters rows by catalogue", () => {
  const input = {
    items: [bashItem()],
    records: [sharedOff(), sharedOff("teams")],
    agents: agents(),
    teams: [{ level: "project" as const, team: "crew", enabled: true, agents: ["mate"] }],
  }
  const ids = (where: string) => query(input, { where }).rows.map((row) => row.id)
  expect(ids("catalogue:teams")).toContain("item:defaults:/teams:tool:bash")
  expect(ids("catalogue:teams")).toContain("item:project:crew/:mate:tool:bash")
  expect(ids("catalogue:teams")).not.toContain("item:defaults::tool:bash")
  expect(ids("catalogue:agents")).toContain("item:defaults::tool:bash")
  expect(ids("catalogue:agents")).toContain("item:project:mate:tool:bash")
  expect(ids("catalogue:agents")).not.toContain("item:defaults:/teams:tool:bash")
  expect(() => ids("catalogue:nope")).toThrow("bad catalogue value")
})

test("migrateCatalogues copies every shared Defaults row into Teams and is idempotent", () => {
  const before: StoredRecord[] = [
    sharedOff(),
    { type: "split", level: "defaults", agent: null, item: "tool:bash", boundaries: [{ id: "a", name: "A", start: 0 }], updated: UPDATED },
    { type: "model", level: "defaults", agent: null, providerID: "acme", modelID: "nova", updated: UPDATED },
    { type: "rule", level: "defaults", agent: null, tool: "read", id: "env", label: ".env", patterns: ["*.env*"], keywords: ["env"], updated: UPDATED },
    // Per-agent and non-defaults rows are one record both catalogues read.
    { ...sharedOff(), level: "project", agent: "solo" },
    { type: "team", level: "project", team: "crew", enabled: true, updated: UPDATED },
  ]
  const once = migrateCatalogues(before)
  expect(once.migrated).toBe(true)
  expect(once.records.filter((record) => "catalogue" in record && record.catalogue === "teams")).toHaveLength(4)
  expect(once.records).toHaveLength(before.length + 4)
  const twice = migrateCatalogues(once.records)
  expect(twice.migrated).toBe(false)
  expect(twice.records).toEqual(once.records)
})

test("migrateCatalogues leaves a store with no shared rows alone", () => {
  const records: StoredRecord[] = [{ ...sharedOff(), level: "project", agent: "solo" }]
  const result = migrateCatalogues(records)
  expect(result.migrated).toBe(false)
  expect(result.records).toEqual(records)
})

test("a pre-split store migrates on load, persists once, and stays put afterwards", async () => {
  const { project } = await isolated()
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: [sharedOff()] })
  const first = await load(project)
  expect(first.cataloguesMigrated).toBe(true)
  expect(first.records).toHaveLength(2)
  // Persisting the migration is one save that moves the global revision once.
  const saved = await save(project, {
    expectedProjectRevision: first.projectRevision,
    expectedGlobalRevision: first.globalRevision,
    records: first.records,
  })
  if (!saved.ok) throw new Error("expected the migration save to succeed")
  expect(saved.globalRevision).toBe(first.globalRevision + 1)
  const second = await load(project)
  expect(second.cataloguesMigrated).toBe(false)
  expect(second.records).toHaveLength(2)
})

test("the plugin's first load migrates the catalogues and logs one migrate.catalogues revision", async () => {
  const { project } = await isolated()
  await enable(project)
  await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records: [sharedOff()] })
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown): never => { throw { type, message, data } } }
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
  const shared = snapshot.records.filter(
    (record) => record.type === "customization" && record.level === "defaults" && record.agent === null,
  )
  expect(shared).toHaveLength(2)
  expect(shared.filter((record) => record.catalogue === "teams")).toHaveLength(1)
  const lines = (await Bun.file(globalLogPath()).text()).split("\n").filter((line) => line.trim().length > 0)
  const migrations = lines.map((line) => JSON.parse(line)).filter((entry) => entry.op === "migrate.catalogues")
  expect(migrations).toHaveLength(1)
  expect(migrations[0].target).toBe("root:defaults")
  // A second snapshot re-reads the store and must not log a second migration.
  await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
  const after = (await Bun.file(globalLogPath()).text()).split("\n").filter((line) => line.trim().length > 0)
  expect(after.map((line) => JSON.parse(line)).filter((entry) => entry.op === "migrate.catalogues")).toHaveLength(1)
})

test("model.add writes a Teams-catalogue shared row only when asked", async () => {
  const { project } = await isolated()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown): never => { throw { type, message, data } } }
  await Effect.runPromise(
    handlers["rule.add"](
      { level: "defaults", agent: null, catalogue: "teams", tool: "shell", id: "no-push", label: "No push", patterns: ["git push *"] },
      throwing,
    ),
  )
  await Effect.runPromise(
    handlers["rule.add"]({ level: "defaults", agent: null, tool: "shell", id: "no-rm", label: "No rm", patterns: ["rm *"] }, throwing),
  )
  const stored = await load(project)
  const rules = stored.records.filter((record) => record.type === "rule")
  expect(rules.find((record) => record.type === "rule" && record.id === "no-push")?.catalogue).toBe("teams")
  expect(rules.find((record) => record.type === "rule" && record.id === "no-rm")?.catalogue).toBeUndefined()
})

test("collapsed roots still expand into the two catalogues", () => {
  const rows = tree({ items: [bashItem()], records: [], agents: agents(), expanded: new Set(["root:defaults"]) })
  // Presets is the last root: Defaults' own rows are the ones before it.
  const defaults = rows.slice(
    rows.findIndex((row) => row.id === "root:defaults") + 1,
    rows.findIndex((row) => row.id === "root:preset"),
  )
  expect(defaults.map((row) => row.id)).toEqual(["group:defaults:agents", "group:defaults:teams"])
  expect(defaults.map((row) => row.depth)).toEqual([1, 1])
  expect(rows.at(-1)?.id).toBe("root:preset")
})
