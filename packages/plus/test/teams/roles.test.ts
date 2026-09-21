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

const TEN = [
  "fable-planner",
  "astra-planner",
  "sol-orchestrator",
  "opus-orchestrator",
  "muse-implementer",
  "gemini-implementer",
  "spark-implementer",
  "opus-implementer",
  "astra-reviewer",
  "scout",
] as const

interface Expectation {
  readonly description: string
  readonly shell: "allow" | "deny"
  readonly external: "allow" | "deny"
  readonly question: "allow" | "deny"
  /** null when the role's ceiling is the whole namespace, so nothing is denied. */
  readonly deniedTeamTool: string | null
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
    // An orchestrator's ceiling is the whole namespace now that every
    // advertised tool works, so no team tool is denied for it.
    deniedTeamTool: null,
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
  "opus-implementer": {
    description: "Genuinely hard or mistake-costly tasks",
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

// The rules no longer travel on the member definition: they are instructions
// rows under each member, and this test reads the end of that path — what
// /api/agent reports after a publish. The effective permissions are the same
// ones the old member-carried `permissions` list produced.
test("enabling opencodeplus-team installs all ten roles with mode, description, and deny rules", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "opencodeplus-team", enabled: true }, throwingContext({})))
  const listed = await Effect.runPromise(ctx.agent.list())
  const byId = new Map(listed.data.map((entry) => [String(entry.id), entry]))
  for (const id of TEN) expect(byId.has(id)).toBe(true)
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
    if (expected.deniedTeamTool !== null) expect(has(`team.${expected.deniedTeamTool}`, "*", "deny")).toBe(true)
    expect(has(`team.${expected.allowedTeamTool}`, "*", "deny")).toBe(false)
    // A member is never hidden from the namespace it belongs to.
    expect(has("team.*", "*", "deny")).toBe(false)
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
  for (const id of TEN) {
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
