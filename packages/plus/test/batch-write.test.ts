import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState, type PlusApi } from "../src/index.js"
import { load } from "../src/instructions/store.js"
import { globalLogPath, projectLogPath } from "../src/instructions/paths.js"
import { registerInstructionTools } from "../src/tools.js"
import type { Context } from "@opencode/plugin/effect/plugin"
import { agentInfo, fullContext } from "./harness.js"

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

type Tools = Map<string, Tool.Info & { readonly id: string }>

async function fixture(toolCount = 3) {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-batch-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const project = path.join(root, "project")
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "role"), agentInfo("beta", "role"), agentInfo("gamma", "role")],
    tools: Array.from({ length: toolCount }, (_, index) => ({ id: `t${index}`, description: `Tool ${index}.`, options: { codemode: false } })),
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  return { api, tools: await readTools(ctx), project }
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

const context: Tool.Context = {
  sessionID: Session.ID.make("ses_batch_test"),
  agent: Agent.ID.make("alpha"),
  messageID: SessionMessage.ID.make("msg_batch_test"),
  id: Tool.CallID.make("call_batch_test"),
  progress: () => Effect.void,
}

async function attempt(tools: Tools, name: string, input: unknown) {
  const tool = tools.get(`instructions_${name}`)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return Effect.runPromise(
    tool.execute(input, context).pipe(
      Effect.map((result) => ({ ok: true as const, output: (result as { output: unknown }).output })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error: error.message })),
    ),
  )
}

async function run(tools: Tools, name: string, input: unknown): Promise<unknown> {
  const outcome = await attempt(tools, name, input)
  if (!outcome.ok) throw new Error(`expected success, got: ${outcome.error}`)
  return outcome.output
}

type Written = {
  status: string
  changed: string[]
  already: number
  notDone: { id: string; reason: string }[]
  dryRun?: true
  results?: { id: string; output?: unknown; error?: string }[]
}

async function revisions(project: string): Promise<number> {
  const stored = await load(project)
  return stored.projectRevision + stored.globalRevision
}

async function stateOf(api: PlusApi, agent: string, item: string): Promise<string | undefined> {
  const snapshot = await api.snapshot()
  if (!snapshot.ok) throw new Error("snapshot failed")
  return snapshot.value.records
    .filter((record) => record.type === "customization")
    .findLast((record) => record.agent === agent && record.item === item && record.section === null)?.state
}

function rowIds(list: unknown): string[] {
  return (list as { rows: readonly string[] }).rows.map((row) => row.split(" | ")[0] ?? "")
}

async function logLines(project: string): Promise<number> {
  const count = async (file: string) => ((await Bun.file(file).exists()) ? (await Bun.file(file).text()).split("\n").filter((line) => line.trim() !== "").length : 0)
  return (await count(projectLogPath(project))) + (await count(globalLogPath()))
}

test("measure: switching 50 tool rows on in one set call", async () => {
  const { api, tools, project } = await fixture(50)
  const before = await load(project)
  const logBefore = await logLines(project)
  const started = performance.now()
  const answer = await run(tools, "set", { find: { agent: "alpha", type: "tool", name: "t*" }, state: "on" })
  console.log(JSON.stringify(answer).slice(0, 600))
  const ms = performance.now() - started
  const after = await load(project)
  const revisions = after.projectRevision - before.projectRevision + (after.globalRevision - before.globalRevision)
  const logged = (await logLines(project)) - logBefore
  console.log(`batch measure: 50 rows set on in ${ms.toFixed(0)} ms, ${revisions} store revisions, ${logged} log entries`)
  expect(after.records.filter((record) => record.type === "customization" && record.agent === "alpha" && record.state === "on").length).toBe(50)
  // Before this change the same call wrote 50 revisions and 50 log entries.
  expect(revisions).toBe(1)
  expect(logged).toBe(1)
  expect((answer as Written).changed).toHaveLength(50)
  // The one log entry names every row it changed.
  const entry = await api.log({ limit: 1 })
  expect(entry.value.entries[0]?.rows).toHaveLength(50)
}, 120_000)

