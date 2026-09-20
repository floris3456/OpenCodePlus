import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState } from "../../src/index.js"
import { teamsDataDir } from "../../src/instructions/paths.js"
import { verify } from "../../src/teams/audit.js"
import { createTeamApi } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { bySession, loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { registerTeamTools } from "../../src/teams/tools.js"
import { registerInstructionTools } from "../../src/tools.js"
import { context, toolHarness } from "../harness.js"

const teamNames = [
  "delegate",
  "finish",
  "followup",
  "review",
  "integrate",
  "checkpoint",
  "set_checks",
  "supersede",
  "shutdown_request",
  "stop",
  "resume",
  "prepare",
  "plan_handoff",
  "status",
  "wait",
  "diff",
  "list",
  "get_context",
  "check",
  "metrics",
  "exa_code_search",
  "tavily_search",
  "tavily_extract",
] as const

const codemodeFalse = new Set(["delegate", "finish", "followup", "review", "integrate", "checkpoint", "set_checks", "supersede", "shutdown_request", "stop", "resume", "prepare", "plan_handoff"])

const notActor = (id: string): string =>
  `E_NOT_ACTOR: This session is not the owner of run ${id}. Call team tools from the run's own chat; do not session_move.`

function fixture(): { ctx: Context; tools: Map<string, Tool.Info & { readonly id: string }> } {
  const harness = toolHarness()
  return { ctx: context({ tool: harness.domain }), tools: harness.tools }
}

async function registeredTools(): Promise<Map<string, Tool.Info & { readonly id: string }>> {
  const created = fixture()
  const api = createTeamApi(created.ctx, createState())
  await registerTeamTools(created.ctx, api)
  return created.tools
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
    messageID: SessionMessage.ID.make("msg_team_test"),
    id: Tool.CallID.make("call_team_test"),
    progress: () => Effect.void,
  }
}

function makeRun(id: string, role: string, sessionID: string): RunRecord {
  const now = new Date().toISOString()
  return {
    id,
    role,
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-team-test",
    paths: [],
    branch: "team/test/work",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "team-tools-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID,
    configDigest: null,
    history: [],
  }
}

// The actor gate reads the real teamsDataDir(), so tests isolate it with a
// scoped XDG_DATA_HOME redirect (restored afterwards) and save real
// RunRecords through saveRun. No mocks of our own code.
async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-tools-"))
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp
  try {
    return await fn(teamsDataDir())
  } finally {
    if (prior === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prior
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

async function runMessage(
  tool: Tool.Info & { readonly id: string },
  input: unknown,
  ctx: Tool.Context,
): Promise<string> {
  const outcome = await Effect.runPromise(
    tool.execute(input, ctx).pipe(
      Effect.map(() => ({ ok: true as const, message: "" })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, message: error.message })),
    ),
  )
  if (outcome.ok) throw new Error(`expected tool failure, got success for ${tool.id}`)
  return outcome.message
}

test("every team tool registers under namespace team with codemode and permission", async () => {
  const tools = await registeredTools()
  const registered = teamNames.map((name) => need(tools, `team_${name}`))
  expect(registered).toHaveLength(23)
  for (const [index, tool] of registered.entries()) {
    const name = teamNames[index] as string
    expect(tool.origin).toEqual({ type: "plugin", name: "opencode.plus" })
    expect(tool.options?.namespace).toBe("team")
    expect(tool.options?.codemode).toBe(!codemodeFalse.has(name))
    expect(tool.options?.permission).toBe(`team.${name}`)
  }
})

test("a session with no run fails E_NOT_ACTOR with the exact message", async () => {
  await withIsolatedTeamsRoot(async () => {
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_none", "muse-implementer")
    for (const name of teamNames) {
      const message = await runMessage(need(tools, `team_${name}`), {}, ctx)
      expect(message).toBe(notActor("unknown"))
    }
  })
})

test("a session with no run names the input run id in E_NOT_ACTOR", async () => {
  await withIsolatedTeamsRoot(async () => {
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_none_named", "sol-orchestrator")
    const message = await runMessage(need(tools, "team_followup"), { run: "w-aaaaaaaaaaaaaaaa", requestID: "r1", prompt: "again" }, ctx)
    expect(message).toBe(notActor("w-aaaaaaaaaaaaaaaa"))
  })
})

