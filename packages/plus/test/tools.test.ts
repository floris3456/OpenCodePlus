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
import { userBaseFile } from "../src/agents/base.js"
import { formatMarkdown } from "../src/agents/files.js"
import {
  addSection,
  removalPlan,
  reset,
  resolveReview,
  saveSplit,
  saveText,
  setPin,
  teamPlan,
  toggle,
  unknownRowRefusal,
} from "../src/instructions/ops.js"
import { expandedTree } from "../src/instructions/tree.js"
import type { MemoInput } from "../src/instructions/tree.js"
import { registerInstructionTools } from "../src/tools.js"
import type { Context } from "@opencode/plugin/effect/plugin"
import { agentHarness, agentInfo, catalogHarness, context, fullContext, modelInfo, skillHarness, skillInfo, toolHarness } from "./harness.js"

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
      ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
      ...(item.pinned === undefined ? {} : { pinned: item.pinned }),
      ...(item.execute === undefined ? {} : { execute: item.execute }),
    })),
    // Rule records stay filtered until phase 3; model records are tree rows.
    records: snapshot.records.flatMap((record) =>
      record.type === "rule"
        ? []
        : [
            record.type === "split"
              ? {
                  type: "split" as const,
                  level: record.level,
                  agent: record.agent,
                  item: record.item,
                  boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
                  updated: record.updated,
                }
              : record.type === "model"
                ? {
                    type: "model" as const,
                    level: record.level,
                    agent: record.agent,
                    providerID: record.providerID,
                    modelID: record.modelID,
                    ...(record.variant === undefined ? {} : { variant: record.variant }),
                    ...(record.active === undefined ? {} : { active: record.active }),
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
                    ...(record.pin === undefined ? {} : { pin: record.pin }),
                    basedOn: record.basedOn,
                    ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
                    ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
                    updated: record.updated,
                  },
          ],
    ),
    agents: snapshot.agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      ...(agent.path === undefined ? {} : { path: agent.path }),
      ...(agent.base === undefined ? {} : { base: agent.base }),
      ...(agent.model === undefined
        ? {}
        : {
            model: {
              providerID: agent.model.providerID,
              modelID: agent.model.modelID,
              ...(agent.model.variant === undefined ? {} : { variant: agent.model.variant }),
            },
          }),
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

test("split and add section match ops and persist boundaries and section records", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  const before = await snapshotOf(api)
  const expected = saveSplit(memoFromSnapshot(before), id, [{ id: "a", name: "A", start: 0 }])
  if ("refusal" in expected) throw new Error(`expected split success: ${expected.refusal}`)
  const output = (await runOk(need(tools, "instructions_split"), { id, boundaries: [{ id: "a", name: "A", start: 0 }] })) as {
    status: string
  }
  expect(output.status).toBe(expected.status)
  const afterSplit = await snapshotOf(api)
  const splitRecord = afterSplit.records.find((record) => record.type === "split")
  if (splitRecord === undefined || splitRecord.type !== "split") throw new Error("expected persisted split record")
  expect(splitRecord.boundaries).toEqual([{ id: "a", name: "A", start: 0 }])
  const { api: api2, tools: tools2 } = await freshFixture()
  const id2 = await readerRowId(api2)
  const before2 = await snapshotOf(api2)
  const expectedAdd = addSection(memoFromSnapshot(before2), id2, "Flags", "extra flags")
  if ("refusal" in expectedAdd) throw new Error(`expected add success: ${expectedAdd.refusal}`)
  const added = (await runOk(need(tools2, "instructions_split"), { id: id2, add: { name: "Flags", text: "extra flags" } })) as {
    status: string
  }
  expect(added.status).toBe(expectedAdd.status)
  const afterAdd = await snapshotOf(api2)
  const addedSplit = afterAdd.records.find((record) => record.type === "split")
  if (addedSplit === undefined || addedSplit.type !== "split") throw new Error("expected persisted split for added section")
  expect(addedSplit.boundaries.some((boundary) => boundary.name === "Flags")).toBe(true)
  const sectionRecord = afterAdd.records.find(
    (record) => record.type === "customization" && record.section !== null && record.text === "extra flags",
  )
  if (sectionRecord === undefined) throw new Error("expected persisted section customization")
  if (sectionRecord.type !== "customization" || sectionRecord.section === null) throw new Error("expected section record")
  expect(addedSplit.boundaries.some((boundary) => boundary.id === sectionRecord.section)).toBe(true)
})

