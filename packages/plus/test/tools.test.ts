import { afterAll, afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState, createHandlers } from "../src/index.js"
import type { PlusApi } from "../src/index.js"
import { Plus } from "../src/rpc.js"
import { enable } from "../src/project.js"
import { globalRecordsPath, globalTeamsPath, projectLogPath, projectRecordsPath, projectTeamsPath, teachingFilePath, teachingSkillId, teamsDataDir } from "../src/instructions/paths.js"
import { saveRun } from "../src/teams/run.js"
import { load, save } from "../src/instructions/store.js"
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
import type { MemoInput, TreeNodeKind } from "../src/instructions/tree.js"
import { registerInstructionTools } from "../src/tools.js"
import { plusTeamPresets } from "../src/instructions/presets.js"
import { presetStateOfSnapshot } from "../src/instructions/snapshot.js"
import type { Context } from "@opencode/plugin/effect/plugin"
import { agentHarness, agentInfo, catalogHarness, context, fullContext, modelInfo, skillHarness, skillInfo, toolHarness } from "./harness.js"

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

// DESIGN §3.3: a user agent's shared rows fall back to off unless a preset
// sets them. Where a test is about something else, its fixture agent stands
// for an agent created from the Native `build` preset (linked at the level the
// agent is addressed at), so every row it does not customize keeps its native
// value.
async function linkToBuild(project: string, level: "project" | "global" | "defaults", ids: readonly string[]): Promise<void> {
  const loaded = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: [
      ...loaded.records,
      ...ids.map((id) => ({
        type: "link" as const,
        level,
        agent: id,
        preset: { kind: "agent" as const, id: "build" },
        updated: "2026-01-01T00:00:00.000Z",
      })),
    ],
  })
  if (!saved.ok) throw new Error("linkToBuild: stale save")
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
      ...(item.permTool === undefined ? {} : { permTool: item.permTool }),
      ...(item.ruleId === undefined ? {} : { ruleId: item.ruleId }),
      ...(item.patterns === undefined ? {} : { patterns: [...item.patterns] }),
      ...(item.keywords === undefined ? {} : { keywords: [...item.keywords] }),
      ...(item.provenance === undefined ? {} : { provenance: [...item.provenance] }),
      ...(item.custom === undefined ? {} : { custom: item.custom }),
      ...(item.permAction === undefined ? {} : { permAction: item.permAction }),
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
          : record.type === "rule"
            ? {
                type: "rule" as const,
                level: record.level,
                agent: record.agent,
                tool: record.tool,
                id: record.id,
                label: record.label,
                patterns: [...record.patterns],
                keywords: [...record.keywords],
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
    ),
    agents: snapshot.agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      ...(agent.origin === undefined ? {} : { origin: agent.origin }),
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
      ...(team.overlay !== undefined ? { overlay: [...team.overlay] } : {}),
    })),
    // Links, Defaults entries and user presets: the chain reads them.
    ...presetStateOfSnapshot(snapshot),
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