test("a reviewer cannot delegate but reaches the finish handler", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    await saveRun(root, makeRun("w-bbbbbbbbbbbbbbbb", "astra-reviewer", "ses_team_reviewer"))
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_reviewer", "astra-reviewer")
    const delegateMessage = await runMessage(need(tools, "team_delegate"), {}, ctx)
    expect(delegateMessage.startsWith("E_ROLE:")).toBe(true)
    const finishMessage = await runMessage(
      need(tools, "team_finish"),
      { status: "blocked", summary: "need decision", needs: [{ kind: "decision", detail: "need decision" }] },
      ctx,
    )
    expect(finishMessage.startsWith("E_INTERNAL:")).toBe(true)
  })
})

test("a run whose role does not match the calling agent fails E_NOT_ACTOR", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    await saveRun(root, makeRun("w-cccccccccccccccc", "muse-implementer", "ses_team_mismatch"))
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_mismatch", "sol-orchestrator")
    const message = await runMessage(need(tools, "team_status"), {}, ctx)
    expect(message).toBe(notActor("w-cccccccccccccccc"))
  })
})

test("team_prepare from a no-run orchestrator session creates a main run and is idempotent", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repoDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-root-"))
    try {
      await git(repoDir, ["init"])
      await git(repoDir, ["config", "user.name", "team-test"])
      await git(repoDir, ["config", "user.email", "team-test@local"])
      await fs.writeFile(path.join(repoDir, "README.md"), "# root\n")
      await git(repoDir, ["add", "README.md"])
      await git(repoDir, ["commit", "-m", "feat: initial commit"])
      const head = await git(repoDir, ["rev-parse", "HEAD"])
      const harness = toolHarness()
      const directory = AbsolutePath.make(repoDir)
      const location = new Location.Info({
        directory,
        project: { id: Project.ID.global, directory, canonical: directory },
      })
      const pluginCtx = context({ tool: harness.domain, location })
      const api = createTeamApi(pluginCtx, createState())
      await registerTeamTools(pluginCtx, api)
      const tool = need(harness.tools, "team_prepare")
      const toolCtx = toolContext("ses_team_root_001", "sol-orchestrator")
      const first = (await Effect.runPromise(tool.execute({}, toolCtx).pipe(Effect.map((result) => result.output)))) as Record<
        string,
        unknown
      >
      expect(typeof first.run).toBe("string")
      expect(String(first.run).startsWith("main-")).toBe(true)
      const second = (await Effect.runPromise(tool.execute({}, toolCtx).pipe(Effect.map((result) => result.output)))) as Record<
        string,
        unknown
      >
      expect(second.run).toBe(first.run)
      const stored = await loadRun(root, String(first.run))
      expect(stored?.kind).toBe("main")
      expect(stored?.role).toBe("sol-orchestrator")
      expect(stored?.directory).toBe(repoDir)
      expect(stored?.sessionID).toBe("ses_team_root_001")
      expect(stored?.base).toBe(head)
      expect(stored?.head).toBe(head)
      expect(stored?.paths).toEqual([])
      expect(stored?.state).toBe("working")
      expect(stored?.attempts).toHaveLength(1)
      expect(stored?.attempts[0]?.state).toBe("streaming")
      const entries = await fs.readdir(path.join(root, "runs"))
      const mains = entries.filter((entry) => entry.startsWith("main-"))
      expect(mains).toEqual([String(first.run)])
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })
})

test("team_prepare from a no-run implementer session still fails E_NOT_ACTOR", async () => {
  await withIsolatedTeamsRoot(async () => {
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_prep_impl", "muse-implementer")
    const message = await runMessage(need(tools, "team_prepare"), {}, ctx)
    expect(message).toBe(notActor("unknown"))
  })
})

