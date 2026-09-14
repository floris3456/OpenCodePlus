import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState, createHandlers } from "../src/index.js"
import type { PlusApi } from "../src/index.js"
import { Plus } from "../src/rpc.js"
import { enable } from "../src/project.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { formatMarkdown } from "../src/agents/files.js"
import {
  addSection,
  removalPlan,
  reset,
  resolveReview,
  saveSplit,
  saveText,
  teamPlan,
  toggle,
  unknownRowRefusal,
} from "../src/instructions/ops.js"
import { expandedTree } from "../src/instructions/tree.js"
import type { MemoInput } from "../src/instructions/tree.js"
import { registerInstructionTools } from "../src/tools.js"
import type { Context } from "@opencode/plugin/effect/plugin"
import { agentHarness, agentInfo, context, fullContext, skillHarness, skillInfo, toolHarness } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempProject(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-tools-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await enable(project)
  return { project }
}

function toolContext(agent = "alpha"): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_tools_test"),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_tools_test"),
    id: Tool.CallID.make("call_tools_test"),
    progress: () => Effect.void,
  }
}

function fixtureContext(project: string, overrides?: Partial<Parameters<typeof fullContext>[0]>): Context {
  return fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "reader", description: "read things", options: { codemode: false } }],
    skills: [skillInfo("notes", "skill body")],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
    ...(overrides ?? {}),
  })
}

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

function memoFromSnapshot(snapshot: Plus.Snapshot): MemoInput {
  return {
    items: snapshot.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      group: item.group,
      ...(item.server === undefined ? {} : { server: item.server }),
      title: item.title,
      text: item.text,
      enabled: item.enabled,
      fingerprint: item.fingerprint,
      ...(item.agents === undefined ? {} : { agents: [...item.agents] }),
      ...(item.order === undefined ? {} : { order: item.order }),
      ...(item.userBase === undefined ? {} : { userBase: item.userBase }),
      ...(item.codemode === undefined ? {} : { codemode: item.codemode }),
    })),
    records: snapshot.records.map((record) =>
      record.type === "split"
        ? {
            type: "split" as const,
            level: record.level,
            agent: record.agent,
            item: record.item,
            boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
            updated: record.updated,
          }
        : {
            type: "customization" as const,
            level: record.level,
            agent: record.agent,
            item: record.item,
            section: record.section,
            ...(record.text === undefined ? {} : { text: record.text }),
            ...(record.state === undefined ? {} : { state: record.state }),
            basedOn: record.basedOn,
            ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
            ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
            updated: record.updated,
          },
    ),
    agents: snapshot.agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      ...(agent.path === undefined ? {} : { path: agent.path }),
      ...(agent.base === undefined ? {} : { base: agent.base }),
    })),
    teams: (snapshot.teams ?? []).map((team) => ({
      level: team.level,
      team: team.team,
      enabled: team.enabled,
      agents: [...team.agents],
    })),
  }
}

async function snapshotOf(api: PlusApi) {
  const result = await api.snapshot()
  if (!result.ok) throw new Error(`snapshot failed: ${result.error.message}`)
  return result.value
}

function withoutUpdated(records: readonly { updated?: string }[]) {
  return records.map((record) => {
    const { updated: _ignored, ...rest } = record as Record<string, unknown>
    void _ignored
    return rest
  })
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

async function freshFixture(): Promise<{ ctx: Context; api: PlusApi; tools: Map<string, Tool.Info & { readonly id: string }>; project: string }> {
  const { project } = await tempProject()
  const ctx = fixtureContext(project)
  const state = createState()
  const api = createPlusApi(ctx, state)
  await registerInstructionTools(ctx, api)
  return { ctx, api, tools: await readTools(ctx), project }
}

async function readerRowId(api: PlusApi): Promise<string> {
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const node = expandedTree(memo).find((candidate) => candidate.address?.item === "tool:reader")
  if (node === undefined) throw new Error("missing tool:reader row")
  return node.id
}

test("toggle through set matches the ops toggle records and status", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  const before = await snapshotOf(api)
  const expected = toggle(memoFromSnapshot(before), id)
  if ("refusal" in expected) throw new Error(`expected toggle success: ${expected.refusal}`)
  const output = (await runOk(need(tools, "instructions_set"), { id })) as { status: string }
  expect(output.status).toBe(expected.status)
  const after = await snapshotOf(api)
  expect(withoutUpdated(after.records)).toEqual(withoutUpdated(expected.records.map((record) => ({ ...record }))))
})

