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
import { enable } from "../src/project.js"
import { allowedTeamTools, kindOf, teamTools } from "../src/teams/policy.js"
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

test("opencodeplus-team ships the ten team roles", () => {
  const team = builtinTeams.find((entry) => entry.name === "opencodeplus-team")
  expect(team).toBeDefined()
  expect(team?.members.map((member) => member.id).toSorted()).toEqual(
    [
      "astra-planner",
      "astra-reviewer",
      "fable-planner",
      "gemini-implementer",
      "muse-implementer",
      "opus-implementer",
      "opus-orchestrator",
      "scout",
      "sol-orchestrator",
      "spark-implementer",
    ].toSorted(),
  )
})

test("starter and review members carry no fields", () => {
  for (const name of ["starter", "review"]) {
    const team = builtinTeams.find((entry) => entry.name === name)
    expect(team).toBeDefined()
    for (const member of team?.members ?? []) expect(member.fields).toBeUndefined()
  }
})

// The member definition no longer carries what the member may do: the
// ceiling and the native answers are instructions rows produced from
// teams/policy.ts, and apply installs whatever they resolve to. The
// end-to-end proof that they reach /api/agent unchanged lives in
// test/teams/roles.test.ts.
test("opencodeplus-team members carry description and mode and no permissions", () => {
  const team = builtinTeams.find((entry) => entry.name === "opencodeplus-team")
  if (team === undefined) throw new Error("missing opencodeplus-team")
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

test("every member gets one ceiling row per out-of-ceiling tool and none for its own ceiling", () => {
  const team = builtinTeams.find((entry) => entry.name === "opencodeplus-team")
  if (team === undefined) throw new Error("missing opencodeplus-team")
  const items = teamPolicyItems(policyMembersOf(team.members.map((member) => member.id)))
  for (const member of team.members) {
    const resolved = kindOf(member.id)
    if (!resolved.ok) throw new Error(`unknown role ${member.id}`)
    const allowed = new Set<string>(allowedTeamTools(resolved.kind))
    const rows = items.filter((item) => item.agents?.includes(member.id) === true)
    expect(rows.length).toBeGreaterThan(0)
    for (const tool of teamTools) {
      const row = rows.find((item) => item.id === `perm:team_${tool}:role-ceiling`)
      if (allowed.has(tool)) {
        expect(row).toBeUndefined()
        continue
      }
      expect(row?.enabled).toBe(false)
      expect(row?.policy?.off).toEqual([
        {
          action: `team.${tool}`,
          resource: "*",
          effect: "deny",
          message: `team_${tool} is outside the ${resolved.kind} ceiling`,
        },
      ])
    }
    // Per-run edit scope is never a role property: it only exists while a run does.
    expect(rows.some((item) => item.runID !== undefined)).toBe(false)
  }
})

// The producer tests above prove the rows exist for a list of member ids; they
// cannot prove the live product ever computes that list. Once Plus installs a
// member, discovery reports it back as an ordinary unbacked defaults agent, and
// a resolver fed that echo drops every member and produces nothing. The
// snapshot is the first place that shows: it is what the Instructions tree, the
// Policy group and instructions.list all read.
test("the live snapshot carries each member's policy rows after the team is installed", async () => {
  const project = await tempProject()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "defaults", team: "opencodeplus-team", enabled: true }, throwingContext()),
  )
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const rowIds = (member: string) =>
    snapshot.items.filter((item) => item.kind === "perm" && item.agents?.includes(member) === true).map((item) => item.id)

  const implementer = rowIds("gemini-implementer")
  expect(implementer).toContain("perm:shell:team-role")
  expect(implementer).toContain("perm:read:team-role")
  expect(implementer).toContain("perm:team_delegate:role-ceiling")
  expect(implementer).toContain("perm:search:team-tavily")

  const orchestrator = rowIds("sol-orchestrator")
  expect(orchestrator).toContain("perm:shell:team-role")
  expect(orchestrator).toContain("perm:team_checkpoint:role-ceiling")

  const planner = rowIds("fable-planner")
  expect(planner).toContain("perm:shell:team-role")
  expect(planner).toContain("perm:team_delegate:team-role")

  // No member may be silently absent: every shipped role owns its rows.
  const team = builtinTeams.find((entry) => entry.name === "opencodeplus-team")
  if (team === undefined) throw new Error("missing opencodeplus-team")
  for (const member of team.members) expect(rowIds(member.id)).toContain("perm:shell:team-role")
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
  const team = builtinTeams.find((entry) => entry.name === "opencodeplus-team")
  if (team === undefined) throw new Error("missing opencodeplus-team")
  const planner = team.members.find((member) => member.id === "fable-planner")
  expect(planner?.body).toContain("search_tavily_search")
  expect(planner?.body).toContain("search_tavily_extract")

  for (const member of team.members) {
    expect(member.body).toContain("search_exa_code_search")
  }
})
