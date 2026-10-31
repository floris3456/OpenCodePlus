import { afterAll, afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { activate, createPlusApi, createState, createHandlers, deactivate } from "../src/index.js"
import type { PlusApi } from "../src/index.js"
import { Plus } from "../src/rpc.js"
import { globalLogPath, globalRecordsPath, globalTeamsPath, linkedProjectsPath, projectLogPath, projectRecordsPath, projectTeamsPath, teachingFilePath, teachingSkillId, teamsDataDir } from "../src/instructions/paths.js"
import { saveRun } from "../src/teams/run.js"
import { load, save } from "../src/instructions/store.js"
import { userBaseFile } from "../src/agents/base.js"
import { formatMarkdown } from "../src/agents/files.js"
import {
  addSection,
  activateModelRow,
  removalPlan,
  reset,
  resolveReview,
  saveSplit,
  saveText,
  setPin,
  setRequires,
  teamPlan,
  toggle,
  unknownRowRefusal,
} from "../src/instructions/ops.js"
import { resolve } from "../src/instructions/model.js"
import { expandedTree } from "../src/instructions/tree.js"
import type { MemoInput, TreeNodeKind } from "../src/instructions/tree.js"
import { registerInstructionTools } from "../src/tools.js"
import { teachingSkillContent } from "../src/instructions/teaching.js"
import { plusTeamPresets } from "../src/instructions/presets.js"
import { memoInputOf, presetStateOfSnapshot } from "../src/instructions/snapshot.js"
import type { Context } from "@opencode/plugin/effect/plugin"
import { agentHarness, agentInfo, modelHarness, context, fullContext, modelInfo, modelRef, skillHarness, skillInfo, toolHarness } from "./harness.js"
import { toolsAndRulesSample } from "./fixtures/tools-and-rules.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME
const instructionToolIds = ["batch", "clipboard", "create", "delete", "edit", "find", "link", "log", "move", "read", "reset", "set", "split", "undo"].map((name) => `instructions_${name}`)

for (const combined of [true, false]) {
  test(`repeat whole-row headed set retains authored text (${combined ? "combined state:on" : "text-only control"})`, async () => {
    const { api, tools, project } = await freshFixture()
    const set = need(tools, "instructions_set")
    const show = need(tools, "instructions_read")
    await runOk(need(tools, "instructions_create"), { kind: "agent", id: "repeatprobe", scope: "project" })
    await linkToBuild(project, "project", ["repeatprobe"])
    const id = "item:project:repeatprobe:tool:reader"
    const plain = "REPEAT_PLAIN_CANARY. Read safely."
    const headed = "Read a file safely.\n\n## Gate Canary\nREPEAT_HEADED_CANARY.\n"
    const write = (text: string) => runOk(set, { id, text, ...(combined ? { state: "on" } : {}) })
    await write(plain)
    await write(plain)
    expect(JSON.stringify(await runOk(show, { id }))).toContain("REPEAT_PLAIN_CANARY")
    await write(headed)
    const first = await runOk(show, { id })
    expect(JSON.stringify(first)).toContain("REPEAT_HEADED_CANARY")
    const before = await snapshotOf(api)
    expect(before.records.filter((record) => record.type === "customization").find((record) => record.item === "tool:reader" && record.level === "project" && record.section === null)?.text).toBe(headed)
    await write(headed)
    const second = await runOk(show, { id })
    expect(JSON.stringify(second)).toContain("REPEAT_HEADED_CANARY")
    expect((await load(project)).records.filter((record) => record.type === "customization").find((record) => record.item === "tool:reader" && record.level === "project" && record.section === null)?.text).toBe(headed)
    // Editing one section must not lose the unchanged whole-span preamble.
    const edited = headed.replace("REPEAT_HEADED_CANARY", "REPEAT_EDITED_CANARY")
    await write(edited)
    expect((await load(project)).records.filter((record) => record.type === "customization").find((record) => record.item === "tool:reader" && record.level === "project" && record.section === null)?.text).toBe(edited)
    await runOk(set, { id: "section:project:repeatprobe:tool:reader:gate-canary", text: "## Gate Canary\nREPEAT_FOLDED_CANARY.\n" })
    await runOk(set, { id: "section:project:repeatprobe:tool:reader:gate-canary", state: "off" })
    const folded = headed.replace("REPEAT_HEADED_CANARY", "REPEAT_FOLDED_CANARY")
    await write(folded)
    const stored = (await load(project)).records.filter((record) => record.type === "customization").filter((record) => record.item === "tool:reader" && record.level === "project")
    expect(stored.find((record) => record.section === null)?.text).toBe(folded)
    expect(stored.some((record) => record.section !== null && record.text !== undefined)).toBe(false)
    expect(stored.find((record) => record.section === "gate-canary")?.state).toBe("off")
  })
}

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
    // Core always registers the skill tool; skills are listed under it.
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "skill", description: "Load a skill", options: { codemode: false } },
    ],
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
            : record.type === "rowlink"
              ? {
                  type: "rowlink" as const,
                  level: record.level,
                  agent: record.agent,
                  item: record.item,
                  section: record.section,
                  target: record.target,
                  targetSection: record.targetSection,
                  link: record.link,
                  ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
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

// Exercise the host boundary as well as execute: unknown keys would otherwise
// bypass the registered schema and conceal missing callable API fields.
function decoded(tool: Tool.Info, input: unknown) {
  if (!Schema.isSchema(tool.input)) throw new Error("expected registered Effect schema")
  return Schema.decodeUnknownSync(tool.input)(input)
}

test("C1 registered model set and emitted field reset persist atomically without changing identity or warming prompt", async () => {
  const { api, tools, project } = await freshFixture({ models: [modelInfo("acme", "nova-2")], classifications: { "nova-2": "general" } })
  const set = need(tools, "instructions_set")
  const resetTool = need(tools, "instructions_reset")
  const created = await runOk(need(tools, "instructions_create"), { kind: "model", providerID: "acme", modelID: "nova-2", level: "defaults", agent: "alpha" }) as { id: string }
  await runOk(set, decoded(set, { id: created.id, prompt: "keep alive" }))
  const values = { compactWarm: "on", coldFirst: "off", coldModels: ["acme/cold#high"], compactionStrategy: "remote", compactionModel: "acme/summary#low", compactionInstructions: "", compactionInput: "120000", compactionOutput: "off" }
  // Bind the taught typed fields to the registered schema and real write,
  // not just the permissive field-id parser.
  for (const field of Object.keys(values)) expect(teachingSkillContent).toContain(`\`${field}\``)
  const input = decoded(set, { id: created.id, ...values })
  expect(input).toMatchObject(values)
  // The per-model cold switch is retired: setting it names the Settings row and writes nothing.
  const unset = await load(project)
  expect((await runFail(set, decoded(set, { id: created.id, coldCompact: "on" }))).message).toContain("Settings › OpenCodePlus › Compact cold chats first")
  expect(await load(project)).toEqual(unset)
  await runOk(set, input)
  const own = () => load(project).then((store) => store.records.find((record) => record.type === "model" && record.agent === "alpha"))
  expect(await own()).toMatchObject({ ...values, providerID: "acme", modelID: "nova-2", prompt: "keep alive", active: true })
  const before = await load(project)
  const log = await Bun.file(globalLogPath()).text()
  expect((await runFail(set, decoded(set, { id: created.id, prompt: "changed", compactWarm: "off", compactionModel: "invalid" }))).message).toContain("compaction model")
  expect(await load(project)).toEqual(before)
  expect(await Bun.file(globalLogPath()).text()).toBe(log)
  expect((await runFail(set, decoded(set, { id: created.id, interval: "invalid", compactionStrategy: "local" }))).message).toContain("interval")
  expect(await load(project)).toEqual(before)
  const rows = expandedTree(memoInputOf(await snapshotOf(api)))
  expect((await runFail(set, decoded(set, { id: created.id, prompt: "changed", compactionInput: "0" }))).message).toContain("positive whole token count")
  expect(await load(project)).toEqual(before)
  for (const field of ["compactWarm", "coldFirst", "compactionStrategy", "compactionModel", "compactionInstructions", "compactionInput", "compactionOutput"]) {
    const row = rows.find((node) => node.id.startsWith("item:defaults:alpha:") && node.address?.item.startsWith(`modelfield:${field}:`))
    if (row === undefined) throw new Error(`missing emitted ${field} row`)
    await runOk(set, decoded(set, { id: row.id, text: field === "compactionInput" || field === "compactionOutput" ? "30000" : field === "compactWarm" ? "off" : field === "coldFirst" ? "on" : field === "compactionStrategy" ? "local" : field === "compactionModel" ? "acme/other" : "summarize" }))
    expect(await own()).toMatchObject({ prompt: "keep alive", active: true })
    await runOk(resetTool, decoded(resetTool, { id: row.id }))
    expect(await own()).not.toHaveProperty(field)
  }
  await runOk(set, decoded(set, { id: created.id, coldModels: [], compactionInstructions: "" }))
  expect(await own()).toMatchObject({ coldModels: [], compactionInstructions: "" })
  await runOk(set, decoded(set, { id: created.id, coldModels: null, coldCompact: "", compactionInstructions: null }))
  expect(await own()).not.toHaveProperty("coldModels")
  expect(await own()).not.toHaveProperty("coldCompact")
  expect(await own()).not.toHaveProperty("compactionInstructions")
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const protectedBefore = await load(project)
  const protectedLog = await Bun.file(globalLogPath()).text()
  const index = await Bun.file(linkedProjectsPath()).text().catch(() => undefined)
  const records = await Bun.file(globalRecordsPath()).text()
  expect((await runFail(set, decoded(set, { id: created.id, compactWarm: "on" }))).message).toContain("agent.protected")
  expect((await runFail(resetTool, decoded(resetTool, { id: created.id }))).message).toContain("agent.protected")
  expect(await load(project)).toEqual(protectedBefore)
  expect(await Bun.file(globalLogPath()).text()).toBe(protectedLog)
  expect(await Bun.file(globalRecordsPath()).text()).toBe(records)
  expect(await Bun.file(linkedProjectsPath()).text().catch(() => undefined)).toBe(index)
})

test("C1 registered Defaults dispatcher accepts comma coldModels and truthful emitted field rows", async () => {
  const { api, tools, project } = await freshFixture({ models: [modelInfo("acme", "nova-2")], classifications: { "nova-2": "general" } })
  const set = need(tools, "instructions_set")
  const rows = expandedTree(memoInputOf(await snapshotOf(api)))
  const row = rows.find((node) => node.address?.item.startsWith("modeldefault:"))
  if (row === undefined) throw new Error("missing Defaults model row")
  await runOk(set, decoded(set, { id: row.id, coldModels: " acme/first#high , acme/second ", compactWarm: "ON", coldFirst: " OFF ", compactionStrategy: "REMOTE", compactionModel: "acme/summary", compactionInstructions: "", prompt: "keep alive" }))
  const stored = (await load(project)).records.find((record) => record.type === "modelSettings")
  expect(stored).toMatchObject({ coldModels: ["acme/first#high", "acme/second"], compactWarm: "on", coldFirst: "off", compactionStrategy: "remote", compactionModel: "acme/summary", compactionInstructions: "", prompt: "keep alive" })
  await runOk(set, decoded(set, { id: row.id, compactionInput: "90000", compactionOutput: "off" }))
  expect((await load(project)).records.find((record) => record.type === "modelSettings")).toMatchObject({ compactionInput: "90000", compactionOutput: "off" })
  const before = await load(project)
  expect((await runFail(set, decoded(set, { id: row.id, prompt: "changed", coldModels: "acme/first,acme/first" }))).message).toContain("twice")
  expect(await load(project)).toEqual(before)
  const emitted = expandedTree(memoInputOf(await snapshotOf(api)))
  for (const field of ["compactionInput", "compactionOutput"]) {
    const threshold = emitted.find((node) => node.address?.item === `modelsetting:${field}:${row.address!.item.slice("modeldefault:".length)}`)
    if (!threshold) throw new Error(`missing ${field}`)
    const saved = (await runOk(set, decoded(set, { id: threshold.id, text: "60000" }))) as { status: string }
    expect((await load(project)).records.find((record) => record.type === "modelSettings")).toMatchObject({ [field]: "60000" })
    // The status and read name the value the store now holds.
    expect(saved.status).toContain(`${field} 60000`)
    expect(((await runOk(need(tools, "instructions_read"), { id: threshold.id })) as { value: unknown }).value).toBe(60000)
    await runOk(need(tools, "instructions_reset"), { id: threshold.id })
    expect((await load(project)).records.find((record) => record.type === "modelSettings")).not.toHaveProperty(field)
  }
  expect(emitted.some((node) => node.address?.item.startsWith("modelsetting:coldModels:"))).toBe(false)
  expect(teachingSkillContent).toContain("no `modelsetting:coldModels` field row is emitted")
  const bogus = `item:defaults:/models:modelsetting:coldModels:${row.address!.item.slice("modeldefault:".length)}`
  const untouched = await load(project)
  expect((await runFail(set, decoded(set, { id: bogus, text: "acme/guessed" }))).message).toContain("row.unknown")
  expect(await load(project)).toEqual(untouched)
  const instructions = emitted.find((node) => node.address?.item === `modelsetting:compactionInstructions:${row.address!.item.slice("modeldefault:".length)}`)
  if (instructions === undefined) throw new Error("missing emitted Defaults instructions row")
  await runOk(set, decoded(set, { id: instructions.id, text: "new summary" }))
  expect((await load(project)).records.find((record) => record.type === "modelSettings")).toMatchObject({ compactionInstructions: "new summary", prompt: "keep alive" })
  await runOk(need(tools, "instructions_reset"), { id: instructions.id })
  expect((await load(project)).records.find((record) => record.type === "modelSettings")).not.toHaveProperty("compactionInstructions")
  await runOk(set, decoded(set, { id: row.id, coldModels: [], compactionInstructions: "" }))
  expect((await load(project)).records.find((record) => record.type === "modelSettings")).toMatchObject({ coldModels: [], compactionInstructions: "" })
  await runOk(set, decoded(set, { id: row.id, coldModels: null, compactionInstructions: null }))
  expect((await load(project)).records.find((record) => record.type === "modelSettings")).not.toHaveProperty("coldModels")
  expect((await load(project)).records.find((record) => record.type === "modelSettings")).not.toHaveProperty("compactionInstructions")
})

test("C1 registered inherited model edits plant only local fields and reset reveals the lower level", async () => {
  const { api, tools, project } = await freshFixture({ agents: [agentInfo("build", "role", modelRef("acme", "base"))], models: [modelInfo("acme", "base")], classifications: { base: "general" } })
  const set = need(tools, "instructions_set")
  await runOk(set, decoded(set, { id: "item:global:build:model:acme/base", compactionStrategy: "remote", compactionInstructions: "global summary" }))
  await runOk(set, decoded(set, { id: "item:project:build:model:acme/base", compactionStrategy: "local", coldModels: ["acme/cold"] }))
  const before = await load(project)
  expect(before.records.find((record) => record.type === "model" && record.level === "global")).toMatchObject({ compactionStrategy: "remote", compactionInstructions: "global summary" })
  expect(before.records.find((record) => record.type === "model" && record.level === "project")).toMatchObject({ compactionStrategy: "local", coldModels: ["acme/cold"] })
  const row = expandedTree(memoInputOf(await snapshotOf(api))).find((node) => node.id.startsWith("item:project:build:") && node.address?.item.startsWith("modelfield:compactionStrategy:"))
  if (row === undefined) throw new Error("missing inherited strategy field")
  await runOk(need(tools, "instructions_reset"), decoded(need(tools, "instructions_reset"), { id: row.id }))
  const after = await load(project)
  expect(after.records.find((record) => record.type === "model" && record.level === "project")).not.toHaveProperty("compactionStrategy")
  expect(after.records.filter((record) => record.level === "global")).toEqual(before.records.filter((record) => record.level === "global"))
  const shown = await runOk(need(tools, "instructions_read"), { id: row.id })
  expect(shown).toMatchObject({ field: "compactionStrategy", value: "Remote · global" })
})

// The ids of list rows, each the first cell of its "id | …" line.
function rowIds(list: { readonly rows: readonly string[] }): string[] {
  return list.rows.map((row) => row.split(" | ")[0] ?? "")
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

// Plus ships Tools and rules empty: tests of its sections add them, as a user
// would, by default for every agent (an agent linked to a preset takes the
// preset's empty text instead, so it needs them on its own row).
async function addToolsAndRules(tools: Map<string, Tool.Info & { readonly id: string }>, id = "item:defaults::system:tools-and-rules") {
  await runOk(need(tools, "instructions_set"), { id, text: toolsAndRulesSample })
}

test("section move tool dispatch persists effective order and refuses invalid and protected requests without writes", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencode", "agent", "alpha.md"), formatMarkdown({}, "# One\nFirst.\n\n# Two\nSecond.\n"))
  await Bun.write(path.join(project, ".opencode", "agent", "beta.md"), formatMarkdown({}, "# One\nOther.\n\n# Two\nOther second.\n"))
  await linkToBuild(project, "project", ["alpha", "beta"])
  const ctx = fixtureContext(project, { agents: [agentInfo("alpha"), agentInfo("beta")], tools: [{ id: "reader", description: "# One\nFirst.\n\n# Two\nSecond.\n", options: { codemode: false } }] })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const snapshot = await snapshotOf(api)
  const nodes = expandedTree(memoInputOf(snapshot))
  const section = (id: string, agent = "alpha") => {
    const node = nodes.find((node) => node.address?.item === "tool:reader" && node.address.section === id && node.address.level === "project" && node.address.agent === agent)
    if (!node) throw new Error(`missing ${agent} ${id}`)
    return node.id
  }
  const tool = need(tools, "instructions_move")
  const before = await load(project)
  expect((await runFail(tool, { id: section("two"), before: section("one", "beta") })).message).toContain("different items")
  expect(await load(project)).toEqual(before)
  await runOk(tool, { id: section("two"), before: section("one") })
  const saved = await load(project)
  const written = saved.records.find((record): record is Extract<typeof record, { type: "customization" }> => record.type === "customization" && record.agent === "alpha" && record.item === "tool:reader" && record.section === null)
  expect(written?.text?.trim()).toBe("# Two\nSecond.\n# One\nFirst.")
  const reload = await snapshotOf(api)
  expect(expandedTree(memoInputOf(reload)).filter((node) => node.address?.item === "tool:reader" && node.address.level === "project" && node.address.agent === "alpha" && node.address.section !== null).map((node) => node.address?.section)).toEqual(["two", "one"])
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  expect((await runFail(tool, { id: section("one"), before: section("two") })).message).toContain("agent.protected")
  expect(await load(project)).toEqual(saved)
})

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

test("folders flow down the chain; a copy reads to review when they change above, and set resolve settles it", async () => {
  const { tools } = await freshFixture({ agents: [agentInfo("build")] })
  const find = async (input: Record<string, unknown>) => rowIds((await runOk(need(tools, "instructions_find"), { limit: 200, ...input })) as { rows: string[] })
  const global = "group:global:build:tools"
  const project = "group:project:build:tools"
  await runOk(need(tools, "instructions_create"), { kind: "folder", name: "Mine", id: global })
  const globalFolder = (await find({ in: global, type: "group", name: "Mine" }))[0]
  if (globalFolder === undefined) throw new Error("missing the global folder")
  await runOk(need(tools, "instructions_move"), { id: "item:global:build:tool:reader", into: globalFolder })
  // Project has no layout of its own: it shows Global's folder, with its own row in it.
  const inherited = (await find({ in: project, type: "group", name: "Mine" }))[0]
  expect(inherited).toBe(`${project}:folder:${globalFolder.split(":folder:")[1]}`)
  expect(await find({ in: inherited, type: "tool" })).toEqual(["item:project:build:tool:reader"])
  // Its first change takes its own copy; Global changing after puts it to review.
  await runOk(need(tools, "instructions_move"), { id: "item:project:build:tool:skill", into: inherited })
  expect(await find({ is: "review" })).toEqual([])
  await runOk(need(tools, "instructions_set"), { id: globalFolder, rename: "Renamed" })
  expect(await find({ is: "review" })).toEqual([project])
  await runOk(need(tools, "instructions_set"), { id: project, resolve: "take" })
  expect(await find({ is: "review" })).toEqual([])
  expect(await find({ in: project, type: "group", name: "Renamed" })).toHaveLength(1)
})

test("an edit back to the inherited text stays an own value until reset; a copy an earlier release stored stays too", async () => {
  const { api, tools, project } = await freshFixture()
  const id = await readerRowId(api)
  const reader = async () => (await load(project)).records.filter((record) => record.type === "customization" && record.item === "tool:reader")
  const changed = async () => rowIds((await runOk(need(tools, "instructions_find"), { is: "changed" })) as { rows: string[] })
  await runOk(need(tools, "instructions_edit"), { id, oldString: "read things", newString: "scan things" })
  expect(await reader()).toHaveLength(1)
  await runOk(need(tools, "instructions_edit"), { id, oldString: "scan things", newString: "read things" })
  expect(await reader()).toEqual([expect.objectContaining({ agent: "alpha", text: "read things" })])
  expect(await changed()).toEqual([id])
  // reset makes it follow again, and says so; a second reset has nothing to reset.
  const reset = (await runOk(need(tools, "instructions_reset"), { id })) as { status: string }
  expect(reset.status).toContain("it follows what it inherits again")
  expect(await reader()).toEqual([])
  expect((await runFail(need(tools, "instructions_reset"), { id })).message).toContain("has no override to reset")
  // A copy of the inherited text an earlier release stored is an own value as well…
  const loaded = await load(project)
  const copy = { type: "customization" as const, level: "defaults" as const, agent: "alpha", item: "tool:reader", section: null, text: "read things", basedOn: "x", updated: "2026-01-01T00:00:00.000Z" }
  expect((await save(project, { expectedProjectRevision: loaded.projectRevision, expectedGlobalRevision: loaded.globalRevision, records: [...loaded.records, copy] })).ok).toBe(true)
  expect(id).toBe("item:defaults:alpha:tool:reader")
  expect(await changed()).toEqual([id])
  // …and the row's next save keeps it beside what the save sets.
  await runOk(need(tools, "instructions_set"), { id, state: "on" })
  expect(await reader()).toEqual([expect.objectContaining({ agent: "alpha", text: "read things", state: "on" })])
})

test("a preset change never removes or overrides a linked agent's own change (b-06)", async () => {
  const { project } = await tempProject()
  await linkToBuild(project, "defaults", ["alpha"])
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const own = "item:defaults:alpha:tool:reader"
  const preset = "item:preset:build:tool:reader"
  const row = async () => (await runOk(need(tools, "instructions_find"), { where: `id:${own}`, fields: ["id", "badges", "from"] })) as { rows: unknown[] }
  const records = async () => (await load(project)).records.filter((record) => record.type === "customization" && record.agent === "alpha")
  await runOk(set, { id: own, state: "off" })
  expect(await records()).toEqual([expect.objectContaining({ level: "defaults", item: "tool:reader", state: "off" })])
  // The preset now says off too: the agent's off stays its own.
  await runOk(set, { id: preset, state: "off" })
  expect(await records()).toEqual([expect.objectContaining({ level: "defaults", item: "tool:reader", state: "off" })])
  // Its own row, not the preset's; the change above puts it to review (keep or take).
  expect((await row()).rows).toEqual(["item:defaults:alpha:tool:reader | off to review (state) | from default alpha"])
  // The preset goes back on: the agent stays off.
  await runOk(set, { id: preset, state: "on" })
  expect(await records()).toEqual([expect.objectContaining({ level: "defaults", item: "tool:reader", state: "off" })])
  expect(await rowState(api, own)).toBe("off")
  // Set to what it inherits (on): an own value, kept through a later preset change.
  await runOk(set, { id: own, state: "on" })
  expect(await records()).toEqual([expect.objectContaining({ item: "tool:reader", state: "on" })])
  await runOk(set, { id: preset, state: "off" })
  expect(await rowState(api, own)).toBe("on")
  // reset follows the preset again.
  const reset = (await runOk(need(tools, "instructions_reset"), { id: own })) as { status: string }
  expect(reset.status).toBe('Reset "reader": it follows what it inherits again (off, from preset Build)')
  expect(await records()).toEqual([])
  expect(await rowState(api, own)).toBe("off")
})

for (const baseline of ["", "Unheaded baseline", "# Previous\nPrevious body."]) {
  test(`whole-item set survives durable reload across heading transition: ${JSON.stringify(baseline)}`, async () => {
    const { api, tools, project, ctx } = await freshFixture({
      tools: [{ id: "reader", description: baseline, options: { codemode: false } }],
    })
    await linkToBuild(project, "defaults", ["alpha"])
    const id = await readerRowId(api)
    const text = "# Role\nBUILD_CHANGED_CANARY. Follow safety instructions."
    await runOk(need(tools, "instructions_set"), { id, text })
    expect((await load(project)).records.some((record) => record.type === "customization" && record.text === text)).toBe(true)
    const reloaded = createPlusApi(ctx, createState())
    await registerInstructionTools(ctx, reloaded)
    const registered = await readTools(ctx)
    const shown = await runOk(need(registered, "instructions_read"), { id, view: "resolved" })
    expect(shown).toMatchObject({ text })
    const snapshot = await snapshotOf(reloaded)
    const memo = memoFromSnapshot(snapshot)
    const node = expandedTree(memo).find((candidate) => candidate.id === id)
    const item = memo.items.find((candidate) => candidate.id === "tool:reader")
    if (node?.address === undefined || item === undefined) throw new Error("missing reader")
    expect(
      resolve({
        upstream: item,
        records: (await load(project)).records.filter((record) => record.type === "customization"),
        splits: [],
        scopes: { global: new Set(), defaults: new Set(["alpha"]) },
        address: node.address,
      }).assembled,
    ).toBe(text)
    await runOk(need(registered, "instructions_reset"), { id })
    expect(await runOk(need(registered, "instructions_read"), { id, view: "resolved" })).toMatchObject({
      text: baseline,
    })
    expect((await load(project)).records.some((record) => record.type === "customization" && record.text === text)).toBe(false)
  })
}

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

test("split with add on section adds child; on item adds top-level", async () => {
  const { api, tools } = await freshFixture()
  await addToolsAndRules(tools)
  const snapshot = await snapshotOf(api)
  const memo = memoFromSnapshot(snapshot)
  const nodes = expandedTree(memo)

  // Find a heading-derived item or section row (e.g. system:tools-and-rules or similar, or any splittable item)
  const itemNode = nodes.find((n) => n.kind === "item" && n.address?.item === "system:tools-and-rules")
  if (itemNode === undefined) throw new Error("missing system:tools-and-rules row")

  // Find a section of this item
  const sectionNode = nodes.find((n) => n.kind === "section" && n.address?.item === "system:tools-and-rules" && n.address.section !== null)
  if (sectionNode === undefined) throw new Error("missing section under system:tools-and-rules")

  // 1. split({ id: sectionNode.id, add }) on a section adds a child of that section
  const childResult = (await runOk(need(tools, "instructions_split"), {
    id: sectionNode.id,
    add: { name: "ChildSection", text: "Child content." },
  })) as { status: string }
  expect(childResult.status).toContain("Added \"ChildSection\"")

  const afterChild = await snapshotOf(api)
  const afterChildMemo = memoFromSnapshot(afterChild)
  const childRow = expandedTree(afterChildMemo).find((n) => n.label === "ChildSection")
  expect(childRow).toBeDefined()
  expect(childRow?.kind).toBe("section")
  expect(childRow?.depth).toBeGreaterThan(sectionNode.depth)

  // 2. split({ id: itemNode.id, add }) on an item adds top-level
  const topResult = (await runOk(need(tools, "instructions_split"), {
    id: itemNode.id,
    add: { name: "TopSection", text: "Top content." },
  })) as { status: string }
  expect(topResult.status).toContain("Added \"TopSection\"")

  const afterTop = await snapshotOf(api)
  const afterTopMemo = memoFromSnapshot(afterTop)
  const topRow = expandedTree(afterTopMemo).find((n) => n.label === "TopSection")
  expect(topRow).toBeDefined()
  expect(topRow?.kind).toBe("section")
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
  await runOk(toolCreate, { kind: "agent", id: "helper", preset: "basic/orchestrator" })
  await runOk(toolCreate, { kind: "skill", name: "notes2", body: skillBody })
  await runOk(toolCreate, { kind: "base", id: "custom", title: baseTitle, text: baseText })
  // OpenCodePlus: create kind:"instruction" is disabled pending the Context
  // catalogue (src/instructions/discover.ts); the api path below stays skipped too
  // so both sides write the same files.
  // await runOk(toolCreate, { kind: "instruction", name: "AGENTS.md", text: instructionText })
  await runOk(toolCreate, { kind: "mcp", name: "search", config: mcpConfig })
  process.env.OPENCODE_CONFIG_DIR = apiConfig
  const apiAgent = await apiApi.createAgent({ scope: "project", id: "helper", preset: { kind: "member", team: "basic", id: "orchestrator" } })
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
  const before = await load(project)
  const error = await runFail(need(tools, "instructions_set"), { id, text: "# Role\nBlocked heading transition." })
  expect(error.message).toContain("agent.protected")
  const after = await snapshotOf(api)
  expect(after.records).toEqual([])
  expect(await load(project)).toEqual(before)
  expect((await runFail(need(tools, "instructions_set"), { id: "item:project:alpha:missing", text: "# Role\nInvalid." })).message).toContain("row.unknown")
  expect(await load(project)).toEqual(before)
})

test("edit replaces exact text in a row and saves exactly what set saves", async () => {
  const { api, tools, project } = await freshFixture()
  const edit = need(tools, "instructions_edit")
  const show = need(tools, "instructions_read")
  await runOk(need(tools, "instructions_create"), { kind: "agent", id: "editprobe", scope: "project" })
  await linkToBuild(project, "project", ["editprobe"])
  const id = "item:project:editprobe:tool:reader"
  const saved = (await runOk(edit, { id, oldString: "read", newString: "scan" })) as { id: string; status: string; replacements: number }
  expect(saved).toEqual({ id, status: 'Saved "reader"', replacements: 1 })
  expect(((await runOk(show, { id })) as { text: string }).text).toBe("scan things")
  const stored = (await load(project)).records.filter((record) => record.type === "customization" && record.item === "tool:reader")
  expect(stored.map((record) => (record.type === "customization" ? record.text : undefined))).toEqual(["scan things"])

  // The same text through set stores the same records.
  const { api: setApi, tools: setTools, project: setProject } = await freshFixture()
  await runOk(need(setTools, "instructions_create"), { kind: "agent", id: "editprobe", scope: "project" })
  await linkToBuild(setProject, "project", ["editprobe"])
  await runOk(need(setTools, "instructions_set"), { id, text: "scan things" })
  expect(withoutUpdated((await snapshotOf(setApi)).records)).toEqual(withoutUpdated((await snapshotOf(api)).records))
})

test("edit refuses a missing, repeated, identical or empty oldString without writing", async () => {
  const { api, tools, project } = await freshFixture()
  const edit = need(tools, "instructions_edit")
  const show = need(tools, "instructions_read")
  await runOk(need(tools, "instructions_create"), { kind: "agent", id: "editprobe", scope: "project" })
  await linkToBuild(project, "project", ["editprobe"])
  const id = "item:project:editprobe:tool:reader"
  await runOk(need(tools, "instructions_set"), { id, text: "Read a file. Read it twice.\n\nKeep ‘quotes’ here.  \nLast line." })
  const before = await snapshotOf(api)
  expect((await runFail(edit, { id, oldString: "absent", newString: "x" })).message).toContain('Could not find oldString in "reader"')
  expect((await runFail(edit, { id, oldString: "Read", newString: "Scan" })).message).toContain("Found 2 matches")
  expect((await runFail(edit, { id, oldString: "Read", newString: "Read" })).message).toContain("identical")
  expect((await runFail(edit, { id, oldString: "", newString: "x" })).message).toContain("must not be empty")
  expect((await runFail(edit, { id: "item:project:editprobe:tool:missing", oldString: "a", newString: "b" })).message).toContain("row.unknown")
  expect((await snapshotOf(api)).revision).toBe(before.revision)

  // replaceAll replaces every match; straight quotes match typographic ones;
  // whole lines match without their trailing spaces.
  expect(((await runOk(edit, { id, oldString: "Read", newString: "Scan", replaceAll: true })) as { replacements: number }).replacements).toBe(2)
  await runOk(edit, { id, oldString: "Keep 'quotes' here.", newString: "Keep quotes here." })
  await runOk(edit, { id, oldString: "Keep quotes here.\nLast line.", newString: "Keep quotes here.\nFinal line." })
  expect(((await runOk(show, { id })) as { text: string }).text).toBe("Scan a file. Scan it twice.\n\nKeep quotes here.\nFinal line.")
})

test("edit changes one section of a headed row and refuses rows without text", async () => {
  const { api, tools, project } = await freshFixture()
  const edit = need(tools, "instructions_edit")
  const show = need(tools, "instructions_read")
  await runOk(need(tools, "instructions_create"), { kind: "agent", id: "editprobe", scope: "project" })
  await linkToBuild(project, "project", ["editprobe"])
  const id = "item:project:editprobe:tool:reader"
  await runOk(need(tools, "instructions_set"), { id, text: "Read a file.\n\n## Gate\nGATE_CANARY one.\n\n## Other\nOTHER_CANARY two.\n" })
  await runOk(edit, { id: "section:project:editprobe:tool:reader:gate", oldString: "GATE_CANARY one.", newString: "GATE_CANARY edited." })
  expect(((await runOk(show, { id })) as { text: string }).text.trimEnd()).toBe("Read a file.\n\n## Gate\nGATE_CANARY edited.\n\n## Other\nOTHER_CANARY two.")
  await runOk(edit, { id, oldString: "OTHER_CANARY two.", newString: "OTHER_CANARY whole-row edit." })
  expect(((await runOk(show, { id: "section:project:editprobe:tool:reader:other" })) as { text: string }).text).toContain("OTHER_CANARY whole-row edit.")

  const before = await snapshotOf(api)
  expect((await runFail(edit, { id: "agent:project:editprobe", oldString: "a", newString: "b" })).message).toBe('"editprobe" has no text to edit: change it with set')
  expect((await snapshotOf(api)).revision).toBe(before.revision)
})

test("show lists the rows under an agent and sends assembled only when it differs from text", async () => {
  const { tools, project } = await freshFixture()
  const show = need(tools, "instructions_read")
  await runOk(need(tools, "instructions_create"), { kind: "agent", id: "showprobe", scope: "project" })
  await linkToBuild(project, "project", ["showprobe"])
  const agent = (await runOk(show, { id: "agent:project:showprobe" })) as { kind: string; link?: string; columns: string; rows: string[] }
  expect(agent.kind).toBe("agent")
  expect(agent.link).toBe("build")
  expect(agent.columns).toBe("id | badges | from")
  expect(agent.rows.some((row) => row.startsWith("group:project:showprobe:tools | "))).toBe(true)
  const group = (await runOk(show, { id: "group:project:showprobe:tools" })) as { kind: string; rows: string[] }
  expect(group.kind).toBe("group")
  expect(group.rows.length).toBeGreaterThan(0)
  expect((await runFail(show, { id: "agent:project:showprobe", view: "mine" })).message).toContain("resolved lists the rows under it")

  const id = "item:project:showprobe:tool:reader"
  const plain = (await runOk(show, { id })) as { text: string; assembled?: string }
  expect(plain.text).toBe("read things")
  expect("assembled" in plain).toBe(false)
  await runOk(need(tools, "instructions_set"), { id, text: "Read a file.\n\n## Gate\nGATE_CANARY.\n" })
  await runOk(need(tools, "instructions_set"), { id: "section:project:showprobe:tool:reader:gate", state: "off" })
  const gated = (await runOk(show, { id })) as { text: string; assembled?: string }
  expect(gated.text).toContain("GATE_CANARY")
  expect(gated.assembled).toBeDefined()
  expect(gated.assembled).not.toContain("GATE_CANARY")
})

test("edit refuses a protected agent's row", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fixtureContext(project)
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const id = await readerRowId(api)
  const before = await load(project)
  expect((await runFail(need(tools, "instructions_edit"), { id, oldString: "read", newString: "scan" })).message).toContain("agent.protected")
  expect(await load(project)).toEqual(before)
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
  expect(registered.map((tool) => tool.id).toSorted()).toEqual(instructionToolIds)
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
  expect(registered.map((tool) => tool.id).toSorted()).toEqual(instructionToolIds)
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
test("activation installs the instruction tooling and deactivate disposes it", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-tools-enable-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fixtureContext(project)
  const state = createState()
  const toolIds = async () => [...(await readTools(ctx)).keys()].filter((id) => id.startsWith("instructions_")).toSorted()
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
  await Effect.runPromise(activate(ctx, state))
  expect(await toolIds()).toEqual(instructionToolIds)
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
  // Tavily and Exa are built-in web tools: Plus adds no search MCP server.
  expect(await serverNames()).toEqual(beforeServers)
  expect([...(await readTools(ctx)).keys()].filter((id) => id.startsWith("web_")).toSorted()).toEqual([
    "web_exa_code_search",
    "web_tavily_fetch",
    "web_tavily_search",
  ])
  const installed = [...state.tooling]
  await Effect.runPromise(activate(ctx, state))
  expect(state.tooling).toEqual(installed)
  expect(await toolIds()).toEqual(instructionToolIds)
  await Effect.runPromise(deactivate(state))
  expect(await toolIds()).toEqual([])
  expect([...(await readTools(ctx)).keys()].some((id) => id.startsWith("web_"))).toBe(false)
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
  const show = need(tools, "instructions_read")
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

// An off rule previews what it really cuts: whole-word lines of its parent
// tool description. A subagent row drops nothing at all, whatever keywords a
// stored record holds (Core already lists only the subagents an agent may run).
test("a subagent rule reports no scrub, and a tool rule previews its own cut lines", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "The runner takes the next step.\nRun git commit before you report.")],
    tools: [
      { id: "shell", description: "Run shell.\nUse git commit to save.\nInspect with git status.", options: { codemode: false } },
      { id: "subagent", description: "Run a subagent.", options: { codemode: false } },
    ],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  // The discovered agents resolve at Defaults here, so the records live there.
  // The stored subagent rule keeps the keywords an older record could hold;
  // discovery ships the row without any, and no keyword ever cuts a line.
  const loaded = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: [
      { type: "link", level: "defaults", agent: "alpha", preset: { kind: "agent", id: "build" }, updated: "2026-01-01T00:00:00.000Z" },
      { type: "customization", level: "defaults", agent: "alpha", item: "perm:subagent:runner", section: null, state: "off", basedOn: "any", updated: "2026-01-01T00:00:00.000Z" },
      { type: "rule", level: "defaults", agent: "alpha", tool: "subagent", id: "runner", label: "runner", patterns: ["runner"], keywords: ["runner"], updated: "2026-01-01T00:00:00.000Z" },
      { type: "customization", level: "defaults", agent: "alpha", item: "perm:shell:git", section: null, state: "on", basedOn: "any", updated: "2026-01-01T00:00:00.000Z" },
      { type: "customization", level: "defaults", agent: "alpha", item: "perm:shell:git-commit", section: null, state: "off", basedOn: "any", updated: "2026-01-01T00:00:00.000Z" },
    ],
  })
  if (!saved.ok) throw new Error("expected records to save")
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const rows = expandedTree(memoFromSnapshot(await snapshotOf(api)))
  const rowOf = (item: string) => {
    const node = rows.find((candidate) => candidate.address?.item === item && candidate.address?.agent === "alpha")
    if (node === undefined) throw new Error(`missing ${item} row`)
    return node
  }
  const subagentShown = (await runOk(need(tools, "instructions_read"), { id: rowOf("perm:subagent:runner").id })) as {
    keywords: string[]
    scrub: { hidden: number; preview: readonly string[] }
  }
  // The stored record's keywords are reported (a user rule keeps its own
  // definition), yet they cut nothing: a subagent row never scrubs.
  expect(subagentShown.keywords).toEqual(["runner"])
  expect(subagentShown.scrub).toEqual({ hidden: 0, preview: [] })
  const gitShown = (await runOk(need(tools, "instructions_read"), { id: rowOf("perm:shell:git-commit").id })) as {
    scrub: { hidden: number; preview: readonly string[] }
  }
  expect(gitShown.scrub).toEqual({ hidden: 1, preview: ["Use git commit to save."] })
  // read({ view: "assembled" }) passes the same list through, so the model sees
  // every line a rule cut and which rule cut it; system text never appears.
  const agentRow = rows.find((node) => node.kind === "agent" && node.label === "alpha")
  if (agentRow === undefined) throw new Error("missing alpha agent row")
  const assembled = (await runOk(need(tools, "instructions_read"), { id: agentRow.id, view: "assembled" })) as {
    system: readonly string[]
    tools: readonly { id: string; description: string }[]
    dropped?: readonly { where: string; rule: string; line: string }[]
  }
  expect(assembled.tools.find((entry) => entry.id === "shell")?.description).toBe("Run shell.\nInspect with git status.")
  expect(assembled.system).toContain("The runner takes the next step.\nRun git commit before you report.")
  expect(assembled.dropped).toEqual([{ where: "tool:shell", rule: "perm:shell:git-commit", line: "Use git commit to save." }])
})