test("keep/take/edit resolve match ops and persist the resulting records", async () => {
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
  const afterKeep = await snapshotOf(api)
  const keptRecord = afterKeep.records.find((record) => record.type === "customization" && record.text === "mine text")
  if (keptRecord === undefined || keptRecord.type !== "customization") throw new Error("expected kept text to persist")
  expect(keptRecord.acknowledged).toBeDefined()
  const edited = (await runOk(need(tools, "instructions_set"), { id, resolve: "edit", text: "merged text" })) as {
    status: string
  }
  expect(edited.status).toBe(`Edited "reader"`)
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "customization" && record.text === "merged text")).toBe(true)
  const taken = (await runOk(need(tools, "instructions_set"), { id, resolve: "take" })) as { status: string }
  expect(taken.status).toBe(`Took upstream for "reader"`)
  const afterTake = await snapshotOf(api)
  expect(afterTake.records.some((record) => record.type === "customization" && record.text === "merged text")).toBe(false)
  expect(
    afterTake.records.some((record) => record.type === "customization" && record.text === "mine text"),
  ).toBe(false)
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
  const node = expandedTree(memo).find((candidate) => candidate.label === "Role/persona")
  if (node === undefined) throw new Error("missing Role/persona row")
  const expected = toggle(memo, node.id)
  if (!("refusal" in expected)) throw new Error("expected toggle refusal")
  expect(expected.refusal).toBe(`"Role/persona" cannot be excluded and remains in effect`)
  const error = await runFail(need(tools, "instructions_set"), { id: node.id })
  expect(error.message).toBe(expected.refusal)
})

