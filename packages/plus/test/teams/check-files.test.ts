// A check judges a run only while the run cannot rewrite what the check runs.
// team_checkpoint's "Requirements for a commit" rows: with "Files its checks
// run stay unchanged" on (a Basic implementer) a run commits none of them
// unless its Brief's scope.paths names the file itself; with "Only files it may
// edit" on (a Basic orchestrator) a delegated run commits only what its edit
// rows allow, its tests and plan files. Each test runs the real handler in a
// real repository with the row on, then off.
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { teamsDataDir } from "../../src/instructions/paths.js"
import { decide, editRefusal, type PermissionTable } from "../../src/instructions/permission-enforce.js"
import { createTeamApi, type TeamApiResult, type TeamCaller } from "../../src/teams/api.js"
import { checkFiles, missingCheckFiles } from "../../src/teams/check-files.js"
import { git } from "../../src/teams/git.js"
import { saveRun, type RunRecord } from "../../src/teams/run.js"
import type { Check } from "../../src/teams/schema.js"
import { context } from "../harness.js"
import { change, linked, presetTable, teamState, type TeamMember } from "./preset-table.js"

// ocp-alice has no preset: every row a test does not turn on is off.
const seat = linked("ocp-build", "build-seat")
const alice: TeamMember = { id: "ocp-alice", team: "opencodeplus-team" }

function tableWith(...rows: readonly [string, "on" | "off"][]): PermissionTable {
  return presetTable({ members: [seat, alice], records: rows.map(([item, state]) => change(alice, item, { state })) })
}

let tmp = ""
let root = ""
const priorDataHome = process.env.XDG_DATA_HOME

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plus-check-files-"))
  process.env.XDG_DATA_HOME = tmp
  root = teamsDataDir()
})

afterEach(async () => {
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  if (priorDataHome !== undefined) process.env.XDG_DATA_HOME = priorDataHome
  await fs.rm(tmp, { recursive: true, force: true })
})

const files: Record<string, string> = {
  "package.json": '{ "scripts": { "typecheck": "tsc" } }\n',
  "packages/plus/package.json": '{ "scripts": { "typecheck": "tsc" } }\n',
  "scripts/check.sh": "exit 0\n",
  "src/value.ts": "export const value = 1\n",
  "test/value.test.ts": "test('value', () => {})\n",
  "test/other.test.ts": "test('other', () => {})\n",
  "test/unit/a.test.ts": "test('a', () => {})\n",
}

async function makeRepo(dir = path.join(tmp, "repo")): Promise<{ dir: string; head: string }> {
  await fs.mkdir(dir, { recursive: true })
  await git(dir, ["init"])
  await git(dir, ["config", "user.name", "check-files"])
  await git(dir, ["config", "user.email", "check-files@local"])
  for (const [file, text] of Object.entries(files)) await Bun.write(path.join(dir, file), text)
  await git(dir, ["add", "."])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  return { dir, head: await git(dir, ["rev-parse", "HEAD"]) }
}

function recordSession(): SessionDomain {
  return {
    create: () => Effect.succeed({ id: Session.ID.make("ses_check_files") }),
    prompt: () => Effect.succeed(undefined as never),
    wait: () => Effect.succeed(undefined),
  } as unknown as SessionDomain
}

// alice's delegated run in `repo`, with these checks and this Brief scope.
async function aliceRun(repo: { dir: string; head: string }, checks: readonly Check[], paths: readonly string[]): Promise<RunRecord> {
  const now = new Date().toISOString()
  const record: RunRecord = {
    id: "w-aaaaaaaaaaaaaaaa",
    kind: "w",
    role: alice.id,
    repo: "opencode",
    repoKey: "opencode",
    directory: repo.dir,
    paths: [...paths],
    branch: "team/test",
    base: repo.head,
    head: repo.head,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    task: null,
    parent: "main-0123456789abcdef",
    children: [],
    briefSha: "abc",
    bundle: "check-files-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: "ses_alice",
    configDigest: null,
    history: [],
  }
  await saveRun(root, record)
  await Bun.write(path.join(root, "runs", record.id, "checks.json"), JSON.stringify(checks))
  await Bun.write(path.join(root, "runs", record.id, "brief.json"), JSON.stringify({ scope: { paths, forbidden: [] } }))
  return record
}

