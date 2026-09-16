import { afterEach, expect, test } from "bun:test"
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
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { apply, applyInstructions, copyName, copyPattern, isSkillCopy } from "../src/instructions/apply.js"
import type { ApplyInput } from "../src/instructions/apply.js"
import { discover } from "../src/instructions/discover.js"
import { teachingFilePath, teachingItemId } from "../src/instructions/paths.js"
import { seedSystemInstruction } from "../src/instructions/teaching.js"
import { catalogPath, fingerprint, resolve, scopesOf } from "../src/instructions/model.js"
import type { CustomizationRecord, Level } from "../src/instructions/model.js"
import { agentHarness, catalogHarness, context, fullContext, modelInfo, modelRef, promptHarness, skillHarness } from "./harness.js"
import { createPlusApi, createState } from "../src/index.js"
import { enable } from "../src/project.js"
import type { Context } from "@opencode/plugin/effect/plugin"
// Plus cannot depend on @opencode/core (core depends on Plus), so this
// regression reads core's own template sources and renderer by path. That
// is the point: artificial upstream/live pairs hid the gpt-6 divergence,
// and only the real texts reproduce it.
import PROMPT_GPT from "../../core/src/plugin/system-prompt/gpt.txt"
import PROMPT_ASTRA from "../../core/src/plugin/system-prompt/gpt-astra.txt"
import { SessionSystemPrompt } from "../../core/src/session/system-prompt.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

async function discoverFor(
  ctx: Context,
  options: {
    records?: CustomizationRecord[]
    baseTemplates?: { id: string; title: string; text: string }[]
    activeBase?: (candidate: Agent.Info) => string | undefined
  } = {},
) {
  return discover({
    ctx,
    records: options.records ?? [],
    baseTemplates: options.baseTemplates ?? [],
    activeBase: options.activeBase ?? (() => undefined),
  })
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

function agentInfo(id: string, system: string, model?: Model.Ref): Agent.Info {
  return { ...Agent.Info.default(Agent.ID.make(id)), system, ...(model === undefined ? {} : { model }) }
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
  const ctx = context({ agent: agents.domain })
  const discovered = await discoverFor(ctx)
  const records = [makeRecord({ item: "system:role", agent: "alpha", level: "project", text: "custom alpha" })]
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: discovered.agents.map((a) => ({ id: a.id, level: "project" })),
      scopes: scopesOf(discovered.agents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(agents.state.get("alpha")?.system).toBe("custom alpha")
  expect(agents.state.get("beta")?.system).toBe("upstream")
  expect(agents.reloads).toBe(1)
})

test("section exclusion removes that text from what is installed", async () => {
  const text = "# One\n\na\n\n# Two\n\nb\n"
  const agents = agentHarness([agentInfo("alpha", text)])
  const ctx = context({ agent: agents.domain })
  const discovered = await discoverFor(ctx)
  const records = [makeRecord({ item: "system:role", agent: "alpha", level: "project", section: "two", state: "off" })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, scopes: scopesOf(discovered.agents), records }))
  expect(applied.registrations).toHaveLength(1)
  const installed = agents.state.get("alpha")?.system ?? ""
  expect(installed).toContain("a")
  expect(installed).not.toContain("b")
})

test("section text edit installs for that agent, including an inherited Defaults edit", async () => {
  const text = "# One\n\na\n\n# Two\n\nb\n"
  const edited = "# Two\n\nb edited\n"
  const agents = agentHarness([agentInfo("alpha", text), agentInfo("beta", text)])
  const ctx = context({ agent: agents.domain })
  const discovered = await discoverFor(ctx)
  const records = [
    makeRecord({
      item: "system:role",
      agent: "alpha",
      level: "project",
      section: "two",
      text: edited,
      basedOn: fingerprint("# Two\n\nb\n"),
      basedOnText: "# Two\n\nb\n",
    }),
  ]
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: discovered.agents.map((a) => ({ id: a.id, level: "project" })),
      scopes: scopesOf(discovered.agents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(agents.state.get("alpha")?.system ?? "").toContain("b edited")
  expect(agents.state.get("beta")?.system ?? "").not.toContain("b edited")
  const shared = [makeRecord({ item: "system:role", agent: null, level: "defaults", section: "two", text: edited })]
  const roleItem = discovered.items.find((item) => item.id === "system:role")!
  const probe = resolve({
    upstream: roleItem,
    records: shared,
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
    address: { level: "project", agent: "alpha", item: "system:role", section: null },
  })
  expect(probe.assembled).toContain("b edited")
})

test("tool description reaches the target agent and disablement deletes the tool", async () => {
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
  const discovered = await discoverFor(ctx)
  const records = [
    makeRecord({ item: "tool:reader", agent: "alpha", level: "project", text: "custom description" }),
    makeRecord({ item: "tool:writer", agent: "alpha", level: "project", state: "off" }),
  ]
  const input = makeInput({
    items: discovered.items,
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
  const discovered = await discoverFor(ctx)
  const records = [makeRecord({ item: "tool:reader", agent: "alpha", level: "project", text: "custom description" })]
  const permissionsBefore = agents.state.get("alpha")?.permissions.length
  const betaBefore = agents.state.get("beta")?.permissions.length
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: discovered.agents.map((a) => ({ id: a.id, level: "project" })),
      scopes: scopesOf(discovered.agents),
      records,
    }),
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
  const skills = skillHarness([skillInfo("notes", "upstream body")])
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({ agent: agents.domain, skill: skills.domain })
  const discovered = await discoverFor(ctx)
  const records = [makeRecord({ item: "skill:notes", agent: "alpha", level: "project", text: "custom body" })]
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: discovered.agents.map((a) => ({ id: a.id, level: "project" })),
      scopes: scopesOf(discovered.agents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(2)
  expect(skills.added.map((entry) => entry.id as string)).toEqual([copyName("alpha", "notes")])
  expect(skills.added[0]?.content).toBe("custom body")
  expect(skills.state.get("notes")?.content).toBe("upstream body")
  expect(isSkillCopy(copyName("alpha", "notes"))).toBe(true)
  expect(isSkillCopy("notes")).toBe(false)
  expect(agents.state.get("alpha")?.permissions.slice(-3)).toEqual([
    { action: "skill", resource: copyPattern(), effect: "deny" },
    { action: "skill", resource: "notes", effect: "deny" },
    { action: "skill", resource: copyName("alpha", "notes"), effect: "allow" },
  ])
})

test("a section-only skill exclusion installs a private copy for that agent only", async () => {
  const text = "# Before\n\na\n\n# Checks\n\nb\n\n# Publishing\n\nc\n"
  const skills = skillHarness([skillInfo("notes", text)])
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({ agent: agents.domain, skill: skills.domain })
  const discovered = await discoverFor(ctx)
  const skillItem = discovered.items.find((item) => item.id === "skill:notes")!
  const records = [makeRecord({ item: "skill:notes", agent: "alpha", level: "project", section: "publishing", state: "off" })]
  const probe = resolve({
    upstream: skillItem,
    records,
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
    address: { level: "project", agent: "alpha", item: "skill:notes", section: null },
  })
  expect(probe.assembled).toContain("Before")
  expect(probe.assembled).toContain("Checks")
  expect(probe.assembled).not.toContain("Publishing")
  expect(probe.enabled).toBe(true)
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: discovered.agents.map((a) => ({ id: a.id, level: "project" })),
      scopes: scopesOf(discovered.agents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(2)
  expect(skills.added.map((entry) => entry.id as string)).toEqual([copyName("alpha", "notes")])
  expect(skills.added[0]?.content).toContain("Before")
  expect(skills.added[0]?.content).toContain("Checks")
  expect(skills.added[0]?.content).not.toContain("Publishing")
  expect(skills.state.get("notes")?.content).toBe(text)
  expect(agents.state.get("alpha")?.permissions.slice(-3)).toEqual([
    { action: "skill", resource: copyPattern(), effect: "deny" },
    { action: "skill", resource: "notes", effect: "deny" },
    { action: "skill", resource: copyName("alpha", "notes"), effect: "allow" },
  ])
  expect(skills.added.some((entry) => String(entry.id) === copyName("beta", "notes"))).toBe(false)
})

test("a disabled skill only denies without a copy", async () => {
  const skills = skillHarness([skillInfo("notes", "skill body")])
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const ctx = context({ agent: agents.domain, skill: skills.domain })
  const discovered = await discoverFor(ctx)
  const records = [makeRecord({ item: "skill:notes", agent: "alpha", level: "project", state: "off" })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, scopes: scopesOf(discovered.agents), records }))
  expect(applied.registrations).toHaveLength(1)
  expect(skills.added).toEqual([])
  expect(agents.state.get("alpha")?.permissions.slice(-1)).toEqual([{ action: "skill", resource: "notes", effect: "deny" }])
})

test("mcp enablement applies while stored text never applies", async () => {
  const mcp = mcpState([["search", { type: "remote", url: "https://example.test" }]])
  let reloaded = 0
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
  const discovered = await discoverFor(ctx)
  const records = [makeRecord({ item: "mcp:search", agent: null, level: "defaults", state: "off" })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, agents: [{ id: "alpha", level: "project" }], records }))
  expect(applied.registrations).toHaveLength(1)
  expect(mcp.servers.get("search")?.disabled).toBe(true)
  expect(reloaded).toBe(1)
})

