// Team rules are instructions rows, so this file tests rows: the producer's
// output, what those rows resolve to through the real apply path, and that a
// project-level override changes the answer. No permission hook exists to
// test any more.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandlers, createState } from "../../src/index.js"
import { apply } from "../../src/instructions/apply.js"
import { liveRunScopes, policyMembersOf, teamPolicyItems } from "../../src/instructions/team-policy-rows.js"
import { fingerprint, type CustomizationRecord } from "../../src/instructions/model.js"
import { enable } from "../../src/project.js"
import { teamTools } from "../../src/teams/policy.js"
import { saveRun } from "../../src/teams/run.js"
import type { RunRecord } from "../../src/teams/run.js"
import { agentHarness, agentInfo, context, fullContext } from "../harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

let dir = ""
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teams-policy-rows-"))
})

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await rm(dir, { recursive: true, force: true })
})

function throwingContext(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      throw data === undefined ? { type, message } : { type, message, data }
    },
  }
}

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  const now = new Date().toISOString()
  return {
    id: "w-0000000000000001",
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: join(dir, "wt"),
    paths: ["packages/plus/src/*"],
    branch: "team/implementer/t-1",
    base: "ocp-main",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "team2-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: "ses_teampolicy001",
    configDigest: null,
    history: [],
    ...overrides,
  }
}

async function permissionsAfterApply(
  member: string,
  items: ReturnType<typeof teamPolicyItems>,
  records: CustomizationRecord[] = [],
  level: "defaults" | "project" = "defaults",
) {
  const agents = agentHarness([agentInfo(member, "upstream")])
  const ctx = context({ agent: agents.domain })
  await apply(ctx, {
    items,
    agents: [{ id: member, level }],
    records,
    splits: [],
    scopes: { global: new Set<string>(), defaults: level === "project" ? new Set([member]) : new Set<string>() },
    teamAgents: [member],
  })
  return agents.state.get(member)?.permissions ?? []
}

function has(
  permissions: readonly { action: string; resource: string; effect: string }[],
  action: string,
  resource: string,
  effect: string,
): boolean {
  return permissions.some((rule) => rule.action === action && rule.resource === resource && rule.effect === effect)
}

test("the producer emits one perm row per native action, per out-of-ceiling tool and per narrowed search server", () => {
  const items = teamPolicyItems(policyMembersOf(["muse-implementer"]))
  const ids = items.map((item) => item.id)
  expect(ids).toContain("perm:shell:team-role")
  expect(ids).toContain("perm:question:team-role")
  expect(ids).toContain("perm:external_directory:team-role")
  expect(ids).toContain("perm:subagent:team-role")
  expect(ids).toContain("perm:task:team-role")
  expect(ids).toContain("perm:read:team-role")
  expect(ids).toContain("perm:team_delegate:role-ceiling")
  expect(ids).toContain("perm:search:team-tavily")
  // In-ceiling tools carry no row: the member simply keeps them.
  expect(ids).not.toContain("perm:team_checkpoint:role-ceiling")
  for (const item of items) {
    expect(item.kind).toBe("perm")
    expect(item.agents).toEqual(["muse-implementer"])
    expect(item.policy).toBeDefined()
  }
})

test("an orchestrator ships shell on and an implementer ships it off", () => {
  const orchestrator = teamPolicyItems(policyMembersOf(["sol-orchestrator"]))
  const implementer = teamPolicyItems(policyMembersOf(["muse-implementer"]))
  expect(orchestrator.find((item) => item.id === "perm:shell:team-role")?.enabled).toBe(true)
  expect(implementer.find((item) => item.id === "perm:shell:team-role")?.enabled).toBe(false)
})