function callerFor(record: RunRecord): TeamCaller {
  return { sessionID: String(record.sessionID), agent: record.role, run: record }
}

async function checkpoint(table: PermissionTable, record: RunRecord, changed: readonly string[]): Promise<TeamApiResult> {
  for (const file of changed) await Bun.write(path.join(record.directory, file), `${files[file] ?? ""}// changed\n`)
  const head = await git(record.directory, ["rev-parse", "HEAD"])
  const api = createTeamApi(context({ session: recordSession() }), teamState(table))
  return api.checkpoint({ expectedHead: head, files: [...changed], message: "test: change files" }, callerFor(record))
}

const lock = (state: "on" | "off") => tableWith(["perm:team_checkpoint:requirements.check-files", state])

test("a check's files: what bun test names, what the base holds under a named directory, package.json for run, path arguments", async () => {
  const repo = await makeRepo()
  const checks: Check[] = [
    { id: "value", argv: ["bun", "test", "test/value.test.ts", "test/new.test.ts"] },
    { id: "unit", argv: ["bun", "test", "test/unit"] },
    { id: "types", argv: ["bun", "run", "typecheck"], cwd: "packages/plus" },
    { id: "script", argv: ["./scripts/check.sh", "--fast"] },
    // Neither a bare word nor the checkout root nor a path outside it is a file.
    { id: "make", argv: ["make", "test"] },
    { id: "all", argv: ["pytest", "."] },
    { id: "outside", argv: ["pytest", "../elsewhere/x.py"] },
  ]
  expect([...(await checkFiles(repo.dir, repo.head, checks))].toSorted()).toEqual(
    ["packages/plus/package.json", "scripts/check.sh", "test/new.test.ts", "test/unit/a.test.ts", "test/value.test.ts"].toSorted(),
  )
})

// Item 1: a check naming a file the base does not hold is what refuses a
// delegation. missingCheckFiles reports exactly the missing `bun test` paths,
// treating a base-held directory as present (new files under it are free).
test("missingCheckFiles reports only the bun test paths the base does not hold", async () => {
  const repo = await makeRepo()
  const checks: Check[] = [
    { id: "value", argv: ["bun", "test", "test/value.test.ts", "test/absent.test.ts"] },
    { id: "unit", argv: ["bun", "test", "test/unit"] },
    { id: "run", argv: ["bun", "run", "typecheck"] },
  ]
  expect(await missingCheckFiles(repo.dir, repo.head, checks)).toEqual([{ id: "value", file: "test/absent.test.ts" }])
})

test("Files its checks run stay unchanged: on refuses committing the test a check runs and the package.json it reads, off commits them", async () => {
  const checks: Check[] = [
    { id: "value", argv: ["bun", "test", "test/value.test.ts"] },
    { id: "types", argv: ["bun", "run", "typecheck"], cwd: "packages/plus" },
  ]
  const repo = await makeRepo()
  const record = await aliceRun(repo, checks, ["src/*", "test/*", "packages/*"])
  for (const file of ["test/value.test.ts", "packages/plus/package.json"]) {
    const refused = await checkpoint(lock("on"), record, [file])
    if (refused.ok) throw new Error(`expected a refusal for ${file}`)
    expect(refused.error.code).toBe("E_SCOPE")
    expect(refused.error.message).toContain(`"${file}" is a file your checks run`)
    expect(refused.error.message).toContain(`needs=[{kind:"path",detail:"${file}: why it must change"}]`)
  }
  // What the checks do not run commits as before.
  expect(await checkpoint(lock("on"), record, ["src/value.ts"])).toMatchObject({ ok: true, value: { committed: true } })
  // Off: the same test commits.
  expect(await checkpoint(lock("off"), record, ["test/value.test.ts"])).toMatchObject({ ok: true, value: { committed: true } })
})

