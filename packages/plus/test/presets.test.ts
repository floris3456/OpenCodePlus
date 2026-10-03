import { afterEach, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../src/index.js"
import { basicBody, builtinTeams } from "../src/instructions/builtin-teams.js"
import { agentBody } from "../src/instructions/discover.js"
import {
  fingerprint,
  resolutionChain,
  resolve,
  type AgentSource,
  type CustomizationRecord,
  type Item,
  type LinkRecord,
  type PresetRef,
} from "../src/instructions/model.js"
import { globalTeamsPath, projectTeamsPath } from "../src/instructions/paths.js"
import {
  chainContext,
  nativePresetIds,
  plusTeamPresets,
  presetCatalog,
  presetListing,
} from "../src/instructions/presets.js"
import { contextOfSnapshot, memoInputOf } from "../src/instructions/snapshot.js"
import { load, save, type StoredRecord } from "../src/instructions/store.js"
import { parseTeamFields } from "../src/instructions/teams-apply.js"
import { expandedTree } from "../src/instructions/tree.js"
import { Plus } from "../src/rpc.js"
import { toRpcRecords } from "../src/tui/instructions/state.js"
import { agentInfo, fullContext } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-presets-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const project = path.join(root, "project")
  return project
}

function throwingContext(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      throw data === undefined ? { type, message } : { type, message, data }
    },
  }
}

function item(overrides: Partial<Item> & { id: string }): Item {
  const text = overrides.text ?? `${overrides.id} text`
  return {
    kind: "tool",
    group: "native",
    title: overrides.id,
    text,
    enabled: true,
    fingerprint: fingerprint(text),
    ...overrides,
  }
}

function roleOf(agent: string, text: string): Item {
  return item({ id: "system:role", kind: "system", group: "none", title: "Role/persona", text, agents: [agent], order: 0 })
}

function link(owner: { level: LinkRecord["level"]; agent: string | null; team?: LinkRecord["team"] }, preset: PresetRef): LinkRecord {
  return {
    type: "link",
    level: owner.level,
    agent: owner.agent,
    ...(owner.team === undefined ? {} : { team: owner.team }),
    preset,
    updated: UPDATED,
  }
}

// A native opencode agent, a user agent, and an inventory whose rows differ in
// state, text and pin, so "exactly like build" is a real comparison.
const agents: AgentSource[] = [
  { id: "build", scope: "defaults", origin: "native" },
  { id: "alpha", scope: "project", origin: "user", path: "/agents/alpha.md" },
  { id: "beta", scope: "project", origin: "user", path: "/agents/beta.md" },
]

const inventory: Item[] = [
  item({ id: "tool:bash" }),
  item({ id: "tool:grep", enabled: false }),
  item({ id: "tool:coder", codemode: true, pinned: true }),
  item({ id: "skill:notes", kind: "skill", text: "notes body" }),
  roleOf("build", "You are build."),
  roleOf("alpha", ""),
  roleOf("beta", "beta body"),
]

function resolveFor(itemId: string, agent: string, level: CustomizationRecord["level"], context: ReturnType<typeof chainContext>) {
  const upstream = inventory.find((entry) => entry.id === itemId && (entry.agents === undefined || entry.agents.includes(agent)))
  if (upstream === undefined) throw new Error(`no item ${itemId} for ${agent}`)
  return resolve({
    upstream,
    records: [],
    splits: [],
    scopes: context,
    address: { level, agent, item: itemId, section: null },
  })
}

test("a Native preset ships its native agent's upstream values and prompt", () => {
  const catalog = presetCatalog({ items: inventory })
  const build: PresetRef = { kind: "agent", id: "build" }
  for (const entry of inventory.filter((candidate) => candidate.id !== "system:role"))
    expect(catalog.shipped(build, entry.id, null, entry)).toEqual({
      text: entry.text,
      state: entry.enabled ? "on" : "off",
      ...(entry.pinned === undefined ? {} : { pin: entry.pinned }),
    })
  // system:role is the native agent's own prompt, whatever agent resolves it.
  expect(catalog.shipped(build, "system:role", null, roleOf("alpha", ""))).toEqual({ text: "You are build.", state: "on" })
  // Sections inherit from the whole text; a preset ships whole items only.
  expect(catalog.shipped(build, "tool:bash", "intro", inventory[0])).toBeUndefined()
  // One Native preset per native opencode agent.
  expect(presetListing().filter((entry) => entry.origin === "native").map((entry) => entry.ref)).toEqual(
    nativePresetIds.map((id) => ({ kind: "agent", id })),
  )
})

