// A copy holds only changes (backlog instructions-tools-fixes, phase 1): a
// duplicated agent, member, team or preset follows the preset its original
// follows and carries the original's own records, one per address, so it
// resolves row for row like the original while it stores about as many
// records as the original has own ones. And the refusals around it: names,
// several ids, a System row's copy, and pastes that write only what they plan.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { createPlusApi, createState, type PlusApi } from "../src/index.js"
import { formatMarkdown } from "../src/agents/files.js"
import { upstreamFor } from "../src/instructions/inherited.js"
import { rowTeamOf, sectionResolveOf, wholeOf } from "../src/instructions/resolve-memo.js"
import { load, save, type StoredRecord } from "../src/instructions/store.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { buildTreeMemo, expandedTree } from "../src/instructions/tree.js"
import { registerInstructionTools } from "../src/tools.js"
import { agentInfo, fullContext, modelInfo, skillInfo } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

type Tools = Map<string, Tool.Info & { readonly id: string }>

async function fixture(): Promise<{ api: PlusApi; tools: Tools; project: string }> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-duplicate-changes-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await Bun.write(path.join(project, ".opencode", "agent", "alpha.md"), formatMarkdown({ description: "Alpha", mode: "primary" }, "Alpha's own prompt.\n"))
  await Bun.write(path.join(project, ".opencode", "agent", "beta.md"), formatMarkdown({ description: "Beta", mode: "primary" }, "Beta's prompt.\n"))
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha"), agentInfo("beta"), agentInfo("build")],
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "writer", description: "write things", options: { codemode: false } },
      { id: "skill", description: "Load a skill", options: { codemode: false } },
    ],
    skills: [skillInfo("notes", "skill body")],
    models: [modelInfo("acme", "nova-2"), modelInfo("acme", "nova-3")],
    classifications: { "nova-2": "general", "nova-3": "general" },
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  return { api, tools: await readTools(ctx), project }
}

async function readTools(ctx: Context): Promise<Tools> {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
    yield* ctx.tool.transform((editor) => {
      Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
    })
    return new Map((yield* Deferred.await(deferred)).map((tool) => [tool.id, tool]))
  })))
}

async function call(tools: Tools, name: string, input: unknown): Promise<{ readonly ok: true; readonly output: any } | { readonly ok: false; readonly message: string }> {
  const tool = tools.get(`instructions_${name}`)
  if (tool === undefined) throw new Error(`missing instructions_${name}`)
  const context = { sessionID: Session.ID.make("ses_dupchanges"), agent: Agent.ID.make("alpha"), messageID: SessionMessage.ID.make("msg_dupchanges"), id: Tool.CallID.make("call_dupchanges"), progress: () => Effect.void }
  return Effect.runPromise(tool.execute(input, context).pipe(
    Effect.map((result) => ({ ok: true as const, output: (result as { output: unknown }).output })),
    Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, message: error.message })),
  ))
}

async function ok(tools: Tools, name: string, input: unknown) {
  const result = await call(tools, name, input)
  if (!result.ok) throw new Error(`instructions_${name} failed: ${result.message}`)
  return result.output
}

async function refused(tools: Tools, name: string, input: unknown): Promise<string> {
  const result = await call(tools, name, input)
  if (result.ok) throw new Error(`instructions_${name} succeeded: ${JSON.stringify(result.output)}`)
  return result.message
}

/**
 * Every row of one owner, as it resolves: on/off, the value and summary a row
 * shows, a model's settings and whether it is active, and the text it sends
 * (a rule's patterns included). Keyed by the row id with the owner segment
 * (`alpha`, `crew/:lead`, …) cut out; where a value comes from is left out —
 * it is "set here" for a copy's own record and "from preset X" for the copy's
 * inherited one, which is the point.
 */
