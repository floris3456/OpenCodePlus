import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { validateAgentId } from "../src/agents/files.js"
import { createHandlers, createState } from "../src/index.js"
import { Schema } from "effect"
import { basicBody, builtinTeams } from "../src/instructions/builtin-teams.js"
import { derive } from "../src/instructions/sections.js"
import { applyRequires, gatedSections, mentionWarnings } from "../src/instructions/requires.js"
import { guidanceContent } from "../src/instructions/guidance.js"
import * as TeamSchema from "../src/teams/schema.js"
import { policyMembersOf, teamPolicyItems } from "../src/instructions/team-policy-rows.js"
import { validateTeamName } from "../src/instructions/teams.js"
import { teamTools } from "../src/teams/policy.js"
import { plusTeamPresets } from "../src/instructions/presets.js"
import { presetInput, resolvedStates } from "./teams/preset-table.js"
import { fullContext } from "./harness.js"

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

async function tempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-builtin-teams-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  return path.join(root, "project")
}

function throwingContext(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      throw data === undefined ? { type, message } : { type, message, data }
    },
  }
}

test("shipped registry is well formed", () => {
  const names = new Set<string>()
  for (const team of builtinTeams) {
    const named = validateTeamName(team.name)
    expect(named.ok).toBe(true)
    expect(names.has(team.name)).toBe(false)
    names.add(team.name)
    const ids = new Set<string>()
    for (const member of team.members) {
      const validated = validateAgentId(member.id)
      expect(validated.ok).toBe(true)
      expect(ids.has(member.id)).toBe(false)
      ids.add(member.id)
      expect(member.body.trim().length).toBeGreaterThan(0)
    }
  }
})

test("basic ships the six former Plus agent presets as its members", () => {
  const team = builtinTeams.find((entry) => entry.name === "basic")
  expect(team).toBeDefined()
  expect(team?.label).toBe("Basic")
  expect(team?.members.map((member) => member.id).toSorted()).toEqual(
    ["build-seat", "implementer", "orchestrator", "planner", "reviewer", "scout"].toSorted(),
  )
})

// The member definition does not carry what the member may do: that is its
// rows, which its self-contained member preset sets, and apply installs
// whatever they resolve to. The end-to-end proof that they reach /api/agent
// unchanged lives in test/teams/roles.test.ts.
test("basic members carry description and mode and no permissions", () => {
  const team = builtinTeams.find((entry) => entry.name === "basic")
  if (team === undefined) throw new Error("missing basic")
  for (const member of team.members) {
    const fields = member.fields
    expect(fields).toBeDefined()
    expect(fields?.description?.trim().length).toBeGreaterThan(0)
    expect(fields?.mode).toBe("primary")
    expect(fields?.permissions).toEqual([])
    // Bodies compose shared first, then the role block.
    expect(member.body.startsWith("# Team member\n")).toBe(true)
  }
})

test("every Basic member preset's team tool rows are the old role ceiling", () => {
  const presets = plusTeamPresets.find((entry) => entry.id === "basic")?.members ?? []
  const input = presetInput({
    members: presets.map((member) => ({ id: member.id, team: "basic", preset: { kind: "member", team: "basic", id: member.id } })),
  })
  const ceilings: Record<string, readonly string[]> = {
    // A planner commits its plan file when delegated, and in the user's chat
    // lands what its orchestrator reports done; workers address only their own
    // run, which get_context describes (no status); a scout changes nothing (no
    // diff); the build seat, never delegated to, finishes nothing.
    planner: ["delegate", "followup", "integrate", "supersede", "stop", "finish", "checkpoint", "status", "list", "get_context", "diff"],
    orchestrator: ["delegate", "followup", "integrate", "set_checks", "supersede", "stop", "finish", "status", "list", "get_context", "check", "diff"],
    implementer: ["checkpoint", "finish", "get_context", "check", "diff"],
    reviewer: ["finish", "get_context", "diff"],
    scout: ["finish", "get_context"],
    "build-seat": teamTools.filter((tool) => tool !== "finish"),
  }
  for (const member of presets) {
    const states = resolvedStates(input, member.id)
    const open: string[] = teamTools.filter((tool) => states[`tool:team_${tool}`] === "on")
    expect([member.id, open.toSorted()]).toEqual([member.id, [...(ceilings[member.id] ?? [])].toSorted()])
  }
  // Per-run edit scope is never a member property: it only exists while a run does.
  expect(teamPolicyItems(policyMembersOf(presets.map((member) => member.id))).some((item) => item.runID !== undefined)).toBe(false)
})