test("team_prepare with a cwd argument from a no-run orchestrator session fails E_NOT_ACTOR and creates no run record", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repoDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-root-"))
    try {
      await git(repoDir, ["init"])
      await git(repoDir, ["config", "user.name", "team-test"])
      await git(repoDir, ["config", "user.email", "team-test@local"])
      await fs.writeFile(path.join(repoDir, "README.md"), "# root\n")
      await git(repoDir, ["add", "README.md"])
      await git(repoDir, ["commit", "-m", "feat: initial commit"])
      const harness = toolHarness()
      const directory = AbsolutePath.make(repoDir)
      const location = new Location.Info({
        directory,
        project: { id: Project.ID.global, directory, canonical: directory },
      })
      const pluginCtx = context({ tool: harness.domain, location })
      const api = createTeamApi(pluginCtx, createState())
      await registerTeamTools(pluginCtx, api)
      const tool = need(harness.tools, "team_prepare")
      const toolCtx = toolContext("ses_team_prep_orch_cwd", "sol-orchestrator")
      const message = await runMessage(tool, { cwd: "scripts/team2" }, toolCtx)
      expect(message).toBe(notActor("unknown"))
      const bound = await bySession(root, "ses_team_prep_orch_cwd")
      expect(bound).toBeUndefined()
      const runs = await fs.readdir(path.join(root, "runs")).catch(() => [])
      expect(runs).toEqual([])
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })
})

test("the instructions namespace still registers alongside team", async () => {
  const created = fixture()
  const state = createState()
  const api = createPlusApi(created.ctx, state)
  await registerInstructionTools(created.ctx, api)
  await registerTeamTools(created.ctx, createTeamApi(created.ctx, state))
  expect(need(created.tools, "instructions_list").options?.namespace).toBe("instructions")
  expect(need(created.tools, "team_status").options?.namespace).toBe("team")
  expect([...created.tools.keys()].filter((id) => id.startsWith("instructions_"))).toHaveLength(8)
  expect([...created.tools.keys()].filter((id) => id.startsWith("team_"))).toHaveLength(23)
})

async function auditLines(root: string): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(path.join(root, "audit.log"), "utf8")
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function runSuccess(tool: Tool.Info & { readonly id: string }, input: unknown, ctx: Tool.Context): Promise<unknown> {
  return Effect.runPromise(tool.execute(input, ctx).pipe(Effect.map((result) => result.output)))
}

test("refused gated call writes tool.call with E_NOT_ACTOR and no input", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_audit_refuse", "muse-implementer")
    const message = await runMessage(need(tools, "team_status"), {}, ctx)
    expect(message).toBe(notActor("unknown"))
    const lines = await auditLines(root)
    expect(lines).toHaveLength(1)
    const line = lines[0] as Record<string, unknown>
    expect(line.kind).toBe("tool.call")
    expect(line.ok).toBe(false)
    expect(line.code).toBe("E_NOT_ACTOR")
    expect(line.run).toBeNull()
    expect(line.actor).toBe("muse-implementer")
    expect(line.sessionID).toBe("ses_team_audit_refuse")
    expect(line.tool).toBe("team_status")
    expect(typeof line.durationMs).toBe("number")
    expect("input" in line).toBe(false)
  })
})

test("successful gated call writes tool.call with run id and chain verifies across both", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const workDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-audit-ok-"))
    try {
      const runID = "w-aaaaaaaaaaaaaaaa"
      const session = "ses_team_audit_ok"
      await saveRun(root, { ...makeRun(runID, "muse-implementer", session), directory: workDir })
      const tools = await registeredTools()
      const refuseCtx = toolContext("ses_team_audit_none", "muse-implementer")
      const refused = await runMessage(need(tools, "team_status"), {}, refuseCtx)
      expect(refused).toBe(notActor("unknown"))
      const okCtx = toolContext(session, "muse-implementer")
      const output = await runSuccess(need(tools, "team_status"), {}, okCtx)
      expect(output).toBeDefined()
      const lines = await auditLines(root)
      const calls = lines.filter((line) => line.kind === "tool.call")
      expect(calls).toHaveLength(2)
      const first = calls[0] as Record<string, unknown>
      expect(first.ok).toBe(false)
      expect(first.code).toBe("E_NOT_ACTOR")
      expect(first.run).toBeNull()
      expect("input" in first).toBe(false)
      const second = calls[1] as Record<string, unknown>
      expect(second.ok).toBe(true)
      expect(second.code).toBeNull()
      expect(second.run).toBe(runID)
      expect(second.tool).toBe("team_status")
      expect(second.actor).toBe("muse-implementer")
      expect(second.sessionID).toBe(session)
      expect(typeof second.durationMs).toBe("number")
      expect("input" in second).toBe(false)
      const v = await verify(root)
      expect(v.ok).toBe(true)
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })
})