async function resolvedRows(api: PlusApi, owner: string, level = "project"): Promise<Map<string, string>> {
  // Which base prompt a preset row marks active comes from the native agent
  // named like the preset (its model), not from the preset's content, so a
  // preset named otherwise marks none; agents made from either get the same.
  const input = memoInputOf((await api.snapshot()).value)
  const memo = buildTreeMemo(input)
  const pattern = new RegExp(`^(\\w+):${level}:${owner.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?=:|$)`)
  const out = new Map<string, string>()
  for (const row of expandedTree(input)) {
    if (!pattern.test(row.id)) continue
    const address = row.address
    const item = address === undefined ? undefined : upstreamFor(memo.ctx.items, address)
    const text = address === undefined || item === undefined
      ? undefined
      : address.section === null
        ? wholeOf(memo, address.level, address.agent, item, address.catalogue, rowTeamOf(address)).fullText
        : sectionResolveOf(memo, address.level, address.agent, item, address.section, address.catalogue, rowTeamOf(address)).fullText
    const badges = row.badges
    out.set(row.id.replace(pattern, "$1:<owner>"), JSON.stringify([
      badges.state, badges.summary, badges.value, level === "preset" && row.address?.item.startsWith("base:") === true ? undefined : badges.active, badges.pinned, badges.hidden, badges.mode,
      badges.warming, badges.interval, badges.waiting, badges.subagent, badges.prompt, text,
    ]))
  }
  return out
}

function differing(original: Map<string, string>, copy: Map<string, string>): string[] {
  return [...new Set([...original.keys(), ...copy.keys()])].filter((key) => original.get(key) !== copy.get(key)).map((key) => `${key}: ${original.get(key)} | ${copy.get(key)}`)
}

/** Records one owner stores: at a level, for an agent name, optionally in a team. */
async function owned(project: string, predicate: (record: StoredRecord) => boolean) {
  const records = (await load(project)).records.filter((record) => record.type !== "folder" && record.type !== "order" && record.type !== "link" && predicate(record))
  return records
}

const agentAt = (level: string, agent: string) => (record: StoredRecord) =>
  "agent" in record && record.agent === agent && record.level === level && (!("team" in record) || record.team === undefined)

test("a copy of a preset-linked agent follows the same preset, carries only the original's own records, and resolves row for row like it", async () => {
  const { api, tools, project } = await fixture()
  await ok(tools, "set", { id: "agent:project:alpha", preset: "build" })
  await ok(tools, "set", { id: "item:project:alpha:tool:reader", text: "Alpha reads carefully." })
  await ok(tools, "set", { id: "item:project:alpha:tool:reader", state: "off" })
  await ok(tools, "set", { id: "item:project:alpha:skill:notes", state: "off" })
  await ok(tools, "set", { id: "item:project:alpha:setting:mode", text: "subagent" })
  await ok(tools, "create", { kind: "model", providerID: "acme", modelID: "nova-2", level: "project", agent: "alpha" })
  await ok(tools, "set", { id: "item:project:alpha:model:acme/nova-2", warming: "45m" })
  const own = (await owned(project, agentAt("project", "alpha"))).length
  expect(own).toBeGreaterThan(0)

  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha"] })
  expect(copy.rows).toEqual(["agent:project:alpha-copy"])
  expect(copy.status).toStartWith("Duplicated alpha as alpha-copy, following preset")

  // The same link as the original, not one to the original.
  const links = (await load(project)).records.filter((record) => record.type === "link" && record.agent === "alpha-copy")
  expect(links.map((record) => record.type === "link" ? record.preset : undefined)).toEqual([{ kind: "agent", id: "build" }])
  // As many records as the original's own, one per address.
  const stored = await owned(project, agentAt("project", "alpha-copy"))
  expect(stored.length).toBe(own)
  const original = await resolvedRows(api, "alpha")
  expect(original.size).toBeGreaterThan(50)
  expect(differing(original, await resolvedRows(api, "alpha-copy"))).toEqual([])
})

