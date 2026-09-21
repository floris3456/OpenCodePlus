// Team role rules as instructions rows.
//
// THE ONE place a team role's rules are turned into something the rest of the
// system can see. Nothing under `src/teams` pushes permissions onto an agent
// or registers a permission hook: `teams/policy.ts` states the ceiling and the
// native answers as data, this producer turns that data into ordinary `perm:`
// rows under each member, and `apply.ts` installs whatever those rows resolve
// to. A row is listable (`instructions.list`), showable, logged, and
// overridable at project or global level like every other row.
//
// A row carries both sides of its own answer: `policy.on` is installed when it
// resolves enabled, `policy.off` when it resolves disabled. That is what lets
// one row express "orchestrators may run shell, implementers may not" as the
// same row with a different shipped state, and what lets a later task hand a
// planner an `ask` effect on `team.delegate` by changing one rule list.
import { readdir } from "node:fs/promises"
import path from "node:path"
import { permItemId, fingerprint, type Item, type PolicyRule } from "./model.js"
import { allowedTeamTools, kindOf, nativePermissions, teamTools, type Kind } from "../teams/policy.js"
import { isTerminal, type RunRecord } from "../teams/run.js"

/** One member of an enabled team, with the role kind its rules come from. */
export interface PolicyMember {
  readonly id: string
  readonly kind: Kind
}

/** A live run's edit scope, read from `runs/<id>/run.json`. */
export interface PolicyRun {
  readonly id: string
  readonly role: string
  readonly paths: readonly string[]
}

// Edit scope comes from the run record, not from the call that created it:
// the row exists exactly while the run is non-terminal, so a superseded or
// reaped run's scope stops applying with no cleanup step. A run with no
// declared scope contributes no row — the role's own rules still apply.
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
    if (paths.length === 0) continue
    out.push({ id: record.id, role: record.role, paths: [...paths] })
  }
  return out.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** Members of enabled teams whose id names a known role kind. Unknown ids get no rules. */
export function policyMembersOf(ids: readonly string[]): PolicyMember[] {
  return ids.flatMap((id): PolicyMember[] => {
    const resolved = kindOf(id)
    if (!resolved.ok) return []
    return [{ id, kind: resolved.kind }]
  })
}

const nativeLabels: Record<string, string> = {
  shell: "Shell commands",
  question: "Ask the user a question",
  external_directory: "Directories outside the worktree",
  subagent: "Start a subagent",
  task: "Start a task",
  read: "Read keys, env files and credentials",
}

// Tools reached through the `search` MCP server rather than the team
// namespace (D3). Implementers, reviewers and scouts keep code search and
// lose Tavily, which is the narrowing the old ceilings expressed.
const searchServer = "search"
const tavilyAction = `${searchServer}_tavily_*`
const narrowedSearchKinds: ReadonlySet<Kind> = new Set<Kind>(["implementer", "reviewer", "scout"])

const editForbidden = [".git/**", ".opencodeplus/**"] as const

export function teamPolicyItems(members: readonly PolicyMember[], runs: readonly PolicyRun[] = []): Item[] {
  const byRole = new Map(members.map((member) => [member.id, member] as const))
  return [
    ...members.flatMap((member) => [
      ...nativeRows(member),
      ...ceilingRows(member),
      ...searchRows(member),
    ]),
    ...runs.flatMap((run) => (byRole.has(run.role) ? [runScopeRow(run)] : [])),
  ]
}

// Native answers grouped by permission action: one row per action, carrying
// every resource that action governs. A row ships enabled when the role's
// answer is permissive and disabled when it is a denial, so the shipped state
// reads the same way as every other row (on = permitted).
function nativeRows(member: PolicyMember): Item[] {
  const byAction = new Map<string, string[]>()
  const permissive = new Map<string, boolean>()
  for (const rule of nativePermissions(member.kind)) {
    const resources = byAction.get(rule.action) ?? []
    resources.push(rule.resource)
    byAction.set(rule.action, resources)
    permissive.set(rule.action, (permissive.get(rule.action) ?? true) && rule.effect !== "deny")
  }
  return [...byAction.entries()].map(([action, resources], index) =>
    row({
      id: permItemId(action, "team-role"),
      title: nativeLabels[action] ?? action,
      agent: member.id,
      order: index,
      permTool: action,
      permAction: action,
      patterns: resources,
      enabled: permissive.get(action) === true,
      policy: {
        on: resources.map((resource) => rule(action, resource, "allow")),
        off: resources.map((resource) => rule(action, resource, "deny")),
      },
    }),
  )
}