// The producer tests above prove the rows exist for a list of member ids; they
// cannot prove the live product ever computes that list. Once Plus installs a
// member, discovery reports it back as an ordinary unbacked defaults agent, and
// a resolver fed that echo drops every member and produces nothing. The
// snapshot is the first place that shows: it is what the Instructions tree, the
// Policy group and instructions.list all read.
// The shipped team is no Defaults team any more (DESIGN §2): it is the Plus
// team preset `basic` a project team is created from.
test("the live snapshot carries each member's Delegate to rows after the team is installed", async () => {
  const project = await tempProject()
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "basic", preset: "basic" }, throwingContext()))
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "basic", enabled: true }, throwingContext()))
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const rowIds = (member: string) =>
    snapshot.items.filter((item) => item.kind === "perm" && item.agents?.includes(member) === true).map((item) => item.id)

  // Each member owns one "Delegate to" row per member of its team (its own
  // included) plus the other-teams row.
  const team = builtinTeams.find((entry) => entry.name === "basic")
  if (team === undefined) throw new Error("missing basic")
  // No member may be silently absent: every shipped member owns its rows.
  for (const member of team.members)
    expect([member.id, rowIds(member.id).toSorted()]).toEqual([
      member.id,
      [...team.members.map((peer) => `perm:team_delegate:to.${peer.id}`), "perm:team_delegate:to.other-teams"].toSorted(),
    ])
})

test("no built-in prompt names a tool that left the namespace", () => {
  const removed = [
    "team_review",
    "team_shutdown_request",
    "team_resume",
    "team_prepare",
    "team_plan_handoff",
    "team_metrics",
    "exa_code_search",
    "tavily_search",
    "tavily_extract",
    "plan_handoff",
  ]
  for (const team of builtinTeams) {
    for (const member of team.members) {
      for (const name of removed) {
        const bare = new RegExp(`(?<![a-zA-Z0-9_])${name}(?![a-zA-Z0-9_])`)
        expect(bare.test(member.body)).toBe(false)
      }
    }
  }
})

// Search tools are named in the Tools and rules row by their MCP-served ids,
// each in a section that depends on that tool, so a member reads the line
// exactly while it has the tool; no role text names them.
test("search tools are named in Tools and rules, each in a section that depends on it", () => {
  const team = builtinTeams.find((entry) => entry.name === "basic")
  if (team === undefined) throw new Error("missing basic")
  for (const tool of ["search_exa_code_search", "search_tavily_search", "search_tavily_extract"]) {
    // The innermost section that names it (the whole-row heading names every one).
    const section = gatedSections(guidanceContent)
      .filter((entry) => guidanceContent.slice(entry.start, entry.end).includes(tool))
      .toSorted((left, right) => right.depth - left.depth)[0]
    expect([tool, section?.requires]).toEqual([tool, [{ id: `tool:${tool}`, on: true }]])
  }
  for (const member of team.members) expect([member.id, member.body.match(/search_[a-z_]+/g)]).toEqual([member.id, null])
})

