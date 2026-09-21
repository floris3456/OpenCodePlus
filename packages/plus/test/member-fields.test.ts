import { afterEach, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseTeamFields } from "../src/instructions/teams-apply.js"
import { createHandlers, createState } from "../src/index.js"
import { globalTeamsPath, projectTeamsPath, teamsDataDir } from "../src/instructions/paths.js"
import { discoverBuiltinTeams, globalDefaultsTeamsPath } from "../src/instructions/teams.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentInfo, fullContext, modelRef } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorXdgDataHome = process.env.XDG_DATA_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorXdgDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const testClassifications = {
  "": "general",
  "gpt-4o": "general",
  "claude-3-opus": "general",
  "claude-3-haiku": "general",
  "claude-3-5-sonnet": "general",
  "gemini-1.5-pro": "general",
  "o1": "general",
}

async function tempRoot(): Promise<{ project: string; config: string; teamsRoot: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-member-fields-"))
  roots.push(root)
  const config = path.join(root, "config")
  const share = path.join(root, "share")
  process.env.OPENCODE_CONFIG_DIR = config
  process.env.XDG_DATA_HOME = share
  return { project: path.join(root, "project"), config, teamsRoot: teamsDataDir() }
}

interface CapturedError {
  type: string
  message: string
  data?: unknown
}

function throwingContext(captured: { current?: CapturedError } = {}): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure: CapturedError = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

test("schema: TeamAddAgentInput validates with and without fields and checks field types", () => {
  const withoutFields = {
    level: "project",
    team: "crew",
    id: "alice",
    prompt: "Alice role prompt",
  }
  const decodedWithout = Schema.decodeUnknownSync(Plus.TeamAddAgentInput)(withoutFields)
  expect(decodedWithout.level).toBe("project")
  expect(decodedWithout.team).toBe("crew")
  expect(decodedWithout.id).toBe("alice")
  expect(decodedWithout.prompt).toBe("Alice role prompt")
  expect(decodedWithout.fields).toBeUndefined()

  const withFullFields = {
    level: "global",
    team: "ops",
    id: "bob",
    template: "build",
    prompt: "Bob role prompt",
    fields: {
      model: "anthropic/claude-3-5-sonnet",
      variant: "high",
      request: { temperature: 0.2, headers: { "X-Custom": "val" } },
      description: "DevOps engineer",
      mode: "subagent" as const,
      hidden: true,
      color: "#ff0011",
      steps: 25,
      disabled: false,
      permissions: [{ action: "file:read", resource: "src/*", effect: "allow" as const }],
    },
  }
  const decodedWith = Schema.decodeUnknownSync(Plus.TeamAddAgentInput)(withFullFields)
  expect(decodedWith.fields?.model).toBe("anthropic/claude-3-5-sonnet")
  expect(decodedWith.fields?.variant).toBe("high")
  expect(decodedWith.fields?.description).toBe("DevOps engineer")
  expect(decodedWith.fields?.mode).toBe("subagent")
  expect(decodedWith.fields?.hidden).toBe(true)
  expect(decodedWith.fields?.color).toBe("#ff0011")
  expect(decodedWith.fields?.steps).toBe(25)
  expect(decodedWith.fields?.disabled).toBe(false)
  expect(decodedWith.fields?.permissions).toHaveLength(1)

  expect(() =>
    Schema.decodeUnknownSync(Plus.TeamAddAgentInput)({
      ...withoutFields,
      fields: { mode: "invalid_mode" },
    }),
  ).toThrow()

  expect(() =>
    Schema.decodeUnknownSync(Plus.TeamAddAgentInput)({
      ...withoutFields,
      fields: { steps: "not_a_number" },
    }),
  ).toThrow()
})

test("persistence + host-install at project tier writes member file with fields and registers on host", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project, classifications: testClassifications })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "devs" }, throwingContext()))
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "devs", enabled: true }, throwingContext()),
  )

  const added = await Effect.runPromise(
    handlers["team.addAgent"](
      {
        level: "project",
        team: "devs",
        id: "coder",
        prompt: "You write clean code.",
        fields: {
          model: "openai/gpt-4o",
          description: "Full-stack developer",
          mode: "subagent",
          steps: 20,
          color: "#112233",
        },
      },
      throwingContext(),
    ),
  )

  const teamDir = path.join(projectTeamsPath(project), "devs")
  const filePath = path.join(teamDir, "coder.md")
  expect(added).toEqual({ id: "coder", path: filePath })

  const diskContent = await Bun.file(filePath).text()
  expect(diskContent).toContain("You write clean code.")
  const parsed = parseTeamFields(diskContent)
  expect(parsed.model).toBe("openai/gpt-4o")
  expect(parsed.description).toBe("Full-stack developer")
  expect(parsed.mode).toBe("subagent")
  expect(parsed.steps).toBe(20)
  expect(parsed.color).toBe("#112233")

  const listed = await Effect.runPromise(ctx.agent.list())
  const coder = listed.data.find((entry) => String(entry.id) === "coder")
  expect(coder).toBeDefined()
  expect(coder?.system).toBe("You write clean code.")
  expect(coder?.model).toMatchObject({ providerID: "openai", id: "gpt-4o" })
  expect(coder?.description).toBe("Full-stack developer")
  expect(coder?.mode).toBe("subagent")
  expect(coder?.steps).toBe(20)
  expect(coder?.color).toBe("#112233")
})