test("a Basic member preset's role text is its sectioned body, and it ships every item's value", () => {
  const catalog = presetCatalog({ items: inventory })
  const basic = plusTeamPresets.find((team) => team.id === "basic")
  const orchestrator = basic?.members.find((member) => member.id === "orchestrator")
  expect(orchestrator?.role).toBe(basicBody("orchestrator"))
  expect(orchestrator?.role.split("\n").filter((line) => line.startsWith("# "))).toEqual(["# Team member", "# Delegating", "# Orchestrator"])
  expect(catalog.shipped({ kind: "member", team: "basic", id: "orchestrator" }, "system:role", null, roleOf("alpha", ""))).toEqual({
    text: basicBody("orchestrator"),
    state: "on",
  })
  // Self-contained: a member preset ships every item's own value, overlaid by
  // its overrides, exactly as the retired Plus agent preset did.
  expect(catalog.shipped({ kind: "member", team: "basic", id: "planner" }, "tool:grep", null, inventory[1])).toEqual({
    text: "tool:grep text",
    state: "off",
  })
  expect(basic?.label).toBe("Basic")
  expect(basic?.members.map((member) => [member.id, member.mode])).toEqual([
    ["planner", "primary"],
    ["orchestrator", "primary"],
    ["implementer", "primary"],
    ["reviewer", "primary"],
    ["scout", "primary"],
    ["build-seat", "primary"],
  ])
  const seat = basic?.members.find((member) => member.id === "build-seat")
  expect(seat?.role.startsWith("# Team member\n")).toBe(true)
  // The seat is never delegated to: no Reporting section, and it delegates.
  expect(seat?.role).not.toContain("## Reporting")
  expect(seat?.role).toContain("# Delegating")
  // The Plus agent group ships empty: its six presets are Basic members now.
  expect(presetListing().filter((entry) => entry.origin === "plus" && entry.kind === "agent")).toEqual([])
})

test("the Basic team preset lists its self-contained members with their own role bodies", () => {
  expect(plusTeamPresets.map((team) => [team.id, team.label])).toEqual([["basic", "Basic"]])
  expect(plusTeamPresets.map((team) => team.id)).toEqual(builtinTeams.map((team) => team.name))
  const catalog = presetCatalog({ items: inventory })
  const basic = plusTeamPresets[0]
  const listed = presetListing().find((entry) => entry.ref.kind === "team" && entry.ref.id === "basic")
  expect(listed?.members).toEqual(basic?.members.map((member) => member.id))
  for (const member of basic?.members ?? []) {
    const body = builtinTeams.find((entry) => entry.name === "basic")?.members.find((entry) => entry.id === member.id)?.body
    expect(catalog.shipped({ kind: "member", team: "basic", id: member.id }, "system:role", null)).toEqual({ text: body, state: "on" })
    expect(catalog.shipped({ kind: "member", team: "basic", id: member.id }, "setting:mode", null)).toEqual({ text: "primary" })
    expect(member.description.length).toBeGreaterThan(0)
    expect(member.mode).toBe("primary")
    // A member preset is self-contained: nothing links it to another preset.
    expect(member.overrides["perm:team_delegate:to.other-teams"]).toBeUndefined()
  }
  // A member preset expands through its shipped node alone; there is no link
  // to a hidden agent preset left.
  const context = chainContext({ agents, items: inventory })
  const chain = resolutionChain(
    { level: "preset", agent: "scout", item: "tool:bash", section: null, team: { level: "preset", team: "basic" } },
    context,
  )
  expect(chain.map((node) => `${node.shipped === undefined ? "" : "shipped:"}${node.level}/${node.agent}${node.team === undefined ? "" : `@${node.team.team}`}`)).toEqual([
    "preset/scout@basic",
    "shipped:preset/scout@basic",
    "defaults/null",
  ])
})