// Stored original and yours have no final newline; the live upstream keeps one (B41).
const mergeOriginal = "Alpha one.\nBeta two.\nGamma three.\nDelta four.\nEpsilon five.\nZeta six.\nEta seven."
const mergeMine = "Alpha mine.\nBeta two.\nGamma three.\nDelta four.\nEpsilon yours.\nZeta six.\nEta same."
const mergeUpstream = "Alpha one.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon upstream.\nZeta six.\nEta same.\n"
const mergeDefault = "Alpha mine.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon yours.\nZeta six.\nEta same."

async function readerAt(project: string, description: string) {
  const ctx = fixtureContext(project, {
    tools: [
      { id: "reader", description, options: { codemode: false } },
      { id: "skill", description: "Load a skill", options: { codemode: false } },
    ],
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  return { api, tools: await readTools(ctx) }
}

async function mergeFixture(): Promise<{ api: PlusApi; tools: Map<string, Tool.Info & { readonly id: string }>; id: string }> {
  const { project } = await tempProject()
  const writer = await readerAt(project, mergeOriginal)
  await runOk(need(writer.tools, "instructions_set"), { id: await readerRowId(writer.api), text: mergeMine })
  const reader = await readerAt(project, mergeUpstream)
  return { api: reader.api, tools: reader.tools, id: await readerRowId(reader.api) }
}

// A heading-derived item: its customization is stored at the section level.
const headingOriginal = "# Reader\nAlpha one.\nBeta two.\n"
const headingMine = "# Reader\nAlpha mine.\nBeta two.\n"
const headingUpstream = "# Reader\nAlpha one.\nBeta upstream.\n"

test("take on a heading-derived item follows upstream for the whole row", async () => {
  const { project } = await tempProject()
  const writer = await readerAt(project, headingOriginal)
  const writerId = await readerRowId(writer.api)
  await runOk(need(writer.tools, "instructions_set"), { id: writerId, text: headingMine })
  const reader = await readerAt(project, headingUpstream)
  const id = await readerRowId(reader.api)
  const before = await snapshotOf(reader.api)
  const customBefore = before.records.filter((record) => record.type === "customization" && record.item === "tool:reader")
  const taken = (await runOk(need(reader.tools, "instructions_set"), { id, resolve: "take" })) as { status: string }
  expect(taken.status).toBe(`Took upstream for "reader"`)
  const after = await snapshotOf(reader.api)
  const customAfter = after.records.filter(
    (record): record is Plus.SnapshotCustomizationRecord => record.type === "customization" && record.item === "tool:reader",
  )
  const upstream = (await runOk(need(reader.tools, "instructions_read"), { id, view: "upstream" })) as { text: string }
  const shown = (await runOk(need(reader.tools, "instructions_read"), { id })) as { text: string }
  expect({ before: customBefore.length, textAfter: customAfter.filter((record) => record.text !== undefined).length }).toEqual({
    before: 1,
    textAfter: 0,
  })
  // The resolved view carries no final newline; the upstream text has one.
  expect(shown.text).toBe(upstream.text.replace(/\n+$/, ""))
})

test("show diff proposes merge units with their kinds and defaults", async () => {
  const { tools, id } = await mergeFixture()
  const diff = (await runOk(need(tools, "instructions_read"), { id, view: "diff" })) as {
    merge: { units: { id: string; kind: string; included: boolean; yours: string; upstream: string; base: string }[]; text: string }
  }
  expect(diff.merge.units.map((unit) => [unit.id, unit.kind, unit.included])).toEqual([
    ["m0", "yours", true],
    ["m1", "upstream", true],
    ["m2", "both", true],
    ["m2:upstream", "both", false],
    ["m3", "same", true],
  ])
  expect(diff.merge.units[3]).toMatchObject({ yours: "Epsilon yours.\n", upstream: "Epsilon upstream.\n", base: "Epsilon five.\n" })
  expect(diff.merge.text).toBe(mergeDefault)
})

test("set resolve merge with the defaults saves the default render", async () => {
  const { api, tools, id } = await mergeFixture()
  const saved = (await runOk(need(tools, "instructions_set"), { id, resolve: "merge" })) as { status: string }
  expect(saved.status).toBe(`Merged "reader"`)
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "customization" && record.text === mergeDefault)).toBe(true)
})