test("rows resolve to the role's native answers and its ceiling on the agent", async () => {
  const permissions = await permissionsAfterApply("muse-implementer", teamPolicyItems(policyMembersOf(["muse-implementer"])))
  expect(has(permissions, "shell", "*", "deny")).toBe(true)
  expect(has(permissions, "external_directory", "*", "deny")).toBe(true)
  expect(has(permissions, "question", "*", "deny")).toBe(true)
  expect(has(permissions, "subagent", "*", "deny")).toBe(true)
  expect(has(permissions, "task", "*", "deny")).toBe(true)
  expect(has(permissions, "read", "*.key", "deny")).toBe(true)
  expect(has(permissions, "read", "*.env*", "deny")).toBe(true)
  expect(has(permissions, "read", "*/auth.json", "deny")).toBe(true)
  expect(has(permissions, "team.delegate", "*", "deny")).toBe(true)
  expect(has(permissions, "team.checkpoint", "*", "deny")).toBe(false)
  expect(has(permissions, "search_tavily_*", "*", "deny")).toBe(true)
})

test("an orchestrator's shell row resolves to an explicit allow", async () => {
  const permissions = await permissionsAfterApply("sol-orchestrator", teamPolicyItems(policyMembersOf(["sol-orchestrator"])))
  expect(has(permissions, "shell", "*", "allow")).toBe(true)
  expect(has(permissions, "shell", "*", "deny")).toBe(false)
})

test("a project-level record on a role row overrides the shipped answer", async () => {
  const records: CustomizationRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "muse-implementer",
      item: "perm:shell:team-role",
      section: null,
      state: "on",
      basedOn: fingerprint("upstream"),
      updated: UPDATED,
    },
  ]
  const permissions = await permissionsAfterApply(
    "muse-implementer",
    teamPolicyItems(policyMembersOf(["muse-implementer"])),
    records,
    "project",
  )
  expect(has(permissions, "shell", "*", "allow")).toBe(true)
  expect(has(permissions, "shell", "*", "deny")).toBe(false)
})

test("a live run contributes an edit-scope row that allows scope.paths and denies everything else", async () => {
  await saveRun(dir, makeRun())
  const runs = await liveRunScopes(dir)
  expect(runs).toEqual([{ id: "w-0000000000000001", role: "muse-implementer", paths: ["packages/plus/src/*"] }])
  const items = teamPolicyItems(policyMembersOf(["muse-implementer"]), runs)
  const row = items.find((item) => item.id === "perm:edit:run:w-0000000000000001")
  expect(row).toBeDefined()
  expect(row?.runID).toBe("w-0000000000000001")
  expect(row?.text).toContain("packages/plus/src/*")
  const permissions = await permissionsAfterApply("muse-implementer", items)
  const editRules = permissions.filter((rule) => rule.action === "edit")
  expect(editRules).toEqual([
    { action: "edit", resource: "*", effect: "deny", message: OUTSIDE_SCOPE },
    { action: "edit", resource: "packages/plus/src/*", effect: "allow" },
    { action: "edit", resource: ".git/**", effect: "deny", message: forbiddenState(".git/**") },
    { action: "edit", resource: ".opencodeplus/**", effect: "deny", message: forbiddenState(".opencodeplus/**") },
  ])
})

// The refusals the round-1 permission hook sent are the rules' own words now,
// so a denied edit still tells the agent what its scope is and what to do.
// Source: docs/team-v2/acceptance/2026-09-18-live-rounds.md R2, hook commit
// c63cf4b4 "fix(plus): explain team scope denials to the agent".
const OUTSIDE_SCOPE = `"*" is outside your scope.paths [packages/plus/src/*]. Report it in needs=[{kind:"path"...}].`

function forbiddenState(resource: string): string {
  return `"${resource}" is version-control or paused-tool state and is never editable, even inside scope.paths [packages/plus/src/*]. Report it in needs=[{kind:"path"...}].`
}

