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
  return renameCandidateOf(node, snapshot)?.target
}

// A row that names an agent, member or team but is not renamable still answers
// with a clear refusal (the live `R` path shows it). Undefined means R belongs
// to the category rename instead.
export function renameCandidateOf(node: TreeNode | undefined, snapshot: Snapshot | undefined): { readonly target?: RenameTarget; readonly refusal?: string } | undefined {
  const owner = node?.owner
  if (node === undefined || owner === undefined || snapshot === undefined) return undefined
  if (owner.preset !== undefined || owner.entry !== undefined) return undefined
  if (owner.level !== "project" && owner.level !== "global") return undefined
  if (node.kind === "agent" && owner.agent !== null && owner.agent !== "") {
    // Prefer this level's entry; a built-in shown at Project/Global is served
    // from the Defaults entry, which has no file.
    const entry =
      snapshot.agents.find((candidate) => candidate.id === owner.agent && candidate.scope === owner.level) ??
      snapshot.agents.find((candidate) => candidate.id === owner.agent)
    if (entry?.ancestor === true)
      return { refusal: `Agent ${owner.agent} is inherited from an ancestor directory and cannot be renamed` }
    if (entry !== undefined && entry.fileBacked !== true) return { refusal: `Agent ${owner.agent} is built in and cannot be renamed` }
    return { target: { kind: "agent", level: owner.level, from: owner.agent } }
  }
  if (node.kind !== "team" || owner.team === undefined) return undefined
  const team = snapshot.teams?.find((entry) => entry.level === owner.level && entry.team === owner.team?.team)
  if (owner.agent === null) {
    if (team === undefined) return undefined
    return { target: { kind: "team", level: owner.level, from: owner.team.team } }
  }
  // A Special agent row under a team is not an on-disk member; a member whose
  // team the snapshot does not list is not renamable either.
  if (team === undefined) return undefined
  if (!team.agents.includes(owner.agent)) return { refusal: `Member ${owner.agent} is built in and cannot be renamed` }
  return { target: { kind: "member", level: owner.level, team: owner.team.team, from: owner.agent } }
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