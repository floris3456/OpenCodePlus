import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import type { Tool } from "@opencode/schema/tool"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Layer, Schema } from "effect"
import { apply, type ApplyInput } from "../src/instructions/apply.js"
import { discover } from "../src/instructions/discover.js"
import { fingerprint, scopesOf, type CustomizationRecord, type Level } from "../src/instructions/model.js"
import { CodeModeCatalog } from "../../core/src/codemode/catalog.js"
import { CodeModeInstructions } from "../../core/src/codemode/instructions.js"
import { Tool as CoreTool } from "../../core/src/tool.js"
import { Image } from "../../core/src/image.js"
import { LayerNode } from "../../util/src/effect/layer-node.js"
import { agentHarness, context } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function agentInfo(id: string, system: string): Agent.Info {
  return { ...Agent.Info.default(Agent.ID.make(id)), system }
}

type McpToolEntry = Tool.Info & { readonly id: string; readonly origin: { type: "mcp"; name: string } }

function mcpTool(namespace: string, name: string, description: string): McpToolEntry {
  const id = `${namespace.replaceAll(".", "_")}_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`
  return {
    id,
    name,
    description,
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace },
    origin: { type: "mcp", name: namespace },
    execute: () => Effect.die("unused tool.execute"),
  }
}

function toolDomainFor(tools: readonly (Tool.Info & { readonly id: string })[]) {
  const live = tools.map((tool) => ({ ...tool }))
  const editor: ToolEditor = {
    list: () => live,
    get: (id) => live.find((entry) => entry.id === id),
    namespace: () => {},
    add: () => {},
    update: () => {},
    remove: () => {},
  }
  return {
    transform: (callback: (editor: ToolEditor) => void) =>
      Effect.sync(() => {
        callback(editor)
        return { dispose: Effect.void }
      }),
    reload: () => Effect.void,
    hook: () => Effect.die("unused tool.hook"),
  }
}

function mcpDomainFor(server: string) {
  const servers: [string, { type: "remote"; url: string }][] = [[server, { type: "remote", url: "https://example.test" }]]
  return {
    list: () => Effect.die("unused mcp.list"),
    transform: (callback: (editor: {
      list: () => typeof servers
      get: (name: string) => { type: "remote"; url: string } | undefined
      set: () => void
      update: () => void
      remove: () => void
    }) => void) =>
      Effect.sync(() => {
        callback({
          list: () => servers,
          get: (name: string) => servers.find(([entry]) => entry === name)?.[1],
          set: () => {},
          update: () => {},
          remove: () => {},
        })
        return { dispose: Effect.void }
      }),
    reload: () => Effect.void,
  }
}

function pluginTool(namespace: string, name: string, description: string): Tool.Info & { readonly id: string; readonly origin: { type: "plugin"; name: string } } {
  const id = `${namespace.replaceAll(".", "_")}_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`
  return {
    id,
    name,
    description,
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace, codemode: true, permission: `${namespace}.${name}` },
    origin: { type: "plugin", name: "opencode.plus" },
    execute: () => Effect.die("unused tool.execute"),
  }
}

function makeInput(overrides: Partial<ApplyInput> & { items: ApplyInput["items"] }): ApplyInput {
  return {
    agents: [{ id: "opus-orchestrator", level: "project" as Level }],
    records: [],
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
    ...overrides,
  }
}

