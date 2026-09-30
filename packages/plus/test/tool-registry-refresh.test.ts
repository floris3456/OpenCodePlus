// An MCP server's tools join the tool registry after Plus's first discovery:
// the search server Plus registers connects seconds later, and a reconnecting
// server re-registers. No event tells a plugin (mcp.tools.changed is not a
// server event), so until something else refreshed Plus those tools had no
// rows and every agent's "off" row for them was ignored: the tool stayed in
// the agent's catalog. watchToolRegistry refreshes on the registry change.
import { afterEach, expect, test } from "bun:test"
import type { Agent } from "@opencode/schema/agent"
import { Mcp } from "@opencode/schema/mcp"
import { Effect, Exit, Scope } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { createPlusApi, createState, deactivate, watchToolRegistry } from "../src/index.js"
import { runRegistration } from "../src/instructions/apply.js"
import { knownMcpToolsPath, learnMcpTools, loadKnownMcpTools, pendingMcpTools } from "../src/instructions/mcp-tools.js"
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

async function fixture(servers: [string, Mcp.ServerConfig][] = []) {
  const root = await fs.mkdtemp("/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus/tool-registry-")
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const directory = path.join(root, "project")
  const agents = agentHarness([agentInfo("build")], directory)
  const tools = toolHarness()
  const ctx = { ...fullContext({ directory, hooks: { current: 0 }, servers }), agent: agents.domain, tool: tools.domain }
  const state = createState()
  states.push(state)
  const api = createPlusApi(ctx, state)
  return { root, agents, ctx, state, api }
}

// The build agent's row for a search tool, stored off; returns the published snapshot.
async function searchRowOff(f: Awaited<ReturnType<typeof fixture>>, item = "tool:search_tavily_search") {
  const first = (await f.api.snapshot()).value
  const saved = await f.api.mutate({
    expectedRevision: first.revision,
    expectedGlobalRevision: first.globalRevision,
    actor: { type: "tui" },
    records: [...first.records, { type: "customization", level: "project", agent: "build", item, section: null, state: "off", basedOn: "", updated: "" }],
  })
  expect(saved.ok).toBe(true)
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

// Plus's search server, as registerSearchMcp configures it.
const ownSearch = new Mcp.LocalConfig({ type: "local", command: ["opencodeplus", "search-mcp"], environment: { OPENCODEPLUS_SEARCH_KEYS_DIR: "/keys" } })

test("the search server's tools have rows and denials before it has connected", async () => {
  const f = await fixture([["search", ownSearch]])
  await searchRowOff(f)
  // Nothing registered yet, yet the off row already denies the tool.
  expect((await Effect.runPromise(f.ctx.tool.list())).some((tool) => tool.id === "search_tavily_search")).toBe(false)
  expect(denies(f.agents.state.get("build"), "search_tavily_search")).toBe(true)
  const row = (await f.api.snapshot()).value.items.find((item) => item.id === "tool:search_tavily_search")
  expect(row).toMatchObject({ group: "mcp", server: "search", codemode: true, title: "tavily_search" })
})

test("a server that is not Plus's own is known only after it has connected once", async () => {
  // Control: someone else's "search" server, never seen, has no rows and no denial.
  const f = await fixture([["search", new Mcp.LocalConfig({ type: "local", command: ["their-search"] })]])
  await searchRowOff(f)
  expect(denies(f.agents.state.get("build"), "search_tavily_search")).toBe(false)
  // It connects and registers; Plus remembers what it registered.
  const scope = await Effect.runPromise(Scope.make())
  scopes.push(scope)
  await Effect.runPromise(watchToolRegistry(f.ctx, f.state).pipe(Scope.provide(scope)))
  const registration = await runRegistration(f.ctx.tool.transform, (editor) => editor.add(searchTool as never))
  expect(await until(() => denies(f.agents.state.get("build"), "search_tavily_search"))).toBe(true)
  expect((await loadKnownMcpTools()).get("search")?.map((tool) => tool.name)).toEqual(["tavily_search"])
  expect(knownMcpToolsPath().startsWith(f.root)).toBe(true)
  // Next start: the server has not connected yet, and the remembered tool still carries the off row.
  await Effect.runPromise(registration.dispose)
  const next = await fixture([["search", new Mcp.LocalConfig({ type: "local", command: ["their-search"] })]])
  process.env.XDG_DATA_HOME = path.join(f.root, "data")
  await searchRowOff(next)
  expect(denies(next.agents.state.get("build"), "search_tavily_search")).toBe(true)
})

test("known tools follow what a server registered; disabled and connected servers get no stand-ins", () => {
  const registered = { ...searchTool, id: "search_tavily_search" } as never
  const learned = learnMcpTools(new Map(), [registered])
  expect(learned?.get("search")).toEqual([{ name: "tavily_search", description: "Search the web via Tavily.", input: { type: "object", properties: {} } }])
  expect(learnMcpTools(learned ?? new Map(), [registered])).toBeUndefined()
  const known = learned ?? new Map()
  const pending = pendingMcpTools([], [["search", new Mcp.LocalConfig({ type: "local", command: ["x"] })]], known)
  expect(pending.map((tool) => [tool.id, tool.options?.namespace, tool.origin])).toEqual([["search_tavily_search", "search", { type: "mcp", name: "search" }]])
  expect(pendingMcpTools([registered], [["search", new Mcp.LocalConfig({ type: "local", command: ["x"] })]], known)).toEqual([])
  expect(pendingMcpTools([], [["search", new Mcp.LocalConfig({ type: "local", command: ["x"], disabled: true })]], known)).toEqual([])
  // Plus's own search server is known from source: all three tools.
  expect(pendingMcpTools([], [["search", ownSearch]], new Map()).map((tool) => tool.id)).toEqual([
    "search_exa_code_search",
    "search_tavily_search",
    "search_tavily_extract",
  ])
})
