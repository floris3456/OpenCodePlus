import { expect, test } from "bun:test"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { initRepo } from "../../../core/test/fixture/git.js"
import { context } from "../harness.js"
import { change, presetTable, shippedMembers, teamState } from "./preset-table.js"
import { decide, enforcementState, installEnforcement, type PermissionTable } from "../../src/instructions/permission-enforce.js"
import { liveRunScopes, teamPolicyItems, type PolicyRun } from "../../src/instructions/team-policy-rows.js"
import { teamsDataDir } from "../../src/instructions/paths.js"
import { createTeamApi, type TeamApiResult, type TeamCaller } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { childSettledText } from "../../src/teams/lifecycle.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Brief, FollowupInput, Report } from "../../src/teams/schema.js"
import { atomicJson, readJson } from "../../src/teams/store.js"

function required<T>(result: TeamApiResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

function rejected(result: TeamApiResult) {
  if (result.ok) throw new Error(`expected refusal: ${JSON.stringify(result.value)}`)
  return result.error
}

async function fixture(table: PermissionTable = presetTable()) {
  const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-followup-scope-"))
  const main = path.join(tmp, "main")
  const directory = path.join(tmp, "child")
  await fs.mkdir(main)
  await initRepo(main)
  const head = await git(main, ["rev-parse", "HEAD"])
  await git(main, ["worktree", "add", "-q", "-b", "child", directory])
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp
  const root = teamsDataDir()
  const now = new Date().toISOString()
  const child: RunRecord = {
    id: "w-aaaaaaaaaaaaaaaa", role: "implementer", kind: "w", repo: "fixture", repoKey: "fixture",
    directory, paths: ["docs/plans/one.md"], branch: "child", base: head, head,
    state: "working", attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    task: null, parent: "main-bbbbbbbbbbbbbbbb", children: [], briefSha: "fixture", bundle: "fixture",
    budget: {}, createdAt: now, lastUsed: now, sessionID: "ses_scope_child", configDigest: null, history: [],
  }
  const parent: RunRecord = { ...child, id: child.parent!, role: "build-seat", kind: "main", directory: main, parent: null, children: [child.id], sessionID: "ses_scope_parent" }
  const brief = Schema.decodeUnknownSync(Brief)({
    requestID: "initial", role: child.role, objective: "Wire the command into the CLI entry point.",
    deliverable: { kind: "commit" }, scope: { paths: child.paths, forbidden: ["src/private/*"] },
  })
  await saveRun(root, parent)
  await saveRun(root, child)
  const briefPath = path.join(root, "runs", child.id, "brief.json")
  await atomicJson(briefPath, brief)
  const prompts: string[] = []
  const order: string[] = []
  const published: PolicyRun[][] = []
  const hooks: Array<(event: PermissionEvaluation) => Effect.Effect<void>> = []
  const base = context()
  const ctx = context({
    session: {
      get: () => Effect.succeed({ id: Session.ID.make(child.sessionID!) } as never),
      prompt: (input) => Effect.sync(() => { order.push("prompt"); prompts.push(input.text); return undefined as never }),
    },
    agent: { ...base.agent, reload: () => Effect.promise(async () => { published.push(await liveRunScopes(root)); order.push("reload") }) },
    tool: { ...base.tool, hook: () => Effect.succeed({ dispose: Effect.void }) },
    shell: { hook: () => Effect.succeed({ dispose: Effect.void }) },
    permission: { ...base.permission, hook: (_name, callback) => {
      hooks.push(callback)
      return Effect.succeed({ dispose: Effect.void })
    } },
  })
  const registrations = await installEnforcement(ctx, table, enforcementState(), { headless: async () => false })
  const api = createTeamApi(ctx, teamState(table))
  const caller: TeamCaller = { sessionID: parent.sessionID!, agent: parent.role, run: parent }
  const worker: TeamCaller = { sessionID: child.sessionID!, agent: child.role, run: child }
  const report = required(await api.finish(Schema.decodeUnknownSync(Report)({
    status: "blocked", summary: "The CLI entry point is outside my scope.", needs: [{ kind: "path", detail: "src/cli.ts: wire the command" }],
  }), worker))
  const edit = async (file: string, effect: PermissionEvaluation["effect"] = "allow") => {
    const event: PermissionEvaluation = { sessionID: Session.ID.make(child.sessionID!), action: "edit", resources: [path.join(directory, file)], effect }
    for (const hook of hooks) await Effect.runPromise(hook(event))
    return event
  }
  return {
    root, child, parent, caller, worker, api, brief, briefPath, prompts, published, order, edit, report,
    [Symbol.asyncDispose]: async () => {
      await Effect.runPromise(Effect.all(registrations.map((registration) => registration.dispose)))
      if (prior === undefined) delete process.env.XDG_DATA_HOME
      if (prior !== undefined) process.env.XDG_DATA_HOME = prior
      await fs.rm(tmp, { recursive: true, force: true })
    },
  }
}

test("a blocked child's path need widens live edit and checkpoint scope, publishes it before admission, and replays once", async () => {
  await using f = await fixture()
  expect((await f.edit("src/cli.ts")).effect).toBe("deny")
  expect(rejected(await f.api.checkpoint({ files: ["src/cli.ts"], message: "feat: wire CLI" }, f.worker)).code).toBe("E_SCOPE")
  const input = Schema.decodeUnknownSync(FollowupInput)({ run: f.child.id, requestID: "widen", paths: ["src/cli.ts", "src/cli.ts"], prompt: "Wire it up and rerun the focused checks." })
  expect(required(await f.api.followup(input, f.caller))).toMatchObject({ attempt: 2, state: "admitted" })
  const paths = ["docs/plans/one.md", "src/cli.ts"]
  expect((await readJson<Brief>(f.briefPath))?.scope).toEqual({ paths, forbidden: ["src/private/*"] })
  expect((await loadRun(f.root, f.child.id))?.paths).toEqual(paths)
  expect(f.published).toHaveLength(1)
  expect(f.order).toEqual(["reload", "prompt"])
  const row = teamPolicyItems([{ id: f.child.role }], f.published[0]).find((item) => item.runID === f.child.id)
  expect(row?.patterns).toEqual(paths)
  expect(row?.text).toContain("forbidden [src/private/*]")
  expect(f.prompts).toEqual(["Plus widened your edit scope: you may now also change [src/cli.ts]; forbidden paths still apply.\n\nWire it up and rerun the focused checks."])
  expect((await f.edit("src/cli.ts")).effect).toBe("allow")
  expect((await f.edit("src/cli.ts", "ask")).effect).toBe("ask")
  expect((await f.edit("src/cli.ts", "deny")).effect).toBe("deny")
  expect((await f.edit("src/private/key.ts")).effect).toBe("deny")
  await fs.mkdir(path.join(f.child.directory, "src"))
  await Bun.write(path.join(f.child.directory, "src/cli.ts"), "export const cli = true\n")
  expect(required(await f.api.checkpoint({ files: ["src/cli.ts"], message: "feat: wire CLI" }, f.worker))).toMatchObject({ committed: true })
  expect(await git(f.child.directory, ["show", "HEAD:src/cli.ts"])).toBe("export const cli = true")
  const saved = await loadRun(f.root, f.child.id)
  expect(required(await f.api.followup(input, f.caller))).toMatchObject({ replayed: true })
  expect(await loadRun(f.root, f.child.id)).toEqual(saved)
  expect(f.prompts).toHaveLength(1)
  expect(f.published).toHaveLength(1)
  expect(rejected(await f.api.followup({ ...input, paths: ["src/other.ts"] }, f.caller)).code).toBe("E_REQUEST_ID")
  expect((await readJson<Brief>(f.briefPath))?.scope.paths).toEqual(paths)
})

test("paths alone admits the Plus note and a blocked settlement names paths", async () => {
  await using f = await fixture()
  const settled = await loadRun(f.root, f.child.id)
  expect(childSettledText(settled!, settled!.attempts[0]!, f.report!)).toContain("next: answer the needs with team_followup (paths for a path need), or team_stop it and delegate afresh.")
  expect(required(await f.api.followup(Schema.decodeUnknownSync(FollowupInput)({ run: f.child.id, requestID: "paths-only", paths: ["src/*"] }), f.caller))).toMatchObject({ attempt: 2, state: "admitted" })
  expect(f.prompts).toEqual(["Plus widened your edit scope: you may now also change [src/*]; forbidden paths still apply."])
  expect((await f.edit("src/cli.ts")).effect).toBe("allow")
  expect((await f.edit("src/private/key.ts")).effect).toBe("deny")
})

test("followup refuses invalid, protected, forbidden, ungrantable and unaccepted paths exactly as delegation does", async () => {
  const members = shippedMembers()
  const parent = members.find((member) => member.id === "build-seat")!
  const child = members.find((member) => member.id === "implementer")!
  for (const scenario of [
    { paths: ["../outside.ts"], code: "E_PATHS", records: [] },
    { paths: [".git/config"], code: "E_PATHS", records: [] },
    { paths: [".opencodeplus/*"], code: "E_PATHS", records: [] },
    { paths: ["src/private/key.ts"], code: "E_SCOPE", records: [] },
    { paths: ["src/private/*"], code: "E_SCOPE", records: [] },
    { paths: [".github/workflows/ci.yml"], code: "E_PERMISSION", records: [change(parent, "perm:team_delegate:scope.ci", { state: "off" })] },
    { paths: ["src/cli.ts"], code: "E_PATHS", records: [change(child, "perm:team_get_context:accepts.plan-files", { state: "on" })] },
    { paths: ["src/cli.ts"], code: "E_BRIEF", records: [change(child, "perm:team_get_context:limits.paths", { state: "on", text: "1" })] },
  ]) {
    await using f = await fixture(presetTable({ records: scenario.records }))
    const before = await loadRun(f.root, f.child.id)
    const brief = await Bun.file(f.briefPath).text()
    const followup = rejected(await f.api.followup({ run: f.child.id, requestID: "refused", paths: scenario.paths }, f.caller))
    const delegate = rejected(await f.api.delegate({ ...f.brief, requestID: "refused-delegate", scope: { ...f.brief.scope, paths: [...f.brief.scope.paths, ...scenario.paths] } }, f.caller))
    expect(followup.code).toBe(scenario.code)
    expect(followup).toEqual(delegate)
    expect(await loadRun(f.root, f.child.id)).toEqual(before)
    expect(await Bun.file(f.briefPath).text()).toBe(brief)
    expect(await fs.readdir(path.join(f.root, "requests")).catch(() => [])).toEqual([])
    expect(f.prompts).toEqual([])
    expect(f.published).toEqual([])
  }
})

test("a busy now delivery cannot partially grant paths", async () => {
  await using f = await fixture()
  const current = (await loadRun(f.root, f.child.id))!
  await saveRun(f.root, { ...current, state: "working" })
  expect(rejected(await f.api.followup({ run: f.child.id, requestID: "busy", paths: ["src/cli.ts"], delivery: "now" }, f.caller)).code).toBe("E_BUSY")
  expect(await readJson<Brief>(f.briefPath)).toEqual(f.brief)
  expect((await loadRun(f.root, f.child.id))?.paths).toEqual(f.child.paths)
  expect(f.prompts).toEqual([])
})

test("the followup paths parameter can be closed without closing ordinary corrections", () => {
  const parent = shippedMembers().find((member) => member.id === "build-seat")!
  const table = presetTable({ records: [change(parent, "perm:team_followup:parameters.paths", { state: "off" })] })
  const rows = table.toolRows(parent.id, "team_followup")
  expect(rows.find((row) => row.item.field === "paths")?.item.title).toBe("Widening a child's scope (paths)")
  const call = { tool: "team_followup", sessionID: "ses_parent", directory: process.cwd(), teamMembers: table.teamMembers }
  expect(decide(rows, { ...call, input: { run: "w-aaaaaaaaaaaaaaaa", requestID: "one", paths: ["src/cli.ts"] } }).refuse).toBeDefined()
  expect(decide(rows, { ...call, input: { run: "w-aaaaaaaaaaaaaaaa", requestID: "two", prompt: "Continue." } }).refuse).toBeUndefined()
})
