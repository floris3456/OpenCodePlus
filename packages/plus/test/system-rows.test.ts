import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSystemRow } from "../src/agents/system.js"
import { createHandlers, createState } from "../src/index.js"
import { apply, type ApplyInput } from "../src/instructions/apply.js"
import { discover } from "../src/instructions/discover.js"
import { groupScope, layoutRefusal, type OrderRecord } from "../src/instructions/folders.js"
import { fingerprint, type CustomizationRecord, type Item, type Level } from "../src/instructions/model.js"
import { planFolderCreate, planRowMove, planSystemMove } from "../src/instructions/ops.js"
import { userSystemFile } from "../src/instructions/paths.js"
import { chainContext } from "../src/instructions/presets.js"
import { expandedTree, type TreeNode } from "../src/instructions/tree.js"
import { agentHarness, agentInfo, context, fullContext, toolHarness } from "./harness.js"

// User-created System rows: a global file per row that every level and
// catalogue lists and Plus plans per agent like the Tools and rules row.

const UPDATED = "2026-01-01T00:00:00.000Z"
const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-system-rows-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return path.join(root, "project")
}

function throwingContext(captured: { current?: { type: string; message: string; data?: unknown } }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

test("system.create adds a deletable System row; ids are slugs and built-in ids are refused", async () => {
  const project = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project, agents: [agentInfo("alpha", "upstream")] }), createState())
  const created = await Effect.runPromise(
    handlers["system.create"]({ id: "working-rules", title: "Working rules", text: "# Working rules\n\nSay what you checked." }, throwingContext({})),
  )
  expect(created).toEqual({ id: "working-rules" })
  expect(await Bun.file(userSystemFile("working-rules")).text()).toBe("# Working rules\n\nSay what you checked.")

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const row = snapshot.items.find((item) => item.id === "system:working-rules")
  expect(row).toMatchObject({ kind: "system", group: "none", title: "Working rules", enabled: true, userSystem: true })
  expect(row?.fingerprint).toBe(fingerprint("# Working rules\n\nSay what you checked."))

  for (const [input, type] of [
    [{ id: "working-rules", title: "Again", text: "x" }, "system.exists"],
    [{ id: "tools-and-rules", title: "Shadow", text: "x" }, "system.invalid"],
    [{ id: "Working Rules", title: "Spaces", text: "x" }, "system.invalid"],
    [{ id: "../escape", title: "Escape", text: "x" }, "system.invalid"],
  ] as const) {
    const captured: { current?: { type: string; message: string; data?: unknown } } = {}
    const exit = await Effect.runPromiseExit(handlers["system.create"](input, throwingContext(captured)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(captured.current?.type).toBe(type)
  }

  expect(await Effect.runPromise(handlers["system.delete"]({ id: "working-rules" }, throwingContext({})))).toEqual({ id: "working-rules" })
  const after = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(after.items.some((item) => item.id === "system:working-rules")).toBe(false)
  const missing: { current?: { type: string; message: string; data?: unknown } } = {}
  const exit = await Effect.runPromiseExit(handlers["system.delete"]({ id: "working-rules" }, throwingContext(missing)))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(missing.current?.type).toBe("system.missing")
})

function sessionEvent(agentID: string): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make("ses_system_rows"),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
    system: [],
    messages: [],
    options: {},
    tools: {},
  }
}

function input(items: readonly Item[], records: readonly CustomizationRecord[], agents: readonly string[]): ApplyInput {
  const sources = agents.map((id) => ({ id, scope: "project" as const, origin: "user" as const }))
  return {
    items,
    records,
    splits: [],
    agents: agents.map((id) => ({ id, level: "project" as Level })),
    scopes: chainContext({
      agents: sources,
      items,
      links: agents.map((agent) => ({ type: "link", level: "project", agent, preset: { kind: "agent", id: "build" }, updated: UPDATED })),
    }),
  }
}

function off(agent: string, item: string): CustomizationRecord {
  return { type: "customization", level: "project", agent, item, section: null, state: "off", basedOn: "", updated: UPDATED }
}

const rulesText = `# Working rules

## Honest work
Say what you checked.

## Teams
<!-- requires: tool:team_check -->
Never claim approval you cannot quote.
`

test("a System row reaches each agent that has it on, keyed by its file, with its conditions applied", async () => {
  await tempRoot()
  await createSystemRow("working-rules", "Working rules", rulesText)
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream"), agentInfo("gamma", "upstream")]).domain,
    tool: toolHarness([{ id: "team_check", description: "Run a check", options: { codemode: false } }]).domain,
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  const row = discovered.items.find((item) => item.id === "system:working-rules")
  expect(row).toMatchObject({ kind: "system", title: "Working rules", text: rulesText, userSystem: true })

  const records = [off("beta", "system:working-rules"), off("gamma", "tool:team_check")]
  await apply(ctx, input(discovered.items, records, ["alpha", "beta", "gamma"]))
  const run = callbacks[0]
  if (run === undefined) throw new Error("missing context hook")
  const events = { alpha: sessionEvent("alpha"), beta: sessionEvent("beta"), gamma: sessionEvent("gamma") }
  await Effect.runPromise(run(events.alpha))
  await Effect.runPromise(run(events.beta))
  await Effect.runPromise(run(events.gamma))
  const partOf = (event: SessionHooks["context"]) =>
    event.system.find((entry) => (entry.metadata as { instruction?: { path?: string } } | undefined)?.instruction?.path === userSystemFile("working-rules"))

  expect(partOf(events.alpha)?.text).toBe("# Working rules\n\n## Honest work\nSay what you checked.\n\n## Teams\nNever claim approval you cannot quote.")
  // Switched off for beta: no part at all.
  expect(partOf(events.beta)).toBeUndefined()
  // gamma has team_check off, so the section that requires it is left out.
  expect(partOf(events.gamma)?.text).toBe("# Working rules\n\n## Honest work\nSay what you checked.")
})