test("set resolve merge with the upstream side of a both unit saves that side", async () => {
  const { api, tools, id } = await mergeFixture()
  const saved = (await runOk(need(tools, "instructions_set"), { id, resolve: "merge", include: ["m0", "m1", "m2:upstream", "m3"] })) as {
    status: string
  }
  expect(saved.status).toBe(`Merged "reader"`)
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "customization" && record.text === "Alpha mine.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon upstream.\nZeta six.\nEta same.")).toBe(true)
})

test("set resolve merge whose include equals upstream records a take", async () => {
  const { api, tools, id } = await mergeFixture()
  const taken = (await runOk(need(tools, "instructions_set"), { id, resolve: "merge", include: ["m1", "m2:upstream", "m3"] })) as {
    status: string
  }
  expect(taken.status).toBe(`Took upstream for "reader"`)
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "customization" && record.item === "tool:reader" && record.text !== undefined)).toBe(false)
})

test("set resolve merge refuses an unknown unit id and names the valid ids", async () => {
  const { api, tools, id } = await mergeFixture()
  const refused = await runFail(need(tools, "instructions_set"), { id, resolve: "merge", include: ["m0", "m9"] })
  expect(refused.message).toContain(`"m9"`)
  expect(refused.message).toContain("m0, m1, m2, m2:upstream, m3")
  const notMerge = await runFail(need(tools, "instructions_set"), { id, resolve: "keep", include: ["m0"] })
  expect(notMerge.message).toContain("include applies only with resolve merge")
  const after = await snapshotOf(api)
  expect(after.records.some((record) => record.type === "customization" && record.text === mergeMine)).toBe(true)
})

test("registered list and log tools return persisted rows and history", async () => {
  const { api, tools } = await freshFixture()
  const id = await readerRowId(api)
  await runOk(need(tools, "instructions_set"), { id, text: "listed text" })
  // Lines by default: one "id | badges | from" string per row.
  const list = (await runOk(need(tools, "instructions_find"), {})) as { rows: readonly string[]; total: number; columns: string }
  expect(list.total).toBeGreaterThan(0)
  expect(list.columns).toBe("id | badges | from")
  expect(list.rows).toContain(`${id} | off modified | off by default`)
  expect(list.rows.every((row) => row.split(" | ").length === 3)).toBe(true)
  const labelled = (await runOk(need(tools, "instructions_find"), { where: `id:${id}`, fields: ["label", "tokens"] })) as { rows: readonly string[]; columns: string }
  expect(labelled.columns).toBe("id | label | tokens")
  expect(labelled.rows[0]).toMatch(new RegExp(`^${id} \\| reader \\| \\d+$`))
  const logged = (await runOk(need(tools, "instructions_log"), {})) as {
    entries: readonly { op: string }[]
    total: number
  }
  expect(logged.total).toBeGreaterThan(0)
  expect(logged.entries.some((entry) => entry.op === "mutate")).toBe(true)
})