test("a user agent linked to Native build resolves every row exactly like build", () => {
  const context = chainContext({ agents, items: inventory, links: [link({ level: "project", agent: "alpha" }, { kind: "agent", id: "build" })] })
  for (const id of ["tool:bash", "tool:grep", "tool:coder", "skill:notes", "system:role"]) {
    const alpha = resolveFor(id, "alpha", "project", context)
    const build = resolveFor(id, "build", "defaults", context)
    expect([id, alpha.enabled, alpha.text, alpha.pinned]).toEqual([id, build.enabled, build.text, build.pinned])
  }
  expect(resolveFor("tool:grep", "alpha", "project", context).from).toEqual({ kind: "preset", id: "build", shipped: true })
})

test("an unlinked user agent resolves shared rows off and its own prompt upstream", () => {
  const context = chainContext({ agents, items: inventory })
  for (const id of ["tool:bash", "tool:coder", "skill:notes"]) {
    const beta = resolveFor(id, "beta", "project", context)
    expect([id, beta.enabled, beta.from]).toEqual([id, false, { kind: "off" }])
  }
  // Only the state goes off: the text stays upstream.
  expect(resolveFor("tool:bash", "beta", "project", context).text).toBe("tool:bash text")
  const role = resolveFor("system:role", "beta", "project", context)
  expect([role.enabled, role.text]).toEqual([true, "beta body"])
})

test("a user preset linked to a Basic member preset expands through it", () => {
  const context = chainContext({
    agents,
    items: inventory,
    presets: [{ type: "preset", level: "preset", kind: "agent", id: "mine", fields: { mode: "primary" }, updated: UPDATED }],
    links: [
      link({ level: "preset", agent: "mine" }, { kind: "member", team: "basic", id: "reviewer" }),
      link({ level: "project", agent: "beta" }, { kind: "agent", id: "mine" }),
    ],
  })
  const chain = resolutionChain({ level: "project", agent: "beta", item: "system:role", section: null }, context)
  expect(chain.map((node) => `${node.shipped === undefined ? "" : "shipped:"}${node.level}/${node.agent}${node.team === undefined ? "" : `@${node.team.team}`}`)).toEqual([
    "project/beta",
    "preset/mine",
    "preset/reviewer@basic",
    "shipped:preset/reviewer@basic",
    "defaults/null",
  ])
  const role = resolveFor("system:role", "beta", "project", context)
  expect(role.text).toBe(basicBody("reviewer"))
  expect(role.textFrom).toEqual({ kind: "preset", id: "reviewer", team: "basic", shipped: true })
  // The user preset's own edits win over what it was created from.
  const edited = resolve({
    upstream: inventory[0] as Item,
    records: [
      { type: "customization", level: "preset", agent: "mine", item: "tool:bash", section: null, state: "off", basedOn: "x", updated: UPDATED },
    ],
    splits: [],
    scopes: context,
    address: { level: "project", agent: "beta", item: "tool:bash", section: null },
  })
  expect([edited.enabled, edited.from]).toEqual([false, { kind: "preset", id: "mine", shipped: false }])
  const mine = presetListing([
    { type: "preset", level: "preset", kind: "agent", id: "mine", fields: { mode: "primary" }, updated: UPDATED },
  ]).find((entry) => entry.origin === "user")
  expect(mine).toEqual({
    ref: { kind: "agent", id: "mine" },
    origin: "user",
    kind: "agent",
    label: "mine",
    mode: "primary",
  })
})

