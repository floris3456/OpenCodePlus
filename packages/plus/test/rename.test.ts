// T6 (plan plus-1.1.12-instructions): rename agents, team members and teams.
// A rename moves the file/team directory and every stored record that names the
// thing in one store revision; built-ins, shipped Defaults rows, ancestor-backed
// agents and protected agents (tool actor) refuse. Session history keeps the
// old name. These tests exercise the real API boundary (no mocks of the code
// under test).
import { afterEach, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Agent as AgentSchema } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { agentPath } from "../src/agents/files.js"
import { createPlusApi, createState } from "../src/index.js"
import { load, save, type StoredRecord } from "../src/instructions/store.js"
import { registerInstructionTools } from "../src/tools.js"
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
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-rename-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "share")
  return path.join(root, "project")
}

// Append records to whichever store they route to, without disturbing existing
// ones (agents, teams and links written by earlier API calls stay).
async function seed(project: string, records: readonly StoredRecord[]): Promise<void> {
  const current = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: current.projectRevision,
    expectedGlobalRevision: current.globalRevision,
    records: [...current.records, ...records],
  })
  if (!saved.ok) throw new Error("seed save conflicted")
}

function teamNameOf(record: StoredRecord): string | undefined {
  if (!("team" in record)) return undefined
  const team = record.team
  return typeof team === "string" ? undefined : team?.team
}

const agentRecords = (level: "global" | "project", agent: string): StoredRecord[] => [
  { type: "customization", level, agent, item: "tool:bash", section: null, basedOn: "fp-bash", updated: UPDATED },
  { type: "split", level, agent, item: "system:role", boundaries: [{ id: "s1", name: "One", start: 0 }], updated: UPDATED },
  { type: "model", level, agent, providerID: "anthropic", modelID: "claude", updated: UPDATED },
  { type: "rule", level, agent, tool: "bash", id: "r1", label: "R", patterns: ["*"], keywords: [], updated: UPDATED },
  { type: "link", level, agent, preset: { kind: "agent", id: "planner" }, updated: UPDATED },
]

test("rename an agent moves its file and records of every kind and keeps resolution", async () => {
  const project = await tempProject()
  const ctx = fullContext({ directory: project, agents: [agentInfo("alice")] })
  const api = createPlusApi(ctx, createState())
  const created = await api.createAgent({ scope: "global", id: "alice" })
  expect(created.ok).toBe(true)
  await seed(project, agentRecords("global", "alice"))

  const renamed = await api.renameAgent({ scope: "global", from: "alice", to: "bob" })
  expect(renamed.ok).toBe(true)
  if (!renamed.ok) return

  expect(await Bun.file(await agentPath("global", project, "bob")).exists()).toBe(true)
  expect(await Bun.file(await agentPath("global", project, "alice")).exists()).toBe(false)

  const records = (await load(project)).records
  const moved = records.filter((record) => "agent" in record && record.agent === "bob")
  expect(moved.map((record) => record.type).toSorted()).toEqual(["customization", "link", "model", "rule", "split"])
  expect(records.some((record) => "agent" in record && record.agent === "alice")).toBe(false)

  // Resolution is unchanged: the new id owns the rows and the snapshot lists it.
  const snapshot = await api.snapshot()
  expect(snapshot.ok).toBe(true)
  if (!snapshot.ok) return
  const bob = snapshot.value.agents.find((entry) => entry.id === "bob")
  expect(bob?.fileBacked).toBe(true)
})