test("persistence + host-install at global tier writes member file with fields and registers on host", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project, classifications: testClassifications })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "globalcrew" }, throwingContext()))
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "global", team: "globalcrew", enabled: true }, throwingContext()),
  )

  const added = await Effect.runPromise(
    handlers["team.addAgent"](
      {
        level: "global",
        team: "globalcrew",
        id: "operator",
        prompt: "Operate systems worldwide.",
        fields: {
          model: "anthropic/claude-3-opus",
          description: "Global operator",
          mode: "all",
          steps: 30,
          hidden: true,
        },
      },
      throwingContext(),
    ),
  )

  const globalTeamDir = path.join(globalTeamsPath(), "globalcrew")
  const filePath = path.join(globalTeamDir, "operator.md")
  expect(added).toEqual({ id: "operator", path: filePath })

  const diskContent = await Bun.file(filePath).text()
  expect(diskContent).toContain("Operate systems worldwide.")
  const parsed = parseTeamFields(diskContent)
  expect(parsed.model).toBe("anthropic/claude-3-opus")
  expect(parsed.description).toBe("Global operator")
  expect(parsed.mode).toBe("all")
  expect(parsed.steps).toBe(30)
  expect(parsed.hidden).toBe(true)

  const listed = await Effect.runPromise(ctx.agent.list())
  const operator = listed.data.find((entry) => String(entry.id) === "operator")
  expect(operator).toBeDefined()
  expect(operator?.system).toBe("Operate systems worldwide.")
  expect(operator?.model).toMatchObject({ providerID: "anthropic", id: "claude-3-opus" })
  expect(operator?.description).toBe("Global operator")
  expect(operator?.mode).toBe("all")
  expect(operator?.steps).toBe(30)
  expect(operator?.hidden).toBe(true)
})

test("persistence + host-install at Defaults tier writes overlay member with fields and registers on host", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate body" }] }]
  const ctx = fullContext({ directory: project, classifications: testClassifications })
  const handlers = createHandlers(ctx, createState(), { builtins: registry })

  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext()),
  )

  const added = await Effect.runPromise(
    handlers["team.addAgent"](
      {
        level: "defaults",
        team: "ship",
        id: "navigator",
        prompt: "Navigate through asteroid belts.",
        fields: {
          model: "google/gemini-1.5-pro",
          description: "Lead navigator",
          mode: "subagent",
          steps: 12,
        },
      },
      throwingContext(),
    ),
  )

  const overlayDir = path.join(globalDefaultsTeamsPath(), "ship")
  const filePath = path.join(overlayDir, "navigator.md")
  expect(added).toEqual({ id: "navigator", path: filePath })

  const diskContent = await Bun.file(filePath).text()
  expect(diskContent).toContain("Navigate through asteroid belts.")
  const parsed = parseTeamFields(diskContent)
  expect(parsed.model).toBe("google/gemini-1.5-pro")
  expect(parsed.description).toBe("Lead navigator")
  expect(parsed.mode).toBe("subagent")
  expect(parsed.steps).toBe(12)

  const listed = await Effect.runPromise(ctx.agent.list())
  const nav = listed.data.find((entry) => String(entry.id) === "navigator")
  expect(nav).toBeDefined()
  expect(nav?.system).toBe("Navigate through asteroid belts.")
  expect(nav?.model).toMatchObject({ providerID: "google", id: "gemini-1.5-pro" })
  expect(nav?.description).toBe("Lead navigator")
  expect(nav?.mode).toBe("subagent")
  expect(nav?.steps).toBe(12)

  const discovered = discoverBuiltinTeams(registry)
  const ship = discovered.find((team) => team.team === "ship")
  expect(ship?.agents.find((agent) => agent.id === "navigator")?.path).toBe(filePath)
})

