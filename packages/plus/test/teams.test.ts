import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatMarkdown } from "../src/agents/files.js"
import type { AgentSource } from "../src/instructions/model.js"
import { globalTeamsPath, projectTeamsPath } from "../src/instructions/paths.js"
import {
  discoverTeams,
  isTeamEnabled,
  resolveTeams,
  validateTeamName,
  type TeamRecord,
} from "../src/instructions/teams.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-teams-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

async function writeTeamAgent(teamDir: string, id: string, prompt = "role"): Promise<string> {
  const target = path.join(teamDir, `${id}.md`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, formatMarkdown({ description: `${path.basename(teamDir)}/${id}` }, prompt))
  return target
}

function record(team: string, enabled: boolean, level: TeamRecord["level"] = "project"): TeamRecord {
  return { type: "team", level, team, enabled, updated: UPDATED }
}

function regular(id: string, scope: AgentSource["scope"]): AgentSource {
  return { id, scope }
}

test("missing teams directory means no teams, not an error", async () => {
  const { project } = await tempRoot()
  expect(await discoverTeams("project", project)).toEqual([])
  expect(await discoverTeams("global", project)).toEqual([])
})

test("paths mirror the records layout", async () => {
  const { project } = await tempRoot()
  expect(projectTeamsPath(project)).toBe(path.join(project, ".opencodeplus", "teams"))
  expect(globalTeamsPath()).toBe(path.join(process.env.OPENCODE_CONFIG_DIR ?? "", "opencodeplus", "teams"))
})

test("a team with several agents lists ids and file paths", async () => {
  const { project } = await tempRoot()
  const root = projectTeamsPath(project)
  for (const id of ["alpha", "nested/beta"]) await writeTeamAgent(path.join(root, "crew"), id)
  await Bun.write(path.join(root, "crew", "notes.txt"), "ignored")
  const teams = await discoverTeams("project", project)
  expect(teams.length).toBe(1)
  expect(teams[0]?.team).toBe("crew")
  expect(teams[0]?.agents.map((agent) => agent.id)).toEqual(["alpha", "nested/beta"])
  expect(teams[0]?.agents.every((agent) => agent.path.endsWith(".md"))).toBe(true)
})

test("a team with no agent files is still a team", async () => {
  const { project } = await tempRoot()
  await fs.mkdir(path.join(projectTeamsPath(project), "empty"), { recursive: true })
  const teams = await discoverTeams("project", project)
  expect(teams.map((team) => team.team)).toEqual(["empty"])
  expect(teams[0]?.agents).toEqual([])
})

test("global teams resolve under OPENCODE_CONFIG_DIR", async () => {
  const { project } = await tempRoot()
  await writeTeamAgent(path.join(globalTeamsPath(), "ops"), "watcher")
  const teams = await discoverTeams("global", project)
  expect(teams.map((team) => team.team)).toEqual(["ops"])
  expect(teams[0]?.agents.map((agent) => agent.id)).toEqual(["watcher"])
})

test("no record means disabled; explicit records decide", async () => {
  const { project } = await tempRoot()
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha")
  const discovered = await discoverTeams("project", project)
  expect(isTeamEnabled([], "project", "crew")).toBe(false)
  expect(resolveTeams(discovered, [], []).agents).toEqual([])
  expect(resolveTeams(discovered, [record("crew", true)], []).teams[0]).toMatchObject({ team: "crew", enabled: true })
  expect(resolveTeams(discovered, [record("crew", false)], []).agents).toEqual([])
  const resolved = resolveTeams(discovered, [record("crew", true)], [])
  expect(resolved.agents).toMatchObject([{ id: "alpha", scope: "project", team: "crew" }])
})

test("same agent in two enabled teams: project level wins, same-level ties go to the first team name", async () => {
  const { project } = await tempRoot()
  const root = projectTeamsPath(project)
  const alphaA = await writeTeamAgent(path.join(root, "aaa"), "shared")
  const alphaB = await writeTeamAgent(path.join(root, "zzz"), "shared")
  const projectTeams = await discoverTeams("project", project)
  const globalRoot = globalTeamsPath()
  await writeTeamAgent(path.join(globalRoot, "ops"), "shared")
  const globalTeams = await discoverTeams("global", project)
  const discovered = [...projectTeams, ...globalTeams]
  const records = [record("aaa", true), record("zzz", true), record("ops", true, "global")]
  const resolved = resolveTeams(discovered, records, [])
  const shared = resolved.agents.filter((agent) => agent.id === "shared")
  expect(shared.length).toBe(1)
  // Project outranks global.
  expect(shared[0]?.scope).toBe("project")
  // Same level: lexicographically smallest team wins deterministically.
  const projectOnly = resolveTeams(projectTeams, records, [])
  expect(projectOnly.agents.find((agent) => agent.id === "shared")?.team).toBe("aaa")
  expect([alphaA, alphaB].some((candidate) => candidate === shared[0]?.path)).toBe(true)
})

test("team copy vs regular agent follows project-over-global-over-defaults", async () => {
  const { project } = await tempRoot()
  const root = projectTeamsPath(project)
  const teamPath = await writeTeamAgent(path.join(root, "crew"), "alpha")
  const globalRoot = globalTeamsPath()
  await writeTeamAgent(path.join(globalRoot, "ops"), "beta")
  const discovered = [...(await discoverTeams("project", project)), ...(await discoverTeams("global", project))]
  // Project team copy beats a global regular.
  const beatsGlobal = resolveTeams(discovered, [record("crew", true), record("ops", true, "global")], [
    regular("alpha", "global"),
  ])
  expect(beatsGlobal.agents.find((agent) => agent.id === "alpha")).toMatchObject({ scope: "project", path: teamPath })
  // A same-level regular keeps its identity: ties go to the established agent.
  const losesTie = resolveTeams(discovered, [record("crew", true)], [regular("alpha", "project")])
  expect(losesTie.agents.some((agent) => agent.id === "alpha" && agent.team !== undefined)).toBe(false)
  // A project regular beats a global team copy.
  const projectWins = resolveTeams(discovered, [record("ops", true, "global")], [regular("beta", "project")])
  expect(projectWins.agents.some((agent) => agent.id === "beta")).toBe(false)
  // Team copies always beat defaults templates.
  const beatsDefaults = resolveTeams(discovered, [record("crew", true)], [regular("alpha", "defaults")])
  expect(beatsDefaults.agents.find((agent) => agent.id === "alpha")).toMatchObject({ team: "crew" })
})

test("validateTeamName accepts plain names and rejects escapes", () => {
  expect(validateTeamName("crew")).toEqual({ ok: true, team: "crew" })
  expect(validateTeamName("  crew  ")).toEqual({ ok: true, team: "crew" })
  expect(validateTeamName("crew-2")).toEqual({ ok: true, team: "crew-2" })
  for (const raw of ["", "   ", "..", ".", "a/b", "a\\b", "/abs", "a\0b", "a..b", "a..b/../c"]) {
    const result = validateTeamName(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
  }
})