test("a built-in agent's copy follows its shipped preset and folds the Global edits it read into its own, row for row", async () => {
  const { api, tools, project } = await fixture()
  await ok(tools, "set", { id: "item:project:build:tool:reader", state: "off" })
  await ok(tools, "set", { id: "item:global:build:tool:writer", state: "off" })
  await ok(tools, "set", { id: "item:global:build:tool:reader", text: "Global build reads." })
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:build"], name: "builder" })
  expect(copy.rows).toEqual(["agent:project:builder"])
  const links = (await load(project)).records.filter((record) => record.type === "link" && record.agent === "builder")
  expect(links.map((record) => record.type === "link" ? record.preset : undefined)).toEqual([{ kind: "agent", id: "build" }])
  // Project reader (on/off) and the Global text of reader merge into one record; writer is the other.
  const stored = await owned(project, agentAt("project", "builder"))
  expect(stored.filter((record) => record.type === "customization").map((record) => record.type === "customization" ? [record.item, record.state, record.text] : []).toSorted())
    .toEqual([["tool:reader", "off", "Global build reads."], ["tool:writer", "off", undefined]])
  expect(differing(await resolvedRows(api, "build"), await resolvedRows(api, "builder"))).toEqual([])
})

test("a built-in agent's copy keeps one active model: the project's, not a Global one folded onto a project record", async () => {
  const { api, tools, project } = await fixture()
  await ok(tools, "create", { kind: "model", providerID: "acme", modelID: "nova-3", level: "global", agent: "build" })
  await ok(tools, "set", { id: "item:global:build:model:acme/nova-3", active: true })
  await ok(tools, "create", { kind: "model", providerID: "acme", modelID: "nova-2", level: "project", agent: "build" })
  await ok(tools, "set", { id: "item:project:build:model:acme/nova-2", active: true })
  await ok(tools, "set", { id: "item:project:build:model:acme/nova-3", warming: "45m" })
  await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:build"], name: "builder" })
  const actives = (await load(project)).records.filter((record) => record.type === "model" && record.agent === "builder" && record.active === true)
  expect(actives.map((record) => record.type === "model" ? record.modelID : undefined)).toEqual(["nova-2"])
  expect(differing(await resolvedRows(api, "build"), await resolvedRows(api, "builder"))).toEqual([])
})

test("a member's copy follows its member's preset and carries its own records; a team's copy every member's, row for row", async () => {
  const { api, tools, project } = await fixture()
  await ok(tools, "create", { kind: "team", team: "crew", level: "project" })
  await ok(tools, "create", { kind: "member", team: "crew", level: "project", id: "lead", preset: "build" })
  await ok(tools, "create", { kind: "member", team: "crew", level: "project", id: "hand" })
  await ok(tools, "set", { id: "item:project:crew/:lead:tool:reader", state: "off" })
  await ok(tools, "set", { id: "item:project:crew/:lead:tool:writer", text: "Lead writes tidy." })
  await ok(tools, "set", { id: "item:project:crew/:hand:tool:writer", state: "on" })
  const own = (await owned(project, agentAt("project", "lead"))).length

  const member = await ok(tools, "clipboard", { action: "duplicate", ids: ["team:project:crew:lead"] })
  expect(member).toEqual({ status: "Duplicated lead as lead-copy, following preset Build as lead does", rows: ["team:project:crew:lead-copy"] })
  expect((await load(project)).records.filter((record) => record.type === "link" && record.agent === "lead-copy").map((record) => record.type === "link" ? record.preset : undefined))
    .toEqual([{ kind: "agent", id: "build" }])
  expect((await owned(project, agentAt("project", "lead-copy"))).length).toBe(own)
  expect(differing(await resolvedRows(api, "crew/:lead"), await resolvedRows(api, "crew/:lead-copy"))).toEqual([])

  const customizations = (await load(project)).records.filter((record) => record.type === "customization").length
  const team = await ok(tools, "clipboard", { action: "duplicate", ids: ["team:project:crew"] })
  expect(team.rows).toEqual(["team:project:crew-copy"])
  expect(team.status).toContain('Duplicated team "crew" as "crew-copy": 3 of 3 members copied')
  for (const name of ["lead", "hand", "lead-copy"])
    expect(differing(await resolvedRows(api, `crew/:${name}`), await resolvedRows(api, `crew-copy/:${name}`)), name).toEqual([])
  // Members keep their names, so their own rows are shared (stored per name):
  // the team's copy adds no customization, only its members' links.
  const after = (await load(project)).records
  expect(after.filter((record) => record.type === "customization").length).toBe(customizations)
  expect(after.filter((record) => record.type === "link" && record.team?.team === "crew-copy").map((record) => record.type === "link" ? [record.agent, record.preset] : []).toSorted())
    .toEqual([["lead", { kind: "agent", id: "build" }], ["lead-copy", { kind: "agent", id: "build" }]])
})

