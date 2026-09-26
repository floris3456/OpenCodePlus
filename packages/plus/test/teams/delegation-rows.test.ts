// Who a member may delegate to, which runs it may address, what a brief to
// it must carry and what its reports need are its permission rows. These
// tests pin what the rows ship with, what each Plus preset sets them to (the
// old role of the same name, row for row), then run the real team handlers
// against a real permission table built from those rows, with single rows
// switched to show the handlers read them. Nothing reads a member's id.
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { teamsDataDir } from "../../src/instructions/paths.js"
import { decide, type PermissionTable } from "../../src/instructions/permission-enforce.js"
import { wildcardMatch } from "../../src/instructions/permission-catalog.js"
import { policyMembersOf, teamPolicyItems } from "../../src/instructions/team-policy-rows.js"
import { createTeamApi, type TeamApiResult, type TeamCaller } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { reachTools } from "../../src/teams/policy.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Brief } from "../../src/teams/schema.js"
import { context } from "../harness.js"
import { change, linked, presetInput, presetTable, resolvedStates, shippedMembers, shippedTeam, teamState, type TeamMember } from "./preset-table.js"

// The shipped team (each member linked to its member preset) plus a build
// seat linked straight to the Plus build-seat agent preset.
const members: TeamMember[] = [...shippedMembers(), linked("ocp-build", "build-seat")]
const ids = members.map((member) => member.id)
const planners = ["fable-planner", "astra-planner"]
const orchestrators = ["sol-orchestrator", "opus-orchestrator"]
const implementers = ["muse-implementer", "gemini-implementer", "spark-implementer", "opus-implementer"]
const workers = [...implementers, "astra-reviewer", "scout"]
const input = presetInput({ members })
const states = Object.fromEntries(ids.map((id) => [id, resolvedStates(input, id)]))

function memberOf(id: string): TeamMember {
  const found = members.find((member) => member.id === id)
  if (found === undefined) throw new Error(`no member ${id}`)
  return found
}

// Each "Delegate to" row by rule id, resolved for the member.
function delegateStates(member: string) {
  return Object.fromEntries(
    Object.entries(states[member] ?? {})
      .filter(([id]) => id.startsWith("perm:team_delegate:to."))
      .map(([id, state]) => [id.slice("perm:team_delegate:".length), state === "on"]),
  )
}

function expectedDelegates(member: string, open: readonly string[]) {
  return Object.fromEntries([...ids.filter((id) => id !== member).map((id) => [`to.${id}`, open.includes(id)]), ["to.other-teams", false]])
}

// ── what the rows are ──────────────────────────────────────────────────────

test("policyMembersOf keeps every member of an enabled team, whatever its id, with its team", () => {
  expect(policyMembersOf(["build", "notes", { id: "ocp-alice", team: shippedTeam }, { id: "x", team: undefined }])).toEqual([
    { id: "build" },
    { id: "notes" },
    { id: "ocp-alice", team: shippedTeam },
    { id: "x" },
  ])
})

test("Delegate to rows list every co-member, name only the member and ship off", () => {
  const items = teamPolicyItems(policyMembersOf(members))
  for (const member of ids) {
    const rows = items.filter((item) => item.agents?.includes(member) === true && item.category === "to")
    expect([member, rows.map((row) => row.ruleId)]).toEqual([member, [...ids.filter((id) => id !== member).map((id) => `to.${id}`), "to.other-teams"]])
    for (const row of rows) {
      expect([row.id, row.enabled, row.permTool, row.permKind, row.message?.includes(member)]).toEqual([row.id, false, "team_delegate", "team", true])
      if (row.ruleId !== "to.other-teams") expect(row.text).toBe(row.title)
    }
  }
  // Nothing else is generated per member without a live run.
  expect(items.every((item) => item.category === "to")).toBe(true)
})

// ── what the presets set ───────────────────────────────────────────────────

test("member presets open Delegate to rows along the old graph, and a build seat opens every teammate", () => {
  for (const planner of planners) expect([planner, delegateStates(planner)]).toEqual([planner, expectedDelegates(planner, orchestrators)])
  for (const orchestrator of orchestrators)
    expect([orchestrator, delegateStates(orchestrator)]).toEqual([
      orchestrator,
      expectedDelegates(orchestrator, [...orchestrators.filter((id) => id !== orchestrator), ...workers]),
    ])
  expect(delegateStates("ocp-build")).toEqual(expectedDelegates("ocp-build", ids.filter((id) => id !== "ocp-build")))
  for (const worker of workers) expect([worker, delegateStates(worker)]).toEqual([worker, expectedDelegates(worker, [])])
})

