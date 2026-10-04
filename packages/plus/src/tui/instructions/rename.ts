import { validateAgentId } from "../../agents/files.js"
import type { TreeNode } from "../../instructions/tree.js"
import { validateTeamName } from "../../instructions/teams.js"
import type { Snapshot } from "../../rpc.js"

// T6: what a row can be renamed to. Only Project/Global user agents, on-disk
// team members and Project/Global teams are renamable; built-ins, shipped
// Defaults rows, ancestor-backed agents and preset/entry rows are not offered.
export type RenameTarget =
  | { readonly kind: "agent"; readonly level: "project" | "global"; readonly from: string }
  | { readonly kind: "member"; readonly level: "project" | "global"; readonly team: string; readonly from: string }
  | { readonly kind: "team"; readonly level: "project" | "global"; readonly from: string }

export function renameTargetOf(node: TreeNode | undefined, snapshot: Snapshot | undefined): RenameTarget | undefined {
  const owner = node?.owner
  if (node === undefined || owner === undefined || snapshot === undefined) return undefined
  if (owner.level !== "project" && owner.level !== "global") return undefined
  if (owner.preset !== undefined || owner.entry !== undefined) return undefined
  if (node.kind === "agent" && owner.agent !== null)
    return owner.agent === "" ? undefined : { kind: "agent", level: owner.level, from: owner.agent }
  if (node.kind !== "team" || owner.team === undefined) return undefined
  const team = snapshot.teams?.find((entry) => entry.level === owner.level && entry.team === owner.team?.team)
  if (team === undefined) return undefined
  if (owner.agent === null) return { kind: "team", level: owner.level, from: owner.team.team }
  // A member row is renamable only while the team actually lists it: a Special
  // agent row under a team is not an on-disk member.
  return team.agents.includes(owner.agent) ? { kind: "member", level: owner.level, team: owner.team.team, from: owner.agent } : undefined
}

// Validation mirrors creation: agent and member ids use validateAgentId, team
// names validateTeamName; member id "special" stays reserved.
export function validateRenameName(target: RenameTarget, raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  if (target.kind === "team") {
    const validated = validateTeamName(raw)
    return validated.ok ? { ok: true, name: validated.team } : validated
  }
  const validated = validateAgentId(raw)
  if (!validated.ok) return validated
  if (target.kind === "member" && validated.id === "special")
    return { ok: false, reason: 'Member id "special" is reserved' }
  return { ok: true, name: validated.id }
}