// A role line that names a tool the member lacks, or a member that has a tool
// its role forbids, costs a refused call or an off-role action. Each Basic
// member's role text and its member preset's rows must agree.
test("every Basic role names only tools its member preset ships on, and forbids none it ships", () => {
  const team = builtinTeams.find((entry) => entry.name === "basic")
  if (team === undefined) throw new Error("missing basic")
  const input = presetInput({
    members: team.members.map((member) => ({ id: member.id, team: "basic", preset: { kind: "member", team: "basic", id: member.id } })),
  })
  for (const member of team.members) {
    const states = resolvedStates(input, member.id)
    // What the member reads: sections that depend on a row it lacks are out.
    const read = applyRequires(member.body, (id) => (states[id] === undefined ? undefined : states[id] === "on"))
    // No persona names: members are addressed by role, from delegationTargets.
    expect([member.id, member.body.match(/\b(gemini|opus|muse|spark|astra|sol|fable)-[a-z]+/g)]).toEqual([member.id, null])
    // No section names a tool or skill the member has off without depending on it.
    const names = new Map(Object.keys(states).filter((id) => id.startsWith("tool:") || id.startsWith("skill:")).map((id) => [id.slice(id.indexOf(":") + 1), id]))
    expect([member.id, mentionWarnings(member.body, names, (id) => (states[id] === undefined ? undefined : states[id] === "on"))]).toEqual([member.id, []])
    // Every team and search tool the text it reads names is on for the member.
    const named = [...new Set(read.match(/\b(team_[a-z_]+|search_[a-z_]+)\b/g) ?? [])]
    expect([member.id, named.filter((tool) => states[`tool:${tool}`] !== "on")]).toEqual([member.id, []])
    // Role text says what to do, never what the member lacks: its tool list
    // shows what it has and a refusal says what it may not, and a claim like
    // "you have no shell" stays wrong once someone turns that row on.
    expect([member.id, member.body.match(/\b(you have no|you cannot (edit|run)|cannot run (commands|checks)|no shell)\b/gi)]).toEqual([member.id, null])
    // What a role says about the shell reaches only a member that has one.
    for (const section of member.body.split(/^(?=## )/m).filter((part) => /\bshell\b/i.test(part)))
      expect([member.id, section.includes("<!-- requires: tool:shell -->")]).toEqual([member.id, true])
    // Only the build seat, the user's own chat, keeps the configuration, release,
    // monitor, browser and session tools and their teaching rows.
    const seatOnly = ["tool:instructions_set", "tool:release_request", "tool:monitor_query", "tool:browser_navigate", "tool:opencode_session_move", "system:opencodeplus", "skill:instructions-tools", "skill:opencodeplus-release", "skill:report", "tool:websearch"]
    const expected = member.id === "build-seat" ? "on" : "off"
    expect([member.id, seatOnly.filter((id) => states[id] !== expected)]).toEqual([member.id, []])
  }
})


// Each part of a Basic body is its own section row in the Instructions tree
// (derived from its headings), so a level can turn off or rewrite one part
// without copying the rest: what every member shares, how a delegator writes
// Briefs, and the role itself.
test("every Basic body splits into Team member, Delegating and role sections", () => {
  const ids = (member: Parameters<typeof basicBody>[0]) => derive(basicBody(member), "Role/persona").sections.map((section) => section.id)
  const shared = ["team-member", "team-member/runs-and-messages", "team-member/working", "team-member/reporting", "team-member/safety"]
  const delegating = ["delegating", "delegating/briefs", "delegating/integration-checks"]
  expect(ids("implementer")).toEqual([...shared, "implementer", "implementer/task", "implementer/checks", "implementer/outside-your-scope"])
  expect(ids("reviewer")).toEqual([...shared, "reviewer", "reviewer/the-change", "reviewer/judging", "reviewer/findings"])
  expect(ids("scout")).toEqual([...shared, "scout", "scout/task", "scout/answer"])
  expect(ids("planner")).toEqual([...shared, ...delegating, "planner", "planner/the-plan", "planner/questions", "planner/hand-off"])
  expect(ids("orchestrator")).toEqual([
    ...shared,
    ...delegating,
    "orchestrator",
    "orchestrator/ownership",
    "orchestrator/shell",
    "orchestrator/splitting-the-work",
    "orchestrator/following-children",
    "orchestrator/review-and-finish",
  ])
  // The build seat is never delegated to: no Reporting section.
  expect(ids("build-seat")).toEqual([
    ...shared.filter((id) => id !== "team-member/reporting"),
    ...delegating,
    "build-seat",
    "build-seat/role",
    "build-seat/subagents",
    "build-seat/choosing-a-member",
    "build-seat/following-runs",
  ])
})

// What a Brief to a target must carry, whether it takes followups and what
// done needs are rows: the tools' descriptions list them per request from those
// rows (permission-enforce.test.ts), so no body restates one and none goes
// stale when a level changes the row.
test("a Basic body states no Brief rule, followup rule or done requirement a row decides", () => {
  for (const member of ["planner", "orchestrator", "implementer", "reviewer", "scout", "build-seat"] as const)
    expect([member, basicBody(member).match(/Required:|needs a reason|needs scope\.paths|plan files only|takes no (followups|corrections)|asks the user to confirm|must pass for|done needs/gi)]).toEqual([member, null])
  for (const worker of ["implementer", "reviewer", "scout"] as const) expect(basicBody(worker)).not.toContain("# Delegating")
})

// How a value must look rides with the tool, so a call is right the first
// time instead of being learned from a refusal: every field a member fills
// carries a description, on the field or on its non-null branch.
test("every field of every team tool input carries a description", () => {
  const inputs = {
    team_delegate: TeamSchema.Brief,
    team_finish: TeamSchema.Report,
    team_followup: TeamSchema.FollowupInput,
    team_integrate: TeamSchema.IntegrateInput,
    team_checkpoint: TeamSchema.CheckpointInput,
    team_set_checks: TeamSchema.SetChecksInput,
    team_supersede: TeamSchema.SupersedeInput,
    team_stop: TeamSchema.StopInput,
    team_status: TeamSchema.StatusInput,
    team_diff: TeamSchema.DiffInput,
    team_list: TeamSchema.ListInput,
    team_check: TeamSchema.CheckInput,
  }
  type Node = { description?: string; anyOf?: Node[]; properties?: Record<string, Node> }
  const described = (node: Node) => node.description !== undefined || (node.anyOf ?? []).some((branch) => branch.description !== undefined)
  const missing: string[] = []
  for (const [tool, input] of Object.entries(inputs)) {
    const schema = Schema.toJsonSchemaDocument(TeamSchema.nullTolerant(input as Schema.Top)).schema as Node
    for (const [field, node] of Object.entries(schema.properties ?? {})) if (!described(node)) missing.push(`${tool}.${field}`)
  }
  expect(missing).toEqual([])
})