// The role's tool ceiling. Only the tools OUTSIDE it get a row: a member sees
// exactly its ceiling because every other team tool carries a shipped-off row
// whose deny on the tool's own permission action drops it from the catalog.
function ceilingRows(member: PolicyMember): Item[] {
  const allowed = new Set<string>(allowedTeamTools(member.kind))
  return teamTools
    .filter((tool) => !allowed.has(tool))
    .map((tool, index) =>
      row({
        id: permItemId(`team_${tool}`, "role-ceiling"),
        title: `team_${tool}`,
        agent: member.id,
        order: 100 + index,
        permTool: `team_${tool}`,
        permAction: `team.${tool}`,
        patterns: ["*"],
        enabled: false,
        policy: { on: [rule(`team.${tool}`, "*", "allow")], off: [rule(`team.${tool}`, "*", "deny")] },
      }),
    )
}

function searchRows(member: PolicyMember): Item[] {
  if (!narrowedSearchKinds.has(member.kind)) return []
  return [
    row({
      id: permItemId(searchServer, "team-tavily"),
      title: "Tavily search (search MCP)",
      agent: member.id,
      order: 200,
      permTool: searchServer,
      permAction: tavilyAction,
      patterns: ["*"],
      enabled: false,
      policy: { on: [rule(tavilyAction, "*", "allow")], off: [rule(tavilyAction, "*", "deny")] },
    }),
  ]
}

// Per-run edit scope. The run record is the source: the row exists while the
// run does and carries the run's own `scope.paths`. Deny `*` first so the
// path allows override it, then the never-editable state last so nothing
// inside scope.paths can reach it (core evaluates last-match-wins).
function runScopeRow(run: PolicyRun): Item {
  const scope = run.paths.join(", ")
  const guidance = `Only scope.paths [${scope}] are editable. Version-control and paused-tool state is never editable, even inside scope.paths. Report anything else in needs=[{kind:"path"...}].`
  return row({
    id: `perm:edit:run:${run.id}`,
    title: `Edit scope for run ${run.id}`,
    agent: run.role,
    order: 300,
    permTool: "edit",
    permAction: "edit",
    patterns: ["*", ...run.paths, ...editForbidden],
    enabled: true,
    guidance,
    runID: run.id,
    policy: {
      on: [
        rule("edit", "*", "deny"),
        ...run.paths.map((path) => rule("edit", path, "allow")),
        ...editForbidden.map((path) => rule("edit", path, "deny")),
      ],
      off: [],
    },
  })
}

function rule(action: string, resource: string, effect: PolicyRule["effect"]): PolicyRule {
  return { action, resource, effect }
}

function row(input: {
  id: string
  title: string
  agent: string
  order: number
  permTool: string
  permAction: string
  patterns: readonly string[]
  enabled: boolean
  policy: { on: readonly PolicyRule[]; off: readonly PolicyRule[] }
  guidance?: string
  runID?: string
}): Item {
  const text = [input.title, ...(input.guidance === undefined ? [] : [input.guidance]), ...input.patterns].join("\n")
  return {
    id: input.id,
    kind: "perm",
    group: "none",
    title: input.title,
    text,
    enabled: input.enabled,
    fingerprint: fingerprint(text),
    order: input.order,
    agents: [input.agent],
    permTool: input.permTool,
    permAction: input.permAction,
    ruleId: input.id.slice(input.id.indexOf(":", "perm:".length) + 1),
    patterns: [...input.patterns],
    policy: { on: [...input.policy.on], off: [...input.policy.off] },
    ...(input.runID === undefined ? {} : { runID: input.runID }),
  }
}
