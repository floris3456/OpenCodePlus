import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Skill } from "@opencode/schema/skill"
import type { Tool } from "@opencode/schema/tool"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { apply, applyInstructions, copyName, copyPattern, isSkillCopy } from "../src/instructions/apply.js"
import type { ApplyInput } from "../src/instructions/apply.js"
import { fingerprint, resolve } from "../src/instructions/model.js"
import type { CustomizationRecord, Item, Level } from "../src/instructions/model.js"
import { agentHarness, context, skillHarness } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function makeItem(overrides: Partial<Item> & { id: string; kind: Item["kind"] }): Item {
  const text = overrides.text ?? "upstream"
  const base = {
    group: "none" as const,
    title: overrides.id,
    enabled: true,
    ...overrides,
    id: overrides.id,
    kind: overrides.kind,
    text,
  }
  return { ...base, fingerprint: overrides.fingerprint ?? fingerprint(text) }
}

function makeRecord(overrides: Partial<CustomizationRecord> & { item: string; type?: "customization" }): CustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    section: null,
    basedOn: fingerprint("upstream"),
    updated: UPDATED,
    ...overrides,
    item: overrides.item,
  }
}

function makeInput(overrides: Partial<ApplyInput> & { items: ApplyInput["items"] }): ApplyInput {
  return {
    agents: [{ id: "alpha", level: "project" as Level }],
    records: [],
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
    ...overrides,
  }
}

function skillInfo(id: string, content: string): Skill.Info {
  return Skill.Info.make({
    id: Skill.ID.make(id),
    name: Skill.Name.make(id),
    location: AbsolutePath.make(`/skills/${id}.md`),
    content,
  })
}

function agentInfo(id: string, system: string): Agent.Info {
  return { ...Agent.Info.default(Agent.ID.make(id)), system }
}

function sessionEvent(
  agentID: string,
  tools: SessionHooks["context"]["tools"],
  system: SessionHooks["context"]["system"],
  model?: { providerID: string; id: string },
): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make("ses_test_event"),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({
      providerID: Provider.ID.make(model?.providerID ?? "test"),
      id: Model.ID.make(model?.id ?? "test"),
    }),
    system,
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