test("Runs rows follow the preset: coordinators read status and wait everywhere, planners and build seats also list", () => {
  const reach = (member: string): Record<string, string | undefined> =>
    Object.fromEntries(reachTools.flatMap((tool) => ["descendants", "others"].map((relation) => {
      const id = `perm:team_${tool}:runs.${relation}`
      return [id, states[member]?.[id]]
    })))
  const expected = (open: readonly string[]): Record<string, string | undefined> =>
    Object.fromEntries(reachTools.flatMap((tool) => ["descendants", "others"].map((relation) => [`perm:team_${tool}:runs.${relation}`, open.includes(tool) ? "on" : "off"])))
  for (const planner of planners) expect([planner, reach(planner)]).toEqual([planner, expected(["status", "wait", "list"])])
  for (const orchestrator of orchestrators) expect([orchestrator, reach(orchestrator)]).toEqual([orchestrator, expected(["status", "wait"])])
  expect(reach("ocp-build")).toEqual(expected(["status", "wait", "list"]))
  for (const worker of workers) expect([worker, reach(worker)]).toEqual([worker, expected([])])
})

test("a clean worktree is required before done for implementer-preset members only", () => {
  for (const member of ids) expect([member, states[member]?.["perm:team_finish:requirements.clean"]]).toEqual([member, implementers.includes(member) ? "on" : "off"])
})

