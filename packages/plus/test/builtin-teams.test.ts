import { expect, test } from "bun:test"
import { validateAgentId } from "../src/agents/files.js"
import { builtinTeams } from "../src/instructions/builtin-teams.js"
import { validateTeamName } from "../src/instructions/teams.js"

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
