// What the team tools read from a member's permission rows: who it may
// delegate to, which runs it may address, the bounds of its delegations,
// what briefs it accepts and what its reports need. The rows are
// instructions rows (permission-catalog.ts and team-policy-rows.ts), read for
// the member they belong to — the caller, or the member a brief names. A row
// that is missing (no table at all, or an agent the table does not know)
// reads as off; nothing is inferred from a member's id.
import { delegateTargets, rowState, teamAllows, teamLimit, type PermissionTable, type PermRow } from "../instructions/permission-enforce.js"
import type { TeamTool } from "./policy.js"
import { loadRun, type RunRecord } from "./run.js"

export type Relation = "self" | "child" | "descendant" | "other"

// How a target run relates to the caller's run: its own, a direct child, a
// deeper descendant (the parent chain reaches the caller), or anything else.
export async function relationOf(root: string, caller: RunRecord, target: RunRecord): Promise<Relation> {
  if (target.id === caller.id) return "self"
  if (target.parent === caller.id) return "child"
  const seen = new Set<string>([target.id])
  let parent = target.parent
  while (parent !== null && parent !== undefined && !seen.has(parent)) {
    if (parent === caller.id) return "descendant"
    seen.add(parent)
    parent = (await loadRun(root, parent))?.parent ?? null
  }
  return "other"
}

// Whether a member may address a run of this relation with a tool: its own run
// and its direct children always; deeper descendants and other runs by the
// tool's Runs rows.
export function mayReach(table: PermissionTable | undefined, agent: string, tool: TeamTool, relation: Relation): boolean {
  if (relation === "self" || relation === "child") return true
  return teamAllows(table, agent, `team_${tool}`, relation === "descendant" ? "runs.descendants" : "runs.others")
}

// Whether a member may delegate to a target: the target's "Delegate to" row
// when the target is on the member's team, else the "Members of other teams"
// row for a member of any enabled team.
export function mayDelegate(table: PermissionTable | undefined, agent: string, target: string): boolean {
  const own = rowState(table, agent, "team_delegate", `to.${target}`)
  if (own !== undefined) return own.on
  return teamAllows(table, agent, "team_delegate", "to.other-teams") && (table?.teamMembers.has(target) ?? false)
}

// The members a delegation may name, for errors that list what is accepted.
export function delegationTargets(table: PermissionTable | undefined, agent: string): string[] {
  if (table === undefined) return []
  return delegateTargets(table.toolRows(agent, "team_delegate"))
}

export function bound(table: PermissionTable | undefined, agent: string, tool: TeamTool, id: string): number | undefined {
  return teamLimit(table, agent, `team_${tool}`, id)
}

export function allows(table: PermissionTable | undefined, agent: string, tool: TeamTool, id: string): boolean {
  return teamAllows(table, agent, `team_${tool}`, id)
}

// The row itself, for a refusal that quotes its message or reads its patterns.
export function row(table: PermissionTable | undefined, agent: string, tool: TeamTool, id: string): PermRow | undefined {
  return rowState(table, agent, `team_${tool}`, id)
}