async function freshFixture(overrides?: Partial<Parameters<typeof fullContext>[0]>): Promise<{ ctx: Context; api: PlusApi; tools: Map<string, Tool.Info & { readonly id: string }>; project: string }> {
  const { project } = await tempProject()
  const ctx = fixtureContext(project, overrides)
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
  const skillBody = "Take notes."
  process.env.OPENCODE_CONFIG_DIR = toolConfig
  // The tool resolves every create's returned row through the tree, and the
  // unit harnesses for skills and MCP do not rescan the disk the way core's
  // watcher does, so the host registry here must already list what the create
  // writes. The files themselves are still written by the real create paths
  // and compared below.
  const toolCtx = fixtureContext(toolProject, {
    skills: [skillInfo("notes2", skillBody)],
    servers: [["search", { type: "remote", url: "https://example.test" }]],
  })
  const toolApi = createPlusApi(toolCtx, createState())
  await registerInstructionTools(toolCtx, toolApi)
  const toolTools = await readTools(toolCtx)
  const toolCreate = need(toolTools, "instructions_create")
  process.env.OPENCODE_CONFIG_DIR = apiConfig
  const apiCtx = fixtureContext(apiProject)
  const apiApi = createPlusApi(apiCtx, createState())
  const baseTitle = "Custom.txt"
  const baseText = "custom base"
  // const instructionText = "Follow the guide."
  const mcpConfig = { type: "remote", url: "https://example.test" }
  process.env.OPENCODE_CONFIG_DIR = toolConfig
  // "<id>" names an agent preset in the string form tools accept.
  await runOk(toolCreate, { kind: "agent", id: "helper", preset: "orchestrator" })
  await runOk(toolCreate, { kind: "skill", name: "notes2", body: skillBody })
  await runOk(toolCreate, { kind: "base", id: "custom", title: baseTitle, text: baseText })
  // OpenCodePlus: create kind:"instruction" is disabled pending the Context
  // catalogue (src/instructions/discover.ts); the api path below stays skipped too
  // so both sides write the same files.
  // await runOk(toolCreate, { kind: "instruction", name: "AGENTS.md", text: instructionText })
  await runOk(toolCreate, { kind: "mcp", name: "search", config: mcpConfig })
  process.env.OPENCODE_CONFIG_DIR = apiConfig
  const apiAgent = await apiApi.createAgent({ scope: "project", id: "helper", preset: { kind: "agent", id: "orchestrator" } })
  if (!apiAgent.ok) throw new Error(`api createAgent failed: ${apiAgent.error.message}`)
  const apiSkill = await apiApi.createSkill({ name: "notes2", body: skillBody })
  if (!apiSkill.ok) throw new Error(`api createSkill failed: ${apiSkill.error.message}`)
  const apiBase = await apiApi.createBase({ id: "custom", title: baseTitle, text: baseText })
  if (!apiBase.ok) throw new Error(`api createBase failed: ${apiBase.error.message}`)
  // const apiInstruction = await apiApi.createInstruction({ name: "AGENTS.md", text: instructionText })
  // if (!apiInstruction.ok) throw new Error(`api createInstruction failed: ${apiInstruction.error.message}`)
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
  // The preset's description and mode, and an empty body (DESIGN §5).
  expect(normalizeRoots(toolProjectFiles.get(agentKey) ?? "")).toBe(
    '---\ndescription: "Owns work, delegates by task, verifies and integrates"\nmode: primary\n---\n',
  )
  const skillKey = [...toolProjectFiles.keys()].find((key) => key.endsWith(path.join("notes2", "SKILL.md")))
  if (skillKey === undefined) throw new Error("missing notes2 skill file")
  expect(toolProjectFiles.get(skillKey) ?? "").toContain(skillBody)
  expect(toolProjectFiles.get(skillKey) ?? "").toContain("name: notes2")
  expect(toolBaseFiles.get("custom.txt") ?? "").toBe(baseText)
  expect(toolBaseFiles.get("index.json") ?? "").toContain(baseTitle)
  // expect(toolProjectFiles.get("AGENTS.md") ?? "").toContain(instructionText)
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

// OpenCodePlus: AGENTS.md handling is disabled pending the Context catalogue
// (src/instructions/discover.ts). Tests that exist only to exercise AGENTS.md
// rows, their apply, or instruction.create/delete are skipped, not deleted, so
// the rework re-enables them with the feature.
test.skip("delete instruction removes the project file", async () => {
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

test("delete team member removes a project team member and reports the plan status", async () => {
  const { project } = await tempProject()
  const memberPath = path.join(projectTeamsPath(project), "crew", "alpha.md")
  await fs.mkdir(path.dirname(memberPath), { recursive: true })
  await Bun.write(memberPath, formatMarkdown({ description: "alpha" }, "role"))
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const memberRow = expandedTree(memo).find((node) => node.id === "team:project:crew:alpha")
  if (memberRow === undefined) throw new Error("missing team member row")
  const memberPlan = removalPlan(memo, memberRow.id)
  if ("refusal" in memberPlan) throw new Error(`expected team member plan: ${memberPlan.refusal}`)
  const deletedMember = (await runOk(need(tools, "instructions_delete"), { id: memberRow.id, confirm: true })) as {
    status: string
  }
  expect(deletedMember.status).toBe(memberPlan.successStatus)
  expect(await Bun.file(memberPath).exists()).toBe(false)

  const nextSnapshot = await snapshotOf(api)
  const crewTeam = nextSnapshot.teams?.find((team) => team.team === "crew" && team.level === "project")
  expect(crewTeam?.agents).not.toContain("alpha")

  const logged = await api.log({ where: "actor:tool" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "team.removeAgent")
  if (entry === undefined) throw new Error("missing team.removeAgent log entry")
  expect(entry.actor).toEqual({ type: "tool", agent: "alpha", sessionID: "ses_tools_test", messageID: "msg_tools_test" })
})

test("delete shipped defaults team member is refused with shipped member wording and writes nothing", async () => {
  const { project } = await tempProject()
  const ctx = fixtureContext(project)
  // No team ships at Defaults any more (DESIGN §2: the shipped teams are Plus
  // team presets); the injected registry stands for a Defaults team.
  const api = createPlusApi(ctx, createState(), { builtins: [{ name: "starter", members: [{ id: "planner", body: "planner body" }] }] })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const shippedRow = expandedTree(memo).find((node) => node.id === "team:defaults:starter:planner")
  if (shippedRow === undefined) throw new Error("missing shipped team member row")
  const plan = removalPlan(memo, shippedRow.id)
  if (!("refusal" in plan)) throw new Error("expected refusal for shipped team member")
  expect(plan.refusal).toContain('shipped member of built-in team "starter"')

  const error = await runFail(need(tools, "instructions_delete"), { id: shippedRow.id, confirm: true })
  expect(error.message).toContain('shipped member of built-in team "starter"')

  const logged = await api.log({ where: "actor:tool" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "team.removeAgent")
  expect(entry).toBeUndefined()
})

test("delete team removes a project team directory and reports the plan status", async () => {
  const { project } = await tempProject()
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)

  const created = await api.createTeam({ level: "project", team: "crew" })
  if (!created.ok) throw new Error("create team failed")
  const added = await api.addTeamAgent({ level: "project", team: "crew", id: "alpha" })
  if (!added.ok) throw new Error("add member failed")

  const teamDir = path.join(projectTeamsPath(project), "crew")
  expect(await Bun.file(path.join(teamDir, "alpha.md")).exists()).toBe(true)

  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const teamRow = expandedTree(memo).find((node) => node.id === "team:project:crew")
  if (teamRow === undefined) throw new Error("missing team row")
  const teamDeletePlan = removalPlan(memo, teamRow.id)
  if ("refusal" in teamDeletePlan) throw new Error(`expected team.delete plan: ${teamDeletePlan.refusal}`)

  const deletedTeam = (await runOk(need(tools, "instructions_delete"), { id: teamRow.id, confirm: true })) as {
    status: string
    removedMembers: number
  }
  expect(deletedTeam.status).toBe(teamDeletePlan.successStatus)
  expect(deletedTeam.removedMembers).toBe(1)
  expect(await fs.stat(teamDir).then(() => true, () => false)).toBe(false)

  const nextSnapshot = await snapshotOf(api)
  expect(nextSnapshot.teams?.find((team) => team.team === "crew")).toBeUndefined()

  const logged = await api.log({ where: "actor:tool" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "team.delete")
  if (entry === undefined) throw new Error("missing team.delete log entry")
  expect(entry.actor).toEqual({ type: "tool", agent: "alpha", sessionID: "ses_tools_test", messageID: "msg_tools_test" })
  expect(entry.target).toBe("team:project:crew")
})

// DESIGN §2: the Defaults teams overlay directory is no longer read, so a
// file left there is no member: no row exists and delete has nothing to find.
test("a file in the old Defaults overlay directory is no team member row", async () => {
  const { project } = await tempProject()
  const ctx = fixtureContext(project)
  const registry = [{ name: "starter", members: [{ id: "planner", body: "planner body" }] }]
  const overlayFile = path.join(process.env.OPENCODE_CONFIG_DIR ?? "", "opencodeplus", "teams-defaults", "starter", "helper.md")
  await fs.mkdir(path.dirname(overlayFile), { recursive: true })
  await Bun.write(overlayFile, "helper role")
  const api = createPlusApi(ctx, createState(), { builtins: registry })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  expect(expandedTree(memo).some((node) => node.id === "team:defaults:starter:helper")).toBe(false)
  const starterTeam = snapshot.teams?.find((team) => team.team === "starter" && team.level === "defaults")
  expect(starterTeam?.agents).toEqual(["planner"])
  const error = await runFail(need(tools, "instructions_delete"), { id: "team:defaults:starter:helper", confirm: true })
  expect(error.message).toContain("row.unknown")
  expect(await Bun.file(overlayFile).exists()).toBe(true)
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

// state.tooling holds one registration per thing installTooling installs: the
// teaching instruction file, the teaching skill, the instructions tool
// namespace, and the search MCP server only when the host configures none of
// that name. Each is asserted by what it installs, never by how many there
// are, so the optional search registration cannot decide the expectation.
test("no instructions tool is registered while disabled, and disabling disposes them", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-tools-enable-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fixtureContext(project)
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const toolIds = async () => [...(await readTools(ctx)).keys()].filter((id) => id.startsWith("instructions_"))
  const skillIds = async (): Promise<string[]> => (await Effect.runPromise(ctx.skill.list())).data.map((skill) => skill.id)
  const serverNames = async () => {
    const names: string[] = []
    const probe = await Effect.runPromise(
      Effect.scoped(
        ctx.mcp.transform((editor) => {
          names.push(...editor.list().map(([name]) => name))
        }),
      ),
    )
    await Effect.runPromise(probe.dispose)
    return names
  }
  const beforeServers = await serverNames()
  expect(await toolIds()).toEqual([])
  expect(await skillIds()).not.toContain(teachingSkillId)
  await Effect.runPromise(
    handlers["project.enable"](undefined, {
      error: () => {
        throw new Error("unexpected enable error")
      },
    }),
  )
  expect(await toolIds()).toHaveLength(8)
  expect(await skillIds()).toContain(teachingSkillId)
  // Only the install side: the harness instruction domain disposes to a no-op,
  // so the disposal proof below rests on the skill, tool and MCP domains.
  const instructionPaths: string[] = []
  const instructions = await Effect.runPromise(
    Effect.scoped(
      ctx.instruction.transform((editor) => {
        instructionPaths.push(...editor.list().map((file) => file.path))
      }),
    ),
  )
  await Effect.runPromise(instructions.dispose)
  expect(instructionPaths).toContain(teachingFilePath())
  // Configured either way: Plus registers its own here, and a host that
  // already has one keeps it.
  expect(await serverNames()).toContain("search")
  const installed = [...state.tooling]
  await Effect.runPromise(
    handlers["project.enable"](undefined, {
      error: () => {
        throw new Error("unexpected enable error")
      },
    }),
  )
  expect(state.tooling).toEqual(installed)
  expect(await toolIds()).toHaveLength(8)
  await Effect.runPromise(
    handlers["project.disable"](undefined, {
      error: () => {
        throw new Error("unexpected disable error")
      },
    }),
  )
  expect(await toolIds()).toEqual([])
  expect(await skillIds()).not.toContain(teachingSkillId)
  expect(await serverNames()).toEqual(beforeServers)
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
  // The harness skill registry does not rescan the disk, so the created skill
  // is listed here for the create's row lookup; the file write is still real.
  const { api, tools } = await freshFixture({ skills: [skillInfo("loggedskill", "seed")] })
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
    id: string
    item: string
  }
  expect(output).toEqual({ level: "project", team: "crew", enabled: false, id: "team:project:crew", item: "crew" })
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
  const record = (await runOk(show, { id, view: "record" })) as { record: { type?: string; text?: string } | null }
  expect(record.record).not.toBeNull()
  expect(record.record?.type).toBe("customization")
  expect(record.record?.text).toBe("mine text\nline two\n")
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
  const error = await runFail(need(tools, "instructions_create"), { kind: "agent", id: "build" })
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
  await linkToBuild(project, "defaults", ["alpha"])
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
  await linkToBuild(project, "defaults", ["alpha"])
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
  const recordView = (await runOk(need(tools, "instructions_show"), { id: row.id, view: "record" })) as {
    id: string
    view: string
    record: { type?: string; active?: boolean } | null
  }
  expect(recordView.record?.type).toBe("model")
  expect(recordView.record?.active).toBe(true)
  const listed = (await runOk(need(tools, "instructions_list"), { where: "item:model active:true" })) as { rows: readonly { id: string }[] }
  expect(listed.rows.some((entry) => entry.id === row.id)).toBe(true)
  const deleted = (await runOk(need(tools, "instructions_delete"), { id: row.id, confirm: true })) as { providerID: string }
  expect(deleted).toMatchObject({ providerID: "acme" })
  void catalogHarness
})

test("perm rules toggle, show, list by item:perm and tool, create custom, and delete only customs", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell. Use git push to publish.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const row = expandedTree(memoFromSnapshot(snapshot)).find((node) => node.address?.item === "perm:shell:git-push")
  if (row === undefined) throw new Error("missing perm:shell:git-push row")
  const listed = (await runOk(need(tools, "instructions_list"), { where: "item:perm tool:shell" })) as { rows: readonly { id: string }[]; total: number }
  expect(listed.total).toBeGreaterThan(0)
  expect(listed.rows.some((entry) => entry.id === row.id)).toBe(true)
  const shown = (await runOk(need(tools, "instructions_show"), { id: row.id })) as { patterns: string[]; keywords: string[]; provenance: string[]; scrub: { hidden: number }; message?: string }
  expect(shown.patterns).toEqual(["git push *"])
  expect(shown.keywords).toContain("git push")
  expect(Array.isArray(shown.provenance)).toBe(true)
  // A shipped curated rule carries a short refusal message, and show reads it.
  expect(shown.message).toBe("pushing is not allowed here")
  const toggled = (await runOk(need(tools, "instructions_set"), { id: row.id, state: "off" })) as { status: string }
  expect(toggled.status).toContain("Disabled")
  const afterOff = await snapshotOf(api)
  expect(afterOff.records.some((record) => record.type === "customization" && record.item === "perm:shell:git-push" && record.state === "off")).toBe(true)
  const curatedShownRecord = (await runOk(need(tools, "instructions_show"), { id: row.id, view: "record" })) as {
    record: { type?: string; state?: string } | null
  }
  expect(curatedShownRecord.record?.type).toBe("customization")
  expect(curatedShownRecord.record?.state).toBe("off")
  const textError = await runFail(need(tools, "instructions_set"), { id: row.id, text: "nope" })
  expect(textError.message).toContain("cannot be edited")
  const created = (await runOk(need(tools, "instructions_create"), { kind: "rule", tool: "shell", id: "no-push", label: "No pushes", patterns: ["git push --force *"], message: "force pushes are not allowed here" })) as { tool: string; id: string; item: string }
  // A rule with no agent is shared: it lands in the Defaults catalogue and
  // returns that row id, not the project-level default the old code wrote.
  expect(created).toMatchObject({ tool: "shell", id: "item:defaults::perm:shell:no-push", item: "perm:shell:no-push" })
  const afterCreate = await snapshotOf(api)
  const customRow = expandedTree(memoFromSnapshot(afterCreate)).find((node) => node.address?.item === "perm:shell:no-push")
  if (customRow === undefined) throw new Error("missing custom perm row")
  const customShownRecord = (await runOk(need(tools, "instructions_show"), { id: customRow.id, view: "record" })) as {
    id: string
    view: string
    record: { type?: string; patterns?: readonly string[] } | null
  }
  expect(customShownRecord.record?.type).toBe("rule")
  expect(customShownRecord.record?.patterns).toEqual(["git push --force *"])
  // A message-only set derives label and patterns from the rule it edits.
  const messaged = (await runOk(need(tools, "instructions_set"), { id: customRow.id, message: "no force pushes here" })) as { status: string }
  expect(messaged.status).toContain("Updated")
  await runOk(need(tools, "instructions_set"), { id: customRow.id, state: "off" })
  const customBoth = (await runOk(need(tools, "instructions_show"), { id: customRow.id, view: "record" })) as {
    record: { type?: string; patterns?: readonly string[] } | null
  }
  expect(customBoth.record?.type).toBe("rule")
  expect(customBoth.record?.patterns).toEqual(["git push --force *"])
  const unconfirmed = await runFail(need(tools, "instructions_delete"), { id: customRow.id })
  expect(unconfirmed.message).toContain("delete.unconfirmed")
  const deleted = (await runOk(need(tools, "instructions_delete"), { id: customRow.id, confirm: true })) as { tool: string }
  expect(deleted).toMatchObject({ tool: "shell" })
  const curatedDelete = await runFail(need(tools, "instructions_delete"), { id: row.id, confirm: true })
  expect(curatedDelete.message).toContain("only user-created rules")
})

test("a Teams-catalogue rule keeps its catalogue through a message set, and a curated Teams row materialises a Teams override", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    tools: [{ id: "shell", description: "Run shell. Use git push to publish.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)

  const created = (await runOk(need(tools, "instructions_create"), {
    kind: "rule",
    tool: "shell",
    id: "round3-team-edit",
    label: "Round3 team edit",
    patterns: ["printf round3-team-edit"],
    message: "Round3 team edit refuses.",
    level: "defaults",
    catalogue: "teams",
  })) as { id: string; item: string }
  expect(created).toMatchObject({ id: "item:defaults:/teams:perm:shell:round3-team-edit", item: "perm:shell:round3-team-edit" })

  // A message-only set through the real tool handler addresses the Teams row.
  // The stored record must keep its catalogue, or the edit silently turns a
  // Teams rule into an Agents one.
  const edited = (await runOk(need(tools, "instructions_set"), { id: created.id, message: "Round3 team edit revised." })) as { status: string }
  expect(edited.status).toContain("Updated")

  const afterEdit = await snapshotOf(api)
  const storedEdit = afterEdit.records.find((record) => record.type === "rule" && record.id === "round3-team-edit")
  expect(storedEdit).toMatchObject({ level: "defaults", agent: null, catalogue: "teams", message: "Round3 team edit revised." })
  const shownEdit = (await runOk(need(tools, "instructions_show"), { id: created.id })) as { message?: string }
  expect(shownEdit.message).toBe("Round3 team edit revised.")

  // The curated shell rule has no stored record here, so a message write from
  // its Teams row is a first write and must land in the Teams catalogue.
  const curatedRow = expandedTree(memoFromSnapshot(afterEdit)).find(
    (node) =>
      node.address?.item === "perm:shell:git-push" &&
      node.address.level === "defaults" &&
      node.address.agent === null &&
      node.address.catalogue === "teams",
  )
  if (curatedRow === undefined) throw new Error("missing Teams-catalogue curated row")
  const override = (await runOk(need(tools, "instructions_set"), { id: curatedRow.id, message: "no pushes in this team" })) as { status: string }
  expect(override.status).toContain("Updated")

  const afterOverride = await snapshotOf(api)
  const storedOverride = afterOverride.records.find((record) => record.type === "rule" && record.id === "git-push")
  expect(storedOverride).toMatchObject({ level: "defaults", agent: null, catalogue: "teams", message: "no pushes in this team" })
  const shownOverride = (await runOk(need(tools, "instructions_show"), { id: curatedRow.id })) as { message?: string }
  expect(shownOverride.message).toBe("no pushes in this team")

  // The override is on disk in the global store under the Teams catalogue.
  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(globalText).toContain('"id":"git-push"')
  expect(globalText).toContain('"catalogue":"teams"')
})

// instructions_list reads api.snapshot(), so a team member's policy rows reach
// the tool only through the boundary shape. The rows asserted here govern
// permission actions with no tool row to hang under, so they exist nowhere
// else in the tree.
test("instructions_list returns a team member's own policy rows even for a tool with no tool row", async () => {
  const { project } = await tempProject()
  process.env.XDG_DATA_HOME = path.join(path.dirname(project), "data")
  const member = "gemini-implementer"
  const memberFile = path.join(projectTeamsPath(project), "crew", `${member}.md`)
  await fs.mkdir(path.dirname(memberFile), { recursive: true })
  await Bun.write(memberFile, formatMarkdown({ description: `crew/${member}` }, "role"))
  // A live delegated run of the member: its edit-scope row installs core rules
  // on edit, which this host does not register.
  const now = new Date().toISOString()
  await saveRun(teamsDataDir(), {
    id: "w-0000000000000007",
    role: member,
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: project,
    paths: ["src/*"],
    branch: "team/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "working",
    attempts: [],
    task: null,
    parent: "main-0123456789abcdef",
    children: [],
    briefSha: "abc",
    bundle: "tools-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
  })
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const enabled = await api.setTeamEnabled({ level: "project", team: "crew", enabled: true, actor: { type: "tui" } })
  if (!enabled.ok) throw new Error(`setTeamEnabled failed: ${enabled.error.message}`)
  // Every tool now lists its catalog rows too, so the member's rows span
  // more than the default page of 40.
  const listed = (await runOk(need(tools, "instructions_list"), { where: `item:perm agent:${member}`, limit: 1000 })) as {
    rows: readonly { id: string }[]
    total: number
  }
  expect(listed.total).toBeGreaterThan(0)
  const ids = listed.rows.map((entry) => entry.id)
  expect(ids).toContain(`item:project:crew/:${member}:perm:edit:run:w-0000000000000007`)
  // No row carries a role: the former role rows are shared rows a preset sets.
  expect(ids.filter((id) => id.endsWith(":team-role") || id.endsWith(":role-ceiling") || id.endsWith(":team-tavily"))).toEqual([])
})

test("deleting a protected agent's custom rule through another agent's row is refused", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const added = await api.addRule({ level: "project", agent: "alpha", tool: "shell", id: "custom", label: "Custom", patterns: ["danger *"], actor: { type: "tui" } })
  if (!added.ok) throw new Error(`addRule failed: ${added.error.message}`)
  const snapshot = await snapshotOf(api)
  const betaRow = expandedTree(memoFromSnapshot(snapshot)).find(
    (node) => node.address?.item === "perm:shell:custom" && node.address?.agent === "beta",
  )
  if (betaRow === undefined) throw new Error("missing beta row for alpha-owned custom rule")
  const error = await runFail(need(tools, "instructions_delete"), { id: betaRow.id, confirm: true })
  expect(error.message).toContain("agent.protected")
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "custom")).toBe(true)
})

async function logLines(project: string): Promise<string[]> {
  const file = Bun.file(projectLogPath(project))
  if (!(await file.exists())) return []
  const text = await file.text()
  return text.split("\n").filter((line) => line.length > 0)
}

test("removeRule refuses a protected owner's rule for a tool actor and lets the TUI remove it", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  const added = await api.addRule({ level: "project", agent: "alpha", tool: "shell", id: "custom", label: "Custom", patterns: ["danger *"], actor: { type: "tui" } })
  if (!added.ok) throw new Error(`addRule failed: ${added.error.message}`)
  const beforeLogs = await logLines(project)
  // A tool actor is refused even at the owner's own address: protection is
  // decided at the API boundary, not by the row the caller addressed.
  const refused = await api.removeRule({ level: "project", agent: "alpha", tool: "shell", id: "custom", actor: { type: "tool" } })
  expect(refused.ok).toBe(false)
  if (refused.ok) throw new Error("expected removeRule refusal")
  expect(refused.error.code).toBe("agent.protected")
  expect(refused.error.message).toContain("agent.protected")
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "custom")).toBe(true)
  expect(await logLines(project)).toEqual(beforeLogs)
  // The TUI writes the same row through the same boundary.
  const tui = await api.removeRule({ level: "project", agent: "alpha", tool: "shell", id: "custom" })
  expect(tui.ok).toBe(true)
  if (!tui.ok) throw new Error(`removeRule failed: ${tui.error.message}`)
  expect(tui.value).toMatchObject({ level: "project", agent: "alpha", tool: "shell", id: "custom" })
  const gone = await snapshotOf(api)
  expect(gone.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "custom")).toBe(false)
  expect((await logLines(project)).length).toBeGreaterThan(beforeLogs.length)
})

