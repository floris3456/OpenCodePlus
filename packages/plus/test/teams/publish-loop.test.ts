import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../../src/index.js"
import { enable } from "../../src/project.js"
import { agentHarness, agentInfo, context, fullContext, skillHarness } from "../harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-publish-loop-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  // Live run scopes become policy rows, so the data dir is part of the
  // fingerprint's inputs and must not be the developer's real one.
  process.env.XDG_DATA_HOME = path.join(root, "data")
  return { project: path.join(root, "project") }
}

function throwingContext(captured: { current?: unknown }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      captured.current = data === undefined ? { type, message } : { type, message, data }
      throw captured.current
    },
  }
}

function fixtureWithFields() {
  return [
    {
      name: "ship",
      members: [
        {
          id: "fielded",
          body: "fielded body",
          fields: {
            description: "Fielded agent",
            mode: "subagent" as const,
            permissions: [
              { action: "shell", resource: "*", effect: "deny" as const },
              { action: "read", resource: "*.key", effect: "deny" as const },
              { action: "team.delegate", resource: "*", effect: "deny" as const },
            ],
          },
        },
      ],
    },
  ]
}

test("second publish with fielded builtin member is a no-op", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const ctx = context({
    location,
    agent: agents.domain,
    skill,
    tool: fullContext({ directory: project }).tool,
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: fixtureWithFields() })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  // The role still installs with its mode and description. Declared permissions
  // are parsed for the fingerprint and never installed; what the member may do
  // lives in instructions rows.
  const installed = await Effect.runPromise(ctx.agent.list())
  const fielded = installed.data.find((entry) => String(entry.id) === "fielded")
  expect(fielded?.system).toBe("fielded body")
  expect(fielded?.description).toBe("Fielded agent")
  expect(fielded?.mode).toBe("subagent")
  expect(fielded?.permissions.some((rule) => rule.action === "shell" && rule.resource === "*" && rule.effect === "deny")).toBe(false)
  expect(fielded?.permissions.some((rule) => rule.action === "read" && rule.resource === "*.key" && rule.effect === "deny")).toBe(false)
  expect(fielded?.permissions.some((rule) => rule.action === "team.delegate" && rule.resource === "*" && rule.effect === "deny")).toBe(false)
  const afterEnable = state.fingerprint
  const installs = agents.transforms
  const disposes = agents.disposes
  const reloads = agents.reloads
  // Second publish with unchanged inputs is a genuine no-op: the fingerprint
  // is unchanged and no further agent registrations or reloads happen.
  // Before the team-field unmask, the host's own description/mode
  // reported as upstream, the team lost to its own output (teamBodies []),
  // and every pass disposed and reinstalled in a loop.
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(state.fingerprint).toBe(afterEnable)
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(agents.reloads).toBe(reloads)
  const again = await Effect.runPromise(ctx.agent.list())
  expect(again.data.some((entry) => String(entry.id) === "fielded")).toBe(true)
})

// The member policy rows are perm items carrying `policy`, so they are part of
// the publish fingerprint. A member dropped on re-discovery would therefore not
// just lose its rules: it would flip the fingerprint on every pass and dispose
// and reinstall the whole registration set in a loop.
test("second publish with the built-in team enabled is a no-op", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const agents = agentHarness([agentInfo("alpha", "upstream")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  // A host with the read tool, so the members' presets install core denies.
  const host = fullContext({ directory: project, tools: [{ id: "read", description: "Read a file.", options: { codemode: false } }] })
  const ctx = context({
    location,
    agent: agents.domain,
    skill,
    tool: host.tool,
    mcp: host.mcp,
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  // The shipped team is a Plus team preset now, not a Defaults team (DESIGN
  // §2, §5): a project team created from it has the same members, linked to
  // their member presets.
  await Effect.runPromise(
    handlers["team.create"]({ level: "project", team: "opencodeplus-team", preset: "opencodeplus-team" }, throwingContext({})),
  )
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "opencodeplus-team", enabled: true }, throwingContext({})),
  )
  // The implementer preset closes private keys: read's Private keys row is a core deny.
  const deniesKeys = (permissions: readonly { action: string; resource: string; effect: string }[]) =>
    permissions.some((rule) => rule.action === "read" && rule.resource === "*.key" && rule.effect === "deny")
  const installed = await Effect.runPromise(ctx.agent.list())
  expect(deniesKeys(installed.data.find((entry) => String(entry.id) === "gemini-implementer")?.permissions ?? [])).toBe(true)
  const afterEnable = state.fingerprint
  const installs = agents.transforms
  const disposes = agents.disposes
  const reloads = agents.reloads
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(state.fingerprint).toBe(afterEnable)
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(agents.reloads).toBe(reloads)
  const republished = await Effect.runPromise(ctx.agent.list())
  expect(deniesKeys(republished.data.find((entry) => String(entry.id) === "gemini-implementer")?.permissions ?? [])).toBe(true)
})