test("a planner asks before each delegation, changes plan files only and does not delegate from a delegated run", () => {
  for (const planner of planners) {
    expect([planner, states[planner]?.["perm:team_delegate:approval.every"], states[planner]?.["perm:team_delegate:access.delegated"]]).toEqual([planner, "on", "off"])
    expect([planner, states[planner]?.["perm:edit:allowed.*"], states[planner]?.["perm:edit:allowed.plans"]]).toEqual([planner, "off", "on"])
  }
  for (const member of ids.filter((id) => !planners.includes(id))) {
    expect([member, states[member]?.["perm:team_delegate:approval.every"]]).toEqual([member, "off"])
    expect([member, states[member]?.["perm:edit:allowed.*"]]).toEqual([member, "on"])
  }
  // The planner's table refuses an edit outside plan files, for edit, write and patch alike.
  const table = presetTable({ members })
  const call = (tool: string, toolInput: unknown) =>
    decide(table.toolRows("fable-planner", tool), { tool, input: toolInput, sessionID: "ses_x", directory: "/repo", teamMembers: table.teamMembers })
  expect(call("edit", { path: "docs/plans/2026-09-25-delegation.md" }).refuse).toBeUndefined()
  expect(call("edit", { path: "/repo/repos/opencode/docs/plans/p.md" }).refuse).toBeUndefined()
  expect(call("write", { path: "docs/handoffs/h.md", content: "x" }).refuse).toBeUndefined()
  expect(call("edit", { path: "packages/plus/src/index.ts" }).refuse).toBe(
    "Permission denied: this file is not one you may change here; only the allowed files (Files it may change) are",
  )
  expect(call("patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }).refuse).toContain("Files it may change")
  // An orchestrator's table does not.
  expect(decide(table.toolRows("sol-orchestrator", "edit"), { tool: "edit", input: { path: "packages/plus/src/index.ts" }, sessionID: "s", directory: "/repo", teamMembers: table.teamMembers }).refuse).toBeUndefined()
})

// The command families the old orchestrator role denied, verbatim.
const orchestratorShellChanges = [
  "git push origin main",
  "git commit -m x",
  "git reset --hard HEAD",
  "git checkout main",
  "git rebase main",
  "git add .",
  "git stash",
  "git clean -fd",
  "git restore a.ts",
  "git switch main",
  "git merge x",
  "git cherry-pick abc",
  "git revert abc",
  "git rm a.ts",
  "git mv a b",
  "git apply p.diff",
  "git am p.mbox",
  "git pull",
  "git tag v1",
  "git update-ref refs/heads/x HEAD",
  "git worktree add ../x",
  "git branch -D x",
  "rm -rf build",
  "echo x > file.txt",
  "echo x >> file.txt",
  "tee out.txt",
  "sed -i s/a/b/ f",
  "cp a b",
  "mv a b",
  "touch a",
  "mkdir d",
  "ln -s a b",
  "truncate -s 0 f",
]

test("an orchestrator's preset turns off the shell rows that change files, commits and refs, and nothing it reads", () => {
  const rows = [
    "perm:shell:git-push",
    "perm:shell:git-commit",
    "perm:shell:git-rewrite",
    "perm:shell:rm",
    "perm:shell:commands.git-changes",
    "perm:shell:commands.git-refs",
    "perm:shell:commands.file-writes",
  ]
  for (const orchestrator of orchestrators) {
    expect([orchestrator, states[orchestrator]?.["tool:shell"]]).toEqual([orchestrator, "on"])
    for (const id of rows) expect([orchestrator, id, states[orchestrator]?.[id]]).toEqual([orchestrator, id, "off"])
  }
  for (const id of rows) expect(["ocp-build", id, states["ocp-build"]?.[id]]).toEqual(["ocp-build", id, "on"])
  const patterns = input.items.filter((item) => rows.includes(item.id)).flatMap((item) => item.patterns ?? [])
  for (const command of orchestratorShellChanges)
    expect([command, patterns.some((pattern) => wildcardMatch(command, pattern))]).toEqual([command, true])
  for (const command of ["git status", "git log --oneline", "git diff", "bun test test/a.test.ts"])
    expect([command, patterns.some((pattern) => wildcardMatch(command, pattern))]).toEqual([command, false])
})

test("every member but a build seat reads and searches no secret files; a build seat has every team tool", () => {
  const secretRows = Object.keys(states["fable-planner"] ?? {}).filter(
    (id) => /^perm:read:(env|files\.(keys|credentials|opencode-config|run-configs|databases))$/.test(id) || /^perm:grep:(files\.(env|keys|credentials|opencode-config|run-configs|databases)|include\.(env|keys))$/.test(id),
  )
  expect(secretRows).toHaveLength(14)
  for (const member of ids.filter((id) => id !== "ocp-build"))
    for (const id of secretRows) expect([member, id, states[member]?.[id]]).toEqual([member, id, "off"])
  for (const id of secretRows) expect(["ocp-build", id, states["ocp-build"]?.[id]]).toEqual(["ocp-build", id, "on"])
  expect(Object.entries(states["ocp-build"] ?? {}).filter(([id, state]) => id.startsWith("tool:team_") && state === "off")).toEqual([])
})

// ── handlers reading the rows ──────────────────────────────────────────────

let tmp = ""
let root = ""
const priorDataHome = process.env.XDG_DATA_HOME

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plus-delegation-rows-"))
  process.env.XDG_DATA_HOME = tmp
  root = teamsDataDir()
})

afterEach(async () => {
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  if (priorDataHome !== undefined) process.env.XDG_DATA_HOME = priorDataHome
  await fs.rm(tmp, { recursive: true, force: true })
})

interface Change {
  readonly agent: string
  readonly id: string
  readonly enabled?: boolean
  readonly text?: string
}

// The table a publish hands the team tools: every member's rows resolved
// through its preset, with `changes` stored as its own overrides.
function tableWith(...changes: Change[]): PermissionTable {
  return presetTable({
    members,
    records: changes.map((entry) =>
      change(memberOf(entry.agent), entry.id, {
        ...(entry.enabled === undefined ? {} : { state: entry.enabled ? "on" : "off" }),
        ...(entry.text === undefined ? {} : { text: entry.text }),
      }),
    ),
  })
}