test("normalization: strips undefined keys and normalizes model variant, request and permissions", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project, classifications: testClassifications })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "alpha" }, throwingContext()))
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "alpha", enabled: true }, throwingContext()),
  )

  const added = await Effect.runPromise(
    handlers["team.addAgent"](
      {
        level: "project",
        team: "alpha",
        id: "specialist",
        prompt: "Specialized tasks only.",
        fields: {
          model: "openai/gpt-4o",
          variant: "high",
          description: undefined,
          mode: "subagent",
          request: {
            headers: { "X-Audit": "enabled" },
            body: { temperature: 0.1 },
          },
          permissions: [
            { action: "file:read", resource: "packages/*", effect: "allow" },
            { action: "file:write", resource: "packages/plus/*", effect: "ask" },
          ],
        },
      },
      throwingContext(),
    ),
  )

  const diskContent = await Bun.file(added.path).text()
  expect(diskContent).not.toContain("undefined")
  expect(diskContent).toContain("variant: high")
  expect(diskContent).toContain("request:")
  expect(diskContent).toContain("X-Audit: enabled")
  expect(diskContent).toContain("temperature: 0.1")
  expect(diskContent).toContain("permissions:")

  const listed = await Effect.runPromise(ctx.agent.list())
  const specialist = listed.data.find((entry) => String(entry.id) === "specialist")
  expect(specialist).toBeDefined()
  expect(specialist?.model).toMatchObject({ providerID: "openai", id: "gpt-4o", variant: "high" })
  expect(specialist?.request.headers).toEqual(expect.objectContaining({ "X-Audit": "enabled" }))
  expect(specialist?.request.body).toEqual(expect.objectContaining({ temperature: 0.1 }))
})

test("template inheritance: explicit defined keys override template while omitted keys and prompt inherit", async () => {
  const { project } = await tempRoot()
  await enable(project)

  const builtinTemplate = {
    ...agentInfo("build", "Build the whole system from scratch.", modelRef("anthropic", "claude-3-haiku")),
    description: "Built-in builder agent",
    mode: "primary" as const,
  }

  const ctx = fullContext({
    directory: project,
    agents: [builtinTemplate],
    classifications: testClassifications,
  })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "craft" }, throwingContext()))
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "craft", enabled: true }, throwingContext()),
  )

  const added = await Effect.runPromise(
    handlers["team.addAgent"](
      {
        level: "project",
        team: "craft",
        id: "mason",
        template: "build",
        prompt: "Caller supplied prompt that should be ignored when template has prompt",
        fields: {
          model: "openai/gpt-4o",
          steps: 45,
        },
      },
      throwingContext(),
    ),
  )

  const diskContent = await Bun.file(added.path).text()
  expect(diskContent).toContain("Build the whole system from scratch.")
  expect(diskContent).not.toContain("Caller supplied prompt that should be ignored")

  const parsed = parseTeamFields(diskContent)
  expect(parsed.model).toBe("openai/gpt-4o")
  expect(parsed.steps).toBe(45)
  expect(parsed.description).toBe("Built-in builder agent")
  expect(parsed.mode).toBe("primary")

  const listed = await Effect.runPromise(ctx.agent.list())
  const mason = listed.data.find((entry) => String(entry.id) === "mason")
  expect(mason).toBeDefined()
  expect(mason?.system).toBe("Build the whole system from scratch.")
  expect(mason?.model).toMatchObject({ providerID: "openai", id: "gpt-4o" })
  expect(mason?.steps).toBe(45)
  expect(mason?.description).toBe("Built-in builder agent")
  expect(mason?.mode).toBe("primary")
})

test("template inheritance: overriding description preserves template model and mode", async () => {
  const { project } = await tempRoot()
  await enable(project)

  const builtinTemplate = {
    ...agentInfo("planner", "Plan system architectural layers.", modelRef("openai", "o1")),
    description: "Default planning agent",
    mode: "subagent" as const,
  }

  const ctx = fullContext({
    directory: project,
    agents: [builtinTemplate],
    classifications: testClassifications,
  })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "architects" }, throwingContext()))
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "architects", enabled: true }, throwingContext()),
  )

  const added = await Effect.runPromise(
    handlers["team.addAgent"](
      {
        level: "project",
        team: "architects",
        id: "chief",
        template: "planner",
        prompt: "Unused prompt",
        fields: {
          description: "Chief enterprise architect",
        },
      },
      throwingContext(),
    ),
  )

  const diskContent = await Bun.file(added.path).text()
  expect(diskContent).toContain("Plan system architectural layers.")

  const parsed = parseTeamFields(diskContent)
  expect(parsed.description).toBe("Chief enterprise architect")
  expect(parsed.model).toBe("openai/o1")
  expect(parsed.mode).toBe("subagent")

  const listed = await Effect.runPromise(ctx.agent.list())
  const chief = listed.data.find((entry) => String(entry.id) === "chief")
  expect(chief).toBeDefined()
  expect(chief?.system).toBe("Plan system architectural layers.")
  expect(chief?.description).toBe("Chief enterprise architect")
  expect(chief?.model).toMatchObject({ providerID: "openai", id: "o1" })
  expect(chief?.mode).toBe("subagent")
})
