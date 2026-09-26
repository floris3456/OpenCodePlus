import { afterEach, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatMarkdown } from "../src/agents/files.js"
import { parseTeamFields } from "../src/instructions/teams-apply.js"
import { createHandlers, createState } from "../src/index.js"
import { load } from "../src/instructions/store.js"
import { globalTeamsPath, projectTeamsPath, teamsDataDir } from "../src/instructions/paths.js"
import { discoverBuiltinTeams } from "../src/instructions/teams.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentInfo, fullContext } from "./harness.js"

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

// DESIGN §5: a member is name → preset → done. The input names the member
// and, optionally, the preset; the old template/prompt/fields inputs are gone.
test("schema: TeamAddAgentInput takes an optional preset and nothing of the old template path", () => {
  const withoutPreset = { level: "project", team: "crew", id: "alice" } as const
  const decodedWithout = Schema.decodeUnknownSync(Plus.TeamAddAgentInput)(withoutPreset)
  expect(decodedWithout).toEqual(withoutPreset)
  expect("preset" in decodedWithout).toBe(false)

  const withPreset = { level: "global", team: "ops", id: "bob", preset: { kind: "member", team: "review", id: "editor" } } as const
  expect(Schema.decodeUnknownSync(Plus.TeamAddAgentInput)(withPreset)).toEqual(withPreset)

  const base = { level: "project", team: "crew", id: "alice" }
  expect(() => Schema.decodeUnknownSync(Plus.TeamAddAgentInput)({ ...base, preset: { kind: "invalid", id: "x" } })).toThrow()
  expect(() => Schema.decodeUnknownSync(Plus.TeamAddAgentInput)({ ...base, preset: "planner" })).toThrow()
})

// The member file carries the preset's mode and description (core reads them
// from the file) and an empty body; a team-scoped link makes the rest follow
// the preset. Host install reads the file.
test("team.addAgent at project tier writes the preset's mode and description, an empty body, and a team-scoped link", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project, classifications: testClassifications })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "devs" }, throwingContext()))
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "devs", enabled: true }, throwingContext()))

  const added = await Effect.runPromise(
    handlers["team.addAgent"](
      { level: "project", team: "devs", id: "coder", preset: { kind: "member", team: "review", id: "editor" } },
      throwingContext(),
    ),
  )

  const filePath = path.join(projectTeamsPath(project), "devs", "coder.md")
  expect(added).toEqual({ id: "coder", path: filePath })
  const diskContent = await Bun.file(filePath).text()
  const parsed = parseTeamFields(diskContent)
  expect(parsed.mode).toBe("primary")
  expect(parsed.description).toBe("Executes the brief inside scope and finishes")
  expect(diskContent.endsWith("---\n")).toBe(true)

  const links = (await load(project)).records.filter((record) => record.type === "link")
  expect(links).toEqual([
    expect.objectContaining({
      level: "project",
      agent: "coder",
      team: { level: "project", team: "devs" },
      preset: { kind: "member", team: "review", id: "editor" },
    }),
  ])

  const listed = await Effect.runPromise(ctx.agent.list())
  const coder = listed.data.find((entry) => String(entry.id) === "coder")
  expect(coder).toBeDefined()
  expect(coder?.description).toBe("Executes the brief inside scope and finishes")
  expect(coder?.mode).toBe("primary")
})