test("the rules a denial comes from carry the message the model reads", async () => {
  await saveRun(dir, makeRun())
  const items = teamPolicyItems(policyMembersOf(["muse-implementer"]), await liveRunScopes(dir))
  const permissions = await permissionsAfterApply("muse-implementer", items)
  const { evaluate } = await import("../../../core/src/permission.js")

  // Edit scope: the two round-1 texts, verbatim but for the quoted subject.
  expect(evaluate("edit", "outside/other.ts", permissions).message).toBe(OUTSIDE_SCOPE)
  expect(evaluate("edit", ".git/HEAD", permissions).message).toBe(forbiddenState(".git/**"))
  expect(evaluate("edit", "packages/plus/src/index.ts", permissions).message).toBeUndefined()

  // Native denies name the role and, for shell, what to run instead.
  expect(evaluate("shell", "bun test", permissions).message).toBe(
    "shell is not available to muse-implementer; run checks with team_check",
  )
  expect(evaluate("question", "*", permissions).message).toBe("question is not available to muse-implementer")
  expect(evaluate("read", "secret.key", permissions).message).toBe(
    `read "*.key" is not available to muse-implementer`,
  )

  // Ceiling denies name the tool and the ceiling it is outside of.
  expect(evaluate("team.delegate", "*", permissions).message).toBe("team_delegate is outside the implementer ceiling")
  expect(evaluate("team.checkpoint", "*", permissions).effect).not.toBe("deny")
})

// A permission rule belongs to an agent, so two live runs of one role cannot
// hold separate scopes: what they must NOT do is take each other's away.
test("two live runs of one role resolve to the union of their scope.paths", async () => {
  await saveRun(dir, makeRun({ id: "w-0000000000000003", paths: ["a.ts"] }))
  await saveRun(dir, makeRun({ id: "w-0000000000000004", paths: ["b.ts"] }))
  const runs = await liveRunScopes(dir)
  expect(runs.map((run) => run.id)).toEqual(["w-0000000000000003", "w-0000000000000004"])
  const items = teamPolicyItems(policyMembersOf(["muse-implementer"]), runs)
  for (const id of ["w-0000000000000003", "w-0000000000000004"]) {
    const row = items.find((item) => item.id === `perm:edit:run:${id}`)
    expect(row?.runID).toBe(id)
    expect(row?.text).toContain("share one edit scope")
    expect(row?.text).toContain("[a.ts, b.ts]")
  }
  const permissions = await permissionsAfterApply("muse-implementer", items)
  // A rule belongs to the agent, so the messages name the union too: what the
  // rules really allow is what the agent is told.
  expect(permissions.filter((rule) => rule.action === "edit")).toEqual([
    {
      action: "edit",
      resource: "*",
      effect: "deny",
      message: `"*" is outside your scope.paths [a.ts, b.ts]. Report it in needs=[{kind:"path"...}].`,
    },
    { action: "edit", resource: "a.ts", effect: "allow" },
    { action: "edit", resource: "b.ts", effect: "allow" },
    {
      action: "edit",
      resource: ".git/**",
      effect: "deny",
      message: `".git/**" is version-control or paused-tool state and is never editable, even inside scope.paths [a.ts, b.ts]. Report it in needs=[{kind:"path"...}].`,
    },
    {
      action: "edit",
      resource: ".opencodeplus/**",
      effect: "deny",
      message: `".opencodeplus/**" is version-control or paused-tool state and is never editable, even inside scope.paths [a.ts, b.ts]. Report it in needs=[{kind:"path"...}].`,
    },
  ])
  const { evaluate } = await import("../../../core/src/permission.js")
  expect(evaluate("edit", "a.ts", permissions).effect).toBe("allow")
  expect(evaluate("edit", "b.ts", permissions).effect).toBe("allow")
  expect(evaluate("edit", ".git/config", permissions).effect).toBe("deny")
  expect(evaluate("edit", "elsewhere.ts", permissions).effect).toBe("deny")
})

test("a superseded run contributes no edit-scope row", async () => {
  await saveRun(dir, makeRun({ state: "superseded" }))
  expect(await liveRunScopes(dir)).toEqual([])
})

