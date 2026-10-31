// Members' rows per team (backlog instructions-tools-fixes, phase 4, cause 4,
// finding b-11): a member's own rows are stored with its team, so an edit of
// one member changes neither the member of that name in another team nor the
// stand-alone agent of that name; rename and delete take them along; and a
// store written before keeps resolving as it did (the load migration).
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
import { memberRowsPerTeam } from "../src/instructions/owner-records.js"
import { globalLogPath, globalRecordsPath } from "../src/instructions/paths.js"
import { load, type StoredRecord } from "../src/instructions/store.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { expandedTree } from "../src/instructions/tree.js"
import { registerInstructionTools } from "../src/tools.js"
import { agentInfo, fullContext, skillInfo } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

type Tools = Map<string, Tool.Info & { readonly id: string }>

const UPDATED = "2026-10-30T00:00:00.000Z"

async function home(): Promise<{ root: string; project: string; config: string }> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-member-scope-"))
  roots.push(root)
  const config = path.join(root, "config")
  process.env.OPENCODE_CONFIG_DIR = config
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  return { root, project, config }
}

async function plus(project: string): Promise<{ api: PlusApi; tools: Tools }> {
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build")],
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "writer", description: "write things", options: { codemode: false } },
    ],
    skills: [skillInfo("notes", "skill body")],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  return { api, tools: await readTools(ctx) }
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

async function ok(tools: Tools, name: string, input: unknown) {
  const tool = tools.get(`instructions_${name}`)
  if (tool === undefined) throw new Error(`missing instructions_${name}`)
  const context = { sessionID: Session.ID.make("ses_memberscope"), agent: Agent.ID.make("build"), messageID: SessionMessage.ID.make("msg_memberscope"), id: Tool.CallID.make("call_memberscope"), progress: () => Effect.void }
  const result = await Effect.runPromise(tool.execute(input, context).pipe(
    Effect.map((value) => ({ ok: true as const, output: (value as { output: unknown }).output })),
    Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, message: error.message })),
  ))
  if (!result.ok) throw new Error(`instructions_${name} failed: ${result.message}`)
  return result.output as any
}

async function states(api: PlusApi, ids: readonly string[]): Promise<(string | undefined)[]> {
  const rows = expandedTree(memoInputOf((await api.snapshot()).value))
  return ids.map((id) => rows.find((row) => row.id === id)?.badges.state)
}

async function teamWith(tools: Tools, level: "project" | "global", team: string, member: string) {
  await ok(tools, "create", { kind: "team", team, level })
  await ok(tools, "create", { kind: "member", team, level, id: member, preset: "build" })
}

test.each(["project", "global"] as const)("b-11 at %s: one member's edit changes neither the member of that name in another team nor the agent of that name", async (level) => {
  const { project } = await home()
  const { api, tools } = await plus(project)
  await teamWith(tools, level, "aa", "scout")
  await teamWith(tools, level, "bb", "scout")
  await ok(tools, "create", { kind: "agent", id: "scout", scope: level, preset: "build" })
  const rows = [`item:${level}:aa/:scout:tool:reader`, `item:${level}:bb/:scout:tool:reader`, `item:${level}:scout:tool:reader`]
  expect(await states(api, rows)).toEqual(["on", "on", "on"])

  await ok(tools, "set", { id: rows[0], state: "off" })
  expect(await states(api, rows)).toEqual(["off", "on", "on"])
  const reader = (await load(project)).records.filter((record) => record.type === "customization" && record.item === "tool:reader")
  expect(reader).toMatchObject([{ level, agent: "scout", team: { level, team: "aa" }, state: "off" }])

  // And the other way round: the agent's edit stays the agent's.
  await ok(tools, "set", { id: rows[2], state: "off" })
  expect(await states(api, rows)).toEqual(["off", "on", "off"])
})

test("b-11: a renamed member keeps its rows, and so does a renamed team; nothing is left orphaned", async () => {
  const { project } = await home()
  const { api, tools } = await plus(project)
  await teamWith(tools, "project", "nm", "scout")
  await ok(tools, "set", { id: "item:project:nm/:scout:tool:reader", state: "off" })
  await ok(tools, "set", { id: "team:project:nm:scout", rename: "scout2" })
  expect(await states(api, ["item:project:nm/:scout2:tool:reader"])).toEqual(["off"])
  await ok(tools, "set", { id: "team:project:nm", rename: "nm2" })
  expect(await states(api, ["item:project:nm2/:scout2:tool:reader"])).toEqual(["off"])
  expect(await ok(tools, "find", { is: "orphaned" })).toMatchObject({ total: 0 })
  expect((await load(project)).records.filter((record) => record.type === "customization")).toMatchObject([{ agent: "scout2", team: { level: "project", team: "nm2" } }])
})