test("rule.remove RPC from another agent's row refuses a tool actor and lets the TUI remove it", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const state = createState()
  const api = createPlusApi(ctx, state)
  const added = await api.addRule({ level: "project", agent: "alpha", tool: "shell", id: "custom", label: "Custom", patterns: ["danger *"], actor: { type: "tui" } })
  if (!added.ok) throw new Error(`addRule failed: ${added.error.message}`)
  const snapshot = await snapshotOf(api)
  const betaRow = expandedTree(memoFromSnapshot(snapshot)).find(
    (node) => node.address?.item === "perm:shell:custom" && node.address?.agent === "beta",
  )
  if (betaRow?.address === undefined) throw new Error("missing beta row for alpha-owned custom rule")
  const beforeLogs = await logLines(project)
  const handlers = createHandlers(ctx, state)
  const captured: { current?: { type: string; message: string } } = {}
  const throwing = {
    error: (type: string, message: string, _data?: unknown) => {
      captured.current = { type, message }
      throw captured.current
    },
  }
  const exit = await Effect.runPromiseExit(
    handlers["rule.remove"](
      { level: betaRow.address.level, agent: betaRow.address.agent, tool: "shell", id: "custom", actor: { type: "tool" } },
      throwing,
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(captured.current?.type).toBe("agent.protected")
  expect(captured.current?.message).toContain("agent.protected")
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "custom")).toBe(true)
  expect(await logLines(project)).toEqual(beforeLogs)
  // state.ts forwards the selected row address verbatim with no actor: a
  // missing actor means the TUI, so the same call succeeds.
  const tui = await Effect.runPromise(
    handlers["rule.remove"](
      { level: betaRow.address.level, agent: betaRow.address.agent, tool: "shell", id: "custom" },
      throwing,
    ),
  )
  expect(tui).toEqual({ level: "project", agent: "alpha", tool: "shell", id: "custom", label: "Custom" })
  const gone = await snapshotOf(api)
  expect(gone.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "custom")).toBe(false)
  expect((await logLines(project)).length).toBeGreaterThan(beforeLogs.length)
})

test("updating a protected agent's custom rule through another agent's row is refused (tools API)", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const added = await api.addRule({ level: "project", agent: "alpha", tool: "shell", id: "custom", label: "Custom", patterns: ["danger *"], actor: { type: "tui" } })
  if (!added.ok) throw new Error(`addRule failed: ${added.error.message}`)
  const snapshot = await snapshotOf(api)
  const betaRow = expandedTree(memoFromSnapshot(snapshot)).find(
    (node) => node.address?.item === "perm:shell:custom" && node.address?.agent === "beta",
  )
  if (betaRow === undefined) throw new Error("missing beta row for alpha-owned custom rule")
  const error = await runFail(need(tools, "instructions_set"), { id: betaRow.id, label: "Hacked", patterns: ["evil *"] })
  expect(error.message).toContain("agent.protected")
  const after = await snapshotOf(api)
  const kept = after.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "custom")
  if (kept === undefined || kept.type !== "rule") throw new Error("expected rule to survive")
  expect(kept.label).toBe("Custom")
})