function toolDomainFor(tools: readonly (Tool.Info & { readonly id: string })[]) {
  const live = tools.map((tool) => ({ ...tool }))
  const editor: ToolEditor = {
    list: () => live,
    get: (id) => live.find((tool) => tool.id === id),
    namespace: () => {},
    add: (tool) => {
      live.push({ ...tool, id: tool.name } as Tool.Info & { readonly id: string })
    },
    update: (id, update) => {
      const current = live.find((tool) => tool.id === id)
      if (current !== undefined) update(current as never)
    },
    remove: (id) => {
      const index = live.findIndex((tool) => tool.id === id)
      if (index !== -1) live.splice(index, 1)
    },
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

function mcpState(entries: [string, { type: "remote"; url: string; disabled?: boolean }][]) {
  const servers = new Map(entries.map(([name, config]) => [name, { ...config }]))
  return {
    servers,
    editor: {
      list: () => Array.from(servers.entries()),
      get: (name: string) => servers.get(name),
      set: (name: string, config: { type: "remote"; url: string; disabled?: boolean }) => {
        servers.set(name, { ...config })
      },
      update: (name: string, update: (config: { disabled?: boolean }) => void) => {
        const current = servers.get(name)
        if (current) update(current)
      },
      remove: (name: string) => {
        servers.delete(name)
      },
    },
  }
}

test("per-agent role applies assembled text to the owning agent only", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const items = [makeItem({ id: "system:role", kind: "system", text: "upstream" })]
  const records = [makeRecord({ item: "system:role", agent: "alpha", level: "project", text: "custom alpha" })]
  const ctx = context({ agent: agents.domain })
  const applied = await apply(
    ctx,
    makeInput({ items, agents: [{ id: "alpha", level: "project" }, { id: "beta", level: "project" }], records }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(agents.state.get("alpha")?.system).toBe("custom alpha")
  expect(agents.state.get("beta")?.system).toBe("upstream")
  expect(agents.reloads).toBe(1)
})

test("section exclusion removes that text from what is installed", async () => {
  const text = "# One\n\na\n\n# Two\n\nb\n"
  const agents = agentHarness([agentInfo("alpha", text)])
  const items = [makeItem({ id: "system:role", kind: "system", text, title: "role" })]
  const records = [makeRecord({ item: "system:role", agent: "alpha", level: "project", section: "two", state: "off" })]
  const ctx = context({ agent: agents.domain })
  const applied = await apply(ctx, makeInput({ items, records }))
  expect(applied.registrations).toHaveLength(1)
  const installed = agents.state.get("alpha")?.system ?? ""
  expect(installed).toContain("a")
  expect(installed).not.toContain("b")
})

test("tool description reaches the target agent and disablement deletes the tool", async () => {
  const items = [
    makeItem({ id: "tool:reader", kind: "tool", text: "read things", title: "reader" }),
    makeItem({ id: "tool:writer", kind: "tool", text: "write things", title: "writer" }),
  ]
  const records = [
    makeRecord({ item: "tool:reader", agent: "alpha", level: "project", text: "custom description" }),
    makeRecord({ item: "tool:writer", agent: "alpha", level: "project", state: "off" }),
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    tool: toolDomainFor([nativeTool("reader", "read things"), nativeTool("writer", "write things")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const input = makeInput({
    items,
    agents: [{ id: "alpha", level: "project" }, { id: "beta", level: "project" }],
    records,
  })
  const applied = await apply(ctx, input)
  expect(applied.registrations).toHaveLength(1)
  expect(callbacks).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const alpha = sessionEvent(
    "alpha",
    { reader: { description: "read things", input: { type: "object" } }, writer: { description: "write things", input: { type: "object" } } },
    [{ type: "text", text: "base" }],
  )
  const beta = sessionEvent(
    "beta",
    { reader: { description: "read things", input: { type: "object" } }, writer: { description: "write things", input: { type: "object" } } },
    [{ type: "text", text: "base" }],
  )
  await Effect.runPromise(run(alpha))
  await Effect.runPromise(run(beta))
  expect(alpha.tools.reader?.description).toBe("custom description")
  expect(alpha.tools.writer).toBeUndefined()
  expect(beta.tools.reader?.description).toBe("read things")
  expect(beta.tools.writer?.description).toBe("write things")
})

test("an uncustomized skill with lossy assemble output installs nothing", async () => {
  // assemble collapses blank runs and trims, so this raw text never
  // round-trips byte-identically: a byte comparison against the raw upstream
  // would mistake it for customized. With records present for other items but
  // none for this skill, it must install no copy and no rule.
  const raw = "# One\n\n\n\na\n\n"
  const skills = skillHarness([skillInfo("notes", raw)])
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const items = [
    makeItem({ id: "skill:notes", kind: "skill", text: raw, title: "notes" }),
    makeItem({ id: "tool:reader", kind: "tool", text: "read things", title: "reader" }),
  ]
  const records = [makeRecord({ item: "tool:reader", agent: "alpha", level: "project", text: "custom description" })]
  const permissionsBefore = agents.state.get("alpha")?.permissions.length
  const betaBefore = agents.state.get("beta")?.permissions.length
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: agents.domain,
    skill: skills.domain,
    tool: toolDomainFor([nativeTool("reader", "read things")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const applied = await apply(
    ctx,
    makeInput({ items, agents: [{ id: "alpha", level: "project" }, { id: "beta", level: "project" }], records }),
  )
  // The tool record still applies through the session hook; the skill side
  // installs no copy and no rule.
  expect(applied.registrations).toHaveLength(1)
  expect(callbacks).toHaveLength(1)
  expect(skills.added).toEqual([])
  expect(agents.state.get("alpha")?.permissions).toHaveLength(permissionsBefore ?? 0)
  expect(agents.state.get("beta")?.permissions).toHaveLength(betaBefore ?? 0)
})

test("skill content registers a private copy and denial, and disablement only denies", async () => {
  const skills = skillHarness([skillInfo("notes", "skill body")])
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const items = [makeItem({ id: "skill:notes", kind: "skill", text: "skill body", title: "notes" })]
  const records = [makeRecord({ item: "skill:notes", agent: "alpha", level: "project", text: "custom body" })]
  const ctx = context({ agent: agents.domain, skill: skills.domain })
  const applied = await apply(
    ctx,
    makeInput({ items, agents: [{ id: "alpha", level: "project" }, { id: "beta", level: "project" }], records }),
  )
  expect(applied.registrations).toHaveLength(2)
  expect(skills.added.map((entry) => entry.id as string)).toEqual([copyName("alpha", "notes")])
  expect(skills.added[0]?.content).toBe("custom body")
  expect(skills.state.get("notes")?.content).toBe("skill body")
  expect(isSkillCopy(copyName("alpha", "notes"))).toBe(true)
  expect(isSkillCopy("notes")).toBe(false)
  expect(agents.state.get("alpha")?.permissions.slice(-3)).toEqual([
    { action: "skill", resource: copyPattern(), effect: "deny" },
    { action: "skill", resource: "notes", effect: "deny" },
    { action: "skill", resource: copyName("alpha", "notes"), effect: "allow" },
  ])
})

test("a section-only skill record installs no copy and no rule", async () => {
  const text = "# One\n\na\n\n# Two\n\nb\n"
  const skills = skillHarness([skillInfo("notes", text)])
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const items = [makeItem({ id: "skill:notes", kind: "skill", text, title: "notes" })]
  const records = [makeRecord({ item: "skill:notes", agent: "alpha", level: "project", section: "two", state: "off" })]
  const probe = resolve({
    upstream: items[0] as Item,
    records,
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
    address: { level: "project", agent: "alpha", item: "skill:notes", section: null },
  })
  expect(probe.assembled).not.toBe(text)
  expect(probe.enabled).toBe(true)
  expect(probe.overriddenHere).toBe(false)
  // A section-only record leaves the whole-item address unowned: enabling or
  // disabling one section cannot be expressed through a private whole-skill
  // copy without also denying the remaining sections.
  const ctx = context({ agent: agents.domain, skill: skills.domain })
  const applied = await apply(ctx, makeInput({ items, records }))
  expect(applied.registrations).toEqual([])
  expect(skills.added).toEqual([])
})

test("a disabled skill only denies without a copy", async () => {
  const skills = skillHarness([skillInfo("notes", "skill body")])
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const items = [makeItem({ id: "skill:notes", kind: "skill", text: "skill body", title: "notes" })]
  const records = [makeRecord({ item: "skill:notes", agent: "alpha", level: "project", state: "off" })]
  const ctx = context({ agent: agents.domain, skill: skills.domain })
  const applied = await apply(ctx, makeInput({ items, records }))
  expect(applied.registrations).toHaveLength(1)
  expect(skills.added).toEqual([])
  expect(agents.state.get("alpha")?.permissions.slice(-1)).toEqual([{ action: "skill", resource: "notes", effect: "deny" }])
})

test("mcp enablement applies while stored text never applies", async () => {
  const mcp = mcpState([["search", { type: "remote", url: "https://example.test" }]])
  let reloaded = 0
  const items = [makeItem({ id: "mcp:search", kind: "mcp", text: "{}", title: "search" })]
  const records = [makeRecord({ item: "mcp:search", agent: null, level: "defaults", state: "off" })]
  const ctx = context({
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcp.editor as never)
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.sync(() => {
          reloaded++
        }),
    },
  })
  const applied = await apply(ctx, makeInput({ items, agents: [{ id: "alpha", level: "project" }], records }))
  expect(applied.registrations).toHaveLength(1)
  expect(mcp.servers.get("search")?.disabled).toBe(true)
  expect(reloaded).toBe(1)
})

test("mcp text alone registers nothing", async () => {
  const mcp = mcpState([["search", { type: "remote", url: "https://example.test" }]])
  const items = [makeItem({ id: "mcp:search", kind: "mcp", text: "{}", title: "search" })]
  const records = [
    makeRecord({ item: "mcp:search", agent: null, level: "defaults", text: '{"replaced":true}' }),
  ]
  const ctx = context({
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcp.editor as never)
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("mcp reload must not run"),
    },
  })
  const applied = await apply(ctx, makeInput({ items, agents: [{ id: "alpha", level: "project" }], records }))
  expect(applied.registrations).toEqual([])
  expect(mcp.servers.get("search")).toEqual({ type: "remote", url: "https://example.test" })
})

test("only the active base template is applied", async () => {
  const items = [
    makeItem({ id: "base:gpt", kind: "base", text: "gpt upstream", title: "gpt" }),
    makeItem({ id: "base:claude", kind: "base", text: "claude upstream", title: "claude" }),
  ]
  const records = [
    makeRecord({ item: "base:gpt", agent: "alpha", level: "project", text: "custom gpt" }),
    makeRecord({ item: "base:claude", agent: "alpha", level: "project", text: "custom claude" }),
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const applied = await apply(ctx, makeInput({ items, records }))
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const gpt = sessionEvent("alpha", {}, [{ type: "text", text: "family default" }], {
    providerID: "openai",
    id: "gpt-4o",
  })
  await Effect.runPromise(run(gpt))
  expect(gpt.system[0]?.text).toBe("custom gpt")
  const claude = sessionEvent("alpha", {}, [{ type: "text", text: "family default" }], {
    providerID: "anthropic",
    id: "claude-3",
  })
  await Effect.runPromise(run(claude))
  expect(claude.system[0]?.text).toBe("custom claude")
  const other = sessionEvent("alpha", {}, [{ type: "text", text: "family default" }], {
    providerID: "test",
    id: "unknown-model",
  })
  await Effect.runPromise(run(other))
  expect(other.system[0]?.text).toBe("family default")
})

test("per-file instructions drop or replace one part by path", async () => {
  const items = [
    makeItem({ id: "system:AGENTS.md", kind: "system", text: "upstream guide", title: "AGENTS.md" }),
    makeItem({ id: "system:OTHER.md", kind: "system", text: "other upstream", title: "OTHER.md" }),
  ]
  const records = [
    makeRecord({ item: "system:AGENTS.md", agent: "alpha", level: "project", text: "custom guide" }),
    makeRecord({ item: "system:OTHER.md", agent: "alpha", level: "project", state: "off" }),
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const applied = await apply(ctx, makeInput({ items, records }))
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent(
    "alpha",
    {},
    [
      { type: "text", text: "upstream guide", metadata: { path: "AGENTS.md" } },
      { type: "text", text: "other upstream", metadata: { path: "OTHER.md" } },
    ],
  )
  await Effect.runPromise(run(event))
  expect(event.system.map((part) => part.text)).toEqual(["custom guide"])
  // Direct unit path: no string surgery on a merged blob.
  const direct: SessionHooks["context"]["system"] = [{ type: "text", text: "merged blob" }]
  applyInstructions(direct, [])
  expect(direct).toHaveLength(1)
})

test("no-op updates install nothing and reload nothing", async () => {
  const items = [makeItem({ id: "system:role", kind: "system", text: "upstream" })]
  const records = [makeRecord({ item: "system:role", agent: "alpha", level: "project", text: "upstream" })]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("agent.transform must not run"),
      reload: () => Effect.die("agent.reload must not run"),
    },
    session: {
      hook: () => Effect.die("session.hook must not run"),
    },
  })
  const applied = await apply(ctx, makeInput({ items, records }))
  expect(applied.registrations).toEqual([])
})

test("empty records install nothing", async () => {
  const items = [makeItem({ id: "system:role", kind: "system", text: "upstream" })]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("agent.transform must not run"),
      reload: () => Effect.die("agent.reload must not run"),
    },
  })
  const applied = await apply(ctx, makeInput({ items, records: [] }))
  expect(applied.registrations).toEqual([])
})