test("a deleted member's rows go with it, and the agent of its name keeps its own", async () => {
  const { project } = await home()
  const { api, tools } = await plus(project)
  await teamWith(tools, "project", "aa", "scout")
  await ok(tools, "create", { kind: "member", team: "aa", level: "project", id: "hand", preset: "build" })
  await ok(tools, "create", { kind: "agent", id: "scout", scope: "project", preset: "build" })
  await ok(tools, "set", { id: "item:project:aa/:scout:tool:reader", state: "off" })
  await ok(tools, "set", { id: "item:project:scout:tool:writer", state: "off" })
  await ok(tools, "delete", { id: "team:project:aa:scout", confirm: true })
  const left = (await load(project)).records.filter((record) => record.type === "customization")
  expect(left).toMatchObject([{ agent: "scout", item: "tool:writer" }])
  expect(left[0]).not.toHaveProperty("team")
  // A member of that name added again starts clean.
  await ok(tools, "create", { kind: "member", team: "aa", level: "project", id: "scout", preset: "build" })
  expect(await states(api, ["item:project:aa/:scout:tool:reader", "item:project:aa/:scout:tool:writer"])).toEqual(["on", "on"])
})

test("a member's copy into the same team carries its own rows; a team's copy carries every member's", async () => {
  const { project } = await home()
  const { api, tools } = await plus(project)
  await teamWith(tools, "project", "aa", "scout")
  await ok(tools, "set", { id: "item:project:aa/:scout:tool:reader", state: "off" })
  await ok(tools, "clipboard", { action: "duplicate", ids: ["team:project:aa:scout"] })
  await ok(tools, "clipboard", { action: "duplicate", ids: ["team:project:aa"] })
  expect(await states(api, ["item:project:aa/:scout-copy:tool:reader", "item:project:aa-copy/:scout:tool:reader", "item:project:aa-copy/:scout-copy:tool:reader"])).toEqual(["off", "off", "off"])
  // The copies are not linked to the original's rows.
  await ok(tools, "set", { id: "item:project:aa/:scout:tool:reader", state: "on" })
  expect(await states(api, ["item:project:aa/:scout:tool:reader", "item:project:aa-copy/:scout:tool:reader"])).toEqual(["on", "off"])
})

test("a paste onto a member writes that member's rows only", async () => {
  const { project } = await home()
  const { api, tools } = await plus(project)
  await teamWith(tools, "project", "aa", "scout")
  await teamWith(tools, "project", "bb", "scout")
  await ok(tools, "set", { id: "item:project:build:tool:reader", state: "off" })
  const copied = await ok(tools, "clipboard", { action: "copy", ids: ["item:project:build:tool:reader"] })
  await ok(tools, "clipboard", { action: "paste", clipboard: copied.clipboard, into: "team:project:aa:scout" })
  expect(await states(api, ["item:project:aa/:scout:tool:reader", "item:project:bb/:scout:tool:reader"])).toEqual(["off", "on"])
})

// A store written before: the member's own rows are its name's, in a file
// whose header has no `members` mark.
async function legacyStore(project: string, records: readonly object[]) {
  const file = path.join(project, ".opencodeplus", "instructions", "records.jsonl")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, [JSON.stringify({ version: 2, revision: 7 }), ...records.map((record) => JSON.stringify(record))].join("\n") + "\n")
  await fs.mkdir(path.dirname(globalRecordsPath()), { recursive: true })
  await Bun.write(globalRecordsPath(), `${JSON.stringify({ version: 2, revision: 3 })}\n`)
  for (const team of ["aa", "bb"]) {
    const dir = path.join(project, ".opencodeplus", "teams", team)
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "scout.md"), formatMarkdown({ mode: "primary" }, ""))
  }
}

const legacy = [
  { type: "team", level: "project", team: "aa", enabled: true, updated: UPDATED },
  { type: "customization", level: "project", agent: "scout", item: "tool:reader", section: null, state: "off", basedOn: "x", updated: UPDATED },
  { type: "customization", level: "project", agent: "scout", item: "tool:writer", section: null, text: "Scout writes.", basedOn: "x", updated: UPDATED },
  // What the member's team node held already wins over its name's.
  { type: "customization", level: "project", agent: "scout", team: { level: "project", team: "bb" }, item: "tool:reader", section: null, state: "on", basedOn: "x", updated: UPDATED },
]