test("edit text through set matches saveText", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  const before = await snapshotOf(api)
  const expected = saveText(memoFromSnapshot(before), id, "custom description")
  if ("refusal" in expected) throw new Error(`expected save success: ${expected.refusal}`)
  const output = (await runOk(need(tools, "instructions_set"), { id, text: "custom description" })) as { status: string }
  expect(output.status).toBe(expected.status)
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "customization" && record.text === "custom description")).toBe(true)
})

test("reset through the tool clears the override like ops reset", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  await runOk(need(tools, "instructions_set"), { id, text: "custom description" })
  const before = await snapshotOf(api)
  const expected = reset(memoFromSnapshot(before), id)
  if ("refusal" in expected) throw new Error(`expected reset success: ${expected.refusal}`)
  const output = (await runOk(need(tools, "instructions_reset"), { id })) as { status: string }
  expect(output.status).toBe(expected.status)
  const after = await snapshotOf(api)
  expect(after.records).toEqual([])
})

test("split and add section match ops", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  const before = await snapshotOf(api)
  const expected = saveSplit(memoFromSnapshot(before), id, [{ id: "a", name: "A", start: 0 }])
  if ("refusal" in expected) throw new Error(`expected split success: ${expected.refusal}`)
  const output = (await runOk(need(tools, "instructions_split"), { id, boundaries: [{ id: "a", name: "A", start: 0 }] })) as {
    status: string
  }
  expect(output.status).toBe(expected.status)
  const { api: api2, tools: tools2 } = await freshFixture()
  const id2 = await readerRowId(api2)
  const before2 = await snapshotOf(api2)
  const expectedAdd = addSection(memoFromSnapshot(before2), id2, "Flags", "extra flags")
  if ("refusal" in expectedAdd) throw new Error(`expected add success: ${expectedAdd.refusal}`)
  const added = (await runOk(need(tools2, "instructions_split"), { id: id2, add: { name: "Flags", text: "extra flags" } })) as {
    status: string
  }
  expect(added.status).toBe(expectedAdd.status)
})

test("keep/take/edit resolve match ops", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  await runOk(need(tools, "instructions_set"), { id, text: "mine text" })
  const before = await snapshotOf(api)
  const memo = memoFromSnapshot(before)
  for (const resolution of ["keep", "take"] as const) {
    const expected = resolveReview(memo, id, resolution)
    if ("refusal" in expected) throw new Error(`expected ${resolution} success: ${expected.refusal}`)
  }
  const kept = (await runOk(need(tools, "instructions_set"), { id, resolve: "keep" })) as { status: string }
  expect(kept.status).toBe(`Kept "reader"`)
  const edited = (await runOk(need(tools, "instructions_set"), { id, resolve: "edit", text: "merged text" })) as {
    status: string
  }
  expect(edited.status).toBe(`Edited "reader"`)
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "customization" && record.text === "merged text")).toBe(true)
  const taken = (await runOk(need(tools, "instructions_set"), { id, resolve: "take" })) as { status: string }
  expect(taken.status).toBe(`Took upstream for "reader"`)
})

test("a refused toggle produces the same refusal string the TUI shows", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream")],
    tools: [{ id: "coder", description: "code mode tool" }],
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const node = expandedTree(memo).find((candidate) => candidate.address?.item === "tool:coder")
  if (node === undefined) throw new Error("missing coder row")
  const expected = toggle(memo, node.id)
  if (!("refusal" in expected)) throw new Error("expected toggle refusal")
  const error = await runFail(need(tools, "instructions_set"), { id: node.id })
  expect(error.message).toBe(expected.refusal)
})