test("create agent/skill/base/instruction/mcp write the same files as the api path", async () => {
  const toolIsolation = await tempProject()
  const toolConfig = process.env.OPENCODE_CONFIG_DIR ?? ""
  if (toolConfig.length === 0) throw new Error("missing tool config dir")
  const toolProject = toolIsolation.project
  const apiIsolation = await tempProject()
  const apiConfig = process.env.OPENCODE_CONFIG_DIR ?? ""
  if (apiConfig.length === 0) throw new Error("missing api config dir")
  const apiProject = apiIsolation.project
  process.env.OPENCODE_CONFIG_DIR = toolConfig
  const toolCtx = fixtureContext(toolProject)
  const toolApi = createPlusApi(toolCtx, createState())
  await registerInstructionTools(toolCtx, toolApi)
  const toolTools = await readTools(toolCtx)
  const toolCreate = need(toolTools, "instructions_create")
  process.env.OPENCODE_CONFIG_DIR = apiConfig
  const apiCtx = fixtureContext(apiProject)
  const apiApi = createPlusApi(apiCtx, createState())
  const agentPrompt = "Be helpful."
  const agentFields = { description: "Helper agent", mode: "subagent" as const }
  const skillBody = "Take notes."
  const baseTitle = "Custom.txt"
  const baseText = "custom base"
  const instructionText = "Follow the guide."
  const mcpConfig = { type: "remote", url: "https://example.test" }
  process.env.OPENCODE_CONFIG_DIR = toolConfig
  await runOk(toolCreate, { kind: "agent", id: "helper", prompt: agentPrompt, fields: agentFields })
  await runOk(toolCreate, { kind: "skill", name: "notes2", body: skillBody })
  await runOk(toolCreate, { kind: "base", id: "custom", title: baseTitle, text: baseText })
  await runOk(toolCreate, { kind: "instruction", name: "AGENTS.md", text: instructionText })
  await runOk(toolCreate, { kind: "mcp", name: "search", config: mcpConfig })
  process.env.OPENCODE_CONFIG_DIR = apiConfig
  const apiAgent = await apiApi.createAgent({ scope: "project", id: "helper", prompt: agentPrompt, fields: agentFields })
  if (!apiAgent.ok) throw new Error(`api createAgent failed: ${apiAgent.error.message}`)
  const apiSkill = await apiApi.createSkill({ name: "notes2", body: skillBody })
  if (!apiSkill.ok) throw new Error(`api createSkill failed: ${apiSkill.error.message}`)
  const apiBase = await apiApi.createBase({ id: "custom", title: baseTitle, text: baseText })
  if (!apiBase.ok) throw new Error(`api createBase failed: ${apiBase.error.message}`)
  const apiInstruction = await apiApi.createInstruction({ name: "AGENTS.md", text: instructionText })
  if (!apiInstruction.ok) throw new Error(`api createInstruction failed: ${apiInstruction.error.message}`)
  const apiMcp = await apiApi.addMcp({ name: "search", config: { ...mcpConfig } })
  if (!apiMcp.ok) throw new Error(`api addMcp failed: ${apiMcp.error.message}`)
  async function collectProjectFiles(project: string): Promise<Map<string, string>> {
    const files = new Map<string, string>()
    async function walk(dir: string): Promise<void> {
      const names = await fs.readdir(dir)
      await Promise.all(
        names.map(async (name) => {
          const full = path.join(dir, name)
          if (full === path.join(project, ".opencodeplus")) return
          const stat = await fs.stat(full)
          if (stat.isDirectory()) {
            await walk(full)
            return
          }
          files.set(path.relative(project, full), await Bun.file(full).text())
        }),
      )
    }
    await walk(project)
    return files
  }
  async function collectBaseFiles(configDir: string): Promise<Map<string, string>> {
    const baseDir = path.join(configDir, "opencodeplus", "instructions", "base")
    const files = new Map<string, string>()
    async function walk(dir: string): Promise<void> {
      const names = await fs.readdir(dir).catch(() => [] as string[])
      await Promise.all(
        names.map(async (name) => {
          const full = path.join(dir, name)
          const stat = await fs.stat(full)
          if (stat.isDirectory()) {
            await walk(full)
            return
          }
          files.set(path.relative(baseDir, full), await Bun.file(full).text())
        }),
      )
    }
    await walk(baseDir)
    return files
  }
  // Normalize only legitimately non-deterministic absolute root paths.
  // Text, titles, and frontmatter pass through untouched so dropped or
  // altered content still fails the comparison below.
  function normalizeRoots(text: string): string {
    const pairs: readonly (readonly [string, string])[] = [
      [toolProject, "<project>"],
      [apiProject, "<project>"],
      [toolConfig, "<config>"],
      [apiConfig, "<config>"],
    ]
    return pairs.reduce((current, pair) => {
      if (pair[0].length === 0) return current
      return current.split(pair[0]).join(pair[1])
    }, text)
  }
  function expectParity(toolFiles: Map<string, string>, apiFiles: Map<string, string>): void {
    expect([...toolFiles.keys()].sort()).toEqual([...apiFiles.keys()].sort())
    for (const key of [...toolFiles.keys()].sort()) {
      expect(normalizeRoots(toolFiles.get(key) ?? "")).toBe(normalizeRoots(apiFiles.get(key) ?? ""))
    }
  }
  const toolProjectFiles = await collectProjectFiles(toolProject)
  const apiProjectFiles = await collectProjectFiles(apiProject)
  expectParity(toolProjectFiles, apiProjectFiles)
  const toolBaseFiles = await collectBaseFiles(toolConfig)
  const apiBaseFiles = await collectBaseFiles(apiConfig)
  expectParity(toolBaseFiles, apiBaseFiles)
  // Vacuity: the compared trees actually contain every artifact with full
  // text, title, and frontmatter, so an empty-vs-empty equality cannot pass.
  const agentKey = [...toolProjectFiles.keys()].find((key) => key.endsWith("helper.md"))
  if (agentKey === undefined) throw new Error("missing helper agent file")
  expect(normalizeRoots(toolProjectFiles.get(agentKey) ?? "")).toContain(agentPrompt)
  expect(normalizeRoots(toolProjectFiles.get(agentKey) ?? "")).toContain("Helper agent")
  expect(normalizeRoots(toolProjectFiles.get(agentKey) ?? "")).toContain("subagent")
  const skillKey = [...toolProjectFiles.keys()].find((key) => key.endsWith(path.join("notes2", "SKILL.md")))
  if (skillKey === undefined) throw new Error("missing notes2 skill file")
  expect(toolProjectFiles.get(skillKey) ?? "").toContain(skillBody)
  expect(toolProjectFiles.get(skillKey) ?? "").toContain("name: notes2")
  expect(toolBaseFiles.get("custom.txt") ?? "").toBe(baseText)
  expect(toolBaseFiles.get("index.json") ?? "").toContain(baseTitle)
  expect(toolProjectFiles.get("AGENTS.md") ?? "").toContain(instructionText)
  const mcpKey = [...toolProjectFiles.keys()].find((key) => key.endsWith("opencode.json"))
  if (mcpKey === undefined) throw new Error("missing mcp config file")
  expect(toolProjectFiles.get(mcpKey) ?? "").toContain("https://example.test")
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

test("delete base removes a user template and its file is gone", async () => {
  const { api, tools } = await freshFixture()
  await runOk(need(tools, "instructions_create"), { kind: "base", id: "dropbase", title: "Drop.txt", text: "drop" })
  const createdPath = userBaseFile("dropbase")
  expect(await Bun.file(createdPath).exists()).toBe(true)
  const afterBase = await snapshotOf(api)
  const baseRow = expandedTree(memoFromSnapshot(afterBase)).find((node) => node.address?.item === "base:dropbase")
  if (baseRow === undefined) throw new Error("missing base row")
  const basePlan = removalPlan(memoFromSnapshot(afterBase), baseRow.id)
  if ("refusal" in basePlan) throw new Error(`expected base plan: ${basePlan.refusal}`)
  const deleted = (await runOk(need(tools, "instructions_delete"), { id: baseRow.id, confirm: true })) as { status: string }
  expect(deleted.status).toBe(basePlan.successStatus)
  expect(await Bun.file(createdPath).exists()).toBe(false)
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

test("a tool create appends a log line with actor tool", async () => {
  const { api, tools } = await freshFixture()
  await runOk(need(tools, "instructions_create"), { kind: "skill", name: "loggedskill", body: "Log me." })
  const logged = await api.log({ where: "actor:tool" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "skill.create")
  if (entry === undefined) throw new Error("missing skill.create log entry")
  expect(entry.actor).toEqual({ type: "tool", agent: "alpha", sessionID: "ses_tools_test", messageID: "msg_tools_test" })
})

test("a tool delete appends a log line with actor tool", async () => {
  const { project } = await tempProject()
  const skillPath = path.join(project, ".opencode", "skill", "loggedkeeper", "SKILL.md")
  await fs.mkdir(path.dirname(skillPath), { recursive: true })
  await Bun.write(skillPath, "---\nname: loggedkeeper\ndescription: loggedkeeper\n---\nkeep me\n")
  const ctx = fixtureContext(project, {
    skills: [skillInfo("notes", "skill body"), skillInfo("loggedkeeper", "keep me", skillPath)],
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const row = expandedTree(memoFromSnapshot(snapshot)).find((node) => node.address?.item === "skill:loggedkeeper")
  if (row === undefined) throw new Error("missing loggedkeeper row")
  await runOk(need(tools, "instructions_delete"), { id: row.id, confirm: true })
  const logged = await api.log({ where: "actor:tool" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "skill.delete")
  if (entry === undefined) throw new Error("missing skill.delete log entry")
  expect(entry.actor).toEqual({ type: "tool", agent: "alpha", sessionID: "ses_tools_test", messageID: "msg_tools_test" })
})

test("a tool team toggle appends a log line with actor tool", async () => {
  const { project } = await tempProject()
  await fs.mkdir(path.join(projectTeamsPath(project), "crew"), { recursive: true })
  await Bun.write(path.join(projectTeamsPath(project), "crew", "alpha.md"), formatMarkdown({ description: "alpha" }, "role"))
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const row = expandedTree(memoFromSnapshot(snapshot)).find((node) => node.id === "team:project:crew")
  if (row === undefined) throw new Error("missing team row")
  await runOk(need(tools, "instructions_set"), { id: row.id })
  const logged = await api.log({ where: "actor:tool" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "team.setEnabled")
  if (entry === undefined) throw new Error("missing team.setEnabled log entry")
  expect(entry.actor).toEqual({ type: "tool", agent: "alpha", sessionID: "ses_tools_test", messageID: "msg_tools_test" })
})

test("instructions_create with kind team creates the directory disabled and logs actor tool", async () => {
  const { project } = await tempProject()
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  // Regression: the old implementation merely enabled via setTeamEnabled and
  // failed with team.unknown for a name with no directory. Creating must
  // succeed on a missing directory and leave the team disabled, not enabled.
  const output = (await runOk(need(tools, "instructions_create"), { kind: "team", team: "crew", level: "project" })) as {
    level: string
    team: string
    enabled: boolean
  }
  expect(output).toEqual({ level: "project", team: "crew", enabled: false })
  const stat = await fs.stat(path.join(projectTeamsPath(project), "crew"))
  expect(stat.isDirectory()).toBe(true)
  const snapshot = await snapshotOf(api)
  expect(snapshot.teams?.find((team) => team.team === "crew")).toEqual({
    level: "project",
    team: "crew",
    enabled: false,
    agents: [],
  })
  const logged = await api.log({ where: "actor:tool" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "team.create")
  if (entry === undefined) throw new Error("missing team.create log entry")
  expect(entry.actor).toEqual({ type: "tool", agent: "alpha", sessionID: "ses_tools_test", messageID: "msg_tools_test" })
  const missing = await runFail(need(tools, "instructions_create"), { kind: "team", team: "ghost" })
  expect(missing.message).toContain("create team requires team and level")
})

test("the same file and team writes through the RPC handlers still log tui", async () => {
  const { project } = await tempProject()
  await fs.mkdir(path.join(projectTeamsPath(project), "crew"), { recursive: true })
  await Bun.write(path.join(projectTeamsPath(project), "crew", "alpha.md"), formatMarkdown({ description: "alpha" }, "role"))
  const ctx = fixtureContext(project)
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const stub = {
    error: (): never => {
      throw new Error("unexpected rpc error")
    },
  }
  await Effect.runPromise(handlers["skill.create"]({ name: "rpcskill", body: "RPC body." }, stub))
  await Effect.runPromise(handlers["skill.delete"]({ id: "rpcskill" }, stub))
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "rpc-crew" }, stub))
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, stub))
  const api = createPlusApi(ctx, state)
  const logged = await api.log({})
  if (!logged.ok) throw new Error("log failed")
  for (const op of ["skill.create", "skill.delete", "team.create", "team.setEnabled"] as const) {
    const entry = logged.value.entries.find((candidate) => candidate.op === op)
    if (entry === undefined) throw new Error(`missing ${op} log entry`)
    expect(entry.actor).toEqual({ type: "tui" })
  }
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

test("registered list and log tools return persisted rows and history", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  await runOk(need(tools, "instructions_set"), { id, text: "listed text" })
  const list = (await runOk(need(tools, "instructions_list"), {})) as { rows: readonly { id: string }[]; total: number }
  expect(list.total).toBeGreaterThan(0)
  expect(list.rows.some((row) => row.id === id)).toBe(true)
  const logged = (await runOk(need(tools, "instructions_log"), {})) as {
    entries: readonly { op: string }[]
    total: number
  }
  expect(logged.total).toBeGreaterThan(0)
  expect(logged.entries.some((entry) => entry.op === "mutate")).toBe(true)
})

test("protected agent creation refuses before writing a file or log line", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["build"] }))
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const error = await runFail(need(tools, "instructions_create"), { kind: "agent", id: "build", prompt: "override" })
  expect(error.message).toContain("agent.protected")
  expect(await Bun.file(path.join(project, ".opencode", "agent", "build.md")).exists()).toBe(false)
  expect(await Bun.file(path.join(project, ".opencode", "agents", "build.md")).exists()).toBe(false)
  const logged = await api.log({})
  if (!logged.ok) throw new Error("log failed")
  expect(logged.value.total).toBe(0)
})

test("team set honours explicit state and refuses text and resolve without writing", async () => {
  const { project } = await tempProject()
  await fs.mkdir(path.join(projectTeamsPath(project), "crew"), { recursive: true })
  await Bun.write(path.join(projectTeamsPath(project), "crew", "alpha.md"), formatMarkdown({ description: "alpha" }, "role"))
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const row = expandedTree(memoFromSnapshot(snapshot)).find((node) => node.id === "team:project:crew")
  if (row === undefined) throw new Error("missing team row")
  const beforeLines = await api.log({})
  if (!beforeLines.ok) throw new Error("log failed")
  const beforeTotal = beforeLines.value.total
  const enabled = (await runOk(need(tools, "instructions_set"), { id: row.id, state: "on" })) as { status: string }
  expect(enabled.status).toBe(`Enabled team "crew"`)
  const afterOn = await snapshotOf(api)
  expect(afterOn.teams?.find((team) => team.team === "crew")?.enabled).toBe(true)
  const disabled = (await runOk(need(tools, "instructions_set"), { id: row.id, state: "off" })) as { status: string }
  expect(disabled.status).toBe(`Disabled team "crew"`)
  const afterOff = await snapshotOf(api)
  expect(afterOff.teams?.find((team) => team.team === "crew")?.enabled).toBe(false)
  const textError = await runFail(need(tools, "instructions_set"), { id: row.id, text: "nope" })
  expect(textError.message).toContain("cannot be edited")
  const resolveError = await runFail(need(tools, "instructions_set"), { id: row.id, resolve: "keep" })
  expect(resolveError.message).toContain("cannot be resolved")
  const afterRefusals = await snapshotOf(api)
  expect(afterRefusals.teams?.find((team) => team.team === "crew")?.enabled).toBe(false)
  const logged = await api.log({})
  if (!logged.ok) throw new Error("log failed")
  const teamLines = logged.value.entries.filter((entry) => entry.op === "team.setEnabled")
  expect(teamLines).toHaveLength(2)
  expect(logged.value.total).toBe(beforeTotal + 2)
})

test("a Code Mode text edit persists and show reports it", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream")],
    tools: [{ id: "coder", description: "code mode tool" }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const node = expandedTree(memoFromSnapshot(snapshot)).find((candidate) => candidate.address?.item === "tool:coder")
  if (node === undefined) throw new Error("missing coder row")
  const before = await snapshotOf(api)
  const expected = saveText(memoFromSnapshot(before), node.id, "custom coder text")
  if ("refusal" in expected) throw new Error(`expected save success: ${expected.refusal}`)
  const output = (await runOk(need(tools, "instructions_set"), { id: node.id, text: "custom coder text" })) as { status: string }
  expect(output.status).toBe(expected.status)
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "customization" && record.text === "custom coder text")).toBe(true)
  const shown = (await runOk(need(tools, "instructions_show"), { id: node.id, view: "resolved" })) as { text: string }
  expect(shown.text).toBe("custom coder text")
  const record = (await runOk(need(tools, "instructions_show"), { id: node.id, view: "record" })) as { record: { text?: string } | null }
  expect(record.record?.text).toBe("custom coder text")
})