test("rename a member moves its records and the Delegate-to rows that name it", async () => {
  const project = await tempProject()
  const ctx = fullContext({ directory: project, agents: [agentInfo("alice"), agentInfo("bob")] })
  const api = createPlusApi(ctx, createState())
  expect((await api.createTeam({ level: "global", team: "crew" })).ok).toBe(true)
  expect((await api.addTeamAgent({ level: "global", team: "crew", id: "alice" })).ok).toBe(true)
  expect((await api.addTeamAgent({ level: "global", team: "crew", id: "bob" })).ok).toBe(true)
  const teamRef = { level: "global" as const, team: "crew" }
  await seed(project, [
    { type: "customization", level: "global", agent: "alice", team: teamRef, item: "tool:bash", section: null, basedOn: "fp", updated: UPDATED },
    { type: "model", level: "global", agent: "alice", team: teamRef, providerID: "anthropic", modelID: "claude", warming: "30m", interval: "3.5m", prompt: "keep-warm sentinel", updated: UPDATED },
    { type: "split", level: "global", agent: "alice", team: teamRef, item: "system:role", boundaries: [{ id: "s1", name: "One", start: 0 }], updated: UPDATED },
    { type: "rule", level: "global", agent: "alice", team: teamRef, tool: "bash", id: "r1", label: "R", patterns: ["*"], keywords: [], updated: UPDATED },
    { type: "link", level: "global", agent: "alice", team: teamRef, preset: { kind: "agent", id: "planner" }, updated: UPDATED },
    // A peer's "Delegate to alice" row must follow the member id.
    { type: "customization", level: "global", agent: "bob", team: teamRef, item: "perm:team_delegate:to.alice", section: null, basedOn: "fp", updated: UPDATED },
  ])

  const renamed = await api.renameAgent({ scope: "global", team: "crew", from: "alice", to: "carol" })
  expect(renamed.ok).toBe(true)

  const records = (await load(project)).records
  const aliceOwn = records.filter(
    (record) => "agent" in record && record.agent === "alice" && "team" in record && record.team?.team === "crew",
  )
  expect(aliceOwn).toEqual([])
  const carolOwn = records.filter(
    (record) => "agent" in record && record.agent === "carol" && "team" in record && record.team?.team === "crew",
  )
  expect(carolOwn.map((record) => record.type).toSorted()).toEqual(["customization", "link", "model", "rule", "split"])
  expect(carolOwn.find((record) => record.type === "split")).toMatchObject({ boundaries: [{ id: "s1", name: "One", start: 0 }] })
  expect(carolOwn.find((record) => record.type === "model")).toMatchObject({ warming: "30m", interval: "3.5m", prompt: "keep-warm sentinel" })
  const delegate = records.find((record) => record.type === "customization" && record.agent === "bob" && record.team?.team === "crew")
  expect(delegate?.type === "customization" ? delegate.item : undefined).toBe("perm:team_delegate:to.carol")

  const snapshot = await api.snapshot()
  expect(snapshot.ok).toBe(true)
  if (!snapshot.ok) return
  const crew = snapshot.value.teams?.find((team) => team.level === "global" && team.team === "crew")
  expect(crew?.agents).toContain("carol")
  expect(crew?.agents).not.toContain("alice")
})

// A member's own rows are stored with its team (phase 4, member-scope): a
// rename moves its team's Delegate-to rows and leaves the stand-alone agents'
// rows of the same names alone (before, the unteamed rows were the members').
test("rename a member moves its team's Delegate-to rows and leaves the stand-alone agents' rows", async () => {
  const project = await tempProject()
  const ctx = fullContext({ directory: project, agents: [agentInfo("alice"), agentInfo("bob"), agentInfo("eve")] })
  const api = createPlusApi(ctx, createState())
  expect((await api.createTeam({ level: "global", team: "crew" })).ok).toBe(true)
  expect((await api.addTeamAgent({ level: "global", team: "crew", id: "alice" })).ok).toBe(true)
  expect((await api.addTeamAgent({ level: "global", team: "crew", id: "bob" })).ok).toBe(true)
  const crew = { level: "global" as const, team: "crew" }
  await seed(project, [
    { type: "customization", level: "global", agent: "bob", team: crew, item: "perm:team_delegate:to.alice", section: null, basedOn: "fp", updated: UPDATED },
    { type: "customization", level: "global", agent: "alice", team: crew, item: "perm:team_delegate:to.alice", section: null, basedOn: "fp", updated: UPDATED },
    { type: "customization", level: "global", agent: "bob", item: "perm:team_delegate:to.alice", section: null, basedOn: "fp", updated: UPDATED },
    { type: "customization", level: "global", agent: "eve", item: "perm:team_delegate:to.alice", section: null, basedOn: "fp", updated: UPDATED },
  ])

  const renamed = await api.renameAgent({ scope: "global", team: "crew", from: "alice", to: "carol" })
  expect(renamed.ok).toBe(true)

  const records = (await load(project)).records
  const customize = records.filter((record): record is Extract<StoredRecord, { type: "customization" }> => record.type === "customization")
  expect(customize.find((record) => record.agent === "bob" && record.team !== undefined)).toMatchObject({ item: "perm:team_delegate:to.carol", team: crew })
  expect(customize.find((record) => record.agent === "carol")).toMatchObject({ item: "perm:team_delegate:to.carol", team: crew })
  expect(customize.some((record) => record.agent === "alice")).toBe(false)
  expect(customize.find((record) => record.agent === "bob" && record.team === undefined)).toMatchObject({ item: "perm:team_delegate:to.alice" })
  expect(customize.find((record) => record.agent === "eve")).toMatchObject({ item: "perm:team_delegate:to.alice" })
})

