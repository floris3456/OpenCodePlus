import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import type { Tool } from "@opencode/schema/tool"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Deferred, Effect, Schema } from "effect"
import { apply, type ApplyInput } from "../src/instructions/apply.js"
import { discover } from "../src/instructions/discover.js"
import { fingerprint, scopesOf, type CustomizationRecord, type Level } from "../src/instructions/model.js"
import { CodeModeCatalog } from "../../core/src/codemode/catalog.js"
import { CodeModeInstructions } from "../../core/src/codemode/instructions.js"
import { CodeModeTool } from "../../core/src/codemode/tool.js"
import { Wildcard } from "../../core/src/util/wildcard.js"
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

function toolDomainFor(tools: readonly McpToolEntry[]) {
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

function makeInput(overrides: Partial<ApplyInput> & { items: ApplyInput["items"] }): ApplyInput {
  return {
    agents: [{ id: "opus-orchestrator", level: "project" as Level }],
    records: [],
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
    ...overrides,
  }
}

function readTransformTools(ctx: Context): Effect.Effect<readonly (Tool.Info & { readonly id: string })[]> {
  return Effect.scoped(
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
      yield* ctx.tool.transform((editor) => {
        Deferred.doneUnsafe(deferred, Effect.succeed(editor.list()))
      })
      return yield* Deferred.await(deferred)
    }),
  )
}

function whollyDenied(target: string, rules: readonly { action: string; resource: string; effect: string }[]): boolean {
  const match = rules.findLast((rule) => Wildcard.match(target, rule.action))
  if (match === undefined) return false
  return match.resource === "*" && match.effect === "deny"
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

  const live = await Effect.runPromise(readTransformTools(ctx))
  const liveById = new Map(live.map((tool) => [tool.id, tool]))
  expect(liveById.has("team-query_status")).toBe(true)
  expect(liveById.has("team-query_diff")).toBe(true)

  const visible = new Map(
    [...liveById].filter(([id, tool]) => {
      const permission = (tool as { options?: { permission?: string } }).options?.permission ?? id
      if (whollyDenied(permission, permissions)) return false
      if (whollyDenied(id, permissions)) return false
      return true
    }),
  )
  expect(visible.has("team-query_status")).toBe(true)
  expect(visible.has("team-query_diff")).toBe(false)

  const inventory = CodeModeTool.catalog({ tools: visible, namespaces: new Map() })
  const paths = Object.keys(CodeModeCatalog.flattenToRecord(inventory))
  expect(paths).toContain("team-query.status")
  expect(paths).not.toContain("team-query.diff")

  const summary = CodeModeCatalog.summarize(inventory)
  const rendered = CodeModeInstructions.render(summary)
  expect(rendered).toContain('tools["team-query"].status')
  expect(rendered).not.toContain('tools["team-query"].diff')
  expect(rendered).toContain("team-query status checks current queue")
  expect(rendered).not.toContain("team-query diff shows pending changes")
})