test("a preset's copy is a user preset that follows what the original follows and carries its own records, row for row", async () => {
  const { api, tools, project } = await fixture()
  await ok(tools, "create", { kind: "preset", id: "careful", from: "build" })
  await ok(tools, "set", { id: "item:preset:careful:tool:reader", state: "off" })
  await ok(tools, "set", { id: "item:preset:careful:tool:writer", text: "Careful writes." })
  const preset = (record: StoredRecord) => "agent" in record && record.level === "preset" && (!("team" in record) || record.team === undefined)
  const own = (await owned(project, (record) => preset(record) && "agent" in record && record.agent === "careful")).length
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:preset:careful"] })
  expect(copy).toEqual({ status: "Duplicated preset careful as careful-copy, following preset Build", rows: ["agent:preset:careful-copy"] })
  const links = (await load(project)).records.filter((record) => record.type === "link" && record.level === "preset" && record.agent === "careful-copy")
  // It follows careful's preset, not careful.
  expect(links.map((record) => record.type === "link" ? record.preset : undefined)).toEqual([{ kind: "agent", id: "build" }])
  expect((await owned(project, (record) => preset(record) && "agent" in record && record.agent === "careful-copy")).length).toBe(own)
  expect(differing(await resolvedRows(api, "careful", "preset"), await resolvedRows(api, "careful-copy", "preset"))).toEqual([])

  // A shipped preset's copy follows it, and writes nothing it inherits.
  const shipped = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:preset:build"] })
  expect(shipped.status).toBe("Duplicated preset build as build-copy, following preset Build")
  expect(await owned(project, (record) => preset(record) && "agent" in record && record.agent === "build-copy")).toEqual([])
  expect(differing(await resolvedRows(api, "build", "preset"), await resolvedRows(api, "build-copy", "preset"))).toEqual([])
})

test("a shipped team preset's copy has its members, each following the shipped member, and writes no inherited value", async () => {
  const { api, tools, project } = await fixture()
  const before = (await load(project)).records.filter((record) => record.type === "customization").length
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["team:preset:basic"] })
  expect(copy.rows).toEqual(["team:preset:basic-copy"])
  expect((await load(project)).records.filter((record) => record.type === "customization").length).toBe(before)
  expect(differing(await resolvedRows(api, "basic/:planner", "preset"), await resolvedRows(api, "basic-copy/:planner", "preset"))).toEqual([])
}, 60_000)