test("mcp text alone registers nothing", async () => {
  const mcp = mcpState([["search", { type: "remote", url: "https://example.test" }]])
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
  const discovered = await discoverFor(ctx)
  const records = [
    makeRecord({ item: "mcp:search", agent: null, level: "defaults", text: '{"replaced":true}' }),
  ]
  const applied = await apply(ctx, makeInput({ items: discovered.items, agents: [{ id: "alpha", level: "project" }], records }))
  expect(applied.registrations).toEqual([])
  expect(mcp.servers.get("search")).toEqual({ type: "remote", url: "https://example.test" })
})

test("only the active base template is applied", async () => {
  const baseTemplates = [
    { id: "gpt", title: "GPT.txt", text: "gpt upstream" },
    { id: "general", title: "General.txt", text: "general upstream" },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "")])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [
    makeRecord({ item: "base:gpt", agent: "alpha", level: "project", text: "custom gpt" }),
    makeRecord({ item: "base:general", agent: "alpha", level: "project", text: "custom general" }),
  ]
  const applied = await apply(
    ctx,
    makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }),
  )
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const gpt = sessionEvent("alpha", {}, [{ type: "text", text: "family default" }], {
    providerID: "openai",
    id: "gpt-4o",
  })
  await Effect.runPromise(run(gpt))
  expect(gpt.system[0]?.text).toBe("custom gpt")
})

test("a stored base edit for a non-active template leaves system[0] alone", async () => {
  const baseTemplates = [
    { id: "gpt", title: "GPT.txt", text: "gpt base prompt" },
    { id: "general", title: "General.txt", text: "general upstream" },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "")])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [makeRecord({ item: "base:general", agent: "alpha", level: "project", text: "custom general" })]
  const applied = await apply(
    ctx,
    makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }),
  )
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent("alpha", {}, [{ type: "text", text: "family default" }], {
    providerID: "openai",
    id: "gpt-4o",
  })
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).toBe("family default")
})

test("a non-obvious model id takes the host classification, not a provider guess", async () => {
  const baseTemplates = [
    { id: "trinity", title: "Trinity.txt", text: "trinity upstream" },
    { id: "general", title: "General.txt", text: "general upstream" },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "", modelRef("acme", "trinity-ultra"))])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "trinity-ultra": "trinity" }),
    catalog: catalogHarness([modelInfo("acme", "trinity-ultra")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "trinity" })
  const records = [makeRecord({ item: "base:trinity", agent: "alpha", level: "project", text: "custom trinity" })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, records }))
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent("alpha", {}, [{ type: "text", text: "family default" }], {
    providerID: "acme",
    id: "trinity-ultra",
  })
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).toBe("custom trinity")
})

test("a custom-system agent keeps its own system[0]", async () => {
  const baseTemplates = [{ id: "gpt", title: "GPT.txt", text: "gpt upstream" }]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "my own prompt")])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [makeRecord({ item: "base:gpt", agent: "alpha", level: "project", text: "custom gpt" })]
  const applied = await apply(
    ctx,
    makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }),
  )
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent("alpha", {}, [{ type: "text", text: "my own prompt" }], {
    providerID: "openai",
    id: "gpt-4o",
  })
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).toBe("my own prompt")
})

test("per-file instructions drop or replace one part by canonical path", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plus-apply-canonical-"))
  applyRoots.push(parent)
  const root = path.join(parent, "repo")
  const project = path.join(root, "session")
  await fs.mkdir(project, { recursive: true })
  const projectAgents = path.join(project, "AGENTS.md")
  const ancestorAgents = path.join(root, "AGENTS.md")
  await fs.writeFile(projectAgents, "project guide\n")
  await fs.writeFile(ancestorAgents, "ancestor guide\n")
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    location: new Location.Info({
      directory: AbsolutePath.make(project),
      project: { id: Project.ID.global, directory: AbsolutePath.make(root), canonical: AbsolutePath.make(root) },
    }),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx)
  const records = [
    makeRecord({ item: "system:AGENTS.md", agent: "alpha", level: "project", text: "custom guide\n" }),
    makeRecord({ item: "system:../AGENTS.md", agent: "alpha", level: "project", state: "off" }),
  ]
  const applied = await apply(ctx, makeInput({ items: discovered.items, records }))
  // One session registration: applySession installs a single context hook
  // carrying both instruction plans (the project-file replace and the
  // ancestor-file drop).
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent(
    "alpha",
    {},
    [
      { type: "text", text: "project guide\n", metadata: { instruction: { path: projectAgents } } },
      { type: "text", text: "ancestor guide\n", metadata: { instruction: { path: ancestorAgents } } },
    ],
  )
  await Effect.runPromise(run(event))
  // resolve assembles custom text trimmed (the same normalization the
  // neighboring global/ancestor test pins: "custom ancestor\n" reads back as
  // "custom ancestor"), so the replaced project part reads back without its
  // trailing newline while the dropped ancestor part is gone.
  expect(event.system.map((part) => part.text)).toEqual(["custom guide"])
  // Direct unit path: no string surgery on a merged blob.
  const direct: SessionHooks["context"]["system"] = [{ type: "text", text: "merged blob" }]
  applyInstructions({ system: direct }, [])
  expect(direct).toHaveLength(1)
})