test("the tree offers System rows from the System group and lets the user row be deleted", async () => {
  await tempRoot()
  await createSystemRow("working-rules", "Working rules", rulesText)
  const ctx = context({ agent: agentHarness([agentInfo("alpha", "upstream")]).domain })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  const nodes = expandedTree({
    agents: discovered.agents,
    items: discovered.items,
    records: [],
    teams: [],
  })
  const row = nodes.find((node) => node.id === "item:defaults::system:working-rules")
  expect(row?.label).toBe("Working rules")
  expect(row?.actions?.remove).toBe(true)
  expect(nodes.find((node) => node.id === "group:defaults::system")?.add).toBe("system")
})

test("System is one flat list in the order the request carries its parts, OpenCode's own parts read-only", async () => {
  await tempRoot()
  await createSystemRow("working-rules", "Working rules", rulesText)
  const ctx = context({ agent: agentHarness([agentInfo("alpha", "upstream")]).domain })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  const list = systemList(expandedTree({ agents: discovered.agents, items: discovered.items, records: [], teams: [] }), "group:defaults::system")
  expect(list.map((node) => node.label)).toEqual([
    "Role/persona",
    "Base",
    "Your model",
    "Code Mode",
    "MCP servers",
    "References",
    "Skills",
    "AGENTS.md files",
    "Date",
    "Environment",
    "Session entries",
    "Worktree note",
    "Tools and rules",
    "Working rules",
  ])
  // Role/persona is off, so the base prompt holds the first place.
  expect(list[0]?.badges.slotNote).toBe("base prompt sent instead")
  expect(list[1]?.badges.slotNote).toBeUndefined()
  const opencode = list.filter((node) => node.id.startsWith("item:defaults::system:opencode/"))
  expect(opencode).toHaveLength(10)
  expect(opencode.every((node) => node.badges.fromLabel === "OpenCode" && Object.values(node.actions ?? {}).every((action) => action !== true))).toBe(true)
})

// The direct rows of one System group, in list order.
function systemList(nodes: readonly TreeNode[], groupId: string): TreeNode[] {
  const at = nodes.findIndex((node) => node.id === groupId)
  const depth = nodes[at]!.depth
  const rest = nodes.slice(at + 1)
  const end = rest.findIndex((node) => node.depth <= depth)
  return rest.slice(0, end === -1 ? undefined : end).filter((node) => node.depth === depth + 1)
}

type SystemArray = SessionHooks["context"]["system"]

// A system array as core and its plugins hand it to Plus: the first part, then
// each part identified by its instruction key (and file), plus one part a
// third-party plugin added without any.
function requestSystem(): SystemArray {
  const part = (text: string, instruction?: { key?: string; path?: string }) =>
    instruction === undefined ? { type: "text" as const, text } : { type: "text" as const, text, metadata: { instruction } }
  return [
    part("base"),
    part("identity", { key: "core/identity" }),
    part("codemode", { key: "core/codemode" }),
    part("mcp", { key: "core/mcp-guidance" }),
    part("references", { key: "core/reference-guidance" }),
    part("skills", { key: "core/skill-guidance" }),
    part("plugin"),
    part("agents", { key: "core/instructions/abc", path: "/repo/AGENTS.md" }),
    part("date", { key: "core/date" }),
    part("environment", { key: "core/environment" }),
    part("entry", { key: "api/note" }),
    part("worktree", { key: "core/tools-note" }),
  ]
}

function order(group: string, items: readonly string[], level: "project" | "global" = "global"): OrderRecord {
  return { type: "order", level, scope: groupScope(group), items, updated: UPDATED }
}

// The request's text for one agent after Plus's context hook.
async function requestFor(agent: string, orders: readonly OrderRecord[] | undefined): Promise<string[]> {
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")]).domain,
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  await apply(ctx, { ...input(discovered.items, [], ["alpha", "beta"]), ...(orders === undefined ? {} : { orders }) })
  const event = { ...sessionEvent(agent), system: requestSystem() }
  await Effect.runPromise(Effect.forEach(callbacks, (run) => run(event), { discard: true }))
  return event.system.map((part) => part.text.startsWith("# Working rules") ? "working-rules" : part.text)
}

const requestOrder = ["base", "identity", "codemode", "mcp", "references", "skills", "plugin", "agents", "date", "environment", "entry", "worktree", "working-rules"]