test("a member's link is found both from apply's team address and from the tree's teams-catalogue address", () => {
  const team = { level: "project" as const, team: "crew" }
  const context = chainContext({
    agents,
    items: inventory,
    links: [link({ level: "project", agent: "beta", team }, { kind: "agent", id: "build" })],
    teams: [{ team: "crew", agents: ["beta"] }],
  })
  const applied = resolve({
    upstream: inventory[1] as Item,
    records: [],
    splits: [],
    scopes: context,
    address: { level: "project", agent: "beta", item: "tool:grep", section: null, team },
  })
  const listed = resolve({
    upstream: inventory[1] as Item,
    records: [],
    splits: [],
    scopes: context,
    address: { level: "project", agent: "beta", item: "tool:grep", section: null, catalogue: "teams" },
  })
  expect(applied.from).toEqual({ kind: "preset", id: "build", shipped: true })
  expect(listed.from).toEqual(applied.from)
  // The stand-alone Agents address of the same id does not read a member's link.
  const alone = resolveFor("tool:bash", "beta", "project", context)
  expect(alone.from).toEqual({ kind: "off" })
})

test("an MCP server row keeps its upstream state at Defaults for every agent", () => {
  const server = item({ id: "mcp:search", kind: "mcp", group: "none" })
  const resolved = resolve({
    upstream: server,
    records: [],
    splits: [],
    scopes: chainContext({ agents, items: inventory }),
    address: { level: "defaults", agent: null, item: "mcp:search", section: null },
  })
  expect(resolved.enabled).toBe(true)
})

test("team.create from a user team preset writes its members and links them to its member presets", async () => {
  const project = await tempProject()
  const loaded = await load(project)
  const presets: StoredRecord[] = [
    { type: "preset", level: "preset", kind: "team", id: "duo", updated: UPDATED },
    { type: "preset", level: "preset", kind: "agent", id: "lead", team: "duo", fields: { mode: "primary", description: "Leads" }, updated: UPDATED },
    { type: "preset", level: "preset", kind: "agent", id: "hand", team: "duo", fields: { mode: "subagent" }, updated: UPDATED },
  ]
  const saved = await save(project, { expectedProjectRevision: loaded.projectRevision, expectedGlobalRevision: loaded.globalRevision, records: presets })
  expect(saved.ok).toBe(true)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "pair", preset: "duo" }, throwingContext()))
  const created = (await load(project)).records.filter((record): record is LinkRecord => record.type === "link")
  const owner = { level: "global" as const, team: "pair" }
  expect(created).toHaveLength(3)
  for (const record of created) expect([record.level, record.team]).toEqual(["global", owner])
  expect(new Map(created.map((record) => [record.agent, record.preset]))).toEqual(
    new Map<string | null, PresetRef>([
      [null, { kind: "team", id: "duo" }],
      ["hand", { kind: "member", team: "duo", id: "hand" }],
      ["lead", { kind: "member", team: "duo", id: "lead" }],
    ]),
  )
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  expect(snapshot.teams?.find((team) => team.team === "pair")?.agents).toEqual(["hand", "lead"])
  expect(snapshot.presets?.map((record) => record.id).toSorted()).toEqual(["duo", "hand", "lead"])
  const leadText = await fs.readFile(path.join(globalTeamsPath(), "pair", "lead.md"), "utf8")
  expect(parseTeamFields(leadText)).toMatchObject({ mode: "primary", description: "Leads" })
  expect(agentBody(leadText)).toBe("")
  const handText = await fs.readFile(path.join(globalTeamsPath(), "pair", "hand.md"), "utf8")
  expect(parseTeamFields(handText).mode).toBe("subagent")
})

test("a project team created from the Basic preset installs each member with its shipped role text", async () => {
  const project = await tempProject()
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew", preset: "basic" }, throwingContext()))
  const file = await fs.readFile(path.join(projectTeamsPath(project), "crew", "reviewer.md"), "utf8")
  expect(agentBody(file)).toBe("")
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext()))
  const listed = await Effect.runPromise(ctx.agent.list())
  const reviewer = listed.data.find((entry) => String(entry.id) === "reviewer")
  const body = builtinTeams.find((team) => team.name === "basic")?.members.find((member) => member.id === "reviewer")?.body
  expect(reviewer?.system).toBe(body)
})

