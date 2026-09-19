import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../../src/index.js"
import { enable } from "../../src/project.js"
import { fullContext } from "../harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-teams-roles-"))
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

const NINE = [
  "fable-planner",
  "astra-planner",
  "sol-orchestrator",
  "opus-orchestrator",
  "muse-implementer",
  "gemini-implementer",
  "spark-implementer",
  "astra-reviewer",
  "scout",
] as const

interface Expectation {
  readonly description: string
  readonly shell: "allow" | "deny"
  readonly external: "allow" | "deny"
  readonly question: "allow" | "deny"
  readonly deniedTeamTool: string
  readonly allowedTeamTool: string
}

const EXPECTED: Record<string, Expectation> = {
  "fable-planner": {
    description: "Fable planner: turns goals into exact task plans with paths and checks",
    shell: "deny",
    external: "allow",
    question: "allow",
    deniedTeamTool: "check",
    allowedTeamTool: "delegate",
  },
  "sol-orchestrator": {
    description: "Sol orchestrator: owns work, delegates by task, verifies and integrates",
    shell: "allow",
    external: "allow",
    question: "deny",
    deniedTeamTool: "plan_handoff",
    allowedTeamTool: "delegate",
  },
  "muse-implementer": {
    description: "Muse implementer: executes the brief inside scope and finishes",
    shell: "deny",
    external: "deny",
    question: "deny",
    deniedTeamTool: "delegate",
    allowedTeamTool: "checkpoint",
  },
  "gemini-implementer": {
    description: "Gemini implementer: executes bounded work inside scope and finishes",
    shell: "deny",
    external: "deny",
    question: "deny",
    deniedTeamTool: "delegate",
    allowedTeamTool: "checkpoint",
  },
  "spark-implementer": {
    description: "Spark implementer: rapid edit and check loops for a small piece",
    shell: "deny",
    external: "deny",
    question: "deny",
    deniedTeamTool: "delegate",
    allowedTeamTool: "checkpoint",
  },
  "astra-reviewer": {
    description: "Astra reviewer: reviews diffs against the brief with findings",
    shell: "deny",
    external: "deny",
    question: "deny",
    deniedTeamTool: "delegate",
    allowedTeamTool: "finish",
  },
  scout: {
    description: "Scout: finds things and reports exact file locations compactly",
    shell: "deny",
    external: "deny",
    question: "deny",
    deniedTeamTool: "delegate",
    allowedTeamTool: "finish",
  },
}

test("enabling opencodeplus-team installs all nine roles with mode, description, and deny rules", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "opencodeplus-team", enabled: true }, throwingContext({})))
  const listed = await Effect.runPromise(ctx.agent.list())
  const byId = new Map(listed.data.map((entry) => [String(entry.id), entry]))
  for (const id of NINE) expect(byId.has(id)).toBe(true)
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const agent = byId.get(id)
    expect(agent).toBeDefined()
    if (agent === undefined) continue
    expect(agent.mode).toBe("primary")
    expect(agent.description).toBe(expected.description)
    const permissions = agent.permissions ?? []
    const has = (action: string, resource: string, effect: string) =>
      permissions.some((rule) => rule.action === action && rule.resource === resource && rule.effect === effect)
    expect(has("shell", "*", expected.shell)).toBe(true)
    expect(has("external_directory", "*", expected.external)).toBe(true)
    expect(has("question", "*", expected.question)).toBe(true)
    expect(has("subagent", "*", "deny")).toBe(true)
    expect(has("task", "*", "deny")).toBe(true)
    expect(has("read", "*.key", "deny")).toBe(true)
    expect(has("read", "*.env*", "deny")).toBe(true)
    expect(has("read", "*/auth.json", "deny")).toBe(true)
    expect(has(`team.${expected.deniedTeamTool}`, "*", "deny")).toBe(true)
    expect(has(`team.${expected.allowedTeamTool}`, "*", "deny")).toBe(false)
  }
})

test("built-in roles allow shell only for orchestrators and deny shell for all others", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "opencodeplus-team", enabled: true }, throwingContext({})))
  const listed = await Effect.runPromise(ctx.agent.list())
  const byId = new Map(listed.data.map((entry) => [String(entry.id), entry]))
  const orchestrators = new Set(["sol-orchestrator", "opus-orchestrator"])
  for (const id of NINE) {
    const agent = byId.get(id)
    expect(agent).toBeDefined()
    if (agent === undefined) continue
    const permissions = agent.permissions ?? []
    const has = (action: string, resource: string, effect: string) =>
      permissions.some((rule) => rule.action === action && rule.resource === resource && rule.effect === effect)
    const expectedShell = orchestrators.has(id) ? "allow" : "deny"
    expect(has("shell", "*", expectedShell)).toBe(true)
    expect(has("shell", "*", "ask")).toBe(false)
  }
})