test("a copy refuses a name an agent has, built-ins included, a name with a space, and a name for several ids", async () => {
  const { tools, project } = await fixture()
  const before = await load(project)
  expect(await refused(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha"], name: "build" })).toBe('name.taken: an agent named "build" exists already (a built-in agent); give the copy another name')
  expect(await refused(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha"], name: "beta" })).toBe('name.taken: an agent named "beta" exists already; give the copy another name')
  expect(await refused(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha"], name: "two words" })).toContain('name.invalid: "two words" cannot name a copy')
  expect(await refused(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha", "agent:project:beta"], name: "zz" })).toContain("name.invalid: name names one copy, but ids holds 2 rows; nothing was duplicated")
  expect(await load(project)).toEqual(before)
  expect(await Bun.file(path.join(project, ".opencode", "agent", "build.md")).exists()).toBe(false)
})

test("several ids: each row that can be copied is, and the status names every copy and every row left, with its reason", async () => {
  const { tools } = await fixture()
  const result = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha", "item:project:alpha:tool:reader", "agent:project:beta"] })
  expect(result.rows).toEqual(["agent:project:alpha-copy", "agent:project:beta-copy"])
  expect(result.status).toBe('Duplicated 2 of 3 rows: Duplicated alpha as alpha-copy; Duplicated beta as beta-copy; not duplicated (1): item:project:alpha:tool:reader: "reader" exists once for each agent: copy it (ctrl+c) and paste it (ctrl+v) onto another agent instead')
})

test("a System row's copy starts off for every agent, so its text is not sent twice", async () => {
  const { api, tools } = await fixture()
  await ok(tools, "create", { kind: "system", id: "mine", title: "Mine", text: "My rules" })
  await ok(tools, "set", { id: "item:project:alpha:system:mine", state: "on" })
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["item:project:alpha:system:mine"] })
  expect(copy.status).toStartWith('Duplicated "Mine" as "Mine copy" (off for every agent')
  const rows = expandedTree(memoInputOf((await api.snapshot()).value))
  expect(rows.find((row) => row.id === "item:project:alpha:system:mine")?.badges.state).toBe("on")
  for (const owner of ["alpha", "beta", "build"])
    expect(rows.find((row) => row.id === `item:project:${owner}:system:mine-copy`)?.badges.state, owner).toBe("off")
  const builtIn = await ok(tools, "clipboard", { action: "duplicate", ids: ["item:project:alpha:system:tools-and-rules"] })
  const after = expandedTree(memoInputOf((await api.snapshot()).value))
  expect(after.find((row) => row.id === builtIn.rows[0])?.badges.state).toBe("off")
  // On where it is turned on.
  await ok(tools, "set", { id: "item:project:alpha:system:mine-copy", state: "on" })
  expect(expandedTree(memoInputOf((await api.snapshot()).value)).find((row) => row.id === "item:project:alpha:system:mine-copy")?.badges.state).toBe("on")
})

test("a paste writes only the records it planned: another owner's records, a second record at one address included, stay as stored", async () => {
  const { tools, project } = await fixture()
  await ok(tools, "set", { id: "item:project:beta:tool:writer", state: "on" })
  await ok(tools, "set", { id: "item:project:beta:tool:reader", text: "Beta reads." })
  // What an older copy left: two records at one address, and an edit equal to what the row inherits.
  const loaded = await load(project)
  const extra: StoredRecord[] = [
    { type: "customization", level: "project", agent: "beta", item: "tool:reader", section: null, state: "off", basedOn: "x", updated: "2026-10-30T00:00:00.000Z" },
    { type: "customization", level: "project", agent: "beta", item: "tool:skill", section: null, state: "on", basedOn: "x", updated: "2026-10-30T00:00:00.000Z" },
  ]
  const saved = await save(project, { expectedProjectRevision: loaded.projectRevision, expectedGlobalRevision: loaded.globalRevision, records: [...loaded.records, ...extra] })
  expect(saved.ok).toBe(true)
  const others = async () => (await load(project)).records.filter((record) => "agent" in record && record.agent === "beta").map((record) => JSON.stringify(record)).toSorted()
  const before = await others()
  const copied = await ok(tools, "clipboard", { action: "copy", ids: ["item:project:build:tool:reader"] })
  const pasted = await ok(tools, "clipboard", { action: "paste", clipboard: copied.clipboard, into: "agent:project:alpha" })
  expect(pasted.rows).toEqual(["item:project:alpha:tool:reader"])
  expect(await others()).toEqual(before)
})

test("a paste onto a team refuses to pick a member; onto a shipped preset's member it says that preset changes", async () => {
  const { tools, project } = await fixture()
  const copied = await ok(tools, "clipboard", { action: "copy", ids: ["item:project:build:tool:reader"] })
  const before = await load(project)
  expect(await refused(tools, "clipboard", { action: "paste", clipboard: copied.clipboard, into: "team:preset:basic" })).toContain("paste onto one of its members instead")
  expect(await load(project)).toEqual(before)
  const pasted = await ok(tools, "clipboard", { action: "paste", clipboard: copied.clipboard, into: "team:preset:basic:planner" })
  expect(pasted.rows).toEqual(["item:preset:basic/:planner:tool:reader"])
  expect(pasted.status).toContain("into the built-in preset")
  expect(pasted.status).toContain("every agent and team made from it gets this change")
}, 60_000)