test("integrate, set_checks, supersede, stop and list reach real handlers while review remains not implemented", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    await saveRun(root, makeRun("w-dddddddddddddddd", "sol-orchestrator", "ses_team_orch"))
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_orch", "sol-orchestrator")

    const reviewMessage = await runMessage(need(tools, "team_review"), {}, ctx)
    expect(reviewMessage.startsWith("E_NOT_IMPLEMENTED:")).toBe(true)

    const integrateMessage = await runMessage(
      need(tools, "team_integrate"),
      { run: "w-0000000000000000", expectedParentHead: "0123456789abcdef0123456789abcdef01234567" },
      ctx,
    )
    expect(integrateMessage.startsWith("E_NOT_CHILD:")).toBe(true)
    expect(integrateMessage.includes("E_NOT_IMPLEMENTED")).toBe(false)

    const stopMessage = await runMessage(need(tools, "team_stop"), { run: "w-0000000000000000" }, ctx)
    expect(stopMessage.startsWith("E_NOT_CHILD:")).toBe(true)
    expect(stopMessage.includes("E_NOT_IMPLEMENTED")).toBe(false)

    const supersedeMessage = await runMessage(
      need(tools, "team_supersede"),
      { run: "w-0000000000000000", reason: "superseded child run in test" },
      ctx,
    )
    expect(supersedeMessage.startsWith("E_NOT_CHILD:")).toBe(true)
    expect(supersedeMessage.includes("E_NOT_IMPLEMENTED")).toBe(false)

    const setChecksMessage = await runMessage(
      need(tools, "team_set_checks"),
      { checks: [{ id: "Bad_ID!", argv: ["bun", "test", "x.test.ts"] }] },
      ctx,
    )
    expect(setChecksMessage.startsWith("E_CHECKS:")).toBe(true)
    expect(setChecksMessage.includes("E_NOT_IMPLEMENTED")).toBe(false)

    const listResult = (await runSuccess(need(tools, "team_list"), { parent: "w-0000000000000000" }, ctx)) as unknown[]
    expect(listResult).toEqual([])
  })
})

test("registered set_checks returns E_CHECKS for an invalid check through the tool seam", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    await saveRun(root, makeRun("w-eeeeeeeeeeeeeeee", "sol-orchestrator", "ses_team_checks_invalid"))
    const tools = await registeredTools()
    const tool = need(tools, "team_set_checks")
    const invalid = { checks: [{ id: "Bad_ID!", argv: ["bun", "test", "x.test.ts"] }] }
    const inputSchema = tool.input
    expect(Schema.isSchema(inputSchema)).toBe(true)
    if (Schema.isSchema(inputSchema)) {
      const decoded = Schema.decodeUnknownOption(inputSchema)(invalid)
      expect(Option.isSome(decoded)).toBe(true)
    }
    const ctx = toolContext("ses_team_checks_invalid", "sol-orchestrator")
    const message = await runMessage(tool, invalid, ctx)
    expect(message.startsWith("E_CHECKS:")).toBe(true)
    expect(message).toContain("Checks need distinct short IDs.")
    expect(message).toContain('\naccepted: {"id":"plus-tests","argv":["bun","test","packages/plus/test/model.test.ts"]}')
  })
})

