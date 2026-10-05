// T3 / overnight#18: a model activated for an agent that exists only as a
// team member must be addressed by its member row id, not a flat owner id.
//
// The evidence case from docs/plans/plus-1.1.12-instructions.md: the user's
// Global `Basic` team holds `Planner` only as a member (linked to the shipped
// `basic/planner` preset), so the tool log's flat target names no row. The log
// wrote TWO flat forms and this file exercises both through the actual tool
// boundary (not `activateModelRow` called directly, which model.test.ts does):
//
//   - the row grammar `item:<level>:<owner>:model:<provider>/<model>`;
//   - the legacy log target `model:<level>:<owner>:<provider>/<model>` that
//     `model.add`/`mutate` recorded before the member owner path existed.
//
// It proves the refusal names the exact member row for both forms, that a
// refusal writes nothing (records, revisions, log), that the member row then
// activates (`active:true` and a bare set) exclusively with one revision and
// one log line while another owner's active candidate is preserved, and that a
// create with the member's team writes the member's own row rather than a flat
// record.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState } from "../src/index.js"
import type { PlusApi } from "../src/index.js"
import { Plus } from "../src/rpc.js"
import { registerInstructionTools } from "../src/tools.js"
import { expandedTree } from "../src/instructions/tree.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { load } from "../src/instructions/store.js"
import type { Context } from "@opencode/plugin/effect/plugin"
import { agentInfo, fullContext, modelInfo, skillInfo } from "./harness.js"

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
  const root = await fs.mkdtemp(path.join(parent, "plus-member-model-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return path.join(root, "project")
}

function toolContext(agent = "alpha"): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_member_model_test"),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_member_model_test"),
    id: Tool.CallID.make("call_member_model_test"),
    progress: () => Effect.void,
  }
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

function isModelRecord(record: { readonly type: string }): record is Extract<Plus.SnapshotRecord, { type: "model" }> {
  return record.type === "model"
}

// A Global `Basic` team with `Planner` only as a member, linked to the shipped
// `basic/planner` preset, plus a Defaults Teams model the member inherits.
async function memberOnlyFixture(): Promise<{
  api: PlusApi
  tools: Map<string, Tool.Info & { readonly id: string }>
  project: string
}> {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "reader", description: "read things", options: { codemode: false } }],
    skills: [skillInfo("notes", "skill body")],
    models: [modelInfo("acme", "nova-2"), modelInfo("acme", "nova-3")],
    classifications: { "nova-2": "general", "nova-3": "general" },
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  await runOk(need(tools, "instructions_create"), { kind: "team", team: "Basic", level: "global" })
  await runOk(need(tools, "instructions_create"), {
    kind: "member",
    team: "Basic",
    level: "global",
    id: "Planner",
    preset: "basic/planner",
  })
  // The Defaults Teams catalogue model the member row inherits.
  await runOk(need(tools, "instructions_create"), {
    kind: "model",
    providerID: "acme",
    modelID: "nova-2",
    level: "defaults",
    catalogue: "teams",
  })
  return { api, tools, project }
}

// The store state a refusal must leave untouched: both revisions and the
// records, plus the log length.
async function storeState(api: PlusApi, project: string) {
  const snapshot = (await api.snapshot()).value
  const loaded = await load(project)
  const logged = await api.log({})
  if (!logged.ok) throw new Error("log failed")
  return {
    projectRevision: loaded.projectRevision,
    globalRevision: loaded.globalRevision,
    records: JSON.stringify(loaded.records),
    logTotal: logged.value.total,
    snapshotRevision: snapshot.revision,
    snapshotGlobalRevision: snapshot.globalRevision,
  }
}

test("both flat model id forms for a member-only agent refuse and name the member row", async () => {
  const { api, tools, project } = await memberOnlyFixture()
  const set = need(tools, "instructions_set")
  const show = need(tools, "instructions_show")
  const reset = need(tools, "instructions_reset")
  const del = need(tools, "instructions_delete")
  const grammar = "item:global:Planner:model:acme/nova-2"
  const legacy = "model:global:Planner:acme/nova-2"
  const member = "item:global:Basic/:Planner:model:acme/nova-2"

  for (const flat of [grammar, legacy]) {
    for (const tool of [set, show, reset, del]) {
      const before = await storeState(api, project)
      const refused = await runFail(tool, tool.id === "instructions_delete" ? { id: flat, confirm: true } : { id: flat })
      expect(refused.message).toContain(`row.unknown: Unknown row "${flat}"`)
      expect(refused.message).toContain(`"Planner" is a member of team "Basic"`)
      expect(refused.message).toContain(member)
      // A refusal writes nothing: same records, same revisions, same log.
      expect(await storeState(api, project)).toEqual(before)
    }
  }

  // A flat id naming no member anywhere keeps the plain refusal: the note is
  // guidance, not a rewrite of every unknown row. Same for a real member id
  // whose candidate does not exist (no invented candidate).
  const noMember = "item:global:Nobody:model:acme/nova-2"
  expect((await runFail(set, { id: noMember })).message).toBe(`row.unknown: Unknown row "${noMember}"`)
  const noCandidate = "item:global:Planner:model:acme/nova-9"
  expect((await runFail(set, { id: noCandidate })).message).toBe(`row.unknown: Unknown row "${noCandidate}"`)
  const legacyNoMember = "model:global:Nobody:acme/nova-2"
  expect((await runFail(set, { id: legacyNoMember })).message).toBe(
    `row.unknown: Unknown row "${legacyNoMember}"`,
  )
})

