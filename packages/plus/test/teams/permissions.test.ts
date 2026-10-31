// Team rules are instructions rows, so this file tests rows: the per-member
// producer's output, what a member's rows resolve to through its preset and
// the real apply path, and that a project-level override changes the answer.
// Nothing reads a member's id: the same member id with another preset (or
// none) gets other rules.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandlers, createPlusApi, createState } from "../../src/index.js"
import { apply, sessionPlans } from "../../src/instructions/apply.js"
import { teamsDataDir } from "../../src/instructions/paths.js"
import { itemOf } from "../../src/instructions/snapshot.js"
import { liveRunScopes, policyMembersOf, teamPolicyItems } from "../../src/instructions/team-policy-rows.js"
import { fingerprint, type CustomizationRecord, type Item, type PolicyEffects } from "../../src/instructions/model.js"
import { Plus } from "../../src/rpc.js"
import { teamTools } from "../../src/teams/policy.js"
import { saveRun } from "../../src/teams/run.js"
import type { RunRecord } from "../../src/teams/run.js"
import { registerInstructionTools } from "../../src/tools.js"
import { agentHarness, agentInfo, context, fullContext, toolHarness } from "../harness.js"
import { change, linked, presetInput, presetTable, resolvedStates, type TeamMember } from "./preset-table.js"

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
    role: "implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: join(dir, "wt"),
    paths: ["packages/plus/src/*"],
    branch: "team/implementer/t-1",
    base: "main",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "test-bundle",
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

test("the producer emits only per-member rows: Delegate to rows, and live-run edit scopes", () => {
  const items = teamPolicyItems(policyMembersOf([{ id: "implementer", team: "crew" }, { id: "orchestrator", team: "crew" }]))
  // One row per member of the team, the member itself included.
  expect(items.map((item) => [item.id, item.agents, item.enabled])).toEqual([
    ["perm:team_delegate:to.implementer", ["implementer"], false],
    ["perm:team_delegate:to.orchestrator", ["implementer"], false],
    ["perm:team_delegate:to.other-teams", ["implementer"], false],
    ["perm:team_delegate:to.implementer", ["orchestrator"], false],
    ["perm:team_delegate:to.orchestrator", ["orchestrator"], false],
    ["perm:team_delegate:to.other-teams", ["orchestrator"], false],
  ])
  for (const item of items) expect([item.id, item.kind, item.permKind, item.category, item.policy]).toEqual([item.id, "perm", "team", "to", undefined])
})

test("an orchestrator preset ships shell on and an implementer preset ships it off; the same id with no preset has it off", () => {
  const orchestrator = linked("ocp-alice", "orchestrator")
  const implementer = linked("ocp-bob", "implementer")
  const bare: TeamMember = { id: "ocp-carol", team: "crew" }
  const input = presetInput({ members: [orchestrator, implementer, bare] })
  expect(resolvedStates(input, "ocp-alice")["tool:shell"]).toBe("on")
  expect(resolvedStates(input, "ocp-bob")["tool:shell"]).toBe("off")
  expect(resolvedStates(input, "ocp-carol")["tool:shell"]).toBe("off")
  // Swapping the presets swaps the answers: nothing comes from the ids.
  const swapped = presetInput({ members: [linked("ocp-alice", "implementer"), linked("ocp-bob", "orchestrator")] })
  expect(resolvedStates(swapped, "ocp-alice")["tool:shell"]).toBe("off")
  expect(resolvedStates(swapped, "ocp-bob")["tool:shell"]).toBe("on")
})

// One tool of each namespace only the build seat keeps (preset-table's inventory).
const seatOnlyTools = ["browser_navigate", "instructions_set", "release_request", "monitor_query", "opencode_session_move"]

// The rules and tool plans one member carries after apply.
async function applyFor(input: ReturnType<typeof presetInput>, member: string) {
  const agents = agentHarness([agentInfo(member, "upstream")])
  const applied = await apply(context({ agent: agents.domain, session: { hook: () => Effect.succeed({ dispose: Effect.void }) } }), input)
  return { permissions: agents.state.get(member)?.permissions ?? [], tools: applied.tools.filter((plan) => plan.agent === member) }
}

