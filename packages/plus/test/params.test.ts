import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { Tool } from "@opencode/schema/tool"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { z } from "zod"
import { apply, type ApplyInput, type ToolPlan } from "../src/instructions/apply.js"
import { computeChangeNote, createPlanSet, SessionPinManager } from "../src/instructions/cache-safe.js"
import { discover } from "../src/instructions/discover.js"
import { fingerprint, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { reset, saveText, setEnabled, toggle } from "../src/instructions/ops.js"
import { editInputSchema, toolParameters } from "../src/instructions/parameters.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"
import { canExpand } from "../src/tui/instructions/workspace.js"
import { context } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

// A Code Mode search tool shaped like Plus's own tavily_search: an MCP tool
// whose input is JSON Schema already.
const searchInput = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to search for" },
    include_domains: { type: "array", items: { type: "string" }, description: "Only these domains" },
    depth: { $ref: "#/$defs/Depth" },
    limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
  },
  required: ["query"],
  $defs: { Depth: { type: "string", enum: ["basic", "advanced"], description: "How deep to search" } },
}

const searchTool: Tool.Info & { readonly id: string } = {
  id: "search_tavily_search",
  name: "tavily_search",
  description: "Search the web",
  input: searchInput as never,
  options: { namespace: "search" },
  execute: () => Effect.die("unused tool.execute"),
}

const readTool: Tool.Info & { readonly id: string } = {
  id: "reader",
  name: "reader",
  description: "Read a file",
  input: Schema.Struct({
    path: Schema.String.annotate({ description: "The file to read" }),
    offset: Schema.optional(Schema.Number).annotate({ description: "First line to read" }),
  }),
  options: { codemode: false },
  execute: () => Effect.die("unused tool.execute"),
}

test("a tool's parameters come from its input schema: JSON Schema, Effect Schema and zod", () => {
  expect(toolParameters(searchInput)).toEqual([
    { name: "query", type: "string", required: true, description: "What to search for" },
    { name: "include_domains", type: "string[]", required: false, description: "Only these domains" },
    { name: "depth", type: `"basic" | "advanced"`, required: false, description: "How deep to search" },
    { name: "limit", type: "integer | null", required: false, description: "" },
  ])
  expect(toolParameters(readTool.input)).toEqual([
    { name: "path", type: "string", required: true, description: "The file to read" },
    { name: "offset", type: "number | null", required: false, description: "First line to read" },
  ])
  expect(toolParameters(z.object({ url: z.string().describe("The page"), raw: z.boolean().optional() }))).toEqual([
    { name: "url", type: "string", required: true, description: "The page" },
    { name: "raw", type: "boolean", required: false, description: "" },
  ])
  // Computed once per schema object.
  expect(toolParameters(searchInput)).toBe(toolParameters(searchInput))
})

test("editing a schema replaces descriptions and drops switched-off parameters without touching the original", () => {
  const before = JSON.stringify(searchInput)
  const edited = editInputSchema(searchInput, [
    { name: "query", enabled: true, text: "Search terms" },
    { name: "include_domains", enabled: false, text: "Only these domains" },
    { name: "missing", enabled: false, text: "" },
  ])
  expect(edited.properties.query).toEqual({ type: "string", description: "Search terms" })
  expect(Object.keys(edited.properties)).toEqual(["query", "depth", "limit"])
  expect(edited.required).toEqual(["query"])
  expect(JSON.stringify(searchInput)).toBe(before)
  // Nothing that applies: the very same object, so an unedited request stays byte-identical.
  expect(editInputSchema(searchInput, [{ name: "missing", enabled: false, text: "" }])).toBe(searchInput)
  expect(editInputSchema(searchInput, [])).toBe(searchInput)
})

const param = (tool: string, name: string, text: string, extra: Partial<Item> = {}): Item => ({
  id: `param:${tool}:${name}`,
  kind: "param",
  group: "native",
  title: name,
  text,
  enabled: true,
  fingerprint: fingerprint(text),
  paramTool: tool,
  paramType: "string",
  ...extra,
})