test("create agent/skill/base/instruction/mcp write the same files as the api path", async () => {
  const { api, tools, project } = await freshFixture()
  const agent = (await runOk(need(tools, "instructions_create"), { kind: "agent", id: "helper", prompt: "Be helpful." })) as {
    id: string
    path: string
  }
  expect(await Bun.file(agent.path).text()).toContain("Be helpful.")
  const skill = (await runOk(need(tools, "instructions_create"), { kind: "skill", name: "notes2", body: "Take notes." })) as {
    path: string
  }
  expect(await Bun.file(skill.path).text()).toContain("Take notes.")
  const base = (await runOk(need(tools, "instructions_create"), { kind: "base", id: "custom", title: "Custom.txt", text: "custom base" })) as {
    id: string
  }
  expect(base.id).toBe("custom")
  const instruction = (await runOk(need(tools, "instructions_create"), { kind: "instruction", name: "AGENTS.md", text: "Follow the guide." })) as {
    path: string
  }
  expect(instruction.path).toBe(path.join(project, "AGENTS.md"))
  const mcp = (await runOk(need(tools, "instructions_create"), {
    kind: "mcp",
    name: "search",
    config: { type: "remote", url: "https://example.test" },
  })) as { name: string }
  expect(mcp.name).toBe("search")
  expect(await Bun.file(path.join(project, ".opencode", "opencode.json")).text()).toContain("https://example.test")
  void api
})

test("delete agent removes a file-backed agent and reports the plan status", async () => {
  const { project } = await tempProject()
  const agentPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(agentPath), { recursive: true })
  await Bun.write(agentPath, "alpha prompt\n")
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const agentRow = expandedTree(memo).find((node) => node.id === "agent:project:alpha")
  if (agentRow === undefined) throw new Error("missing agent row")
  const agentPlan = removalPlan(memo, agentRow.id)
  if ("refusal" in agentPlan) throw new Error(`expected agent plan: ${agentPlan.refusal}`)
  const deletedAgent = (await runOk(need(tools, "instructions_delete"), { id: agentRow.id, confirm: true })) as {
    status: string
  }
  expect(deletedAgent.status).toBe(agentPlan.successStatus)
  expect(await Bun.file(agentPath).exists()).toBe(false)
})

test("delete skill removes a project skill and reports the plan status", async () => {
  const { project } = await tempProject()
  const skillPath = path.join(project, ".opencode", "skill", "keeper", "SKILL.md")
  await fs.mkdir(path.dirname(skillPath), { recursive: true })
  await Bun.write(skillPath, "---\nname: keeper\ndescription: keeper\n---\nkeep me\n")
  const keeperInfo = skillInfo("keeper", "keep me", skillPath)
  const ctx = fixtureContext(project, { skills: [skillInfo("notes", "skill body"), keeperInfo] })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const skillRow = expandedTree(memo).find((node) => node.address?.item === "skill:keeper")
  if (skillRow === undefined) throw new Error("missing skill row")
  const skillPlan = removalPlan(memo, skillRow.id)
  if ("refusal" in skillPlan) throw new Error(`expected skill plan: ${skillPlan.refusal}`)
  const deletedSkill = (await runOk(need(tools, "instructions_delete"), { id: skillRow.id, confirm: true })) as {
    status: string
  }
  expect(deletedSkill.status).toBe(skillPlan.successStatus)
  expect(await Bun.file(skillPath).exists()).toBe(false)
})

test("delete base removes a user template", async () => {
  const { api, tools } = await freshFixture()
  await runOk(need(tools, "instructions_create"), { kind: "base", id: "dropbase", title: "Drop.txt", text: "drop" })
  const afterBase = await snapshotOf(api)
  const baseRow = expandedTree(memoFromSnapshot(afterBase)).find((node) => node.address?.item === "base:dropbase")
  if (baseRow === undefined) throw new Error("missing base row")
  const basePlan = removalPlan(memoFromSnapshot(afterBase), baseRow.id)
  if ("refusal" in basePlan) throw new Error(`expected base plan: ${basePlan.refusal}`)
  const deleted = (await runOk(need(tools, "instructions_delete"), { id: baseRow.id, confirm: true })) as { status: string }
  expect(deleted.status).toBe(basePlan.successStatus)
})

test("delete instruction removes the project file", async () => {
  const { api, tools, project } = await freshFixture()
  await runOk(need(tools, "instructions_create"), { kind: "instruction", name: "AGENTS.md", text: "guide" })
  const afterInstruction = await snapshotOf(api)
  const instructionRow = expandedTree(memoFromSnapshot(afterInstruction)).find(
    (node) => node.address?.item === "system:AGENTS.md",
  )
  if (instructionRow === undefined) throw new Error("missing instruction row")
  await runOk(need(tools, "instructions_delete"), { id: instructionRow.id, confirm: true })
  expect(await Bun.file(path.join(project, "AGENTS.md")).exists()).toBe(false)
})