test("an implementer-preset member's rows resolve to the old implementer answers through apply", async () => {
  const member = linked("implementer", "implementer")
  const { permissions, tools } = await applyFor(presetInput({ members: [member] }), member.id)
  // Tool rows off drop the tools: no shell, no question, no subagent, no delegation,
  // no web search beyond code search, none of the build seat's tools.
  const off = tools.filter((plan) => !plan.enabled).map((plan) => plan.tool).toSorted()
  expect(off).toEqual(
    [
      "shell", "question", "subagent", "web_tavily_search", "web_tavily_fetch",
      "team_delegate", "team_followup", "team_integrate", "team_stop", "team_status", "team_list",
      ...seatOnlyTools,
    ].toSorted(),
  )
  // OpenCode's search stays in Code Mode, which the member does not have: denied whole.
  expect(has(permissions, "web_opencode_search", "*", "deny")).toBe(true)
  expect(tools.find((plan) => plan.tool === "team_checkpoint")).toBeUndefined()
  // Secret read rows and the outside-checkout rule are core denies.
  expect(has(permissions, "read", "*.key", "deny")).toBe(true)
  expect(has(permissions, "read", "*.env*", "deny")).toBe(true)
  expect(has(permissions, "read", "*/auth.json", "deny")).toBe(true)
  expect(has(permissions, "read", "*/.config/opencodeplus/opencode.json", "deny")).toBe(true)
  expect(has(permissions, "read", "*.db", "deny")).toBe(true)
  expect(has(permissions, "external_directory", "*", "deny")).toBe(true)
})

test("an orchestrator-preset member keeps shell and reads outside its checkout", async () => {
  const member = linked("orchestrator", "orchestrator")
  const { permissions, tools } = await applyFor(presetInput({ members: [member] }), member.id)
  expect(tools.find((plan) => plan.tool === "shell")).toBeUndefined()
  // It leaves web search to the planner.
  expect(tools.filter((plan) => !plan.enabled).map((plan) => plan.tool).toSorted()).toEqual(
    ["question", "subagent", "web_tavily_search", "web_tavily_fetch", ...seatOnlyTools].toSorted(),
  )
  expect(has(permissions, "web_opencode_search", "*", "deny")).toBe(true)
  expect(has(permissions, "external_directory", "*", "deny")).toBe(false)
  expect(has(permissions, "read", "*.key", "deny")).toBe(true)
})

test("members other than the build seat get search direct and no execute; the seat keeps Code Mode", () => {
  const members = [linked("planner", "planner"), linked("implementer", "implementer"), linked("build-seat", "build-seat")]
  const options = { members }
  const plans = sessionPlans(presetInput(options), presetTable(options))
  const direct = (agent: string) => plans.exposure.filter((entry) => entry.agent === agent && entry.mode === "direct").map((entry) => entry.tool).toSorted()
  const denied = (agent: string) => plans.denials.filter((entry) => entry.agent === agent).map((entry) => entry.tool).toSorted()
  // The web tools a member uses go direct, OpenCode's fetch with them.
  expect(direct("planner")).toEqual(["web_exa_code_search", "web_opencode_fetch", "web_tavily_fetch", "web_tavily_search"])
  // OpenCode's search is off for members, and stays in Code Mode: denied whole with execute.
  expect(denied("planner")).toEqual(["execute", "web_opencode_search"])
  // Tavily is off for an implementer: direct and off, so it is simply not sent.
  expect(direct("implementer")).toEqual(["web_exa_code_search", "web_opencode_fetch", "web_tavily_fetch", "web_tavily_search"])
  expect(denied("implementer")).toEqual(["execute", "web_opencode_search"])
  expect(plans.native.find((plan) => plan.agent === "implementer" && plan.tool === "web_tavily_search")?.enabled).toBe(false)
  expect(direct("build-seat")).toEqual([])
  expect(denied("build-seat")).toEqual([])
})

test("a reviewer and a scout, with no skill on, get no skill tool; an implementer keeps it", async () => {
  const members = [linked("reviewer", "reviewer"), linked("scout", "scout"), linked("implementer", "implementer")]
  const input = presetInput({ members })
  const skill = await Promise.all(members.map(async (member) => (await applyFor(input, member.id)).tools.find((plan) => plan.tool === "skill")?.enabled))
  expect(skill).toEqual([false, false, undefined])
})