test("the snapshot round-trips link, entry and preset records and the basedOn fields, and a TUI save keeps them", async () => {
  const project = await tempProject()
  const loaded = await load(project)
  const stored: StoredRecord[] = [
    link({ level: "project", agent: "alpha" }, { kind: "agent", id: "build" }),
    link({ level: "project", agent: "helper", team: { level: "project", team: "crew" } }, { kind: "member", team: "basic", id: "implementer" }),
    { type: "entry", level: "defaults", catalogue: "agents", name: "*orchestrator*", updated: UPDATED },
    { type: "entry", level: "defaults", catalogue: "teams", team: "crew", name: "helper", updated: UPDATED },
    { type: "preset", level: "preset", kind: "agent", id: "mine", fields: { description: "Mine" }, updated: UPDATED },
    {
      type: "customization",
      level: "project",
      agent: "alpha",
      item: "tool:bash",
      section: null,
      state: "off",
      pin: true,
      basedOn: "fp",
      basedOnState: "on",
      basedOnPin: false,
      updated: UPDATED,
    },
    { type: "model", level: "project", agent: "alpha", providerID: "acme", modelID: "nova", active: true, basedOn: "acme/old", updated: UPDATED },
  ]
  const saved = await save(project, { expectedProjectRevision: loaded.projectRevision, expectedGlobalRevision: loaded.globalRevision, records: stored })
  expect(saved.ok).toBe(true)
  const handlers = createHandlers(fullContext({ directory: project, agents: [agentInfo("alpha", "")] }), createState())
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  // The wire: encode as JSON, decode back, nothing lost, no undefined keys.
  const wire = JSON.parse(JSON.stringify(Schema.encodeSync(Plus.Snapshot)(snapshot)))
  const decoded = Schema.decodeUnknownSync(Plus.Snapshot)(wire)
  expect(decoded.links).toHaveLength(2)
  expect(decoded.links).toContainEqual({
    type: "link",
    level: "project",
    agent: "helper",
    team: { level: "project", team: "crew" },
    preset: { kind: "member", team: "basic", id: "implementer" },
    updated: UPDATED,
  })
  expect(decoded.entries).toContainEqual({ type: "entry", level: "defaults", catalogue: "teams", team: "crew", name: "helper", updated: UPDATED })
  expect(decoded.presets).toEqual([
    { type: "preset", level: "preset", kind: "agent", id: "mine", fields: { description: "Mine" }, updated: UPDATED },
  ])
  const custom = decoded.records.find((record) => record.type === "customization")
  expect(custom).toMatchObject({ basedOnState: "on", basedOnPin: false })
  const model = decoded.records.find((record) => record.type === "model")
  expect(model).toMatchObject({ basedOn: "acme/old" })
  // The client reads the same context the server builds.
  const memo = memoInputOf(decoded)
  expect(memo.links).toHaveLength(2)
  expect(memo.entries).toHaveLength(2)
  expect(contextOfSnapshot(decoded).links).toHaveLength(2)
  // A TUI whole-set save resubmits only inventory records; links, entries,
  // presets and the basedOn fields all survive it.
  const records = memo.records
  const resubmitted = toRpcRecords(
    records.filter((record): record is CustomizationRecord => record.type === "customization"),
    records.filter((record) => record.type === "split"),
    records.filter((record) => record.type === "model"),
    records.filter((record) => record.type === "rule"),
  )
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: decoded.revision, expectedGlobalRevision: decoded.globalRevision, records: resubmitted },
      throwingContext(),
    ),
  )
  expect(mutated.ok).toBe(true)
  const after = (await load(project)).records
  for (const record of stored) expect(after).toContainEqual(record)
})