// Direct unit test of applyInstructions array mutation: synthetic system parts
// isolate part removal without disk instruction discovery. The full
// discover -> apply -> real-hook path is covered by the neighboring per-file
// tests; synthesizing here keeps this a pure mutation unit.
test("excluding one instruction removes exactly that part (direct applyInstructions unit)", async () => {
  const system: SessionHooks["context"]["system"] = [
    { type: "text", text: "guide", metadata: { instruction: { path: "/repo/AGENTS.md" } } },
    { type: "text", text: "other", metadata: { instruction: { path: "/repo/OTHER.md" } } },
  ]
  applyInstructions({ system }, [{ agent: "alpha", path: "/repo/OTHER.md", text: "other", enabled: false }])
  expect(system.map((part) => part.text)).toEqual(["guide"])
})

// Direct unit test of applyInstructions array mutation: synthetic system parts
// isolate in-place part replacement without disk instruction discovery. The
// full discover -> apply -> real-hook path is covered by the neighboring
// per-file tests; synthesizing here keeps this a pure mutation unit.
test("editing one instruction replaces its part rather than appending (direct applyInstructions unit)", async () => {
  const system: SessionHooks["context"]["system"] = [
    { type: "text", text: "guide", metadata: { instruction: { path: "/repo/AGENTS.md" } } },
    { type: "text", text: "other", metadata: { instruction: { path: "/repo/OTHER.md" } } },
  ]
  applyInstructions({ system }, [{ agent: "alpha", path: "/repo/AGENTS.md", text: "custom guide", enabled: true }])
  expect(system).toHaveLength(2)
  expect(system.map((part) => part.text)).toEqual(["custom guide", "other"])
  expect(system[0]?.metadata).toEqual({ instruction: { path: "/repo/AGENTS.md" } })
})

test("a request model switch gets the request model's customization, not the configured one", async () => {
  // DEFECT A: the agent's configured model is gpt (base "gpt"), but the
  // request arrives on a kimi model. Per-request classification must apply
  // the kimi customization, not the configured gpt one. Items use real host
  // template text, matching what discovery passes through verbatim.
  const baseTemplates = [
    { id: "gpt", title: "GPT.txt", text: "gpt base prompt" },
    { id: "kimi", title: "Kimi.txt", text: "kimi base prompt" },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "", modelRef("openai", "gpt-4o"))])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt", "kimi-k2": "kimi" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o"), modelInfo("moonshot", "kimi-k2")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [
    makeRecord({ item: "base:gpt", agent: "alpha", level: "project", text: "custom gpt" }),
    makeRecord({ item: "base:kimi", agent: "alpha", level: "project", text: "custom kimi" }),
  ]
  // The pin mirrors production: publishFresh always threads discover's
  // configured-model classification as agent.base, so the request model must
  // win over it rather than the pin short-circuiting classification.
  const applied = await apply(
    ctx,
    makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }),
  )
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent("alpha", {}, [{ type: "text", text: "family default" }], {
    providerID: "moonshot",
    id: "kimi-k2",
  })
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).toBe("custom kimi")
})

test("a customized raw base template renders tool guidance instead of the placeholder", async () => {
  // DEFECT B (before branch): the user edits the opening text, so the
  // customized surroundings no longer match live. Aligning the UPSTREAM
  // surroundings against live must still recover the rendered guidance.
  const upstream = "base header\n${OPENCODE_TOOL_GUIDANCE}\nbase footer"
  const guidance = "GUIDANCE-WRITE-EDIT-SHELL-123"
  const live = `base header\n${guidance}\nbase footer`
  const customized = "edited header\n${OPENCODE_TOOL_GUIDANCE}\nbase footer"
  const baseTemplates = [{ id: "gpt", title: "GPT.txt", text: upstream }]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "")])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [makeRecord({ item: "base:gpt", agent: "alpha", level: "project", text: customized })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }))
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent(
    "alpha",
    { write: { description: "write", input: { type: "object" } } },
    [{ type: "text", text: live }],
    { providerID: "openai", id: "gpt-4o" },
  )
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(event.system[0]?.text).toContain("edited header")
  expect(event.system[0]?.text).toContain(guidance)
})

test("appending after a customized base template preserves rendered tool guidance", async () => {
  // DEFECT B (after branch): the user appends after the template, so the
  // customized trailing text no longer matches live. Upstream alignment must
  // still recover the rendered guidance span.
  const upstream = "base header\n${OPENCODE_TOOL_GUIDANCE}\nbase footer"
  const guidance = "GUIDANCE-WRITE-EDIT-SHELL-123"
  const live = `base header\n${guidance}\nbase footer`
  const customized = "base header\n${OPENCODE_TOOL_GUIDANCE}\nbase footer appended"
  const baseTemplates = [{ id: "gpt", title: "GPT.txt", text: upstream }]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "")])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [makeRecord({ item: "base:gpt", agent: "alpha", level: "project", text: customized })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }))
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent(
    "alpha",
    { write: { description: "write", input: { type: "object" } } },
    [{ type: "text", text: live }],
    { providerID: "openai", id: "gpt-4o" },
  )
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(event.system[0]?.text).toContain("appended")
  expect(event.system[0]?.text).toContain(guidance)
})

test("a customized gpt base keeps astra-rendered tool guidance on a gpt-6 request", async () => {
  // Third P1 in the guidance family: Plus discovers the canonical gpt.txt
  // as upstream, but core's OpenAI optimize plugin renders gpt-astra.txt
  // for gpt-6 ids. Aligning gpt upstream against astra live finds no
  // suffix, so the classification-keyed code empties the marker and
  // destroys the write/edit/shell guidance core actually rendered. The
  // real core templates and the real core renderer reproduce it; an
  // artificial matching pair cannot.
  const live = SessionSystemPrompt.render(PROMPT_ASTRA, ["write", "edit", "shell"])
  const customized = `MY-CUSTOM-HEADER-123\n\n${PROMPT_GPT}`
  const baseTemplates = [{ id: "gpt", title: "GPT.txt", text: PROMPT_GPT }]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "")])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-6": "gpt" }, { "gpt-6": PROMPT_ASTRA }),
    catalog: catalogHarness([modelInfo("openai", "gpt-6", "GPT 6")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [makeRecord({ item: "base:gpt", agent: "alpha", level: "project", text: customized })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }))
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent(
    "alpha",
    {
      write: { description: "write", input: { type: "object" } },
      edit: { description: "edit", input: { type: "object" } },
      shell: { description: "shell", input: { type: "object" } },
    },
    [{ type: "text", text: live }],
    { providerID: "openai", id: "gpt-6" },
  )
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(event.system[0]?.text).toContain("MY-CUSTOM-HEADER-123")
  expect(event.system[0]?.text).toContain("Use the write tool")
})

test("live system prompt with mismatched prefix leaves system[0] untouched", async () => {
  // When live system text before the tool guidance marker does not match the
  // raw template's prefix (for example, foreign middleware modified system[0]
  // ahead of guidance), alignment cannot safely locate where guidance begins.
  // Plus aborts the base plan so the live prompt and tool guidance are kept intact.
  const upstream = "base header\n${OPENCODE_TOOL_GUIDANCE}\nbase footer"
  const guidance = "GUIDANCE-WRITE-EDIT-SHELL-123"
  const live = `foreign header\n${guidance}\nbase footer`
  const customized = "edited header\n${OPENCODE_TOOL_GUIDANCE}\nbase footer"
  const baseTemplates = [{ id: "gpt", title: "GPT.txt", text: upstream }]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "")])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [makeRecord({ item: "base:gpt", agent: "alpha", level: "project", text: customized })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }))
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent(
    "alpha",
    { write: { description: "write", input: { type: "object" } } },
    [{ type: "text", text: live }],
    { providerID: "openai", id: "gpt-4o" },
  )
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).toBe(live)
  expect(event.system[0]?.text).toContain(guidance)
  expect(event.system[0]?.text).not.toContain("edited header")
})