test("filters take lists, and a comma inside one value is alternatives too", async () => {
  const { tools } = await fixture()
  const listed = rowIds(await run(tools, "find", { agent: ["alpha", "beta"], type: "tool", name: ["t0", "t2"] })).toSorted()
  expect(listed).toEqual(["item:defaults:alpha:tool:t0", "item:defaults:alpha:tool:t2", "item:defaults:beta:tool:t0", "item:defaults:beta:tool:t2"])
  expect(rowIds(await run(tools, "find", { agent: "alpha,beta", type: "tool", name: "t0,t2" })).toSorted()).toEqual(listed)
})

test("a list write: partial success names each row not done with its reason, in one revision", async () => {
  const { api, tools, project } = await fixture()
  const before = await revisions(project)
  const answer = (await run(tools, "set", { id: ["item:defaults:alpha:tool:t0", "item:defaults:alpha:tool:nope", "item:defaults:beta:tool:t1"], state: "on" })) as Written
  expect(answer.changed).toEqual(["item:defaults:alpha:tool:t0", "item:defaults:beta:tool:t1"])
  expect(answer.notDone).toHaveLength(1)
  expect(answer.notDone[0]).toMatchObject({ id: "item:defaults:alpha:tool:nope" })
  expect(answer.notDone[0]?.reason).toContain("row.unknown")
  expect(answer.results).toBeUndefined()
  expect((await revisions(project)) - before).toBe(1)
  expect(await stateOf(api, "beta", "tool:t1")).toBe("on")
  // Again: nothing changes, nothing is written.
  const again = (await run(tools, "set", { id: ["item:defaults:alpha:tool:t0", "item:defaults:beta:tool:t1"], state: "on", verbose: true })) as Written
  expect(again).toMatchObject({ changed: [], already: 2, notDone: [] })
  expect(again.results).toHaveLength(2)
  expect((await revisions(project)) - before).toBe(1)
})

test("dryRun answers what would change and writes nothing", async () => {
  const { api, tools, project } = await fixture()
  const before = await revisions(project)
  const logBefore = await logLines(project)
  const many = (await run(tools, "set", { find: { agent: ["alpha", "beta"], type: "tool", name: "t*" }, state: "on", dryRun: true })) as Written
  expect(many.dryRun).toBe(true)
  expect(many.status).toStartWith("Dry run, nothing written: 6 would change")
  expect(many.changed).toHaveLength(6)
  const one = (await run(tools, "set", { id: "item:defaults:alpha:tool:t0", state: "on", dryRun: true })) as { dryRun?: true; status: string }
  expect(one.dryRun).toBe(true)
  expect(one.status).toStartWith("Dry run, nothing written")
  const batch = (await run(tools, "batch", { dryRun: true, changes: [{ op: "set", id: "item:defaults:alpha:tool:t1", state: "on" }, { op: "reset", id: "item:defaults:beta:tool:t1" }] })) as Written
  expect(batch.dryRun).toBe(true)
  expect(await revisions(project)).toBe(before)
  expect(await logLines(project)).toBe(logBefore)
  expect(await stateOf(api, "alpha", "tool:t0")).toBeUndefined()
})

test("batch changes apply in order to one store, a later change uses what an earlier one made, written once", async () => {
  const { api, tools, project } = await fixture()
  const before = await revisions(project)
  const answer = (await run(tools, "batch", {
    changes: [
      { op: "set", find: { agent: "alpha", type: "tool" }, state: "on" },
      { op: "set", id: "item:defaults:alpha:tool:t1", state: "off" },
      { op: "set", id: "item:defaults:gamma:tool:missing", state: "on" },
      { op: "teleport", id: "x" },
      { op: "set", find: { agent: "beta", type: "tool", name: "t2" }, like: "alpha" },
    ],
  })) as Written
  expect(answer.notDone.map((entry) => entry.id)).toEqual(["3. set item:defaults:gamma:tool:missing", "4. teleport x"])
  expect(answer.notDone[1]?.reason).toContain("unknown op")
  expect((await revisions(project)) - before).toBe(1)
  expect(await stateOf(api, "alpha", "tool:t0")).toBe("on")
  expect(await stateOf(api, "alpha", "tool:t1")).not.toBe("on")
  expect(await stateOf(api, "beta", "tool:t2")).toBe("on")
  // Either form, not both.
  const decode = Schema.decodeUnknownExit(tools.get("instructions_batch")!.input as Schema.Codec<unknown>)
  expect(Exit.isFailure(decode({ changes: [], op: "set", id: "x", selected: [], input: {} }))).toBe(true)
  expect(Exit.isFailure(decode({}))).toBe(true)
  expect(Exit.isSuccess(decode({ op: "set", id: "x", selected: ["x"], input: { state: "on" } }))).toBe(true)
})