function memoInput(records: CustomizationRecord[] = [], items: Item[] = []): MemoInput {
  return {
    items: [
      { id: "tool:reader", kind: "tool", group: "native", title: "reader", text: "Read a file", enabled: true, fingerprint: fingerprint("Read a file") },
      param("reader", "path", "The file to read", { required: true }),
      param("reader", "offset", "First line to read", { paramType: "number" }),
      ...items,
    ],
    records,
    agents: [{ id: "alpha", scope: "project" }],
    links: [{ type: "link", level: "project", agent: "alpha", preset: { kind: "agent", id: "build" }, updated: UPDATED }],
  }
}

const rowOf = (input: MemoInput, item: string) => {
  const node = expandedTree(input).find((candidate) => candidate.id === `item:project:alpha:${item}`)
  if (node === undefined) throw new Error(`no row for ${item}`)
  return node
}

test("each tool row lists its parameters; an optional one switches off, a required one refuses", () => {
  const input = memoInput()
  const nodes = expandedTree(input)
  const tool = nodes.findIndex((node) => node.id === "item:project:alpha:tool:reader")
  const group = nodes.findIndex((node) => node.id === "group:project:alpha:tool:reader:parameters")
  expect(tool).toBeGreaterThan(-1)
  expect(group).toBeGreaterThan(tool)
  expect(nodes[group]?.label).toBe("Parameters")
  expect(rowOf(input, "param:reader:path").label).toBe("path: string (required)")
  expect(rowOf(input, "param:reader:offset").label).toBe("offset: number")
  // A parameter row only ever shows inside its tool's Parameters group, at every level.
  const parents = nodes.flatMap((node, index) => {
    if (node.kind !== "item" || !node.id.includes(":param:")) return []
    return [nodes.slice(0, index).findLast((above) => above.depth === node.depth - 1)?.label]
  })
  expect(parents.length).toBeGreaterThan(2)
  expect(new Set(parents)).toEqual(new Set(["Parameters"]))

  // B7: a parameter's description is a text row, so it now exposes sections
  // and is expandable (line 150's "leaf" assertion moved to the Description).
  expect(rowOf(input, "param:reader:offset").add).toBe("section")
  expect(nodes.some((node) => node.id === "section:project:alpha:param:reader:offset:whole")).toBe(true)

  const refused = toggle(input, rowOf(input, "param:reader:path").id)
  if (!("refusal" in refused)) throw new Error("expected a refusal")
  expect(refused.refusal).toBe(`"path: string (required)" is required by its tool and cannot be switched off`)
  const refusedSet = setEnabled(input, rowOf(input, "param:reader:path").id, false)
  expect("refusal" in refusedSet).toBe(true)

  expect(canExpand(rowOf(input, "tool:reader"))).toBe(true)

  const off = toggle(input, rowOf(input, "param:reader:offset").id)
  if ("refusal" in off) throw new Error(off.refusal)
  expect(off.records).toContainEqual(expect.objectContaining({ item: "param:reader:offset", agent: "alpha", state: "off" }))
  expect(rowOf(memoInput(off.records), "param:reader:offset").badges.state).toBe("off")
})

test("a parameter description edits like a text row, and reset brings back the tool's own", () => {
  const input = memoInput()
  const edited = saveText(input, rowOf(input, "param:reader:path").id, "Absolute path of the file")
  if ("refusal" in edited) throw new Error(edited.refusal)
  expect(edited.records).toContainEqual(
    expect.objectContaining({ item: "param:reader:path", text: "Absolute path of the file", basedOn: fingerprint("The file to read") }),
  )
  const after = memoInput(edited.records)
  expect(rowOf(after, "param:reader:path").badges.modified).toBe(true)
  const restored = reset(after, rowOf(after, "param:reader:path").id)
  if ("refusal" in restored) throw new Error(restored.refusal)
  expect(restored.records.some((record) => record.item === "param:reader:path")).toBe(false)
})