test("a project-level record on a preset row overrides the shipped answer", async () => {
  const member = linked("implementer", "implementer")
  const { tools } = await applyFor(presetInput({ members: [member], records: [change(member, "tool:shell", { state: "on" })] }), member.id)
  expect(tools.find((plan) => plan.tool === "shell")).toBeUndefined()
  expect(tools.find((plan) => plan.tool === "question")?.enabled).toBe(false)
})

test("invalid legacy scopes do not break the global guidance inventory", async () => {
  await saveRun(dir, makeRun({ id: "w-legacy", role: "other-team", paths: ["packages/plus/**"] }))
  await saveRun(dir, makeRun())
  expect((await liveRunScopes(dir)).map((run) => run.id)).toEqual(["w-0000000000000001"])
  expect(teamPolicyItems(policyMembersOf(["implementer"]), await liveRunScopes(dir)).some((item) => item.runID === "w-0000000000000001")).toBe(true)
})

test("a live run describes its scope without adding agent-wide allows", async () => {
  await saveRun(dir, makeRun())
  const runs = await liveRunScopes(dir)
  expect(runs).toEqual([{ id: "w-0000000000000001", role: "implementer", paths: ["packages/plus/src/*"], forbidden: [] }])
  const items = teamPolicyItems(policyMembersOf(["implementer"]), runs)
  const row = items.find((item) => item.id === "perm:edit:run:w-0000000000000001")
  expect(row).toBeDefined()
  expect(row?.runID).toBe("w-0000000000000001")
  expect(row?.text).toContain("packages/plus/src/*")
  const permissions = await permissionsAfterApply("implementer", items)
  const editRules = permissions.filter((rule) => rule.action === "edit")
  expect(editRules).toEqual([])
  expect(row?.text).toContain("Session-aware enforcement")
})

test("scope display does not override preset denial messages", async () => {
  await saveRun(dir, makeRun())
  const items = teamPolicyItems(policyMembersOf(["implementer"]), await liveRunScopes(dir))
  const permissions = await permissionsAfterApply("implementer", items)
  const { evaluate } = await import("../../../core/src/permission.js")

  // Scope is checked per Session, not compiled into agent-wide rules.
  expect(permissions.filter((rule) => rule.action === "edit")).toEqual([])
  expect(evaluate("edit", "packages/plus/src/index.ts", permissions).message).toBeUndefined()

  // A preset's secret rows deny with their own words, naming the row that did it.
  const member = linked("implementer", "implementer")
  const preset = await applyFor(presetInput({ members: [member] }), member.id)
  expect(evaluate("read", "secret.key", preset.permissions).message).toBe(
    'Private keys cannot be read here (denied by item:project:opencodeplus-team/:implementer:perm:read:files.keys "Private keys": off, from preset basic › implementer)',
  )
  expect(evaluate("external_directory", "/etc/hosts", preset.permissions).message).toBe(
    'paths outside this checkout are not available here; still allowed: Temporary directories (denied by item:project:opencodeplus-team/:implementer:perm:read:where.external "Outside this checkout, for every tool (external_directory)": off, from preset basic › implementer)',
  )
})

// Agent-wide rows must neither union nor intersect independent run scopes.
test("two live runs of one role describe individual scopes, not an agent-wide union", async () => {
  await saveRun(dir, makeRun({ id: "w-0000000000000003", paths: ["a.ts"] }))
  await saveRun(dir, makeRun({ id: "w-0000000000000004", paths: ["b.ts"] }))
  const runs = await liveRunScopes(dir)
  expect(runs.map((run) => run.id)).toEqual(["w-0000000000000003", "w-0000000000000004"])
  const items = teamPolicyItems(policyMembersOf(["implementer"]), runs)
  for (const id of ["w-0000000000000003", "w-0000000000000004"]) {
    const row = items.find((item) => item.id === `perm:edit:run:${id}`)
    expect(row?.runID).toBe(id)
    expect(row?.text).toContain("Same-role runs do not share scope")
    expect(row?.text).not.toContain("[a.ts, b.ts]")
  }
  const permissions = await permissionsAfterApply("implementer", items)
  // Enforcement belongs to the Session hook, covered in permission-hooks.
  expect(permissions.filter((rule) => rule.action === "edit")).toEqual([])
})