test("the publish fingerprint moves when an agent is relinked", async () => {
  const project = await tempProject()
  const state = createState()
  const ctx = fullContext({ directory: project, agents: [agentInfo("alpha", "")] })
  const handlers = createHandlers(ctx, state)
  const relink = async (preset: PresetRef) => {
    const loaded = await load(project)
    const saved = await save(project, {
      expectedProjectRevision: loaded.projectRevision,
      expectedGlobalRevision: loaded.globalRevision,
      records: [...loaded.records.filter((record) => record.type !== "link"), link({ level: "defaults", agent: "alpha" }, preset)],
    })
    expect(saved.ok).toBe(true)
    await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext()))
    return state.fingerprint
  }
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext()))
  const unlinked = state.fingerprint
  const build = await relink({ kind: "agent", id: "build" })
  const planner = await relink({ kind: "member", team: "basic", id: "planner" })
  expect(unlinked).toBeDefined()
  expect(build).not.toBe(unlinked)
  expect(planner).not.toBe(build)
  // The republished tree reads the new link: alpha's role now follows Basic › planner.
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const role = expandedTree(memoInputOf(snapshot)).find((node) => node.id === "item:defaults:alpha:system:role")
  expect(role?.badges.source).toBe("preset")
})

// Phase 2b (DESIGN §6): the Basic member presets carry the old role answers
// as row overrides. Every override must name a row that exists, or it silently
// sets nothing.
test("every Basic member preset override names a row that exists", async () => {
  const { plusMemberOverrides } = await import("../src/instructions/presets.js")
  const { presetInput } = await import("./teams/preset-table.js")
  const basic = plusTeamPresets.find((team) => team.id === "basic")
  const input = presetInput({
    members: (basic?.members ?? []).map((member) => ({ id: member.id, team: "basic", preset: { kind: "member", team: "basic", id: member.id } })),
  })
  const ids = new Set(input.items.map((item) => item.id))
  const missing = Object.entries(plusMemberOverrides).flatMap(([team, members]) =>
    Object.entries(members).flatMap(([member, rows]) => Object.keys(rows).filter((id) => !ids.has(id)).map((id) => `${team} › ${member}: ${id}`)),
  )
  expect(missing).toEqual([])
  // Every override differs from the row's own shipped value: an override that
  // repeats it would hide a later change of the catalogue.
  const items = input.items
  const same = Object.entries(plusMemberOverrides).flatMap(([team, members]) =>
    Object.entries(members).flatMap(([member, rows]) =>
      Object.entries(rows).flatMap(([id, override]) => {
        const item = items.find((entry) => entry.id === id && entry.agents === undefined)
        if (item === undefined || override.state === undefined) return []
        return (item.enabled ? "on" : "off") === override.state ? [`${team} › ${member}: ${id}`] : []
      }),
    ),
  )
  expect(same.toSorted()).toEqual(
    [
      // Stated on purpose: the member's own team rules, whatever the catalogue ships.
      "basic › planner: tool:question",
      "basic › planner: perm:edit:allowed.plans",
      "basic › planner: perm:team_get_context:bootstrap.chat",
      "basic › orchestrator: tool:shell",
      "basic › orchestrator: perm:team_get_context:bootstrap.chat",
      "basic › orchestrator: perm:team_delegate:access.delegated",
      "basic › build-seat: tool:shell",
      "basic › build-seat: tool:question",
      "basic › build-seat: tool:subagent",
      "basic › build-seat: perm:team_get_context:bootstrap.chat",
      "basic › build-seat: perm:team_delegate:access.delegated",
    ].toSorted(),
  )
})

test("the Basic member presets open Delegate to rows for their teammates' roles", async () => {
  const { plusMemberOverrides } = await import("../src/instructions/presets.js")
  const team = plusMemberOverrides["basic"] ?? {}
  const opened = (member: string) =>
    Object.entries(team[member] ?? {})
      .filter(([id, row]) => id.startsWith("perm:team_delegate:to.") && row.state === "on")
      .map(([id]) => id.slice("perm:team_delegate:to.".length))
      .toSorted()
  expect(opened("planner")).toEqual(["orchestrator"])
  expect(opened("orchestrator")).toEqual(["implementer", "reviewer", "scout"])
  expect(opened("build-seat")).toEqual(["implementer", "orchestrator", "planner", "reviewer", "scout"].toSorted())
  for (const member of ["implementer", "reviewer", "scout"]) expect([member, opened(member)]).toEqual([member, []])
  // Members of other teams are not named: only the teammate's own row is on.
  expect(opened("planner")).not.toContain("other-teams")
})
