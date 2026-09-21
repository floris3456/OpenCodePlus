import { expect, test } from "bun:test"
import { validateAgentId } from "../src/agents/files.js"
import { builtinTeams } from "../src/instructions/builtin-teams.js"
import { policyMembersOf, teamPolicyItems } from "../src/instructions/team-policy-rows.js"
import { validateTeamName } from "../src/instructions/teams.js"
import { allowedTeamTools, kindOf, teamTools } from "../src/teams/policy.js"

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
      expect(row?.policy?.off).toEqual([{ action: `team.${tool}`, resource: "*", effect: "deny" }])
    }
    // Per-run edit scope is never a role property: it only exists while a run does.
    expect(rows.some((item) => item.runID !== undefined)).toBe(false)
  }
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
      for (const name of removed) expect(member.body).not.toContain(name)
    }
  }
})