// Every frontmatter field a hand-written member file carries still installs
// on the host (the create path writes only mode and description; the file is
// the human's to extend).
test("a global member file's own fields install on the host", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project, classifications: testClassifications })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "globalcrew" }, throwingContext()))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "global", team: "globalcrew", id: "operator" }, throwingContext()))
  const filePath = path.join(globalTeamsPath(), "globalcrew", "operator.md")
  expect(await Bun.file(filePath).text()).toBe("---\nmode: primary\n---\n")
  await Bun.write(
    filePath,
    formatMarkdown(
      {
        model: "anthropic/claude-3-opus",
        variant: "high",
        description: "Global operator",
        mode: "all",
        steps: 30,
        hidden: true,
        request: { headers: { "X-Audit": "enabled" }, body: { temperature: 0.1 } },
        permissions: [{ action: "file:read", resource: "packages/*", effect: "allow" }],
      },
      "Operate systems worldwide.",
    ),
  )
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "global", team: "globalcrew", enabled: true }, throwingContext()))

  const listed = await Effect.runPromise(ctx.agent.list())
  const operator = listed.data.find((entry) => String(entry.id) === "operator")
  expect(operator).toBeDefined()
  expect(operator?.model).toMatchObject({ providerID: "anthropic", id: "claude-3-opus", variant: "high" })
  expect(operator?.description).toBe("Global operator")
  expect(operator?.mode).toBe("all")
  expect(operator?.steps).toBe(30)
  expect(operator?.hidden).toBe(true)
  expect(operator?.request.headers).toEqual(expect.objectContaining({ "X-Audit": "enabled" }))
  expect(operator?.request.body).toEqual(expect.objectContaining({ temperature: 0.1 }))
})

// DESIGN §4: a Defaults team takes member ENTRIES (patterns), never a file:
// team.addAgent at defaults stores an entry and writes no overlay file.
test("team.addAgent at defaults creates a Teams member entry and writes no overlay file", async () => {
  const { project, config } = await tempRoot()
  await enable(project)
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate body" }] }]
  const ctx = fullContext({ directory: project, classifications: testClassifications })
  const handlers = createHandlers(ctx, createState(), { builtins: registry })

  const added = await Effect.runPromise(
    handlers["team.addAgent"](
      { level: "defaults", team: "ship", id: "nav*", preset: { kind: "agent", id: "scout" } },
      throwingContext(),
    ),
  )
  expect(added).toEqual({ id: "nav*", path: "team:defaults:ship:nav*" })
  expect(await Bun.file(path.join(config, "opencodeplus", "teams-defaults", "ship", "nav*.md")).exists()).toBe(false)
  expect(discoverBuiltinTeams(registry).find((team) => team.team === "ship")?.agents.map((agent) => agent.id)).toEqual(["mate"])
  const records = (await load(project)).records
  expect(records.filter((record) => record.type === "entry")).toEqual([
    expect.objectContaining({ type: "entry", level: "defaults", catalogue: "teams", team: "ship", name: "nav*" }),
  ])
  expect(records.filter((record) => record.type === "link")).toEqual([
    expect.objectContaining({
      level: "defaults",
      agent: "nav*",
      team: { level: "defaults", team: "ship" },
      preset: { kind: "agent", id: "scout" },
    }),
  ])
  const duplicate: { current?: CapturedError } = {}
  await expect(
    Effect.runPromise(handlers["team.addAgent"]({ level: "defaults", team: "ship", id: "nav*" }, throwingContext(duplicate))),
  ).rejects.toBeDefined()
  expect(duplicate.current?.type).toBe("entry.exists")
})

// The Defaults-template path left: a member created from the Native `build`
// preset copies build's mode and description, not its prompt, and follows
// it through the link instead.
test("a member created from a Native preset copies mode and description, not the prompt", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const build = {
    ...agentInfo("build", "Build the whole system from scratch."),
    description: "Built-in builder agent",
    mode: "primary" as const,
  }
  const ctx = fullContext({ directory: project, agents: [build], classifications: testClassifications })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "craft" }, throwingContext()))
  const added = await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "craft", id: "mason", preset: { kind: "agent", id: "build" } }, throwingContext()),
  )
  const diskContent = await Bun.file(added.path).text()
  expect(diskContent).not.toContain("Build the whole system from scratch.")
  const parsed = parseTeamFields(diskContent)
  expect(parsed.description).toBe("Built-in builder agent")
  expect(parsed.mode).toBe("primary")
  expect(parsed.model).toBeUndefined()

  const unknown: { current?: CapturedError } = {}
  await expect(
    Effect.runPromise(
      handlers["team.addAgent"]({ level: "project", team: "craft", id: "other", preset: { kind: "agent", id: "ghost" } }, throwingContext(unknown)),
    ),
  ).rejects.toBeDefined()
  expect(unknown.current?.type).toBe("preset.invalid")
  expect(await Bun.file(path.join(projectTeamsPath(project), "craft", "other.md")).exists()).toBe(false)
})