test("create takes lists: several agents in one call", async () => {
  const { api, tools } = await fixture()
  const answer = (await run(tools, "create", { kind: "agent", id: ["scout", "pilot"], scope: "project" })) as Written
  expect(answer.notDone).toEqual([])
  expect(answer.changed.toSorted()).toEqual(["agent:project:pilot", "agent:project:scout"])
  const snapshot = await api.snapshot()
  if (!snapshot.ok) throw new Error("snapshot failed")
  expect(JSON.stringify(snapshot.value)).toContain("scout")
})

test("set like copies another agent's on/off for the same row", async () => {
  const { api, tools } = await fixture()
  await run(tools, "set", { id: ["item:defaults:alpha:tool:t0", "item:defaults:alpha:tool:t1"], state: "on" })
  const liked = (await run(tools, "set", { find: { agent: "beta", type: "tool", name: ["t0", "t1"] }, like: "alpha" })) as Written
  expect(liked.changed.toSorted()).toEqual(["item:defaults:beta:tool:t0", "item:defaults:beta:tool:t1"])
  expect(await stateOf(api, "beta", "tool:t0")).toBe("on")
  // like with its own state is refused: it would be two answers to one question.
  const both = await attempt(tools, "set", { id: "item:defaults:gamma:tool:t0", like: "alpha", state: "off" })
  expect(both.ok).toBe(false)
})

test("undo takes back one whole call; a row changed again since is kept and named", async () => {
  const { api, tools } = await fixture()
  await run(tools, "set", { id: ["item:defaults:alpha:tool:t0", "item:defaults:alpha:tool:t1", "item:defaults:beta:tool:t0"], state: "on" })
  const dry = (await run(tools, "undo", { dryRun: true })) as { dryRun?: true; undone: string[] }
  expect(dry.dryRun).toBe(true)
  expect(dry.undone).toHaveLength(3)
  expect(await stateOf(api, "alpha", "tool:t0")).toBe("on")
  const undone = (await run(tools, "undo", {})) as { undone: string[]; notUndone: unknown[] }
  expect(undone.undone).toHaveLength(3)
  expect(undone.notUndone).toEqual([])
  expect(await stateOf(api, "alpha", "tool:t0")).toBeUndefined()
  expect(await stateOf(api, "beta", "tool:t0")).toBeUndefined()
  // Undo of the undo puts it back.
  await run(tools, "undo", {})
  expect(await stateOf(api, "alpha", "tool:t1")).toBe("on")

  // An older call whose row was changed again later: that row is kept.
  const log = await api.log({ limit: 10 })
  const first = log.value.entries.findLast((entry) => entry.op === "mutate")!
  await run(tools, "set", { id: "item:defaults:alpha:tool:t0", state: "off" })
  const partial = (await run(tools, "undo", { ts: first.ts })) as { undone: string[]; notUndone: { id: string; reason: string }[] }
  expect(partial.notUndone).toHaveLength(1)
  expect(partial.notUndone[0]?.reason).toContain("changed again at")
  expect(await stateOf(api, "alpha", "tool:t0")).not.toBe("on")
  expect(await stateOf(api, "alpha", "tool:t1")).toBeUndefined()
  expect((await attempt(tools, "undo", { ts: "2000-01-01T00:00:00.000Z" })).ok).toBe(false)
})