test("a run whose role is not a member of an enabled team contributes no row", async () => {
  await saveRun(dir, makeRun({ role: "stranger" }))
  const items = teamPolicyItems(policyMembersOf(["muse-implementer"]), await liveRunScopes(dir))
  expect(items.some((item) => item.runID !== undefined)).toBe(false)
})

test("a planner role emits an ask row on team.delegate", async () => {
  const items = teamPolicyItems(policyMembersOf(["fable-planner"]))
  const delegateRow = items.find((item) => item.id === "perm:team_delegate:team-role")
  expect(delegateRow).toBeDefined()
  expect(delegateRow?.enabled).toBe(true)
  expect(delegateRow?.policy?.on).toEqual([{ action: "team.delegate", resource: "*", effect: "ask" }])
  const permissions = await permissionsAfterApply("fable-planner", items)
  expect(has(permissions, "team.delegate", "*", "ask")).toBe(true)
  expect(has(permissions, "team.delegate", "*", "deny")).toBe(false)
})

// The producer tests above hand teamPolicyItems a member list. Only the live
// path decides that list, and it decides it again on every publish: the second
// publish re-discovers a host that now reports each installed member back as an
// ordinary defaults agent. Read the end of the path — what /api/agent shows.
test("a published member carries its native denies and ceiling while a non-member carries the namespace deny", async () => {
  process.env.OPENCODE_CONFIG_DIR = join(dir, "config")
  process.env.XDG_DATA_HOME = join(dir, "data")
  const project = join(dir, "project")
  await enable(project)
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("build", "upstream")],
    tools: teamTools.map((name) => ({
      id: name,
      description: `team ${name}`,
      options: { namespace: "team", permission: `team.${name}` },
    })),
  })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "defaults", team: "opencodeplus-team", enabled: true }, throwingContext()),
  )
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext()))

  const listed = await Effect.runPromise(ctx.agent.list())
  const permissionsOf = (id: string) => listed.data.find((entry) => String(entry.id) === id)?.permissions ?? []
  const member = permissionsOf("gemini-implementer")
  expect(member.length).toBeGreaterThan(0)
  expect(has(member, "shell", "*", "deny")).toBe(true)
  expect(has(member, "question", "*", "deny")).toBe(true)
  expect(has(member, "external_directory", "*", "deny")).toBe(true)
  expect(has(member, "subagent", "*", "deny")).toBe(true)
  expect(has(member, "task", "*", "deny")).toBe(true)
  expect(has(member, "read", "*.key", "deny")).toBe(true)
  expect(has(member, "search_tavily_*", "*", "deny")).toBe(true)
  // Out of the implementer ceiling, so denied; in it, so never denied.
  expect(has(member, "team.delegate", "*", "deny")).toBe(true)
  expect(has(member, "team.checkpoint", "*", "deny")).toBe(false)
  // A member is never hidden from the namespace it belongs to.
  expect(has(member, "team.*", "*", "deny")).toBe(false)

  expect(has(permissionsOf("build"), "team.*", "*", "deny")).toBe(true)
})

test("a child run for a planner role overrides ask to deny on team.delegate", async () => {
  await saveRun(dir, makeRun({ id: "w-0000000000000002", role: "fable-planner", paths: [] }))
  const runs = await liveRunScopes(dir)
  expect(runs.some((r) => r.id === "w-0000000000000002")).toBe(true)
  const items = teamPolicyItems(policyMembersOf(["fable-planner"]), runs)
  const childRow = items.find((item) => item.id === "perm:edit:run:w-0000000000000002")
  expect(childRow).toBeDefined()
  expect(childRow?.policy?.on).toContainEqual({ action: "team.delegate", resource: "*", effect: "deny" })
  const permissions = await permissionsAfterApply("fable-planner", items)
  const { evaluate } = await import("../../../core/src/permission.js")
  expect(evaluate("team.delegate", "*", permissions).effect).toBe("deny")
})
