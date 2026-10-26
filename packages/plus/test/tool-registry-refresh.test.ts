// An MCP server's tools join the tool registry after Plus's first discovery:
// a configured server connects seconds later, and a reconnecting
// server re-registers. No event tells a plugin (mcp.tools.changed is not a
// server event), so until something else refreshed Plus those tools had no
// rows and every agent's "off" row for them was ignored: the tool stayed in
// the agent's catalog. watchToolRegistry refreshes on the registry change.
import { afterEach, expect, test } from "bun:test"
import type { Agent } from "@opencode/schema/agent"
import { Mcp } from "@opencode/schema/mcp"
import { Effect, Exit, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-registry-"))
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

// The build agent's row for an MCP tool, stored off; returns the published snapshot.
async function mcpRowOff(f: Awaited<ReturnType<typeof fixture>>, item = "tool:docs_lookup") {
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
const docsTool = {
  name: "lookup",
  description: "Look a page up in the docs.",
  input: { type: "object", properties: {} },
  output: {},
  options: { namespace: "docs", codemode: true },
  origin: { type: "mcp", name: "docs" },
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
      { type: "customization", level: "project", agent: "build", item: "tool:docs_lookup", section: null, state: "off", basedOn: "", updated: "" },
    ],
  })
  expect(saved.ok).toBe(true)
  // The server connects: its tool joins the registry after that publish.
  await runRegistration(f.ctx.tool.transform, (editor) => editor.add(docsTool as never))

  // Control: nothing Plus hears refreshes it, so the off row is never applied.
  expect(await until(() => denies(f.agents.state.get("build"), "docs_lookup"), 400)).toBe(false)

  // Watching the registry: a rebuild whose tools differ from the last discovery republishes.
  const scope = await Effect.runPromise(Scope.make())
  scopes.push(scope)
  await Effect.runPromise(watchToolRegistry(f.ctx, f.state).pipe(Scope.provide(scope)))
  expect(await until(() => denies(f.agents.state.get("build"), "docs_lookup"))).toBe(true)
  // A publish applies the agents before it records its fingerprint: let that publish finish.
  expect(await until(() => f.state.fingerprint?.includes('{"id":"tool:docs_lookup"') === true)).toBe(true)

  // And it settles: its own registry reads list the same tools, so no further publish follows.
  const fingerprint = f.state.fingerprint
  const revision = f.state.projectRevision
  await Bun.sleep(400)
  expect([f.state.fingerprint, f.state.projectRevision]).toEqual([fingerprint, revision])
})

test("an MCP server is known only after it has connected once", async () => {
  // A server never seen has no rows and no denial.
  const f = await fixture([["docs", new Mcp.LocalConfig({ type: "local", command: ["their-docs"] })]])
  await mcpRowOff(f)
  expect(denies(f.agents.state.get("build"), "docs_lookup")).toBe(false)
  // It connects and registers; Plus remembers what it registered.
  const scope = await Effect.runPromise(Scope.make())
  scopes.push(scope)
  await Effect.runPromise(watchToolRegistry(f.ctx, f.state).pipe(Scope.provide(scope)))
  const registration = await runRegistration(f.ctx.tool.transform, (editor) => editor.add(docsTool as never))
  expect(await until(() => denies(f.agents.state.get("build"), "docs_lookup"))).toBe(true)
  expect((await loadKnownMcpTools()).get("docs")?.map((tool) => tool.name)).toEqual(["lookup"])
  expect(knownMcpToolsPath().startsWith(f.root)).toBe(true)
  // Next start: the server has not connected yet, and the remembered tool still carries the off row.
  await Effect.runPromise(registration.dispose)
  const next = await fixture([["docs", new Mcp.LocalConfig({ type: "local", command: ["their-docs"] })]])
  process.env.XDG_DATA_HOME = path.join(f.root, "data")
  await mcpRowOff(next)
  expect(denies(next.agents.state.get("build"), "docs_lookup")).toBe(true)
})

test("known tools follow what a server registered; disabled and connected servers get no stand-ins", () => {
  const registered = { ...docsTool, id: "docs_lookup" } as never
  const learned = learnMcpTools(new Map(), [registered])
  expect(learned?.get("docs")).toEqual([{ name: "lookup", description: "Look a page up in the docs.", input: { type: "object", properties: {} } }])
  expect(learnMcpTools(learned ?? new Map(), [registered])).toBeUndefined()
  const known = learned ?? new Map()
  const pending = pendingMcpTools([], [["docs", new Mcp.LocalConfig({ type: "local", command: ["x"] })]], known)
  expect(pending.map((tool) => [tool.id, tool.options?.namespace, tool.origin])).toEqual([["docs_lookup", "docs", { type: "mcp", name: "docs" }]])
  expect(pendingMcpTools([registered], [["docs", new Mcp.LocalConfig({ type: "local", command: ["x"] })]], known)).toEqual([])
  expect(pendingMcpTools([], [["docs", new Mcp.LocalConfig({ type: "local", command: ["x"], disabled: true })]], known)).toEqual([])
})
