// The round-1 walkthrough evidence program: it drives the real team tooling
// end to end, asserts every outcome, and prints the verbatim tool outputs the
// walkthrough document pastes. Every team-tool output goes through the tool
// seam (registerTeamTools), never a handler directly, because the seam is what
// formats `CODE: message` plus the `accepted:` line.
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CodeModeCatalog } from "../../../core/src/codemode/catalog.js"
import { Image } from "../../../core/src/image.js"
import { Tool as CoreTool } from "../../../core/src/tool.js"
import { LayerNode } from "../../../util/src/effect/layer-node.js"
import { createPlusApi, createState, type PlusApi } from "../../src/index.js"
import { apply } from "../../src/instructions/apply.js"
import { discover } from "../../src/instructions/discover.js"
import { scopesOf, type Level } from "../../src/instructions/model.js"
import { teamsDataDir } from "../../src/instructions/paths.js"
import { liveRunScopes, policyMembersOf, teamPolicyItems } from "../../src/instructions/team-policy-rows.js"
import { enable } from "../../src/project.js"
import { createTeamApi } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { peek } from "../../src/teams/inbox.js"
import { gc, onSessionEvent } from "../../src/teams/lifecycle.js"
import { allowedTeamTools, codeTools, teamTools } from "../../src/teams/policy.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Policy } from "../../src/teams/schema.js"
import { atomicJson } from "../../src/teams/store.js"
import { registerTeamTools } from "../../src/teams/tools.js"
import { registerInstructionTools } from "../../src/tools.js"
import { agentHarness, agentInfo, context, toolHarness } from "../harness.js"

const defaultPolicy = Schema.decodeUnknownSync(Policy)({})

const PASSING_CHECK = `import { expect, test } from "bun:test"\n\ntest("note", () => {\n  expect(1).toBe(1)\n})\n`

const TEAM = "opencodeplus-team"

function banner(section: string, title: string): void {
  console.log(`\n=== [${section}] ${title} ===`)
}