test("rename a team moves its directory, members, records and enablement", async () => {
  const project = await tempProject()
  const ctx = fullContext({ directory: project, agents: [agentInfo("alice")] })
  const api = createPlusApi(ctx, createState())
  expect((await api.createTeam({ level: "global", team: "crew" })).ok).toBe(true)
  expect((await api.addTeamAgent({ level: "global", team: "crew", id: "alice" })).ok).toBe(true)
  const enabled = await api.setTeamEnabled({ level: "global", team: "crew", enabled: true })
  expect(enabled.ok).toBe(true)
  const teamRef = { level: "global" as const, team: "crew" }
  await seed(project, [
    { type: "customization", level: "global", agent: "alice", team: teamRef, item: "tool:bash", section: null, basedOn: "fp", updated: UPDATED },
    { type: "model", level: "global", agent: "alice", team: teamRef, providerID: "anthropic", modelID: "claude", updated: UPDATED },
    { type: "link", level: "global", agent: "alice", team: teamRef, preset: { kind: "agent", id: "planner" }, updated: UPDATED },
  ])

  const renamed = await api.renameTeam({ level: "global", from: "crew", to: "squad" })
  expect(renamed.ok).toBe(true)

  const records = (await load(project)).records
  expect(records.find((record) => record.type === "team")).toMatchObject({ level: "global", team: "squad", enabled: true })
  expect(records.some((record) => teamNameOf(record) === "crew")).toBe(false)
  expect(records.filter((record) => teamNameOf(record) === "squad").length).toBeGreaterThanOrEqual(3)

  const snapshot = await api.snapshot()
  expect(snapshot.ok).toBe(true)
  if (!snapshot.ok) return
  const squad = snapshot.value.teams?.find((team) => team.level === "global" && team.team === "squad")
  expect(squad?.agents).toEqual(["alice"])
  expect(squad?.enabled).toBe(true)
})

test("rename refuses built-in and ancestor-backed agents", async () => {
  const project = await tempProject()
  // A host agent with no file is a built-in.
  const ctx = fullContext({ directory: project, agents: [agentInfo("build", "Build.")] })
  const api = createPlusApi(ctx, createState())
  const builtin = await api.renameAgent({ scope: "project", from: "build", to: "builder" })
  expect(builtin.ok).toBe(false)
  if (!builtin.ok) {
    expect(builtin.error.code).toBe("agent.invalid")
    expect(builtin.error.message).toContain("built in")
  }

  // An agent file above the project is ancestor-backed, not this project's.
  const parent = path.dirname(project)
  await fs.mkdir(path.join(parent, ".opencode", "agent"), { recursive: true })
  await fs.writeFile(path.join(parent, ".opencode", "agent", "legacy.md"), "---\nmode: primary\n---\nlegacy")
  const ancestorCtx = fullContext({ directory: project, agents: [agentInfo("legacy")] })
  const ancestorApi = createPlusApi(ancestorCtx, createState())
  const ancestor = await ancestorApi.renameAgent({ scope: "project", from: "legacy", to: "newer" })
  expect(ancestor.ok).toBe(false)
  if (!ancestor.ok) {
    expect(ancestor.error.code).toBe("agent.invalid")
    expect(ancestor.error.message).toContain("ancestor")
  }
})

