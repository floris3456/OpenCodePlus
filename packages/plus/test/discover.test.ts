import { afterEach, expect, test } from "bun:test"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import type { Mcp } from "@opencode/schema/mcp"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema, type Types } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agentBody, discover, type BaseTemplate } from "../src/instructions/discover.js"
import { fingerprint, type CustomizationRecord } from "../src/instructions/model.js"
import { context } from "./harness.js"

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

function agent(id: string, system: string): Agent.Info {
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

function record(item: string, state: "on" | "off", agent: string | null = null): CustomizationRecord {
  return {
    type: "customization",
    level: agent === null ? "defaults" : "project",
    agent,
    item,
    section: null,
    state,
    basedOn: fingerprint("upstream"),
    updated: "2026-01-01T00:00:00.000Z",
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
    records: [record("mcp:search", "off")],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  const reconstructed = withDisable.items.find((item) => item.id === "mcp:search")
  expect(reconstructed?.enabled).toBe(true)
  expect(reconstructed?.text).toBe(expectedSanitized)
  expect(withDisable.servers).toEqual([{ name: "search", enabled: true }])
})

test("prompt discovery rereads file-backed upstream while the host shows Plus output", async () => {
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

test("prompt discovery ignores the backing file when another config source owns the prompt", async () => {
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

test("a Plus state record disables the reported tool enablement", async () => {
  const directory = await tempDir("plus-discover-")
  const tools = [tool("reader", "read things")]
  const discovered = await discover({
    ctx: fullContext({ directory, tools }),
    records: [record("tool:reader", "off")],
    baseTemplates: noTemplates,
    activeBase: noBase,
  })
  expect(discovered.items.find((entry) => entry.id === "tool:reader")?.enabled).toBe(false)
})

test("agentBody matches core's trimmed markdown content for frontmatter and body-only files", () => {
  expect(agentBody("---\nmode: subagent\n---\nBe helpful.\n")).toBe("Be helpful.")
  expect(agentBody("---\nmode: subagent\n---\n")).toBe("")
  expect(agentBody("Be helpful.\n")).toBe("Be helpful.")
  expect(agentBody("  spaced  ")).toBe("spaced")
  expect(agentBody("---\ndescription: x\n---\nfirst\n---\nsecond\n")).toBe("first\n---\nsecond")
  expect(agentBody("not frontmatter\n---\nstill body\n")).toBe("not frontmatter\n---\nstill body")
})