test("a superseded run contributes no edit-scope row", async () => {
  await saveRun(dir, makeRun({ state: "superseded" }))
  expect(await liveRunScopes(dir)).toEqual([])
})

test("a run whose role is not a member of an enabled team contributes no row", async () => {
  await saveRun(dir, makeRun({ role: "stranger" }))
  const items = teamPolicyItems(policyMembersOf(["implementer"]), await liveRunScopes(dir))
  expect(items.some((item) => item.runID !== undefined)).toBe(false)
})

// The producer tests above hand teamPolicyItems a member list. Only the live
// path decides that list, and it decides it again on every publish: the second
// publish re-discovers a host that now reports each installed member back as an
// ordinary defaults agent. Read the end of the path — what /api/agent shows.
test("a published member carries its preset's denies while a non-member's team tools are off one by one", async () => {
  process.env.OPENCODE_CONFIG_DIR = join(dir, "config")
  process.env.XDG_DATA_HOME = join(dir, "data")
  const project = join(dir, "project")
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
  // The shipped team is a Plus team preset now, not a Defaults team (DESIGN
  // §2, §5): a project team created from it has the same members.
  await Effect.runPromise(
    handlers["team.create"]({ level: "project", team: "opencodeplus-team", preset: "basic" }, throwingContext()),
  )
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "opencodeplus-team", enabled: true }, throwingContext()),
  )
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext()))

  const listed = await Effect.runPromise(ctx.agent.list())
  const permissionsOf = (id: string) => listed.data.find((entry) => String(entry.id) === id)?.permissions ?? []
  const member = permissionsOf("implementer")
  expect(member.length).toBeGreaterThan(0)
  // Its implementer preset: the team tools outside its old ceiling are off
  // (this host registers only team tools, as Code Mode tools: off denies by name).
  expect(has(member, "team_delegate", "*", "deny")).toBe(true)
  expect(has(member, "team_list", "*", "deny")).toBe(true)
  expect(has(member, "team_checkpoint", "*", "deny")).toBe(false)
  // An orchestrator keeps what its preset gives it.
  const orchestrator = permissionsOf("orchestrator")
  expect(has(orchestrator, "team_delegate", "*", "deny")).toBe(false)
  // It commits the tests that judge its implementers.
  expect(has(orchestrator, "team_checkpoint", "*", "deny")).toBe(false)
  // A member is never hidden from the namespace it belongs to.
  expect(has(member, "team.*", "*", "deny")).toBe(false)

  // A stand-alone agent, OpenCode's build included, has no namespace deny:
  // each of its team tool rows is off by default and refuses on its own.
  const build = permissionsOf("build")
  expect(has(build, "team.*", "*", "deny")).toBe(false)
  for (const name of teamTools) expect([name, has(build, `team.${name}`, "*", "deny")]).toEqual([name, true])
  expect(has(orchestrator, "team.delegate", "*", "deny")).toBe(false)
})

// The wire every reader outside the server goes through: the server encodes
// each Item as a SnapshotItem, it travels as JSON, and itemOf rebuilds it. A
// field missing from either side is silently dropped here, so the words a rule
// refuses with reach a reader only if Plus.PolicyRule carries them too.
function acrossSnapshotBoundary(source: readonly Item[]): Item[] {
  const wire = source.map((item) => Schema.encodeSync(Plus.SnapshotItem)(item))
  return Schema.decodeUnknownSync(Schema.Array(Plus.SnapshotItem))(JSON.parse(JSON.stringify(wire))).map(itemOf)
}

test("scope guidance and delegation refusals survive the snapshot boundary", () => {
  const member = "implementer"
  const run = { id: "w-0000000000000005", role: member, paths: ["packages/plus/src/*"] }
  const crossed = acrossSnapshotBoundary(teamPolicyItems(policyMembersOf([member]), [run]))
  const policyOf = (id: string): PolicyEffects | undefined => crossed.find((item) => item.id === id)?.policy

  // A Delegate to row keeps its refusal text and how it is enforced.
  expect(crossed.find((item) => item.id === "perm:team_delegate:to.other-teams")).toMatchObject({
    permKind: "team",
    category: "to",
    message: `${member} delegates only within its own team`,
  })
  // Guidance carries no agent-wide allows.
  expect(policyOf(`perm:edit:run:${run.id}`)?.on).toEqual([])

  // Snapshot readback still names the individual Session boundary.
  const scope = policyOf(`perm:edit:run:${run.id}`)?.on ?? []
  expect(scope).toEqual([])
  expect(crossed.find((item) => item.runID === run.id)?.text).toContain("Same-role runs do not share scope")
})

