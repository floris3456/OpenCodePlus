// Every former hidden team rule (DESIGN §6) is a row now. Each test here takes
// one row of a member with no preset (so everything else it has is off) and
// runs the real handler with the row on and with it off. Permission rows
// allow while on and refuse with their own words while off; requirement rows
// ("Briefs it accepts", "Brief limits", "Requirements for done") demand while
// on and demand nothing while off.
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { apply } from "../../src/instructions/apply.js"
import { teamsDataDir } from "../../src/instructions/paths.js"
import type { PermissionTable } from "../../src/instructions/permission-enforce.js"
import { createTeamApi, type TeamApiResult, type TeamCaller } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { bySession, loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Brief } from "../../src/teams/schema.js"
import { registerTeamTools } from "../../src/teams/tools.js"
import { agentHarness, agentInfo, context, toolHarness } from "../harness.js"
import { change, linked, presetInput, presetTable, teamState, type TeamMember } from "./preset-table.js"

// A build seat that may delegate to every teammate, and ocp-alice with no
// preset: every shared row of hers is off until a test turns one on.
const seat = linked("ocp-build", "build-seat")
const alice: TeamMember = { id: "ocp-alice", team: "opencodeplus-team" }
const members = [seat, alice]

function tableWith(...rows: readonly [string, "on" | "off", string?][]): PermissionTable {
  return presetTable({
    members,
    records: rows.map(([item, state, text]) => change(alice, item, { state, ...(text === undefined ? {} : { text }) })),
  })
}

let tmp = ""
let root = ""
const priorDataHome = process.env.XDG_DATA_HOME

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plus-former-rules-"))
  process.env.XDG_DATA_HOME = tmp
  root = teamsDataDir()
})

afterEach(async () => {
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  if (priorDataHome !== undefined) process.env.XDG_DATA_HOME = priorDataHome
  await fs.rm(tmp, { recursive: true, force: true })
})