test("a mid-way failure unwinds earlier registrations in reverse order", async () => {
  const events: string[] = []
  const items = [
    makeItem({ id: "system:role", kind: "system", text: "upstream" }),
    makeItem({ id: "skill:notes", kind: "skill", text: "skill body", title: "notes" }),
    makeItem({ id: "tool:reader", kind: "tool", text: "read things", title: "reader" }),
    makeItem({ id: "mcp:search", kind: "mcp", text: "{}", title: "search" }),
  ]
  const records = [
    makeRecord({ item: "system:role", agent: "alpha", level: "project", text: "custom prompt" }),
    makeRecord({ item: "skill:notes", agent: "alpha", level: "project", text: "custom skill" }),
    makeRecord({ item: "tool:reader", agent: "alpha", level: "project", text: "custom tool" }),
    makeRecord({ item: "mcp:search", agent: null, level: "defaults", state: "off" }),
  ]
  const skills = skillHarness([skillInfo("notes", "skill body")])
  const stateAgents = agentHarness([agentInfo("alpha", "upstream")])
  void stateAgents
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          const tag = events.some((entry) => entry.startsWith("install:")) ? "skill-agent-rules" : "prompt"
          events.push(`install:${tag}`)
          callback({ get: () => undefined, update: () => undefined } as never)
          return {
            dispose: Effect.sync(() => {
              events.push(`dispose:${tag}`)
            }),
          }
        }),
      reload: () => Effect.void,
    },
    skill: {
      list: () => Effect.die("unused skill.list"),
      transform: (callback) =>
        Effect.sync(() => {
          events.push("install:skill-copy")
          const res = Effect.runSync(Effect.scoped(skills.domain.transform(callback)))
          return {
            dispose: Effect.sync(() => {
              events.push("dispose:skill-copy")
              Effect.runSync(res.dispose)
            }),
          }
        }),
      reload: () => Effect.void,
    },
    tool: toolDomainFor([nativeTool("reader", "read things")]),
    session: {
      hook: () => {
        events.push("install:tool")
        return Effect.succeed({
          dispose: Effect.sync(() => {
            events.push("dispose:tool")
          }),
        })
      },
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: () => Effect.die(new Error("mcp transform failed")),
      reload: () => Effect.void,
    },
  })
  await expect(
    apply(ctx, makeInput({ items, records })),
  ).rejects.toThrow("mcp transform failed")
  expect(events).toEqual([
    "install:prompt",
    "install:skill-copy",
    "install:skill-agent-rules",
    "install:tool",
    "dispose:tool",
    "dispose:skill-agent-rules",
    "dispose:skill-copy",
    "dispose:prompt",
  ])
})
