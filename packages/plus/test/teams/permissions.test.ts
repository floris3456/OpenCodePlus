// Team rules are instructions rows, so this file tests rows: the producer's
// output, what those rows resolve to through the real apply path, and that a
// project-level override changes the answer. No permission hook exists to
// test any more.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply } from "../../src/instructions/apply.js"
import { liveRunScopes, policyMembersOf, teamPolicyItems } from "../../src/instructions/team-policy-rows.js"
import { fingerprint, type CustomizationRecord } from "../../src/instructions/model.js"
import { saveRun } from "../../src/teams/run.js"
import type { RunRecord } from "../../src/teams/run.js"
import { agentHarness, agentInfo, context } from "../harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teams-policy-rows-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

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
    { action: "edit", resource: "*", effect: "deny" },
    { action: "edit", resource: "packages/plus/src/*", effect: "allow" },
    { action: "edit", resource: ".git/**", effect: "deny" },
    { action: "edit", resource: ".opencodeplus/**", effect: "deny" },
  ])
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
