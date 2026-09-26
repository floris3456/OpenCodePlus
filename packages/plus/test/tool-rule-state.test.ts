import { afterEach, describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState, type PlusApi } from "../src/index.js"
import { globalRecordsPath, projectRecordsPath } from "../src/instructions/paths.js"
import { load, type RuleRecord } from "../src/instructions/store.js"
import { enable } from "../src/project.js"
import { registerInstructionTools } from "../src/tools.js"
import type { Plus } from "../src/rpc.js"
import { fullContext } from "./harness.js"

// A state-only write (`instructions_set` with just `state`) resubmits the
// whole record set through the tool serializer. These tests drive the real
// tool handlers and the real host publish path to prove that resubmission
// preserves the optional fields it never means to touch: a stored rule's
// `message` and the catalogue identity of shared Defaults records. The agent
// that owns the rule is a file-backed project agent created through the host
// handler, so the installed-denial readback does not depend on built-in scope
// resolution.

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
  const root = await fs.mkdtemp(path.join(parent, "plus-rule-state-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const project = path.join(root, "project")
  await enable(project)
  return project
}

type Tools = Map<string, Tool.Info & { readonly id: string }>

interface Fixture {
  readonly project: string
  readonly ctx: Context
  readonly api: PlusApi
  readonly tools: Tools
}

async function openFixture(): Promise<Fixture> {
  const project = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [],
    tools: [{ id: "shell", description: "Run shell commands. Use git push to publish.", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  return { project, ctx, api, tools: await readTools(ctx) }
}

// A real project agent file written by the host handler, so discovery reports
// it fileBacked at project scope.
async function addFileBackedAgent(api: PlusApi): Promise<void> {
  const created = await api.createAgent({ scope: "project", id: "alpha" })
  if (!created.ok) throw new Error(`createAgent failed: ${created.error.message}`)
}

function toolContext(agent = "alpha"): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_tool_rule_state"),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_tool_rule_state"),
    id: Tool.CallID.make("call_tool_rule_state"),
    progress: () => Effect.void,
  }
}

async function readTools(ctx: Context): Promise<Tools> {
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

function need<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key)
  if (value === undefined) throw new Error(`missing tool ${key}`)
  return value
}

