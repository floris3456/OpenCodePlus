import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState } from "../../src/index.js"
import { teamsDataDir } from "../../src/instructions/paths.js"
import { createTeamApi } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
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
    const finishMessage = await runMessage(need(tools, "team_finish"), {}, ctx)
    expect(finishMessage.startsWith("E_INPUT:")).toBe(true)
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
