// An MCP server's tools join the tool registry after Plus's first discovery:
// the search server Plus registers connects seconds later, and a reconnecting
// server re-registers. No event tells a plugin (mcp.tools.changed is not a
// server event), so until something else refreshed Plus those tools had no
// rows and every agent's "off" row for them was ignored: the tool stayed in
// the agent's catalog. watchToolRegistry refreshes on the registry change.
import { afterEach, expect, test } from "bun:test"
import type { Agent } from "@opencode/schema/agent"
import { Effect, Exit, Scope } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { createPlusApi, createState, deactivate, watchToolRegistry } from "../src/index.js"
import { runRegistration } from "../src/instructions/apply.js"
import { agentHarness, agentInfo, fullContext, toolHarness } from "./harness.js"

const roots: string[] = []
const states: ReturnType<typeof createState>[] = []
const scopes: Scope.Closeable[] = []
const env = { config: process.env.OPENCODE_CONFIG_DIR, data: process.env.XDG_DATA_HOME }
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
  for (const state of states.splice(0)) await Effect.runPromise(deactivate(state))
  if (env.config === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = env.config
  if (env.data === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = env.data
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await fs.mkdtemp("/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus/tool-registry-")
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const directory = path.join(root, "project")
  const agents = agentHarness([agentInfo("build")], directory)
  const tools = toolHarness()
  const ctx = { ...fullContext({ directory, hooks: { current: 0 } }), agent: agents.domain, tool: tools.domain }
  const state = createState()
  states.push(state)
  const api = createPlusApi(ctx, state)
  return { agents, ctx, state, api }
}

// An MCP tool as core's McpTool registers it: namespaced, in Code Mode, from an mcp origin.
const searchTool = {
  name: "tavily_search",
  description: "Search the web via Tavily.",
  input: { type: "object", properties: {} },
  output: {},
  options: { namespace: "search", codemode: true },
  origin: { type: "mcp", name: "search" },
  execute: () => Effect.succeed({ output: null }),
}

const denies = (agent: Agent.Info | undefined, action: string) =>
  agent?.permissions.some((rule) => rule.action === action && rule.resource === "*" && rule.effect === "deny") === true

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now()
  while (!check() && Date.now() - start < ms) await Bun.sleep(25)
  return check()
}

test("an MCP tool that registers after discovery gets the agent's off row once the registry is watched", async () => {
  const f = await fixture()
  // The agent's row for the not yet registered tool is off.
  const first = (await f.api.snapshot()).value
  const saved = await f.api.mutate({
    expectedRevision: first.revision,
    expectedGlobalRevision: first.globalRevision,
    actor: { type: "tui" },
    records: [
      ...first.records,
      { type: "customization", level: "project", agent: "build", item: "tool:search_tavily_search", section: null, state: "off", basedOn: "", updated: "" },
    ],
  })
  expect(saved.ok).toBe(true)
  // The server connects: its tool joins the registry after that publish.
  await runRegistration(f.ctx.tool.transform, (editor) => editor.add(searchTool as never))

  // Control: nothing Plus hears refreshes it, so the off row is never applied.
  expect(await until(() => denies(f.agents.state.get("build"), "search_tavily_search"), 400)).toBe(false)

  // Watching the registry: a rebuild whose tools differ from the last discovery republishes.
  const scope = await Effect.runPromise(Scope.make())
  scopes.push(scope)
  await Effect.runPromise(watchToolRegistry(f.ctx, f.state).pipe(Scope.provide(scope)))
  expect(await until(() => denies(f.agents.state.get("build"), "search_tavily_search"))).toBe(true)

  // And it settles: its own registry reads list the same tools, so no further publish follows.
  const fingerprint = f.state.fingerprint
  const revision = f.state.projectRevision
  await Bun.sleep(400)
  expect([f.state.fingerprint, f.state.projectRevision]).toEqual([fingerprint, revision])
})