test("rule.update RPC from another agent's row refuses a tool actor and lets the TUI write", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const state = createState()
  const api = createPlusApi(ctx, state)
  const added = await api.addRule({ level: "project", agent: "alpha", tool: "shell", id: "custom", label: "Custom", patterns: ["danger *"], actor: { type: "tui" } })
  if (!added.ok) throw new Error(`addRule failed: ${added.error.message}`)
  const snapshot = await snapshotOf(api)
  const betaRow = expandedTree(memoFromSnapshot(snapshot)).find(
    (node) => node.address?.item === "perm:shell:custom" && node.address?.agent === "beta",
  )
  if (betaRow?.address === undefined) throw new Error("missing beta row for alpha-owned custom rule")
  const beforeLogs = await logLines(project)
  const handlers = createHandlers(ctx, state)
  const captured: { current?: { type: string; message: string } } = {}
  const throwing = {
    error: (type: string, message: string, _data?: unknown) => {
      captured.current = { type, message }
      throw captured.current
    },
  }
  const exit = await Effect.runPromiseExit(
    handlers["rule.update"](
      { level: betaRow.address.level, agent: betaRow.address.agent, tool: "shell", id: "custom", label: "Hacked", patterns: ["evil *"], actor: { type: "tool" } },
      throwing,
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(captured.current?.type).toBe("agent.protected")
  expect(captured.current?.message).toContain("agent.protected")
  const after = await snapshotOf(api)
  const kept = after.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "custom")
  if (kept === undefined || kept.type !== "rule") throw new Error("expected rule to survive")
  expect(kept.label).toBe("Custom")
  expect(await logLines(project)).toEqual(beforeLogs)
  // Exact capture for the T3 evidence document: the tool-actor refusal this
  // real handler produced and the storage it left untouched. The check
  // harness truncates stdout but keeps stderr whole. No assertion reads it.
  console.error(
    "T3 rule.update refusal:",
    JSON.stringify({ refused: captured.current, storedLabel: kept.label, logLinesUnchanged: (await logLines(project)).length === beforeLogs.length }),
  )
  // The TUI path (no actor) writes the same row through the same boundary.
  const tui = await Effect.runPromise(
    handlers["rule.update"](
      { level: betaRow.address.level, agent: betaRow.address.agent, tool: "shell", id: "custom", label: "Hacked", patterns: ["evil *"] },
      throwing,
    ),
  )
  expect(tui).toMatchObject({ level: "project", agent: "alpha", tool: "shell", id: "custom", label: "Hacked" })
  const written = await snapshotOf(api)
  const edited = written.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "custom")
  if (edited === undefined || edited.type !== "rule") throw new Error("expected edited rule")
  expect(edited.label).toBe("Hacked")
  expect(await logLines(project)).not.toEqual(beforeLogs)
  // Exact capture for the T3 evidence document: the same handler writing the
  // row for a TUI caller and appending the log line. No assertion reads it.
  console.error(
    "T3 rule.update tui write:",
    JSON.stringify({ written: edited.label, logLinesAppended: (await logLines(project)).length > beforeLogs.length }),
  )
})

test("updateRule creates a custom override for a curated row and updates it with a log line", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  const snapshot = await snapshotOf(api)
  const row = expandedTree(memoFromSnapshot(snapshot)).find((node) => node.address?.item === "perm:shell:git-push")
  if (row?.address === undefined) throw new Error("missing curated perm row")
  const created = await api.updateRule({
    level: row.address.level,
    agent: row.address.agent,
    tool: "shell",
    id: "git-push",
    label: "Git push edited",
    patterns: ["git push --force *"],
    actor: { type: "tui" },
  })
  if (!created.ok) throw new Error(`updateRule failed: ${created.error.message}`)
  expect(created.value).toMatchObject({ tool: "shell", id: "git-push", label: "Git push edited" })
  const afterCreate = await snapshotOf(api)
  const custom = afterCreate.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "git-push")
  if (custom === undefined || custom.type !== "rule") throw new Error("expected custom override")
  expect(custom.label).toBe("Git push edited")
  expect(custom.keywords).toContain("git push")
  const logged = await api.log({ where: "op:rule.update" })
  if (!logged.ok) throw new Error("log failed")
  expect(logged.value.total).toBeGreaterThan(0)
  expect(logged.value.entries.some((entry) => entry.op === "rule.update")).toBe(true)
  const updated = await api.updateRule({
    level: row.address.level,
    agent: row.address.agent,
    tool: "shell",
    id: "git-push",
    label: "Git push v2",
    patterns: ["git push *"],
    keywords: ["custom-key"],
    actor: { type: "tui" },
  })
  if (!updated.ok) throw new Error(`second update failed: ${updated.error.message}`)
  const afterUpdate = await snapshotOf(api)
  const second = afterUpdate.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "git-push")
  if (second === undefined || second.type !== "rule") throw new Error("expected rule after second update")
  expect(second.label).toBe("Git push v2")
  expect(second.keywords).toEqual(["custom-key"])
})