test("delete mcp removes the server from the project config", async () => {
  const { project } = await tempProject()
  const ctx = fixtureContext(project, { servers: [["search", { type: "remote", url: "https://example.test" }]] })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  await api.addMcp({ name: "search", config: { type: "remote", url: "https://example.test" } })
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const mcpRow = expandedTree(memo).find((node) => node.address?.item === "mcp:search")
  if (mcpRow === undefined) throw new Error("missing mcp row")
  const mcpPlan = removalPlan(memo, mcpRow.id)
  if ("refusal" in mcpPlan) throw new Error(`expected mcp plan: ${mcpPlan.refusal}`)
  const deleted = (await runOk(need(tools, "instructions_delete"), { id: mcpRow.id, confirm: true })) as { status: string }
  expect(deleted.status).toBe(mcpPlan.successStatus)
  expect(await Bun.file(path.join(project, ".opencode", "opencode.json")).text()).not.toContain("search")
})

test("team toggle through set matches teamPlan", async () => {
  const { project } = await tempProject()
  await fs.mkdir(path.join(projectTeamsPath(project), "crew"), { recursive: true })
  await Bun.write(path.join(projectTeamsPath(project), "crew", "alpha.md"), formatMarkdown({ description: "alpha" }, "role"))
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const row = expandedTree(memo).find((node) => node.id === "team:project:crew")
  if (row === undefined) throw new Error("missing team row")
  const plan = teamPlan(memo, row.id)
  if ("refusal" in plan) throw new Error(`expected team plan: ${plan.refusal}`)
  const output = (await runOk(need(tools, "instructions_set"), { id: row.id })) as { status: string }
  expect(output.status).toBe(plan.successStatus)
  const after = await snapshotOf(api)
  expect(after.teams?.find((team) => team.team === "crew")?.enabled).toBe(true)
})

test("protectedAgents refusal on a write", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const id = await readerRowId(api)
  const error = await runFail(need(tools, "instructions_set"), { id, text: "blocked" })
  expect(error.message).toContain("agent.protected")
  const after = await snapshotOf(api)
  expect(after.records).toEqual([])
})

test("delete without confirm refuses and deletes nothing", async () => {
  const { project } = await tempProject()
  const skillPath = path.join(project, ".opencode", "skill", "keeper", "SKILL.md")
  await fs.mkdir(path.dirname(skillPath), { recursive: true })
  await Bun.write(skillPath, "---\nname: keeper\ndescription: keeper\n---\nkeep me\n")
  const ctx = fixtureContext(project, { skills: [skillInfo("notes", "skill body"), skillInfo("keeper", "keep me", skillPath)] })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const row = expandedTree(memoFromSnapshot(snapshot)).find((node) => node.address?.item === "skill:keeper")
  if (row === undefined) throw new Error("missing keeper row")
  const error = await runFail(need(tools, "instructions_delete"), { id: row.id })
  expect(error.message).toContain("delete.unconfirmed")
  expect(await Bun.file(skillPath).exists()).toBe(true)
  const after = await snapshotOf(api)
  expect(after.items.some((item) => item.id === "skill:keeper")).toBe(true)
})

test("every tool carries the plugin origin, no pinned, and namespace/codemode/permission set", async () => {
  const { tools } = await freshFixture()
  const registered = [...tools.values()].filter((tool) => tool.id.startsWith("instructions_"))
  expect(registered).toHaveLength(8)
  for (const tool of registered) {
    expect(tool.origin).toEqual({ type: "plugin", name: "opencode.plus" })
    expect(tool.options?.namespace).toBe("instructions")
    expect(tool.options?.codemode).toBe(true)
    expect(tool.options?.permission).toBe("instructions")
    expect("pinned" in (tool.options ?? {})).toBe(false)
  }
})

test("every tool first description line is within 120 characters", async () => {
  const { tools } = await freshFixture()
  const registered = [...tools.values()].filter((tool) => tool.id.startsWith("instructions_"))
  expect(registered).toHaveLength(8)
  for (const tool of registered) {
    const first = tool.description.split("\n", 1)[0] ?? ""
    expect(first.length).toBeLessThanOrEqual(120)
  }
})