function call(command: string, input: unknown, result: unknown): void {
  console.log(`\n$ ${command}${input === undefined ? "" : ` ${JSON.stringify(input)}`}`)
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2))
}

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-walkthrough-"))
  const priorData = process.env.XDG_DATA_HOME
  const priorConfig = process.env.OPENCODE_CONFIG_DIR
  process.env.XDG_DATA_HOME = tmp
  process.env.OPENCODE_CONFIG_DIR = path.join(tmp, "config")
  try {
    return await fn(teamsDataDir())
  } finally {
    if (priorData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = priorData
    if (priorConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfig
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

async function makeRepo(): Promise<{ scratch: string; dir: string; head: string }> {
  const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-walkthrough-repo-"))
  const dir = path.join(scratch, "repo")
  await git(scratch, ["init", "-b", "main", "repo"])
  await git(dir, ["config", "user.name", "team-test"])
  await git(dir, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# walkthrough\n")
  await fs.writeFile(path.join(dir, "note.test.ts"), PASSING_CHECK)
  await fs.writeFile(path.join(dir, ".gitignore"), ".opencodeplus/\n")
  await git(dir, ["add", "README.md", "note.test.ts", ".gitignore"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { scratch, dir, head }
}

// The host session domain is a recording double: a plugin cannot spawn
// model-backed sessions in-process, so it records what the handlers asked for.
function recordSession() {
  const created: unknown[] = []
  const prompted: Array<{ sessionID: string; text: string }> = []
  let seq = 0
  const domain = {
    create: (input: unknown) => {
      created.push(input)
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_child_${seq}`) })
    },
    prompt: (input: { sessionID: unknown; text: unknown }) => {
      prompted.push({ sessionID: String(input.sessionID), text: String(input.text) })
      return Effect.succeed(undefined as never)
    },
    switchModel: () => Effect.succeed(undefined as never),
    wait: () => Effect.succeed(undefined),
  } as unknown as SessionDomain
  return { created, prompted, domain }
}

function pluginContext(directory: string, session?: SessionDomain) {
  const tools = toolHarness()
  const agents = agentHarness([], directory)
  const absolute = AbsolutePath.make(directory)
  const location = new Location.Info({
    directory: absolute,
    project: { id: Project.ID.global, directory: absolute, canonical: absolute },
  })
  const ctx = context({
    location,
    agent: agents.domain,
    tool: tools.domain,
    ...(session === undefined ? {} : { session }),
  })
  return { ctx, tools: tools.tools }
}

// Registers the real instruction and team namespaces on one context, so every
// printed call below is a registered tool reached through the seam.
async function registerAll(ctx: Context) {
  const state = createState()
  const plus = createPlusApi(ctx, state)
  await registerInstructionTools(ctx, plus)
  await registerTeamTools(ctx, createTeamApi(ctx, state))
  return plus
}

// The shipped roster as a project team, which is the TUI's "start from
// template" flow. A defaults-level copy would be shadowed by the very agents
// Plus installs for it (they read back as defaults-scope regulars), so its
// members would carry no rows at all.
async function enableShippedTeam(plus: PlusApi): Promise<void> {
  const created = await plus.createTeam({ level: "project", team: TEAM, template: TEAM })
  expect(created.ok).toBe(true)
  const enabled = await plus.setTeamEnabled({ level: "project", team: TEAM, enabled: true })
  expect(enabled.ok).toBe(true)
}

function need(tools: Map<string, Tool.Info & { readonly id: string }>, id: string): Tool.Info & { readonly id: string } {
  const tool = tools.get(id)
  if (tool === undefined) throw new Error(`missing tool ${id}`)
  return tool
}

function toolContext(sessionID: string, agent: string): Tool.Context {
  return {
    sessionID: Session.ID.make(sessionID),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_walkthrough"),
    id: Tool.CallID.make("call_walkthrough"),
    progress: () => Effect.void,
  }
}

// Core decodes a call against the tool's own input schema before executing it,
// which is where optional fields take their declared defaults; the seam is only
// faithful if the walkthrough decodes the same way.
function admitted(tool: Tool.Info & { readonly id: string }, input: unknown): unknown {
  if (!Schema.isSchema(tool.input)) return input
  return Schema.decodeUnknownSync(tool.input)(input)
}

async function runOk<T>(tool: Tool.Info & { readonly id: string }, input: unknown, ctx: Tool.Context): Promise<T> {
  const output = await Effect.runPromise(tool.execute(admitted(tool, input), ctx).pipe(Effect.map((result) => result.output)))
  return output as T
}

async function runMessage(tool: Tool.Info & { readonly id: string }, input: unknown, ctx: Tool.Context): Promise<string> {
  const outcome = await Effect.runPromise(
    tool.execute(admitted(tool, input), ctx).pipe(
      Effect.map(() => ({ ok: true as const, message: "" })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, message: error.message })),
    ),
  )
  if (outcome.ok) throw new Error(`expected tool failure, got success for ${tool.id}`)
  return outcome.message
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "gemini-implementer",
    kind: "w",
    repo: "repo",
    repoKey: "repo",
    directory: "/tmp/wt-walkthrough",
    paths: [],
    branch: "team/implementer/walkthrough",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "walkthrough",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function dirExists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  )
}

interface ListRows {
  rows: Array<{ id: string; label?: string; text?: string; badges?: string; source?: string }>
  total: number
}

interface StatusEntry {
  run: string
  state: string
  attempt: number
  attemptState: string
  acked: { attempt: number; at: string } | null
}

test("[20b] a team member's ceiling and native denies are instructions rows", async () => {
  await withIsolatedTeamsRoot(async () => {
    const repo = await makeRepo()
    try {
      console.log(
        [
          "",
          "Round-1 team walkthrough evidence. Everything below is produced by",
          "packages/plus/test/teams/walkthrough.test.ts against real machinery:",
          "real git repositories and worktrees, a real team data root under a temp",
          "XDG_DATA_HOME, real run records, briefs, reports, check receipts, inbox",
          "files and instructions rows. Two things are doubles: the host session",
          "domain is the recording double the tests use (a plugin cannot spawn",
          "model-backed sessions in-process), and host session.idle /",
          "session.execution.* events are delivered by calling the exported",
          "lifecycle handlers directly. Run ids, ULIDs, timestamps and temp paths",
          "vary between runs.",
        ].join("\n"),
      )
      banner("20b", "a team member's ceiling and native denies are instructions rows")
      await enable(repo.dir)
      const fixture = pluginContext(repo.dir)
      await enableShippedTeam(await registerAll(fixture.ctx))

      const ctx = toolContext("ses_walkthrough_20b", "sol-orchestrator")
      const where = "agent:gemini-implementer item:perm"
      const fields = ["id", "label", "badges", "source"]
      const listed = await runOk<ListRows>(need(fixture.tools, "instructions_list"), { where, fields, limit: 200 }, ctx)
      call("instructions_list", { where, fields, limit: 200 }, listed)

      const ids = listed.rows.map((row) => row.id)
      const ceiling = allowedTeamTools("implementer")
      // A row is listable only where a hostable tool row exists to hang it
      // under, which for this member is the out-of-ceiling direct team tools.
      const codeSet = new Set<string>(codeTools)
      for (const tool of teamTools.filter((name) => !ceiling.includes(name) && !codeSet.has(name)))
        expect(ids.some((id) => id.endsWith(`perm:team_${tool}:role-ceiling`))).toBe(true)
      for (const tool of ceiling) expect(ids.some((id) => id.endsWith(`perm:team_${tool}:role-ceiling`))).toBe(false)

      const delegateRow = ids.find((id) => id.endsWith("perm:team_delegate:role-ceiling"))
      expect(delegateRow).toBeDefined()
      const shown = await runOk<{ tool: string; enabled: boolean; patterns: string[] }>(
        need(fixture.tools, "instructions_show"),
        { id: delegateRow },
        ctx,
      )
      call("instructions_show", { id: delegateRow }, shown)
      expect(shown.tool).toBe("team_delegate")
      expect(shown.enabled).toBe(false)
      expect(shown.patterns).toEqual(["*"])

      // The whole set, straight from the producer that feeds the snapshot.
      // Plus.SnapshotItem carries neither `policy` nor `runID`, so the tree's
      // Policy group — the surface that lists every row regardless of tool —
      // is empty by the time instructions_list reads the snapshot back.
      const produced = teamPolicyItems(policyMembersOf(["gemini-implementer"]))
      const producedIds = produced.map((row) => row.id)
      call("teamPolicyItems(policyMembersOf([gemini-implementer])) row ids", undefined, producedIds)
      for (const item of [
        "perm:shell:team-role",
        "perm:question:team-role",
        "perm:subagent:team-role",
        "perm:task:team-role",
        "perm:read:team-role",
        "perm:external_directory:team-role",
        "perm:team_delegate:role-ceiling",
        "perm:search:team-tavily",
      ])
        expect(producedIds).toContain(item)
      for (const tool of ceiling) expect(producedIds).not.toContain(`perm:team_${tool}:role-ceiling`)
      call("teamPolicyItems(...) perm:shell:team-role", undefined, produced.find((row) => row.id === "perm:shell:team-role"))
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 60000)

test("[20c] a non-member catalog has zero team tools; a member's is exactly its ceiling", async () => {
  banner("20c", "a non-member catalog has zero team tools; a member's is exactly its ceiling")
  const member = "gemini-implementer"
  const codeSet = new Set<string>(codeTools)
  const registered = teamTools.map((name) => ({
    id: `team_${name}`,
    name,
    description: `team ${name}`,
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace: "team", codemode: codeSet.has(name), permission: `team.${name}` },
    origin: { type: "plugin", name: "opencode.plus" } as const,
    execute: () => Effect.die("unused tool.execute"),
  }))
  const editor: ToolEditor = {
    list: () => registered,
    get: (id) => registered.find((entry) => entry.id === id),
    namespace: () => {},
    add: () => {},
    update: () => {},
    remove: () => {},
  }
  const agents = agentHarness([agentInfo("build", "upstream")])
  const ctx = context({
    agent: agents.domain,
    tool: {
      transform: (callback: (edit: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
      hook: () => Effect.die("unused tool.hook"),
    },
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  await apply(ctx, {
    items: [...discovered.items, ...teamPolicyItems(policyMembersOf([member]))],
    agents: [
      { id: member, level: "defaults" as Level },
      { id: "build", level: "project" as Level },
    ],
    records: [],
    splits: [],
    scopes: scopesOf([
      { id: member, scope: "defaults" as const },
      { id: "build", scope: "project" as const },
    ]),
    teamAgents: [member],
  })

  const toolLayer = LayerNode.compile(LayerNode.group([CoreTool.node]), {
    replacements: [
      Image.node.replace(Layer.mock(Image.Service, { normalize: (_resource, content) => Effect.succeed(content) })),
    ],
  })
  const visible = async (agent: string) => {
    const permissions = agents.state.get(agent)?.permissions ?? []
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* CoreTool.Service
        yield* registry.transform((edit) => {
          for (const tool of registered)
            edit.add({
              name: tool.name,
              description: tool.description,
              input: tool.input,
              output: tool.output,
              options: tool.options,
              execute: () => Effect.die("unused tool.execute"),
            })
        })
        return yield* registry.snapshot(permissions)
      }).pipe(Effect.provide(toolLayer), Effect.scoped),
    )
    const code =
      snapshot.codeModeCatalog === undefined
        ? []
        : Object.keys(CodeModeCatalog.flattenToRecord(snapshot.codeModeCatalog)).filter((entry) => entry.startsWith("team."))
    return {
      native: snapshot.definitions.map((entry) => entry.name).filter((name) => name.startsWith("team_")).toSorted(),
      codemode: code.toSorted(),
    }
  }

  const nonMember = await visible("build")
  call("tool catalog for agent build (team entries)", undefined, nonMember)
  expect(nonMember).toEqual({ native: [], codemode: [] })

  const ceiling = allowedTeamTools("implementer")
  const memberCatalog = await visible(member)
  call(`tool catalog for agent ${member} (team entries)`, undefined, memberCatalog)
  expect(memberCatalog.native).toEqual(
    ceiling.filter((name) => !codeSet.has(name)).map((name) => `team_${name}`).toSorted(),
  )
  expect(memberCatalog.codemode).toEqual(
    ceiling.filter((name) => codeSet.has(name)).map((name) => `team.${name}`).toSorted(),
  )
}, 60000)

test("[20d] root bootstrap, delegate, context, checkpoint, finish, notification, wait, integrate", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      banner("20d", "root bootstrap → delegate → get_context → checkpoint → finish → notification → wait → integrate → worktree gone")
      await enable(repo.dir)
      const sessions = recordSession()
      const fixture = pluginContext(repo.dir, sessions.domain)
      await enableShippedTeam(await registerAll(fixture.ctx))

      const parent = toolContext("ses_walkthrough_root", "sol-orchestrator")
      const bootstrap = await runOk<StatusEntry[]>(need(fixture.tools, "team_status"), {}, parent)
      call("team_status", {}, bootstrap)
      const rootRun = bootstrap[0].run
      expect(rootRun.startsWith("main-")).toBe(true)
      const again = await runOk<StatusEntry[]>(need(fixture.tools, "team_status"), {}, parent)
      call("team_status", {}, again)
      expect(again[0].run).toBe(rootRun)

      const brief = {
        requestID: "ev-1",
        role: "gemini-implementer",
        objective: "Add docs/note.md naming this run, commit it, and leave the note check green.",
        deliverable: { kind: "commit" },
        scope: { paths: ["docs/note.md"] },
        checks: [{ id: "note", argv: ["bun", "test", "note.test.ts"] }],
      }
      const delegated = await runOk<{ run: string; session: string; directory: string; branch: string; base: string; briefPath: string }>(
        need(fixture.tools, "team_delegate"),
        brief,
        parent,
      )
      call("team_delegate", brief, delegated)
      const childRun = delegated.run
      expect(childRun.startsWith("w-")).toBe(true)
      expect(await dirExists(delegated.directory)).toBe(true)

      const scopeQuery = { where: `run:${childRun}`, fields: ["id", "label", "text", "badges", "source"] }
      const scopeRows = await runOk<ListRows>(need(fixture.tools, "instructions_list"), scopeQuery, parent)
      call("instructions_list", scopeQuery, scopeRows)
      // The row exists; the `run:` filter cannot see it because the RPC
      // snapshot drops the `runID` the filter reads, so the producer below is
      // the only surface that answers today.
      const live = await liveRunScopes(root)
      expect(live.some((entry) => entry.id === childRun && entry.paths.includes("docs/note.md"))).toBe(true)
      const scopeRow = teamPolicyItems(policyMembersOf(["gemini-implementer"]), live).find(
        (row) => row.id === `perm:edit:run:${childRun}`,
      )
      call(`teamPolicyItems(..., liveRunScopes) perm:edit:run:${childRun}`, undefined, scopeRow)
      expect(scopeRow?.runID).toBe(childRun)
      expect(scopeRow?.text).toContain("docs/note.md")
      expect(scopeRow?.policy?.on).toContainEqual({ action: "edit", resource: "docs/note.md", effect: "allow" })
      expect(scopeRow?.policy?.on).toContainEqual({ action: "edit", resource: "*", effect: "deny" })

      const child = toolContext(delegated.session, "gemini-implementer")
      const childContext = await runOk<{ run: string; brief: { objective: string }; scope: { paths: string[] } }>(
        need(fixture.tools, "team_get_context"),
        {},
        child,
      )
      call("team_get_context", {}, childContext)
      expect(childContext.run).toBe(childRun)
      expect(childContext.scope.paths).toEqual(["docs/note.md"])

      await fs.mkdir(path.join(delegated.directory, "docs"), { recursive: true })
      await fs.writeFile(path.join(delegated.directory, "docs", "note.md"), `# note for ${childRun}\n`)
      const checkpointInput = {
        expectedHead: await git(delegated.directory, ["rev-parse", "HEAD"]),
        files: ["docs/note.md"],
        message: "docs: add the walkthrough note",
      }
      const checkpoint = await runOk<{ head: string; committed: boolean; subject: string }>(
        need(fixture.tools, "team_checkpoint"),
        checkpointInput,
        child,
      )
      call("team_checkpoint", checkpointInput, checkpoint)
      expect(checkpoint.committed).toBe(true)

      const report = { status: "done", summary: "Added docs/note.md and left the note check green." }
      const finished = await runOk<{
        head: string
        reportPath: string
        checks: Array<{ id: string; passed: boolean; head: string; at: number }>
      }>(need(fixture.tools, "team_finish"), report, child)
      call("team_finish", report, finished)
      expect(finished.checks).toEqual([{ id: "note", passed: true, head: finished.head, at: expect.any(Number) }])
      expect(await Bun.file(finished.reportPath).exists()).toBe(true)

      // The host publishes session.idle; in-process the walkthrough delivers it
      // through the same exported handler the plugin subscribes with.
      await onSessionEvent(fixture.ctx, root, { type: "session.idle", properties: { sessionID: delegated.session } })
      const inbox = await peek(root, rootRun)
      call(`cat ${path.join(root, "runs", rootRun, "inbox", `${inbox[0].id}.json`)}`, undefined, inbox[0])
      expect(inbox).toHaveLength(1)
      expect(inbox[0].kind).toBe("child.settled")
      expect(inbox[0].text).toContain(childRun)
      expect(inbox[0].text).toContain("attempt 1 succeeded")
      expect(inbox[0].text).toContain("settled: done")

      const waitInput = { runs: [childRun], timeoutMs: 10000 }
      const waited = await runOk<{ acknowledged: string[]; settled: unknown[] }>(need(fixture.tools, "team_wait"), waitInput, parent)
      call("team_wait", waitInput, waited)
      expect(waited.acknowledged).toEqual([childRun])

      const childStatus = await runOk<StatusEntry[]>(need(fixture.tools, "team_status"), { runs: [childRun] }, parent)
      call("team_status", { runs: [childRun] }, childStatus)
      expect(childStatus[0].acked?.attempt).toBe(childStatus[0].attempt)

      // A second wait re-reads the same settled attempt: it names the run in
      // `acknowledged` again and rewrites ack.json, but the acknowledged
      // attempt does not move, so no new outcome is taken responsibility for.
      const waitedAgain = await runOk<{ acknowledged: string[] }>(need(fixture.tools, "team_wait"), waitInput, parent)
      call("team_wait", waitInput, waitedAgain)
      expect(waitedAgain.acknowledged).toEqual([childRun])
      const statusAgain = await runOk<StatusEntry[]>(need(fixture.tools, "team_status"), { runs: [childRun] }, parent)
      call("team_status", { runs: [childRun] }, statusAgain)
      expect(statusAgain[0].acked?.attempt).toBe(childStatus[0].acked?.attempt)

      const integrateInput = { run: childRun, expectedParentHead: await git(repo.dir, ["rev-parse", "HEAD"]) }
      const integrated = await runOk<{ entry: string; state: string; head: string }>(
        need(fixture.tools, "team_integrate"),
        integrateInput,
        parent,
      )
      call("team_integrate", integrateInput, integrated)
      expect(integrated.state).toBe("landed")
      expect(await fs.readFile(path.join(repo.dir, "docs", "note.md"), "utf8")).toContain(childRun)

      call("git worktree list", undefined, await git(repo.dir, ["worktree", "list"]))
      call(`test -d ${delegated.directory}`, undefined, String(await dirExists(delegated.directory)))
      expect(await dirExists(delegated.directory)).toBe(false)
      call(`git rev-parse ${delegated.branch}`, undefined, await git(repo.dir, ["rev-parse", delegated.branch]))
      const runDir = path.join(root, "runs", childRun)
      call(`cat ${path.join(runDir, "run.json")}`, undefined, await Bun.file(path.join(runDir, "run.json")).text())
      call(`ls ${runDir}`, undefined, (await fs.readdir(runDir)).toSorted().join("\n"))
      call(`ls ${path.join(runDir, "receipts")}`, undefined, (await fs.readdir(path.join(runDir, "receipts"))).toSorted().join("\n"))
      expect((await loadRun(root, childRun))?.worktree).toBe("removed")
      expect(await Bun.file(path.join(runDir, "brief.md")).exists()).toBe(true)
      expect(await Bun.file(path.join(runDir, "report-1.md")).exists()).toBe(true)
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 120000)

test("[20e] a turn that ends without finish is idle / no_report", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      banner("20e", "a turn that ends without finish is idle / no_report")
      const now = new Date().toISOString()
      const child = baseRun({
        id: "w-aaaaaaaaaaaaaaaa",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        state: "working",
        attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
        sessionID: "ses_walkthrough_noreport",
      })
      await saveRun(root, child)
      const sessions = recordSession()
      const fixture = pluginContext(repo.dir, sessions.domain)
      await registerAll(fixture.ctx)

      await onSessionEvent(fixture.ctx, root, { type: "session.idle", properties: { sessionID: "ses_walkthrough_noreport" } })
      const ctx = toolContext("ses_walkthrough_noreport", "gemini-implementer")
      const status = await runOk<StatusEntry[]>(need(fixture.tools, "team_status"), { runs: [child.id] }, ctx)
      call("team_status", { runs: [child.id] }, status)
      expect(status[0].state).toBe("idle")
      expect(status[0].attemptState).toBe("no_report")
      expect(sessions.prompted).toHaveLength(0)
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 60000)

test("[20f] a followup queued while the child is working is delivered on idle", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      banner("20f", "a followup queued while the child is working is delivered on idle")
      const now = new Date().toISOString()
      const parentRun = baseRun({
        id: "main-0123456789abcdef",
        role: "sol-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
        attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "prepare" }],
        sessionID: "ses_walkthrough_followup_parent",
        children: ["w-bbbbbbbbbbbbbbbb"],
      })
      const child = baseRun({
        id: "w-bbbbbbbbbbbbbbbb",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        state: "working",
        attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
        parent: parentRun.id,
        sessionID: "ses_walkthrough_followup_child",
      })
      await saveRun(root, parentRun)
      await saveRun(root, child)
      const sessions = recordSession()
      const fixture = pluginContext(repo.dir, sessions.domain)
      await registerAll(fixture.ctx)

      const followup = { run: child.id, requestID: "ev-f1", prompt: "Also cover the empty-list case." }
      const queued = await runOk<{ attempt: number; state: string }>(
        need(fixture.tools, "team_followup"),
        followup,
        toolContext(parentRun.sessionID ?? "", "sol-orchestrator"),
      )
      call("team_followup", followup, queued)
      expect(queued).toEqual({ attempt: 1, state: "queued" })

      await onSessionEvent(fixture.ctx, root, {
        type: "session.idle",
        properties: { sessionID: "ses_walkthrough_followup_child" },
      })
      call("session.prompt recorded by the host double", undefined, sessions.prompted)
      expect(sessions.prompted).toEqual([
        { sessionID: "ses_walkthrough_followup_child", text: "Also cover the empty-list case." },
      ])

      const status = await runOk<StatusEntry[]>(
        need(fixture.tools, "team_status"),
        { runs: [child.id] },
        toolContext(parentRun.sessionID ?? "", "sol-orchestrator"),
      )
      call("team_status", { runs: [child.id] }, status)
      expect(status[0].state).toBe("working")
      expect(status[0].attempt).toBe(2)
      const moved = await loadRun(root, child.id)
      call(`cat ${path.join(root, "runs", child.id, "run.json")} .attempts`, undefined, moved?.attempts)
      expect(moved?.attempts[1]).toMatchObject({ n: 2, state: "admitted", trigger: "followup" })
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 60000)

test("[20g] one GC pass reaps a stale run and one orphan", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      banner("20g", "one GC pass reaps a stale run and one orphan")
      const stale = "2020-01-01T00:00:00.000Z"
      const worktreeRoot = path.join(root, "worktrees", "repo")
      const reapDir = path.join(worktreeRoot, "implementer", "stale")
      const keptDir = path.join(worktreeRoot, "implementer", "kept")
      const orphanDir = path.join(worktreeRoot, "implementer", "orphan")
      await git(repo.dir, ["worktree", "add", "-b", "team/implementer/stale", reapDir, repo.head])
      await git(repo.dir, ["worktree", "add", "-b", "team/implementer/kept", keptDir, repo.head])
      await git(repo.dir, ["worktree", "add", "-b", "team/implementer/orphan", orphanDir, repo.head])

      const parentRun = baseRun({
        id: "main-0123456789abcdef",
        role: "sol-orchestrator",
        kind: "main",
        directory: repo.dir,
        branch: "main",
        base: repo.head,
        head: repo.head,
        state: "working",
      })
      const reaped = baseRun({
        id: "w-cccccccccccccccc",
        directory: reapDir,
        branch: "team/implementer/stale",
        base: repo.head,
        head: repo.head,
        state: "stopped",
        lastUsed: stale,
        worktree: "present",
      })
      const kept = baseRun({
        id: "w-dddddddddddddddd",
        directory: keptDir,
        branch: "team/implementer/kept",
        base: repo.head,
        head: repo.head,
        state: "stopped",
        lastUsed: stale,
        worktree: "present",
      })
      await saveRun(root, parentRun)
      await saveRun(root, reaped)
      await saveRun(root, kept)
      await atomicJson(path.join(root, "runs", parentRun.id, "merge", "entry-1.json"), {
        id: "entry-1",
        parentRun: parentRun.id,
        childRun: kept.id,
        childBranch: kept.branch,
        childHead: kept.head,
        expectedParentHead: parentRun.head,
        state: "pending",
        at: stale,
        updatedAt: stale,
      })

      call("git worktree list", undefined, await git(repo.dir, ["worktree", "list"]))
      call("state before gc", undefined, {
        staleRun: (await loadRun(root, reaped.id))?.state,
        staleWorktree: await dirExists(reapDir),
        keptRun: (await loadRun(root, kept.id))?.state,
        keptWorktree: await dirExists(keptDir),
        orphanWorktree: await dirExists(orphanDir),
      })

      const result = await gc(root, defaultPolicy)
      call("gc(root, policy)", undefined, result)
      expect(result.reaped).toEqual([reaped.id])
      expect(result.orphansRemoved).toEqual([orphanDir])

      call("git worktree list", undefined, await git(repo.dir, ["worktree", "list"]))
      const after = {
        staleRun: (await loadRun(root, reaped.id))?.state,
        staleWorktree: await dirExists(reapDir),
        keptRun: (await loadRun(root, kept.id))?.state,
        keptWorktree: await dirExists(keptDir),
        orphanWorktree: await dirExists(orphanDir),
      }
      call("state after gc", undefined, after)
      expect(after).toEqual({
        staleRun: "reaped",
        staleWorktree: false,
        keptRun: "stopped",
        keptWorktree: true,
        orphanWorktree: false,
      })
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 60000)

test("[20h] a refusal carries the accepted line verbatim", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      banner("20h", "a refusal carries the accepted line verbatim")
      await saveRun(
        root,
        baseRun({
          id: "main-0123456789abcdef",
          role: "sol-orchestrator",
          kind: "main",
          directory: repo.dir,
          branch: "main",
          base: repo.head,
          head: repo.head,
          state: "working",
          sessionID: "ses_walkthrough_refusal",
        }),
      )
      const fixture = pluginContext(repo.dir, recordSession().domain)
      await registerAll(fixture.ctx)
      const ctx = toolContext("ses_walkthrough_refusal", "sol-orchestrator")

      const checksInput = { checks: [{ id: "unit", argv: ["bun", "test"] }] }
      const checksMessage = await runMessage(need(fixture.tools, "team_set_checks"), checksInput, ctx)
      call("team_set_checks", checksInput, checksMessage)
      expect(checksMessage).toBe(
        `E_CHECKS: Checks must be explicit bun test FILE or bun run SCRIPT commands. Whole-suite bun test is not permitted.\naccepted: {"id":"plus-tests","argv":["bun","test","packages/plus/test/model.test.ts"]}`,
      )

      const pathsInput = {
        requestID: "ev-h1",
        role: "gemini-implementer",
        objective: "Implement with empty paths so the refusal names the accepted scope shape.",
        deliverable: { kind: "commit" },
        scope: { paths: [] },
        checks: [{ id: "note", argv: ["bun", "test", "note.test.ts"] }],
      }
      const pathsMessage = await runMessage(need(fixture.tools, "team_delegate"), pathsInput, ctx)
      call("team_delegate", pathsInput, pathsMessage)
      expect(pathsMessage).toBe(
        `E_PATHS: Implementers need scope.paths (files or dir/* they may edit).\naccepted: ["packages/plus/src/*","packages/plus/test/*"]`,
      )

      for (const message of [checksMessage, pathsMessage]) {
        const lines = message.split("\n")
        expect(lines[0]).toMatch(/^E_[A-Z_]+: .+/)
        expect(lines[1]?.startsWith("accepted: ")).toBe(true)
      }
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 60000)

test("[21] finish on the root run", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      banner("21", "finish on the root run")
      await enable(repo.dir)
      const fixture = pluginContext(repo.dir, recordSession().domain)
      await registerAll(fixture.ctx)
      const ctx = toolContext("ses_walkthrough_root_finish", "sol-orchestrator")
      const bootstrap = await runOk<StatusEntry[]>(need(fixture.tools, "team_status"), {}, ctx)
      const rootRun = bootstrap[0].run

      const report = { status: "done", summary: "Root run closed after the walkthrough cycle." }
      const finished = await runOk<{ run: string; attempt: number; status: string; reportPath: string }>(
        need(fixture.tools, "team_finish"),
        report,
        ctx,
      )
      call("team_finish", report, finished)
      expect(finished.run).toBe(rootRun)
      expect(finished.status).toBe("done")
      expect(await Bun.file(finished.reportPath).exists()).toBe(true)
      expect(await Bun.file(path.join(root, "runs", rootRun, "brief.json")).exists()).toBe(false)

      const rootContext = await runOk<{ run: string; brief: unknown; briefPath: unknown; scope: { paths: string[] } }>(
        need(fixture.tools, "team_get_context"),
        {},
        ctx,
      )
      call("team_get_context", {}, rootContext)
      expect(rootContext.run).toBe(rootRun)
      expect(rootContext.brief).toBeNull()
      expect(rootContext.briefPath).toBeNull()
    } finally {
      await fs.rm(repo.scratch, { recursive: true, force: true })
    }
  })
}, 60000)
