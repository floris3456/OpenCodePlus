// Team rows that exist per member, as instructions rows.
//
// Almost every team rule is a shared catalogue row (permission-catalog.ts)
// that every agent has and a preset sets; nothing here or under `src/teams`
// reads a role from a member's id. Two kinds of row cannot be shared, because
// they name something only a member has:
//
// - "Delegate to": one row per teammate, plus "Members of other teams". They
//   ship off; a member preset turns on the teammates it delegates to.
// - Per-run edit scope: one row per live delegated run, carrying the run's own
//   `scope.paths`.
//
// A row is listable (`instructions.list`), showable, logged, and overridable
// at project or global level like every other row.
import { readdir } from "node:fs/promises"
import path from "node:path"
import { permItemId, fingerprint, type Item } from "./model.js"
import { isTerminal, type RunRecord } from "../teams/run.js"
import { runScope } from "../teams/scope.js"

/** One member of an enabled team. */
export interface PolicyMember {
  readonly id: string
  /** The enabled team the member belongs to: its "Delegate to" rows list that team's other members. */
  readonly team?: string
}

/** A live run's edit scope, read from `runs/<id>/run.json`. */
export interface PolicyRun {
  readonly id: string
  readonly role: string
  readonly paths: readonly string[]
  readonly forbidden?: readonly string[]
}

// Edit scope comes from the run record, not from the call that created it:
// the row exists exactly while the run is non-terminal, so a superseded or
// reaped run's scope stops applying with no cleanup step. A root run with no
// declared scope contributes no row — the member's own rows still apply.
export async function liveRunScopes(root: string): Promise<PolicyRun[]> {
  const dir = path.join(root, "runs")
  const entries = await readdir(dir).catch(() => [])
  const out: PolicyRun[] = []
  for (const name of entries) {
    if (name.startsWith(".")) continue
    const record = await Bun.file(path.join(dir, name, "run.json"))
      .json()
      .then((value: RunRecord) => value)
      .catch(() => undefined)
    if (record === undefined || typeof record.id !== "string") continue
    if (isTerminal(record.state) || record.worktree === "removed") continue
    const paths = record.paths ?? []
    // A delegated run with no scope still gets its row: it may edit nothing.
    const delegated = record.kind === "w" || record.id.startsWith("w-")
    if (paths.length === 0 && !delegated) continue
    const scope = await runScope(root, record)
    out.push({ id: record.id, role: record.role, paths: [...scope.paths], forbidden: [...scope.forbidden] })
  }
  return out.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** Every member of an enabled team, with its team. */
export function policyMembersOf(members: readonly (string | { readonly id: string; readonly team?: string | undefined })[]): PolicyMember[] {
  return members.map((entry): PolicyMember => {
    if (typeof entry === "string") return { id: entry }
    return { id: entry.id, ...(entry.team === undefined ? {} : { team: entry.team }) }
  })
}

export function teamPolicyItems(members: readonly PolicyMember[], runs: readonly PolicyRun[] = []): Item[] {
  const byRole = new Map(members.map((member) => [member.id, member] as const))
  const scoped = runs.filter((run) => byRole.has(run.role))
  return [
    ...members.flatMap((member) => delegateRows(member, members)),
    ...scoped.map(runScopeRow),
  ]
}

// "Delegate to": one row per other member of the member's team, plus one row
// for every member of other teams. All ship off: a member preset turns on the
// teammates it delegates to. team_delegate reads these rows; its `role`
// parameter lists exactly the members that are on.
function delegateRows(member: PolicyMember, members: readonly PolicyMember[]): Item[] {
  const peers = members.filter((peer) => peer.id !== member.id && peer.team === member.team)
  return [
    ...peers.map((peer, index) =>
      delegateRow({
        id: permItemId("team_delegate", `to.${peer.id}`),
        title: peer.id,
        agent: member.id,
        order: 10 + index,
        message: `${member.id} may not delegate to ${peer.id}`,
      }),
    ),
    delegateRow({
      id: permItemId("team_delegate", "to.other-teams"),
      title: "Members of other teams",
      agent: member.id,
      order: 99,
      message: `${member.id} delegates only within its own team`,
    }),
  ]
}

function delegateRow(input: { id: string; title: string; agent: string; order: number; message: string }): Item {
  return {
    id: input.id,
    kind: "perm",
    group: "none",
    title: input.title,
    text: input.title,
    enabled: false,
    fingerprint: fingerprint(input.title),
    order: input.order,
    agents: [input.agent],
    permTool: "team_delegate",
    permAction: "team.delegate",
    ruleId: input.id.slice(input.id.indexOf(":", "perm:".length) + 1),
    patterns: [],
    category: "to",
    permKind: "team",
    message: input.message,
  }
}

// Guidance only: agent-wide allow rules would union independent workers and
// could override a prior denial. The session-aware hook and checkpoint boundary
// enforce the saved brief, and can only narrow existing permissions.
function runScopeRow(run: PolicyRun): Item {
  const title = `Edit scope for run ${run.id}`
  const patterns = [...run.paths]
  const text = `${title}\nOnly this run's scope.paths [${run.paths.join(", ")}] are eligible for edits/checkpoints; forbidden [${(run.forbidden ?? []).join(", ")}] wins. Same-role runs do not share scope. Session-aware enforcement never overrides existing permission denials or approval requirements. Version-control, paused-tool and .opencodeplus state remain protected. Changing this display row does not widen the saved brief. Report other paths in needs=[{kind:"path"...}].`
  return {
    id: `perm:edit:run:${run.id}`,
    kind: "perm",
    group: "none",
    title,
    text,
    enabled: true,
    fingerprint: fingerprint(text),
    order: 300,
    agents: [run.role],
    permTool: "edit",
    permAction: "edit",
    ruleId: `run:${run.id}`,
    patterns,
    policy: { on: [], off: [] },
    category: "scopes",
    runID: run.id,
  }
}