test("pin through set matches ops.setPin records and status", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream")],
    tools: [{ id: "coder", description: "code mode tool" }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const node = expandedTree(memoFromSnapshot(snapshot)).find((candidate) => candidate.address?.item === "tool:coder")
  if (node === undefined) throw new Error("missing coder row")
  const before = await snapshotOf(api)
  const expected = setPin(memoFromSnapshot(before), node.id, true)
  if ("refusal" in expected) throw new Error(`expected pin success: ${expected.refusal}`)
  const output = (await runOk(need(tools, "instructions_set"), { id: node.id, pin: true })) as { status: string }
  expect(output.status).toBe(expected.status)
  expect(output.status).toBe(`Pinned "coder"`)
  const after = await snapshotOf(api)
  expect(withoutUpdated(after.records)).toEqual(withoutUpdated(expected.records.map((record) => ({ ...record }))))
  const combined = (await runOk(need(tools, "instructions_set"), { id: node.id, text: "pinned text", pin: false })) as {
    status: string
  }
  expect(combined.status).toBe(`Unpinned "coder"`)
  const afterCombined = await snapshotOf(api)
  expect(afterCombined.records.some((record) => record.type === "customization" && record.text === "pinned text")).toBe(true)
})

test("toggling the execute row through set succeeds and writes the state record", async () => {
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
  const node = expandedTree(memoFromSnapshot(snapshot)).find((candidate) => candidate.address?.item === "tool:execute")
  if (node === undefined) throw new Error("missing execute row")
  const before = await snapshotOf(api)
  const expected = toggle(memoFromSnapshot(before), node.id)
  if ("refusal" in expected) throw new Error(`expected execute toggle success: ${expected.refusal}`)
  const output = (await runOk(need(tools, "instructions_set"), { id: node.id })) as { status: string }
  expect(output.status).toBe(expected.status)
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "customization" && record.item === "tool:execute" && record.state === "off")).toBe(
    true,
  )
  const pinError = await runFail(need(tools, "instructions_set"), { id: node.id, pin: true })
  expect(pinError.message).toBe(`"execute" is host-owned: toggle only`)
})

