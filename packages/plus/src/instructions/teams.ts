import fs from "node:fs/promises"
import path from "node:path"
import { idFromPath } from "../agents/files.js"
import type { AgentSource } from "./model.js"
import { globalTeamsPath, projectTeamsPath } from "./paths.js"

// Teams are named sets of agent files toggled as a unit. Project teams live
// under <projectDir>/.opencodeplus/teams/<team>/, global teams under
// <globalConfigDir()>/opencodeplus/teams/<team>/; agent files are
// <team>/<agentId>.md in the same frontmatter+body format files.ts writes.
// A team's storage level remains project|global only; the TUI additionally
// surfaces an always-empty Teams group under Defaults as a creation entry
// point. This file is the record shape the store follow-up will persist
// (with a V2Team schema mirroring V2Customization), plus validation,
// discovery, and membership resolution.
export type TeamLevel = "project" | "global"

// The `type` discriminator is not in the brief's shorthand; the store's v2
// union style (V2Customization/V2Split) needs it, so it is part of the shape.
export interface TeamRecord {
  readonly type: "team"
  readonly level: TeamLevel
  readonly team: string
  readonly enabled: boolean
  readonly updated: string
}

export interface TeamAgent {
  readonly id: string
  readonly path: string
}

export interface DiscoveredTeam {
  readonly level: TeamLevel
  readonly team: string
  readonly path: string
  readonly agents: readonly TeamAgent[]
}

export interface TeamContribution {
  readonly team: string
  readonly level: TeamLevel
  readonly enabled: boolean
  // On-disk members, listed whether or not the team is enabled. Only an
  // enabled team contributes them to the core-visible set.
  readonly agents: readonly TeamAgent[]
}

export interface ResolvedTeams {
  readonly teams: readonly TeamContribution[]
  // Winning team copy per agent id: core-visible team agents.
  readonly agents: readonly AgentSource[]
}

// Team names are single path segments, mirroring validateAgentId's
// confinement style: nothing that could escape the teams directory passes.
export function validateTeamName(raw: string): { ok: true; team: string } | { ok: false; reason: string } {
  const team = raw.trim()
  if (team.length === 0) return { ok: false, reason: "Team name cannot be empty" }
  if (team.includes("\0")) return { ok: false, reason: `Invalid team name "${team}": null bytes are not allowed` }
  if (path.isAbsolute(team)) return { ok: false, reason: `Invalid team name "${team}": absolute paths are not allowed` }
  if (team.includes("\\") || team.includes("/"))
    return { ok: false, reason: `Invalid team name "${team}": team names are single path segments (no slashes)` }
  if (team === ".") return { ok: false, reason: `Invalid team name "${team}": "." is not allowed` }
  // Mirrors resolveInstructionPath: any ".." is rejected even though team
  // names are single segments, so nothing resembling parent traversal passes.
  if (team.includes("..")) return { ok: false, reason: `Invalid team name "${team}": ".." is not allowed` }
  return { ok: true, team }
}

// Every immediate subdirectory is a team, including one with no agent files.
// A missing teams directory means no teams, not an error.
export async function discoverTeams(level: TeamLevel, projectDirectory: string): Promise<DiscoveredTeam[]> {
  const root = level === "project" ? projectTeamsPath(projectDirectory) : globalTeamsPath()
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  return Promise.all(names.toSorted().map((team) => readTeam(level, root, team)))
}

// No record at all means DISABLED. First matching (level, team) wins,
// mirroring model.ts `at()` taking the first matching record.
export function isTeamEnabled(records: readonly TeamRecord[], level: TeamLevel, team: string): boolean {
  return records.find((record) => record.level === level && record.team === team)?.enabled ?? false
}

// Reports each discovered team's enabled flag with its on-disk members, plus
// the winning team copy per agent id. `regular` is the existing non-team
// agent sources; never feed team-derived sources back in.
export function resolveTeams(
  discovered: readonly DiscoveredTeam[],
  records: readonly TeamRecord[],
  regular: readonly AgentSource[],
): ResolvedTeams {
  const teams = discovered.map(
    (team): TeamContribution => ({
      team: team.team,
      level: team.level,
      enabled: isTeamEnabled(records, team.level, team.team),
      agents: team.agents,
    }),
  )
  return { teams, agents: visibleAgents(teams, regular) }
}

