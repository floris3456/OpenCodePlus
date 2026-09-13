import { afterEach, expect, test } from "bun:test"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import type { Mcp } from "@opencode/schema/mcp"
import { AbsolutePath } from "@opencode/schema/schema"
import { Permission } from "@opencode/schema/permission"
import { Project } from "@opencode/schema/project"
import { Skill } from "@opencode/schema/skill"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema, type Types } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agentBody, discover } from "../src/instructions/discover.js"
import { copyName } from "../src/instructions/apply.js"
import { effective, fingerprint } from "../src/instructions/model.js"
import { context } from "./harness.js"

const roots: string[] = []
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, prefix))
  roots.push(root)
  return root
}

function location(directory: string): Location.Info {
  return new Location.Info({
    directory: AbsolutePath.make(directory),
    project: {
      id: Project.ID.make("test"),
      directory: AbsolutePath.make(directory),
      canonical: AbsolutePath.make(directory),
    },
  })
}

function agent(id: string, system: string, permissions: Permission.Ruleset = []): Agent.Info {
  return {
    id: Agent.ID.make(id),
    name: Agent.Name.make(id),
    request: { settings: {}, headers: {}, body: {} },
    system,
    mode: "primary",
    hidden: false,
    permissions,
  }
}

function tool(id: string, description: string): Tool.Info & { readonly id: string } {
  return {
    id,
    name: id,
    description,
    input: Schema.Void,
    execute: () => Effect.die("unused tool.execute"),
  }
}

function toolWithOptions(
  id: string,
  description: string,
  options: Tool.Info["options"],
): Tool.Info & { readonly id: string } {
  const base = tool(id, description)
  if (options === undefined) return base
  return { ...base, options }
}

