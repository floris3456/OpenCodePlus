import { afterEach, expect, test } from "bun:test"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Location } from "@opencode/schema/location"
import type { Mcp } from "@opencode/schema/mcp"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Skill } from "@opencode/schema/skill"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema, type Types } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agentBody, discover, type BaseTemplate } from "../src/instructions/discover.js"
import { teachingFilePath, teachingItemId } from "../src/instructions/paths.js"
import { seedSystemInstruction, teachingContent } from "../src/instructions/teaching.js"
import { captureBaselines, createState } from "../src/index.js"
import { apply, type ApplyInput } from "../src/instructions/apply.js"
import { fingerprint, resolve, scopesOf, type CustomizationRecord, type Level } from "../src/instructions/model.js"
import { agentHarness, catalogHarness, context, modelInfo, modelRef, promptHarness, skillHarness, type PromptClassificationTable } from "./harness.js"

const roots: string[] = []
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
const previousTestHome = process.env.OPENCODE_TEST_HOME

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
  if (previousTestHome === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = previousTestHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, prefix))
  roots.push(root)
  return root
}

function location(directory: string, projectDirectory: string = directory): Location.Info {
  return new Location.Info({
    directory: AbsolutePath.make(directory),
    project: {
      id: "test" as never,
      directory: AbsolutePath.make(projectDirectory),
      canonical: AbsolutePath.make(projectDirectory),
    },
  })
}

function agent(id: string, system: string, model?: Model.Ref): Agent.Info {
  return {
    id: Agent.ID.make(id),
    name: Agent.Name.make(id),
    request: { settings: {}, headers: {}, body: {} },
    system,
    mode: "primary",
    hidden: false,
    permissions: [],
    ...(model === undefined ? {} : { model }),
  }
}

type ToolEntry = Tool.Info & { readonly id: string; readonly origin?: { type: "mcp" | "plugin"; name: string } }

function tool(id: string, description: string, origin?: ToolEntry["origin"]): ToolEntry {
  return {
    id,
    name: id,
    description,
    input: Schema.Void,
    execute: () => Effect.die("unused tool.execute"),
    ...(origin === undefined ? {} : { origin }),
  }
}

function toolEditor(tools: readonly ToolEntry[] = []): ToolEditor {
  return {
    list: () => tools,
    get: (id) => tools.find((entry) => entry.id === id),
    namespace: () => {},
    add: () => {},
    update: () => {},
    remove: () => {},
  }
}

function mcpEditor(servers: readonly [string, Types.DeepMutable<Mcp.ServerConfig>][] = []): MCPEditor {
  return {
    list: () => servers,
    get: (name) => servers.find(([serverName]) => serverName === name)?.[1],
    set: () => {},
    update: () => {},
    remove: () => {},
  }
}

type SkillEntry = Skill.Info & { readonly origin?: { type: "mcp" | "plugin"; name: string } }

function skill(id: string, content: string, locationPath: string): Skill.Info {
  return Skill.Info.make({
    id: Skill.ID.make(id),
    name: Skill.Name.make(id),
    location: AbsolutePath.make(locationPath),
    content,
  })
}

