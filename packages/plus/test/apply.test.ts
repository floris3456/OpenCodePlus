import { expect, test } from "bun:test"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import type { Mcp } from "@opencode/schema/mcp"
import { Model } from "@opencode/schema/model"
import { Permission } from "@opencode/schema/permission"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Skill } from "@opencode/schema/skill"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema, type Types } from "effect"
import { apply, copyName, copyPattern } from "../src/instructions/apply.js"
import { fingerprint, type Item, type Snapshot } from "../src/instructions/model.js"
import { context, skillHarness } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function item(overrides: Partial<Item> & { id: string; kind: Item["kind"]; owner: string }): Item {
  const text = overrides.text ?? "upstream"
  return {
    title: overrides.owner,
    text,
    agents: [],
    fingerprint: fingerprint(text),
    available: true,
    ...overrides,
    id: overrides.id,
    kind: overrides.kind,
    owner: overrides.owner,
  }
}

function snapshot(items: Item[], customizations: Snapshot["customizations"] = []): Snapshot {
  return { revision: 1, items, customizations }
}

function agent(id: string, system: string): Types.DeepMutable<Agent.Info> {
  return {
    id: Agent.ID.make(id),
    name: Agent.Name.make(id),
    request: { settings: {}, headers: {}, body: {} },
    system,
    mode: "primary",
    hidden: false,
    permissions: [],
  }
}

function agentState(ids: { id: string; system: string }[]): Map<string, Types.DeepMutable<Agent.Info>> {
  return new Map(ids.map((entry) => [entry.id, agent(entry.id, entry.system)]))
}

function agentEditor(state: Map<string, Types.DeepMutable<Agent.Info>>): AgentEditor {
  return {
    list: () => Array.from(state.values()),
    get: (id) => state.get(id),
    default: () => undefined,
    update: (id, update) => {
      const key = Agent.ID.make(id)
      const current = state.get(key) ?? Agent.Info.default(key)
      if (!state.has(key)) state.set(key, current)
      update(current)
      current.id = key
    },
    remove: (id) => {
      state.delete(id)
    },
  }
}

function skill(id: string, content: string): Skill.Info {
  return Skill.Info.make({
    id: Skill.ID.make(id),
    name: Skill.Name.make(id),
    location: AbsolutePath.make(`/skills/${id}.md`),
    content,
  })
}

function skillItems(): Item[] {
  return [
    item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream", agents: ["alpha"] }),
    item({ id: "prompt:beta", kind: "prompt", owner: "beta", text: "upstream", agents: ["beta"] }),
    item({ id: "skill:notes", kind: "skill", owner: "notes", title: "notes", text: "skill body" }),
  ]
}

function sessionEvent(agentID: string, tools: SessionHooks["context"]["tools"]): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make("ses_test_event"),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
    system: [{ type: "text", text: "base" }],
    messages: [],
    options: {},
    tools,
  }
}

function nativeTool(id: string, description: string): Tool.Info & { readonly id: string } {
  return {
    id,
    name: id,
    description,
    input: Schema.Void,
    options: { codemode: false },
    execute: () => Effect.die("unused tool.execute"),
  }
}

function codeModeTool(id: string, description: string): Tool.Info & { readonly id: string } {
  return {
    id,
    name: id,
    description,
    input: Schema.Void,
    execute: () => Effect.die("unused tool.execute"),
  }
}

function toolDomain(tools: readonly (Tool.Info & { readonly id: string })[]) {
  const editor: ToolEditor = {
    list: () => tools,
    get: (id) => tools.find((tool) => tool.id === id),
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
    reload: () => Effect.die("unused tool.reload"),
    hook: () => Effect.die("unused tool.hook"),
  }
}

// Core's rule semantics cannot be imported here (@opencode/core is outside
// the allowed imports), so these helpers mirror Permission.evaluate over
// Wildcard.match as read in packages/core/src/permission.ts and
// packages/core/src/util/wildcard.ts: the last matching rule wins, and an
// unmatched resource defaults to "ask" (visible to
// Skill.available, which filters only "deny").
function wildcardMatch(input: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(input)
}

