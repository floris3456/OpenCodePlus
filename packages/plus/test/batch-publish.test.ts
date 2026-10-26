// A list of Instructions rows must save row by row but publish once at the
// end: every publish rediscovers and reinstalls everything.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState, type PlusApi } from "../src/index.js"
import { registerInstructionTools } from "../src/tools.js"
import { agentInfo, fullContext } from "./harness.js"
import type { Context } from "@opencode/plugin/effect/plugin"

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
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-batch-publish-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  return { project: path.join(root, "project") }
}

function toolContext(): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_batch_publish_test"),
    agent: Agent.ID.make("alpha"),
    messageID: SessionMessage.ID.make("msg_batch_publish_test"),
    id: Tool.CallID.make("call_batch_publish_test"),
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

function need(tools: Map<string, Tool.Info & { readonly id: string }>, id: string): Tool.Info & { readonly id: string } {
  const tool = tools.get(id)
  if (tool === undefined) throw new Error(`missing tool ${id}`)
  return tool
}

test("instructions_set over a list of rows publishes once at the end", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [
      ...["preview", "navigate"].map((name) => ({ id: name, description: `${name} tool`, options: { codemode: true, namespace: "browser" } })),
      { id: "cpu-prof", description: "cpu tool", options: { codemode: true, namespace: "browser.cpu" } },
    ],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api: PlusApi = createPlusApi(ctx, createState())
  const calls = { publishFalse: 0, publishDefault: 0, refresh: 0 }
  const counted: PlusApi = {
    ...api,
    mutate: (input, options) => {
      if (options?.publish === false) {
        calls.publishFalse++
        return api.mutate(input, options)
      }
      calls.publishDefault++
      return api.mutate(input, options)
    },
    refresh: () => {
      calls.refresh++
      return api.refresh()
    },
  }
  await registerInstructionTools(ctx, counted)
  const tools = await readTools(ctx)
  const set = need(tools, "instructions_set")
  const ids = ["item:defaults:alpha:tool:browser_preview", "item:defaults:alpha:tool:browser_navigate", "item:defaults:alpha:tool:browser_cpu_cpu-prof"]

  // Alpha inherits these three tool rows off, so on is what the write stores.
  const output = (await runOk(set, { id: ids, state: "on" })) as { total: number; failed: number }
  expect(output).toMatchObject({ total: 3, failed: 0 })
  expect(calls).toEqual({ publishFalse: 3, publishDefault: 0, refresh: 1 })
  const after = await api.snapshot()
  if (!after.ok) throw new Error("snapshot failed")
  const stored = after.value.records.filter((record) => record.type === "customization").filter((record) => record.state === "on")
  expect(stored.map((record) => record.item).sort()).toEqual(["tool:browser_cpu_cpu-prof", "tool:browser_navigate", "tool:browser_preview"].sort())

  // A single row still publishes the old way, with no extra refresh.
  const one = (await runOk(set, { id: ids[0], state: "off" })) as { status: string }
  expect(one.status.length).toBeGreaterThan(0)
  expect(calls).toEqual({ publishFalse: 3, publishDefault: 1, refresh: 1 })
})

test("an interrupted list still publishes the rows it already saved", async () => {
  const { project } = await tempProject()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: ["preview", "navigate"].map((name) => ({ id: name, description: `${name} tool`, options: { codemode: true, namespace: "browser" } })),
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api: PlusApi = createPlusApi(ctx, createState())
  const calls = { writes: 0, refresh: 0 }
  const second = Promise.withResolvers<void>()
  const counted: PlusApi = {
    ...api,
    mutate: (input, options) => {
      calls.writes++
      if (calls.writes === 1) return api.mutate(input, options)
      // The second row's write never finishes: the call is interrupted while it waits.
      second.resolve()
      return new Promise(() => {})
    },
    refresh: () => {
      calls.refresh++
      return api.refresh()
    },
  }
  await registerInstructionTools(ctx, counted)
  const set = need(await readTools(ctx), "instructions_set")
  const ids = ["item:defaults:alpha:tool:browser_preview", "item:defaults:alpha:tool:browser_navigate"]

  const fiber = Effect.runFork(set.execute({ id: ids, state: "on" }, toolContext()))
  await second.promise
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(calls).toEqual({ writes: 2, refresh: 1 })
  const after = await api.snapshot()
  if (!after.ok) throw new Error("snapshot failed")
  expect(after.value.records.filter((record) => record.type === "customization" && record.state === "on").map((record) => record.item)).toEqual(["tool:browser_preview"])
})