test("updateRule stale retry preserves the edit and the log agrees with what persisted", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  const seeded = await api.addRule({
    level: "project",
    agent: "alpha",
    tool: "shell",
    id: "race",
    label: "Original",
    patterns: ["orig *"],
    keywords: ["orig"],
    actor: { type: "tui" },
  })
  if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.message}`)
  // An unrelated write started first bumps the revision mid-update, forcing
  // saveRuleRecords through its merge retry. Without the content-replacement
  // fix the retry keeps the old label while reporting the new one.
  const [addedOther, updated] = await Promise.all([
    api.addRule({
      level: "project",
      agent: "alpha",
      tool: "shell",
      id: "other",
      label: "Other",
      patterns: ["other *"],
      actor: { type: "tui" },
    }),
    api.updateRule({
      level: "project",
      agent: "alpha",
      tool: "shell",
      id: "race",
      label: "New label",
      patterns: ["new *"],
      keywords: ["new"],
      actor: { type: "tui" },
    }),
  ])
  if (!addedOther.ok) throw new Error(`unrelated add failed: ${addedOther.error.message}`)
  if (!updated.ok) throw new Error(`update failed: ${updated.error.message}`)
  const after = await snapshotOf(api)
  const persisted = after.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "race")
  if (persisted === undefined || persisted.type !== "rule") throw new Error("expected race rule to persist")
  expect(persisted.label).toBe("New label")
  expect(persisted.patterns).toEqual(["new *"])
  expect(persisted.keywords).toEqual(["new"])
  expect(after.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "other")).toBe(true)
  expect(updated.value.label).toBe(persisted.label)
  const logged = await api.log({ where: "op:rule.update" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "rule.update" && candidate.target === "rule:project:alpha:shell:race")
  if (entry === undefined) throw new Error("missing rule.update log entry for the persisted target")
  // Both concurrent writes land (seed rev1, then two more), so the final
  // revision is 3 regardless of which wins first; the update's log entry is
  // 2 or 3 depending on order, but it always exists for the correct target
  // and the persisted values always match the update's response.
  expect(after.revision).toBe(3)
})

test("updateRule through a project row keeps a global rule in the global store", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  const added = await api.addRule({
    level: "global",
    agent: "alpha",
    tool: "shell",
    id: "shared",
    label: "Original",
    patterns: ["orig *"],
    actor: { type: "tui" },
  })
  if (!added.ok) throw new Error(`add failed: ${added.error.message}`)
  const updated = await api.updateRule({
    level: "project",
    agent: "alpha",
    tool: "shell",
    id: "shared",
    label: "Edited",
    patterns: ["edited *"],
    keywords: ["edited"],
    actor: { type: "tui" },
  })
  if (!updated.ok) throw new Error(`update failed: ${updated.error.message}`)
  expect(updated.value.level).toBe("global")
  expect(updated.value.agent).toBe("alpha")
  expect(updated.value.label).toBe("Edited")
  const after = await snapshotOf(api)
  const persisted = after.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "shared")
  if (persisted === undefined || persisted.type !== "rule") throw new Error("expected shared rule to persist")
  expect(persisted.level).toBe("global")
  expect(persisted.agent).toBe("alpha")
  expect(persisted.label).toBe("Edited")
  expect(persisted.patterns).toEqual(["edited *"])
  const { load } = await import("../src/instructions/store.js")
  const stored = await load(project)
  expect(stored.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "shared" && record.level === "global")).toBe(true)
  expect(stored.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "shared" && record.level === "project")).toBe(false)
  const { globalRecordsPath, projectRecordsPath } = await import("../src/instructions/paths.js")
  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(globalText).toContain(`"id":"shared"`)
  if (await Bun.file(projectRecordsPath(project)).exists()) {
    const projectText = await Bun.file(projectRecordsPath(project)).text()
    expect(projectText).not.toContain(`"id":"shared"`)
  }
  const logged = await api.log({ where: "op:rule.update" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "rule.update" && candidate.target === "rule:global:alpha:shell:shared")
  if (entry === undefined) throw new Error("missing global rule.update log entry")
})

test("updateRule retry preserves an unrelated concurrent deletion", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  const seedKeep = await api.addRule({
    level: "project",
    agent: "alpha",
    tool: "shell",
    id: "keep",
    label: "Keep",
    patterns: ["keep *"],
    actor: { type: "tui" },
  })
  if (!seedKeep.ok) throw new Error(`seed keep failed: ${seedKeep.error.message}`)
  const seedGone = await api.addRule({
    level: "project",
    agent: "alpha",
    tool: "shell",
    id: "gone",
    label: "Gone",
    patterns: ["gone *"],
    actor: { type: "tui" },
  })
  if (!seedGone.ok) throw new Error(`seed gone failed: ${seedGone.error.message}`)
  // Both load [keep, gone]; the removal wins first, forcing the update
  // through the stale-save merge retry. Without the delta fix the retry
  // recomputes additions as next-minus-fresh and resurrects the concurrently
  // removed row while the log mentions only the edited target.
  const [removed, updated] = await Promise.all([
    api.removeRule({ level: "project", agent: "alpha", tool: "shell", id: "gone", actor: { type: "tui" } }),
    api.updateRule({
      level: "project",
      agent: "alpha",
      tool: "shell",
      id: "keep",
      label: "Keep edited",
      patterns: ["keep-new *"],
      keywords: ["keep-new"],
      actor: { type: "tui" },
    }),
  ])
  if (!removed.ok) throw new Error(`concurrent remove failed: ${removed.error.message}`)
  if (!updated.ok) throw new Error(`update failed: ${updated.error.message}`)
  const after = await snapshotOf(api)
  const persisted = after.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "keep")
  if (persisted === undefined || persisted.type !== "rule") throw new Error("expected keep rule to persist")
  expect(persisted.label).toBe("Keep edited")
  expect(persisted.patterns).toEqual(["keep-new *"])
  expect(after.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "gone")).toBe(false)
  expect(updated.value.label).toBe(persisted.label)
  const logged = await api.log({ where: "op:rule.update" })
  if (!logged.ok) throw new Error("log failed")
  const updateEntry = logged.value.entries.find(
    (candidate) => candidate.op === "rule.update" && candidate.target === "rule:project:alpha:shell:keep",
  )
  if (updateEntry === undefined) throw new Error("missing rule.update log entry for the edited target")
  const removedLog = await api.log({ where: "op:rule.remove" })
  if (!removedLog.ok) throw new Error("log failed")
  const removeEntry = removedLog.value.entries.find(
    (candidate) => candidate.op === "rule.remove" && candidate.target === "rule:project:alpha:shell:gone",
  )
  if (removeEntry === undefined) throw new Error("missing rule.remove log entry for the concurrently removed target")
})

test("concurrent updateRule creates for the same target never report false success", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  // Both load an empty store and materialise the same curated target with
  // different labels. When the loads overlap the loser retries against fresh
  // carrying the winner; without the fix it keeps the winner's values while
  // returning the loser's label. The fix returns a conflict so response,
  // persisted values, and log all agree. When the loads do not overlap the
  // second is a sequential edit that overwrites the first (both succeed and
  // both log); that path is also correct and must not be mistaken for the
  // bug (which logs only once while reporting twice).
  const [first, second] = await Promise.all([
    api.updateRule({
      level: "project",
      agent: "alpha",
      tool: "shell",
      id: "race-create",
      label: "First",
      patterns: ["first *"],
      keywords: ["first"],
      actor: { type: "tui" },
    }),
    api.updateRule({
      level: "project",
      agent: "alpha",
      tool: "shell",
      id: "race-create",
      label: "Second",
      patterns: ["second *"],
      keywords: ["second"],
      actor: { type: "tui" },
    }),
  ])
  const after = await snapshotOf(api)
  const persisted = after.records.filter((record) => record.type === "rule" && record.tool === "shell" && record.id === "race-create")
  expect(persisted).toHaveLength(1)
  const only = persisted[0]
  if (only === undefined || only.type !== "rule") throw new Error("expected race-create to persist once")
  const logged = await api.log({ where: "op:rule.update" })
  if (!logged.ok) throw new Error("log failed")
  const entries = logged.value.entries.filter(
    (candidate) => candidate.op === "rule.update" && candidate.target === "rule:project:alpha:shell:race-create",
  )
  if (first.ok && second.ok) {
    // Sequential path (no stale retry): both edits landed in order, both
    // logged, and the final values are one of the two requested sets. Either
    // order is correct here because each response was true at return time.
    expect(entries).toHaveLength(2)
    expect(only.label === "First" || only.label === "Second").toBe(true)
    return
  }
  // Concurrent path (stale retry): exactly one succeeds and its values are
  // what persisted; the loser reports a conflict and never logs.
  const succeeded = [first, second].filter((result) => result.ok)
  const failed = [first, second].filter((result) => !result.ok)
  expect(succeeded).toHaveLength(1)
  expect(failed).toHaveLength(1)
  const winner = succeeded[0]
  if (winner === undefined || !winner.ok) throw new Error("expected one successful create")
  const loser = failed[0]
  if (loser === undefined || loser.ok) throw new Error("expected one concurrent conflict")
  if (loser.error.code !== "rule.invalid") throw new Error(`expected rule.invalid conflict, got ${loser.error.code}`)
  expect(loser.error.message).toContain("changed concurrently")
  expect(only.label).toBe(winner.value.label)
  expect(winner.value.label === "First" || winner.value.label === "Second").toBe(true)
  // The loser's requested values were never persisted and never logged.
  const winnerLabel = winner.value.label
  const loserLabel = winnerLabel === "First" ? "Second" : "First"
  const loserPatterns = loserLabel === "First" ? ["first *"] : ["second *"]
  expect(only.label).not.toBe(loserLabel)
  expect(only.patterns).not.toEqual(loserPatterns)
  expect(entries).toHaveLength(1)
  expect(entries[0]?.revision).toBe(after.revision)
})

test("updateRule preserves a shared agent:null owner instead of retargeting it", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  const seeded = await api.addRule({
    level: "defaults",
    agent: null,
    tool: "shell",
    id: "shared",
    label: "Shared",
    patterns: ["shared *"],
    actor: { type: "tui" },
  })
  if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.message}`)
  expect(seeded.value.agent).toBeNull()
  // Update through another agent's row address: protection follows the
  // matched record, and the owner (including legitimate null) follows it too.
  const updated = await api.updateRule({
    level: "project",
    agent: "alpha",
    tool: "shell",
    id: "shared",
    label: "Shared edited",
    patterns: ["shared-new *"],
    keywords: ["shared-new"],
    actor: { type: "tui" },
  })
  if (!updated.ok) throw new Error(`update failed: ${updated.error.message}`)
  expect(updated.value.level).toBe("defaults")
  expect(updated.value.agent).toBeNull()
  expect(updated.value.label).toBe("Shared edited")
  const after = await snapshotOf(api)
  const persisted = after.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "shared")
  if (persisted === undefined || persisted.type !== "rule") throw new Error("expected shared rule to persist")
  expect(persisted.level).toBe("defaults")
  expect(persisted.agent).toBeNull()
  expect(persisted.label).toBe("Shared edited")
  const logged = await api.log({ where: "op:rule.update" })
  if (!logged.ok) throw new Error("log failed")
  const updateEntry = logged.value.entries.find(
    (candidate) => candidate.op === "rule.update" && candidate.target === "rule:defaults::shell:shared",
  )
  if (updateEntry === undefined) throw new Error("missing shared rule.update log entry at the shared address")
})

test("instructions_set on a team-special row persists team-scoped record", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [
      agentInfo("alpha", "upstream alpha"),
      agentInfo("explore", "upstream explore"),
    ],
    tools: [{ id: "bash", description: "Run commands.", options: { codemode: false } }],
  })
  await linkToBuild(project, "defaults", ["alpha"])
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)

  await runOk(need(tools, "instructions_create"), {
    kind: "team",
    team: "crew",
    level: "project",
  })

  const rowId = "item:project:crew/:special:explore:tool:bash"
  const setResult = (await runOk(need(tools, "instructions_set"), {
    id: rowId,
    state: "off",
  })) as { status: string }
  expect(setResult.status).toBe('Disabled "bash"')

  const snap = await snapshotOf(api)
  const custom = snap.records.find((r) => r.type === "customization" && r.agent === "explore" && r.item === "tool:bash")
  expect(custom).toBeDefined()
  expect(custom?.type).toBe("customization")
  if (custom?.type === "customization") {
    expect(custom.state).toBe("off")
    expect(custom.team).toEqual({ level: "project", team: "crew" })
  }
})

// ---------------------------------------------------------------------------
// Round-3 evidence capture: labeled stdout of the values these flows really
// return, for docs/round3-instructions-output.md. No assertion reads it and no
// behavior depends on it. The only normalized text is the disposable mkdtemp
// prefix; long strings become a clearly labeled projection.

const ROUND3_TEXT_LIMIT = 200
// The check harness truncates the head of a run's stdout but keeps stderr
// whole, so each labeled line is printed on both streams: console.log as the
// test runs and one console.error block when this file finishes. No assertion
// reads either.
const round3Lines: string[] = []

function round3Capture(label: string, value: unknown, project: string): void {
  const line = `[round3] ${label} ${JSON.stringify(round3Value(value, project))}`
  round3Lines.push(line)
  console.log(line)
}

afterAll(() => {
  for (const line of round3Lines) console.error(line)
})

// The assembled view lists every visible system, tool and skill text. The
// round-trip needs the row identity, so keep that and the visible ids and
// replace the assembled bodies with this labeled projection.
function round3ShowValue(step: { readonly name: string }, shown: Record<string, unknown>): unknown {
  if (step.name !== "agent") return shown
  return {
    id: shown.id,
    view: shown.view,
    agent: shown.agent,
    systemEntries: Array.isArray(shown.system) ? shown.system.length : 0,
    toolIds: Array.isArray(shown.tools) ? (shown.tools as readonly { id?: unknown }[]).map((tool) => tool.id) : [],
    skillIds: Array.isArray(shown.skills) ? (shown.skills as readonly { id?: unknown }[]).map((skill) => skill.id) : [],
    projection: "assembled text bodies replaced by their ids and a system entry count",
  }
}

function round3Value(value: unknown, project: string): unknown {
  if (typeof value === "string") {
    const normalized = project.length === 0 ? value : value.split(project).join("<project>")
    if (normalized.length <= ROUND3_TEXT_LIMIT) return normalized
    return `<projection ${normalized.length} chars>: ${normalized.slice(0, ROUND3_TEXT_LIMIT)}…`
  }
  if (Array.isArray(value)) return value.map((entry) => round3Value(entry, project))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, round3Value(entry, project)]))
  }
  return value
}

// ---------------------------------------------------------------------------
// create returns the row id show/set/delete accept