test("a changed upstream parameter description marks the edited row for review", () => {
  const record: CustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "param:reader:offset",
    section: null,
    text: "Where to start",
    basedOn: fingerprint("First line to read"),
    updated: UPDATED,
  }
  expect(rowOf(memoInput([record]), "param:reader:offset").badges.review ?? false).toBe(false)
  const changed = memoInput([record])
  const upstream = changed.items.map((item) =>
    item.id === "param:reader:offset" ? { ...item, text: "First line to read (1-based)", fingerprint: fingerprint("First line to read (1-based)") } : item,
  )
  expect(rowOf({ ...changed, items: upstream }, "param:reader:offset").badges.review).toBe(true)
})

function toolDomainFor(tools: readonly (Tool.Info & { readonly id: string })[]) {
  const editor: ToolEditor = {
    list: () => tools,
    get: (id) => tools.find((tool) => tool.id === id),
    namespace: () => {},
    add: () => {},
    update: () => {},
    remove: () => {},
  }
  return { transform: (callback: (editor: ToolEditor) => void) => Effect.sync(() => callback(editor)).pipe(Effect.as({ dispose: Effect.void })) } as never
}

function hookContext() {
  const hooks: { context: ((event: SessionHooks["context"]) => Effect.Effect<void>)[]; catalog: ((event: SessionHooks["catalog"]) => Effect.Effect<void>)[] } = { context: [], catalog: [] }
  const ctx = context({
    tool: toolDomainFor([readTool, searchTool]),
    session: {
      hook: (name, callback) => {
        if (name === "context") hooks.context.push(callback as never)
        if (name === "catalog") hooks.catalog.push(callback as never)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  return { ctx, hooks }
}

const record = (item: string, fields: Partial<CustomizationRecord>, basedOn: string): CustomizationRecord => ({
  type: "customization",
  level: "project",
  agent: "alpha",
  item,
  section: null,
  basedOn: fingerprint(basedOn),
  updated: UPDATED,
  ...fields,
})

async function applied(records: CustomizationRecord[]) {
  const { ctx, hooks } = hookContext()
  const discovered = await discover({ ctx, records, baseTemplates: [], activeBase: () => undefined })
  const input: ApplyInput = {
    items: discovered.items,
    agents: [
      { id: "alpha", level: "project" },
      { id: "beta", level: "project" },
    ],
    records,
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
  }
  return { result: await apply(ctx, input), hooks, discovered }
}

const contextEvent = (agent: string): SessionHooks["context"] => ({
  sessionID: Session.ID.make(`ses_params_${agent}`),
  agent: Agent.ID.make(agent),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
  system: [{ type: "text", text: "base" }],
  messages: [],
  options: {},
  tools: {
    reader: {
      description: "Read a file",
      input: {
        type: "object",
        properties: { path: { type: "string", description: "The file to read" }, offset: { type: "number", description: "First line to read" } },
        required: ["path"],
      },
    },
  },
})

test("discovery lists every tool's parameters as rows of that tool", async () => {
  const { discovered } = await applied([])
  const params = discovered.items.filter((item) => item.kind === "param")
  expect(params.map((item) => [item.id, item.paramType, item.required === true, item.text])).toEqual([
    ["param:reader:path", "string", true, "The file to read"],
    ["param:reader:offset", "number | null", false, "First line to read"],
    ["param:search_tavily_search:query", "string", true, "What to search for"],
    ["param:search_tavily_search:include_domains", "string[]", false, "Only these domains"],
    ["param:search_tavily_search:depth", `"basic" | "advanced"`, false, "How deep to search"],
    ["param:search_tavily_search:limit", "integer | null", false, ""],
  ])
})

test("with no parameter edits nothing is installed and tool definitions stay byte-identical", async () => {
  const { result, hooks } = await applied([])
  expect(result.registrations).toHaveLength(0)
  expect(hooks.context).toHaveLength(0)
  expect(hooks.catalog).toHaveLength(0)
})

test("an edited description and a switched-off parameter reach the native definition of that agent only", async () => {
  const { result, hooks } = await applied([
    record("param:reader:path", { text: "Absolute path of the file" }, "The file to read"),
    record("param:reader:offset", { state: "off" }, "First line to read"),
    // A required parameter stays even when a record says off.
    record("param:search_tavily_search:query", { state: "off" }, "What to search for"),
  ])
  expect(result.tools.find((plan) => plan.tool === "reader")).toEqual({
    agent: "alpha",
    tool: "reader",
    enabled: true,
    text: "Read a file",
    params: [
      { name: "path", enabled: true, text: "Absolute path of the file" },
      { name: "offset", enabled: false, text: "First line to read" },
    ],
  })
  const run = hooks.context[0]
  if (run === undefined) throw new Error("missing context hook")
  const alpha = contextEvent("alpha")
  const beta = contextEvent("beta")
  const betaInput = beta.tools.reader?.input
  await Effect.runPromise(run(alpha))
  await Effect.runPromise(run(beta))
  expect(alpha.tools.reader?.input).toEqual({
    type: "object",
    properties: { path: { type: "string", description: "Absolute path of the file" } },
    required: ["path"],
  })
  // Control: an agent without edits keeps the very same schema object.
  expect(beta.tools.reader?.input).toBe(betaInput)
})

test("a Code Mode tool's edited parameters reach its catalog entry by replacing its input", async () => {
  const { hooks } = await applied([
    record("param:search_tavily_search:query", { text: "Search terms" }, "What to search for"),
    record("param:search_tavily_search:include_domains", { state: "off" }, "Only these domains"),
  ])
  const run = hooks.catalog[0]
  if (run === undefined) throw new Error("missing catalog hook")
  const event = (agent: string): SessionHooks["catalog"] => ({
    sessionID: Session.ID.make(`ses_catalog_${agent}`),
    agent: Agent.ID.make(agent),
    tools: { "search.tavily_search": { description: "Search the web", pinned: false, input: searchInput } },
  })
  const alpha = event("alpha")
  const beta = event("beta")
  await Effect.runPromise(run(alpha))
  await Effect.runPromise(run(beta))
  const input = alpha.tools["search.tavily_search"]?.input as typeof searchInput
  expect(input).not.toBe(searchInput)
  expect(input.properties.query).toEqual({ type: "string", description: "Search terms" })
  expect(Object.keys(input.properties)).toEqual(["query", "depth", "limit"])
  expect(beta.tools["search.tavily_search"]?.input).toBe(searchInput)
})

test("a running chat hears that a tool's parameters changed, and sees them at its next rebuild", () => {
  const planSet = (native: ToolPlan[]) =>
    createPlanSet({
      roles: new Map(),
      base: [],
      native,
      instructions: [],
      scrubByAgent: new Map(),
      needsNarrowing: false,
      permissions: { toolEnabled: () => false, rows: () => [], toolRows: () => [], ruleRows: () => [], teamMembers: new Set(), describe: () => undefined },
      customByAgent: new Set(),
    })
  const tool: ToolPlan = { agent: "alpha", tool: "reader", enabled: true, text: "Read a file" }
  const pin = new SessionPinManager().pinSession("ses_note", { providerID: "test", id: "test" }, planSet([tool]))
  const note = computeChangeNote(pin, planSet([{ ...tool, params: [{ name: "offset", enabled: false, text: "First line to read" }] }]), "alpha")
  expect(note?.noteText).toContain(`Tool "reader" parameters changed (available after the next rebuild).`)
  expect(computeChangeNote(pin, planSet([tool]), "alpha")).toBeUndefined()
})