test("find takes structured parameters and answers one row per thing", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencode", "agent", "alpha.md"), formatMarkdown({}, "Alpha role.\n"))
  await Bun.write(path.join(project, ".opencode", "agent", "beta.md"), formatMarkdown({}, "Beta role.\n"))
  await linkToBuild(project, "project", ["alpha", "beta"])
  const ctx = fixtureContext(project, {
    agents: [agentInfo("build"), agentInfo("alpha"), agentInfo("beta")],
    tools: [
      { id: "reader", description: "# One\nread things\n\n# Two\nSecond part.\n", options: { codemode: false } },
      { id: "skill", description: "Load a skill", options: { codemode: false } },
    ],
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const find = async (input: Record<string, unknown>) => (await runOk(need(tools, "instructions_find"), { limit: 500, ...input })) as { rows: string[]; total: number }
  const ids = async (input: Record<string, unknown>) => rowIds(await find(input))
  const reader = "item:project:alpha:tool:reader"

  // One agent's tools: each once, at the most specific level, without sections or presets.
  const alphaTools = await ids({ agent: "alpha", type: "tool" })
  expect(alphaTools.filter((id) => id.endsWith(":tool:reader"))).toEqual([reader])
  expect(alphaTools.every((id) => id.startsWith("item:project:alpha:tool:"))).toBe(true)
  // agent is the exact name ignoring case; * stands for any text.
  expect(await ids({ agent: "alp", type: "tool" })).toEqual([])
  expect(await ids({ agent: "ALP*", type: "tool", name: "reader" })).toEqual([reader])
  // A native agent has a row at every level: without level, the most specific one; level picks one.
  expect(await ids({ agent: "build", type: "tool", name: "reader" })).toEqual(["item:project:build:tool:reader"])
  expect(await ids({ agent: "build", type: "tool", name: "reader", level: "global" })).toEqual(["item:global:build:tool:reader"])
  // Without an agent, the agents' copies with the same value are one row that says how many more.
  expect((await find({ type: "skill" })).rows).toEqual([
    "item:project:build:skill:notes | on | OpenCode (+2 agents)",
    "item:defaults::skill:notes | off | off by default",
  ])
  expect(await ids({ type: "skill", agent: "*" })).toEqual(["item:project:build:skill:notes", "item:project:alpha:skill:notes", "item:project:beta:skill:notes"])
  // An edit makes alpha's copy a row of its own; is:changed names the row holding it.
  await runOk(need(tools, "instructions_edit"), { id: reader, oldString: "read things", newString: "scan things" })
  expect((await find({ type: "tool", name: "reader" })).rows).toEqual([
    "item:project:build:tool:reader | on | OpenCode (+1 agent)",
    `${reader} | on modified | from preset Build`,
    "item:defaults::tool:reader | off | off by default",
  ])
  expect(await ids({ is: "changed" })).toEqual([reader])
  expect(await ids({ type: "tool", text: "SCAN" })).toEqual([reader])
  // Sections show for type section, a name, or in; their item row carries a text match.
  expect(await ids({ agent: "alpha", text: "Second part" })).toEqual([reader])
  expect(await ids({ agent: "alpha", type: "section", text: "Second part" })).toEqual([`section:project:alpha:tool:reader:two`])
  expect(await ids({ agent: "alpha", name: "two" })).toEqual([`section:project:alpha:tool:reader:two`])
  expect(await ids({ in: reader })).toEqual([`section:project:alpha:tool:reader:one`, `section:project:alpha:tool:reader:two`, "item:project:alpha:toolmode:reader"])
  // A value is passed whole, quotes and backslashes included.
  expect((await find({ text: 'say "hi" \\ there' })).total).toBe(0)
  // A key that does not exist names the one that does.
  expect((await runFail(need(tools, "instructions_find"), { where: "member:alpha" })).message).toContain("use agent:<member>")
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
  const shown = (await runOk(need(tools, "instructions_read"), { id: node.id, view: "resolved" })) as { text: string }
  expect(shown.text).toBe("custom coder text")
  const record = (await runOk(need(tools, "instructions_read"), { id: node.id, view: "record" })) as { record: { text?: string } | null }
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

test("a bare-id toggle sends a delta and lands over a concurrent write to another row", async () => {
  const { project } = await tempProject()
  const ctx = fixtureContext(project)
  await linkToBuild(project, "defaults", ["alpha"])
  const state = createState()
  const real = createPlusApi(ctx, state)
  const before = await snapshotOf(real)
  const memo = memoFromSnapshot(before)
  const target = expandedTree(memo).find((candidate) => candidate.address?.item === "tool:reader")
  if (target === undefined) throw new Error("missing reader row")
  const expected = toggle(memo, target.id)
  if ("refusal" in expected) throw new Error(`expected toggle success: ${expected.refusal}`)
  // A different row is written concurrently, the way another writer would.
  // With the full form this was a stale refusal; the delta form lands both
  // writes because they touch different rows.
  let injected = false
  const sent: Plus.MutateInput[] = []
  const wrapped: PlusApi = {
    ...real,
    mutate: async (input) => {
      sent.push(input)
      if (!injected && "changes" in input) {
        injected = true
        const concurrent = await real.mutate({
          changes: {
            upsert: [
              {
                type: "customization",
                level: "defaults",
                agent: "alpha",
                item: "skill:notes",
                section: null,
                state: "off",
                basedOn: "",
                updated: "2026-01-01T00:00:00.000Z",
              },
            ],
            remove: [],
          },
          actor: { type: "tui" },
        })
        if (!concurrent.ok || !concurrent.value.ok) throw new Error("concurrent delta write failed")
      }
      return real.mutate(input)
    },
  }
  await registerInstructionTools(ctx, wrapped)
  const tools = await readTools(ctx)
  const output = (await runOk(need(tools, "instructions_set"), { id: target.id })) as { status: string }
  expect(output.status).toBe(expected.status)
  const delta = sent.find((input) => "changes" in input)
  if (delta === undefined || !("changes" in delta)) throw new Error("expected a delta write")
  // Only the toggled row crossed the wire; the concurrent row did not.
  expect(delta.changes.upsert).toHaveLength(1)
  expect(delta.changes.upsert[0]).toMatchObject({ type: "customization", item: "tool:reader" })
  expect(delta.changes.remove).toEqual([])
  const after = await snapshotOf(real)
  const enabled = after.records.find((record) => record.type === "customization" && record.item === "tool:reader")
  if (enabled === undefined || enabled.type !== "customization") throw new Error("expected committed record")
  expect(enabled.state).toBe(expected.records.find((record) => record.item === "tool:reader")?.state)
  const otherRow = after.records.find((record) => record.type === "customization" && record.item === "skill:notes")
  if (otherRow === undefined || otherRow.type !== "customization") throw new Error("expected concurrent record")
  expect(otherRow.state).toBe("off")
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
  const recordView = (await runOk(need(tools, "instructions_read"), { id: row.id, view: "record" })) as {
    id: string
    view: string
    record: { type?: string; active?: boolean } | null
  }
  expect(recordView.record?.type).toBe("model")
  expect(recordView.record?.active).toBe(true)
  const listed = (await runOk(need(tools, "instructions_find"), { where: "item:model active:true" })) as { rows: readonly string[] }
  expect(rowIds(listed)).toContain(row.id)
  // The effective model refuses deletion: activate a replacement first. r
  // clears only this level's active flag, so the candidate then deletes.
  const refused = await runFail(need(tools, "instructions_delete"), { id: row.id, confirm: true })
  expect(refused.message).toBe(`"acme/nova-2" is the active model here: activate another model first`)
  await runOk(need(tools, "instructions_reset"), { id: row.id })
  const deleted = (await runOk(need(tools, "instructions_delete"), { id: row.id, confirm: true })) as { status: string }
  expect(deleted.status).toBe('Removed "acme/nova-2"')
  void modelHarness
})

test("set text on a model row replaces the candidate and keeps the active flag", async () => {
  const { tools, project } = await freshFixture({
    models: [modelInfo("acme", "nova-2"), modelInfo("acme", "nova-3")],
    classifications: { "nova-2": "general", "nova-3": "general" },
  })
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")
  const created = (await runOk(create, { kind: "model", providerID: "acme", modelID: "nova-2", level: "defaults", agent: "alpha" })) as { id: string }
  await runOk(set, { id: created.id, active: true })
  const replaced = (await runOk(set, { id: created.id, text: "acme/nova-3#high" })) as { status: string }
  expect(replaced.status).toBe('Updated "acme/nova-2"')
  // The row changes in place: one live record for the new candidate and a
  // tombstone hiding the old one at this level.
  const stored = (await load(project)).records.filter((record) => record.type === "model" && record.agent === "alpha" && record.removed !== true)
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({ providerID: "acme", modelID: "nova-3", variant: "high", active: true })
  expect(
    (await load(project)).records.some(
      (record) => record.type === "model" && record.agent === "alpha" && record.removed === true && record.modelID === "nova-2",
    ),
  ).toBe(true)
  expect((await runFail(set, { id: "item:defaults:alpha:model:acme/nova-3@high", text: "not-a-model" })).message).toContain("takes provider/model")
})

test("set warming on a model row stores it through the real store; bad values and non-model rows refuse", async () => {
  const { api, tools, project } = await freshFixture({ models: [modelInfo("acme", "nova-2")], classifications: { "nova-2": "general" } })
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")
  const created = (await runOk(create, { kind: "model", providerID: "acme", modelID: "nova-2", level: "defaults", agent: "alpha" })) as { id: string }
  const applied = (await runOk(set, { id: created.id, warming: "90m" })) as { status: string }
  expect(applied.status).toBe('Cache warming for "acme/nova-2": 1h30m')
  const stored = (await load(project)).records.find((record) => record.type === "model" && record.agent === "alpha")
  expect(stored).toMatchObject({ providerID: "acme", modelID: "nova-2", warming: "1h30m" })
  // The production snapshot reader carries it to the row (this file's memoFromSnapshot predates warming).
  const row = expandedTree(memoInputOf(await snapshotOf(api))).find((node) => node.id === created.id)
  expect(row?.badges.warming).toBe("1h30m")
  expect(await runOk(need(tools, "instructions_read"), { id: created.id, view: "record" })).toMatchObject({ record: { warming: "1h30m" } })
  // Refusals leave the store unchanged.
  const before = await load(project)
  expect((await runFail(set, { id: created.id, warming: "forever" })).message).toContain("not a warming time")
  const tool = expandedTree(memoInputOf(await snapshotOf(api))).find((node) => node.address?.item.startsWith("tool:") === true && node.address.agent === "alpha")
  if (tool === undefined) throw new Error("missing tool row")
  expect((await runFail(set, { id: tool.id, warming: "2h" })).message).toContain("not a model row")
  expect((await load(project)).records).toEqual(before.records)
  // Empty clears it again.
  await runOk(set, { id: created.id, warming: "" })
  expect((await load(project)).records.find((record) => record.type === "model" && record.agent === "alpha")).not.toHaveProperty("warming")
})

test("create model preserves the selected member owner and returns its addressable row", async () => {
  const { api, tools, project } = await freshFixture({ models: [modelInfo("acme", "nova-2")], classifications: { "nova-2": "general" } })
  const create = need(tools, "instructions_create")
  const show = need(tools, "instructions_read")
  const set = need(tools, "instructions_set")
  await runOk(create, { kind: "preset", id: "reader", from: "basic/scout" })
  await runOk(create, { kind: "teamPreset", id: "crew" })
  await runOk(create, { kind: "presetMember", team: "crew", id: "reader", from: "basic/scout" })
  const model = { kind: "model", providerID: "acme", modelID: "nova-2", level: "preset", agent: "reader" }
  const standalone = await runOk(create, model) as { id: string }
  await runOk(set, { id: standalone.id, active: true })
  const prior = await load(project)
  for (const invalid of [{ team: "missing" }, { team: "crew", agent: "missing" }, { agent: "missing" }, { team: "" }]) {
    expect((await runFail(create, { ...model, ...invalid })).message).toContain("model.invalid")
    expect(await load(project)).toEqual(prior)
  }
  const member = await runOk(create, { ...model, team: " crew " }) as { id: string }
  expect(member.id).toBe("item:preset:crew/:reader:model:acme/nova-2")
  expect(await runOk(show, { id: member.id, view: "record" })).toMatchObject({
    record: { level: "preset", agent: "reader", team: { level: "preset", team: "crew" } },
  })
  await runOk(set, { id: member.id, active: true })
  expect(await runOk(show, { id: member.id, view: "record" })).toMatchObject({ record: { active: true } })
  expect((await load(project)).records.find((record) => record.type === "model" && record.team === undefined))
    .toEqual(prior.records.find((record) => record.type === "model"))
  // Ordinary discovered members keep per-agent storage, just like the TUI,
  // but the returned row stays in the selected team's inheritance chain.
  await runOk(create, { kind: "team", team: "live", level: "project", preset: "crew" })
  const live = await runOk(create, { ...model, level: "project", team: "live" }) as { id: string }
  expect(live.id).toBe("item:project:live/:reader:model:acme/nova-2")
  expect(await runOk(show, { id: live.id, view: "record" })).toMatchObject({ record: { level: "project", agent: "reader" } })
  expect((await snapshotOf(api)).records.find((record) => record.type === "model" && record.level === "project")?.team).toBeUndefined()

  await runOk(create, { kind: "entry", catalogue: "teams", team: "crew*", name: "reader*" })
  const entry = await runOk(create, { ...model, level: "defaults", team: "crew*", agent: "reader*" }) as { id: string }
  expect(entry.id).toBe("item:defaults:crew*/:reader*:model:acme/nova-2")
  expect(await runOk(show, { id: entry.id, view: "record" })).toMatchObject({ record: { team: { level: "defaults", team: "crew*" } } })
})

test("show view:record matches the full owner, not just level and agent", async () => {
  const { api, tools } = await freshFixture({ models: [modelInfo("acme", "nova-2")], classifications: { "nova-2": "general" } })
  const create = need(tools, "instructions_create")
  const show = need(tools, "instructions_read")
  const set = need(tools, "instructions_set")
  await runOk(create, { kind: "preset", id: "reader", from: "basic/scout" })
  await runOk(create, { kind: "teamPreset", id: "crew" })
  await runOk(create, { kind: "presetMember", team: "crew", id: "reader", from: "basic/scout" })
  const model = { kind: "model", providerID: "acme", modelID: "nova-2", level: "preset", agent: "reader" }
  // The member (with its team) is created first, so without a full-owner match
  // a lookup that only checks level and agent would return it for the
  // standalone row too.
  const member = await runOk(create, { ...model, team: "crew" }) as { id: string }
  await runOk(set, { id: member.id, warming: "45m" })
  const standalone = await runOk(create, model) as { id: string }
  await runOk(set, { id: standalone.id, warming: "10m" })
  const standaloneRecord = await runOk(show, { id: standalone.id, view: "record" }) as { record: Record<string, unknown> | null }
  const memberRecord = await runOk(show, { id: member.id, view: "record" }) as { record: Record<string, unknown> | null }
  expect(standaloneRecord.record).toMatchObject({ warming: "10m" })
  expect(standaloneRecord.record?.team).toBeUndefined()
  expect(memberRecord.record).toMatchObject({ warming: "45m", team: { level: "preset", team: "crew" } })
})

test("create model refuses an owner-segment agent before writing and names agent + team", async () => {
  const { api, tools, project } = await freshFixture({ models: [modelInfo("acme", "nova-2")], classifications: { "nova-2": "general" } })
  const create = need(tools, "instructions_create")
  // A Global team whose member exists only as a team member.
  await runOk(create, { kind: "team", team: "Simple", level: "global" })
  await runOk(create, { kind: "member", team: "Simple", level: "global", id: "Simple-Orchestrator" })
  const memberRow = `team:global:Simple:Simple-Orchestrator`
  expect((await snapshotOf(api)).teams?.some((team) => team.team === "Simple")).toBe(true)
  void memberRow
  const before = await load(project)
  // The member's owner path is not an agent id: the old guard found the
  // member's Models group, wrote a literal-owner record, then failed with
  // create.failed, leaving a row delete could not reach.
  const refused = await runFail(create, { kind: "model", level: "global", agent: "Simple/:Simple-Orchestrator", providerID: "acme", modelID: "nova-2" })
  expect(refused.message).toContain("model.invalid")
  expect(refused.message).toContain('"Simple-Orchestrator"')
  expect(refused.message).toContain('"Simple"')
  // No write: store revision and records are unchanged.
  expect(await load(project)).toEqual(before)
  // The valid member control passes agent + team and returns the member row.
  const valid = (await runOk(create, { kind: "model", level: "global", agent: "Simple-Orchestrator", team: "Simple", providerID: "acme", modelID: "nova-2" })) as { id: string }
  expect(valid.id).toBe("item:global:Simple/:Simple-Orchestrator:model:acme/nova-2")
  expect((await load(project)).records.some((record) => record.type === "model" && record.level === "global" && record.agent === "Simple-Orchestrator")).toBe(true)
})

test("show separates inherited state and text provenance across role override and reset", async () => {
  const { tools } = await freshFixture()
  const create = need(tools, "instructions_create")
  const show = need(tools, "instructions_read")
  const set = need(tools, "instructions_set")
  await runOk(create, { kind: "teamPreset", id: "crew" })
  await runOk(create, { kind: "presetMember", team: "crew", id: "reader", from: "basic/scout" })
  await runOk(set, { id: "item:preset:crew/:reader:system:role", text: "Inherited member verification text" })
  await runOk(create, { kind: "team", team: "live", level: "global", preset: "crew" })
  const id = "item:global:live/:reader:system:role"
  const inherited = {
    text: "Inherited member verification text",
    stateFrom: { kind: "preset", id: "scout", team: "basic", shipped: true },
    textFrom: { kind: "preset", id: "reader", team: "crew", shipped: false },
    from: "from preset Basic › scout",
  }
  expect(await runOk(show, { id })).toMatchObject(inherited)
  await runOk(set, { id, text: "Local role override" })
  expect(await runOk(show, { id })).toMatchObject({
    ...inherited, text: "Local role override", textFrom: { kind: "level", level: "global" },
  })
  await runOk(need(tools, "instructions_reset"), { id })
  expect(await runOk(show, { id })).toMatchObject(inherited)
})

test("team activation tool reports exactly the teams it disables", async () => {
  const { api, tools } = await freshFixture()
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")
  await runOk(create, { kind: "team", team: "one", level: "project" })
  await runOk(create, { kind: "team", team: "two", level: "global" })
  expect(await runOk(set, { id: "team:project:one", state: "on" })).toMatchObject({ exclusive: true, disabledTeams: [] })
  expect(await runOk(set, { id: "team:global:two", state: "on" })).toMatchObject({
    enabled: true, exclusive: true, disabledTeams: [{ level: "project", team: "one" }],
  })
  expect((await snapshotOf(api)).teams?.filter((team) => team.enabled).map((team) => team.team)).toEqual(["two"])
  expect(await runOk(set, { id: "team:global:two", state: "on" })).toMatchObject({ disabledTeams: [] })
  expect(await runOk(set, { id: "team:global:two", state: "off" })).toMatchObject({ disabledTeams: [] })
})

test("read, set, edit, reset and delete take a list of ids or a find filter; writes answer counts and the rows not done", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const [find, read, set, edit, reset, remove] = ["find", "read", "set", "edit", "reset", "delete"].map((name) => need(tools, `instructions_${name}`))
  type Many = { total: number; failed: number; results: { id: string; output?: { status?: string; enabled?: boolean; replacements?: number }; error?: string }[] }
  type Written = { status: string; changed: string[]; already: number; notDone: { id: string; reason: string }[]; results?: Many["results"] }
  const alphas = rowIds((await runOk(find, { agent: "alpha", type: "rule", where: "tool:shell", limit: 200 })) as { rows: readonly string[] })
  const push = alphas.find((id) => id.endsWith(":perm:shell:git-push"))
  const sudo = alphas.find((id) => id.endsWith(":perm:shell:sudo"))
  if (push === undefined || sudo === undefined) throw new Error("expected alpha's git-push and sudo rows")

  // A list: each row is saved even though another refuses, and the answer names it with the reason.
  const switched = (await runOk(set, { id: [push, "item:project:alpha:perm:shell:nope", sudo], state: "on" })) as Written
  expect(switched.changed).toEqual([push, sudo])
  expect(switched.notDone.map((entry) => entry.id)).toEqual(["item:project:alpha:perm:shell:nope"])
  expect(switched.notDone[0]?.reason).toContain("row.unknown")
  expect(switched.status).toStartWith("2 changed, 0 already so, 1 not done (written once")
  const shown = (await runOk(read, { id: [push, sudo] })) as Many
  expect(shown.results.map((result) => result.output?.enabled)).toEqual([true, true])
  // A single id still answers as before.
  expect(await runOk(read, { id: push })).toMatchObject({ enabled: true, patterns: ["git push *"] })

  // find picks the rows: here the two edits alpha holds.
  const undone = (await runOk(reset, { find: { agent: "alpha", type: "rule", is: "changed" } })) as Written
  expect(undone.changed.toSorted()).toEqual([push, sudo].toSorted())
  expect(undone.notDone).toEqual([])
  expect((await snapshotOf(api)).records.some((record) => record.type === "customization" && record.item.startsWith("perm:"))).toBe(false)

  // Without agent, find reaches every agent's copy, the shared Defaults row first.
  const everyone = (await runOk(set, { find: { type: "rule", name: "git-push" }, state: "on" })) as Written
  expect(everyone.notDone).toEqual([])
  expect(everyone.changed[0]).toBe("item:defaults::perm:shell:git-push")
  const copies = rowIds((await runOk(find, { agent: "*", type: "rule", name: "git-push", fields: ["id", "badges"] })) as { rows: readonly string[] })
  const states = (await runOk(read, { id: copies.filter((id) => id.includes(":alpha:") || id.includes(":beta:")) })) as Many
  expect(states.results.length).toBe(2)
  expect(states.results.every((result) => result.output?.enabled === true)).toBe(true)

  // edit takes a list too; verbose adds each row's own answer.
  const shells = rowIds((await runOk(find, { agent: "*", type: "tool", name: "shell" })) as { rows: readonly string[] }).filter((id) => id.includes(":alpha:") || id.includes(":beta:"))
  expect(shells).toHaveLength(2)
  const reworded = (await runOk(edit, { id: shells, oldString: "Run shell.", newString: "Runs one shell command.", verbose: true })) as Written
  expect(reworded.results?.map((result) => result.output?.replacements)).toEqual([1, 1])

  // Exactly one of id and find: the input schema refuses both and neither.
  expect(Exit.isFailure(Schema.decodeUnknownExit(set.input as Schema.Codec<unknown>)({ id: push, find: { agent: "alpha" }, state: "on" }))).toBe(true)
  expect(Exit.isFailure(Schema.decodeUnknownExit(set.input as Schema.Codec<unknown>)({ state: "on" }))).toBe(true)
  expect(Exit.isSuccess(Schema.decodeUnknownExit(set.input as Schema.Codec<unknown>)({ id: [push, sudo], state: "on" }))).toBe(true)
  // delete asks for confirm once, before any row.
  expect((await runFail(remove, { find: { agent: "alpha", type: "rule" } })).message).toContain("delete.unconfirmed")
  // find takes at most 200 rows.
  expect((await runFail(read, { find: {} })).message).toMatch(/^find matches \d+ rows; one call takes at most 200/)
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
  const listed = (await runOk(need(tools, "instructions_find"), { where: "item:perm tool:shell", limit: 200 })) as { rows: readonly string[]; total: number }
  expect(listed.total).toBeGreaterThan(0)
  // Without an agent, the shared Defaults row stands for alpha's identical copy.
  expect(rowIds(listed)).toContain("item:defaults::perm:shell:git-push")
  expect(rowIds(listed)).not.toContain(row.id)
  const alphas = (await runOk(need(tools, "instructions_find"), { agent: "alpha", type: "rule", where: "tool:shell", limit: 200 })) as { rows: readonly string[] }
  expect(rowIds(alphas)).toContain(row.id)
  const shown = (await runOk(need(tools, "instructions_read"), { id: row.id })) as { patterns: string[]; keywords: string[]; scrub: { hidden: number }; message?: string }
  expect(shown.patterns).toEqual(["git push *"])
  expect(shown.keywords).toContain("git push")
  expect("provenance" in shown).toBe(false)
  // A shipped curated rule carries a short refusal message, and show reads it.
  expect(shown.message).toBe("pushing is not allowed here")
  // alpha inherits the rule off, so on is the edit that is stored…
  const toggled = (await runOk(need(tools, "instructions_set"), { id: row.id, state: "on" })) as { status: string }
  expect(toggled.status).toContain("Enabled")
  const afterOn = await snapshotOf(api)
  expect(afterOn.records.some((record) => record.type === "customization" && record.item === "perm:shell:git-push" && record.state === "on")).toBe(true)
  const curatedShownRecord = (await runOk(need(tools, "instructions_read"), { id: row.id, view: "record" })) as {
    record: { type?: string; state?: string } | null
  }
  expect(curatedShownRecord.record?.type).toBe("customization")
  expect(curatedShownRecord.record?.state).toBe("on")
  // …and off again, what it inherits, is an own off until reset.
  expect(((await runOk(need(tools, "instructions_set"), { id: row.id, state: "off" })) as { status: string }).status).toContain("Disabled")
  expect(((await runOk(need(tools, "instructions_read"), { id: row.id, view: "record" })) as { record: { state?: string } | null }).record?.state).toBe("off")
  expect(((await runOk(need(tools, "instructions_reset"), { id: row.id })) as { status: string }).status).toContain("it follows what it inherits again (off")
  expect(((await runOk(need(tools, "instructions_read"), { id: row.id, view: "record" })) as { record: unknown }).record).toBeNull()
  const textError = await runFail(need(tools, "instructions_set"), { id: row.id, text: "nope" })
  expect(textError.message).toContain("cannot be edited")
  const created = (await runOk(need(tools, "instructions_create"), { kind: "rule", tool: "shell", id: "no-push", label: "No pushes", patterns: ["git push --force *"], message: "force pushes are not allowed here" })) as { tool: string; id: string; item: string }
  // A rule with no agent is shared: it lands in the Defaults catalogue and
  // returns that row id, not the project-level default the old code wrote.
  expect(created).toMatchObject({ tool: "shell", id: "item:defaults::perm:shell:no-push", item: "perm:shell:no-push" })
  const afterCreate = await snapshotOf(api)
  const customRow = expandedTree(memoFromSnapshot(afterCreate)).find((node) => node.id === created.id)
  if (customRow === undefined) throw new Error("missing custom perm row")
  const customShownRecord = (await runOk(need(tools, "instructions_read"), { id: customRow.id, view: "record" })) as {
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
  const customBoth = (await runOk(need(tools, "instructions_read"), { id: customRow.id, view: "record" })) as {
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

// T1: the read view of a perm row says when the row is an allow row of its
// category, so a reader sees an `allow.` shell rule as the allow row it is.
test("read shows an allow row as one, and a plain rule without the field", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const allow = (await runOk(need(tools, "instructions_create"), {
    kind: "rule",
    tool: "shell",
    id: "allow.inspect",
    label: "Looking around",
    patterns: ["ls", "ls *"],
    level: "project",
  })) as { id: string }
  const plain = (await runOk(need(tools, "instructions_create"), {
    kind: "rule",
    tool: "shell",
    id: "mine",
    label: "Mine",
    patterns: ["mine *"],
    level: "project",
  })) as { id: string }
  expect(await runOk(need(tools, "instructions_read"), { id: allow.id })).toMatchObject({
    tool: "shell",
    rule: "allow.inspect",
    category: "commands",
    kind: "input",
    allow: true,
    field: "command",
  })
  const plainRow = (await runOk(need(tools, "instructions_read"), { id: plain.id })) as Record<string, unknown>
  expect(plainRow).toMatchObject({ tool: "shell", rule: "mine", category: "commands", kind: "rule" })
  expect("allow" in plainRow).toBe(false)
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
  const shownEdit = (await runOk(need(tools, "instructions_read"), { id: created.id })) as { message?: string }
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
  const shownOverride = (await runOk(need(tools, "instructions_read"), { id: curatedRow.id })) as { message?: string }
  expect(shownOverride.message).toBe("no pushes in this team")

  // The override is on disk in the global store under the Teams catalogue.
  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(globalText).toContain('"id":"git-push"')
  expect(globalText).toContain('"catalogue":"teams"')
})

// instructions_find reads api.snapshot(), so a team member's policy rows reach
// the tool only through the boundary shape. The rows asserted here govern
// permission actions with no tool row to hang under, so they exist nowhere
// else in the tree.
test("instructions_find returns a team member's own policy rows even for a tool with no tool row", async () => {
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
  const listed = (await runOk(need(tools, "instructions_find"), { where: `item:perm agent:${member}`, limit: 1000 })) as {
    rows: readonly string[]
    total: number
  }
  expect(listed.total).toBeGreaterThan(0)
  const ids = rowIds(listed)
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
  expect(betaRow).toBeUndefined()
  const error = await runFail(need(tools, "instructions_delete"), { id: "item:project:alpha:perm:shell:custom", confirm: true })
  expect(error.message).toContain("row.unknown")
  await runFail(need(tools, "instructions_delete"), { id: "item:project:beta:perm:shell:custom", confirm: true })
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

test("rule.remove RPC respects owner identity and protected-owner permissions", async () => {
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
  expect(betaRow).toBeUndefined()
  expect((await api.removeRule({ level: "project", agent: "beta", tool: "shell", id: "custom" })).ok).toBe(false)
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
      { level: "project", agent: "alpha", tool: "shell", id: "custom", actor: { type: "tool" } },
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
      { level: "project", agent: "alpha", tool: "shell", id: "custom" },
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
  expect(betaRow).toBeUndefined()
  const error = await runFail(need(tools, "instructions_set"), { id: "item:project:alpha:perm:shell:custom", label: "Hacked", patterns: ["evil *"] })
  expect(error.message).toContain("row.unknown")
  const after = await snapshotOf(api)
  const kept = after.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "custom")
  if (kept === undefined || kept.type !== "rule") throw new Error("expected rule to survive")
  expect(kept.label).toBe("Custom")
})

test("rule.update RPC protects the addressed owner and lets the TUI write", async () => {
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
  expect(betaRow).toBeUndefined()
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
      { level: "project", agent: "alpha", tool: "shell", id: "custom", label: "Hacked", patterns: ["evil *"], actor: { type: "tool" } },
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
      { level: "project", agent: "alpha", tool: "shell", id: "custom", label: "Hacked", patterns: ["evil *"] },
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

test("updateRule through a project row creates an independent override of a global rule", async () => {
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
  expect(updated.value.level).toBe("project")
  expect(updated.value.agent).toBe("alpha")
  expect(updated.value.label).toBe("Edited")
  const after = await snapshotOf(api)
  const persisted = after.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "shared" && record.level === "project")
  if (persisted === undefined || persisted.type !== "rule") throw new Error("expected shared rule to persist")
  expect(persisted.level).toBe("project")
  expect(persisted.agent).toBe("alpha")
  expect(persisted.label).toBe("Edited")
  expect(persisted.patterns).toEqual(["edited *"])
  const { load } = await import("../src/instructions/store.js")
  const stored = await load(project)
  expect(stored.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "shared" && record.level === "global")).toBe(true)
  expect(stored.records.some((record) => record.type === "rule" && record.tool === "shell" && record.id === "shared" && record.level === "project")).toBe(true)
  expect(stored.records.find((record) => record.type === "rule" && record.id === "shared" && record.level === "global")).toMatchObject({ label: "Original", patterns: ["orig *"] })
  const { globalRecordsPath, projectRecordsPath } = await import("../src/instructions/paths.js")
  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(globalText).toContain(`"id":"shared"`)
  if (await Bun.file(projectRecordsPath(project)).exists()) {
    const projectText = await Bun.file(projectRecordsPath(project)).text()
    expect(projectText).toContain(`"id":"shared"`)
  }
  const logged = await api.log({ where: "op:rule.update" })
  if (!logged.ok) throw new Error("log failed")
  const entry = logged.value.entries.find((candidate) => candidate.op === "rule.update" && candidate.target === "rule:project:alpha:shell:shared")
  if (entry === undefined) throw new Error("missing project rule.update log entry")
})

test("concurrent same-id rule creation across owners persists independently and deletion preserves its peer", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({ directory: project, agents: [agentInfo("alpha", "role"), agentInfo("beta", "role")], tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }], session: { hook: () => Effect.succeed({ dispose: Effect.void }) } })
  const api = createPlusApi(ctx, createState())
  const created = await Promise.all(["alpha", "beta"].map((agent) => api.addRule({ level: "project", agent, tool: "shell", id: "independent", label: agent, patterns: [`${agent} *`], actor: { type: "tui" } })))
  expect(created.every((result) => result.ok)).toBe(true)
  expect((await snapshotOf(api)).records.filter((record) => record.type === "rule" && record.id === "independent")).toHaveLength(2)
  expect((await api.removeRule({ level: "project", agent: "alpha", tool: "shell", id: "independent" })).ok).toBe(true)
  expect((await snapshotOf(api)).records.filter((record) => record.type === "rule" && record.id === "independent")).toEqual([expect.objectContaining({ agent: "beta", patterns: ["beta *"] })])
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

test("updateRule creates an owner override without changing the shared default", async () => {
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
  // An agent edit materializes its own definition; shared defaults stay intact.
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
  expect(updated.value.level).toBe("project")
  expect(updated.value.agent).toBe("alpha")
  expect(updated.value.label).toBe("Shared edited")
  const after = await snapshotOf(api)
  const persisted = after.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "shared" && record.agent === "alpha")
  if (persisted === undefined || persisted.type !== "rule") throw new Error("expected shared rule to persist")
  expect(persisted.level).toBe("project")
  expect(persisted.agent).toBe("alpha")
  expect(persisted.label).toBe("Shared edited")
  expect(after.records.find((record) => record.type === "rule" && record.id === "shared" && record.agent === null)).toMatchObject({ label: "Shared", patterns: ["shared *"] })
  const logged = await api.log({ where: "op:rule.update" })
  if (!logged.ok) throw new Error("log failed")
  const updateEntry = logged.value.entries.find(
    (candidate) => candidate.op === "rule.update" && candidate.target === "rule:project:alpha:shell:shared",
  )
  if (updateEntry === undefined) throw new Error("missing shared rule.update log entry at the shared address")
})

test("instructions_set on a team-special row persists team-scoped record", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [
      agentInfo("alpha", "upstream alpha"),
      agentInfo("title", "upstream title"),
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

  const rowId = "item:project:crew/:special:title:tool:bash"
  const setResult = (await runOk(need(tools, "instructions_set"), {
    id: rowId,
    state: "off",
  })) as { status: string }
  expect(setResult.status).toBe('Disabled "bash"')

  const snap = await snapshotOf(api)
  const custom = snap.records.find((r) => r.type === "customization" && r.agent === "title" && r.item === "tool:bash")
  expect(custom).toBeDefined()
  expect(custom?.type).toBe("customization")
  if (custom?.type === "customization") {
    expect(custom.state).toBe("off")
    expect(custom.team).toEqual({ level: "project", team: "crew" })
  }
})

// ---------------------------------------------------------------------------
// Round-3 evidence capture: labeled stdout of the values these flows really
// return (the round-3 capture doc is in Git history). No assertion reads it and
// no behavior depends on it. The only normalized text is the disposable mkdtemp
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
    // Core always registers the skill tool; created skills are listed under it.
    tools: [
      { id: "shell", description: "Run shell.", options: { codemode: false } },
      { id: "skill", description: "Load a skill", options: { codemode: false } },
    ],
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
  const show = need(tools, "instructions_read")
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
    /** Reset the active flag before deleting (create makes a model active). */
    readonly resetFirst?: boolean
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
      status: 'Removed "acme/nova-2"',
      show: { expect: { view: "resolved" } },
      gone: true,
      // Create activates the model; reset clears the active flag so the row
      // is no longer the effective model and deletes.
      resetFirst: true,
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
    if (step.resetFirst === true) await runOk(need(tools, "instructions_reset"), { id: step.id })
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
  const show = need(tools, "instructions_read")
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
    // Create activates a model, so clear its active flag before deleting it.
    if (id.includes(":model:")) await runOk(need(tools, "instructions_reset"), { id })
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
  const show = need(tools, "instructions_read")
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
    preset: "basic/implementer",
  })) as { id: string; item: string }
  expect(member.id).toBe("team:project:crew:one:nested/beta")
  expect(member.item).toBe("nested/beta")
  const memberPath = path.join(projectTeamsPath(project), "crew:one", "nested", "beta.md")
  // "<team>/<member>" names a member preset: its mode and description, an empty body.
  expect(await Bun.file(memberPath).text()).toContain("mode: primary")
  round3Capture(
    "member flow: create project member (padded colon team, nested member id)",
    {
      request: { kind: "member", team: " crew:one ", level: "project", id: "nested/beta", preset: "basic/implementer" },
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
  // The row already resolves off: the set stores off as its own value (the
  // owner's decision, 2026-10-31), so it is a write and has no "no change" note.
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
    preset: "basic/planner",
  })) as { id: string; item: string }
  expect(created.id).toBe("team:project:crew:fielded")
  expect(created.item).toBe("fielded")
  expect(forwarded).toHaveLength(1)
  expect(forwarded[0]).toMatchObject({
    level: "project",
    team: "crew",
    id: "fielded",
    preset: { kind: "member", team: "basic", id: "planner" },
    actor: { type: "tool" },
  })
  expect(await Bun.file(path.join(projectTeamsPath(project), "crew", "fielded.md")).text()).toBe(
    formatMarkdown({ mode: "primary", description: "Turns goals into exact task plans with paths and checks" }, ""),
  )
  const unknown = await runFail(create, { kind: "member", team: "crew", level: "project", id: "other", preset: "ghost" })
  expect(unknown.message).toContain("preset.invalid")
  round3Capture("member flow: preset forwarded to team.addAgent", { output: created, forwarded: forwarded[0] }, project)
})