function recordSession(): SessionDomain {
  let seq = 0
  return {
    create: () => {
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_former_${seq}`) })
    },
    prompt: () => Effect.succeed(undefined as never),
    wait: () => Effect.succeed(undefined),
  } as unknown as SessionDomain
}

function apiWith(table: PermissionTable) {
  return createTeamApi(context({ session: recordSession() }), teamState(table))
}

function run(overrides: Partial<RunRecord> & { id: string; role: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    kind: "main",
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
    bundle: "former-rules-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function callerFor(record: RunRecord): TeamCaller {
  return { sessionID: String(record.sessionID ?? "ses_unknown"), agent: record.role, run: record }
}

function brief(overrides: Record<string, unknown>): Brief {
  return Schema.decodeUnknownSync(Brief)({
    requestID: "req-1",
    role: alice.id,
    objective: "Fix the agent filter in the query module so scoped listing works as documented.",
    deliverable: { kind: "commit" },
    scope: { paths: ["packages/plus/src/*"] },
    checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] }],
    ...overrides,
  })
}

function rejected(result: TeamApiResult) {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`)
  return result.error
}

function required(result: TeamApiResult): unknown {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

async function makeRepo(): Promise<{ dir: string; head: string }> {
  const dir = path.join(tmp, "repo")
  await fs.mkdir(dir)
  await git(dir, ["init"])
  await git(dir, ["config", "user.name", "former-rules"])
  await git(dir, ["config", "user.email", "former-rules@local"])
  await Bun.write(path.join(dir, "README.md"), "# former rules\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  return { dir, head: await git(dir, ["rev-parse", "HEAD"]) }
}

// The build seat's root run in a real repository, ready to delegate to alice.
async function seatRun() {
  const repo = await makeRepo()
  const parent = run({ id: "main-0123456789abcdef", role: seat.id, directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_seat" })
  await saveRun(root, parent)
  return parent
}

// Delegates `brief` to alice with her row `item` on, then off: on must refuse
// with `code` and the row's words, off must start the run.
async function targetRow(item: string, input: Brief, code: string, words: string, text?: string) {
  const parent = await seatRun()
  const refusal = rejected(await apiWith(tableWith([item, "on", text])).delegate({ ...input, requestID: `${item}-on` }, callerFor(parent)))
  expect([item, refusal.code]).toEqual([item, code])
  expect(refusal.message).toContain(words)
  expect(refusal.message.startsWith(`${alice.id} `)).toBe(true)
  const started = required(await apiWith(tableWith([item, "off"])).delegate({ ...input, requestID: `${item}-off` }, callerFor(parent))) as { run: string }
  expect((await loadRun(root, started.run))?.role).toBe(alice.id)
}

test("Scope paths for a commit: on refuses a commit brief with no scope.paths, off accepts it", async () => {
  await targetRow("perm:team_get_context:accepts.scope-paths", brief({ scope: { paths: [] } }), "E_PATHS", "needs scope.paths (files or dir/* it may edit) for a commit deliverable")
}, 30000)

test("A reason: on refuses a brief without a reason, off accepts it", async () => {
  await targetRow("perm:team_get_context:accepts.reason", brief({}), "E_REASON", "needs a reason: say why this member and not another")
}, 30000)

test("A check: on refuses a brief without checks, off accepts it", async () => {
  await targetRow("perm:team_get_context:accepts.check", brief({ checks: [] }), "E_BRIEF", "needs at least one check")
}, 30000)

test("Plan files only: on refuses a scope outside its patterns, off accepts it", async () => {
  await targetRow("perm:team_get_context:accepts.plan-files", brief({ deliverable: { kind: "plan" } }), "E_PATHS", "accepts plan files only")
}, 30000)

test("Paths per brief: on (5) refuses a sixth scope path, off accepts it; the number is the row's text", async () => {
  const six = brief({ scope: { paths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"] } })
  await targetRow("perm:team_get_context:limits.paths", six, "E_BRIEF", "accepts at most 5 scope paths per brief (Brief limits → Paths per brief); this brief has 6")
  const parent = await loadRun(root, "main-0123456789abcdef")
  if (parent === undefined) throw new Error("no seat run")
  const seven = tableWith(["perm:team_get_context:limits.paths", "on", "7"])
  expect(required(await apiWith(seven).delegate({ ...six, requestID: "paths-7" }, callerFor(parent)))).toMatchObject({ state: "starting" })
}, 30000)

test("Checks per brief: on (1) refuses a second check, off accepts it", async () => {
  const two = brief({
    checks: [
      { id: "a", argv: ["bun", "test", "a.test.ts"] },
      { id: "b", argv: ["bun", "test", "b.test.ts"] },
    ],
  })
  await targetRow("perm:team_get_context:limits.checks", two, "E_BRIEF", "accepts at most 1 checks per brief (Brief limits → Checks per brief); this brief has 2")
}, 30000)

test("Corrections by followup: off refuses a correction with its words, on queues it", async () => {
  const parent = run({ id: "main-0123456789abcdef", role: seat.id, children: ["w-aaaaaaaaaaaaaaaa"], sessionID: "ses_seat" })
  const child = run({
    id: "w-aaaaaaaaaaaaaaaa",
    kind: "w",
    role: alice.id,
    parent: parent.id,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
    sessionID: "ses_alice",
  })
  await saveRun(root, parent)
  await saveRun(root, child)
  const prompt = "Tighten the error message."
  const refused = rejected(await apiWith(tableWith(["perm:team_get_context:accepts.followup", "off"])).followup({ run: child.id, requestID: "f-1", prompt }, callerFor(parent)))
  expect(refused.code).toBe("E_NO_FOLLOWUP")
  expect(refused.message).toStartWith(`${alice.id} takes no corrections by followup: delegate a fresh run`)
  expect(required(await apiWith(tableWith(["perm:team_get_context:accepts.followup", "on"])).followup({ run: child.id, requestID: "f-2", prompt }, callerFor(parent)))).toEqual({ attempt: 1, state: "queued" })
})

test("Delegate from a delegated run: off refuses a delegated run's delegation with its words, on lets it through", async () => {
  const repo = await makeRepo()
  const own = run({ id: "w-aaaaaaaaaaaaaaaa", kind: "w", role: alice.id, parent: "main-0123456789abcdef", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_alice" })
  await saveRun(root, own)
  const toSeat = ["perm:team_delegate:to.ocp-build", "on"] as const
  const task = brief({ role: seat.id, deliverable: { kind: "report" }, scope: { paths: [] }, checks: [] })
  const refused = rejected(await apiWith(tableWith([...toSeat], ["perm:team_delegate:access.delegated", "off"])).delegate(task, callerFor(own)))
  expect(refused.code).toBe("E_ROLE")
  expect(refused.message).toBe(`${alice.id}: a delegated run of yours may not delegate further; finish with needs=[{kind:"decision",...}] instead`)
  const started = required(await apiWith(tableWith([...toSeat], ["perm:team_delegate:access.delegated", "on"])).delegate({ ...task, requestID: "req-2" }, callerFor(own))) as { run: string }
  expect((await loadRun(root, started.run))?.parent).toBe(own.id)
}, 30000)

test("Worktree committed before done: on refuses done with uncommitted changes, off records it", async () => {
  const repo = await makeRepo()
  await Bun.write(path.join(repo.dir, "dirty.txt"), "uncommitted\n")
  const own = run({
    id: "w-aaaaaaaaaaaaaaaa",
    kind: "w",
    role: alice.id,
    parent: "main-0123456789abcdef",
    directory: repo.dir,
    base: repo.head,
    head: repo.head,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
    sessionID: "ses_alice",
  })
  await saveRun(root, own)
  const report = { status: "done" as const, summary: "Work is complete and checked.", concerns: [], needs: [], findings: [], deferred: [] }
  const refused = rejected(await apiWith(tableWith(["perm:team_finish:requirements.clean", "on"])).finish(report, callerFor(own)))
  expect(refused.code).toBe("E_DIRTY")
  expect(refused.message).toContain("dirty.txt")
  expect(required(await apiWith(tableWith(["perm:team_finish:requirements.clean", "off"])).finish(report, callerFor(own)))).toMatchObject({ status: "done", dirty: true })
}, 30000)

// ── the bootstrap row, through the registered tools ─────────────────────────

async function registered(table: PermissionTable, directory: string) {
  const tools = toolHarness()
  const absolute = AbsolutePath.make(directory)
  const ctx = context({
    tool: tools.domain,
    location: new Location.Info({ directory: absolute, project: { id: Project.ID.global, directory: absolute, canonical: absolute } }),
  })
  await registerTeamTools(ctx, createTeamApi(ctx, teamState(table)), () => table)
  const status = tools.tools.get("team_status")
  if (status === undefined) throw new Error("team_status is not registered")
  return status
}

function toolContext(sessionID: string, agent: string): Tool.Context {
  return {
    sessionID: Session.ID.make(sessionID),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_former_rules"),
    id: Tool.CallID.make("call_former_rules"),
    progress: () => Effect.void,
  }
}

test("Start a team run from a chat: off refuses a chat's first team call with its words, on starts the member's own run", async () => {
  const repo = await makeRepo()
  const off = await registered(tableWith(["perm:team_get_context:bootstrap.chat", "off"]), repo.dir)
  const refused = await Effect.runPromise(
    off.execute({}, toolContext("ses_alice_chat", alice.id)).pipe(
      Effect.map(() => ""),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed(error.message)),
    ),
  )
  expect(refused).toBe(
    `E_NOT_ACTOR: This session is not the owner of run unknown. Call team tools from the run's own chat; do not session_move. You do not start a team run from a chat; team tools work only inside a run delegated to you (team_get_context → Team runs → Start a team run from a chat).`,
  )
  expect(await bySession(root, "ses_alice_chat")).toBeUndefined()
  const on = await registered(tableWith(["perm:team_get_context:bootstrap.chat", "on"]), repo.dir)
  await Effect.runPromise(on.execute({}, toolContext("ses_alice_chat", alice.id)))
  const started = await bySession(root, "ses_alice_chat")
  expect([started?.role, started?.kind, started?.parent]).toEqual([alice.id, "main", null])
}, 30000)

// ── rows installed as core rules or tool plans ──────────────────────────────

async function appliedFor(...rows: readonly [string, "on" | "off"][]) {
  const agents = agentHarness([agentInfo(alice.id, "upstream")])
  const applied = await apply(
    context({ agent: agents.domain, session: { hook: () => Effect.succeed({ dispose: Effect.void }) } }),
    presetInput({ members, records: rows.map(([item, state]) => change(alice, item, { state })) }),
  )
  return { rules: agents.state.get(alice.id)?.permissions ?? [], tools: applied.tools.filter((plan) => plan.agent === alice.id) }
}

test("read's secret Files rows and Where for every tool: off installs the core deny with its words, on installs none", async () => {
  const { evaluate } = await import("../../../core/src/permission.js")
  const secrets = [
    ["perm:read:files.keys", "secret.key", "Private keys cannot be read here"],
    ["perm:read:files.credentials", "home/.netrc", "Credential stores cannot be read here"],
    ["perm:read:files.opencode-config", "/home/x/.config/opencodeplus/opencode.json", "Provider config and service passwords cannot be read here"],
    ["perm:read:files.run-configs", "/w/run/team/ns/runs/r1/config/opencode.json", "Frozen team run configs cannot be read here"],
    ["perm:read:files.databases", "data/opencode.db", "Session databases (*.db, *.sqlite) cannot be read here"],
    ["perm:read:env", "app/.env", ".env files cannot be read here"],
  ] as const
  const closed = await appliedFor(...secrets.map(([item]) => [item, "off"] as [string, "off"]), ["perm:read:where.external", "off"])
  for (const [item, file, words] of secrets) expect([item, evaluate("read", file, closed.rules)]).toMatchObject([item, { effect: "deny", message: words }])
  expect(evaluate("external_directory", "/etc/hosts", closed.rules)).toMatchObject({ effect: "deny", message: "paths outside this checkout are not available here" })
  const open = await appliedFor(...secrets.map(([item]) => [item, "on"] as [string, "on"]), ["perm:read:where.external", "on"])
  for (const [item, file] of secrets) expect([item, evaluate("read", file, open.rules).effect]).not.toEqual([item, "deny"])
  expect(evaluate("external_directory", "/etc/hosts", open.rules).effect).not.toBe("deny")
})

test("tool rows are the ceiling: a team tool, shell, question, subagent and Tavily off leave the member's tools, on keep them", async () => {
  const tools = ["tool:team_delegate", "tool:team_list", "tool:shell", "tool:question", "tool:subagent", "tool:search_tavily_search", "tool:search_tavily_extract"]
  const off = await appliedFor(...tools.map((item) => [item, "off"] as [string, "off"]))
  expect(off.tools.filter((plan) => !plan.enabled && tools.includes(`tool:${plan.tool}`)).map((plan) => `tool:${plan.tool}`).toSorted()).toEqual(tools.toSorted())
  const on = await appliedFor(...tools.map((item) => [item, "on"] as [string, "on"]))
  expect(on.tools.filter((plan) => tools.includes(`tool:${plan.tool}`) && !plan.enabled)).toEqual([])
})