test("refusal carries accepted line verbatim for E_PATHS, E_ROLE, E_CHECKS, E_SUMMARY, E_TIMEOUT_MIN", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repoDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-accepted-"))
    try {
      await git(repoDir, ["init"])
      await git(repoDir, ["config", "user.name", "team-test"])
      await git(repoDir, ["config", "user.email", "team-test@local"])
      await fs.writeFile(path.join(repoDir, "README.md"), "# accepted test\n")
      await git(repoDir, ["add", "README.md"])
      await git(repoDir, ["commit", "-m", "feat: initial commit"])
      const head = await git(repoDir, ["rev-parse", "HEAD"])

      // 1. E_PATHS: Orchestrator delegating with empty paths for implementer
      const orchRun = {
        ...makeRun("w-orch000000000001", "sol-orchestrator", "ses_orch_paths"),
        directory: repoDir,
        base: head,
        head,
      }
      await saveRun(root, orchRun)
      const tools = await registeredTools()
      const orchCtx = toolContext("ses_orch_paths", "sol-orchestrator")
      const pathsMsg = await runMessage(
        need(tools, "team_delegate"),
        {
          requestID: "r-paths",
          role: "muse-implementer",
          objective: "Implement with empty paths to trigger E_PATHS refusal.",
          deliverable: { kind: "commit" },
          scope: { paths: [] },
          checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/model.test.ts"] }],
        },
        orchCtx,
      )
      expect(pathsMsg).toBe(
        `E_PATHS: Implementers need scope.paths (files or dir/* they may edit).\naccepted: ["packages/plus/src/*","packages/plus/test/*"]`,
      )

      // 2. E_ROLE: Planner delegating to a non-orchestrator (e.g. scout)
      const plannerRun = {
        ...makeRun("w-plan000000000001", "fable-planner", "ses_planner_role"),
        directory: repoDir,
        base: head,
        head,
      }
      await saveRun(root, plannerRun)
      const plannerCtx = toolContext("ses_planner_role", "fable-planner")
      const roleMsg = await runMessage(
        need(tools, "team_delegate"),
        {
          requestID: "r-role",
          role: "scout",
          objective: "Delegate to scout from planner to trigger E_ROLE refusal.",
          deliverable: { kind: "findings" },
          scope: { paths: ["packages/plus/src/*"] },
          checks: [],
        },
        plannerCtx,
      )
      expect(roleMsg).toBe(
        `E_ROLE: Planners may delegate only to opus-orchestrator or sol-orchestrator.\naccepted: {"role":"opus-orchestrator"}`,
      )

      // 3. E_CHECKS: Invalid check ID in set_checks
      const checksMsg = await runMessage(
        need(tools, "team_set_checks"),
        {
          checks: [{ id: "Bad_ID!", argv: ["bun", "test", "packages/plus/test/model.test.ts"] }],
        },
        orchCtx,
      )
      expect(checksMsg).toBe(
        `E_CHECKS: Checks need distinct short IDs.\naccepted: {"id":"plus-tests","argv":["bun","test","packages/plus/test/model.test.ts"]}`,
      )

      // 4. E_SUMMARY: Summary with 16 lines in finish
      const implRun = {
        ...makeRun("w-impl000000000001", "muse-implementer", "ses_impl_summary"),
        directory: repoDir,
        base: head,
        head,
        attempts: [{ n: 1, state: "streaming" as const, trigger: "delegate", startedAt: new Date().toISOString() }],
      }
      await saveRun(root, implRun)
      const implCtx = toolContext("ses_impl_summary", "muse-implementer")
      const summaryMsg = await runMessage(
        need(tools, "team_finish"),
        {
          status: "done",
          summary: Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join("\n"),
        },
        implCtx,
      )
      expect(summaryMsg).toBe(
        `E_SUMMARY: summary is 16 lines (max 15). Detail goes to the report file automatically; keep the summary to what the parent must act on.\naccepted: "a summary of ≤15 lines"`,
      )

      // 5. E_TIMEOUT_MIN: Wait with timeoutMs below 10000ms floor
      const waitMsg = await runMessage(
        need(tools, "team_wait"),
        {
          runs: ["w-orch000000000001"],
          timeoutMs: 5000,
        },
        orchCtx,
      )
      expect(waitMsg).toBe(
        `E_TIMEOUT_MIN: timeoutMs 5000 is below the 10000ms floor.\naccepted: {"timeoutMs":10000}`,
      )
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })
})