test("member row activates exclusively through set active:true and a bare set", async () => {
  const { api, tools, project } = await memberOnlyFixture()
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")
  const show = need(tools, "instructions_show")
  const member = "item:global:Basic/:Planner:model:acme/nova-2"
  const sibling = "item:global:Basic/:Planner:model:acme/nova-3"

  // A second member candidate, written through the real create boundary.
  await runOk(create, { kind: "model", providerID: "acme", modelID: "nova-3", level: "global", agent: "Planner", team: "Basic" })

  // active:true activates and the record view reports it.
  const activated = (await runOk(set, { id: member, active: true })) as { status: string }
  expect(activated.status).toBe('Activated "acme/nova-2"')
  const record = (await runOk(show, { id: member, view: "record" })) as {
    record: { level: string; agent: string; team?: unknown; active?: boolean } | null
  }
  expect(record.record).toMatchObject({ level: "global", agent: "Planner", active: true })
  expect(record.record?.team).toBeUndefined()

  // The row resolves active on the member chain, and a bare set on the sibling
  // candidate activates it exclusively, clearing the previous flag.
  const rows = expandedTree(memoInputOf((await api.snapshot()).value))
  expect(rows.find((node) => node.id === member)?.badges.active).toBe(true)
  await runOk(set, { id: sibling })
  const models = (await api.snapshot()).value.records.filter(isModelRecord).filter((entry) => entry.agent === "Planner")
  expect(models).toHaveLength(2)
  expect(models.find((entry) => entry.modelID === "nova-2")?.active).toBeUndefined()
  expect(models.find((entry) => entry.modelID === "nova-3")?.active).toBe(true)
  expect(models.every((entry) => entry.team === undefined)).toBe(true)
})

test("activation is one revision and one log line and preserves another owner's active candidate", async () => {
  const { api, tools, project } = await memberOnlyFixture()
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")
  const member = "item:global:Basic/:Planner:model:acme/nova-2"

  // Another Global owner with its own active candidate, written through the
  // real create boundary (create activates exclusively).
  await runOk(create, { kind: "agent", id: "other", scope: "global" })
  const beforeOther = await storeState(api, project)
  await runOk(create, { kind: "model", providerID: "acme", modelID: "nova-2", level: "global", agent: "other" })
  const afterOther = await storeState(api, project)
  // Add is also one global revision and one log line (the T3 create contract).
  expect(afterOther.globalRevision).toBe(beforeOther.globalRevision + 1)
  expect(afterOther.projectRevision).toBe(beforeOther.projectRevision)
  expect(afterOther.logTotal).toBe(beforeOther.logTotal + 1)

  const before = await storeState(api, project)
  const activated = (await runOk(set, { id: member, active: true })) as { revision: number; globalRevision: number }
  const after = await storeState(api, project)
  // One global store revision, no project write, exactly one new log line.
  expect(after.globalRevision).toBe(before.globalRevision + 1)
  expect(after.projectRevision).toBe(before.projectRevision)
  expect(after.logTotal).toBe(before.logTotal + 1)
  expect(activated.globalRevision).toBe(after.globalRevision)

  const loaded = await load(project)
  const planner = loaded.records.filter(isModelRecord).filter((record) => record.agent === "Planner")
  const other = loaded.records.filter(isModelRecord).filter((record) => record.agent === "other")
  expect(planner.filter((record) => record.active === true)).toHaveLength(1)
  expect(planner.find((record) => record.active === true)?.modelID).toBe("nova-2")
  // The other owner's active candidate is untouched.
  expect(other.filter((record) => record.active === true)).toHaveLength(1)
  expect(other.find((record) => record.active === true)?.modelID).toBe("nova-2")
})

test("an ambiguous flat id lists every matching member row instead of choosing one", async () => {
  const { api, tools } = await memberOnlyFixture()
  const create = need(tools, "instructions_create")
  const set = need(tools, "instructions_set")
  // The same member id in a second Global team, with the same candidate.
  await runOk(create, { kind: "team", team: "Backup", level: "global" })
  await runOk(create, { kind: "member", team: "Backup", level: "global", id: "Planner", preset: "basic/planner" })
  await runOk(create, { kind: "model", providerID: "acme", modelID: "nova-2", level: "global", agent: "Planner", team: "Backup" })

  const refused = await runFail(set, { id: "item:global:Planner:model:acme/nova-2" })
  // Both matching rows are listed, in a deterministic order; neither is claimed
  // as the single right team.
  expect(refused.message).toContain('"Planner" is a member of teams "Backup", "Basic"')
  expect(refused.message).toContain("item:global:Basic/:Planner:model:acme/nova-2")
  expect(refused.message).toContain("item:global:Backup/:Planner:model:acme/nova-2")
  void api
})

test("create model with the member's team writes the member row, not a flat record", async () => {
  const { tools, project } = await memberOnlyFixture()
  const create = need(tools, "instructions_create")
  const member = "item:global:Basic/:Planner:model:acme/nova-3"

  // A flat owner with no team refuses: `Planner` is not a Global agent.
  const flat = await runFail(create, {
    kind: "model",
    providerID: "acme",
    modelID: "nova-3",
    level: "global",
    agent: "Planner",
  })
  expect(flat.message).toContain('model.invalid: unknown model owner "Planner" at global')

  // With the team, the create returns the member's own row.
  const created = (await runOk(create, {
    kind: "model",
    providerID: "acme",
    modelID: "nova-3",
    level: "global",
    agent: "Planner",
    team: "Basic",
  })) as { id: string; item: string }
  expect(created.id).toBe(member)
  expect(created.item).toBe("model:acme/nova-3")

  // The write is a per-agent Global record (no team owner path), exactly the
  // record the member chain reads.
  const stored = (await load(project)).records.find(
    (record) => record.type === "model" && record.agent === "Planner" && record.modelID === "nova-3",
  )
  expect(stored).toMatchObject({ level: "global", agent: "Planner" })
  expect(stored).not.toHaveProperty("team")
})