// DESIGN §5: `template` names a team preset (here the Plus `basic` preset),
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
  const show = need(tools, "instructions_read")

  const memberIds = ["build-seat", "implementer", "orchestrator", "planner", "reviewer", "scout"]
  const created = (await runOk(create, { kind: "team", team: "mine", level: "project", preset: "basic" })) as {
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
    members: memberIds,
  })
  const snapshot = await snapshotOf(api)
  expect(snapshot.teams?.find((team) => team.team === "mine")).toEqual({
    level: "project",
    team: "mine",
    enabled: false,
    agents: memberIds,
  })
  const rows = expandedTree(memoFromSnapshot(snapshot))
  expect(rows.some((node) => node.id === "team:project:mine:planner")).toBe(true)
  expect(rows.some((node) => node.id === "team:project:mine:reviewer")).toBe(true)
  round3Capture(
    "team template: create kind team with template",
    {
      request: { kind: "team", team: "mine", level: "project", preset: "basic" },
      output: created,
      show: shownTeam,
      snapshotTeam: snapshot.teams?.find((team) => team.team === "mine"),
      memberRows: rows.filter((node) => node.id.startsWith("team:project:mine")).map((node) => node.id),
    },
    project,
  )
  // The same handler the TUI's team.create calls wrote the member files.
  const teamDir = path.join(projectTeamsPath(project), "mine")
  const preset = plusTeamPresets.find((team) => team.id === "basic")
  const plannerMember = preset?.members.find((member) => member.id === "planner")
  const reviewerMember = preset?.members.find((member) => member.id === "reviewer")
  if (plannerMember === undefined || reviewerMember === undefined) throw new Error("missing preset members")
  const plannerText = await Bun.file(path.join(teamDir, "planner.md")).text()
  expect(plannerText).toBe(formatMarkdown({ mode: "primary", description: plannerMember.description }, ""))
  expect(await Bun.file(path.join(teamDir, "reviewer.md")).text()).toBe(
    formatMarkdown({ mode: "primary", description: reviewerMember.description }, ""),
  )
  expect(snapshot.links?.map((link) => [link.agent, link.preset])).toEqual(
    expect.arrayContaining([
      [null, { kind: "team", id: "basic" }],
      ["planner", { kind: "member", team: "basic", id: "planner" }],
      ["reviewer", { kind: "member", team: "basic", id: "reviewer" }],
    ]),
  )
  round3Capture(
    "team template: member files written",
    {
      plannerFile: { path: path.join(teamDir, "planner.md"), text: plannerText },
      reviewerFile: { path: path.join(teamDir, "reviewer.md"), text: await Bun.file(path.join(teamDir, "reviewer.md")).text() },
    },
    project,
  )
})

