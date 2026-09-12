import { afterEach, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Project } from "@opencode/schema/project"
import { Skill } from "@opencode/schema/skill"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { discover } from "../src/instructions/discover.js"
import { copyName } from "../src/instructions/apply.js"
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
          callback({ list: () => [], get: () => undefined } as never)
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused tool.reload"),
      hook: () => Effect.die("unused tool.hook"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback({ list: () => [] } as never)
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
          callback({ list: () => [], get: () => undefined } as never)
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused tool.reload"),
      hook: () => Effect.die("unused tool.hook"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback({ list: () => [] } as never)
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
  const tools = [
    { id: "reader", name: "reader", description: "read things" },
    { id: "writer", name: "writer", description: "write things" },
  ]
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
          callback({ list: () => tools, get: (id: string) => tools.find((tool) => tool.id === id) } as never)
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused tool.reload"),
      hook: () => Effect.die("unused tool.hook"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback({ list: () => [] } as never)
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
