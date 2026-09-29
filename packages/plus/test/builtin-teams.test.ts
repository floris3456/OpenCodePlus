import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { validateAgentId } from "../src/agents/files.js"
import { createHandlers, createState } from "../src/index.js"
import { builtinTeams } from "../src/instructions/builtin-teams.js"
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
    expect(member.body).toContain("team_get_context")
    expect(member.body.indexOf("team_get_context")).toBeLessThan(member.body.length - 1)
  }
})

test("every Basic member preset's team tool rows are the old role ceiling", () => {
  const presets = plusTeamPresets.find((entry) => entry.id === "basic")?.members ?? []
  const input = presetInput({
    members: presets.map((member) => ({ id: member.id, team: "basic", preset: { kind: "member", team: "basic", id: member.id } })),
  })
  const ceilings: Record<string, readonly string[]> = {
    planner: ["delegate", "followup", "supersede", "stop", "finish", "status", "list", "wait", "get_context", "diff"],
    orchestrator: ["delegate", "followup", "integrate", "set_checks", "supersede", "stop", "finish", "status", "list", "wait", "get_context", "check", "diff"],
    implementer: ["checkpoint", "finish", "status", "get_context", "check", "diff"],
    reviewer: ["finish", "status", "get_context", "diff"],
    scout: ["finish", "status", "get_context", "diff"],
    "build-seat": teamTools,
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

  // Each member owns one "Delegate to" row per teammate plus the other-teams row.
  const team = builtinTeams.find((entry) => entry.name === "basic")
  if (team === undefined) throw new Error("missing basic")
  // No member may be silently absent: every shipped member owns its rows.
  for (const member of team.members)
    expect([member.id, rowIds(member.id).toSorted()]).toEqual([
      member.id,
      [...team.members.filter((peer) => peer.id !== member.id).map((peer) => `perm:team_delegate:to.${peer.id}`), "perm:team_delegate:to.other-teams"].toSorted(),
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

test("built-in prompts name search tools by their MCP-served ids", () => {
  const team = builtinTeams.find((entry) => entry.name === "basic")
  if (team === undefined) throw new Error("missing basic")
  const planner = team.members.find((member) => member.id === "planner")
  expect(planner?.body).toContain("search_tavily_search")
  expect(planner?.body).toContain("search_tavily_extract")

  for (const member of team.members) {
    expect(member.body).toContain("search_exa_code_search")
  }
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
    // No persona names: members are addressed by role, from delegationTargets.
    expect([member.id, member.body.match(/\b(gemini|opus|muse|spark|astra|sol|fable)-[a-z]+/g)]).toEqual([member.id, null])
    // Every team and search tool the text names is on for the member.
    const named = [...new Set(member.body.match(/\b(team_[a-z_]+|search_[a-z_]+)\b/g) ?? [])]
    expect([member.id, named.filter((tool) => states[`tool:${tool}`] !== "on")]).toEqual([member.id, []])
    // A member told it cannot edit has no file tool; one told it writes only
    // plan files edits nothing else.
    if (/You cannot edit/.test(member.body))
      expect([member.id, ["edit", "write", "patch"].filter((tool) => states[`tool:${tool}`] !== "off")]).toEqual([member.id, []])
    if (/write only (plan|Brief)/i.test(member.body))
      expect([member.id, states["perm:edit:allowed.*"], states["perm:edit:allowed.plans"]]).toEqual([member.id, "off", "on"])
    // One told it has no shell has none.
    if (/You have no shell|cannot run\s+commands/.test(member.body)) expect([member.id, states["tool:shell"]]).toEqual([member.id, "off"])
    // Only the build seat, the user's own chat, keeps the configuration, release,
    // monitor, browser and session tools and their teaching rows.
    const seatOnly = ["tool:instructions_set", "tool:release_request", "tool:monitor_query", "tool:browser_navigate", "tool:opencode_session_move", "system:opencodeplus", "skill:instructions-tools", "skill:opencodeplus-release", "skill:report", "tool:websearch"]
    const expected = member.id === "build-seat" ? "on" : "off"
    expect([member.id, seatOnly.filter((id) => states[id] !== expected)]).toEqual([member.id, []])
  }
})