test("every enabled create kind returns the row id show and delete accept, and delete removes the row", async () => {
  const { project } = await tempProject()
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate" }] }]
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    skills: [skillInfo("notes2", "Take notes.", path.join(project, ".opencode", "skill", "notes2", "SKILL.md"))],
    servers: [["search", { type: "remote", url: "https://example.test" }]],
    models: [modelInfo("acme", "nova-2")],
    classifications: { "": "general", "nova-2": "general" },
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState(), { builtins: registry })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const create = need(tools, "instructions_create")
  const show = need(tools, "instructions_show")
  const del = need(tools, "instructions_delete")

  const known = async (id: string) =>
    expandedTree(memoFromSnapshot(await snapshotOf(api))).find((node) => node.id === id)

  // The member step deletes its own member, so the team it lives in is created
  // first and stays alive through it. Owner is the file-backed project agent
  // the model and rule steps are addressed to.
  await runOk(create, { kind: "team", team: "crew", level: "project" })
  await runOk(create, { kind: "agent", id: "owner", scope: "project" })

  const steps: readonly {
    readonly name: string
    readonly input: Record<string, unknown>
    readonly id: string
    readonly item: string
    readonly kind: TreeNodeKind
    readonly status: string
    readonly show?: { readonly view?: string; readonly expect?: Record<string, unknown> }
    readonly showFail?: string
    readonly gone?: boolean
  }[] = [
    {
      name: "agent",
      input: { kind: "agent", id: "helper", scope: "project" },
      id: "agent:project:helper",
      item: "helper",
      kind: "agent",
      status: "Deleted agent helper",
      show: { view: "assembled", expect: { agent: "helper" } },
      gone: true,
    },
    {
      name: "skill",
      input: { kind: "skill", name: "notes2", body: "Take notes." },
      id: "item:defaults::skill:notes2",
      item: "skill:notes2",
      kind: "item",
      status: "Deleted skill notes2",
      show: { expect: { view: "resolved" } },
    },
    {
      name: "base",
      input: { kind: "base", id: "custom", title: "Custom.txt", text: "custom base" },
      id: "item:defaults::base:custom",
      item: "base:custom",
      kind: "item",
      status: "Deleted base template custom",
      show: { expect: { view: "resolved" } },
      gone: true,
    },
    {
      name: "mcp",
      input: { kind: "mcp", name: "search", config: { type: "remote", url: "https://example.test" } },
      id: "item:defaults::mcp:search",
      item: "mcp:search",
      kind: "item",
      status: "Removed MCP server search",
      show: { expect: { view: "resolved" } },
    },
    {
      name: "model",
      input: { kind: "model", providerID: "acme", modelID: "nova-2", level: "project", agent: "owner" },
      id: "item:project:owner:model:acme/nova-2",
      item: "model:acme/nova-2",
      kind: "item",
      status: 'Removed "item:project:owner:model:acme/nova-2"',
      show: { expect: { view: "resolved" } },
      gone: true,
    },
    {
      name: "rule",
      input: { kind: "rule", tool: "shell", id: "owner-rule", label: "Owner rule", patterns: ["git push *"], level: "project", agent: "owner" },
      id: "item:project:owner:perm:shell:owner-rule",
      item: "perm:shell:owner-rule",
      kind: "item",
      status: 'Removed "item:project:owner:perm:shell:owner-rule"',
      show: { expect: { tool: "shell", rule: "owner-rule" } },
      gone: true,
    },
    {
      name: "member",
      input: { kind: "member", team: "crew", level: "project", id: "newbie" },
      id: "team:project:crew:newbie",
      item: "newbie",
      kind: "team",
      status: "Deleted team member newbie",
      show: { expect: { kind: "member", level: "project", team: "crew", member: "newbie", registered: false } },
      showFail: "diff",
      gone: true,
    },
    {
      name: "team",
      input: { kind: "team", team: " squad ", level: "project" },
      id: "team:project:squad",
      item: "squad",
      kind: "team",
      status: "Deleted team squad",
      show: { expect: { kind: "team", level: "project", team: "squad", enabled: false, members: [] } },
      showFail: "sections",
      gone: true,
    },
  ]

  for (const step of steps) {
    const output = (await runOk(create, step.input)) as { id: string; item: string }
    expect(output.id).toBe(step.id)
    expect(output.item).toBe(step.item)
    const row = await known(step.id)
    if (row === undefined) throw new Error(`create ${step.name} did not put ${step.id} in the tree`)
    expect(row.kind).toBe(step.kind)
    round3Capture(`round-trip ${step.name}: create`, { request: step.input, output, row: { id: row.id, kind: row.kind } }, project)
    const shown = (await runOk(show, {
      id: step.id,
      ...(step.show?.view === undefined ? {} : { view: step.show.view }),
    })) as Record<string, unknown>
    expect(shown).toMatchObject({ id: step.id, ...(step.show?.expect ?? {}) })
    round3Capture(
      `round-trip ${step.name}: show`,
      { request: { id: step.id, view: step.show?.view ?? "resolved" }, output: round3ShowValue(step, shown) },
      project,
    )
    if (step.showFail !== undefined) {
      const refused = await runFail(show, { id: step.id, view: step.showFail })
      expect(refused.message).toContain("view.unsupported")
      expect(refused.message).not.toContain("row.unknown")
      round3Capture(
        `round-trip ${step.name}: show ${step.showFail} refusal`,
        { request: { id: step.id, view: step.showFail }, error: refused.message },
        project,
      )
    }
    const deleted = (await runOk(del, { id: step.id, confirm: true })) as { status: string }
    expect(deleted.status).toBe(step.status)
    if (step.gone === true) expect(await known(step.id)).toBeUndefined()
    round3Capture(
      `round-trip ${step.name}: delete`,
      { request: { id: step.id, confirm: true }, output: deleted, rowStillInTree: (await known(step.id)) !== undefined },
      project,
    )
  }
})

test("create returns the created level's model and rule row, not the identical Defaults row", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    models: [modelInfo("acme", "nova-2")],
    classifications: { "": "general", "nova-2": "general" },
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const create = need(tools, "instructions_create")
  const show = need(tools, "instructions_show")
  const del = need(tools, "instructions_delete")

  // Project and global rows need agents that live at those levels.
  await runOk(create, { kind: "agent", id: "proj", scope: "project" })
  await runOk(create, { kind: "agent", id: "glob", scope: "global" })

  // A model with no agent and no level keeps the original validation.
  const invalidModel = await runFail(create, { kind: "model", providerID: "acme", modelID: "nova-2" })
  expect(invalidModel.message).toContain("create model requires agent for project|global|preset levels")

  // An explicit defaults model with no agent is the shared Defaults row.
  const sharedModel = (await runOk(create, { kind: "model", providerID: "acme", modelID: "nova-2", level: "defaults" })) as {
    id: string
    item: string
    level: string
    agent: string | null
  }
  expect(sharedModel).toMatchObject({ id: "item:defaults::model:acme/nova-2", item: "model:acme/nova-2", level: "defaults", agent: null })

  // A shared rule (no agent, no level) keeps the original project storage and
  // resolves through its visible Defaults row.
  const sharedRule = (await runOk(create, { kind: "rule", tool: "shell", id: "shared-rule", label: "Shared", patterns: ["git push *"] })) as {
    id: string
    item: string
    level: string
    agent: string | null
  }
  expect(sharedRule).toMatchObject({ id: "item:defaults::perm:shell:shared-rule", item: "perm:shell:shared-rule", level: "project", agent: null })
  const shownShared = (await runOk(show, { id: sharedRule.id })) as { tool: string; rule: string }
  expect(shownShared).toMatchObject({ tool: "shell", rule: "shared-rule" })
  const storedShared = (await load(project)).records.find((record) => record.type === "rule" && record.id === "shared-rule")
  expect(storedShared).toMatchObject({ level: "project", agent: null })
  expect(await Bun.file(projectRecordsPath(project)).text()).toContain('"id":"shared-rule"')
  const sharedGlobalPath = globalRecordsPath()
  const sharedGlobalText = (await Bun.file(sharedGlobalPath).exists()) ? await Bun.file(sharedGlobalPath).text() : ""
  expect(sharedGlobalText).not.toContain('"id":"shared-rule"')

  // The same model and rule at project and global levels return their own
  // rows even though the Defaults row with the same item already exists.
  const projectModel = (await runOk(create, { kind: "model", providerID: "acme", modelID: "nova-2", level: "project", agent: "proj" })) as { id: string }
  expect(projectModel.id).toBe("item:project:proj:model:acme/nova-2")
  const globalModel = (await runOk(create, { kind: "model", providerID: "acme", modelID: "nova-2", level: "global", agent: "glob" })) as { id: string }
  expect(globalModel.id).toBe("item:global:glob:model:acme/nova-2")
  const projectRule = (await runOk(create, { kind: "rule", tool: "shell", id: "proj-rule", label: "Proj", patterns: ["proj *"], level: "project", agent: "proj" })) as { id: string }
  expect(projectRule.id).toBe("item:project:proj:perm:shell:proj-rule")
  const globalRule = (await runOk(create, { kind: "rule", tool: "shell", id: "glob-rule", label: "Glob", patterns: ["glob *"], level: "global", agent: "glob" })) as { id: string }
  expect(globalRule.id).toBe("item:global:glob:perm:shell:glob-rule")

  // Each write persisted at its own store: the global rule lands in the global
  // records file, the shared and project rules in the project file.
  const storedGlobalRule = (await load(project)).records.find((record) => record.type === "rule" && record.id === "glob-rule")
  expect(storedGlobalRule).toMatchObject({ level: "global", agent: "glob" })
  const globalText = await Bun.file(globalRecordsPath()).text()
  const projectText = await Bun.file(projectRecordsPath(project)).text()
  expect({ globalRule: globalText.includes('"id":"glob-rule"'), projectRule: projectText.includes('"id":"glob-rule"') }).toEqual({
    globalRule: true,
    projectRule: false,
  })
  round3Capture(
    "levels create outputs (model and rule at defaults / project / global)",
    {
      noAgentModelError: invalidModel.message,
      sharedModel,
      sharedRule,
      storedShared,
      projectModel,
      globalModel,
      projectRule,
      globalRule,
      storedGlobalRule,
    },
    project,
  )

  for (const id of [sharedModel.id, sharedRule.id, projectModel.id, globalModel.id, projectRule.id, globalRule.id]) {
    const snapshot = await snapshotOf(api)
    if (!expandedTree(memoFromSnapshot(snapshot)).some((node) => node.id === id)) throw new Error(`missing created row ${id}`)
    const deleted = (await runOk(del, { id, confirm: true })) as { status: string }
    expect(deleted.status).toContain("Removed")
    round3Capture("levels delete round-trip", { request: { id, confirm: true }, output: deleted }, project)
  }
  // Delete of the returned id removed the written records.
  const remaining = (await load(project)).records.filter((record) => record.type === "model" || record.type === "rule")
  expect(remaining.some((record) => record.type === "rule" && record.id === "shared-rule")).toBe(false)
  expect(remaining.some((record) => record.type === "rule" && record.id === "proj-rule")).toBe(false)
  expect(remaining.some((record) => record.type === "rule" && record.id === "glob-rule")).toBe(false)
  expect(
    remaining.some(
      (record) => record.type === "model" && record.providerID === "acme" && record.modelID === "nova-2" && record.agent !== null,
    ),
  ).toBe(false)
  const after = await snapshotOf(api)
  // The pre-split catalogue migration copies the first shared Defaults row
  // written into a new store into the Teams catalogue (store.ts
  // migrateCatalogues); that is existing store behaviour, so this asserts the
  // Agents-catalogue rows this test wrote are gone.
  expect(
    after.records.filter((record) => (record.type === "model" || record.type === "rule") && record.catalogue === undefined),
  ).toEqual([])
})

