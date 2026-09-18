import { expect, test } from "bun:test"
import { validateAgentId } from "../src/agents/files.js"
import { builtinTeams } from "../src/instructions/builtin-teams.js"
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

test("opencodeplus-team ships the nine team roles", () => {
  const team = builtinTeams.find((entry) => entry.name === "opencodeplus-team")
  expect(team).toBeDefined()
  expect(team?.members.map((member) => member.id).toSorted()).toEqual(
    [
      "astra-planner",
      "astra-reviewer",
      "fable-planner",
      "gemini-implementer",
      "muse-implementer",
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

test("opencodeplus-team members carry description, mode, and ceiling plus static denies", () => {
  const team = builtinTeams.find((entry) => entry.name === "opencodeplus-team")
  if (team === undefined) throw new Error("missing opencodeplus-team")
  for (const member of team.members) {
    const fields = member.fields
    expect(fields).toBeDefined()
    expect(fields?.description?.trim().length).toBeGreaterThan(0)
    expect(fields?.mode).toBe("primary")
    const permissions = fields?.permissions ?? []
    // No per-run edit scope here; a later hook owns assigned-path allows.
    expect(permissions.some((rule) => rule.action === "edit" && rule.effect === "allow")).toBe(false)
    const resolved = kindOf(member.id)
    if (!resolved.ok) throw new Error(`unknown role ${member.id}`)
    const allowed = new Set<string>(allowedTeamTools(resolved.kind))
    for (const tool of teamTools) {
      const denied = permissions.some((rule) => rule.action === `team.${tool}` && rule.resource === "*" && rule.effect === "deny")
      if (allowed.has(tool)) expect(denied).toBe(false)
      else expect(denied).toBe(true)
    }
    // Bodies compose shared first, then the role block.
    expect(member.body).toContain("team_get_context")
    expect(member.body.indexOf("team_get_context")).toBeLessThan(member.body.length - 1)
  }
})
