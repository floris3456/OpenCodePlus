import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../../src/index.js"
import { enable } from "../../src/project.js"
import { teamTools } from "../../src/teams/policy.js"
import { fullContext } from "../harness.js"

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
  const root = await fs.mkdtemp(path.join(parent, "plus-teams-roles-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
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
    deniedTeamTool: "checkpoint",
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

test("final ceilings are asserted exactly for every built-in team role", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "opencodeplus-team", enabled: true }, throwingContext({})))
  const listed = await Effect.runPromise(ctx.agent.list())
  const byId = new Map(listed.data.map((entry) => [String(entry.id), entry]))

  const ceilings: Record<string, string[]> = {
    "fable-planner": ["delegate", "followup", "supersede", "stop", "finish", "status", "list", "wait", "get_context", "diff"],
    "astra-planner": ["delegate", "followup", "supersede", "stop", "finish", "status", "list", "wait", "get_context", "diff"],
    "sol-orchestrator": ["delegate", "followup", "integrate", "set_checks", "supersede", "stop", "finish", "status", "list", "wait", "get_context", "check", "diff"],
    "opus-orchestrator": ["delegate", "followup", "integrate", "set_checks", "supersede", "stop", "finish", "status", "list", "wait", "get_context", "check", "diff"],
    "muse-implementer": ["checkpoint", "finish", "status", "get_context", "check", "diff"],
    "gemini-implementer": ["checkpoint", "finish", "status", "get_context", "check", "diff"],
    "spark-implementer": ["checkpoint", "finish", "status", "get_context", "check", "diff"],
    "opus-implementer": ["checkpoint", "finish", "status", "get_context", "check", "diff"],
    "astra-reviewer": ["finish", "status", "get_context", "diff"],
    scout: ["finish", "status", "get_context", "diff"],
  }

  for (const [roleId, allowedList] of Object.entries(ceilings)) {
    const agent = byId.get(roleId)
    expect(agent).toBeDefined()
    if (agent === undefined) continue
    const permissions = agent.permissions ?? []
    const has = (action: string, resource: string, effect: string) =>
      permissions.some((rule) => rule.action === action && rule.resource === resource && rule.effect === effect)

    const allowedSet = new Set(allowedList)
    for (const tool of teamTools) {
      if (allowedSet.has(tool)) {
        // In-ceiling tools are not denied
        expect(has(`team.${tool}`, "*", "deny")).toBe(false)
        if (tool === "delegate" && (roleId === "fable-planner" || roleId === "astra-planner")) {
          // D6: team.delegate defaults to "ask" for planners
          expect(has("team.delegate", "*", "ask")).toBe(true)
        }
      } else {
        // Out-of-ceiling tools must be denied
        expect(has(`team.${tool}`, "*", "deny")).toBe(true)
      }
    }
  }
})

test("effective permission at /api/agent for a child session is never ask", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())

  const { saveRun } = await import("../../src/teams/run.js")
  const { teamsDataDir } = await import("../../src/instructions/paths.js")
  const { evaluate } = await import("../../../core/src/permission.js")

  const now = new Date().toISOString()
  await saveRun(teamsDataDir(), {
    id: "w-0000000000000001",
    role: "fable-planner",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: project,
    paths: [],
    branch: "test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    task: null,
    parent: "main-0123456789abcdef",
    children: [],
    briefSha: "abc",
    bundle: "test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: "ses_child_planner_001",
    configDigest: null,
    history: [],
  })

  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "opencodeplus-team", enabled: true }, throwingContext({})))
  const listed = await Effect.runPromise(ctx.agent.list())
  const planner = listed.data.find((entry) => String(entry.id) === "fable-planner")
  expect(planner).toBeDefined()
  const permissions = planner?.permissions ?? []

  // The child session's run-scoped row overrides ask to deny for team.delegate
  const effective = evaluate("team.delegate", "*", permissions)
  expect(effective.effect).toBe("deny")
  expect(effective.effect).not.toBe("ask")

  for (const tool of teamTools) {
    const eff = evaluate(`team.${tool}`, "*", permissions)
    expect(eff.effect).not.toBe("ask")
  }
})