test("with no stored System order the request keeps exactly the order core gives it", async () => {
  await tempRoot()
  await createSystemRow("working-rules", "Working rules", "# Working rules\n\nSay what you checked.")
  expect(await requestFor("alpha", undefined)).toEqual(requestOrder)
  expect(await requestFor("alpha", [])).toEqual(requestOrder)
  // An order stored for another agent, or a legacy tab order, moves nothing.
  expect(await requestFor("alpha", [order("group:project:beta:system", ["core/date", "first"], "project"), { ...order("", ["system:working-rules"]), scope: "tab:system" }])).toEqual(requestOrder)
})

test("a stored System order reorders the request; an unidentified part travels with the part before it", async () => {
  await tempRoot()
  await createSystemRow("working-rules", "Working rules", "# Working rules\n\nSay what you checked.")
  const stored = [
    "system:working-rules",
    "core/identity",
    "core/codemode",
    "core/mcp-guidance",
    "core/reference-guidance",
    "core/skill-guidance",
    "core/instructions",
    "system:opencodeplus",
    "core/date",
    "first",
    "core/environment",
    "api",
    "core/tools-note",
    "system:tools-and-rules",
  ]
  expect(await requestFor("alpha", [order("group:project:alpha:system", stored, "project")])).toEqual([
    "working-rules", "identity", "codemode", "mcp", "references", "skills", "plugin", "agents", "date", "base", "environment", "entry", "worktree",
  ])
  // beta has no order of its own, so its request is unchanged.
  expect(await requestFor("beta", [order("group:project:alpha:system", stored, "project")])).toEqual(requestOrder)
})

test("an agent inherits the Defaults System order for every agent, and its own order wins", async () => {
  await tempRoot()
  await createSystemRow("working-rules", "Working rules", "# Working rules\n\nSay what you checked.")
  const everyone = order("group:defaults::system", ["first", "core/date", "core/identity"])
  // Missing slots return to their default places after the listed ones.
  const inherited = ["base", "date", "environment", "entry", "worktree", "working-rules", "identity", "codemode", "mcp", "references", "skills", "plugin", "agents"]
  expect(await requestFor("alpha", [everyone])).toEqual(inherited)
  expect(await requestFor("beta", [everyone])).toEqual(inherited)
  const own = order("group:project:alpha:system", ["core/identity", "first"], "project")
  expect(await requestFor("alpha", [everyone, own])).toEqual([
    "identity", "codemode", "mcp", "references", "skills", "plugin", "agents", "date", "environment", "entry", "worktree", "working-rules", "base",
  ])
  expect(await requestFor("beta", [everyone, own])).toEqual(inherited)
})

test("moving a System row stores the owner's complete order, which the tree lists; System refuses folders", async () => {
  await tempRoot()
  await createSystemRow("working-rules", "Working rules", rulesText)
  const ctx = context({ agent: agentHarness([agentInfo("alpha", "upstream")]).domain })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  const memo = { agents: discovered.agents, items: discovered.items, records: [], teams: [] }
  const empty = { folders: [], orders: [] }
  const moved = planSystemMove(memo, empty, "item:defaults::system:opencode/date", { before: "item:defaults::system:role" }, UPDATED)
  if ("refusal" in moved) throw new Error(moved.refusal)
  expect(moved.layout.orders).toEqual([
    order("group:defaults::system", [
      "core/date", "first", "core/identity", "core/codemode", "core/mcp-guidance", "core/reference-guidance", "core/skill-guidance",
      "core/instructions", "system:opencodeplus", "core/environment", "api", "core/tools-note", "system:tools-and-rules", "system:working-rules",
    ]),
  ])
  expect(moved.status).toBe(`Moved "Date" before "Role/persona": the model receives it there`)
  const after = systemList(expandedTree({ ...memo, orders: moved.layout.orders }), "group:defaults::system")
  expect(after.map((node) => node.label).slice(0, 4)).toEqual(["Date", "Role/persona", "Base", "Your model"])
  // planRowMove routes System rows the same way, and the Base group moves with Role/persona.
  const base = planRowMove(memo, empty, "group:defaults::base", { after: "item:defaults::system:working-rules" }, UPDATED)
  if ("refusal" in base) throw new Error(base.refusal)
  expect(base.layout.orders[0]?.items.at(-1)).toBe("first")
  expect(planSystemMove(memo, empty, "group:defaults::base", { after: "item:defaults::system:role" }, UPDATED)).toEqual({
    refusal: `"Base" and "Role/persona" are one part of the request and move together`,
  })
  expect(planSystemMove(memo, empty, "item:defaults::system:working-rules", { into: "group:defaults::base" }, UPDATED)).toEqual({
    refusal: "System has no folders: its list is the order the model receives the parts",
  })
  expect(planFolderCreate(memo, empty, "group:defaults::system", "Mine", UPDATED)).toEqual({
    refusal: "System has no folders: its list is the order the model receives the parts",
  })
  expect(layoutRefusal(moved.layout.folders, moved.layout.orders)).toBeUndefined()
})