function fullContext(options: {
  directory: string
  projectDirectory?: string
  agents?: Agent.Info[]
  skills?: SkillEntry[]
  tools?: ToolEntry[]
  servers?: [string, Types.DeepMutable<Mcp.ServerConfig>][]
  templates?: { id: string; title: string; text: string }[]
  models?: Model.Info[]
  classifications?: PromptClassificationTable
}): Context {
  const loc = location(options.directory, options.projectDirectory ?? options.directory)
  const agents = options.agents ?? []
  const skills = options.skills ?? []
  const tools = options.tools ?? []
  const servers = options.servers ?? []
  return context({
    location: loc,
    agent: {
      list: () => Effect.succeed({ location: loc, data: agents }),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    catalog: catalogHarness(options.models ?? []),
    prompt: promptHarness(options.templates ?? [], options.classifications),
    skill: {
      list: () => Effect.succeed({ location: loc, data: skills }),
      transform: () => Effect.die("unused skill.transform"),
      reload: () => Effect.die("unused skill.reload"),
    },
    tool: {
      transform: (callback) =>
        Effect.sync(() => {
          callback(toolEditor(tools))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused tool.reload"),
      hook: () => Effect.die("unused tool.hook"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcpEditor(servers))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused mcp.reload"),
    },
  })
}

const noBase = () => undefined
const noTemplates: BaseTemplate[] = []
const UPDATED = "2026-01-01T00:00:00.000Z"

function agentInfo(id: string, system: string, model?: Model.Ref): Agent.Info {
  return { ...Agent.Info.default(Agent.ID.make(id)), system, ...(model === undefined ? {} : { model }) }
}

function skillInfo(id: string, content: string): Skill.Info {
  return Skill.Info.make({
    id: Skill.ID.make(id),
    name: Skill.Name.make(id),
    location: AbsolutePath.make(`/skills/${id}.md`),
    content,
  })
}

function makeInput(overrides: Partial<ApplyInput> & { items: ApplyInput["items"] }): ApplyInput {
  return {
    agents: [{ id: "alpha", level: "project" satisfies Level }],
    records: [],
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
    ...overrides,
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

function sessionEvent(
  agentID: string,
  tools: SessionHooks["context"]["tools"],
  system: SessionHooks["context"]["system"],
): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make("ses_test_event"),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({
      providerID: Provider.ID.make("test"),
      id: Model.ID.make("test"),
    }),
    system,
    messages: [],
    options: {},
    tools,
  }
}

function sharedRecord(item: string, state: "on" | "off"): CustomizationRecord {
  return {
    type: "customization",
    level: "defaults",
    agent: null,
    item,
    section: null,
    state,
    basedOn: fingerprint("shared upstream"),
    updated: UPDATED,
  }
}

function globalRecord(item: string, agent: string, text: string): CustomizationRecord {
  return {
    type: "customization",
    level: "global",
    agent,
    item,
    section: null,
    text,
    basedOn: fingerprint("shared upstream"),
    updated: UPDATED,
  }
}

test("project, global, and defaults agents resolve by file location with active base", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  await fs.mkdir(path.join(directory, ".opencode", "agent"), { recursive: true })
  await Bun.write(path.join(directory, ".opencode", "agent", "planner.md"), "# planner\n")
  await fs.mkdir(path.join(global, "agents"), { recursive: true })
  await Bun.write(path.join(global, "agents", "reviewer.md"), "# reviewer\n")
  const agents = [agent("planner", "plan"), agent("reviewer", "review"), agent("ghost", "ghost")]
  const templates: BaseTemplate[] = [{ id: "gpt", title: "GPT.txt", text: "gpt base" }]
  const discovered = await discover({
    ctx: fullContext({ directory, agents }),
    records: [],
    baseTemplates: templates,
    activeBase: (candidate) => (candidate.id === "planner" ? "gpt" : undefined),
  })

  expect(discovered.agents).toEqual([
    { id: "planner", scope: "project", path: path.join(directory, ".opencode", "agent", "planner.md"), base: "gpt" },
    { id: "reviewer", scope: "global", path: path.join(global, "agents", "reviewer.md") },
    { id: "ghost", scope: "defaults" },
  ])
})

test("tools group by origin without inferring the server from the namespace", async () => {
  const directory = await tempDir("plus-discover-")
  const server = "my.server:name"
  const tools = [
    tool("read", "read things"),
    tool("plus-helper", "plus helper", { type: "plugin", name: "opencode.plus" }),
    tool("other-plugin-tool", "other", { type: "plugin", name: "some.other" }),
    tool("mcp-tool", "mcp tool", { type: "mcp", name: server }),
  ]
  const discovered = await discover({
    ctx: fullContext({ directory, tools }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const byId = new Map(discovered.items.map((item) => [item.id, item]))
  expect(byId.get("tool:read")).toMatchObject({ kind: "tool", group: "native", title: "read", text: "read things", enabled: true })
  expect(byId.get("tool:read")?.server).toBeUndefined()
  expect(byId.get("tool:plus-helper")).toMatchObject({ kind: "tool", group: "plus" })
  // A non-Plus plugin origin is not Plus inventory.
  expect(byId.get("tool:other-plugin-tool")).toMatchObject({ kind: "tool", group: "native" })
  // The exact server name survives even though the namespace sanitizer would
  // rewrite "." and ":" to "_".
  expect(byId.get("tool:mcp-tool")).toMatchObject({ kind: "tool", group: "mcp", server })
})

test("base template items carry title and text with group none", async () => {
  const directory = await tempDir("plus-discover-")
  const templates: BaseTemplate[] = [
    { id: "gpt", title: "GPT.txt", text: "gpt base text" },
    { id: "general", title: "general.txt", text: "general base text" },
  ]
  const discovered = await discover({
    ctx: fullContext({ directory }),
    records: [],
    baseTemplates: templates,
    activeBase: noBase,
  })
  const bases = discovered.items.filter((item) => item.kind === "base")
  expect(bases).toEqual([
    expect.objectContaining({ id: "base:gpt", kind: "base", group: "none", title: "GPT.txt", text: "gpt base text", enabled: true }),
    expect.objectContaining({ id: "base:general", kind: "base", group: "none", title: "general.txt", text: "general base text", enabled: true }),
  ])
  expect(bases[0].fingerprint).toBe(fingerprint("gpt base text"))
  // Builtin ids are the host's own answers, so they carry no user flag.
  expect(bases.every((item) => item.userBase === undefined)).toBe(true)
})

test("discovery marks user base templates and Code Mode tools from the real registry", async () => {
  const directory = await tempDir("plus-discover-")
  const coder = tool("coder", "code mode tool")
  delete (coder as { options?: unknown }).options
  const discovered = await discover({
    ctx: fullContext({
      directory,
      tools: [
        // Real harness registry entries: options omitted means Code Mode
        // (core defaults codemode true), explicit false means native.
        coder,
        nativeTool("reader", "native tool"),
      ],
    }),
    records: [],
    baseTemplates: [{ id: "custom", title: "Custom.txt", text: "custom base text", user: true }],
    activeBase: noBase,
  })
  const byId = new Map(discovered.items.map((item) => [item.id, item]))
  expect(byId.get("base:custom")).toMatchObject({ kind: "base", userBase: true })
  expect(byId.get("tool:coder")?.codemode).toBe(true)
  expect(byId.get("tool:reader")?.codemode).toBeUndefined()
})

test("project skills group as project and Plus copies stay excluded", async () => {
  const directory = await tempDir("plus-discover-")
  const projectSkillPath = path.join(directory, ".opencode", "skills", "notes", "SKILL.md")
  const nativeSkillPath = path.join(directory, "elsewhere", "SKILL.md")
  await fs.mkdir(path.dirname(projectSkillPath), { recursive: true })
  const copy = "plus/alpha/notes"
  const skills: SkillEntry[] = [
    skill("notes", "skill body", projectSkillPath),
    skill("other", "other body", nativeSkillPath),
    skill(copy, "custom body", nativeSkillPath),
  ]
  const discovered = await discover({
    ctx: fullContext({ directory, skills }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const found = discovered.items.filter((item) => item.kind === "skill")
  expect(found).toEqual([
    expect.objectContaining({ id: "skill:notes", group: "project", text: "skill body", enabled: true }),
    expect.objectContaining({ id: "skill:other", group: "native", text: "other body", enabled: true }),
  ])
})

test("system:role is one per agent with scoped agents and order 0", async () => {
  const directory = await tempDir("plus-discover-")
  const agents = [agent("alpha", "alpha prompt"), agent("beta", "beta prompt")]
  const discovered = await discover({
    ctx: fullContext({ directory, agents }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const roles = discovered.items.filter((item) => item.id === "system:role")
  expect(roles).toHaveLength(2)
  expect(roles[0]).toMatchObject({ kind: "system", group: "none", title: "Role/persona", text: "alpha prompt", agents: ["alpha"], order: 0 })
  expect(roles[1]).toMatchObject({ text: "beta prompt", agents: ["beta"], order: 0 })
})

test("instruction files follow core order: global first, then nearest-to-farthest", async () => {
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const project = await tempDir("plus-discover-")
  const nested = path.join(project, "nested")
  await fs.mkdir(nested, { recursive: true })
  await Bun.write(path.join(global, "AGENTS.md"), "global instructions\n")
  await Bun.write(path.join(project, "AGENTS.md"), "project instructions\n")
  await Bun.write(path.join(nested, "AGENTS.md"), "nested instructions\n")
  const discovered = await discover({
    ctx: fullContext({ directory: nested, projectDirectory: project }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const files = discovered.items.filter((item) => item.kind === "system" && item.id !== "system:role")
  expect(files.map((item) => item.id)).toEqual([
    `system:${path.relative(nested, path.join(global, "AGENTS.md")) || path.join(global, "AGENTS.md")}`,
    "system:AGENTS.md",
    `system:${path.relative(nested, path.join(project, "AGENTS.md"))}`,
  ])
  expect(files.map((item) => item.order)).toEqual([0, 1, 2])
  expect(files[0].text).toBe("global instructions\n")
})

test("descendant instruction files are not inventory", async () => {
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const project = await tempDir("plus-discover-")
  await Bun.write(path.join(project, "AGENTS.md"), "project instructions\n")
  await fs.mkdir(path.join(project, "child"), { recursive: true })
  await Bun.write(path.join(project, "child", "AGENTS.md"), "descendant instructions\n")
  const discovered = await discover({
    ctx: fullContext({ directory: project, projectDirectory: project }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const files = discovered.items.filter((item) => item.kind === "system" && item.id !== "system:role")
  expect(files.map((item) => item.id)).toEqual(["system:AGENTS.md"])
})

test("mcp server items serialize config without disabled and reconstruct upstream enablement", async () => {
  const directory = await tempDir("plus-discover-")
  const servers: [string, Types.DeepMutable<Mcp.ServerConfig>][] = [
    ["search", { type: "remote", url: "https://example.test", disabled: true }],
  ]
  const expectedSanitized = JSON.stringify({ type: "remote", url: "https://example.test" })
  const withoutRecords = await discover({
    ctx: fullContext({ directory, servers: servers.map(([name, config]) => [name, structuredClone(config)] as [string, Types.DeepMutable<Mcp.ServerConfig>]) }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const plain = withoutRecords.items.find((item) => item.id === "mcp:search")
  expect(plain).toMatchObject({ kind: "mcp", group: "none", text: expectedSanitized, enabled: false })
  expect(plain?.fingerprint).toBe(fingerprint(expectedSanitized))
  expect(withoutRecords.servers).toEqual([{ name: "search", enabled: false }])

  const withDisable = await discover({
    ctx: fullContext({ directory, servers: servers.map(([name, config]) => [name, structuredClone(config)] as [string, Types.DeepMutable<Mcp.ServerConfig>]) }),
    records: [sharedRecord("mcp:search", "off")],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const reconstructed = withDisable.items.find((item) => item.id === "mcp:search")
  expect(reconstructed?.enabled).toBe(true)
  expect(reconstructed?.text).toBe(expectedSanitized)
  expect(withDisable.servers).toEqual([{ name: "search", enabled: true }])
})

test("production baselines reread a directly edited file-backed body (fails while file is unset)", async () => {
  // End-to-end through the real baseline constructor: Plus applies "custom"
  // over the "alpha upstream" file body, then the markdown is edited directly
  // to "alpha upstream revised" while the host still shows Plus's output.
  // With file populated at baseline time, discovery must trust the reread.
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "alpha upstream\n")
  const state = createState()
  const applyCtx = fullContext({ directory, agents: [agent("alpha", "alpha upstream")] })
  const pre = await discover({ ctx: applyCtx, records: [], baselines: state.baselines, baseTemplates: noTemplates, activeBase: noBase })
  const custom: CustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "system:role",
    section: null,
    text: "custom",
    basedOn: fingerprint("alpha upstream"),
    updated: UPDATED,
  }
  captureBaselines(applyCtx, state, pre, [custom], [])
  await Bun.write(alphaPath, "alpha upstream revised\n")
  const maskedCtx = fullContext({ directory, agents: [agent("alpha", "custom")] })
  const discovered = await discover({
    ctx: maskedCtx,
    records: [],
    baselines: state.baselines,
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const role = discovered.items.find((item) => item.id === "system:role")
  expect(role?.text).toBe("alpha upstream revised")
})

test("production baselines ignore the backing file when another config source owns the prompt", async () => {
  // Same production path with the guard's negative case: the host prompt was
  // replaced by another config source ("config upstream" while the markdown
  // held "file body"), so at baseline time file !== upstream and the owner is
  // the config source. A later edit to the markdown must still be ignored,
  // otherwise the publish fingerprint flips on every pass.
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "file body\n")
  const state = createState()
  const applyCtx = fullContext({ directory, agents: [agent("alpha", "config upstream")] })
  const pre = await discover({ ctx: applyCtx, records: [], baselines: state.baselines, baseTemplates: noTemplates, activeBase: noBase })
  const custom: CustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "system:role",
    section: null,
    text: "custom",
    basedOn: fingerprint("config upstream"),
    updated: UPDATED,
  }
  captureBaselines(applyCtx, state, pre, [custom], [])
  await Bun.write(alphaPath, "file body edited\n")
  const maskedCtx = fullContext({ directory, agents: [agent("alpha", "custom")] })
  const discovered = await discover({
    ctx: maskedCtx,
    records: [],
    baselines: state.baselines,
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const role = discovered.items.find((item) => item.id === "system:role")
  expect(role?.text).toBe("config upstream")
})

test("prompt discovery rereads a trusted file body while the host shows Plus output", async () => {
  // Unit coverage for upstreamPrompt's trusted branch with a hand-built
  // baseline (production construction is covered by the production tests
  // above): file matched upstream at baseline time, so the reread wins.
  // The beta entry documents the unmasked-host early return, not baselines:
  // "beta upstream" differs from applied, so it flows through untouched.
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "alpha upstream revised\n")
  const ctx = fullContext({ directory, agents: [agent("alpha", "custom"), agent("beta", "beta upstream")] })
  const baselines = new Map([
    ["alpha", { applied: "custom", upstream: "alpha upstream", fileBacked: true, file: "alpha upstream" }],
    ["beta", { applied: "stale override", upstream: "stale upstream", fileBacked: false }],
  ])
  const discovered = await discover({ ctx, records: [], baselines, baseTemplates: noTemplates, activeBase: noBase })
  const texts = new Map(discovered.items.map((item) => [JSON.stringify([item.id, item.agents]), item.text]))
  expect(texts.get(JSON.stringify(["system:role", ["alpha"]]))).toBe("alpha upstream revised")
  expect(texts.get(JSON.stringify(["system:role", ["beta"]]))).toBe("beta upstream")
})

test("prompt discovery ignores the backing file when baseline file differs from upstream", async () => {
  // Unit coverage for upstreamPrompt's ownership guard with a hand-built
  // baseline (production construction is covered above): file !== upstream at
  // baseline time means another config source owns the prompt, so the reread
  // is rejected against the retained upstream.
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "file body\n")
  const ctx = fullContext({ directory, agents: [agent("alpha", "custom")] })
  const baselines = new Map([
    ["alpha", { applied: "custom", upstream: "config upstream", fileBacked: true, file: "file body" }],
  ])
  const discovered = await discover({ ctx, records: [], baselines, baseTemplates: noTemplates, activeBase: noBase })
  const role = discovered.items.find((item) => item.id === "system:role")
  expect(role?.text).toBe("config upstream")
})

test("a Plus-applied tool description is never reported as upstream", async () => {
  const directory = await tempDir("plus-discover-")
  const tools = [tool("reader", "custom description")]
  const ctx = fullContext({ directory, tools })
  const baselines = new Map([["tool:reader", { applied: "custom description", upstream: "upstream description", fileBacked: false }]])
  const discovered = await discover({ ctx, records: [], baselines, baseTemplates: noTemplates, activeBase: noBase })
  const item = discovered.items.find((entry) => entry.id === "tool:reader")
  expect(item?.text).toBe("upstream description")
  expect(item?.fingerprint).toBe(fingerprint("upstream description"))
})

test("a Plus-applied skill description is never reported as upstream", async () => {
  const directory = await tempDir("plus-discover-")
  const locationPath = path.join(directory, "skills", "notes", "SKILL.md")
  const skills: SkillEntry[] = [skill("notes", "custom body", locationPath)]
  const ctx = fullContext({ directory, skills })
  const baselines = new Map([["skill:notes", { applied: "custom body", upstream: "upstream body", fileBacked: false }]])
  const discovered = await discover({ ctx, records: [], baselines, baseTemplates: noTemplates, activeBase: noBase })
  const item = discovered.items.find((entry) => entry.id === "skill:notes")
  expect(item?.text).toBe("upstream body")
  expect(item?.fingerprint).toBe(fingerprint("upstream body"))
})

test("a shared off record through discover -> apply installs a real skill denial", async () => {
  const directory = await tempDir("plus-discover-")
  const records = [sharedRecord("skill:notes", "off")]
  const locationPath = path.join(directory, "skills", "notes", "SKILL.md")
  const discovered = await discover({
    ctx: fullContext({ directory, skills: [skill("notes", "skill body", locationPath)] }),
    records,
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const item = discovered.items.find((entry) => entry.id === "skill:notes")
  if (item === undefined) throw new Error("expected skill:notes")
  expect(item.enabled).toBe(true)
  const skills = skillHarness([skillInfo("notes", "skill body")])
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const ctx = context({ agent: agents.domain, skill: skills.domain })
  const applied = await apply(
    ctx,
    makeInput({
      items: [item],
      records,
      scopes: scopesOf(discovered.agents),
      agents: [{ id: "alpha", level: "project" }],
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(skills.added).toEqual([])
  expect(agents.state.get("alpha")?.permissions.slice(-1)).toEqual([
    { action: "skill", resource: "notes", effect: "deny" },
  ])
})

test("a shared off record through discover -> apply removes a native tool", async () => {
  const directory = await tempDir("plus-discover-")
  const records = [sharedRecord("tool:reader", "off")]
  const toolEntry = nativeTool("reader", "read things")
  const toolDomain = toolDomainFor([toolEntry])
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    location: location(directory),
    tool: toolDomain,
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discover({
    ctx,
    records,
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const item = discovered.items.find((entry) => entry.id === "tool:reader")
  if (item === undefined) throw new Error("expected tool:reader")
  expect(item.enabled).toBe(true)
  expect(item.codemode).toBeUndefined()
  const applied = await apply(
    ctx,
    makeInput({
      items: [item],
      records,
      scopes: scopesOf(discovered.agents),
      agents: [{ id: "alpha", level: "project" }],
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  expect(callbacks).toHaveLength(1)
  const run = callbacks[0]
  if (run === undefined) throw new Error("missing context hook")
  const event = sessionEvent("alpha", { reader: { description: "read things", input: { type: "object" } } }, [
    { type: "text", text: "base" },
  ])
  await Effect.runPromise(run(event))
  expect(event.tools.reader).toBeUndefined()
})

test("a project agent shadowing a global file keeps both scopes", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  await fs.mkdir(path.join(directory, ".opencode", "agent"), { recursive: true })
  await Bun.write(path.join(directory, ".opencode", "agent", "alpha.md"), "# project alpha\n")
  await fs.mkdir(path.join(global, "agents"), { recursive: true })
  await Bun.write(path.join(global, "agents", "alpha.md"), "# global alpha\n")
  const records: CustomizationRecord[] = [globalRecord("system:role", "alpha", "global custom")]
  const discovered = await discover({
    ctx: fullContext({ directory, agents: [agent("alpha", "project prompt")] }),
    records,
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  expect(discovered.agents).toEqual([
    { id: "alpha", scope: "project", path: path.join(directory, ".opencode", "agent", "alpha.md") },
    { id: "alpha", scope: "global", path: path.join(global, "agents", "alpha.md") },
  ])
  const scopes = scopesOf(discovered.agents)
  expect(scopes.global.has("alpha")).toBe(true)
  const projectRole = discovered.items.find((entry) => entry.id === "system:role")
  if (projectRole === undefined) throw new Error("expected system:role")
  const resolved = resolve({
    upstream: projectRole,
    records,
    splits: [],
    scopes,
    address: { level: "project", agent: "alpha", item: "system:role", section: null },
  })
  expect(resolved.text).toBe("global custom")
})

test("a project agent shadowing a builtin keeps the defaults identity", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  await fs.mkdir(path.join(directory, ".opencode", "agent"), { recursive: true })
  await Bun.write(path.join(directory, ".opencode", "agent", "build.md"), "# build\n")
  const discovered = await discover({
    ctx: fullContext({ directory, agents: [agent("build", "build prompt")] }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  expect(discovered.agents).toEqual([
    { id: "build", scope: "project", path: path.join(directory, ".opencode", "agent", "build.md") },
    { id: "build", scope: "defaults" },
  ])
  const scopes = scopesOf(discovered.agents)
  expect(scopes.defaults.has("build")).toBe(true)
})

test("a zero-template host still yields a coherent fallback list", async () => {
  const directory = await tempDir("plus-discover-")
  const discovered = await discover({
    ctx: fullContext({ directory, agents: [agent("alpha", "alpha prompt")], templates: [], models: [] }),
    records: [],
    baseTemplates: [],
    activeBase: noBase,
  })
  expect(discovered.items.filter((item) => item.kind === "base")).toEqual([])
  expect(discovered.agents.map((entry) => entry.id)).toContain("alpha")
})

test("discover -> apply honors active base classification", async () => {
  const directory = await tempDir("plus-discover-")
  const locationPath = path.join(directory, "skills", "notes", "SKILL.md")
  const model = modelRef("acme", "trinity-ultra")
  const templates = [
    { id: "trinity", title: "Trinity.txt", text: "trinity base" },
    { id: "general", title: "General.txt", text: "general base" },
  ]
  const models = [modelInfo("acme", "trinity-ultra")]
  const discoverCtx = fullContext({
    directory,
    agents: [{ ...agent("alpha", ""), model }],
    skills: [skill("notes", "skill body", locationPath)],
    // Same native registry on both sides: reader carries explicit
    // codemode false here and in the apply-domain below, so discovery and
    // apply classify it identically (a default Code Mode entry on one side
    // only would prove nothing about the other side's view).
    tools: [nativeTool("reader", "read things")],
    templates,
    models,
    classifications: { "trinity-ultra": "trinity" },
  })
  const discovered = await discover({
    ctx: discoverCtx,
    records: [],
    baseTemplates: templates,
    activeBase: (candidate) => (candidate.id === "alpha" ? "trinity" : undefined),
  })
  const alpha = discovered.agents.find((entry) => entry.id === "alpha")
  if (alpha === undefined) throw new Error("expected alpha agent")
  expect(alpha.base).toBe("trinity")
  const trinity = discovered.items.find((entry) => entry.id === "base:trinity")
  if (trinity === undefined) throw new Error("expected base:trinity")
  const general = discovered.items.find((entry) => entry.id === "base:general")
  if (general === undefined) throw new Error("expected base:general")
  const records: CustomizationRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "alpha",
      item: "base:trinity",
      section: null,
      text: "custom trinity",
      basedOn: fingerprint("trinity base"),
      updated: UPDATED,
    },
    {
      type: "customization",
      level: "project",
      agent: "alpha",
      item: "base:general",
      section: null,
      text: "custom general",
      basedOn: fingerprint("general base"),
      updated: UPDATED,
    },
  ]
  const skills = skillHarness([skillInfo("notes", "skill body")])
  const agents = agentHarness([{ ...agentInfo("alpha", ""), model }])
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    location: discoverCtx.location,
    agent: agents.domain,
    catalog: catalogHarness(models),
    prompt: promptHarness(templates, { "trinity-ultra": "trinity" }),
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
    makeInput({
      items: discovered.items,
      records,
      scopes: scopesOf(discovered.agents),
      agents: [{ id: "alpha", level: "project", base: alpha.base }],
    }),
  )
  expect(applied.registrations).toHaveLength(1)
  const run = callbacks[0]
  if (run === undefined) throw new Error("missing context hook")
  const event = sessionEvent("alpha", {}, [{ type: "text", text: "family default" }])
  await Effect.runPromise(run(event))
  expect(event.system[0]?.text).toBe("custom trinity")
})

test("agentBody matches core's trimmed markdown content for frontmatter and body-only files", () => {
  expect(agentBody("---\nmode: subagent\n---\nBe helpful.\n")).toBe("Be helpful.")
  expect(agentBody("---\nmode: subagent\n---\n")).toBe("")
  expect(agentBody("Be helpful.\n")).toBe("Be helpful.")
  expect(agentBody("  spaced  ")).toBe("spaced")
  expect(agentBody("---\ndescription: x\n---\nfirst\n---\nsecond\n")).toBe("first\n---\nsecond")
  expect(agentBody("not frontmatter\n---\nstill body\n")).toBe("not frontmatter\n---\nstill body")
})

test("the seeded teaching file appears as an editable plus row", async () => {
  const config = await tempDir("plus-teaching-config-")
  process.env.OPENCODE_CONFIG_DIR = config
  const directory = await tempDir("plus-teaching-")
  const seeded = await seedSystemInstruction()
  expect(seeded.path).toBe(teachingFilePath())
  const discovered = await discover({
    ctx: fullContext({ directory }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const row = discovered.items.find((item) => item.id === teachingItemId)
  expect(row).toMatchObject({
    kind: "system",
    group: "plus",
    title: "OpenCodePlus",
    text: teachingContent,
    enabled: true,
  })
  expect(row?.fingerprint).toBe(fingerprint(teachingContent))
})

test("no teaching row appears without the seeded file", async () => {
  const config = await tempDir("plus-teaching-config-")
  process.env.OPENCODE_CONFIG_DIR = config
  const directory = await tempDir("plus-teaching-")
  const discovered = await discover({
    ctx: fullContext({ directory }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  expect(discovered.items.some((item) => item.id === teachingItemId)).toBe(false)
})

test("tool rows carry namespace and pinned from tool options only when defined", async () => {
  const directory = await tempDir("plus-discover-")
  const namespaced: ToolEntry = {
    ...tool("alpha", "alpha tool"),
    options: { namespace: "ns", pinned: true },
  }
  const plain = tool("beta", "beta tool")
  const discovered = await discover({
    ctx: fullContext({ directory, tools: [namespaced, plain] }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const byId = new Map(discovered.items.map((item) => [item.id, item]))
  expect(byId.get("tool:alpha")).toMatchObject({ namespace: "ns", pinned: true })
  expect("namespace" in (byId.get("tool:beta") ?? {})).toBe(false)
  expect("pinned" in (byId.get("tool:beta") ?? {})).toBe(false)
})

test("discovery emits exactly one synthetic execute row with the exact shape", async () => {
  const directory = await tempDir("plus-discover-")
  const text = "Host-owned Code Mode entry point: runs JavaScript that calls the tools in the Code Mode catalog."
  for (const tools of [[tool("a", "a tool")], []] as ToolEntry[][]) {
    const discovered = await discover({
      ctx: fullContext({ directory, tools }),
      records: [],
      baseTemplates: noTemplates,
      activeBase: noBase,
    })
    const executeRows = discovered.items.filter((item) => item.id === "tool:execute")
    expect(executeRows).toHaveLength(1)
    expect(executeRows[0]).toEqual({
      id: "tool:execute",
      kind: "tool",
      group: "native",
      title: "execute",
      text,
      enabled: true,
      fingerprint: fingerprint(text),
      codemode: false,
      execute: true,
    })
  }
})

test("discovery emits model candidates with agent scoping plus file-backed upstream", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "---\nmodel: acme/nova-1\n---\nAlpha prompt\n")
  const agents = [agent("alpha", "Alpha prompt", modelRef("acme", "nova-9"))]
  const modelRecords = [
    { type: "model" as const, level: "project" as const, agent: "alpha", providerID: "acme", modelID: "nova-2", updated: UPDATED },
    { type: "model" as const, level: "defaults" as const, agent: null, providerID: "acme", modelID: "nova-3", updated: UPDATED },
  ]
  const discovered = await discover({
    ctx: fullContext({ directory, agents }),
    records: [],
    baseTemplates: noTemplates,
    activeBase: noBase,
    modelRecords,
  })
  const byId = new Map(discovered.items.filter((item) => item.kind === "model").map((item) => [item.id, item]))
  expect(byId.get("model:acme/nova-2")).toMatchObject({ kind: "model", group: "none", agents: ["alpha"] })
  expect(byId.get("model:acme/nova-3")?.agents).toBeUndefined()
  expect(byId.get("model:acme/nova-1")).toMatchObject({ kind: "model", agents: ["alpha"] })
  expect(discovered.agents.find((entry) => entry.id === "alpha")?.model).toEqual({ providerID: "acme", modelID: "nova-1" })
  expect(discovered.modelUpstream.get("alpha")).toEqual({ providerID: "acme", modelID: "nova-1" })
})