test("scope.paths naming the file itself hands it over; a dir/* entry does not, and a new test beside the checked ones stays free", async () => {
  const checks: Check[] = [{ id: "tests", argv: ["bun", "test", "test"] }]
  const repo = await makeRepo()
  const broad = await aliceRun(repo, checks, ["test/*"])
  const refused = await checkpoint(lock("on"), broad, ["test/other.test.ts"])
  expect(refused.ok).toBe(false)
  expect(await checkpoint(lock("on"), broad, ["test/extra.test.ts"])).toMatchObject({ ok: true, value: { committed: true } })
  const named = await aliceRun(repo, checks, ["test/*", "test/other.test.ts"])
  expect(await checkpoint(lock("on"), named, ["test/other.test.ts"])).toMatchObject({ ok: true, value: { committed: true } })
})

test("Only files it may edit: on keeps a delegated run's commits to what its edit rows allow, off to its scope", async () => {
  const testsOnly: [string, "on" | "off"][] = [
    ["perm:edit:allowed.*", "off"],
    ["perm:edit:allowed.tests", "on"],
    ["perm:edit:protected.tests", "on"],
  ]
  const repo = await makeRepo()
  const record = await aliceRun(repo, [], ["src/*", "test/*"])
  const refused = await checkpoint(tableWith(...testsOnly, ["perm:team_checkpoint:requirements.editable", "on"]), record, ["src/value.ts"])
  if (refused.ok) throw new Error("expected a refusal for src/value.ts")
  expect(refused.error.code).toBe("E_SCOPE")
  expect(refused.error.message).toContain(`"src/value.ts" is not a file ${alice.id} may edit`)
  expect(await checkpoint(tableWith(...testsOnly, ["perm:team_checkpoint:requirements.editable", "on"]), record, ["test/value.test.ts"])).toMatchObject({
    ok: true,
    value: { committed: true },
  })
  expect(await checkpoint(tableWith(...testsOnly, ["perm:team_checkpoint:requirements.editable", "off"]), record, ["src/value.ts"])).toMatchObject({
    ok: true,
    value: { committed: true },
  })
})

test("a Basic orchestrator edits tests and plan files only; a Basic implementer edits anything in scope", () => {
  const orchestrator = linked("orchestrator", "orchestrator")
  const implementer = linked("implementer", "implementer")
  const table = presetTable({ members: [orchestrator, implementer] })
  const dir = "/work/repo"
  expect(editRefusal(table, orchestrator.id, dir, "packages/plus/test/value.test.ts")).toBeUndefined()
  expect(editRefusal(table, orchestrator.id, dir, `${dir}/src/value.spec.tsx`)).toBeUndefined()
  expect(editRefusal(table, orchestrator.id, dir, "docs/plans/x.md")).toBeUndefined()
  expect(editRefusal(table, orchestrator.id, dir, "packages/plus/src/value.ts")).toContain("not one you may change")
  expect(editRefusal(table, implementer.id, dir, "packages/plus/src/value.ts")).toBeUndefined()
})

// A team run worktree lives under ~/.local/share/opencodeplus/teams/worktrees/,
// so every absolute path in it holds /teams/. Protected rows name one resource:
// the checkout-relative path, as core's file access does.
test("Agent and team definitions refuses a project's team definitions, not every Markdown file in a worktree under .../teams/", () => {
  const implementer = linked("implementer", "implementer")
  const table = presetTable({
    members: [implementer],
    records: [
      // The outside path reaches the protected rows; "Where" is left open for it.
      change(implementer, "perm:edit:where.outside", { state: "on" }),
      change(implementer, "perm:edit:protected.team-state", { state: "on" }),
      change(implementer, "perm:edit:protected.agent-definitions", { state: "off" }),
    ],
  })
  const dir = "/home/u/.local/share/opencodeplus/teams/worktrees/repo/implementer/w-1"
  expect(editRefusal(table, implementer.id, dir, "tools/archive/status.md")).toBeUndefined()
  expect(editRefusal(table, implementer.id, dir, "docs/teams/guide.md")).toBeUndefined()
  expect(editRefusal(table, implementer.id, dir, ".opencodeplus/teams/crew/member.md")).toContain("Agent and team definitions")
  expect(editRefusal(table, implementer.id, dir, "sub/.opencodeplus/teams/crew/member.md")).toContain("Agent and team definitions")
  expect(editRefusal(table, implementer.id, dir, "/home/u/.config/opencodeplus/agents/x.md")).toContain("Agent and team definitions")
  // The same holds when the checkout itself sits under such a folder.
  expect(editRefusal(table, implementer.id, "/home/u/.opencodeplus/teams/worktrees/x", "tools/archive/status.md")).toBeUndefined()
})