async function runOk(tool: Tool.Info & { readonly id: string }, input: unknown): Promise<unknown> {
  const outcome = await Effect.runPromise(
    tool.execute(input, toolContext()).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (!outcome.ok) throw new Error(`expected tool to succeed: ${outcome.error.message}`)
  return (outcome.result as { output: unknown }).output
}

async function snapshotOf(api: PlusApi): Promise<Plus.Snapshot> {
  const result = await api.snapshot()
  if (!result.ok) throw new Error(`snapshot failed: ${result.error.message}`)
  return result.value
}

// One JSON object per stored record, after the header line.
async function storedLines(file: string): Promise<Record<string, unknown>[]> {
  const text = await fs.readFile(file, "utf8")
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(1)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function createRule(tools: Tools, input: Record<string, unknown>): Promise<{ id: string; item: string }> {
  const created = await runOk(need(tools, "instructions_create"), { kind: "rule", ...input })
  return created as { id: string; item: string }
}

describe("tool state mutations preserve rule messages and catalogue identity", () => {
  test("set state off rewrites the snapshot without dropping stored rule messages or catalogue", async () => {
    const { project, api, tools } = await openFixture()
    await addFileBackedAgent(api)
    const withAgent = await snapshotOf(api)
    const alpha = withAgent.agents.find((entry) => entry.id === "alpha")
    expect(alpha?.scope).toBe("project")
    expect(alpha?.fileBacked).toBe(true)

    // A: edited by the state-only write; agent-scoped, so its own record has no catalogue.
    const ruleA = await createRule(tools, {
      tool: "shell",
      id: "no-force",
      label: "No force push",
      patterns: ["git push --force *"],
      message: "force pushes are not allowed here",
      agent: "alpha",
      level: "project",
    })
    // B: unrelated shared Defaults rule in the Agents catalogue.
    const ruleB = await createRule(tools, {
      tool: "shell",
      id: "no-pull",
      label: "No pull",
      patterns: ["git pull *"],
      message: "pulls are not allowed here",
      level: "defaults",
    })
    // C: shared Defaults rule in the Teams catalogue, also edited by a state-only write.
    const ruleC = await createRule(tools, {
      tool: "shell",
      id: "no-push",
      label: "No push",
      patterns: ["git push *"],
      message: "pushing is not allowed in this team",
      level: "defaults",
      catalogue: "teams",
    })
    expect(ruleA.id).toBe("item:project:alpha:perm:shell:no-force")
    expect(ruleB.id).toBe("item:defaults::perm:shell:no-pull")
    expect(ruleC.id).toBe("item:defaults:/teams:perm:shell:no-push")

    const disabledA = (await runOk(need(tools, "instructions_set"), { id: ruleA.id, state: "off" })) as { status: string }
    expect(disabledA.status).toContain("Disabled")
    const disabledC = (await runOk(need(tools, "instructions_set"), { id: ruleC.id, state: "off" })) as { status: string }
    expect(disabledC.status).toContain("Disabled")

    // show: the edited rule still refuses with its own message, and the
    // unrelated rule keeps its message and stays in the Teams catalogue.
    const shownA = (await runOk(need(tools, "instructions_show"), { id: ruleA.id })) as {
      rule?: string
      enabled?: boolean
      message?: string
    }
    expect(shownA.rule).toBe("no-force")
    expect(shownA.enabled).toBe(false)
    expect(shownA.message).toBe("force pushes are not allowed here")

    const shownB = (await runOk(need(tools, "instructions_show"), { id: ruleB.id })) as { message?: string }
    expect(shownB.message).toBe("pulls are not allowed here")

    const shownC = (await runOk(need(tools, "instructions_show"), { id: ruleC.id })) as {
      enabled?: boolean
      message?: string
    }
    expect(shownC.enabled).toBe(false)
    expect(shownC.message).toBe("pushing is not allowed in this team")

    const recordC = (await runOk(need(tools, "instructions_show"), { id: ruleC.id, view: "record" })) as {
      record: { type?: string; catalogue?: string; message?: string } | null
    }
    expect(recordC.record?.type).toBe("rule")
    expect(recordC.record?.catalogue).toBe("teams")
    expect(recordC.record?.message).toBe("pushing is not allowed in this team")

    // The snapshot the next writer reads rebuilt both the edit and the untouched records.
    const after = await snapshotOf(api)
    const rules = after.records.filter((record): record is Plus.SnapshotRuleRecord => record.type === "rule")
    const storedA = rules.find((record) => record.tool === "shell" && record.id === "no-force")
    expect(storedA?.level).toBe("project")
    expect(storedA?.agent).toBe("alpha")
    expect(storedA?.message).toBe("force pushes are not allowed here")
    const storedB = rules.find((record) => record.tool === "shell" && record.id === "no-pull")
    expect(storedB?.level).toBe("defaults")
    expect(storedB?.message).toBe("pulls are not allowed here")
    expect(storedB?.catalogue).toBeUndefined()
    const storedC = rules.find((record) => record.tool === "shell" && record.id === "no-push")
    expect(storedC?.catalogue).toBe("teams")
    expect(storedC?.message).toBe("pushing is not allowed in this team")
    const stateA = after.records.find(
      (record) => record.type === "customization" && record.item === "perm:shell:no-force" && record.state === "off",
    )
    expect(stateA?.level).toBe("project")
    expect(stateA?.agent).toBe("alpha")
    const stateC = after.records.find(
      (record) => record.type === "customization" && record.item === "perm:shell:no-push" && record.state === "off",
    )
    expect(stateC?.catalogue).toBe("teams")

    // Disk: the same fields survive a load, and the raw JSONL carries the optional keys.
    const stored = await load(project)
    const diskA = stored.records.find((record): record is RuleRecord => record.type === "rule" && record.id === "no-force")
    expect(diskA?.message).toBe("force pushes are not allowed here")
    const diskB = stored.records.find((record): record is RuleRecord => record.type === "rule" && record.id === "no-pull")
    expect(diskB?.message).toBe("pulls are not allowed here")
    const diskC = stored.records.find((record): record is RuleRecord => record.type === "rule" && record.id === "no-push")
    expect(diskC?.catalogue).toBe("teams")
    expect(diskC?.message).toBe("pushing is not allowed in this team")

    const projectLines = await storedLines(projectRecordsPath(project))
    const projectRule = projectLines.find((line) => line.type === "rule" && line.id === "no-force")
    expect(projectRule?.message).toBe("force pushes are not allowed here")
    const projectState = projectLines.find((line) => line.type === "customization" && line.item === "perm:shell:no-force")
    expect(projectState?.state).toBe("off")

    const globalLines = await storedLines(globalRecordsPath())
    const teamsRule = globalLines.find((line) => line.type === "rule" && line.id === "no-push")
    expect(teamsRule?.catalogue).toBe("teams")
    expect(teamsRule?.message).toBe("pushing is not allowed in this team")
    const teamsState = globalLines.find((line) => line.type === "customization" && line.item === "perm:shell:no-push")
    expect(teamsState?.catalogue).toBe("teams")
    expect(teamsState?.state).toBe("off")
  })

  test("the installed host denial keeps the message for a file-backed project agent", async () => {
    const { ctx, api, tools } = await openFixture()
    await addFileBackedAgent(api)
    const ruleA = await createRule(tools, {
      tool: "shell",
      id: "no-force",
      label: "No force push",
      patterns: ["git push --force *"],
      message: "force pushes are not allowed here",
      agent: "alpha",
      level: "project",
    })
    await runOk(need(tools, "instructions_set"), { id: ruleA.id, state: "off" })

    // Publish the stored records the way the plugin does, then read the rule
    // the host actually installed on the agent.
    const refreshed = await api.refresh()
    if (!refreshed.ok) throw new Error(`refresh failed: ${refreshed.error.message}`)
    const { evaluate } = await import("../../core/src/permission.js")
    const listed = await Effect.runPromise(ctx.agent.list())
    const installed = listed.data.find((entry) => String(entry.id) === "alpha")
    if (installed === undefined) throw new Error("alpha missing from the installed agent list")
    const denial = evaluate("shell", "git push --force origin main", installed.permissions ?? [])
    expect(denial.effect).toBe("deny")
    expect(denial.message).toBe("force pushes are not allowed here")
  })
})