test("upgrade: a member's per-name rows are copied to every team that has it, and the agent of that name keeps them", async () => {
  const { project } = await home()
  await legacyStore(project, legacy)
  const loaded = await load(project)
  expect(loaded.membersMoved).toBe(true)
  const customizations = loaded.records.filter((record) => record.type === "customization").map((record) => record.type === "customization" ? [record.team?.team ?? "-", record.item, record.state ?? "", record.text ?? ""] : [])
  expect(customizations.toSorted()).toEqual([
    ["-", "tool:reader", "off", ""],
    ["-", "tool:writer", "", "Scout writes."],
    ["aa", "tool:reader", "off", ""],
    ["aa", "tool:writer", "", "Scout writes."],
    ["bb", "tool:reader", "on", ""],
    ["bb", "tool:writer", "", "Scout writes."],
  ])
})

test("upgrade: the migration is saved once, marks both headers, and a later agent edit stays the agent's", async () => {
  const { project } = await home()
  await legacyStore(project, legacy)
  const { api, tools } = await plus(project)
  const rows = ["item:project:aa/:scout:tool:reader", "item:project:bb/:scout:tool:reader"]
  expect(await states(api, rows)).toEqual(["off", "on"])
  for (const file of [path.join(project, ".opencodeplus", "instructions", "records.jsonl"), globalRecordsPath()])
    expect(JSON.parse((await Bun.file(file).text()).split("\n")[0]!)).toMatchObject({ version: 2, members: "team" })
  const log = (await Bun.file(globalLogPath()).text()).split("\n").filter((line) => line.includes("migrate.members"))
  expect(log).toHaveLength(1)
  const again = await load(project)
  expect([again.membersMigrated, again.membersMoved]).toEqual([false, false])
  // After the upgrade the name's records are the stand-alone agent's alone.
  await ok(tools, "create", { kind: "agent", id: "scout", scope: "project" })
  const before = await states(api, ["item:project:aa/:scout:tool:writer", "item:project:bb/:scout:tool:writer"])
  await ok(tools, "set", { id: "item:project:scout:tool:writer", state: "on" })
  expect(await states(api, ["item:project:aa/:scout:tool:writer", "item:project:bb/:scout:tool:writer", "item:project:scout:tool:writer"])).toEqual([...before, "on"])
  expect(before).toEqual(["off", "off"])
})

test("memberRowsPerTeam merges field by field under the team node, is idempotent and leaves members without records alone", () => {
  const team = { level: "project" as const, team: "aa" }
  const records: StoredRecord[] = [
    { type: "customization", level: "project", agent: "scout", item: "tool:reader", section: null, text: "Name text", state: "off", basedOn: "x", basedOnState: "on", updated: UPDATED },
    { type: "customization", level: "project", agent: "scout", team, item: "tool:reader", section: null, state: "on", basedOn: "y", updated: UPDATED },
    { type: "model", level: "project", agent: "scout", providerID: "acme", modelID: "nova", active: true, updated: UPDATED },
    { type: "link", level: "project", agent: "scout", preset: { kind: "agent", id: "build" }, updated: UPDATED },
  ]
  const teams = [{ level: "project" as const, team: "aa", agents: ["scout", "hand"] }]
  const moved = memberRowsPerTeam(records, teams)
  expect(moved.migrated).toBe(true)
  const atTeam = moved.records.filter((record) => "team" in record && record.team?.team === "aa")
  expect(atTeam).toEqual([
    { type: "customization", level: "project", agent: "scout", team, item: "tool:reader", section: null, state: "on", basedOn: "y", text: "Name text", updated: UPDATED },
    { type: "model", level: "project", agent: "scout", team, providerID: "acme", modelID: "nova", active: true, updated: UPDATED },
    { type: "link", level: "project", agent: "scout", team, preset: { kind: "agent", id: "build" }, updated: UPDATED },
  ])
  // The name keeps its own.
  expect(moved.records.filter((record) => !("team" in record) || record.team === undefined)).toHaveLength(3)
  expect(memberRowsPerTeam(moved.records, teams)).toMatchObject({ migrated: false })
  expect(memberRowsPerTeam(records.filter((record) => record.type === "link"), [{ level: "global", team: "aa", agents: ["scout"] }])).toMatchObject({ migrated: false })
})