test("create kind instruction is refused with instruction.disabled and writes nothing", async () => {
  const { project, tools } = await freshFixture()
  const error = await runFail(need(tools, "instructions_create"), { kind: "instruction", name: "AGENTS.md", text: "guide" })
  expect(error.message).toContain("instruction.disabled")
  expect(error.message).toContain("System › AGENTS.md files")
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
  const show = need(tools, "instructions_read")

  const agent = (await runOk(create, { kind: "agent", id: "helper", preset: "basic/implementer" })) as { id: string; item: string }
  expect(agent).toMatchObject({ id: "agent:project:helper", item: "helper" })
  expect((await snapshotOf(api)).links).toEqual([
    expect.objectContaining({ level: "project", agent: "helper", preset: { kind: "member", team: "basic", id: "implementer" } }),
  ])
  expect((await runFail(create, { kind: "agent", id: "ghostly", preset: "no-such-preset" })).message).toContain("preset.invalid")

  const entry = (await runOk(create, { kind: "entry", catalogue: "agents", name: "*orchestrator*", preset: "basic/orchestrator" })) as {
    id: string
    item: string
  }
  expect(entry).toMatchObject({ id: "agent:defaults:*orchestrator*", item: "*orchestrator*" })
  const teamEntry = (await runOk(create, { kind: "entry", catalogue: "teams", team: "crew*", name: "*impl*" })) as { id: string }
  expect(teamEntry.id).toBe("team:defaults:crew*:*impl*")
  expect((await runFail(create, { kind: "entry", catalogue: "agents", name: "*orchestrator*" })).message).toContain("entry.exists")

  const preset = (await runOk(create, { kind: "preset", id: "mine", from: "basic/planner" })) as { id: string; item: string }
  expect(preset).toMatchObject({ id: "agent:preset:mine", item: "mine" })
  expect(await runOk(show, { id: preset.id })).toMatchObject({
    kind: "preset",
    preset: { kind: "agent", id: "mine" },
    origin: "user",
    link: { kind: "member", team: "basic", id: "planner" },
  })
  const team = (await runOk(create, { kind: "teamPreset", id: "crew", from: "basic" })) as { id: string }
  expect(team.id).toBe("team:preset:crew")
  const member = (await runOk(create, { kind: "presetMember", team: "crew", id: "lead", from: "mine" })) as { id: string }
  expect(member.id).toBe("team:preset:crew:lead")
  expect((await runFail(create, { kind: "presetMember", team: "basic", id: "x" })).message).toContain("preset.readonly")
  expect((await runFail(create, { kind: "teamPreset", id: "other", from: "basic/planner" })).message).toContain("preset.invalid")
  const presets = (await snapshotOf(api)).presets?.map((record) => [record.kind, record.team ?? "", record.id]) ?? []
  expect(presets.toSorted()).toEqual(
    [
      ["agent", "", "mine"],
      ["agent", "crew", "build-seat"],
      ["agent", "crew", "implementer"],
      ["agent", "crew", "lead"],
      ["agent", "crew", "orchestrator"],
      ["agent", "crew", "planner"],
      ["agent", "crew", "reviewer"],
      ["agent", "crew", "scout"],
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
  const linked = (await runOk(set, { id: "agent:project:helper", preset: "basic/orchestrator" })) as { preset: unknown; status: string }
  expect(linked).toMatchObject({
    preset: { kind: "member", team: "basic", id: "orchestrator" },
    status: 'Linked "helper" to member:basic/orchestrator',
  })
  // The row now inherits from the preset. Its Description row repeats it, so
  // list leaves that out.
  const rows = (await runOk(need(tools, "instructions_find"), { where: "id:item:project:helper:tool:reader", fields: ["id", "from"] })) as {
    rows: string[]
  }
  expect(rows.rows).toEqual(["item:project:helper:tool:reader | from preset Basic › orchestrator"])
  const alias = (await runOk(need(tools, "instructions_find"), { where: "id:item:project:helper:tool:reader:description", fields: ["from"] })) as { rows: string[] }
  expect(alias.rows).toEqual(["item:project:helper:tool:reader:description | from preset Basic › orchestrator"])
  await runOk(set, { id: "agent:project:helper", preset: { kind: "member", team: "basic", id: "implementer" } })
  expect((await snapshotOf(api)).links).toEqual([
    expect.objectContaining({ agent: "helper", preset: { kind: "member", team: "basic", id: "implementer" } }),
  ])
  const unlinked = (await runOk(set, { id: "agent:project:helper", preset: null })) as { preset: unknown }
  expect(unlinked.preset).toBeNull()
  expect((await snapshotOf(api)).links).toEqual([])
  expect((await runFail(set, { id: "agent:project:helper", preset: "no-such-preset" })).message).toContain("preset.invalid")
  expect((await runFail(set, { id: "group:project:agents", preset: "basic/planner" })).message).toContain("link.invalid")
  expect((await runFail(set, { id: "agent:preset:build", preset: "basic/planner" })).message).toContain("preset.readonly")

  // A protected agent's link stays out of a tool's reach; a preset of that name does not.
  await api.createAgent({ scope: "project", id: "guarded" })
  expect((await runFail(set, { id: "agent:project:guarded", preset: "basic/planner" })).message).toContain("agent.protected")
  await runOk(create, { kind: "preset", id: "mine" })
  await runOk(set, { id: "agent:preset:mine", preset: "basic/scout" })
  expect((await snapshotOf(api)).links).toEqual([
    expect.objectContaining({ level: "preset", agent: "mine", preset: { kind: "member", team: "basic", id: "scout" } }),
  ])

  // A team relink relinks the members the team preset has, and says which.
  await runOk(create, { kind: "teamPreset", id: "crewset", from: "basic" })
  await runOk(create, { kind: "team", team: "crew", level: "project", preset: "basic" })
  const team = (await runOk(set, { id: "team:project:crew", preset: "crewset" })) as { members: unknown; status: string }
  expect(team).toMatchObject({
    members: [
      { agent: "build-seat", preset: { kind: "member", team: "crewset", id: "build-seat" } },
      { agent: "implementer", preset: { kind: "member", team: "crewset", id: "implementer" } },
      { agent: "orchestrator", preset: { kind: "member", team: "crewset", id: "orchestrator" } },
      { agent: "planner", preset: { kind: "member", team: "crewset", id: "planner" } },
      { agent: "reviewer", preset: { kind: "member", team: "crewset", id: "reviewer" } },
      { agent: "scout", preset: { kind: "member", team: "crewset", id: "scout" } },
    ],
    status: 'Linked "crew" to team:crewset; relinked build-seat, implementer, orchestrator, planner, reviewer, scout',
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
  expect((await runFail(del, { id: "agent:preset:build", confirm: true })).message).toContain("read-only")
  await runOk(need(tools, "instructions_set"), { id: "agent:project:user1", preset: null })
  expect(await runOk(del, { id: "agent:preset:mine", confirm: true })).toMatchObject({ ref: { kind: "agent", id: "mine" } })
  expect((await snapshotOf(api)).presets).toEqual([])
})

// The store the bug left behind: a user team preset whose global team
// directory is gone, with its team and member links still in the global
// store. Those links' owners no longer exist, so they must not refuse the
// delete; the delete removes them in the same revision and says so in the
// log. A live owner (an existing agent linked at the project level) still
// refuses with preset.inUse — the refusal control.
test("instructions_delete removes orphan links with the preset and still refuses live users", async () => {
  const { api, tools, project } = await freshFixture()
  const create = need(tools, "instructions_create")
  const del = need(tools, "instructions_delete")
  const set = need(tools, "instructions_set")
  await runOk(create, { kind: "teamPreset", id: "field-audit-26" })
  await runOk(create, { kind: "presetMember", team: "field-audit-26", id: "fa26-lead" })
  const stored = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [
      ...stored.records,
      {
        type: "link",
        level: "global",
        agent: null,
        team: { level: "global", team: "field-audit-26" },
        preset: { kind: "team", id: "field-audit-26" },
        updated: "2026-09-26T13:36:59.651Z",
      },
      {
        type: "link",
        level: "global",
        agent: "fa26-lead",
        team: { level: "global", team: "field-audit-26" },
        preset: { kind: "member", team: "field-audit-26", id: "fa26-lead" },
        updated: "2026-09-26T13:36:59.651Z",
      },
    ],
  })
  expect(saved.ok).toBe(true)

  // Refusal control: an existing agent linked at the project level refuses.
  await runOk(create, { kind: "agent", id: "watcher" })
  await runOk(set, { id: "agent:project:watcher", preset: "field-audit-26/fa26-lead" })
  const inUse = await runFail(del, { id: "team:preset:field-audit-26", confirm: true, force: true })
  expect(inUse.message).toContain("preset.inUse")
  expect(inUse.message).toContain("agent:project:watcher")
  expect(inUse.message).not.toContain("team:global:field-audit-26")

  // The live link goes; only the orphans are left, and they no longer block.
  await runOk(set, { id: "agent:project:watcher", preset: null })
  const deleted = await runOk(del, { id: "team:preset:field-audit-26", confirm: true, force: true })
  expect(deleted).toMatchObject({ id: "team:preset:field-audit-26", ref: { kind: "team", id: "field-audit-26" } })
  const after = await snapshotOf(api)
  expect(after.presets).toEqual([])
  expect(after.links).toEqual([])
  const log = (await runOk(need(tools, "instructions_log"), {})) as { entries: { op: string; summary: string }[] }
  expect(log.entries.find((entry) => entry.op === "preset.delete")?.summary).toContain("removed 2 orphaned links")
})

// C: the instructions tool's delete walks the same content as the TUI's `d`:
// a local record is deleted, an inherited or upstream row is hidden at this
// level with a tombstone, and the effective model refuses.
test("delete hides an inherited model row at this level, re-adding clears it, and the effective model refuses", async () => {
  const { api, tools, project } = await freshFixture({
    agents: [agentInfo("build", "upstream role", modelRef("acme", "base"))],
    models: [modelInfo("acme", "base"), modelInfo("acme", "opus"), modelInfo("acme", "alt")],
    classifications: { "": "general", "base": "general", "opus": "general", "alt": "general" },
  })
  const create = need(tools, "instructions_create")
  const del = need(tools, "instructions_delete")
  const set = need(tools, "instructions_set")
  const rowOf = async (id: string) => expandedTree(memoInputOf(await snapshotOf(api))).find((node) => node.id === id)

  const created = (await runOk(create, { kind: "model", providerID: "acme", modelID: "opus", level: "global", agent: "build" })) as { id: string }
  expect(created.id).toBe("item:global:build:model:acme/opus")
  const projectRow = "item:project:build:model:acme/opus"
  expect(await rowOf(projectRow)).toBeDefined()
  // The Global add is active, so opus is the effective model at Project: its
  // row refuses deletion until another model is activated.
  const refused = await runFail(del, { id: projectRow, confirm: true })
  expect(refused.message).toBe('"acme/opus" is the active model here: activate another model first')
  // Activating another model at Project makes the inherited opus row deletable.
  await runOk(create, { kind: "model", providerID: "acme", modelID: "alt", level: "project", agent: "build" })
  const hidden = (await runOk(del, { id: projectRow, confirm: true })) as { status: string }
  expect(hidden.status).toBe('Hidden "acme/opus" at this level')
  expect(await rowOf(projectRow)).toBeUndefined()
  expect(await rowOf(created.id)).toBeDefined()
  const stored = (await load(project)).records.find(
    (record) => record.type === "model" && record.level === "project" && record.modelID === "opus",
  )
  expect(stored).toMatchObject({ removed: true, agent: "build" })

  // Re-adding at Project clears the tombstone and activates it exclusively.
  await runOk(create, { kind: "model", providerID: "acme", modelID: "opus", level: "project", agent: "build" })
  expect(await rowOf(projectRow)).toBeDefined()
  expect(
    (await load(project)).records.some((record) => record.type === "model" && record.level === "project" && record.modelID === "opus" && record.removed === true),
  ).toBe(false)

  // Activating another model makes the upstream row deletable: it is hidden at
  // Project while the Global view (which does not resolve through Project)
  // still lists the host fallback.
  const upstream = "item:project:build:model:acme/base"
  await runOk(set, { id: "item:project:build:model:acme/alt", active: true })
  const hiddenUpstream = (await runOk(del, { id: upstream, confirm: true })) as { status: string }
  expect(hiddenUpstream.status).toBe('Hidden "acme/base" at this level')
  expect(await rowOf("item:project:build:model:acme/base")).toBeUndefined()
  expect(await rowOf("item:global:build:model:acme/base")).toBeDefined()
})

// Instructions that follow capabilities reach an agent through show too: a
// Tools and rules section says which row it depends on, and a tool row names
// the Tools and rules sections that come with it.
test("show reports a section's requires line and a tool's Tools and rules sections", async () => {
  const { api, tools } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  await addToolsAndRules(tools)
  const nodes = expandedTree(memoFromSnapshot(await snapshotOf(api)))
  const section = nodes.find(
    (node) => node.kind === "section" && node.address?.item === "system:tools-and-rules" && node.address.agent === "alpha" && node.label === "Questions",
  )
  const tool = nodes.find((node) => node.kind === "item" && node.address?.item === "tool:question" && node.address.agent === "alpha")
  if (section === undefined || tool === undefined) throw new Error("missing rows")
  const shownSection = (await runOk(need(tools, "instructions_read"), { id: section.id })) as { requires?: unknown }
  // met follows alpha's own state of the question tool.
  expect(shownSection.requires).toEqual([{ id: "tool:question", on: true, met: tool.badges.state === "on" }])
  const shownTool = (await runOk(need(tools, "instructions_read"), { id: tool.id })) as { guidance?: unknown }
  expect(shownTool.guidance).toEqual(["Questions"])
})

// find({ is: "held-back" }): sections that are on but whose "shown when" the
// agent does not meet, each with what it needs.
test("find is held-back lists what an agent's shown when keeps from it", async () => {
  const { tools } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  await addToolsAndRules(tools)
  const find = need(tools, "instructions_find")
  const heldBack = async () => ((await runOk(find, { agent: "alpha", is: "held-back", limit: 100 })) as { rows: string[] }).rows
  // The Tools and rules row is off by default for alpha: nothing in it is held back.
  expect(await heldBack()).toEqual([])
  await runOk(need(tools, "instructions_set"), { id: "item:defaults:alpha:system:tools-and-rules", state: "on" })
  const rows = await heldBack()
  // No code search tool here: its section is held back, and says what it needs.
  expect(rows.find((row) => row.includes(":tools-and-rules/code-search |"))).toContain("held back (needs tool:web_exa_code_search on)")
  // Questions waits for the question tool; switching it on sends it.
  expect(rows.find((row) => row.includes(":tools-and-rules/questions |"))).toContain("held back (needs tool:question on)")
  await runOk(need(tools, "instructions_set"), { id: "item:defaults:alpha:tool:question", state: "on" })
  expect((await heldBack()).some((row) => row.includes(":tools-and-rules/questions |"))).toBe(false)
  expect((await runFail(find, { is: "hidden" })).message).toContain("overruled")
})

// "Shown when" through the tool: set takes requires (null drops it), show
// reports the condition and where it comes from, and a typo is refused.
test("set requires changes when a section is sent; show reports it and its source", async () => {
  const { api, tools } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  await addToolsAndRules(tools)
  const nodes = expandedTree(memoFromSnapshot(await snapshotOf(api)))
  // alpha's own row (alpha is a Defaults entry in this fixture).
  const section = nodes.find((node) => node.id.startsWith("section:defaults:alpha:system:tools-and-rules:") && node.label === "Questions")
  if (section === undefined) throw new Error(`missing Questions: ${nodes.filter((node) => node.label === "Questions").map((node) => node.id).join(", ")}`)
  const show = need(tools, "instructions_read")
  const set = need(tools, "instructions_set")
  expect(((await runOk(show, { id: section.id })) as { requiresFrom?: string }).requiresFrom).toBe("its text")
  const saved = (await runOk(set, { id: section.id, requires: ["tool:reader"] })) as { status: string }
  expect(saved.status).toBe('"Questions" is sent when tool:reader on')
  const shown = (await runOk(show, { id: section.id })) as { requires?: { id: string; on: boolean }[]; requiresFrom?: string; requiresHere?: boolean }
  expect(shown.requires?.map(({ id, on }) => ({ id, on }))).toEqual([{ id: "tool:reader", on: true }])
  expect(shown.requiresHere).toBe(true)
  expect(shown.requiresFrom).not.toBe("its text")
  expect((await runFail(set, { id: section.id, requires: ["tool:readr"] })).message).toContain('no row "tool:readr" exists; did you mean tool:reader')
  await runOk(set, { id: section.id, requires: null })
  expect(((await runOk(show, { id: section.id })) as { requiresFrom?: string }).requiresFrom).toBe("its text")
})

// ── row links (S2a B9–B12): the production instructions_link tool ─────────
//
// The tool's contract: no target inspects outgoing/incoming links; target
// upserts, type defaults either, enabled:false masks. Both ends must be in the
// same level/owner view; a refusal writes no record and no log line.

async function rowIdOf(api: PlusApi, item: string): Promise<string> {
  const snapshot = await snapshotOf(api)
  const node = expandedTree(memoFromSnapshot(snapshot)).find((candidate) => candidate.address?.item === item)
  if (node === undefined) throw new Error(`missing row ${item}`)
  return node.id
}

async function linksOf(project: string) {
  return (await load(project)).records.filter((record) => record.type === "rowlink")
}

test("instructions_link upserts, inspects both directions, and masks with enabled:false", async () => {
  const { api, tools, project } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  const link = need(tools, "instructions_link")
  const reader = await rowIdOf(api, "tool:reader")
  const question = await rowIdOf(api, "tool:question")
  const created = (await runOk(link, { id: reader, target: question })) as { type: string; enabled: boolean; status: string }
  expect(created.type).toBe("either")
  expect(created.enabled).toBe(true)
  expect(created.status).toContain("either")
  // Stored as one rowlink record, no second representation.
  const stored = await linksOf(project)
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({ item: "tool:reader", target: "tool:question", link: "either" })
  // Inspect from the primary: outgoing. From the connected end: incoming.
  const outgoing = (await runOk(link, { id: reader })) as { links: { direction: string; target: string }[] }
  expect(outgoing.links.map(({ direction, target }) => ({ direction, target }))).toEqual([
    { direction: "outgoing", target: "tool:question" },
  ])
  const incoming = (await runOk(link, { id: question })) as { links: { direction: string; item: string }[] }
  expect(incoming.links.map(({ direction, item }) => ({ direction, item }))).toEqual([
    { direction: "incoming", item: "tool:reader" },
  ])
  // A second upsert on the same pair replaces it (still one record) and takes the new type.
  await runOk(link, { id: reader, target: question, type: "shownWhenOff" })
  const replaced = await linksOf(project)
  expect(replaced).toHaveLength(1)
  expect(replaced[0]?.link).toBe("shownWhenOff")
  // enabled:false stores a tombstone that still inspects, marked disabled.
  await runOk(link, { id: reader, target: question, enabled: false })
  const masked = (await runOk(link, { id: reader })) as { links: { enabled: boolean }[] }
  expect(masked.links).toHaveLength(1)
  expect(masked.links[0]?.enabled).toBe(false)
  expect((await linksOf(project))[0]?.enabled).toBe(false)
  // An unrelated set write must carry the rowlink over, not drop it (the
  // memo's rowlinks ride along in the delta).
  await runOk(need(tools, "instructions_set"), { id: reader, state: "off" })
  expect(await linksOf(project)).toHaveLength(1)
})

test("instructions_link refuses a self, unknown or cross-level link without writing or logging", async () => {
  const { api, tools, project } = await freshFixture({
    agents: [agentInfo("alpha", "role"), agentInfo("beta", "role")],
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  const link = need(tools, "instructions_link")
  const reader = await rowIdOf(api, "tool:reader")
  const nodes = expandedTree(memoFromSnapshot(await snapshotOf(api)))
  // A different owner at the same level, and a different level entirely.
  const otherOwner = nodes.find((node) => node.address?.item === "tool:reader" && node.address.agent === "beta")
  const otherLevel = nodes.find((node) => node.address?.item === "tool:reader" && node.address.level === "preset")
  const before = await snapshotOf(api)
  const beforeLog = await Bun.file(projectLogPath(project)).exists()
  expect((await runFail(link, { id: reader, target: reader })).message).toContain("cannot link to itself")
  expect((await runFail(link, { id: reader, target: "item:defaults:alpha:tool:missing" })).message).toContain("row.unknown")
  if (otherOwner === undefined || otherLevel === undefined) throw new Error("fixture lacks a mixed owner or level row")
  expect((await runFail(link, { id: reader, target: otherOwner.id })).message).toContain("not in the same level and owner")
  expect((await runFail(link, { id: reader, target: otherLevel.id })).message).toContain("not in the same level and owner")
  // Nothing was written and no change-log line appeared.
  expect((await snapshotOf(api)).records).toEqual(before.records)
  expect(await Bun.file(projectLogPath(project)).exists()).toBe(beforeLog)
})

test("instructions_link refuses a protected agent's row before any write", async () => {
  const { project } = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fixtureContext(project, {
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const link = need(tools, "instructions_link")
  const reader = await rowIdOf(api, "tool:reader")
  const question = await rowIdOf(api, "tool:question")
  expect((await runFail(link, { id: reader, target: question })).message).toContain("agent.protected")
  expect(await linksOf(project)).toEqual([])
})

// ── write-time switches (B9, B10): the production set/toggle path ─────────
//
// `instructions_set state:"on"` (and a bare-id toggle) must write the linked
// row off in the same save, through the real registered tool and a private
// store, so the behaviour survives reload. Turning the row off writes nothing
// linked; one hop only; a tombstone masks an inherited switch.

async function customizationState(project: string, item: string): Promise<"on" | "off" | undefined> {
  const record = (await load(project)).records.find(
    (entry): entry is Extract<(typeof entry), { type: "customization" }> =>
      entry.type === "customization" && entry.item === item && entry.section === null,
  )
  return record?.state
}

// What a row resolves to after a fresh read: a switch equal to what the row
// inherits stores no record, so the row, not the store, says whether it is on.
async function rowState(api: PlusApi, id: string): Promise<"on" | "off" | undefined> {
  return expandedTree(memoInputOf(await snapshotOf(api))).find((node) => node.id === id)?.badges.state
}

test("model rowlinks either: activation and state:on persist physical records in one save", async () => {
    const { api, tools, project } = await freshFixture({ models: [modelInfo("acme", "nova-2"), modelInfo("acme", "nova-3")], classifications: { "nova-2": "general", "nova-3": "general" } })
    const set = need(tools, "instructions_set")
    await runOk(need(tools, "instructions_create"), { kind: "model", providerID: "acme", modelID: "nova-2", level: "defaults", agent: "alpha" })
    await runOk(need(tools, "instructions_create"), { kind: "model", providerID: "acme", modelID: "nova-3", level: "defaults", agent: "alpha" })
    const model = "item:defaults:alpha:model:acme/nova-2"
    const reader = "item:defaults:alpha:tool:reader"
    await runOk(set, { id: model, warming: "on", interval: "15m", prompt: "keep alive" })
    await runOk(set, { id: model, compactWarm: "on", compactionInstructions: "retain C1" })
    await runOk(set, { id: reader, state: "on" })
    await runOk(need(tools, "instructions_link"), { id: model, target: reader, type: "either" })
    const before = await load(project)
    // The exact operation used by TUI Space, not an alternate switch algebra.
    const equivalent = activateModelRow(memoFromSnapshot(await snapshotOf(api)), model)
    if ("refusal" in equivalent) throw new Error(equivalent.refusal)
    expect(equivalent.records?.find((record) => record.item === "tool:reader")?.state).toBe("off")
    await runOk(set, { id: model, active: true })
    const activated = await load(project)
    expect(activated.projectRevision + activated.globalRevision).toBe(before.projectRevision + before.globalRevision + 1)
    expect(activated.records.find((record) => record.type === "model" && record.modelID === "nova-2")).toMatchObject({ active: true })
    expect(await rowState(api, reader)).toBe("off")
    expect((await runFail(set, { id: model, state: "off" })).message).toContain("cannot be toggled off by state")
    expect(await load(project)).toEqual(activated)
    // Explicitly turning the target back on disables the active model.
    const reverseEquivalent = toggle(memoInputOf(await snapshotOf(api)), reader)
    if ("refusal" in reverseEquivalent) throw new Error(reverseEquivalent.refusal)
    expect(reverseEquivalent.models?.find((record) => record.modelID === "nova-2")).toMatchObject({ active: false, prompt: "keep alive", compactionInstructions: "retain C1", compactWarm: "on" })
    await runOk(set, { id: reader, state: "on" })
    const reversed = await load(project)
    expect(reversed.records.find((record) => record.type === "model" && record.modelID === "nova-2")).toMatchObject({ active: false, prompt: "keep alive", compactionInstructions: "retain C1", compactWarm: "on" })
      const snapshot = await snapshotOf(api)
      const retained = expandedTree(memoInputOf(snapshot)).find((node) => node.id === model)
      expect(retained).toBeDefined()
      expect(retained?.badges.active).not.toBe(true)
      const space = activateModelRow(memoInputOf(snapshot), model)
      if ("refusal" in space) throw new Error(space.refusal)
      expect(space.models.find((record) => record.modelID === "nova-2")).toMatchObject({ active: true, prompt: "keep alive", compactionInstructions: "retain C1" })
      const prior = await load(project)
      await runOk(set, { id: model, state: "on" })
      const after = await load(project)
      expect(after.projectRevision + after.globalRevision).toBe(prior.projectRevision + prior.globalRevision + 1)
      expect(await rowState(api, reader)).toBe("off")
      expect(after.records.find((record) => record.type === "model" && record.modelID === "nova-2")).toMatchObject({ active: true })
})

test("model rowlinks inherit, mask, stay one-hop and refuse protected writes atomically", async () => {
  const { api, tools, project } = await freshFixture({
    agents: [agentInfo("build", "role", modelRef("acme", "base"))],
    models: [modelInfo("acme", "base"), modelInfo("acme", "alt")],
    classifications: { base: "general", alt: "general" },
    tools: [{ id: "reader", description: "reader", options: { codemode: false } }, { id: "extra", description: "extra", options: { codemode: false } }],
  })
  const set = need(tools, "instructions_set")
  const link = need(tools, "instructions_link")
  const create = need(tools, "instructions_create")
  await runOk(create, { kind: "model", providerID: "acme", modelID: "alt", level: "global", agent: "build" })
  const globalModel = "item:global:build:model:acme/alt"
  const model = "item:project:build:model:acme/alt"
  const reader = "item:project:build:tool:reader"
  const extra = "item:project:build:tool:extra"
  await runOk(link, { id: globalModel, target: "item:global:build:tool:reader", type: "either" })
  await runOk(link, { id: reader, target: extra, type: "either" })
  await runOk(set, { id: reader, state: "off" })
  // The inherited either switches alt off when reader turns on at Project.
  await runOk(set, { id: reader, state: "on" })
  expect((await load(project)).records.find((record) => record.type === "model" && record.level === "project" && record.modelID === "alt")).toMatchObject({ active: false })
  expect(expandedTree(memoInputOf(await snapshotOf(api))).find((node) => node.id === model)?.badges.active).not.toBe(true)
  await runOk(set, { id: "item:project:build:model:acme/base", state: "on" })
  await runOk(set, { id: extra, state: "on" })
  await runOk(set, { id: model, state: "on" })
  expect(await rowState(api, reader)).toBe("off")
  expect(await rowState(api, extra)).toBe("on")
  await runOk(set, { id: model, state: "on" })
  expect(await rowState(api, reader)).toBe("off")
  // Tombstone only this level's relationship; the Global link survives.
  await runOk(link, { id: model, target: reader, type: "either", enabled: false })
  await runOk(set, { id: reader, state: "on" })
  await runOk(set, { id: "item:project:build:model:acme/base", state: "on" })
  await runOk(set, { id: model, state: "on" })
  expect(await rowState(api, reader)).toBe("on")
  await runOk(link, { id: model, target: reader, type: "either" })
  await runOk(set, { id: "item:project:build:model:acme/base", state: "on" })
  const switchMemo = memoInputOf(await snapshotOf(api))
  const unsupported = activateModelRow({ ...switchMemo, rowlinks: [...(switchMemo.rowlinks ?? []), {
    type: "rowlink", level: "project", agent: "build", item: "model:acme/alt", section: null,
    target: "setting:description", targetSection: null, link: "either", updated: "2026-01-01T00:00:00.000Z",
  }] }, model)
  expect(unsupported).toMatchObject({ refusal: 'Linked row "setting:description" has no switch state' })
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["build"] }))
  const before = await load(project)
  expect((await runFail(set, { id: model, state: "on" })).message).toContain("agent.protected")
  expect(await load(project)).toEqual(before)
})

test("model rowlinks create and chat pick compose switches; linked replacement refuses atomically", async () => {
  const { api, tools, project } = await freshFixture({
    agents: [agentInfo("build", "role", modelRef("acme", "base"))],
    models: [modelInfo("acme", "base"), modelInfo("acme", "alt")],
    classifications: { base: "general", alt: "general" },
  })
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")
  await runOk(create, { kind: "model", providerID: "acme", modelID: "alt", level: "global", agent: "build" })
  const model = "item:project:build:model:acme/alt"
  const reader = "item:project:build:tool:reader"
  await runOk(need(tools, "instructions_link"), { id: model, target: reader, type: "either" })
  await runOk(set, { id: "item:project:build:model:acme/base", state: "on" })
  await runOk(set, { id: reader, state: "on" })
  const before = await load(project)
  await runOk(create, { kind: "model", providerID: "acme", modelID: "alt", level: "project", agent: "build" })
  const added = await load(project)
  expect(added.projectRevision + added.globalRevision).toBe(before.projectRevision + before.globalRevision + 1)
  expect(await customizationState(project, "tool:reader")).toBe("off")
  await runOk(set, { id: "item:project:build:model:acme/base", state: "on" })
  await runOk(set, { id: reader, state: "on" })
  const beforePick = await load(project)
  expect(await api.pickModel({ agent: "build", providerID: "acme", modelID: "alt" })).toMatchObject({ ok: true, value: { changed: true } })
  const picked = await load(project)
  expect(picked.projectRevision + picked.globalRevision).toBe(beforePick.projectRevision + beforePick.globalRevision + 1)
  expect(await customizationState(project, "tool:reader")).toBe("off")
  expect((await runFail(set, { id: model, text: "acme/base" })).message).toContain("remove its links before replacing")
  expect(await load(project)).toEqual(picked)
  await runOk(set, { id: "item:project:build:model:acme/base", state: "on" })
  await runOk(set, { id: reader, state: "on" })
  // An unlinked active row may become an already-linked target candidate:
  // replacement composes the new endpoint's switches before its one save.
  const beforeReplace = await load(project)
  await runOk(set, { id: "item:project:build:model:acme/base", text: "acme/alt" })
  const replaced = await load(project)
  expect(replaced.projectRevision + replaced.globalRevision).toBe(beforeReplace.projectRevision + beforeReplace.globalRevision + 1)
  expect(await customizationState(project, "tool:reader")).toBe("off")
  expect(await api.pickModel({ agent: "build", providerID: "acme", modelID: "base" })).toMatchObject({ ok: true })
  await runOk(set, { id: reader, state: "on" })
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["build"] }))
  const protectedBefore = await load(project)
  expect(await api.pickModel({ agent: "build", providerID: "acme", modelID: "alt" })).toMatchObject({ ok: false })
  expect(await load(project)).toEqual(protectedBefore)
})