test("live system prompt with mismatched suffix leaves system[0] untouched", async () => {
  // When live system text after the tool guidance marker does not match the
  // raw template's suffix (for example, foreign middleware altered text following
  // guidance), alignment cannot safely locate where guidance ends. Plus aborts
  // the base plan so the live prompt and tool guidance are kept intact.
  const upstream = "base header\n${OPENCODE_TOOL_GUIDANCE}\nbase footer"
  const guidance = "GUIDANCE-WRITE-EDIT-SHELL-123"
  const live = `base header\n${guidance}\nforeign footer`
  const customized = "edited header\n${OPENCODE_TOOL_GUIDANCE}\nbase footer"
  const baseTemplates = [{ id: "gpt", title: "GPT.txt", text: upstream }]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "")])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [makeRecord({ item: "base:gpt", agent: "alpha", level: "project", text: customized })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }))
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent(
    "alpha",
    { write: { description: "write", input: { type: "object" } } },
    [{ type: "text", text: live }],
    { providerID: "openai", id: "gpt-4o" },
  )
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).toBe(live)
  expect(event.system[0]?.text).toContain(guidance)
  expect(event.system[0]?.text).not.toContain("edited header")
})

test("an untouched base template with a trailing newline installs no base plan", async () => {
  // DEFECT B (no-op half): assemble trims, so a raw template ending in a
  // newline never round-trips byte-identically. With records present for an
  // unrelated item but none for the base, Plus must leave system[0] alone —
  // pre-fix it overwrites system[0] with trimmed RAW text (restoring the
  // placeholder) during an unrelated save.
  const raw = "gpt base prompt\n${OPENCODE_TOOL_GUIDANCE}\n"
  const baseTemplates = [{ id: "gpt", title: "GPT.txt", text: raw }]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "")])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o")]),
    tool: toolDomainFor([nativeTool("reader", "read things")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const records = [makeRecord({ item: "tool:reader", agent: "alpha", level: "project", text: "custom description" })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, records, agents: [{ id: "alpha", level: "project", base: "gpt" }] }))
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent(
    "alpha",
    { reader: { description: "read things", input: { type: "object" } } },
    [{ type: "text", text: "rendered family default" }],
    { providerID: "openai", id: "gpt-4o" },
  )
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).toBe("rendered family default")
  expect(event.tools.reader?.description).toBe("custom description")
})

const applyRoots: string[] = []

