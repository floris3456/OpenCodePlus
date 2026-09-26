import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../../src/index.js"
import { enable } from "../../src/project.js"
import { directTools, teamTools } from "../../src/teams/policy.js"
import { fullContext } from "../harness.js"
import { presetInput, resolvedStates } from "./preset-table.js"

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

// The shipped team is a Plus team preset now, not a Defaults team (DESIGN §2,
// §5): a project team created from it has the same ten members, each linked
// to its member preset, and enabling it installs them.
async function installFromPreset(handlers: ReturnType<typeof createHandlers>): Promise<void> {
  await Effect.runPromise(
    handlers["team.create"]({ level: "project", team: "opencodeplus-team", preset: "opencodeplus-team" }, throwingContext({})),
  )
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "opencodeplus-team", enabled: true }, throwingContext({})),
  )
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

const DESCRIPTIONS: Record<(typeof TEN)[number], string> = {
  "fable-planner": "Fable planner: turns goals into exact task plans with paths and checks",
  "astra-planner": "Astra planner: turns goals into exact task plans with paths and checks",
  "sol-orchestrator": "Sol orchestrator: owns work, delegates by task, verifies and integrates",
  "opus-orchestrator": "Opus orchestrator: owns work, delegates by task, verifies and integrates",
  "muse-implementer": "Muse implementer: executes the brief inside scope and finishes",
  "gemini-implementer": "Gemini implementer: executes bounded work inside scope and finishes",
  "spark-implementer": "Spark implementer: rapid edit and check loops for a small piece",
  "opus-implementer": "Genuinely hard or mistake-costly tasks",
  "astra-reviewer": "Astra reviewer: reviews diffs against the brief with findings",
  scout: "Scout: finds things and reports exact file locations compactly",
}

const orchestrators = new Set(["sol-orchestrator", "opus-orchestrator"])
const planners = new Set(["fable-planner", "astra-planner"])

// The host's own tools plus the team namespace as Plus registers it: direct
// tools stay on the provider's list, code tools go through Code Mode.
const hostTools = [
  { id: "read", description: "Read a file.", options: { codemode: false } },
  { id: "shell", description: "Run a command.", options: { codemode: false } },
  ...teamTools.map((name) => ({
    id: name,
    description: `team ${name}`,
    options: { namespace: "team", permission: `team.${name}`, codemode: !(directTools as readonly string[]).includes(name) },
  })),
]

// The rules no longer travel on the member definition: they are rows each
// member's preset sets, and this test reads the end of that path — what
// /api/agent reports after a publish.
test("enabling opencodeplus-team installs all ten members with mode, description, and their presets' core denies", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project, tools: hostTools, session: { hook: () => Effect.succeed({ dispose: Effect.void }) } })
  const handlers = createHandlers(ctx, createState())
  await installFromPreset(handlers)
  const listed = await Effect.runPromise(ctx.agent.list())
  const byId = new Map(listed.data.map((entry) => [String(entry.id), entry]))
  for (const id of TEN) {
    const agent = byId.get(id)
    expect(agent).toBeDefined()
    if (agent === undefined) continue
    expect(agent.mode).toBe("primary")
    expect(agent.description).toBe(DESCRIPTIONS[id])
    const permissions = agent.permissions ?? []
    const has = (action: string, resource: string, effect: string) =>
      permissions.some((rule) => rule.action === action && rule.resource === resource && rule.effect === effect)
    // Secrets are closed for every member (read's Files rows off).
    expect([id, has("read", "*.key", "deny"), has("read", "*.env*", "deny"), has("read", "*/auth.json", "deny")]).toEqual([id, true, true, true])
    // Paths outside the checkout: open for coordinators, closed for workers.
    expect([id, has("external_directory", "*", "deny")]).toEqual([id, !orchestrators.has(id) && !planners.has(id)])
    // Orchestrators change no files, commits or refs from the shell.
    expect([id, has("shell", "git push *", "deny"), has("shell", "git stash", "deny")]).toEqual([id, orchestrators.has(id), orchestrators.has(id)])
    // A member is never hidden from the namespace it belongs to.
    expect(has("team.*", "*", "deny")).toBe(false)
  }
})

// What each member's rows resolve to, through its member preset and the Plus
// agent preset behind it: the old roles, row for row.
const input = presetInput()
const states = Object.fromEntries(TEN.map((id) => [id, resolvedStates(input, id)]))

test("the shell tool is on only for orchestrator-preset members", () => {
  for (const id of TEN) expect([id, states[id]?.["tool:shell"]]).toEqual([id, orchestrators.has(id) ? "on" : "off"])
  for (const id of TEN) expect([id, states[id]?.["tool:question"]]).toEqual([id, planners.has(id) ? "on" : "off"])
  for (const id of TEN) expect([id, states[id]?.["tool:subagent"]]).toEqual([id, "off"])
})

test("final ceilings are the team tool rows, exactly the old ceiling of every built-in role", () => {
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
  for (const [id, allowed] of Object.entries(ceilings)) {
    const open: string[] = teamTools.filter((tool) => states[id]?.[`tool:team_${tool}`] === "on")
    expect([id, open.toSorted()]).toEqual([id, allowed.toSorted()])
    // D6: a planner asks the human before each delegation.
    expect([id, states[id]?.["perm:team_delegate:approval.every"]]).toEqual([id, planners.has(id) ? "on" : "off"])
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

  await installFromPreset(handlers)
  const listed = await Effect.runPromise(ctx.agent.list())
  const planner = listed.data.find((entry) => String(entry.id) === "fable-planner")
  expect(planner).toBeDefined()
  const permissions = planner?.permissions ?? []

  // No core rule asks: a planner's approval is a Plus hook that refuses in a
  // run nobody watches, and whether its delegated run delegates at all is its
  // "Delegate from a delegated run" row, which the planner preset turns off.
  for (const tool of teamTools) {
    const eff = evaluate(`team.${tool}`, "*", permissions)
    expect(eff.effect).not.toBe("ask")
  }
  expect(states["fable-planner"]?.["perm:team_delegate:access.delegated"]).toBe("off")
})