test("off on team-query.diff denies that tool and drops it from the code-mode catalog", async () => {
  const agents = agentHarness([agentInfo("opus-orchestrator", "upstream")])
  const status = mcpTool("team-query", "status", "team-query status checks current queue")
  const diff = mcpTool("team-query", "diff", "team-query diff shows pending changes")
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([status, diff]),
    mcp: mcpDomainFor("team-query"),
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  const statusItem = discovered.items.find((item) => item.id === "tool:team-query_status")
  const diffItem = discovered.items.find((item) => item.id === "tool:team-query_diff")
  if (!statusItem) throw new Error("expected tool:team-query_status in discovery")
  if (!diffItem) throw new Error("expected tool:team-query_diff in discovery")
  expect(statusItem.codemode).toBe(true)
  expect(diffItem.codemode).toBe(true)

  const records: CustomizationRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "opus-orchestrator",
      item: "tool:team-query_diff",
      section: null,
      state: "off",
      basedOn: fingerprint("upstream"),
      updated: UPDATED,
    },
  ]
  const applied = await apply(
    ctx,
    makeInput({ items: discovered.items, scopes: scopesOf(discovered.agents), records }),
  )
  expect(applied.registrations).toHaveLength(1)

  const permissions = agents.state.get("opus-orchestrator")?.permissions ?? []
  expect(permissions).toContainEqual({ action: "team-query_diff", resource: "*", effect: "deny" })
  expect(permissions.some((rule) => rule.action === "team-query_status" && rule.effect === "deny")).toBe(false)

  const toolLayer = LayerNode.compile(LayerNode.group([CoreTool.node]), {
    replacements: [
      Image.node.replace(Layer.mock(Image.Service, { normalize: (_resource, content) => Effect.succeed(content) })),
    ],
  })
  const { control, snapshot } = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* CoreTool.Service
      yield* registry.transform((editor) => {
        editor.add({
          name: status.name,
          description: status.description,
          input: status.input,
          output: status.output,
          options: status.options,
          execute: () => Effect.die("unused tool.execute"),
        })
        editor.add({
          name: diff.name,
          description: diff.description,
          input: diff.input,
          output: diff.output,
          options: diff.options,
          execute: () => Effect.die("unused tool.execute"),
        })
      })
      const control = yield* registry.snapshot([])
      const snapshot = yield* registry.snapshot(permissions)
      return { control, snapshot }
    }).pipe(Effect.provide(toolLayer), Effect.scoped),
  )
  if (!control.codeModeCatalog) throw new Error("expected codeModeCatalog in control snapshot")
  const controlPaths = Object.keys(CodeModeCatalog.flattenToRecord(control.codeModeCatalog))
  expect(controlPaths).toContain("team-query.status")
  expect(controlPaths).toContain("team-query.diff")
  if (!snapshot.codeModeCatalog) throw new Error("expected codeModeCatalog in snapshot")
  const paths = Object.keys(CodeModeCatalog.flattenToRecord(snapshot.codeModeCatalog))
  expect(paths).toContain("team-query.status")
  expect(paths).not.toContain("team-query.diff")

  const summary = CodeModeCatalog.summarize(snapshot.codeModeCatalog)
  const rendered = CodeModeInstructions.render(summary)
  expect(rendered).toContain('tools["team-query"].status')
  expect(rendered).not.toContain('tools["team-query"].diff')
  expect(rendered).toContain("team-query status checks current queue")
  expect(rendered).not.toContain("team-query diff shows pending changes")
})

test("off on team.diff for a defaults-level team agent denies that tool and drops it from the catalog", async () => {
  // Team-provided agents are not host upstream: the built-in team registry
  // contributes muse-implementer with scope defaults, so the host starts
  // without it and apply must still install the deny (upsert, not skip).
  const agents = agentHarness([])
  const status = pluginTool("team", "status", "team status shows run state")
  const diff = pluginTool("team", "diff", "team diff shows pending changes")
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([status, diff]),
    mcp: mcpDomainFor("team-query"),
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  const diffItem = discovered.items.find((item) => item.id === "tool:team_diff")
  if (!diffItem) throw new Error("expected tool:team_diff in discovery")
  expect(diffItem.codemode).toBe(true)

  const records: CustomizationRecord[] = [
    {
      type: "customization",
      level: "defaults",
      agent: "muse-implementer",
      item: "tool:team_diff",
      section: null,
      state: "off",
      basedOn: fingerprint("upstream"),
      updated: UPDATED,
    },
  ]
  const teamAgents = [{ id: "muse-implementer", scope: "defaults" as const }]
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: [{ id: "muse-implementer", level: "defaults" as Level }],
      scopes: scopesOf(teamAgents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(1)

  const permissions = agents.state.get("muse-implementer")?.permissions ?? []
  expect(permissions).toContainEqual({ action: "team_diff", resource: "*", effect: "deny" })

  const toolLayer = LayerNode.compile(LayerNode.group([CoreTool.node]), {
    replacements: [
      Image.node.replace(Layer.mock(Image.Service, { normalize: (_resource, content) => Effect.succeed(content) })),
    ],
  })
  const { snapshot } = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* CoreTool.Service
      yield* registry.transform((editor) => {
        editor.add({
          name: status.name,
          description: status.description,
          input: status.input,
          output: status.output,
          options: status.options,
          execute: () => Effect.die("unused tool.execute"),
        })
        editor.add({
          name: diff.name,
          description: diff.description,
          input: diff.input,
          output: diff.output,
          options: diff.options,
          execute: () => Effect.die("unused tool.execute"),
        })
      })
      const snapshot = yield* registry.snapshot(permissions)
      return { snapshot }
    }).pipe(Effect.provide(toolLayer), Effect.scoped),
  )
  if (!snapshot.codeModeCatalog) throw new Error("expected codeModeCatalog in snapshot")
  const paths = Object.keys(CodeModeCatalog.flattenToRecord(snapshot.codeModeCatalog))
  expect(paths).toContain("team.status")
  expect(paths).not.toContain("team.diff")
})
