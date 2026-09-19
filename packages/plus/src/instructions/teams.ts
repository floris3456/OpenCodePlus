import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { idFromPath } from "../agents/files.js"
import type { AgentSource } from "./model.js"
import { builtinTeams, type BuiltinTeam } from "./builtin-teams.js"
import { globalConfigDir, globalTeamsPath, projectTeamsPath } from "./paths.js"
import { agentBody } from "./discover.js"

// Defaults teams are shipped source data from `builtin-teams.ts`, editable
// through an on-disk overlay: `<globalConfigDir>/opencodeplus/teams-defaults/<team>/<id>.md`.
// `discoverBuiltinTeams` merges the overlay (same id REPLACES, new id is
// APPENDED, still `level: "defaults"` with `body` from the file and `path`
// set). Their enablement is a `TeamRecord` at level `defaults` routed to the
// global store, and their members resolve below project and global in the
// precedence chain.
export type TeamLevel = "project" | "global" | "defaults"

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
  // On-disk member file; absent for built-ins, which carry `body` instead.
  // Never invent a path that does not exist.
  readonly path?: string
  // Built-in member markdown body; absent for on-disk members, which read it
  // from `path`.
  readonly body?: string
}

export interface DiscoveredTeam {
  readonly level: TeamLevel
  readonly team: string
  // On-disk team directory; absent for built-ins, which have no filesystem
  // path and are never written.
  readonly path?: string
  readonly agents: readonly TeamAgent[]
}

export interface TeamContribution {
  readonly team: string
  readonly level: TeamLevel
  readonly enabled: boolean
  // Members, listed whether or not the team is enabled. Only an enabled team
  // contributes them to the core-visible set. Built-in members carry `body`
  // with no `path`; on-disk members carry `path` with no `body`.
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

// On-disk overlay root for editable Defaults teams:
// `<globalConfigDir>/opencodeplus/teams-defaults`. One subdirectory per team.
export function globalDefaultsTeamsPath(configDir: string = globalConfigDir()): string {
  return path.join(configDir, "opencodeplus", "teams-defaults")
}

export function defaultsOverlayTeamDir(team: string, configDir: string = globalConfigDir()): string {
  return path.join(globalDefaultsTeamsPath(configDir), team)
}

// Every immediate subdirectory is a team, including one with no agent files.
// A missing teams directory means no teams, not an error. The `defaults`
// tier comes from the built-in registry merged with the on-disk overlay.
// The registry is injectable so behaviour tests supply fixtures
// instead of coupling to the shipped roster.
export async function discoverTeams(
  level: TeamLevel,
  projectDirectory: string,
  registry: readonly BuiltinTeam[] = builtinTeams,
): Promise<DiscoveredTeam[]> {
  if (level === "defaults") return discoverBuiltinTeams(registry)
  const root = level === "project" ? projectTeamsPath(projectDirectory) : globalTeamsPath()
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  return Promise.all(names.toSorted().map((team) => readTeam(level, root, team)))
}

// Built-ins as defaults-tier teams, sorted by name with members sorted by
// id. Merges the on-disk overlay synchronously so the signature stays sync
// for existing callers: a member file with the same id REPLACES the built-in
// member, a new id is APPENDED. Overlay members stay `level: "defaults"`
// with `body` read from the file and `path` set so the installer reads it.
export function discoverBuiltinTeams(registry: readonly BuiltinTeam[] = builtinTeams): DiscoveredTeam[] {
  const base = new Map<string, { members: Map<string, TeamAgent>; order: number }>()
  registry.forEach((team, index) => {
    const members = new Map<string, TeamAgent>()
    for (const member of team.members) members.set(member.id, { id: member.id, body: member.body })
    base.set(team.name, { members, order: index })
  })
  const overlayRoot = globalDefaultsTeamsPath()
  const overlayNames = listDirectoriesSync(overlayRoot)
  for (const name of overlayNames) {
    const teamDir = path.join(overlayRoot, name)
    const files = scanMarkdownSync(teamDir)
    const entry = base.get(name) ?? { members: new Map<string, TeamAgent>(), order: Number.MAX_SAFE_INTEGER }
    if (!base.has(name)) base.set(name, entry)
    for (const file of files) {
      const id = idFromPath(teamDir, file)
      if (id.length === 0) continue
      const text = readFileSync(file)
      if (text === undefined) continue
      entry.members.set(id, { id, body: agentBody(text), path: file })
    }
  }
  return [...base.entries()]
    .map(
      ([name]): DiscoveredTeam => ({
        level: "defaults",
        team: name,
        agents: [...base.get(name)!.members.values()].toSorted(compareAgentIds),
      }),
    )
    .toSorted((left, right) => (left.team < right.team ? -1 : left.team > right.team ? 1 : 0))
}

function listDirectoriesSync(root: string): string[] {
  let entries: fsSync.Dirent[]
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
}

function scanMarkdownSync(directory: string): string[] {
  const entries = readDirectorySync(directory)
  return entries.flatMap((entry) => (entry.directory ? scanMarkdownSync(entry.path) : [entry.path])).toSorted()
}

function readDirectorySync(directory: string): DirectoryEntry[] {
  let entries: fsSync.Dirent[]
  try {
    entries = fsSync.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry): DirectoryEntry[] => {
    if (entry.isDirectory()) return [{ path: path.join(directory, entry.name), directory: true }]
    if (entry.isFile() && entry.name.endsWith(".md"))
      return [{ path: path.join(directory, entry.name), directory: false }]
    return []
  })
}

function readFileSync(file: string): string | undefined {
  try {
    return fsSync.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

// All three tiers merged: on-disk project and global plus built-in defaults.
export async function discoverAllTeams(
  projectDirectory: string,
  registry: readonly BuiltinTeam[] = builtinTeams,
): Promise<DiscoveredTeam[]> {
  const disk = await Promise.all([discoverTeams("project", projectDirectory), discoverTeams("global", projectDirectory)])
  return [...disk[0], ...disk[1], ...discoverBuiltinTeams(registry)]
}

// Look up one built-in member body by team and id. Built-in winners carry no
// path, so the installer reads the body back through this instead of the
// filesystem.
export function builtinBody(
  registry: readonly BuiltinTeam[],
  team: string,
  id: string,
): string | undefined {
  return registry.find((entry) => entry.name === team)?.members.find((member) => member.id === id)?.body
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
// lose). A project or global team, or an authored agent, beats a built-in
// member with the same id. Among team copies the project level wins, with
// same-level ties going to the lexicographically smallest team name.
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
    winners.set(agent.id, {
      id: agent.id,
      scope: team.level,
      ...(agent.path === undefined ? {} : { path: agent.path }),
      team: team.team,
    })
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