function evaluateSkill(resource: string, rules: Permission.Ruleset): Permission.Effect {
  return (
    rules.findLast((rule) => wildcardMatch("skill", rule.action) && wildcardMatch(resource, rule.resource)) ?? {
      action: "skill",
      resource: "*",
      effect: "ask",
    }
  ).effect
}

test("a saved prompt override reaches agent.transform and sets system", async () => {
  const state = agentState([{ id: "alpha", system: "upstream" }])
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream" })]
  const customizations = [
    { item: "prompt:alpha", agent: "alpha", text: "custom", state: "inherit" as const, basedOn: prompts[0].fingerprint, updated: UPDATED },
  ]
  let reloaded = 0
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.sync(() => {
          reloaded++
        }),
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(prompts), customizations)
  expect(applied.registrations).toHaveLength(1)
  expect(state.get("alpha")?.system).toBe("custom")
  expect(reloaded).toBe(1)
})

test("a disabled skill denies that agent only", async () => {
  const state = agentState([
    { id: "alpha", system: "upstream" },
    { id: "beta", system: "upstream" },
  ])
  const items = [
    item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream", agents: ["alpha"] }),
    item({ id: "prompt:beta", kind: "prompt", owner: "beta", text: "upstream", agents: ["beta"] }),
    item({ id: "skill:notes", kind: "skill", owner: "notes", title: "notes", text: "skill body" }),
  ]
  const customizations = [
    {
      item: "skill:notes",
      agent: "alpha",
      state: "disabled" as const,
      basedOn: items[2].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  await apply(ctx, snapshot(items), customizations)
  expect(state.get("alpha")?.permissions).toEqual([{ action: "skill", resource: "notes", effect: "deny" }])
  // The negative case is asserted: the other agent keeps its original permissions.
  expect(state.get("beta")?.permissions).toEqual([])
})

test("a customized skill registers a private copy for that agent only", async () => {
  const state = agentState([
    { id: "alpha", system: "upstream" },
    { id: "beta", system: "upstream" },
  ])
  const skills = skillHarness([skill("notes", "skill body")])
  const items = skillItems()
  const customizations = [
    {
      item: "skill:notes",
      agent: "alpha",
      text: "custom body",
      state: "inherit" as const,
      basedOn: items[2].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    skill: skills.domain,
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(items), customizations)
  expect(applied.registrations).toHaveLength(2)
  expect(skills.added.map((entry) => entry.id as string)).toEqual([copyName("alpha", "notes")])
  expect(skills.added[0]?.content).toBe("custom body")
  expect(skills.added[0]?.location as string).toBe(skills.state.get("notes")?.location as string)
  expect(skills.state.get("notes")?.content).toBe("skill body")
  expect(state.get("alpha")?.permissions).toEqual([
    { action: "skill", resource: copyPattern(), effect: "deny" },
    { action: "skill", resource: "notes", effect: "deny" },
    { action: "skill", resource: copyName("alpha", "notes"), effect: "allow" },
  ])
  expect(state.get("beta")?.permissions).toEqual([{ action: "skill", resource: copyPattern(), effect: "deny" }])
  // Effective outcomes under core's last-match-wins evaluation: the owner
  // keeps its copy while losing the original; the other agent keeps the
  // original while the copy is denied.
  const copy = copyName("alpha", "notes")
  const alpha = state.get("alpha")?.permissions ?? []
  const beta = state.get("beta")?.permissions ?? []
  expect(evaluateSkill(copy, alpha)).toBe("allow")
  expect(evaluateSkill("notes", alpha)).toBe("deny")
  expect(evaluateSkill(copy, beta)).toBe("deny")
  expect(evaluateSkill("notes", beta)).not.toBe("deny")
})

test("a skill customization for another agent leaves this agent untouched", async () => {
  const state = agentState([
    { id: "alpha", system: "upstream" },
    { id: "beta", system: "upstream" },
  ])
  const skills = skillHarness([skill("notes", "skill body")])
  const items = skillItems()
  const customizations = [
    {
      item: "skill:notes",
      agent: "beta",
      text: "custom body",
      state: "inherit" as const,
      basedOn: items[2].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    skill: skills.domain,
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  await apply(ctx, snapshot(items), customizations)
  expect(skills.added.map((entry) => entry.id as string)).toEqual([copyName("beta", "notes")])
  expect(state.get("alpha")?.permissions).toEqual([{ action: "skill", resource: copyPattern(), effect: "deny" }])
  expect(state.get("beta")?.permissions).toEqual([
    { action: "skill", resource: copyPattern(), effect: "deny" },
    { action: "skill", resource: "notes", effect: "deny" },
    { action: "skill", resource: copyName("beta", "notes"), effect: "allow" },
  ])
  // The copy is denied to the non-owner but allowed to the owner, while the
  // non-owner still reaches the original.
  const copy = copyName("beta", "notes")
  expect(evaluateSkill(copy, state.get("alpha")?.permissions ?? [])).toBe("deny")
  expect(evaluateSkill(copy, state.get("beta")?.permissions ?? [])).toBe("allow")
  expect(evaluateSkill("notes", state.get("alpha")?.permissions ?? [])).not.toBe("deny")
})

test("two agents customizing the same skill cannot reach each other's copy", async () => {
  const state = agentState([
    { id: "alpha", system: "upstream" },
    { id: "beta", system: "upstream" },
  ])
  const skills = skillHarness([skill("notes", "skill body")])
  const items = skillItems()
  const customizations = [
    {
      item: "skill:notes",
      agent: "alpha",
      text: "alpha body",
      state: "inherit" as const,
      basedOn: items[2].fingerprint,
      updated: UPDATED,
    },
    {
      item: "skill:notes",
      agent: "beta",
      text: "beta body",
      state: "inherit" as const,
      basedOn: items[2].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    skill: skills.domain,
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  await apply(ctx, snapshot(items), customizations)
  expect(skills.added.map((entry) => entry.id as string)).toEqual([
    copyName("alpha", "notes"),
    copyName("beta", "notes"),
  ])
  const alphaCopy = copyName("alpha", "notes")
  const betaCopy = copyName("beta", "notes")
  const alpha = state.get("alpha")?.permissions ?? []
  const beta = state.get("beta")?.permissions ?? []
  expect(evaluateSkill(alphaCopy, alpha)).toBe("allow")
  expect(evaluateSkill(betaCopy, alpha)).toBe("deny")
  expect(evaluateSkill(betaCopy, beta)).toBe("allow")
  expect(evaluateSkill(alphaCopy, beta)).toBe("deny")
  // Each owner loses the original while its own copy stays reachable.
  expect(evaluateSkill("notes", alpha)).toBe("deny")
  expect(evaluateSkill("notes", beta)).toBe("deny")
})

test("a disabled customized skill only denies without a copy", async () => {
  const state = agentState([
    { id: "alpha", system: "upstream" },
    { id: "beta", system: "upstream" },
  ])
  const skills = skillHarness([skill("notes", "skill body")])
  const items = skillItems()
  const customizations = [
    {
      item: "skill:notes",
      agent: "alpha",
      text: "custom body",
      state: "disabled" as const,
      basedOn: items[2].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    skill: skills.domain,
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(items), customizations)
  expect(applied.registrations).toHaveLength(1)
  expect(skills.added).toEqual([])
  expect(state.get("alpha")?.permissions).toEqual([{ action: "skill", resource: "notes", effect: "deny" }])
  expect(state.get("beta")?.permissions).toEqual([])
})

test("a missing original skill emits no copy and no dangling allow rule", async () => {
  const state = agentState([
    { id: "alpha", system: "upstream" },
    { id: "beta", system: "upstream" },
  ])
  const skills = skillHarness([])
  const items = skillItems()
  const customizations = [
    {
      item: "skill:notes",
      agent: "alpha",
      text: "custom body",
      state: "inherit" as const,
      basedOn: items[2].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    skill: skills.domain,
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(items), customizations)
  expect(applied.registrations).toEqual([])
  expect(skills.added).toEqual([])
  expect(state.get("alpha")?.permissions).toEqual([])
  expect(state.get("beta")?.permissions).toEqual([])
})

test("a tool description override reaches the target agent and not another agent", async () => {
  const prompts = [
    item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream", agents: ["alpha"] }),
    item({ id: "prompt:beta", kind: "prompt", owner: "beta", text: "upstream", agents: ["beta"] }),
  ]
  const tools = [item({ id: "tool:reader", kind: "tool", owner: "reader", title: "reader", text: "read things" })]
  const all = [...prompts, ...tools]
  const customizations = [
    {
      item: "tool:reader",
      agent: "alpha",
      text: "custom description",
      state: "inherit" as const,
      basedOn: tools[0].fingerprint,
      updated: UPDATED,
    },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    tool: toolDomain([nativeTool("reader", "read things")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })

  const applied = await apply(ctx, snapshot(all), customizations)
  expect(applied.registrations).toHaveLength(1)
  expect(callbacks).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const alpha = sessionEvent("alpha", { reader: { description: "read things", input: { type: "object" } } })
  const beta = sessionEvent("beta", { reader: { description: "read things", input: { type: "object" } } })
  await Effect.runPromise(run(alpha))
  await Effect.runPromise(run(beta))
  expect(alpha.tools.reader?.description).toBe("custom description")
  // The negative case is asserted: a different agent keeps the upstream description.
  expect(beta.tools.reader?.description).toBe("read things")
})

test("a Code Mode tool customization registers nothing because session context cannot reach the execute inventory", async () => {
  const prompts = [
    item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream", agents: ["alpha"] }),
  ]
  const tools = [item({ id: "tool:helper", kind: "tool", owner: "helper", title: "helper", text: "help things" })]
  const all = [...prompts, ...tools]
  const customizations = [
    {
      item: "tool:helper",
      agent: "alpha",
      text: "custom description",
      state: "inherit" as const,
      basedOn: tools[0].fingerprint,
      updated: UPDATED,
    },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    tool: toolDomain([codeModeTool("helper", "help things")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })

  const applied = await apply(ctx, snapshot(all), customizations)
  expect(applied.registrations).toEqual([])
  expect(callbacks).toEqual([])
})

function mcpState(entries: [string, Types.DeepMutable<Mcp.ServerConfig>][]): {
  editor: MCPEditor
  removed: string[]
  configured: [string, Mcp.ServerConfig][]
  servers: Map<string, Types.DeepMutable<Mcp.ServerConfig>>
} {
  const servers = new Map(entries)
  const removed: string[] = []
  const configured: [string, Mcp.ServerConfig][] = []
  const editor: MCPEditor = {
    list: () => Array.from(servers.entries()),
    get: (name) => servers.get(name),
    set: (name, config) => {
      configured.push([name, config])
    },
    update: (name, update) => {
      const current = servers.get(name)
      if (current) update(current)
    },
    remove: (name) => {
      servers.delete(name)
      removed.push(name)
    },
  }
  return { editor, removed, configured, servers }
}

test("a shared MCP disable flags the server disabled while keeping it listed", async () => {
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream" })]
  const servers = [item({ id: "mcp:search", kind: "mcp", owner: "search", title: "search", text: "{}" })]
  const all = [...prompts, ...servers]
  const customizations = [
    {
      item: "mcp:search",
      agent: "*",
      state: "disabled" as const,
      basedOn: servers[0].fingerprint,
      updated: UPDATED,
    },
  ]
  const mcp = mcpState([["search", { type: "remote", url: "https://example.test" }]])
  let reloaded = 0
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcp.editor)
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.sync(() => {
          reloaded++
        }),
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(all), customizations)
  expect(applied.registrations).toHaveLength(1)
  expect(mcp.removed).toEqual([])
  expect(mcp.servers.get("search")?.disabled).toBe(true)
  expect(reloaded).toBe(1)
})

test("a shared MCP disable survives repeated discovery because the server stays listed", async () => {
  const upstream: [string, Types.DeepMutable<Mcp.ServerConfig>] = ["search", { type: "remote", url: "https://example.test" }]
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream" })]
  const customizations = [
    {
      item: "mcp:search",
      agent: "*",
      state: "disabled" as const,
      basedOn: fingerprint("{}"),
      updated: UPDATED,
    },
  ]
  const installed: Array<(editor: MCPEditor) => void> = []
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          installed.push(callback)
          const mcp = mcpState([structuredClone(upstream)])
          callback(mcp.editor)
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  // Each refresh rebuilds the visible list from upstream plus every installed
  // transform, mirroring core's State rebuild semantics.
  function visible(): Map<string, Types.DeepMutable<Mcp.ServerConfig>> {
    const mcp = mcpState([structuredClone(upstream)])
    for (const transform of installed) transform(mcp.editor)
    return mcp.servers
  }

  for (let pass = 0; pass < 2; pass++) {
    const servers = Array.from(visible()).map(([name, config]) =>
      item({ id: `mcp:${name}`, kind: "mcp", owner: name, title: name, text: JSON.stringify(config) }),
    )
    expect(servers.map((server) => server.id)).toEqual(["mcp:search"])
    await apply(ctx, snapshot([...prompts, ...servers]), customizations)
    expect(visible().get("search")?.disabled).toBe(true)
  }
})

test("an MCP text edit registers nothing because server configuration is file-owned", async () => {
  const upstream = JSON.stringify({ type: "remote", url: "https://example.test" })
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream" })]
  const servers = [item({ id: "mcp:search", kind: "mcp", owner: "search", title: "search", text: upstream })]
  const all = [...prompts, ...servers]
  const customizations = [
    {
      item: "mcp:search",
      agent: "*",
      text: JSON.stringify({ type: "remote", url: "https://replaced.test" }),
      state: "inherit" as const,
      basedOn: servers[0].fingerprint,
      updated: UPDATED,
    },
  ]
  const mcp = mcpState([["search", { type: "remote", url: "https://example.test" }]])
  let reloaded = 0
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcp.editor)
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.sync(() => {
          reloaded++
        }),
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(all), customizations)
  expect(applied.registrations).toEqual([])
  expect(mcp.configured).toEqual([])
  expect(mcp.servers.get("search")).toEqual({ type: "remote", url: "https://example.test" })
  expect(reloaded).toBe(0)
})

test("a per-agent MCP record is ignored because servers are shared configuration", async () => {
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream" })]
  const servers = [item({ id: "mcp:search", kind: "mcp", owner: "search", title: "search", text: "{}" })]
  const all = [...prompts, ...servers]
  const customizations = [
    {
      item: "mcp:search",
      agent: "alpha",
      state: "disabled" as const,
      basedOn: servers[0].fingerprint,
      updated: UPDATED,
    },
  ]
  const mcp = mcpState([["search", { type: "remote", url: "https://example.test" }]])
  let reloaded = 0
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcp.editor)
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.sync(() => {
          reloaded++
        }),
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(all), customizations)
  expect(applied.registrations).toEqual([])
  expect(mcp.removed).toEqual([])
  expect(reloaded).toBe(0)
})

test("a disabled prompt customization never clears the agent system text", async () => {
  const state = agentState([{ id: "alpha", system: "upstream" }])
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream" })]
  const customizations = [
    {
      item: "prompt:alpha",
      agent: "alpha",
      text: "custom",
      state: "disabled" as const,
      basedOn: prompts[0].fingerprint,
      updated: UPDATED,
    },
  ]
  let reloaded = 0
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.sync(() => {
          reloaded++
        }),
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(prompts), customizations)
  expect(applied.registrations).toEqual([])
  expect(state.get("alpha")?.system).toBe("upstream")
  expect(reloaded).toBe(0)
})

test("instruction customizations register nothing", async () => {
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream" })]
  const instructions = [
    item({ id: "instruction:guide", kind: "instruction", owner: "guide", title: "guide", text: "upstream" }),
  ]
  const all = [...prompts, ...instructions]
  const customizations = [
    {
      item: "instruction:guide",
      agent: "alpha",
      text: "custom",
      state: "inherit" as const,
      basedOn: instructions[0].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("instruction customizations must not reach agent.transform"),
      reload: () => Effect.die("instruction customizations must not reload agents"),
    },
    session: {
      hook: () => Effect.die("instruction customizations must not hook sessions"),
    },
  })

  const applied = await apply(ctx, snapshot(all), customizations)
  expect(applied.registrations).toEqual([])
})

test("a prompt override for a removed agent does not recreate the agent", async () => {
  const state = agentState([])
  const prompts = [item({ id: "prompt:ghost", kind: "prompt", owner: "ghost", text: "upstream" })]
  const customizations = [
    { item: "prompt:ghost", agent: "ghost", text: "custom", state: "inherit" as const, basedOn: prompts[0].fingerprint, updated: UPDATED },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  await apply(ctx, snapshot(prompts), customizations)
  expect(state.has("ghost")).toBe(false)
})

test("a skill rule for a removed agent does not recreate the agent", async () => {
  const state = agentState([{ id: "alpha", system: "upstream" }])
  const items = [
    item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream", agents: ["alpha"] }),
    item({ id: "prompt:ghost", kind: "prompt", owner: "ghost", text: "upstream", agents: ["ghost"] }),
    item({ id: "skill:notes", kind: "skill", owner: "notes", title: "notes", text: "skill body" }),
  ]
  const customizations = [
    {
      item: "skill:notes",
      agent: "ghost",
      state: "disabled" as const,
      basedOn: items[2].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  await apply(ctx, snapshot(items), customizations)
  expect(state.has("ghost")).toBe(false)
  expect(state.get("alpha")?.permissions).toEqual([])
})

test("enabling a server whose item is available: false actually clears disabled in the host config", async () => {
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream" })]
  const servers = [item({ id: "mcp:search", kind: "mcp", owner: "search", title: "search", text: "{}", available: false })]
  const all = [...prompts, ...servers]
  const customizations = [
    {
      item: "mcp:search",
      agent: "*",
      state: "enabled" as const,
      basedOn: servers[0].fingerprint,
      updated: UPDATED,
    },
  ]
  const mcp = mcpState([["search", { type: "remote", url: "https://example.test", disabled: true }]])
  let reloaded = 0
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcp.editor)
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.sync(() => {
          reloaded++
        }),
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(all), customizations)
  expect(applied.registrations).toHaveLength(1)
  expect(mcp.servers.get("search")?.disabled).toBeUndefined()
  expect(reloaded).toBe(1)
})

test("an agent-level disable plus a Defaults-level disable removes the native tool for that agent", async () => {
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream", agents: ["alpha"] })]
  const tools = [item({ id: "tool:reader", kind: "tool", owner: "reader", title: "reader", text: "read things" })]
  const all = [...prompts, ...tools]
  const customizations = [
    {
      item: "tool:reader",
      agent: "alpha",
      state: "disabled" as const,
      basedOn: tools[0].fingerprint,
      updated: UPDATED,
    },
    {
      item: "tool:reader",
      agent: "*",
      state: "disabled" as const,
      basedOn: tools[0].fingerprint,
      updated: UPDATED,
    },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    tool: toolDomain([nativeTool("reader", "read things")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })

  const applied = await apply(ctx, snapshot(all), customizations)
  expect(applied.registrations).toHaveLength(1)
  expect(callbacks).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const alpha = sessionEvent("alpha", { reader: { description: "read things", input: { type: "object" } } })
  await Effect.runPromise(run(alpha))
  expect(alpha.tools.reader).toBeUndefined()
})

test("an agent with upstream permissions [{skill,notes,deny},{skill,*,allow}], disabling notes through Plus, ends with a Plus-appended deny as the last matching entry", async () => {
  const state = agentState([{ id: "alpha", system: "upstream" }])
  const alphaAgent = state.get("alpha")
  if (!alphaAgent) throw new Error("missing alpha agent")
  alphaAgent.permissions = [
    { action: "skill", resource: "notes", effect: "deny" },
    { action: "skill", resource: "*", effect: "allow" },
  ]
  const items = [
    item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream", agents: ["alpha"] }),
    item({ id: "skill:notes", kind: "skill", owner: "notes", title: "notes", text: "skill body" }),
  ]
  const customizations = [
    {
      item: "skill:notes",
      agent: "alpha",
      state: "disabled" as const,
      basedOn: items[1].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  await apply(ctx, snapshot(items), customizations)
  const permissions = state.get("alpha")?.permissions ?? []
  expect(permissions).toEqual([
    { action: "skill", resource: "notes", effect: "deny" },
    { action: "skill", resource: "*", effect: "allow" },
    { action: "skill", resource: "notes", effect: "deny" },
  ])
  const lastMatching = permissions.findLast(
    (entry) => entry.action === "skill" && (entry.resource === "notes" || entry.resource === "*"),
  )
  expect(lastMatching).toEqual({ action: "skill", resource: "notes", effect: "deny" })
  expect(evaluateSkill("notes", permissions)).toBe("deny")
})