test("create kind member adds members at project level, refuses a Defaults team, and returns the member row id", async () => {
  const { project } = await tempProject()
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate" }] }]
  const ctx = fullContext({
    directory: project,
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState(), { builtins: registry })
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const create = need(tools, "instructions_create")
  const show = need(tools, "instructions_show")
  const del = need(tools, "instructions_delete")

  // Colon team names and nested member ids both round-trip, and a padded team
  // name is normalized exactly as team.addAgent normalizes it, so the write and
  // the row lookup agree.
  const crewOne = await runOk(create, { kind: "team", team: "crew:one", level: "project" })
  round3Capture(
    "member flow: create team crew:one",
    { request: { kind: "team", team: "crew:one", level: "project" }, output: crewOne },
    project,
  )
  const member = (await runOk(create, {
    kind: "member",
    team: " crew:one ",
    level: "project",
    id: "nested/beta",
    preset: "review/editor",
  })) as { id: string; item: string }
  expect(member.id).toBe("team:project:crew:one:nested/beta")
  expect(member.item).toBe("nested/beta")
  const memberPath = path.join(projectTeamsPath(project), "crew:one", "nested", "beta.md")
  // "<team>/<member>" names a member preset: its mode and description, an empty body.
  expect(await Bun.file(memberPath).text()).toContain("mode: primary")
  round3Capture(
    "member flow: create project member (padded colon team, nested member id)",
    {
      request: { kind: "member", team: " crew:one ", level: "project", id: "nested/beta", preset: "review/editor" },
      output: member,
      file: { path: memberPath, text: await Bun.file(memberPath).text() },
    },
    project,
  )

  // The member entity view and its subtree: the team is disabled, so the host
  // has not registered the member; enabling the team registers it.
  const disabledView = (await runOk(show, { id: member.id })) as Record<string, unknown>
  expect(disabledView).toMatchObject({ kind: "member", level: "project", team: "crew:one", member: "nested/beta", registered: false })
  const recordView = (await runOk(show, { id: member.id, view: "record" })) as { record: Record<string, unknown> }
  expect(recordView.record).toMatchObject({ kind: "member", team: "crew:one", member: "nested/beta" })
  round3Capture(
    "member flow: project member resolved + record views (team disabled)",
    { request: { id: member.id }, resolved: disabledView, record: recordView },
    project,
  )
  const subtree = expandedTree(memoFromSnapshot(await snapshotOf(api)))
  const memberRows = subtree.filter((node) => node.id.includes("nested/beta")).map((node) => node.id)
  const subtreeTool = "item:project:crew:one/:nested/beta:tool:shell"
  expect(memberRows).toContain("group:project:crew:one/:nested/beta:tools")
  expect(memberRows).toContain(subtreeTool)
  round3Capture("member flow: project member subtree rows", { subtreeTool, memberRows }, project)
  const toggled = (await runOk(need(tools, "instructions_set"), { id: subtreeTool, state: "off" })) as { status: string }
  expect(toggled.status).toBe('Disabled "shell"')
  round3Capture("member flow: subtree row set", { request: { id: subtreeTool, state: "off" }, output: toggled }, project)
  const enabled = await api.setTeamEnabled({ level: "project", team: "crew:one", enabled: true, actor: { type: "tui" } })
  if (!enabled.ok) throw new Error(`setTeamEnabled failed: ${enabled.error.message}`)
  const enabledView = (await runOk(show, { id: member.id })) as Record<string, unknown>
  expect(enabledView).toMatchObject({ kind: "member", registered: true })
  round3Capture("member flow: project member view after team enable", { enableResult: enabled.value, resolved: enabledView }, project)

  // A global member created through a padded team name.
  const gcrew = await runOk(create, { kind: "team", team: "gcrew", level: "global" })
  round3Capture(
    "member flow: create team gcrew (global)",
    { request: { kind: "team", team: "gcrew", level: "global" }, output: gcrew },
    project,
  )
  const globalMember = (await runOk(create, {
    kind: "member",
    team: " gcrew ",
    level: "global",
    id: "gmember",
  })) as { id: string; item: string }
  expect(globalMember.id).toBe("team:global:gcrew:gmember")
  expect(globalMember.item).toBe("gmember")
  const globalMemberPath = path.join(globalTeamsPath(), "gcrew", "gmember.md")
  // No preset: "None — everything off", a file with core's default mode only.
  expect(await Bun.file(globalMemberPath).text()).toBe("---\nmode: primary\n---\n")
  const globalView = (await runOk(show, { id: globalMember.id })) as Record<string, unknown>
  expect(globalView).toMatchObject({ kind: "member", level: "global", team: "gcrew", member: "gmember" })
  round3Capture(
    "member flow: create global member (padded team name)",
    {
      request: { kind: "member", team: " gcrew ", level: "global", id: "gmember" },
      output: globalMember,
      file: { path: globalMemberPath, text: await Bun.file(globalMemberPath).text() },
      resolved: globalView,
    },
    project,
  )

  // DESIGN §4: a Defaults team takes member ENTRIES (patterns), never a
  // file: the overlay directory is not read and nothing is written there.
  const entry = (await runOk(create, { kind: "member", team: " ship ", level: "defaults", id: "rook*" })) as { id: string; item: string }
  expect(entry).toMatchObject({ id: "team:defaults:ship:rook*", item: "rook*" })
  const overlayPath = path.join(process.env.OPENCODE_CONFIG_DIR ?? "", "opencodeplus", "teams-defaults", "ship", "rook*.md")
  expect(await Bun.file(overlayPath).exists()).toBe(false)
  const snapshot = await snapshotOf(api)
  expect(snapshot.teams?.find((team) => team.team === "ship")?.agents).toEqual(["mate"])
  expect(snapshot.entries).toEqual([expect.objectContaining({ catalogue: "teams", team: "ship", name: "rook*" })])

  const removedMember = (await runOk(del, { id: member.id, confirm: true })) as { status: string }
  expect(removedMember.status).toBe("Deleted team member nested/beta")
  expect(await Bun.file(memberPath).exists()).toBe(false)
  round3Capture(
    "member flow: delete project member",
    { request: { id: member.id, confirm: true }, output: removedMember, fileExists: await Bun.file(memberPath).exists() },
    project,
  )
  const removedGlobal = (await runOk(del, { id: globalMember.id, confirm: true })) as { status: string }
  expect(removedGlobal.status).toBe("Deleted team member gmember")
  expect(await Bun.file(globalMemberPath).exists()).toBe(false)
  round3Capture(
    "member flow: delete global member",
    { request: { id: globalMember.id, confirm: true }, output: removedGlobal, fileExists: await Bun.file(globalMemberPath).exists() },
    project,
  )
})

test("create kind member forwards the preset to team.addAgent", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const real = createPlusApi(ctx, createState())
  const forwarded: unknown[] = []
  // A recording delegation, not a stub: the create below still runs the real
  // handler and writes the real member file; the recorder only observes the
  // request the tool sent.
  const api: PlusApi = {
    ...real,
    addTeamAgent: (input) => {
      forwarded.push(input)
      return real.addTeamAgent(input)
    },
  }
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const create = need(tools, "instructions_create")
  await runOk(create, { kind: "team", team: "crew", level: "project" })
  const created = (await runOk(create, {
    kind: "member",
    team: "crew",
    level: "project",
    id: "fielded",
    preset: "planner",
  })) as { id: string; item: string }
  expect(created.id).toBe("team:project:crew:fielded")
  expect(created.item).toBe("fielded")
  expect(forwarded).toHaveLength(1)
  expect(forwarded[0]).toMatchObject({
    level: "project",
    team: "crew",
    id: "fielded",
    preset: { kind: "agent", id: "planner" },
    actor: { type: "tool" },
  })
  expect(await Bun.file(path.join(projectTeamsPath(project), "crew", "fielded.md")).text()).toBe(
    formatMarkdown({ mode: "primary", description: "Turns goals into exact task plans with paths and checks" }, ""),
  )
  const unknown = await runFail(create, { kind: "member", team: "crew", level: "project", id: "other", preset: "ghost" })
  expect(unknown.message).toContain("preset.invalid")
  round3Capture("member flow: preset forwarded to team.addAgent", { output: created, forwarded: forwarded[0] }, project)
})