async function readTeam(level: TeamLevel, root: string, team: string): Promise<DiscoveredTeam> {
  const directory = confinedTeamPath(root, team)
  const files = await scanMarkdown(directory)
  const agents = files
    .map((file): TeamAgent => ({ id: idFromPath(directory, file), path: file }))
    .filter((agent) => agent.id.length > 0)
    .toSorted(compareAgentIds)
  return { level, team, path: directory, agents }
}

// Same shape as files.ts confinedPath: validated names can never escape, so
// this only fires on unvalidated input and fails closed.
function confinedTeamPath(root: string, team: string): string {
  const base = path.resolve(root)
  const resolved = path.resolve(base, team)
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) throw new Error(`Invalid team name "${team}"`)
  return resolved
}

// Recursive *.md scan mirroring discover.ts scanMarkdown: nested agent ids
// (sub/agent.md -> "sub/agent") work the same as regular agents.
async function scanMarkdown(directory: string): Promise<string[]> {
  const entries = await readDirectory(directory)
  const nested = await Promise.all(
    entries.map((entry) => (entry.directory ? scanMarkdown(entry.path) : Promise.resolve([entry.path]))),
  )
  return nested.flat().toSorted()
}

interface DirectoryEntry {
  readonly path: string
  readonly directory: boolean
}

async function readDirectory(directory: string): Promise<DirectoryEntry[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  return entries.flatMap((entry): DirectoryEntry[] => {
    if (entry.isDirectory()) return [{ path: path.join(directory, entry.name), directory: true }]
    if (entry.isFile() && entry.name.endsWith(".md"))
      return [{ path: path.join(directory, entry.name), directory: false }]
    return []
  })
}

// Collision rule extends the model.ts chain (project over global over
// defaults) to team copies: level rank decides first, so a project team copy
// outranks a global regular but never a project or same-level regular (ties
// go to the established non-team identity, and defaults templates always
// lose). Among team copies the project level wins, with same-level ties going
// to the lexicographically smallest team name for determinism.
function visibleAgents(teams: readonly TeamContribution[], regular: readonly AgentSource[]): AgentSource[] {
  const regularRank = new Map<string, number>()
  regular.forEach((agent) => {
    const rank = rankOf(agent.scope)
    if ((regularRank.get(agent.id) ?? Number.MAX_SAFE_INTEGER) > rank) regularRank.set(agent.id, rank)
  })
  const winners = new Map<string, AgentSource>()
  const copies = teams
    .filter((team) => team.enabled)
    .flatMap((team) => team.agents.map((agent) => ({ team, agent })))
    .toSorted(compareCopies)
  copies.forEach(({ team, agent }) => {
    if (winners.has(agent.id)) return
    const shadow = regularRank.get(agent.id)
    if (shadow !== undefined && shadow <= rankOf(team.level)) return
    winners.set(agent.id, { id: agent.id, scope: team.level, path: agent.path, team: team.team })
  })
  return [...winners.values()].toSorted(compareAgentIds)
}

function compareAgentIds(left: { id: string }, right: { id: string }): number {
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
}

function rankOf(scope: AgentSource["scope"]): number {
  if (scope === "project") return 0
  if (scope === "global") return 1
  return 2
}

function compareCopies(
  left: { team: TeamContribution; agent: TeamAgent },
  right: { team: TeamContribution; agent: TeamAgent },
): number {
  const rank = rankOf(left.team.level) - rankOf(right.team.level)
  if (rank !== 0) return rank
  if (left.team.team < right.team.team) return -1
  if (left.team.team > right.team.team) return 1
  if (left.agent.id < right.agent.id) return -1
  if (left.agent.id > right.agent.id) return 1
  return 0
}