test("a stale bare-id toggle reports the status that actually committed", async () => {
  const { project } = await tempProject()
  const ctx = fixtureContext(project)
  const state = createState()
  const real = createPlusApi(ctx, state)
  const before = await snapshotOf(real)
  const memo = memoFromSnapshot(before)
  const target = expandedTree(memo).find((candidate) => candidate.address?.item === "tool:reader")
  if (target === undefined) throw new Error("missing reader row")
  let calls = 0
  const wrapped: PlusApi = {
    ...real,
    mutate: async (input) => {
      calls += 1
      if (calls === 1) {
        const concurrentOp = toggle(memo, target.id)
        if ("refusal" in concurrentOp) throw new Error(`concurrent toggle refused: ${concurrentOp.refusal}`)
        const concurrent = await real.mutate({
          expectedRevision: before.revision,
          expectedGlobalRevision: before.globalRevision,
          records: [...concurrentOp.records, ...concurrentOp.splits] as unknown as Plus.MutateInput["records"],
          actor: { type: "tui" },
        })
        if (!concurrent.ok) throw new Error("concurrent write failed")
        const fresh = await real.snapshot()
        if (!fresh.ok) throw new Error("fresh snapshot failed")
        return {
          ok: true as const,
          value: { ok: false as const, reason: "stale" as const, store: "project" as const, snapshot: fresh.value },
        }
      }
      return real.mutate(input)
    },
  }
  await registerInstructionTools(ctx, wrapped)
  const tools = await readTools(ctx)
  const output = (await runOk(need(tools, "instructions_set"), { id: target.id })) as { status: string }
  expect(output.status).toBe(`Enabled "reader"`)
  const after = await snapshotOf(real)
  const enabled = after.records.find((record) => record.type === "customization" && record.item === "tool:reader")
  if (enabled === undefined || enabled.type !== "customization") throw new Error("expected committed record")
  expect(enabled.state).toBe("on")
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

test("create model, activate through set, list with item:model and active, then delete", async () => {
  const { project } = await tempProject()
  const models = [modelInfo("acme", "nova-1"), modelInfo("acme", "nova-2")]
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "reader", description: "read things", options: { codemode: false } }],
    skills: [skillInfo("notes", "skill body")],
    models,
    classifications: { "nova-1": "general", "nova-2": "general" },
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const created = (await runOk(need(tools, "instructions_create"), {
    kind: "model",
    providerID: "acme",
    modelID: "nova-2",
    level: "defaults",
    agent: "alpha",
  })) as { providerID: string; modelID: string }
  expect(created).toMatchObject({ providerID: "acme", modelID: "nova-2" })
  const snapshot = await snapshotOf(api)
  const row = expandedTree(memoFromSnapshot(snapshot)).find((node) => node.address?.item === "model:acme/nova-2")
  if (row === undefined) throw new Error("missing model row")
  const activated = (await runOk(need(tools, "instructions_set"), { id: row.id, active: true })) as { status: string }
  expect(activated.status).toBe(`Activated "acme/nova-2"`)
  const listed = (await runOk(need(tools, "instructions_list"), { where: "item:model active:true" })) as { rows: readonly { id: string }[] }
  expect(listed.rows.some((entry) => entry.id === row.id)).toBe(true)
  const deleted = (await runOk(need(tools, "instructions_delete"), { id: row.id, confirm: true })) as { providerID: string }
  expect(deleted).toMatchObject({ providerID: "acme" })
  void catalogHarness
})