test("no instructions tool is registered while disabled, and disabling disposes them", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-tools-enable-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fixtureContext(project)
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const before = await readTools(ctx)
  expect([...before.keys()].filter((id) => id.startsWith("instructions_"))).toEqual([])
  await Effect.runPromise(
    handlers["project.enable"](undefined, {
      error: () => {
        throw new Error("unexpected enable error")
      },
    }),
  )
  const afterEnable = await readTools(ctx)
  expect(afterEnable.size).toBeGreaterThanOrEqual(8)
  expect(state.tooling.length).toBe(3)
  await Effect.runPromise(
    handlers["project.enable"](undefined, {
      error: () => {
        throw new Error("unexpected enable error")
      },
    }),
  )
  expect(state.tooling.length).toBe(3)
  const still = await readTools(ctx)
  expect([...still.keys()].filter((id) => id.startsWith("instructions_"))).toHaveLength(8)
  await Effect.runPromise(
    handlers["project.disable"](undefined, {
      error: () => {
        throw new Error("unexpected disable error")
      },
    }),
  )
  const afterDisable = await readTools(ctx)
  expect([...afterDisable.keys()].filter((id) => id.startsWith("instructions_"))).toEqual([])
  expect(state.tooling).toEqual([])
})

test("a tool write appends a log line with actor tool carrying agent/session/message", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  const set = need(tools, "instructions_set")
  const outcome = await Effect.runPromise(
    set.execute({ id, text: "logged edit" }, toolContext()).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (!outcome.ok) throw new Error(`set failed: ${outcome.error.message}`)
  const logged = await api.log({ where: "actor:tool" })
  if (!logged.ok) throw new Error("log failed")
  expect(logged.value.total).toBeGreaterThan(0)
  const entry = logged.value.entries[0]
  if (entry === undefined) throw new Error("missing log entry")
  expect(entry.actor).toEqual({ type: "tool", agent: "alpha", sessionID: "ses_tools_test", messageID: "msg_tools_test" })
})

test("show with each view returns the right shape, diff returns two diffs plus summary", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  await runOk(need(tools, "instructions_set"), { id, text: "mine text\nline two\n" })
  const show = need(tools, "instructions_show")
  const resolved = (await runOk(show, { id })) as { view?: string; text: string }
  expect(typeof resolved.text).toBe("string")
  const upstream = (await runOk(show, { id, view: "upstream" })) as { text: string }
  expect(typeof upstream.text).toBe("string")
  const mine = (await runOk(show, { id, view: "mine" })) as { text: string }
  expect(mine.text).toBe("mine text\nline two\n")
  const record = (await runOk(show, { id, view: "record" })) as { record: unknown }
  expect(record.record).not.toBeNull()
  const sections = (await runOk(show, { id, view: "sections" })) as { sections: readonly string[] }
  expect(Array.isArray(sections.sections)).toBe(true)
  const diff = (await runOk(show, { id, view: "diff" })) as { mineDiff: string; upstreamDiff: string; summary: string }
  expect(typeof diff.mineDiff).toBe("string")
  expect(typeof diff.upstreamDiff).toBe("string")
  expect(diff.mineDiff).toContain("--- original")
  expect(diff.summary).not.toContain("\n")
  const snapshot = await snapshotOf(api)
  const agentRow = expandedTree(memoFromSnapshot(snapshot)).find((node) => node.kind === "agent")
  if (agentRow === undefined) throw new Error("missing agent row")
  const assembled = (await runOk(show, { id: agentRow.id, view: "assembled" })) as { agent: string }
  expect(assembled.agent).toBe("alpha")
  const badView = await runFail(show, { id, view: "assembled" })
  expect(badView.message).toContain("view.unsupported")
  const unknown = await runFail(show, { id: "item:project:alpha:does:not:exist", view: "resolved" })
  expect(unknown.message).toContain("row.unknown")
  expect(unknown.message).toContain(unknownRowRefusal("item:project:alpha:does:not:exist"))
})

test("toolHarness exposes agent, skill, and hook state for parity checks", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const skills = skillHarness([skillInfo("notes", "body")])
  const toolState = toolHarness([{ id: "reader", description: "read", options: { codemode: false } }])
  const hooks = { current: 0 }
  const ctx = context({ agent: agents.domain, skill: skills.domain, tool: toolState.domain, session: { hook: () => Effect.sync(() => ({ dispose: Effect.void })) } })
  void ctx
  void hooks
  expect(agents.state.get("alpha")?.system).toBe("upstream")
  expect(skills.state.get("notes")?.content).toBe("body")
  expect(toolState.tools.get("reader")?.description).toBe("read")
})