function toolEditor(tools: readonly (Tool.Info & { readonly id: string })[] = []): ToolEditor {
  return {
    list: () => tools,
    get: (id) => tools.find((tool) => tool.id === id),
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

function agentContext(directory: string, agents: Agent.Info[]): Context {
  return context({
    location: location(directory),
    agent: {
      list: () => Effect.succeed({ location: location(directory), data: agents }),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    skill: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
      transform: () => Effect.die("unused skill.transform"),
      reload: () => Effect.die("unused skill.reload"),
    },
    tool: {
      transform: (callback) =>
        Effect.sync(() => {
          callback(toolEditor())
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused tool.reload"),
      hook: () => Effect.die("unused tool.hook"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcpEditor())
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused mcp.reload"),
    },
  })
}

test("project, global, and builtin agents resolve by file location", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  await fs.mkdir(path.join(directory, ".opencode", "agent"), { recursive: true })
  await Bun.write(path.join(directory, ".opencode", "agent", "planner.md"), "# planner\n")
  await fs.mkdir(path.join(global, "agents"), { recursive: true })
  await Bun.write(path.join(global, "agents", "reviewer.md"), "# reviewer\n")
  const agents = [agent("planner", "plan"), agent("reviewer", "review"), agent("ghost", "ghost")]
  const discovered = await discover(agentContext(directory, agents), { revision: 3, customizations: [] })

  expect(discovered.snapshot.revision).toBe(3)
  expect(discovered.agents).toEqual([
    { id: "planner", scope: "project", path: path.join(directory, ".opencode", "agent", "planner.md") },
    { id: "reviewer", scope: "global", path: path.join(global, "agents", "reviewer.md") },
    { id: "ghost", scope: "builtin" },
  ])
  expect(discovered.snapshot.items.filter((item) => item.kind === "prompt")).toHaveLength(3)
})

function skill(id: string, content: string): Skill.Info {
  return Skill.Info.make({
    id: Skill.ID.make(id),
    name: Skill.Name.make(id),
    location: AbsolutePath.make(`/skills/${id}.md`),
    content,
  })
}

test("personalized skill copies are excluded from discovery", async () => {
  const directory = await tempDir("plus-discover-")
  const copy = copyName("alpha", "notes")
  const skills = [skill("notes", "skill body"), skill(copy, "custom body")]
  const ctx = context({
    location: location(directory),
    agent: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    skill: {
      list: () => Effect.succeed({ location: location(directory), data: skills }),
      transform: () => Effect.die("unused skill.transform"),
      reload: () => Effect.die("unused skill.reload"),
    },
    tool: {
      transform: (callback) =>
        Effect.sync(() => {
          callback(toolEditor())
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused tool.reload"),
      hook: () => Effect.die("unused tool.hook"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(mcpEditor())
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused mcp.reload"),
    },
  })

  const discovered = await discover(ctx, { revision: 0, customizations: [] })
  expect(discovered.snapshot.items.filter((item) => item.kind === "skill")).toEqual([
    expect.objectContaining({ id: "skill:notes", owner: "notes", text: "skill body", available: true }),
  ])
})

test("tool items are collected through tool.transform", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const tools = [tool("reader", "read things"), tool("writer", "write things")]
  let sawTransform = false
  const ctx = context({
    location: location(directory),
    agent: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    skill: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
      transform: () => Effect.die("unused skill.transform"),
      reload: () => Effect.die("unused skill.reload"),
    },
    tool: {
      // The tool domain exposes no list(); inventory must be read inside transform.
      transform: (callback) =>
        Effect.sync(() => {
          sawTransform = true
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
          callback(mcpEditor())
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused mcp.reload"),
    },
  })

  const discovered = await discover(ctx, { revision: 0, customizations: [] })
  expect(sawTransform).toBe(true)
  expect("list" in ctx.tool).toBe(false)
  expect(discovered.snapshot.items.filter((item) => item.kind === "tool")).toEqual([
    expect.objectContaining({ id: "tool:reader", owner: "reader", text: "read things", available: true }),
    expect.objectContaining({ id: "tool:writer", owner: "writer", text: "write things", available: true }),
  ])
})

test("discovery reports native status from the live tool inventory", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const tools = [
    toolWithOptions("reader", "read things", { codemode: false }),
    toolWithOptions("helper", "help things", { codemode: true }),
    tool("writer", "write things"),
  ]
  const ctx = context({
    location: location(directory),
    agent: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    skill: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
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
          callback(mcpEditor())
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused mcp.reload"),
    },
  })

  const discovered = await discover(ctx, { revision: 0, customizations: [] })
  // Same rule as apply.ts: only options.codemode === false is native. A tool
  // with no options is a Code Mode tool, exactly like one with codemode: true.
  expect(discovered.tools).toEqual([
    { id: "reader", native: true },
    { id: "helper", native: false },
    { id: "writer", native: false },
  ])
})

test("nested agent files resolve to nested ids with their scope and path", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const nestedPath = path.join(directory, ".opencode", "agent", "team", "lead.md")
  await fs.mkdir(path.dirname(nestedPath), { recursive: true })
  await Bun.write(nestedPath, "# lead\n")
  const agents = [agent("team/lead", "lead")]
  const discovered = await discover(agentContext(directory, agents), { revision: 0, customizations: [] })

  expect(discovered.agents).toEqual([{ id: "team/lead", scope: "project", path: nestedPath }])
})

test("prompt discovery rereads file-backed upstream while the host shows Plus output, and new host text otherwise", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "alpha upstream revised\n")
  const applied = agentContext(directory, [agent("alpha", "custom"), agent("beta", "beta upstream")])
  const baselines = new Map([
    ["alpha", { applied: "custom", upstream: "alpha upstream", fileBacked: true, file: "alpha upstream" }],
    ["beta", { applied: "stale override", upstream: "stale upstream", fileBacked: false }],
  ])
  const discovered = await discover(applied, { revision: 0, customizations: [] }, baselines)
  const texts = new Map(discovered.snapshot.items.map((item) => [item.id, item.text]))
  // Alpha still shows exactly what Plus wrote, but the backing file changed
  // underneath the override, so discovery reports the reread body rather than
  // the stale retained upstream.
  expect(texts.get("prompt:alpha")).toBe("alpha upstream revised")
  // Beta's host text matches neither the retained override nor stale
  // upstream — a genuine host edit — so it flows through untouched.
  expect(texts.get("prompt:beta")).toBe("beta upstream")
})

test("prompt discovery ignores the backing file when another config source owns the prompt", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "file body\n")
  const applied = agentContext(directory, [agent("alpha", "custom")])
  const baselines = new Map([
    ["alpha", { applied: "custom", upstream: "config upstream", fileBacked: true, file: "file body" }],
  ])
  const discovered = await discover(applied, { revision: 0, customizations: [] }, baselines)
  const texts = new Map(discovered.snapshot.items.map((item) => [item.id, item.text]))
  // The file body did not match the host upstream when the baseline was
  // retained, so the file is ignored and the retained upstream is reported.
  expect(texts.get("prompt:alpha")).toBe("config upstream")
})

test("prompt discovery retains the baseline for builtin agents while the host shows Plus output", async () => {
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global
  const applied = agentContext(directory, [agent("ghost", "custom")])
  const baselines = new Map([["ghost", { applied: "custom", upstream: "ghost upstream", fileBacked: false }]])
  const discovered = await discover(applied, { revision: 0, customizations: [] }, baselines)
  const texts = new Map(discovered.snapshot.items.map((item) => [item.id, item.text]))
  // Builtins have no backing file to reread, so the retained upstream is the
  // only available source: genuine host edits stay masked until the override
  // is removed.
  expect(texts.get("prompt:ghost")).toBe("ghost upstream")
})

test("agentBody matches core's trimmed markdown content for frontmatter and body-only files", () => {
  // Core decodes file-backed agents as { ...frontmatter, system: content.trim() }.
  expect(agentBody("---\nmode: subagent\n---\nBe helpful.\n")).toBe("Be helpful.")
  expect(agentBody("---\nmode: subagent\n---\n")).toBe("")
  expect(agentBody("Be helpful.\n")).toBe("Be helpful.")
  expect(agentBody("  spaced  ")).toBe("spaced")
  // `---` inside the body is content, not a second fence.
  expect(agentBody("---\ndescription: x\n---\nfirst\n---\nsecond\n")).toBe("first\n---\nsecond")
  // No opening fence means the whole file is the body.
  expect(agentBody("not frontmatter\n---\nstill body\n")).toBe("not frontmatter\n---\nstill body")
})