test("a delegated run in a worktree under .../teams/ commits a plain Markdown file in scope", async () => {
  const table = tableWith(
    ["perm:team_checkpoint:requirements.editable", "on"],
    ["perm:edit:allowed.*", "on"],
    ["perm:edit:protected.agent-definitions", "off"],
  )
  const inTeams = await makeRepo(path.join(tmp, "teams", "worktrees", "repo", "implementer", "w-1"))
  expect(await checkpoint(table, await aliceRun(inTeams, [], ["notes/*"]), ["notes/status.md"])).toMatchObject({ ok: true, value: { committed: true } })
  // And when the checkout's own path matches a protected row's pattern.
  const nested = await makeRepo(path.join(tmp, ".opencodeplus", "teams", "worktrees", "repo", "implementer", "w-2"))
  expect(await checkpoint(table, await aliceRun(nested, [], ["notes/*"]), ["notes/status.md"])).toMatchObject({ ok: true, value: { committed: true } })
})

test("a Basic orchestrator removes only its own files with rm, one plain path each, never recursively; others keep rm as it was", () => {
  const orchestrator = linked("orchestrator", "orchestrator")
  const table = presetTable({ members: [orchestrator, seat] })
  const dir = "/work/repo"
  const rm = (agent: string, command: string, workdir?: string) =>
    decide(table.toolRows(agent, "shell"), {
      tool: "shell",
      input: { command, ...(workdir === undefined ? {} : { workdir }) },
      sessionID: "",
      agent,
      directory: dir,
      teamMembers: table.teamMembers,
      editRefusal: (file) => editRefusal(table, agent, dir, file),
    }).refuse
  // Its Brief, handoff, plan and test files, alone or in a list, quiet or not.
  expect(rm(orchestrator.id, "rm docs/handoffs/t1.md docs/plans/plan.md")).toBeUndefined()
  expect(rm(orchestrator.id, "rm -f docs/handoffs/t1.md && git status")).toBeUndefined()
  expect(rm(orchestrator.id, "rm -- test/old.test.ts > /dev/null 2>&1")).toBeUndefined()
  expect(rm(orchestrator.id, "rm handoffs/t1.md", "docs")).toBeUndefined()
  // Anything else, wherever the rm sits in the command.
  expect(rm(orchestrator.id, "rm src/cli.ts")).toContain("rm removes only files you may change here")
  expect(rm(orchestrator.id, "rm docs/handoffs/t1.md src/cli.ts")).toContain('"src/cli.ts"')
  expect(rm(orchestrator.id, "echo ok; rm src/cli.ts")).toContain('"src/cli.ts"')
  expect(rm(orchestrator.id, "echo $(rm src/cli.ts)")).toContain('"src/cli.ts"')
  expect(rm(orchestrator.id, "/bin/rm src/cli.ts")).toContain('"src/cli.ts"')
  expect(rm(orchestrator.id, "rm /etc/hosts")).toContain("outside this checkout")
  // What a check cannot read: globs, expansions, climbing paths, a cd first.
  expect(rm(orchestrator.id, "rm docs/handoffs/*")).toContain("not a plain path")
  expect(rm(orchestrator.id, "rm docs/plans/../../src/cli.ts")).toContain("not a plain path")
  expect(rm(orchestrator.id, "rm docs/plans/{a.md,../../src/cli.ts}")).toContain("not a plain path")
  expect(rm(orchestrator.id, "rm $HOME/x")).toContain("not a plain path")
  expect(rm(orchestrator.id, "cd src && rm cli.ts")).toContain("after cd")
  // Remove files is on for it, recursive force removal off (core refuses rm -rf).
  const shellRule = (agent: string, id: string) => table.ruleRows(agent, "shell").find((row) => row.item.ruleId === id)?.on
  expect([shellRule(orchestrator.id, "rm"), shellRule(orchestrator.id, "rm-rf")]).toEqual([true, false])
  // The build seat's rm is not limited to its editable files (the row ships off).
  expect(rm(seat.id, "rm src/cli.ts")).toBeUndefined()
})
