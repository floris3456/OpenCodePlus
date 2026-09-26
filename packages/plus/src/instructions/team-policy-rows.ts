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
import { permItemId, fingerprint, type Item, type PolicyRule } from "./model.js"
import { isTerminal, type RunRecord } from "../teams/run.js"

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
    if (isTerminal(record.state)) continue
    const paths = record.paths ?? []
    // A delegated run with no scope still gets its row: it may edit nothing.
    const delegated = record.kind === "w" || record.id.startsWith("w-")
    if (paths.length === 0 && !delegated) continue
    out.push({ id: record.id, role: record.role, paths: [...paths] })
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

const editForbidden = [".git/**", ".opencodeplus/**"] as const

export function teamPolicyItems(members: readonly PolicyMember[], runs: readonly PolicyRun[] = []): Item[] {
  const byRole = new Map(members.map((member) => [member.id, member] as const))
  const scoped = runs.filter((run) => byRole.has(run.role))
  return [
    ...members.flatMap((member) => delegateRows(member, members)),
    ...scoped.map((run) => runScopeRow(run, scoped.filter((peer) => peer.role === run.role))),
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

// Per-run edit scope. The run record is the source: the row exists while the
// run does and carries the run's own `scope.paths`. A rule belongs to an AGENT
// and not to a session, so a member's live runs cannot hold separate scopes —
// `peers` (every live run of this member, in row order) is what the rows state
// together: the member's first row denies `*`, each row allows its own paths,
// and the member's last row denies the never-editable state so nothing inside
// any scope can reach it (core evaluates last-match-wins).
function runScopeRow(run: PolicyRun, peers: readonly PolicyRun[]): Item {
  const allowed = [...new Set(peers.flatMap((peer) => peer.paths))].join(", ")
  const editRules: PolicyRule[] = [
    ...(peers[0]?.id === run.id ? [rule("edit", "*", "deny", outsideScopeMessage("*", allowed))] : []),
    ...run.paths.map((path) => rule("edit", path, "allow")),
    ...(peers[peers.length - 1]?.id === run.id
      ? editForbidden.map((path) => rule("edit", path, "deny", forbiddenStateMessage(path, allowed)))
      : []),
  ]
  const title = `Edit scope for run ${run.id}`
  const patterns = ["*", ...run.paths, ...editForbidden]
  const text = [title, scopeGuidance(run, peers), ...patterns].join("\n")
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
    policy: { on: editRules, off: [] },
    category: "scopes",
    runID: run.id,
  }
}

// What the row's reader is told. With one live run that is its own
// scope.paths; with more, the agent carries the union of every live run's
// scope.paths, so the text says so instead of promising isolation the rules
// cannot give.
function scopeGuidance(run: PolicyRun, peers: readonly PolicyRun[]): string {
  const own = run.paths.length > 0 ? `Only scope.paths [${run.paths.join(", ")}] are editable. ` : ""
  const union = [...new Set(peers.flatMap((peer) => peer.paths))]
  const shared =
    peers.length > 1
      ? `This member's live runs share one edit scope on this agent: the union [${union.join(", ")}] is allowed, so stay inside your own scope.paths. `
      : ""
  const forbidden = run.paths.length > 0 ? "never editable, even inside scope.paths" : "never editable"
  return `${own}${shared}Version-control and paused-tool state is ${forbidden}. Report anything else in needs=[{kind:"path"...}].`
}

// The two refusals the round-1 permission hook sent, word for word, now carried
// by the rules themselves (recovered from the R2 acceptance record in
// docs/team-v2/acceptance/2026-09-18-live-rounds.md, hook commit c63cf4b4
// "fix(plus): explain team scope denials to the agent"). The hook saw the file
// the agent had asked for; a rule answers for a pattern, so the quoted subject
// is the rule's own resource and every other word is unchanged. `allowed` is
// the union of the member's live scopes, which is what the agent's rules really
// permit.
function outsideScopeMessage(resource: string, allowed: string): string {
  return `"${resource}" is outside your scope.paths [${allowed}]. Report it in needs=[{kind:"path"...}].`
}

function forbiddenStateMessage(resource: string, allowed: string): string {
  const scope = allowed.length > 0 ? `, even inside scope.paths [${allowed}]` : ""
  return `"${resource}" is version-control or paused-tool state and is never editable${scope}. Report it in needs=[{kind:"path"...}].`
}

function rule(action: string, resource: string, effect: PolicyRule["effect"], message?: string): PolicyRule {
  return { action, resource, effect, ...(message === undefined ? {} : { message }) }
}