const showContext: Tool.Context = {
  sessionID: Session.ID.make("ses_teampolicyshow"),
  agent: Agent.ID.make("orchestrator"),
  messageID: SessionMessage.ID.make("msg_teampolicyshow"),
  id: Tool.CallID.make("call_teampolicyshow"),
  progress: () => Effect.void,
}

async function showPolicy(
  tools: Map<string, Tool.Info & { readonly id: string }>,
  id: string,
): Promise<{ readonly tool: string; readonly rule?: string; readonly patterns?: readonly string[]; readonly policy?: PolicyEffects }> {
  const show = tools.get("instructions_read")
  if (show === undefined) throw new Error("missing tool instructions_read")
  const output = await Effect.runPromise(show.execute({ id }, showContext).pipe(Effect.map((result) => result.output)))
  return output as { readonly tool: string; readonly rule?: string; readonly patterns?: readonly string[]; readonly policy?: PolicyEffects }
}

// The reader's end of that wire, through the registered tool: instructions_read
// on a perm row returns the row's policy, so a reader sees what the rule says
// when it refuses and not merely that some rule exists.
test("instructions_read on a run edit-scope row reports the rules and the message each refuses with", async () => {
  process.env.OPENCODE_CONFIG_DIR = join(dir, "config")
  process.env.XDG_DATA_HOME = join(dir, "data")
  const project = join(dir, "project")
  const member = "implementer"
  const run = makeRun({ id: "w-0000000000000006", role: member })
  await saveRun(teamsDataDir(), run)
  // fullContext keeps its own tool registry private, so the test installs the
  // registry the instruction tools land in and reads them back out of it.
  const registry = toolHarness(
    teamTools.map((name) => ({
      id: name,
      description: `team ${name}`,
      options: { namespace: "team", permission: `team.${name}` },
    })),
  )
  const ctx = { ...fullContext({ directory: project }), tool: registry.domain }
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  // The shipped team is a Plus team preset now, not a Defaults team (DESIGN
  // §2, §5): a project team created from it has the same members.
  const created = await api.createTeam({ level: "project", team: "opencodeplus-team", preset: "basic" })
  expect(created.ok).toBe(true)
  const enabled = await api.setTeamEnabled({ level: "project", team: "opencodeplus-team", enabled: true })
  expect(enabled.ok).toBe(true)

  // T5: a Global/Project team member never appears under Defaults, so the
  // run edit-scope row is addressed at the member's own `<team>/:<member>`
  // path. instructions_read still reports the rule it carries: the run it
  // scopes and the patterns that are eligible.
  const scope = await showPolicy(registry.tools, `item:project:opencodeplus-team/:${member}:perm:edit:run:${run.id}`)
  expect(scope.tool).toBe("edit")
  expect(scope.rule).toBe(`run:${run.id}`)
  expect(scope.patterns).toEqual(run.paths)
  expect(scope.policy).toEqual({
    on: [],
    off: [],
  })
})

// A delegated planner no longer gets a delegate deny from its run: whether a
// delegated run delegates further is its member's "Delegate from a delegated
// run" row, which the planner preset turns off (delegation-rows.test.ts runs it).
test("a delegated run's edit-scope row carries edit rules only, whoever the member is", async () => {
  await saveRun(dir, makeRun({ id: "w-0000000000000002", role: "planner", paths: [] }))
  const runs = await liveRunScopes(dir)
  const items = teamPolicyItems(policyMembersOf(["planner"]), runs)
  const childRow = items.find((item) => item.id === "perm:edit:run:w-0000000000000002")
  expect(childRow?.policy?.on.every((rule) => rule.action === "edit")).toBe(true)
  // With no scope.paths the delegated run may edit nothing.
  expect(childRow?.policy?.on).toEqual([])
  expect(childRow?.text).toContain("scope.paths []")
  const planner = presetInput({ members: [linked("planner", "planner")] })
  expect(resolvedStates(planner, "planner")["perm:team_delegate:access.delegated"]).toBe("off")
})