test("instructions.set rename covers agent, member and team rows and refuses Defaults rows", async () => {
  const project = await tempProject()
  const ctx = fullContext({ directory: project, agents: [agentInfo("alice"), agentInfo("build")] })
  const api = createPlusApi(ctx, createState(), { builtins: [{ name: "ship", members: [{ id: "mate", body: "mate body" }] }] })
  expect((await api.createAgent({ scope: "project", id: "alice" })).ok).toBe(true)
  expect((await api.createTeam({ level: "project", team: "crew" })).ok).toBe(true)
  expect((await api.addTeamAgent({ level: "project", team: "crew", id: "m1" })).ok).toBe(true)
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")

  // Agent row.
  const agentOut = (await runOk(set, { id: "agent:project:alice", rename: "bob" })) as { id: string; to: string }
  expect(agentOut.to).toBe("bob")
  expect(agentOut.id).toBe("agent:project:bob")
  // Member row.
  const memberOut = (await runOk(set, { id: "team:project:crew:m1", rename: "m2" })) as { id: string; to: string }
  expect(memberOut.id).toBe("team:project:crew:m2")
  // Team row.
  const teamOut = (await runOk(set, { id: "team:project:crew", rename: "squad" })) as { id: string; to: string }
  expect(teamOut.id).toBe("team:project:squad")

  // Shipped Defaults team and member rows refuse.
  expect((await runFail(set, { id: "team:defaults:ship", rename: "fleet" })).message).toContain("shipped")
  expect((await runFail(set, { id: "team:defaults:ship:mate", rename: "mato" })).message).toContain("shipped")
  // A built-in agent row routes to the API, which refuses it.
  expect((await runFail(set, { id: "agent:project:build", rename: "builder" })).message).toContain("built in")
})

test("a tool actor may not rename a protected agent", async () => {
  const project = await tempProject()
  await fs.mkdir(path.join(project, ".opencodeplus"), { recursive: true })
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alice"] }))
  const ctx = fullContext({ directory: project, agents: [agentInfo("alice")] })
  const api = createPlusApi(ctx, createState())
  expect((await api.createAgent({ scope: "project", id: "alice" })).ok).toBe(true)
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  expect((await runFail(set, { id: "agent:project:alice", rename: "bob" })).message).toContain("agent.protected")
  expect(await Bun.file(await agentPath("project", project, "alice")).exists()).toBe(true)
})

// ---------------------------------------------------------------------------

async function readTools(ctx: Context): Promise<Map<string, Tool.Info & { readonly id: string }>> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
        yield* ctx.tool.transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
        })
        const list = yield* Deferred.await(deferred)
        return new Map(list.map((tool) => [tool.id, tool]))
      }),
    ),
  )
}

async function runOk(tool: Tool.Info & { readonly id: string }, input: unknown): Promise<unknown> {
  const outcome = await Effect.runPromise(
    tool.execute(input, toolContext()).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (!outcome.ok) throw new Error(`expected tool success, got error: ${outcome.error.message}`)
  return (outcome.result as { output: unknown }).output
}

async function runFail(tool: Tool.Info & { readonly id: string }, input: unknown): Promise<Tool.Error> {
  const outcome = await Effect.runPromise(
    tool.execute(input, toolContext()).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (outcome.ok) throw new Error(`expected tool failure, got success: ${JSON.stringify(outcome.result)}`)
  return outcome.error
}

function need(tools: Map<string, Tool.Info & { readonly id: string }>, id: string): Tool.Info & { readonly id: string } {
  const tool = tools.get(id)
  if (tool === undefined) throw new Error(`missing tool ${id}`)
  return tool
}

function toolContext(agent = "build"): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_rename"),
    agent: AgentSchema.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_rename"),
    id: Tool.CallID.make("call_rename"),
    progress: () => Effect.void,
  }
}