test("set state:on persists its either partner off in one save, and it stays off after reload", async () => {
  const { api, tools, project } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  const link = need(tools, "instructions_link")
  const set = need(tools, "instructions_set")
  const reader = await rowIdOf(api, "tool:reader")
  const question = await rowIdOf(api, "tool:question")
  await runOk(link, { id: reader, target: question })
  // Rows start off in this fixture; turn question on so the switch has a live
  // target to save off.
  await runOk(set, { id: question, state: "on" })
  const before = await load(project)
  const on = (await runOk(set, { id: reader, text: "updated reader", state: "on" })) as { status: string }
  expect(on.status).toBe(`Enabled "reader"; disabled tool:question`)
  // The switch replaces question's own on with an own off, durable after reload.
  expect(await rowState(api, question)).toBe("off")
  expect(await customizationState(project, "tool:question")).toBe("off")
  const saved = await load(project)
  expect(saved.projectRevision + saved.globalRevision).toBe(before.projectRevision + before.globalRevision + 1)
  expect(saved.records.filter((record) => record.type === "rowlink")).toEqual(before.records.filter((record) => record.type === "rowlink"))
  expect(saved.records.find((record) => record.type === "customization" && record.item === "tool:reader")).toMatchObject({ text: "updated reader", state: "on" })
  // Turning reader back off leaves question off (no cascade, no resurrect).
  await runOk(set, { id: reader, state: "off" })
  expect(await rowState(api, question)).toBe("off")
})

test("set state:on changes the partner only for either, not conditional links", async () => {
  const { api, tools, project } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  const link = need(tools, "instructions_link")
  const set = need(tools, "instructions_set")
  const reader = await rowIdOf(api, "tool:reader")
  const question = await rowIdOf(api, "tool:question")
  await runOk(link, { id: reader, target: question, type: "shownWhenOff" })
  // Conditions leave saved state alone in both directions.
  await runOk(set, { id: question, state: "on" })
  expect(await customizationState(project, "tool:reader")).toBeUndefined()
  // Primary on leaves the target's saved state on.
  await runOk(set, { id: reader, state: "on" })
  expect(await customizationState(project, "tool:question")).toBe("on")
  // Either is symmetric: turn the target on and the primary goes off.
  await runOk(link, { id: reader, target: question, type: "either" })
  await runOk(set, { id: question, state: "off" })
  await runOk(set, { id: question, state: "on" })
  expect(await rowState(api, reader)).toBe("off")
})

test("a bare-id toggle writes the partner off in one hop and never cascades", async () => {
  const { api, tools, project } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
      { id: "extra", description: "extra", options: { codemode: false } },
    ],
  })
  const link = need(tools, "instructions_link")
  const set = need(tools, "instructions_set")
  const reader = await rowIdOf(api, "tool:reader")
  const question = await rowIdOf(api, "tool:question")
  const extra = await rowIdOf(api, "tool:extra")
  // reader—question and question—extra. Turn question on, then reader off and
  // on: the on toggle disables question only; question's own link to extra
  // must not fire (no cascade).
  await runOk(link, { id: reader, target: question })
  await runOk(link, { id: question, target: extra })
  await runOk(set, { id: question, state: "on" })
  await runOk(set, { id: reader, state: "off" })
  await runOk(set, { id: reader })
  expect(await rowState(api, question)).toBe("off")
  expect(await customizationState(project, "tool:extra")).toBeUndefined()
})

test("a same-level disabled link masks a switch through the tool", async () => {
  const { api, tools, project } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  const link = need(tools, "instructions_link")
  const set = need(tools, "instructions_set")
  const reader = await rowIdOf(api, "tool:reader")
  const question = await rowIdOf(api, "tool:question")
  // Store the switch, then mask it at the same level with enabled:false, and
  // turn the target on so the switch would have fired if not masked.
  await runOk(link, { id: reader, target: question })
  await runOk(link, { id: reader, target: question, enabled: false })
  await runOk(set, { id: question, state: "on" })
  await runOk(set, { id: reader, state: "off" })
  await runOk(set, { id: reader, state: "on" })
  // The masked switch fires nothing: question stays on.
  expect(await customizationState(project, "tool:question")).toBe("on")
})

test("turning a protected owner's row on with a linked partner refuses atomically", async () => {
  const { project } = await tempProject()
  // The protected row belongs to alpha; the reader and question rows do too,
  // so the tool-actor guard must refuse the write before any record changes.
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fixtureContext(project, {
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const reader = await rowIdOf(api, "tool:reader")
  // Seed the link directly: the link tool itself refuses protected owners, so
  // the guard under test is the write-time path.
  const loaded = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: [
      ...loaded.records,
      {
        type: "rowlink" as const,
        level: "project" as const,
        agent: "alpha",
        item: "tool:reader",
        section: null,
        target: "tool:question",
        targetSection: null,
        link: "either" as const,
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  if (!saved.ok) throw new Error("seed save failed")
  const before = await snapshotOf(api)
  const beforeLog = await Bun.file(projectLogPath(project)).exists()
  const error = await runFail(set, { id: reader, state: "on" })
  expect(error.message).toContain("agent.protected")
  // No records and no log line changed.
  expect((await snapshotOf(api)).records).toEqual(before.records)
  expect((await load(project)).projectRevision).toBe(saved.projectRevision)
  expect(await Bun.file(projectLogPath(project)).exists()).toBe(beforeLog)
  expect(await customizationState(project, "tool:question")).toBeUndefined()
})

test("instructions_link refuses a section as a gate's primary without writing", async () => {
  const { api, tools, project } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  await addToolsAndRules(tools)
  const link = need(tools, "instructions_link")
  const nodes = expandedTree(memoFromSnapshot(await snapshotOf(api)))
  const section = nodes.find(
    (node) => node.kind === "section" && node.address?.item === "system:tools-and-rules" && node.label === "Questions",
  )
  const question = await rowIdOf(api, "tool:question")
  if (section === undefined) throw new Error("missing Questions section")
  const before = await snapshotOf(api)
  expect((await runFail(link, { id: section.id, target: question, type: "shownWhenOn" })).message).toContain(
    "a \"shownWhenOn\" gate cannot have a section as its condition",
  )
  // A switch may still use a section endpoint; only the gate primary is refused.
  expect((await snapshotOf(api)).records).toEqual(before.records)
  expect(await linksOf(project)).toEqual([])
})

// B43: the legacy `set({requires})` writes only rowlink gates, so a reload
// cannot leave two authoritative condition stores. The adapter's three cases:
// non-null replaces the target's list at this level, [] means always, null
// removes the local list to inherit again.
test("set requires stores rowlinks only, survives reload, and null inherits again", async () => {
  const { api, tools, project } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  await addToolsAndRules(tools)
  const show = need(tools, "instructions_read")
  const set = need(tools, "instructions_set")
  const nodes = expandedTree(memoFromSnapshot(await snapshotOf(api)))
  const section = nodes.find((node) => node.id.startsWith("section:defaults:alpha:system:tools-and-rules:") && node.label === "Questions")
  if (section === undefined) throw new Error("missing Questions section")
  // Non-null: one barrier + one pair, and no `requires` field on any record.
  await runOk(set, { id: section.id, requires: ["tool:reader"] })
  const stored = await linksOf(project)
  expect(stored.some((record) => record.item === "tool:reader" && record.target === "system:tools-and-rules" && record.link === "shownWhenOn")).toBe(true)
  const barrier = stored.find((record) => record.item === "system:tools-and-rules" && record.target === "system:tools-and-rules")
  expect(barrier?.link).toBe("shownAlways")
  expect((await load(project)).records.some((record) => record.type === "customization" && "requires" in record)).toBe(false)
  // Inspect shows the effective answer (the stored pair, not the barrier).
  const links = (await runOk(need(tools, "instructions_link"), { id: section.id })) as { links: { item: string; type: string; enabled: boolean }[] }
  expect(links.links.filter((entry) => entry.item === "tool:reader").map((entry) => [entry.type, entry.enabled])).toEqual([["shownWhenOn", true]])
  expect(links.links.some((entry) => entry.item === "system:tools-and-rules")).toBe(false)
  // [] means always: the barrier alone, still no condition.
  await runOk(set, { id: section.id, requires: [] })
  const always = await linksOf(project)
  expect(always.filter((record) => record.item === "tool:reader")).toEqual([])
  expect(always.some((record) => record.item === "system:tools-and-rules" && record.link === "shownAlways")).toBe(true)
  // null drops the local list: no stored gate for the target remains.
  await runOk(set, { id: section.id, requires: null })
  expect((await linksOf(project)).filter((record) => record.target === "system:tools-and-rules")).toEqual([])
  expect(((await runOk(show, { id: section.id })) as { requiresFrom?: string }).requiresFrom).toBe("its text")
  // Reset takes the same rowlink removal through the durable tool boundary.
  await runOk(set, { id: section.id, requires: [], text: "## Questions\nLocal question guidance." })
  await runOk(need(tools, "instructions_reset"), { id: section.id })
  expect((await linksOf(project)).filter((record) => record.target === "system:tools-and-rules")).toEqual([])
  expect(((await runOk(show, { id: section.id })) as { requiresFrom?: string }).requiresFrom).toBe("its text")
})

test("instructions_link reports a shipped requires marker with text provenance", async () => {
  const { api, tools } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "question", description: "Ask the user", options: { codemode: false } },
    ],
  })
  await addToolsAndRules(tools)
  const link = need(tools, "instructions_link")
  const nodes = expandedTree(memoFromSnapshot(await snapshotOf(api)))
  // The shipped Tools and rules "Questions" section carries
  // `<!-- requires: tool:question -->` in its text.
  const section = nodes.find((node) => node.id.startsWith("section:defaults:alpha:system:tools-and-rules:") && node.label === "Questions")
  if (section === undefined) throw new Error("missing Questions section")
  const inspected = (await runOk(link, { id: section.id })) as { links: { item: string; shipped: boolean; from: unknown }[] }
  expect(inspected.links.map((entry) => [entry.item, entry.shipped, entry.from])).toEqual([["tool:question", true, "text"]])
})