function recordSession(): SessionDomain {
  let seq = 0
  // The handlers read child.id and pass plain inputs through, so minimal
  // shapes behind one boundary cast are enough.
  return {
    create: () => {
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_delegated_${seq}`) })
    },
    prompt: () => Effect.succeed(undefined as never),
    wait: () => Effect.succeed(undefined),
  } as unknown as SessionDomain
}

function apiWith(table: PermissionTable) {
  return createTeamApi(context({ session: recordSession() }), teamState(table))
}

function baseRun(overrides: Partial<RunRecord> & { id: string; role: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: path.join(tmp, "no-worktree"),
    paths: [],
    branch: "team/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "delegation-rows-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function working(overrides: Partial<RunRecord> & { id: string; role: string }): RunRecord {
  return baseRun({
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
    sessionID: `ses_${overrides.id.slice(2, 10)}`,
    ...overrides,
  })
}

function callerFor(record: RunRecord): TeamCaller {
  return { sessionID: String(record.sessionID ?? "ses_unknown"), agent: record.role, run: record }
}

function brief(overrides: Record<string, unknown>): Brief {
  return Schema.decodeUnknownSync(Brief)({
    requestID: "req-1",
    role: "gemini-implementer",
    objective: "Fix the agent filter in the query module so scoped listing works as documented.",
    deliverable: { kind: "commit" },
    scope: { paths: ["packages/plus/src/*"] },
    checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] }],
    ...overrides,
  })
}

function required(result: TeamApiResult): unknown {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

function rejected(result: TeamApiResult) {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`)
  return result.error
}

async function makeRepo(): Promise<{ dir: string; head: string }> {
  const dir = path.join(tmp, "repo")
  await fs.mkdir(dir)
  await git(dir, ["init"])
  await git(dir, ["config", "user.name", "delegation-rows"])
  await git(dir, ["config", "user.email", "delegation-rows@local"])
  await Bun.write(path.join(dir, "README.md"), "# delegation rows\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  return { dir, head: await git(dir, ["rev-parse", "HEAD"]) }
}

test("a planner may not delegate to a reviewer until its Delegate to row for that reviewer is on", async () => {
  const planner = baseRun({ id: "main-0123456789abcdef", role: "fable-planner", kind: "main", sessionID: "ses_planner" })
  await saveRun(root, planner)
  const review = brief({ role: "astra-reviewer", deliverable: { kind: "findings" }, scope: { paths: [] }, repo: "not-a-configured-repo" })
  const error = rejected(await apiWith(tableWith()).delegate(review, callerFor(planner)))
  expect(error.code).toBe("E_ROLE")
  expect(error.message).toContain(`"astra-reviewer"`)
  expect(error.message).toContain("You may delegate to: opus-orchestrator, sol-orchestrator.")
  expect(error.accepted).toEqual({ role: "opus-orchestrator" })

  // With the row on, the role gate passes and the next gate answers.
  const opened = tableWith({ agent: "fable-planner", id: "perm:team_delegate:to.astra-reviewer", enabled: true })
  expect(rejected(await apiWith(opened).delegate(review, callerFor(planner))).code).toBe("E_REPO")
})

test("an implementer's preset opens nobody, and a member outside the enabled teams is refused as such", async () => {
  const implementer = baseRun({ id: "main-0123456789abcdef", role: "muse-implementer", kind: "main", sessionID: "ses_implementer" })
  const orchestrator = baseRun({ id: "main-1111111111111111", role: "opus-orchestrator", kind: "main", sessionID: "ses_orchestrator" })
  await saveRun(root, implementer)
  await saveRun(root, orchestrator)
  const nobody = rejected(await apiWith(tableWith()).delegate(brief({ role: "gemini-implementer" }), callerFor(implementer)))
  expect(nobody.code).toBe("E_ROLE")
  expect(nobody.message).toBe("muse-implementer may not delegate. No member is open to you for delegation.")
  const stranger = rejected(await apiWith(tableWith()).delegate(brief({ role: "acme-implementer" }), callerFor(orchestrator)))
  expect(stranger.code).toBe("E_ROLE")
  expect(stranger.message).toContain(`"acme-implementer" is not a member of an enabled team`)
})

test("a delegated run delegates further only while its Delegate from a delegated run row is on", async () => {
  const repo = await makeRepo()
  const root_ = baseRun({ id: "main-0123456789abcdef", role: "ocp-build", kind: "main", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_build" })
  const planner = working({ id: "w-aaaaaaaaaaaaaaaa", role: "fable-planner", parent: root_.id, directory: repo.dir, base: repo.head, head: repo.head })
  await saveRun(root, root_)
  await saveRun(root, planner)
  const plan = brief({ role: "sol-orchestrator", deliverable: { kind: "report" }, scope: { paths: [] }, checks: [], reason: "two packages" })
  const refused = rejected(await apiWith(tableWith()).delegate(plan, callerFor(planner)))
  expect(refused.code).toBe("E_ROLE")
  expect(refused.message).toBe(`fable-planner: a delegated run of yours may not delegate further; finish with needs=[{kind:"decision",...}] instead`)
  const opened = tableWith({ agent: "fable-planner", id: "perm:team_delegate:access.delegated", enabled: true })
  const started = required(await apiWith(opened).delegate({ ...plan, requestID: "req-2" }, callerFor(planner))) as { run: string }
  expect((await loadRun(root, started.run))?.parent).toBe(planner.id)
}, 30000)

test("a Children working at once row edited to 1 refuses a second working child", async () => {
  const repo = await makeRepo()
  const parent = baseRun({ id: "main-0123456789abcdef", role: "opus-orchestrator", kind: "main", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_orchestrator" })
  await saveRun(root, parent)
  await saveRun(root, working({ id: "w-aaaaaaaaaaaaaaaa", role: "gemini-implementer", parent: parent.id, directory: repo.dir }))
  const one = tableWith({ agent: parent.role, id: "perm:team_delegate:limits.inflight", text: "1" })
  const error = rejected(await apiWith(one).delegate(brief({ requestID: "second-1" }), callerFor(parent)))
  expect(error.code).toBe("E_BOUNDS")
  expect(error.message).toContain("In-flight limit 1 reached (w-aaaaaaaaaaaaaaaa)")
  // The shipped bound (4) lets the same delegation start.
  const started = required(await apiWith(tableWith()).delegate(brief({ requestID: "second-2" }), callerFor(parent))) as { run: string }
  expect((await loadRun(root, started.run))?.parent).toBe(parent.id)
}, 30000)

test("status reads another run only while the caller's Any other run row for team_status is on", async () => {
  const orchestrator = baseRun({ id: "main-0123456789abcdef", role: "opus-orchestrator", kind: "main", sessionID: "ses_orchestrator" })
  const implementer = baseRun({ id: "main-1111111111111111", role: "muse-implementer", kind: "main", sessionID: "ses_implementer" })
  const stranger = baseRun({ id: "w-bbbbbbbbbbbbbbbb", role: "gemini-implementer", parent: "main-ffffffffffffffff", sessionID: "ses_stranger" })
  for (const run of [orchestrator, implementer, stranger]) await saveRun(root, run)
  const status = async (table: PermissionTable, caller: RunRecord) => apiWith(table).status({ runs: [stranger.id] }, callerFor(caller))

  // The orchestrator preset turns the row on; turning it off closes the stranger's run.
  expect((required(await status(tableWith(), orchestrator)) as { run: string }[]).map((entry) => entry.run)).toEqual([stranger.id])
  const closed = rejected(await status(tableWith({ agent: orchestrator.role, id: "perm:team_status:runs.others", enabled: false }), orchestrator))
  expect(closed.code).toBe("E_NOT_VISIBLE")
  expect(closed.message).toContain(stranger.id)
  // The implementer preset leaves it off; turning it on opens it.
  expect(rejected(await status(tableWith(), implementer)).code).toBe("E_NOT_VISIBLE")
  const opened = tableWith({ agent: implementer.role, id: "perm:team_status:runs.others", enabled: true })
  expect((required(await status(opened, implementer)) as { run: string }[]).map((entry) => entry.run)).toEqual([stranger.id])
})

test("list shows deeper descendants and other runs by the caller's team_list Runs rows", async () => {
  const parent = baseRun({ id: "main-0123456789abcdef", role: "opus-orchestrator", kind: "main", children: ["w-aaaaaaaaaaaaaaaa"], sessionID: "ses_orchestrator" })
  const child = baseRun({ id: "w-aaaaaaaaaaaaaaaa", role: "opus-orchestrator", parent: parent.id, children: ["w-bbbbbbbbbbbbbbbb"] })
  const grandchild = baseRun({ id: "w-bbbbbbbbbbbbbbbb", role: "gemini-implementer", parent: child.id })
  const stranger = baseRun({ id: "w-cccccccccccccccc", role: "opus-implementer", parent: "main-ffffffffffffffff" })
  const planner = baseRun({ id: "main-2222222222222222", role: "fable-planner", kind: "main", sessionID: "ses_planner" })
  for (const run of [parent, child, grandchild, stranger, planner]) await saveRun(root, run)
  const listed = async (caller: RunRecord, ...changes: Change[]) =>
    (required(await apiWith(tableWith(...changes)).list({}, callerFor(caller))) as { run: string }[]).map((entry) => entry.run).toSorted()
  const descendants = { agent: parent.role, id: "perm:team_list:runs.descendants", enabled: true }
  const others = { agent: parent.role, id: "perm:team_list:runs.others", enabled: true }

  expect(await listed(parent)).toEqual([parent.id, child.id].toSorted())
  expect(await listed(parent, descendants)).toEqual([parent.id, child.id, grandchild.id].toSorted())
  expect(await listed(parent, others)).toEqual([parent.id, child.id, stranger.id, planner.id].toSorted())
  expect(await listed(parent, descendants, others)).toEqual([parent.id, child.id, grandchild.id, stranger.id, planner.id].toSorted())
  // The planner preset turns its rows on: it lists every run.
  expect(await listed(planner)).toEqual([parent.id, child.id, grandchild.id, stranger.id, planner.id].toSorted())
})

test("followup reaches a grandchild only while the caller's Deeper descendants row for team_followup is on", async () => {
  const parent = baseRun({ id: "main-0123456789abcdef", role: "opus-orchestrator", kind: "main", children: ["w-aaaaaaaaaaaaaaaa"], sessionID: "ses_orchestrator" })
  const child = working({ id: "w-aaaaaaaaaaaaaaaa", role: "opus-orchestrator", parent: parent.id, children: ["w-bbbbbbbbbbbbbbbb"] })
  const grandchild = working({ id: "w-bbbbbbbbbbbbbbbb", role: "gemini-implementer", parent: child.id })
  for (const run of [parent, child, grandchild]) await saveRun(root, run)
  const prompt = "Scope now includes docs/*, continue in place."

  const refused = rejected(await apiWith(tableWith()).followup({ run: grandchild.id, requestID: "f-1", prompt }, callerFor(parent)))
  expect(refused.code).toBe("E_NOT_CHILD")
  expect(refused.accepted).toEqual([child.id])
  const deeper = tableWith({ agent: parent.role, id: "perm:team_followup:runs.descendants", enabled: true })
  expect(required(await apiWith(deeper).followup({ run: grandchild.id, requestID: "f-2", prompt }, callerFor(parent)))).toEqual({ attempt: 1, state: "queued" })
  // A direct child needs no row.
  expect(required(await apiWith(tableWith()).followup({ run: child.id, requestID: "f-3", prompt }, callerFor(parent)))).toEqual({ attempt: 1, state: "queued" })
})

test("a planner-preset target accepts plan files only, by its own Plan files only row", async () => {
  const repo = await makeRepo()
  const build = baseRun({ id: "main-0123456789abcdef", role: "ocp-build", kind: "main", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_build" })
  await saveRun(root, build)
  const api = apiWith(tableWith())
  const plan = (requestID: string, paths: readonly string[]) => brief({ requestID, role: "fable-planner", deliverable: { kind: "plan" }, scope: { paths }, checks: [] })
  const outside = rejected(await api.delegate(plan("plan-1", ["packages/plus/src/*"]), callerFor(build)))
  expect(outside.code).toBe("E_PATHS")
  expect(outside.message).toBe(
    "fable-planner accepts plan files only: every scope path must match one of its patterns [docs/plans/*, docs/handoffs/*]; outside them: [packages/plus/src/*].",
  )
  expect(outside.accepted).toEqual(["docs/plans/*", "docs/handoffs/*"])
  expect(rejected(await api.delegate(plan("plan-2", ["docs/plans/p.md", "src/a.ts"]), callerFor(build))).code).toBe("E_PATHS")
  const planned = required(await api.delegate(plan("plan-3", ["docs/plans/*"]), callerFor(build))) as { run: string }
  const record = await loadRun(root, planned.run)
  expect(record?.role).toBe("fable-planner")
  expect(record?.paths).toEqual(["docs/plans/*"])
  // Off, the same planner takes any scope.
  const open = apiWith(tableWith({ agent: "fable-planner", id: "perm:team_get_context:accepts.plan-files", enabled: false }))
  expect(required(await open.delegate(plan("plan-4", ["packages/plus/src/*"]), callerFor(build)))).toMatchObject({ state: "starting" })
}, 30000)