// DESIGN §5: `template` names a team preset (here the Plus `review` preset),
// no longer a Defaults template: member files carry the preset's mode and
// description with an empty body, and links make everything else follow it.
test("create kind team passes the team preset to team.create and produces the preset's members", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const create = need(tools, "instructions_create")
  const show = need(tools, "instructions_show")

  const created = (await runOk(create, { kind: "team", team: "mine", level: "project", preset: "review" })) as {
    id: string
    item: string
    enabled: boolean
  }
  expect(created).toMatchObject({ id: "team:project:mine", item: "mine", enabled: false })
  const shownTeam = (await runOk(show, { id: created.id })) as Record<string, unknown>
  expect(shownTeam).toMatchObject({
    kind: "team",
    level: "project",
    team: "mine",
    enabled: false,
    members: ["editor", "reviewer"],
  })
  const snapshot = await snapshotOf(api)
  expect(snapshot.teams?.find((team) => team.team === "mine")).toEqual({
    level: "project",
    team: "mine",
    enabled: false,
    agents: ["editor", "reviewer"],
  })
  const rows = expandedTree(memoFromSnapshot(snapshot))
  expect(rows.some((node) => node.id === "team:project:mine:editor")).toBe(true)
  expect(rows.some((node) => node.id === "team:project:mine:reviewer")).toBe(true)
  round3Capture(
    "team template: create kind team with template",
    {
      request: { kind: "team", team: "mine", level: "project", preset: "review" },
      output: created,
      show: shownTeam,
      snapshotTeam: snapshot.teams?.find((team) => team.team === "mine"),
      memberRows: rows.filter((node) => node.id.startsWith("team:project:mine")).map((node) => node.id),
    },
    project,
  )
  // The same handler the TUI's team.create calls wrote the member files.
  const teamDir = path.join(projectTeamsPath(project), "mine")
  const preset = plusTeamPresets.find((team) => team.id === "review")
  const editorMember = preset?.members.find((member) => member.id === "editor")
  const reviewerMember = preset?.members.find((member) => member.id === "reviewer")
  if (editorMember === undefined || reviewerMember === undefined) throw new Error("missing preset members")
  const editorText = await Bun.file(path.join(teamDir, "editor.md")).text()
  expect(editorText).toBe(formatMarkdown({ mode: "primary", description: editorMember.description }, ""))
  expect(await Bun.file(path.join(teamDir, "reviewer.md")).text()).toBe(
    formatMarkdown({ mode: "primary", description: reviewerMember.description }, ""),
  )
  expect(snapshot.links?.map((link) => [link.agent, link.preset])).toEqual(
    expect.arrayContaining([
      [null, { kind: "team", id: "review" }],
      ["editor", { kind: "member", team: "review", id: "editor" }],
      ["reviewer", { kind: "member", team: "review", id: "reviewer" }],
    ]),
  )
  round3Capture(
    "team template: member files written",
    {
      editorFile: { path: path.join(teamDir, "editor.md"), text: editorText },
      reviewerFile: { path: path.join(teamDir, "reviewer.md"), text: await Bun.file(path.join(teamDir, "reviewer.md")).text() },
    },
    project,
  )
})

test("create kind instruction is refused with instruction.disabled and writes nothing", async () => {
  const { project, tools } = await freshFixture()
  const error = await runFail(need(tools, "instructions_create"), { kind: "instruction", name: "AGENTS.md", text: "guide" })
  expect(error.message).toContain("instruction.disabled")
  expect(error.message).toContain("Context catalogue")
  expect(await Bun.file(path.join(project, "AGENTS.md")).exists()).toBe(false)
  expect(await Bun.file(path.join(project, ".opencode", "AGENTS.md")).exists()).toBe(false)
  round3Capture(
    "instruction.disabled: create kind instruction is refused and writes nothing",
    {
      request: { kind: "instruction", name: "AGENTS.md", text: "guide" },
      error: error.message,
      filesWritten: {
        projectAgentsMd: await Bun.file(path.join(project, "AGENTS.md")).exists(),
        dotOpencodeAgentsMd: await Bun.file(path.join(project, ".opencode", "AGENTS.md")).exists(),
      },
    },
    project,
  )
})

// DESIGN §5 through the tools: every create kind names its preset, the string
// preset form resolves, `set {preset}` relinks and unlinks, and `delete`
// removes entries and User presets, surfacing the in-use refusal.
test("instructions_create entry, preset, teamPreset and presetMember return their rows; agent takes a string preset", async () => {
  const { api, tools } = await freshFixture()
  const create = need(tools, "instructions_create")
  const show = need(tools, "instructions_show")

  const agent = (await runOk(create, { kind: "agent", id: "helper", preset: "review/editor" })) as { id: string; item: string }
  expect(agent).toMatchObject({ id: "agent:project:helper", item: "helper" })
  expect((await snapshotOf(api)).links).toEqual([
    expect.objectContaining({ level: "project", agent: "helper", preset: { kind: "member", team: "review", id: "editor" } }),
  ])
  expect((await runFail(create, { kind: "agent", id: "ghostly", preset: "no-such-preset" })).message).toContain("preset.invalid")

  const entry = (await runOk(create, { kind: "entry", catalogue: "agents", name: "*orchestrator*", preset: "orchestrator" })) as {
    id: string
    item: string
  }
  expect(entry).toMatchObject({ id: "agent:defaults:*orchestrator*", item: "*orchestrator*" })
  const teamEntry = (await runOk(create, { kind: "entry", catalogue: "teams", team: "crew*", name: "*impl*" })) as { id: string }
  expect(teamEntry.id).toBe("team:defaults:crew*:*impl*")
  expect((await runFail(create, { kind: "entry", catalogue: "agents", name: "*orchestrator*" })).message).toContain("entry.exists")

  const preset = (await runOk(create, { kind: "preset", id: "mine", from: "planner" })) as { id: string; item: string }
  expect(preset).toMatchObject({ id: "agent:preset:mine", item: "mine" })
  expect(await runOk(show, { id: preset.id })).toMatchObject({
    kind: "preset",
    preset: { kind: "agent", id: "mine" },
    origin: "user",
    link: { kind: "agent", id: "planner" },
  })
  const team = (await runOk(create, { kind: "teamPreset", id: "crew", from: "starter" })) as { id: string }
  expect(team.id).toBe("team:preset:crew")
  const member = (await runOk(create, { kind: "presetMember", team: "crew", id: "lead", from: "mine" })) as { id: string }
  expect(member.id).toBe("team:preset:crew:lead")
  expect((await runFail(create, { kind: "presetMember", team: "starter", id: "x" })).message).toContain("preset.readonly")
  expect((await runFail(create, { kind: "teamPreset", id: "other", from: "planner" })).message).toContain("preset.invalid")
  const presets = (await snapshotOf(api)).presets?.map((record) => [record.kind, record.team ?? "", record.id]) ?? []
  expect(presets.toSorted()).toEqual(
    [
      ["agent", "", "mine"],
      ["agent", "crew", "helper"],
      ["agent", "crew", "lead"],
      ["agent", "crew", "planner"],
      ["team", "", "crew"],
    ].toSorted(),
  )
})

test("instructions_set {preset} relinks and unlinks the row's owner; protected agents refuse, presets do not", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["guarded", "mine"] }))
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")

  await runOk(create, { kind: "agent", id: "helper" })
  const linked = (await runOk(set, { id: "agent:project:helper", preset: "orchestrator" })) as { preset: unknown; status: string }
  expect(linked).toMatchObject({ preset: { kind: "agent", id: "orchestrator" }, status: 'Linked "helper" to agent:orchestrator' })
  // The row now inherits from the preset.
  const rows = (await runOk(need(tools, "instructions_list"), { where: "id:item:project:helper:tool:reader", fields: ["id", "from"] })) as {
    rows: { id: string; from?: string }[]
  }
  expect(rows.rows).toEqual([{ id: "item:project:helper:tool:reader", from: "from preset Orchestrator" }])
  await runOk(set, { id: "agent:project:helper", preset: { kind: "member", team: "starter", id: "helper" } })
  expect((await snapshotOf(api)).links).toEqual([expect.objectContaining({ agent: "helper", preset: { kind: "member", team: "starter", id: "helper" } })])
  const unlinked = (await runOk(set, { id: "agent:project:helper", preset: null })) as { preset: unknown }
  expect(unlinked.preset).toBeNull()
  expect((await snapshotOf(api)).links).toEqual([])
  expect((await runFail(set, { id: "agent:project:helper", preset: "no-such-preset" })).message).toContain("preset.invalid")
  expect((await runFail(set, { id: "group:project:agents", preset: "planner" })).message).toContain("link.invalid")
  expect((await runFail(set, { id: "agent:preset:orchestrator", preset: "planner" })).message).toContain("preset.readonly")

  // A protected agent's link stays out of a tool's reach; a preset of that name does not.
  await api.createAgent({ scope: "project", id: "guarded" })
  expect((await runFail(set, { id: "agent:project:guarded", preset: "planner" })).message).toContain("agent.protected")
  await runOk(create, { kind: "preset", id: "mine" })
  await runOk(set, { id: "agent:preset:mine", preset: "scout" })
  expect((await snapshotOf(api)).links).toEqual([expect.objectContaining({ level: "preset", agent: "mine", preset: { kind: "agent", id: "scout" } })])

  // A team relink relinks the members the team preset has, and says which.
  await runOk(create, { kind: "teamPreset", id: "crewset", from: "starter" })
  await runOk(create, { kind: "team", team: "crew", level: "project", preset: "starter" })
  const team = (await runOk(set, { id: "team:project:crew", preset: "crewset" })) as { members: unknown; status: string }
  expect(team).toMatchObject({
    members: [
      { agent: "helper", preset: { kind: "member", team: "crewset", id: "helper" } },
      { agent: "planner", preset: { kind: "member", team: "crewset", id: "planner" } },
    ],
    status: 'Linked "crew" to team:crewset; relinked helper, planner',
  })
})

test("instructions_delete removes Defaults entries and User presets and surfaces an in-use preset's users", async () => {
  const { api, tools } = await freshFixture()
  const create = need(tools, "instructions_create")
  const del = need(tools, "instructions_delete")
  await runOk(create, { kind: "entry", catalogue: "agents", name: "Opus-%" })
  await runOk(create, { kind: "entry", catalogue: "teams", name: "scout" })
  await runOk(create, { kind: "entry", catalogue: "teams", name: "helper" })
  expect(await runOk(del, { id: "agent:defaults:Opus-%", confirm: true })).toMatchObject({ removed: 1, status: "Deleted Defaults entry Opus-%" })
  expect(await runOk(del, { id: "team:defaults:*", confirm: true })).toMatchObject({ removed: 2 })
  expect((await snapshotOf(api)).entries).toEqual([])

  await runOk(create, { kind: "preset", id: "mine" })
  await runOk(create, { kind: "agent", id: "user1", preset: "mine" })
  const inUse = await runFail(del, { id: "agent:preset:mine", confirm: true })
  expect(inUse.message).toContain("preset.inUse")
  expect(inUse.message).toContain("agent:project:user1")
  expect((await runFail(del, { id: "agent:preset:orchestrator", confirm: true })).message).toContain("read-only")
  await runOk(need(tools, "instructions_set"), { id: "agent:project:user1", preset: null })
  expect(await runOk(del, { id: "agent:preset:mine", confirm: true })).toMatchObject({ ref: { kind: "agent", id: "mine" } })
  expect((await snapshotOf(api)).presets).toEqual([])
})