test("a server with upstream disabled: true and no customization is discovered with available === false, and its text/fingerprint exclude the disabled key", async () => {
  const directory = await tempDir("plus-discover-")
  const serverConfig: Mcp.ServerConfig = { type: "remote", url: "https://example.test", disabled: true }
  const servers: [string, Types.DeepMutable<Mcp.ServerConfig>][] = [["search", structuredClone(serverConfig)]]
  const ctx = context({
    location: location(directory),
    agent: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    skill: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
      transform: () => Effect.die("unused skill.transform"),
      reload: () => Effect.die("unused skill.reload"),
    },
    tool: {
      transform: (callback) =>
        Effect.sync(() => {
          callback(toolEditor())
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

  const discovered = await discover(ctx, { revision: 0, customizations: [] })
  const mcpItem = discovered.snapshot.items.find((item) => item.id === "mcp:search")
  expect(mcpItem).toBeDefined()
  expect(mcpItem?.available).toBe(false)
  const expectedSanitized = JSON.stringify({ type: "remote", url: "https://example.test" })
  expect(mcpItem?.text).toBe(expectedSanitized)
  expect(mcpItem?.fingerprint).toBe(fingerprint(expectedSanitized))
})

test("the same server WITH a shared disabled customization reports available === true and the identical stable text/fingerprint", async () => {
  const directory = await tempDir("plus-discover-")
  const serverConfig: Mcp.ServerConfig = { type: "remote", url: "https://example.test", disabled: true }
  const servers: [string, Types.DeepMutable<Mcp.ServerConfig>][] = [["search", structuredClone(serverConfig)]]
  const ctx = context({
    location: location(directory),
    agent: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    skill: {
      list: () => Effect.succeed({ location: location(directory), data: [] }),
      transform: () => Effect.die("unused skill.transform"),
      reload: () => Effect.die("unused skill.reload"),
    },
    tool: {
      transform: (callback) =>
        Effect.sync(() => {
          callback(toolEditor())
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

  const expectedSanitized = JSON.stringify({ type: "remote", url: "https://example.test" })
  const customizations = [
    {
      item: "mcp:search",
      agent: "*",
      state: "disabled" as const,
      basedOn: fingerprint(expectedSanitized),
      updated: "2026-01-01T00:00:00.000Z",
    },
  ]
  const discovered = await discover(ctx, { revision: 0, customizations })
  const mcpItem = discovered.snapshot.items.find((item) => item.id === "mcp:search")
  expect(mcpItem).toBeDefined()
  expect(mcpItem?.available).toBe(true)
  expect(mcpItem?.text).toBe(expectedSanitized)
  expect(mcpItem?.fingerprint).toBe(fingerprint(expectedSanitized))
})

test("discovery reports an upstream-denied skill as available (known limitation)", async () => {
  // Known limitation: Plus discovers skills and tools globally with available: true
  // regardless of agent upstream permissions. Core filters denied skills in
  // Skill.available (packages/core/src/skill.ts) and denied tools in Tool.snapshot
  // (packages/core/src/tool.ts) before session hooks run, so an agent that upstream
  // denies a skill or tool cannot use it even when discovery reports available: true.
  const directory = await tempDir("plus-discover-")
  const global = await tempDir("plus-discover-global-")
  process.env.OPENCODE_CONFIG_DIR = global

  const deniedPermissions: Permission.Ruleset = [
    { action: "skill", resource: "deploy", effect: "deny" },
    { action: "git", resource: "*", effect: "deny" },
  ]
  const agents = [agent("restricted", "restricted agent", deniedPermissions)]
  const skills = [skill("deploy", "deploy to production")]
  const tools = [toolWithOptions("git", "run git commands", { codemode: false })]

  const ctx = context({
    location: location(directory),
    agent: {
      list: () => Effect.succeed({ location: location(directory), data: agents }),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    skill: {
      list: () => Effect.succeed({ location: location(directory), data: skills }),
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
          callback(mcpEditor())
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused mcp.reload"),
    },
  })

  const discovered = await discover(ctx, { revision: 0, customizations: [] })
  const skillItem = discovered.snapshot.items.find((item) => item.id === "skill:deploy")
  const toolItem = discovered.snapshot.items.find((item) => item.id === "tool:git")

  // The skill and native tool are surfaced to plugin APIs by core, but Plus
  // assigns available: true unconditionally rather than inspecting agent permissions.
  expect(skillItem).toBeDefined()
  expect(skillItem?.available).toBe(true)
  expect(toolItem).toBeDefined()
  expect(toolItem?.available).toBe(true)

  // Downstream effect: effective() also reports enabled: true for the restricted agent
  expect(effective(discovered.snapshot, skillItem!, "restricted").enabled).toBe(true)
  expect(effective(discovered.snapshot, toolItem!, "restricted").enabled).toBe(true)
})