afterEach(async () => {
  await Promise.all(applyRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

test("disabling the global instruction file removes that part, not the project one", async () => {
  // DEFECT C: discovery yields location-relative ids (see
  // test/discover.test.ts "instruction files follow core order": "system:AGENTS.md"
  // for the session file, "system:../AGENTS.md"-style for ancestors, and a long
  // relative climb for the global file) while core delivers canonical absolute
  // paths. Disabling the global file must remove the global part, and editing
  // an ancestor file must replace that part. The ids below mirror that real
  // discovery shape; the temp files pin the absolute side.
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plus-apply-instructions-"))
  applyRoots.push(parent)
  const root = path.join(parent, "repo")
  const project = path.join(root, "session")
  await fs.mkdir(project, { recursive: true })
  const config = path.join(parent, "config")
  const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = config
  try {
    await fs.writeFile(path.join(root, "AGENTS.md"), "ancestor guide\n")
    await fs.writeFile(path.join(project, "AGENTS.md"), "project guide\n")
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(path.join(config, "AGENTS.md"), "global guide\n")
    const globalId = `system:${path.relative(project, path.join(config, "AGENTS.md"))}`
    const globalPath = path.join(config, "AGENTS.md")
    const ancestorPath = path.join(root, "AGENTS.md")
    const projectPath = path.join(project, "AGENTS.md")
    // Direct unit path with canonical absolute plan paths (the shape
    // applyInstructionPlans produces after resolving discovery ids).
    const direct: SessionHooks["context"]["system"] = [
      { type: "text", text: "ancestor guide\n", metadata: { instruction: { path: ancestorPath } } },
      { type: "text", text: "project guide\n", metadata: { instruction: { path: projectPath } } },
    ]
    applyInstructions({ system: direct }, [{ agent: "alpha", path: ancestorPath, text: "custom ancestor\n", enabled: true }])
    expect(direct.map((part) => part.text)).toEqual(["custom ancestor\n", "project guide\n"])
    // Full hook path: records keyed by real discovery ids resolve against the
    // owning session directory to the same canonical paths.
    const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
    const ctx = context({
      location: new Location.Info({
        directory: AbsolutePath.make(project),
        project: { id: Project.ID.global, directory: AbsolutePath.make(root), canonical: AbsolutePath.make(root) },
      }),
      session: {
        hook: (name, callback) => {
          if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    })
    const discovered = await discoverFor(ctx)
    const records = [
      makeRecord({ item: globalId, agent: "alpha", level: "project", state: "off" }),
      makeRecord({ item: "system:../AGENTS.md", agent: "alpha", level: "project", text: "custom ancestor\n" }),
    ]
    const applied = await apply(ctx, makeInput({ items: discovered.items, records }))
    expect(applied.registrations).toHaveLength(1)
    const run = callbacks[0]
    if (!run) throw new Error("missing context hook")
    const event = sessionEvent(
      "alpha",
      {},
      [
        { type: "text", text: "global guide\n", metadata: { instruction: { path: globalPath } } },
        { type: "text", text: "ancestor guide\n", metadata: { instruction: { path: ancestorPath } } },
        { type: "text", text: "project guide\n", metadata: { instruction: { path: projectPath } } },
      ],
    )
    await Effect.runPromise(run(event))
    // Global part removed; ancestor part replaced in place (assembled text is
    // trimmed by resolve) with no duplicate appended.
    expect(event.system.map((part) => part.text)).toEqual(["custom ancestor", "project guide\n"])
    expect(event.system).toHaveLength(2)
  } finally {
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  }
})

test("no-op updates install nothing and reload nothing", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const ctx = context({
    agent: agents.domain,
  })
  const discovered = await discoverFor(ctx)
  const records = [makeRecord({ item: "system:role", agent: "alpha", level: "project", text: "upstream" })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, records }))
  expect(applied.registrations).toEqual([])
})

test("empty records install nothing", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const ctx = context({
    agent: agents.domain,
  })
  const discovered = await discoverFor(ctx)
  const applied = await apply(ctx, makeInput({ items: discovered.items, records: [] }))
  expect(applied.registrations).toEqual([])
})

test("an active model sets the host agent model and no active installs nothing", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({ agent: agents.domain })
  const discovered = await discoverFor(ctx)
  const models = [
    { type: "model" as const, level: "project" as const, agent: "alpha", providerID: "acme", modelID: "nova-2", active: true as const, updated: UPDATED },
  ]
  const applied = await apply(
    ctx,
    makeInput({ items: discovered.items, records: [], models, scopes: scopesOf(discovered.agents), agents: [{ id: "alpha", level: "project" }, { id: "beta", level: "project" }] }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(agents.state.get("alpha")?.model).toMatchObject({ providerID: "acme", id: "nova-2" })
  expect(agents.state.get("beta")?.model).toBeUndefined()
  const none = await apply(ctx, makeInput({ items: discovered.items, records: [], models: [], agents: [{ id: "alpha", level: "project" }] }))
  expect(none.registrations).toEqual([])
})

test("the base template follows the switched model family per request", async () => {
  const baseTemplates = [
    { id: "gpt", title: "GPT.txt", text: "gpt base prompt" },
    { id: "kimi", title: "Kimi.txt", text: "kimi base prompt" },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "", modelRef("openai", "gpt-4o"))])
  const ctx = context({
    agent: agents.domain,
    prompt: promptHarness(baseTemplates, { "gpt-4o": "gpt", "kimi-k2": "kimi" }),
    catalog: catalogHarness([modelInfo("openai", "gpt-4o"), modelInfo("moonshot", "kimi-k2")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx, { baseTemplates, activeBase: () => "gpt" })
  const models = [
    { type: "model" as const, level: "project" as const, agent: "alpha", providerID: "moonshot", modelID: "kimi-k2", active: true as const, updated: UPDATED },
  ]
  const records = [makeRecord({ item: "base:kimi", agent: "alpha", level: "project", text: "custom kimi" })]
  const applied = await apply(
    ctx,
    makeInput({ items: discovered.items, records, models, scopes: scopesOf(discovered.agents), agents: [{ id: "alpha", level: "project", base: "gpt" }] }),
  )
  expect(agents.state.get("alpha")?.model).toMatchObject({ providerID: "moonshot", id: "kimi-k2" })
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent("alpha", {}, [{ type: "text", text: "family default" }], { providerID: "moonshot", id: "kimi-k2" })
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).toBe("custom kimi")
})

test("a mid-way failure unwinds earlier registrations in reverse order", async () => {
  const events: string[] = []
  const skills = skillHarness([skillInfo("notes", "skill body")])
  const stateAgents = agentHarness([agentInfo("alpha", "upstream")])
  const tools = toolDomainFor([nativeTool("reader", "read things")])
  const mcp = mcpState([["search", { type: "remote", url: "https://example.test" }]])
  const discoverCtx = context({
    agent: stateAgents.domain,
    skill: skills.domain,
    tool: tools,
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcp.editor as never)
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
  })
  const discovered = await discoverFor(discoverCtx)
  const records = [
    makeRecord({ item: "system:role", agent: "alpha", level: "project", text: "custom prompt" }),
    makeRecord({ item: "skill:notes", agent: "alpha", level: "project", text: "custom skill" }),
    makeRecord({ item: "tool:reader", agent: "alpha", level: "project", text: "custom tool" }),
    makeRecord({ item: "mcp:search", agent: null, level: "defaults", state: "off" }),
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          const tag = events.some((entry) => entry.startsWith("install:")) ? "skill-agent-rules" : "prompt"
          events.push(`install:${tag}`)
          const res = Effect.runSync(Effect.scoped(stateAgents.domain.transform(callback)))
          return {
            dispose: Effect.sync(() => {
              events.push(`dispose:${tag}`)
              Effect.runSync(res.dispose)
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
    tool: tools,
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
    apply(ctx, makeInput({ items: discovered.items, records })),
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
  expect(skills.added).toEqual([])
  expect(skills.state.get(copyName("alpha", "notes"))).toBeUndefined()
  expect(skills.state.get("notes")?.content).toBe("skill body")
  expect(stateAgents.state.get("alpha")?.system).toBe("upstream")
  // apply() installs two agent transforms in this scenario (the role prompt
  // via install:prompt and the skill agent rules via install:skill-agent-rules),
  // so a correct unwind disposes every installed agent transform.
  expect(stateAgents.disposes).toBe(stateAgents.transforms)
})

test("a perm rule off installs a core deny proved by Permission.evaluate (not a local matcher)", async () => {
  const { evaluate } = await import("../../core/src/permission.js")
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({
    agent: agents.domain,
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const shellText = "Execute shell commands."
  const permText = "Git push\ngit push *"
  const items = [
    { id: "tool:shell", kind: "tool" as const, group: "native" as const, title: "shell", text: shellText, enabled: true, fingerprint: fingerprint(shellText) },
    { id: "perm:shell:git-push", kind: "perm" as const, group: "none" as const, title: "Git push", text: permText, enabled: true, fingerprint: fingerprint(permText), permTool: "shell", ruleId: "git-push", patterns: ["git push *"], keywords: ["git push"], provenance: [] as string[] },
  ]
  const records = [makeRecord({ item: "perm:shell:git-push", agent: "alpha", level: "project", state: "off" })]
  const applied = await apply(ctx, makeInput({ items, records, agents: [{ id: "alpha", level: "project" }, { id: "beta", level: "project" }] }))
  expect(applied.registrations.length).toBeGreaterThan(0)
  const alphaRules = agents.state.get("alpha")?.permissions ?? []
  expect(alphaRules.slice(-1)).toEqual([{ action: "shell", resource: "git push *", effect: "deny" }])
  expect(agents.state.get("beta")?.permissions.some((rule) => rule.action === "shell")).toBe(false)
  expect(evaluate("shell", "git push origin", alphaRules).effect).toBe("deny")
  expect(evaluate("shell", "git status", alphaRules).effect).not.toBe("deny")
})

test("patch operation rules off install per-action denies proved by Permission.evaluate", async () => {
  const { evaluate } = await import("../../core/src/permission.js")
  const { match } = await import("../../core/src/util/wildcard.js")
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({
    agent: agents.domain,
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const patchText = "Apply file patches."
  const addText = "Add file\n*"
  const updateText = "Update file\n*"
  const deleteText = "Delete file\n*"
  const items = [
    { id: "tool:patch", kind: "tool" as const, group: "native" as const, title: "patch", text: patchText, enabled: true, fingerprint: fingerprint(patchText) },
    { id: "perm:patch:add-file", kind: "perm" as const, group: "none" as const, title: "Add file", text: addText, enabled: true, fingerprint: fingerprint(addText), permTool: "patch", ruleId: "add-file", patterns: ["*"], keywords: [] as string[], provenance: [] as string[], permAction: "patch.add" },
    { id: "perm:patch:update-file", kind: "perm" as const, group: "none" as const, title: "Update file", text: updateText, enabled: true, fingerprint: fingerprint(updateText), permTool: "patch", ruleId: "update-file", patterns: ["*"], keywords: [] as string[], provenance: [] as string[], permAction: "patch.update" },
    { id: "perm:patch:delete-file", kind: "perm" as const, group: "none" as const, title: "Delete file", text: deleteText, enabled: true, fingerprint: fingerprint(deleteText), permTool: "patch", ruleId: "delete-file", patterns: ["*"], keywords: [] as string[], provenance: [] as string[], permAction: "patch.delete" },
  ]
  const records = [
    makeRecord({ item: "perm:patch:add-file", agent: "alpha", level: "project", state: "off" }),
    makeRecord({ item: "perm:patch:update-file", agent: "alpha", level: "project", state: "off" }),
    makeRecord({ item: "perm:patch:delete-file", agent: "alpha", level: "project", state: "off" }),
  ]
  const applied = await apply(ctx, makeInput({ items, records, agents: [{ id: "alpha", level: "project" }, { id: "beta", level: "project" }] }))
  expect(applied.registrations.length).toBeGreaterThan(0)
  const alphaRules = agents.state.get("alpha")?.permissions ?? []
  expect(alphaRules.slice(-3)).toEqual([
    { action: "patch.add", resource: "*", effect: "deny" },
    { action: "patch.update", resource: "*", effect: "deny" },
    { action: "patch.delete", resource: "*", effect: "deny" },
  ])
  expect(agents.state.get("beta")?.permissions.some((rule) => String(rule.action).startsWith("patch."))).toBe(false)
  expect(evaluate("patch.add", "src/a.ts", alphaRules).effect).toBe("deny")
  expect(evaluate("patch.update", "src/a.ts", alphaRules).effect).toBe("deny")
  expect(evaluate("patch.delete", "src/a.ts", alphaRules).effect).toBe("deny")
  expect(evaluate("edit", "src/a.ts", alphaRules).effect).not.toBe("deny")
  expect(evaluate("patch.add", "src/a.ts", alphaRules).effect).toBe("deny")
  expect(match("src/a.ts", "*")).toBe(true)
})

test("a perm rule off scrubs whole-word lines, keeping head-only lines", async () => {
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    tool: toolDomainFor([nativeTool("reader", "read things")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const description = "Use git push to publish.\nUse git status to inspect.\nUse gitpush without space."
  const permText = "Git push\ngit push *"
  const items = [
    { id: "tool:shell", kind: "tool" as const, group: "native" as const, title: "shell", text: "shell tool", enabled: true, fingerprint: fingerprint("shell tool") },
    { id: "perm:shell:git-push", kind: "perm" as const, group: "none" as const, title: "Git push", text: permText, enabled: true, fingerprint: fingerprint(permText), permTool: "shell", ruleId: "git-push", patterns: ["git push *"], keywords: ["git push"], provenance: [] as string[] },
  ]
  const records = [makeRecord({ item: "perm:shell:git-push", agent: "alpha", level: "project", state: "off" })]
  const applied = await apply(ctx, makeInput({ items, records, agents: [{ id: "alpha", level: "project" }] }))
  expect(applied.registrations.length).toBeGreaterThan(0)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent("alpha", {}, [{ type: "text", text: description }])
  await Effect.runPromise(run(event))
  const text = event.system.map((part) => part.text).join("\n")
  expect(text).not.toContain("git push to publish")
  expect(text).toContain("git status")
  expect(text).toContain("gitpush without space")
})

test("a broad scrub keyword never empties a tool description or system text", async () => {
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    tool: toolDomainFor([nativeTool("reader", "read things")]),
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const description = "git push\n git PUSH "
  const permText = "Git push\ngit push *"
  const items = [
    { id: "tool:shell", kind: "tool" as const, group: "native" as const, title: "shell", text: "shell tool", enabled: true, fingerprint: fingerprint("shell tool") },
    { id: "perm:shell:git-push", kind: "perm" as const, group: "none" as const, title: "Git push", text: permText, enabled: true, fingerprint: fingerprint(permText), permTool: "shell", ruleId: "git-push", patterns: ["git push *"], keywords: ["git push"], provenance: [] as string[] },
  ]
  const records = [makeRecord({ item: "perm:shell:git-push", agent: "alpha", level: "project", state: "off" })]
  const applied = await apply(ctx, makeInput({ items, records, agents: [{ id: "alpha", level: "project" }] }))
  expect(applied.registrations.length).toBeGreaterThan(0)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const event = sessionEvent("alpha", { shell: { description, input: { type: "object" } } }, [{ type: "text", text: description }])
  await Effect.runPromise(run(event))
  expect(event.tools["shell"]?.description).toBe(description)
  expect(event.system.map((part) => part.text).join("\n")).toBe(description)
})

test("editing the teaching row for one agent replaces that agent's part only", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plus-apply-teaching-"))
  applyRoots.push(parent)
  const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = path.join(parent, "config")
  try {
    const root = path.join(parent, "repo")
    const project = path.join(root, "session")
    await fs.mkdir(project, { recursive: true })
    const seeded = await seedSystemInstruction()
    expect(seeded.path).toBe(teachingFilePath())
    const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
    const ctx = context({
      location: new Location.Info({
        directory: AbsolutePath.make(project),
        project: { id: Project.ID.global, directory: AbsolutePath.make(root), canonical: AbsolutePath.make(root) },
      }),
      session: {
        hook: (name, callback) => {
          if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    })
    const discovered = await discoverFor(ctx)
    const row = discovered.items.find((item) => item.id === teachingItemId)
    if (row === undefined) throw new Error("expected teaching row")
    const records = [
      makeRecord({ item: teachingItemId, agent: "alpha", level: "project", text: "custom teaching", basedOn: fingerprint(row.text) }),
    ]
    const applied = await apply(
      ctx,
      makeInput({
        items: discovered.items,
        records,
        agents: [
          { id: "alpha", level: "project" },
          { id: "beta", level: "project" },
        ],
      }),
    )
    expect(applied.registrations).toHaveLength(1)
    const run = callbacks[0]
    if (!run) throw new Error("missing context hook")
    const alpha = sessionEvent(
      "alpha",
      {},
      [{ type: "text", text: row.text, metadata: { instruction: { path: seeded.path } } }],
    )
    const beta = sessionEvent(
      "beta",
      {},
      [{ type: "text", text: row.text, metadata: { instruction: { path: seeded.path } } }],
    )
    await Effect.runPromise(run(alpha))
    await Effect.runPromise(run(beta))
    expect(alpha.system.map((part) => part.text)).toEqual(["custom teaching"])
    expect(beta.system.map((part) => part.text)).toEqual([row.text])
  } finally {
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  }
})

test("toggling the teaching row off removes that part", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plus-apply-teaching-off-"))
  applyRoots.push(parent)
  const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = path.join(parent, "config")
  try {
    const root = path.join(parent, "repo")
    const project = path.join(root, "session")
    await fs.mkdir(project, { recursive: true })
    const seeded = await seedSystemInstruction()
    const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
    const ctx = context({
      location: new Location.Info({
        directory: AbsolutePath.make(project),
        project: { id: Project.ID.global, directory: AbsolutePath.make(root), canonical: AbsolutePath.make(root) },
      }),
      session: {
        hook: (name, callback) => {
          if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    })
    const discovered = await discoverFor(ctx)
    const row = discovered.items.find((item) => item.id === teachingItemId)
    if (row === undefined) throw new Error("expected teaching row")
    const records = [makeRecord({ item: teachingItemId, agent: "alpha", level: "project", state: "off" })]
    const applied = await apply(
      ctx,
      makeInput({
        items: discovered.items,
        records,
        agents: [
          { id: "alpha", level: "project" },
          { id: "beta", level: "project" },
        ],
      }),
    )
    expect(applied.registrations).toHaveLength(1)
    const run = callbacks[0]
    if (!run) throw new Error("missing context hook")
    const alpha = sessionEvent(
      "alpha",
      {},
      [{ type: "text", text: row.text, metadata: { instruction: { path: seeded.path } } }],
    )
    const beta = sessionEvent(
      "beta",
      {},
      [{ type: "text", text: row.text, metadata: { instruction: { path: seeded.path } } }],
    )
    await Effect.runPromise(run(alpha))
    await Effect.runPromise(run(beta))
    expect(alpha.system).toEqual([])
    expect(beta.system.map((part) => part.text)).toEqual([row.text])
  } finally {
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  }
})

function codemodeTool(id: string, description: string): Tool.Info & { readonly id: string } {
  return {
    id,
    name: id,
    description,
    input: Schema.Void,
    execute: () => Effect.die("unused tool.execute"),
  }
}

test("catalogPath derives the qualified dotted path, not the registry id", async () => {
  // Core builds the registry id with underscores but the catalog path with
  // dots: namespace "my.server" + raw name "read:file" becomes registry
  // "my_server_read_file" but catalog "my.server.read_file". The registry id
  // is not reversible, so apply must derive the path from namespace + title.
  expect(catalogPath({ namespace: "my.server", title: "read:file" })).toBe("my.server.read_file")
  expect(catalogPath({ title: "plain" })).toBe("plain")
})

test("a Code Mode tool switched off for one agent installs a deny rule on that agent only", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([codemodeTool("coder", "code mode tool")]),
  })
  const discovered = await discoverFor(ctx)
  const records = [makeRecord({ item: "tool:coder", agent: "alpha", level: "project", state: "off" })]
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: [
        { id: "alpha", level: "project" },
        { id: "beta", level: "project" },
      ],
      scopes: scopesOf(discovered.agents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(applied.tools).toEqual([])
  expect(agents.state.get("alpha")?.permissions.slice(-1)).toEqual([{ action: "coder", resource: "*", effect: "deny" }])
  expect(agents.state.get("beta")?.permissions.some((rule) => rule.action === "coder" && rule.effect === "deny")).toBe(false)
  expect(agents.reloads).toBe(1)
})

test("a Defaults-level off cascades to the agents that inherit it", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([codemodeTool("coder", "code mode tool")]),
  })
  const discovered = await discoverFor(ctx)
  const records: CustomizationRecord[] = [{
    type: "customization",
    level: "defaults",
    agent: null,
    item: "tool:coder",
    section: null,
    state: "off",
    basedOn: fingerprint("upstream"),
    updated: UPDATED,
  }]
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: [
        { id: "alpha", level: "project" },
        { id: "beta", level: "project" },
      ],
      scopes: scopesOf(discovered.agents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(agents.state.get("alpha")?.permissions.slice(-1)).toEqual([{ action: "coder", resource: "*", effect: "deny" }])
  expect(agents.state.get("beta")?.permissions.slice(-1)).toEqual([{ action: "coder", resource: "*", effect: "deny" }])
  expect(agents.reloads).toBe(1)
})

test("the execute row switched off installs a deny for execute", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([codemodeTool("coder", "code mode tool")]),
  })
  const discovered = await discoverFor(ctx)
  expect(discovered.items.some((item) => item.id === "tool:execute")).toBe(true)
  const records = [makeRecord({ item: "tool:execute", agent: "alpha", level: "project", state: "off" })]
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: [
        { id: "alpha", level: "project" },
        { id: "beta", level: "project" },
      ],
      scopes: scopesOf(discovered.agents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(agents.state.get("alpha")?.permissions.slice(-1)).toEqual([{ action: "execute", resource: "*", effect: "deny" }])
  expect(agents.state.get("beta")?.permissions.some((rule) => rule.action === "execute" && rule.effect === "deny")).toBe(false)
  expect(agents.reloads).toBe(1)
})

test("the catalog hook rewrites description and pinned for the right agent only", async () => {
  const catalogCallbacks: ((event: SessionHooks["catalog"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([codemodeTool("coder", "code mode tool")]),
    session: {
      hook: (name, callback) => {
        if (name === "catalog") catalogCallbacks.push(callback as (event: SessionHooks["catalog"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx)
  const coder = discovered.items.find((item) => item.id === "tool:coder")
  if (!coder) throw new Error("expected tool:coder")
  const records = [makeRecord({ item: "tool:coder", agent: "alpha", level: "project", text: "custom description", pin: true })]
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: [
        { id: "alpha", level: "project" },
        { id: "beta", level: "project" },
      ],
      scopes: scopesOf(discovered.agents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(catalogCallbacks).toHaveLength(1)
  expect(applied.tools).toEqual([
    { agent: "alpha", tool: "coder", enabled: true, text: "custom description", codemode: true, catalogPath: "coder", pinned: true },
  ])
  const run = catalogCallbacks[0]
  if (!run) throw new Error("missing catalog hook")
  const alphaEvent: SessionHooks["catalog"] = {
    sessionID: Session.ID.make("ses_catalog_alpha"),
    agent: Agent.ID.make("alpha"),
    tools: {
      coder: { description: "code mode tool", pinned: false },
      other: { description: "untouched", pinned: false },
    },
  }
  await Effect.runPromise(run(alphaEvent))
  expect(alphaEvent.tools.coder?.description).toBe("custom description")
  expect(alphaEvent.tools.coder?.pinned).toBe(true)
  expect(alphaEvent.tools.other?.description).toBe("untouched")
  expect(Object.keys(alphaEvent.tools).toSorted()).toEqual(["coder", "other"])
  const betaEvent: SessionHooks["catalog"] = {
    sessionID: Session.ID.make("ses_catalog_beta"),
    agent: Agent.ID.make("beta"),
    tools: { coder: { description: "code mode tool", pinned: false } },
  }
  await Effect.runPromise(run(betaEvent))
  expect(betaEvent.tools.coder?.description).toBe("code mode tool")
  expect(betaEvent.tools.coder?.pinned).toBe(false)
  // A plan for a path the event does not carry never creates a key.
  const missingEvent: SessionHooks["catalog"] = {
    sessionID: Session.ID.make("ses_catalog_missing"),
    agent: Agent.ID.make("alpha"),
    tools: { other: { description: "untouched", pinned: false } },
  }
  await Effect.runPromise(run(missingEvent))
  expect(Object.keys(missingEvent.tools)).toEqual(["other"])
})

test("a namespaced tool joins the catalog by dotted path, not registry id", async () => {
  const catalogCallbacks: ((event: SessionHooks["catalog"]) => Effect.Effect<void>)[] = []
  const namespaced: Tool.Info & { readonly id: string } = {
    id: "my_server_read_file",
    name: "read:file",
    description: "namespaced tool",
    input: Schema.Void,
    options: { namespace: "my.server" },
    execute: () => Effect.die("unused tool.execute"),
  }
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([namespaced]),
    session: {
      hook: (name, callback) => {
        if (name === "catalog") catalogCallbacks.push(callback as (event: SessionHooks["catalog"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx)
  const item = discovered.items.find((entry) => entry.id === "tool:my_server_read_file")
  if (!item) throw new Error("expected namespaced tool item")
  expect(item.namespace).toBe("my.server")
  expect(item.title).toBe("read:file")
  expect(catalogPath(item)).toBe("my.server.read_file")
  const records = [makeRecord({ item: "tool:my_server_read_file", agent: "alpha", level: "project", text: "custom namespaced" })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, scopes: scopesOf(discovered.agents), records }))
  expect(applied.tools).toEqual([
    {
      agent: "alpha",
      tool: "my_server_read_file",
      enabled: true,
      text: "custom namespaced",
      codemode: true,
      catalogPath: "my.server.read_file",
      pinned: false,
    },
  ])
  const run = catalogCallbacks[0]
  if (!run) throw new Error("missing catalog hook")
  const event: SessionHooks["catalog"] = {
    sessionID: Session.ID.make("ses_catalog_namespaced"),
    agent: Agent.ID.make("alpha"),
    tools: { "my.server.read_file": { description: "namespaced tool", pinned: false } },
  }
  await Effect.runPromise(run(event))
  expect(event.tools["my.server.read_file"]?.description).toBe("custom namespaced")
  expect("my_server_read_file" in event.tools).toBe(false)
})

test("a catalog failure unwinds the denial installed earlier in the pass", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([codemodeTool("coder", "code mode tool")]),
    session: {
      hook: (name) => {
        if (name === "catalog") return Effect.die(new Error("catalog hook failed"))
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx)
  const records = [
    makeRecord({ item: "tool:coder", agent: "alpha", level: "project", state: "off", text: "custom", pin: true }),
  ]
  // The off installs a denial and the text+pin installs a catalog plan in the
  // same pass. The catalog hook then fails, so the denial must unwind rather
  // than leaving the agent denied.
  const before = agents.state.get("alpha")?.permissions.length ?? 0
  await expect(apply(ctx, makeInput({ items: discovered.items, scopes: scopesOf(discovered.agents), records }))).rejects.toThrow(
    "catalog hook failed",
  )
  expect(agents.state.get("alpha")?.permissions).toHaveLength(before)
  expect(agents.transforms).toBe(agents.disposes)
})

test("a pin-only change installs a catalog plan that sets pinned without touching description", async () => {
  const catalogCallbacks: ((event: SessionHooks["catalog"]) => Effect.Effect<void>)[] = []
  const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([codemodeTool("coder", "code mode tool")]),
    session: {
      hook: (name, callback) => {
        if (name === "catalog") catalogCallbacks.push(callback as (event: SessionHooks["catalog"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discoverFor(ctx)
  // No text, no state: only the pin differs from the registry default, so the
  // candidate must still survive to the catalog hook.
  const records = [makeRecord({ item: "tool:coder", agent: "alpha", level: "project", pin: true })]
  const applied = await apply(
    ctx,
    makeInput({
      items: discovered.items,
      agents: [
        { id: "alpha", level: "project" },
        { id: "beta", level: "project" },
      ],
      scopes: scopesOf(discovered.agents),
      records,
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(catalogCallbacks).toHaveLength(1)
  expect(applied.tools).toEqual([
    { agent: "alpha", tool: "coder", enabled: true, text: "code mode tool", codemode: true, catalogPath: "coder", pinned: true },
  ])
  const run = catalogCallbacks[0]
  if (!run) throw new Error("missing catalog hook")
  const alphaEvent: SessionHooks["catalog"] = {
    sessionID: Session.ID.make("ses_catalog_pin_only"),
    agent: Agent.ID.make("alpha"),
    tools: { coder: { description: "code mode tool", pinned: false } },
  }
  await Effect.runPromise(run(alphaEvent))
  expect(alphaEvent.tools.coder?.description).toBe("code mode tool")
  expect(alphaEvent.tools.coder?.pinned).toBe(true)
  const betaEvent: SessionHooks["catalog"] = {
    sessionID: Session.ID.make("ses_catalog_pin_only_beta"),
    agent: Agent.ID.make("beta"),
    tools: { coder: { description: "code mode tool", pinned: false } },
  }
  await Effect.runPromise(run(betaEvent))
  expect(betaEvent.tools.coder?.description).toBe("code mode tool")
  expect(betaEvent.tools.coder?.pinned).toBe(false)
})

test("a pin matching the registry default installs no catalog plan", async () => {
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const ctx = context({
    agent: agents.domain,
    tool: toolDomainFor([codemodeTool("coder", "code mode tool")]),
    session: {
      hook: () => Effect.die("catalog hook must not install"),
    },
  })
  const discovered = await discoverFor(ctx)
  // The registry default pin is false and the record pins false: text and
  // enabled are untouched, so there is nothing to install.
  const records = [makeRecord({ item: "tool:coder", agent: "alpha", level: "project", pin: false })]
  const applied = await apply(ctx, makeInput({ items: discovered.items, scopes: scopesOf(discovered.agents), records }))
  expect(applied.registrations).toEqual([])
  expect(applied.tools).toEqual([])
})

test("editing a curated patch rule keeps its operation action through apply proved by Permission.evaluate", async () => {
  // Whole path, not pieces: discovery -> edit and save through the real API
  // -> discovery again -> apply. Editing just the label of Delete file must
  // keep patch.delete; without the fix the custom overlay recomputes edit
  // from the tool's options.permission, so turning the row off installs
  // edit + * deny (blocking every patch operation plus ordinary edits)
  // instead of only deletions.
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plus-apply-patch-action-"))
  applyRoots.push(parent)
  const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = path.join(parent, "config")
  try {
    const project = path.join(parent, "project")
    await enable(project)
    const patchTool = {
      id: "patch",
      description: "Apply file patches.",
      options: { codemode: false, permission: "edit" },
    }
    const plusCtx = fullContext({
      directory: project,
      agents: [agentInfo("alpha", "upstream role")],
      tools: [patchTool],
      session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
    })
    const api = createPlusApi(plusCtx, createState())
    const first = await api.snapshot()
    if (!first.ok) throw new Error(`snapshot failed: ${first.error.message}`)
    const curated = first.value.items.find((item) => item.id === "perm:patch:delete-file")
    if (curated === undefined) throw new Error("expected perm:patch:delete-file")
    expect(curated.permAction).toBe("patch.delete")
    const edited = await api.updateRule({
      level: "project",
      agent: "alpha",
      tool: "patch",
      id: "delete-file",
      label: "Delete file edited",
      patterns: ["*"],
      keywords: ["patch-delete-probe"],
      actor: { type: "tui" },
    })
    if (!edited.ok) throw new Error(`updateRule failed: ${edited.error.message}`)
    expect(edited.value.label).toBe("Delete file edited")
    const second = await api.snapshot()
    if (!second.ok) throw new Error(`second snapshot failed: ${second.error.message}`)
    const custom = second.value.items.find((item) => item.id === "perm:patch:delete-file")
    if (custom === undefined) throw new Error("expected custom perm:patch:delete-file after edit")
    expect(custom.custom).toBe(true)
    expect(custom.title).toBe("Delete file edited")
    expect(custom.permAction).toBe("patch.delete")
    expect(custom.patterns).toEqual(["*"])
    // Turn the edited row off and apply through the real installer.
    const off: CustomizationRecord = {
      type: "customization",
      level: "project",
      agent: "alpha",
      item: "perm:patch:delete-file",
      section: null,
      state: "off",
      basedOn: custom.fingerprint,
      updated: UPDATED,
    }
    const agents = agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")])
    const applyCtx = context({ agent: agents.domain, session: { hook: () => Effect.succeed({ dispose: Effect.void }) } })
    const applied = await apply(
      applyCtx,
      makeInput({
        items: second.value.items,
        records: [off],
        scopes: scopesOf(second.value.agents.map((agent) => ({ id: agent.id, scope: agent.scope }))),
        agents: [{ id: "alpha", level: "project" }, { id: "beta", level: "project" }],
      }),
    )
    expect(applied.registrations.length).toBeGreaterThan(0)
    const alphaRules = agents.state.get("alpha")?.permissions ?? []
    expect(alphaRules.slice(-1)).toEqual([{ action: "patch.delete", resource: "*", effect: "deny" }])
    expect(agents.state.get("beta")?.permissions.some((rule) => String(rule.action).startsWith("patch."))).toBe(false)
    const { evaluate } = await import("../../core/src/permission.js")
    expect(evaluate("patch.delete", "src/a.ts", alphaRules).effect).toBe("deny")
    expect(evaluate("patch.add", "src/a.ts", alphaRules).effect).not.toBe("deny")
    expect(evaluate("patch.update", "src/a.ts", alphaRules).effect).not.toBe("deny")
    expect(evaluate("edit", "src/a.ts", alphaRules).effect).not.toBe("deny")
  } finally {
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  }
})
