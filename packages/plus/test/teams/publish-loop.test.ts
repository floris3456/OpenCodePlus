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

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-publish-loop-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
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
  // The role still installs with its mode, description, and permission rules.
  const installed = await Effect.runPromise(ctx.agent.list())
  const fielded = installed.data.find((entry) => String(entry.id) === "fielded")
  expect(fielded?.system).toBe("fielded body")
  expect(fielded?.description).toBe("Fielded agent")
  expect(fielded?.mode).toBe("subagent")
  expect(fielded?.permissions.some((rule) => rule.action === "shell" && rule.resource === "*" && rule.effect === "deny")).toBe(true)
  const afterEnable = state.fingerprint
  const installs = agents.transforms
  const disposes = agents.disposes
  const reloads = agents.reloads
  // Second publish with unchanged inputs is a genuine no-op: the fingerprint
  // is unchanged and no further agent registrations or reloads happen.
  // Before the team-field unmask, the host's own description/mode/permissions
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