test("durable section gates and inspection agree across pair replacements and barriers", async () => {
  const { api, tools, project } = await freshFixture({ tools: [
    { id: "reader", description: "Read", options: { codemode: false } },
    { id: "question", description: "Ask", options: { codemode: false } },
  ] })
  const create = need(tools, "instructions_create")
  await runOk(create, { kind: "agent", id: "gateprobe", scope: "global" })
  await runOk(create, { kind: "agent", id: "gateprobe", scope: "project" })
  await linkToBuild(project, "global", ["gateprobe"])
  await linkToBuild(project, "project", ["gateprobe"])
  await addToolsAndRules(tools, "item:project:gateprobe:system:tools-and-rules")
  const nodes = expandedTree(memoInputOf(await snapshotOf(api)))
  const section = nodes.find((node) => node.address?.level === "project" && node.address.agent === "gateprobe" && node.label === "Questions")
  if (section?.address === undefined) throw new Error("Missing project Questions section")
  const target = section.address
  const pair = (level: "project" | "global", item: string, link: "either" | "shownWhenOn" | "shownWhenOff" | "shownAlways") => ({
    type: "rowlink" as const, level, agent: "gateprobe", item, section: link === "shownAlways" ? target.section : null,
    target: target.item, targetSection: target.section, link, updated: "2026-01-01T00:00:00.000Z",
  })
  for (const scenario of [
    { pairs: [pair("global", "tool:question", "shownWhenOn"), pair("project", "tool:question", "either")], inspected: [["tool:question", "either"]], kept: true },
    { pairs: [pair("project", "tool:question", "shownWhenOff")], inspected: [["tool:question", "shownWhenOff"]], kept: true },
    { pairs: [pair("global", target.item, "shownAlways"), pair("project", "tool:reader", "shownWhenOn")], inspected: [["tool:reader", "shownWhenOn"]], kept: false },
    { pairs: [pair("global", "tool:reader", "shownWhenOn"), pair("project", target.item, "shownAlways")], inspected: [], kept: true },
  ]) {
    const loaded = await load(project)
    const saved = await save(project, {
      expectedProjectRevision: loaded.projectRevision, expectedGlobalRevision: loaded.globalRevision,
      records: [...loaded.records.filter((record) => record.type !== "rowlink"), ...scenario.pairs],
    })
    if (!saved.ok) throw new Error("Seed failed")
    await runOk(need(tools, "instructions_set"), { id: "item:project:gateprobe:tool:question", state: "off" })
    await runOk(need(tools, "instructions_set"), { id: "item:project:gateprobe:tool:reader", state: "off" })
    expect((await linksOf(project)).length).toBe(scenario.pairs.length)
    const inspected = await runOk(need(tools, "instructions_link"), { id: section.id }) as { links: { item: string; type: string }[] }
    expect(inspected.links.map((entry) => [entry.item, entry.type])).toEqual(scenario.inspected)
    const assembled = await api.assembled({ agent: "gateprobe" })
    if (!assembled.ok) throw new Error(assembled.error.message)
    expect(assembled.value.system.join("\n").includes("## Questions")).toBe(scenario.kept)
  }
})

test("legacy requires durably replaces a same-scope switch pair without duplicate identity", async () => {
  const { api, tools, project } = await freshFixture({ tools: [
    { id: "reader", description: "Read", options: { codemode: false } },
    { id: "question", description: "Ask", options: { codemode: false } },
    { id: "extra", description: "Extra", options: { codemode: false } },
  ] })
  await runOk(need(tools, "instructions_create"), { kind: "agent", id: "gateprobe", scope: "project" })
  await linkToBuild(project, "project", ["gateprobe"])
  await addToolsAndRules(tools, "item:project:gateprobe:system:tools-and-rules")
  const reader = "item:project:gateprobe:tool:reader"
  const section = expandedTree(memoInputOf(await snapshotOf(api))).find((node) => node.id.startsWith("section:project:gateprobe:system:tools-and-rules:") && node.label === "Questions")
  if (section === undefined) throw new Error("Missing Questions section")
  const question = section.id
  const extra = "item:project:gateprobe:tool:extra"
  const set = need(tools, "instructions_set")
  const link = need(tools, "instructions_link")
  await runOk(link, { id: reader, target: question, type: "either" })
  await runOk(link, { id: extra, target: question, type: "either" })
  const operation = setRequires(memoInputOf(await snapshotOf(api)), question, ["tool:reader"])
  if ("refusal" in operation) throw new Error(operation.refusal)
  expect(operation.rowlinks?.filter((record) => record.item === "tool:reader" && record.target === "system:tools-and-rules").map((record) => record.link)).toEqual(["shownWhenOn"])
  await runOk(set, { id: question, requires: ["tool:reader"] })
  const stored = await linksOf(project)
  expect(stored.filter((record) => record.item === "tool:reader" && record.target === "system:tools-and-rules").map((record) => record.link)).toEqual(["shownWhenOn"])
  expect(stored.filter((record) => record.item === "tool:extra").map((record) => record.link)).toEqual(["either"])
  const shown = await runOk(need(tools, "instructions_read"), { id: question }) as { requires?: { id: string }[] }
  expect(shown.requires?.map((entry) => entry.id)).toEqual(["tool:reader"])
  await runOk(set, { id: question, requires: [] })
  expect((await linksOf(project)).filter((record) => record.item === "tool:extra").map((record) => record.link)).toEqual(["either"])
  await runOk(set, { id: question, requires: null })
  expect((await linksOf(project)).map((record) => [record.item, record.link])).toEqual([["tool:extra", "either"]])
})

test("a model prompt is created with create kind system + models, re-aimed with set models, and deleted like a System row", async () => {
  const { api, tools } = await freshFixture()
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")
  const output = (await runOk(create, decoded(create, { kind: "system", id: "opus", title: "Opus 5.5", text: "Check twice.", models: ["*opus-5-5*"] }))) as { id: string; item: string }
  expect(output).toMatchObject({ id: "item:defaults::system:model/opus", item: "system:model/opus" })
  expect((await snapshotOf(api)).items.find((item) => item.id === "system:model/opus")?.models).toEqual(["*opus-5-5*"])
  expect(await runOk(set, decoded(set, { id: output.id, models: ["*opus-5-5*", "Claude Opus 5.5"] }))).toMatchObject({ models: ["*opus-5-5*", "Claude Opus 5.5"] })
  expect((await runFail(set, decoded(set, { id: output.id, models: ["*"], state: "off" }))).message).toBe("models is set on its own; send state in another call")
  expect((await runFail(set, decoded(set, { id: output.id, models: [] }))).message).toContain("system.invalid")
  expect((await runFail(set, decoded(set, { id: "item:defaults::system:tools-and-rules", models: ["*"] }))).message).toContain("is not a model prompt")
  expect(await runOk(need(tools, "instructions_delete"), { id: output.id, confirm: true })).toMatchObject({ id: "model/opus" })
  expect((await snapshotOf(api)).items.some((item) => item.id === "system:model/opus")).toBe(false)
})

// Team tools for every agent (2026-10-31): an agent linked to a member preset
// has that preset's team tool rows, an agent with no preset has them off, a
// member of a disabled team has its preset's role, and a member linked to an
// agent preset hears that it got an agent's rows and no team role.
test("team tool rows reach every agent, a disabled team's member keeps its role, and a member from an agent preset is told so", async () => {
  const { api, tools } = await freshFixture({
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "skill", description: "Load a skill", options: { codemode: false } },
      { id: "delegate", description: "Delegate a Brief.", options: { codemode: false, namespace: "team", permission: "team.delegate" } },
      { id: "check", description: "Run a check.", options: { codemode: false, namespace: "team", permission: "team.check" } },
    ],
  })
  const create = need(tools, "instructions_create")
  await runOk(create, { kind: "agent", id: "lead", scope: "project", preset: "basic/orchestrator" })
  await runOk(create, { kind: "agent", id: "worker", scope: "project", preset: "basic/implementer" })
  await runOk(create, { kind: "agent", id: "solo", scope: "project" })
  await runOk(create, { kind: "team", team: "crew", level: "project" })
  const hand = (await runOk(create, { kind: "member", team: "crew", level: "project", id: "hand", preset: "basic/implementer" })) as Record<string, unknown>
  expect(hand.status).toBeUndefined()
  const seat = (await runOk(create, { kind: "member", team: "crew", level: "project", id: "seat", preset: "build" })) as Record<string, unknown>
  expect(seat.status).toBe(
    `Linked member seat to the agent preset build, not a member preset: it takes build's rows (its tools, skills and role text), not a team member's role. For a team role pick a member preset ("<team>/<member>", e.g. "basic/implementer").`,
  )
  const nodes = expandedTree(memoInputOf(await snapshotOf(api)))
  const state = (id: string) => nodes.find((node) => node.id === id)?.badges.state
  expect(state("item:project:lead:tool:team_delegate")).toBe("on")
  expect(state("item:project:lead:tool:team_check")).toBe("on")
  expect(state("item:project:worker:tool:team_delegate")).toBe("off")
  expect(state("item:project:worker:tool:team_check")).toBe("on")
  expect(state("item:project:solo:tool:team_delegate")).toBe("off")
  expect(state("item:defaults:alpha:tool:team_check")).toBe("off")
  // The team is disabled (create leaves it so), yet the member has its role.
  const role = nodes.find((node) => node.id === "item:project:crew/:hand:system:role")
  expect(role?.badges.state).toBe("on")
  expect(nodes.some((node) => node.id.startsWith("section:project:crew/:hand:system:role:"))).toBe(true)
})

// c-09: a team's Special rows are listed by find --type agent, so `read` must
// accept the same id instead of answering row.unknown.
test("read renders a team's Special agent row", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream alpha"), agentInfo("title", "upstream title")],
    tools: [{ id: "bash", description: "Run commands.", options: { codemode: false } }],
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  await runOk(need(tools, "instructions_create"), { kind: "team", team: "crew", level: "project" })
  const id = "team:project:crew:special:title"
  const listed = (await runOk(need(tools, "instructions_find"), { type: "agent", limit: 200 })) as { rows: readonly string[] }
  expect(listed.rows.some((row) => row.startsWith(`${id} |`))).toBe(true)
  expect(await runOk(need(tools, "instructions_read"), { id })).toMatchObject({
    kind: "special",
    level: "project",
    team: "crew",
    agent: "title",
  })
  expect(await runOk(need(tools, "instructions_read"), { id, view: "record" })).toMatchObject({
    record: { kind: "special", level: "project", team: "crew", agent: "title" },
  })
})

// c-10: a member's own model row named two sources: `stateFrom`/`textFrom`
// pointed at the member preset (which ships no model) while `from` said
// "set here". A model row names the one source its candidate has.
test("a member's own model row names one source, not the preset that has none", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    tools: [{ id: "bash", description: "Run commands.", options: { codemode: false } }],
    models: [modelInfo("acme", "nova-2")],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  await runOk(need(tools, "instructions_create"), { kind: "team", team: "crew", level: "project", preset: "basic" })
  const created = (await runOk(need(tools, "instructions_create"), {
    kind: "model",
    providerID: "acme",
    modelID: "nova-2",
    level: "project",
    team: "crew",
    agent: "implementer",
  })) as { id: string }
  expect(created.id).toBe("item:project:crew/:implementer:model:acme/nova-2")
  const shown = (await runOk(need(tools, "instructions_read"), { id: created.id })) as Record<string, unknown>
  expect(shown).toMatchObject({
    source: "project",
    stateFrom: { kind: "level", level: "project" },
    textFrom: { kind: "level", level: "project" },
    from: "set here",
  })
  const found = (await runOk(need(tools, "instructions_find"), { team: "crew", agent: "implementer", type: "model", fields: ["id", "from", "source"] })) as {
    rows: readonly string[]
  }
  expect(found.rows).toEqual([`${created.id} | set here | project`])
})

// c-14: after `set` on one agent's copy, a plain find folded that copy into
// the shared Defaults row, so the edit read as "off by default" and looked
// lost. An own edit keeps its own row.
test("find keeps an agent's own edit out of the shared Defaults row", async () => {
  const { project } = await tempProject()
  for (const id of ["alpha", "beta"]) await Bun.write(path.join(project, ".opencode", "agent", `${id}.md`), formatMarkdown({}, "role\n"))
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  // alpha follows the native build preset, so it inherits the host's git-push
  // rule on; beta inherits the shared Defaults row's off.
  await linkToBuild(project, "project", ["alpha"])
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const find = need(tools, "instructions_find")
  const set = need(tools, "instructions_set")
  const read = need(tools, "instructions_read")
  const shared = "item:defaults::perm:shell:git-push"
  const alpha = "item:project:alpha:perm:shell:git-push"
  await runOk(set, { id: shared, state: "off" })
  // alpha's inherited value is on, so switching it off is its own edit — and
  // its state then equals the shared row's, which is what folded it away.
  expect(await runOk(read, { id: alpha })).toMatchObject({ enabled: true })
  await runOk(set, { id: alpha, state: "off" })
  const rows = (await runOk(find, { name: "git-push", limit: 20 })) as { rows: readonly string[] }
  expect(rows.rows).toContain(`${alpha} | off | set here`)
})

// a-18/a-21/d-07/b-08/b-09: the texts the tools answer. A write that saved
// nothing says so, an unknown clipboard token is refused, a copied owner is
// named instead of counted, a shipped preset row's save says what it reaches,
// and a missing create-member field is the field that is missing.
test("the tool answers say what actually happened", async () => {
  const { project } = await tempProject()
  for (const id of ["alpha", "beta"]) await Bun.write(path.join(project, ".opencode", "agent", `${id}.md`), formatMarkdown({}, "role\n"))
  const ctx = fixtureContext(project, {
    agents: [agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")
  const read = need(tools, "instructions_read")
  const find = need(tools, "instructions_find")
  const clipboard = need(tools, "instructions_clipboard")

  // a-18: a set that writes nothing says it wrote nothing.
  const rule = rowIds((await runOk(find, { agent: "alpha", type: "rule", where: "tool:shell", limit: 200 })) as { rows: readonly string[] })
    .find((id) => id.endsWith("perm:shell:git-push"))
  if (rule === undefined) throw new Error("expected alpha's git-push row")
  // It already reads off: the first set stores off as its own value (the
  // owner's decision, 2026-10-31); the same set again stores nothing.
  const own = (await runOk(set, { id: rule, state: "off" })) as { status: string; revision: number }
  expect(own.status).toBe('Disabled "Git push"')
  const nothing = (await runOk(set, { id: rule, state: "off" })) as { status: string; revision: number }
  expect(nothing.status).toBe('Disabled "Git push" (no change: it was already so)')
  expect(nothing.revision).toBe(own.revision)
  // A set that writes does not carry the note.
  const wrote = (await runOk(set, { id: rule, state: "on" })) as { status: string }
  expect(wrote.status).toBe('Enabled "Git push"')

  // a-21: an unknown clipboard token is refused, not answered as "cleared".
  const unknown = await runFail(clipboard, { action: "clear", clipboard: "not-a-clipboard" })
  expect(unknown.message).toContain("clipboard.unknown")

  // d-07: copying an agent names it, since its whole configuration moves.
  const copied = (await runOk(clipboard, { action: "copy", ids: ["agent:project:alpha"] })) as { status: string; clipboard: string }
  expect(copied.status).toBe("agent alpha copied")
  const pasted = (await runOk(clipboard, { action: "paste", clipboard: copied.clipboard, into: "agent:project:beta" })) as { status: string }
  expect(pasted.status).toBe("Pasted agent alpha into agent:project:beta")

  // b-08: a shipped preset row's save names the preset it reaches.
  const presetRow = "item:preset:build:tool:shell"
  const savedPreset = (await runOk(set, { id: presetRow, state: "off" })) as { status: string }
  expect(savedPreset.status).toContain('Disabled "shell"')
  expect(savedPreset.status).toContain("ships with the release")
  expect(savedPreset.status).toContain("every agent linked to it")

  // b-09: the refusal names only the field that is missing.
  const noTeam = await runFail(create, { kind: "member", level: "defaults", id: "worker3*" })
  expect(noTeam.message).toBe("create member requires team")
  const noId = await runFail(create, { kind: "member", team: "crew", level: "project" })
  expect(noId.message).toBe("create member requires id")
  void read
})

// b-10/c-15: read of a preset or a member answered only an identity stub, so
// comparing an agent with its preset, or seeing a member's on counts, needed
// two ~150 kB find dumps. Resolved lists the rows directly under it.
test("read of a preset, an entry and a member lists their rows", async () => {
  const { project } = await tempProject()
  const ctx = fixtureContext(project, {
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const show = need(tools, "instructions_read")
  const create = need(tools, "instructions_create")

  // A shipped agent preset: its groups, with on counts, beside its identity.
  const preset = (await runOk(show, { id: "agent:preset:build" })) as { kind: string; rows?: readonly string[]; columns?: string }
  expect(preset).toMatchObject({ kind: "preset", columns: "id | badges | from" })
  expect(preset.rows?.map((row) => row.split(" | ")[0])).toEqual([
    "group:preset:build:models",
    "group:preset:build:tools",
    "group:preset:build:skills",
    "group:preset:build:system",
    "group:preset:build:settings",
  ])
  expect(preset.rows?.some((row) => row.startsWith("group:preset:build:tools |") && row.includes("on"))).toBe(true)

  // A member preset.
  const member = (await runOk(show, { id: "team:preset:basic:implementer" })) as { kind: string; rows?: readonly string[] }
  expect(member.kind).toBe("preset")
  expect(member.rows?.map((row) => row.split(" | ")[0])).toContain("group:preset:basic/:implementer:tools")

  // A Defaults entry.
  await runOk(create, { kind: "entry", catalogue: "agents", name: "*orchestrator*" })
  const entry = (await runOk(show, { id: "agent:defaults:*orchestrator*" })) as { kind: string; rows?: readonly string[] }
  expect(entry.kind).toBe("entry")
  expect(entry.rows?.map((row) => row.split(" | ")[0])).toEqual([
    "group:defaults:*orchestrator*:models",
    "group:defaults:*orchestrator*:tools",
    "group:defaults:*orchestrator*:skills",
    "group:defaults:*orchestrator*:system",
    "group:defaults:*orchestrator*:settings",
  ])

  // A live team member: its groups and their on counts.
  await runOk(create, { kind: "team", team: "crew", level: "project", preset: "basic" })
  const live = (await runOk(show, { id: "team:project:crew:implementer" })) as { kind: string; team: string; rows?: readonly string[] }
  expect(live).toMatchObject({ kind: "member", team: "crew" })
  expect(live.rows?.map((row) => row.split(" | ")[0])).toContain("group:project:crew/:implementer:tools")
  // The record view stays the identity, with no rows: it is the stored record.
  const record = (await runOk(show, { id: "team:project:crew:implementer", view: "record" })) as { record: Record<string, unknown> }
  expect(record.record).toMatchObject({ kind: "member", team: "crew", member: "implementer" })
  expect("rows" in record.record).toBe(false)
})
