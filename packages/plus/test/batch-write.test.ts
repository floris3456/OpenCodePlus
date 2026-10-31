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
import { load } from "../src/instructions/store.js"
import { globalLogPath, projectLogPath } from "../src/instructions/paths.js"
import { registerInstructionTools } from "../src/tools.js"
import type { Context } from "@opencode/plugin/effect/plugin"
import { agentInfo, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

type Tools = Map<string, Tool.Info & { readonly id: string }>

async function fixture(toolCount = 3) {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-batch-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
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

async function run(tools: Tools, name: string, input: unknown): Promise<unknown> {
  const tool = tools.get(`instructions_${name}`)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  const outcome = await Effect.runPromise(
    tool.execute(input, context).pipe(
      Effect.map((result) => ({ ok: true as const, output: (result as { output: unknown }).output })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error: error.message })),
    ),
  )
  if (!outcome.ok) throw new Error(`expected success, got: ${outcome.error}`)
  return outcome.output
}

async function logLines(project: string): Promise<number> {
  const count = async (file: string) => ((await Bun.file(file).exists()) ? (await Bun.file(file).text()).split("\n").filter((line) => line.trim() !== "").length : 0)
  return (await count(projectLogPath(project))) + (await count(globalLogPath()))
}

test("measure: switching 50 tool rows on in one set call", async () => {
  const { tools, project } = await fixture(50)
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
}, 120_000)
