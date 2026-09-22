import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { EventDomain } from "@opencode/plugin/effect/event"
import type { ToolDomain, ToolHooks } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Cause, Deferred, Effect, Fiber, Option, PubSub, Schema, SchemaAST, Stream } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertToolPermission } from "../../../core/src/tool/permission-gate.js"
import { Permission } from "../../../core/src/permission.js"
import { createPlusApi, createState } from "../../src/index.js"
import { teamsDataDir } from "../../src/instructions/paths.js"
import { verify } from "../../src/teams/audit.js"
import { createTeamApi } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { bySession, loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Brief } from "../../src/teams/schema.js"
import { registerTeamTools } from "../../src/teams/tools.js"
import { registerInstructionTools } from "../../src/tools.js"
import { context, toolHarness } from "../harness.js"

// The whole namespace. Every name here has a real handler; a tool that
// cannot work is absent rather than registered-and-failing.
const teamNames = [
  "delegate",
  "finish",
  "followup",
  "integrate",
  "checkpoint",
  "set_checks",
  "supersede",
  "stop",
  "status",
  "wait",
  "diff",
  "list",
  "get_context",
  "check",
] as const

// Gone from the namespace: search moved to the `search` MCP server, and the
// rest had no implementation to advertise.
const removedNames = [
  "review",
  "shutdown_request",
  "resume",
  "prepare",
  "plan_handoff",
  "metrics",
  "exa_code_search",
  "tavily_search",
  "tavily_extract",
] as const

const codemodeFalse = new Set(["delegate", "finish", "followup", "integrate", "checkpoint", "set_checks", "supersede", "stop"])

const notActor = (id: string): string =>
  `E_NOT_ACTOR: This session is not the owner of run ${id}. Call team tools from the run's own chat; do not session_move.`

interface TestToolHarness {
  readonly ctx: Context
  readonly tools: Map<string, Tool.Info & { readonly id: string }>
  readonly emit: (event: { type: string; data: unknown }) => void
  readonly triggerHook: <Name extends "execute.before" | "execute.after">(
    name: Name,
    event: ToolHooks[Name],
  ) => Effect.Effect<void>
}

function testToolContext(options: {
  directory?: string
  session?: unknown
} = {}): TestToolHarness {
  const base = toolHarness()
  const beforeHooks: Array<(event: ToolHooks["execute.before"]) => Effect.Effect<void>> = []
  const afterHooks: Array<(event: ToolHooks["execute.after"]) => Effect.Effect<void>> = []

  const domain = {
    ...base.domain,
    hook: (name: string, callback: unknown) =>
      Effect.sync(() => {
        if (name === "execute.before") {
          beforeHooks.push(callback as (event: ToolHooks["execute.before"]) => Effect.Effect<void>)
          return {
            dispose: Effect.sync(() => {
              const idx = beforeHooks.indexOf(callback as (event: ToolHooks["execute.before"]) => Effect.Effect<void>)
              if (idx !== -1) beforeHooks.splice(idx, 1)
            }),
          }
        }
        if (name === "execute.after") {
          afterHooks.push(callback as (event: ToolHooks["execute.after"]) => Effect.Effect<void>)
          return {
            dispose: Effect.sync(() => {
              const idx = afterHooks.indexOf(callback as (event: ToolHooks["execute.after"]) => Effect.Effect<void>)
              if (idx !== -1) afterHooks.splice(idx, 1)
            }),
          }
        }
        return { dispose: Effect.void }
      }),
  } as ToolDomain

  const pubsub = Effect.runSync(PubSub.unbounded<{ type: string; data: unknown }>())
  const event = {
    subscribe: () => Stream.fromPubSub(pubsub) as any,
  }

  const emit = (evt: { type: string; data: unknown }) => {
    Effect.runSync(PubSub.publish(pubsub, evt))
  }

  const triggerHook = <Name extends "execute.before" | "execute.after">(name: Name, evt: ToolHooks[Name]) =>
    Effect.gen(function* () {
      const hooks = name === "execute.before" ? beforeHooks : afterHooks
      for (const hook of hooks) {
        yield* (hook as (e: unknown) => Effect.Effect<void>)(evt)
      }
    })

  const location = options.directory
    ? new Location.Info({
        directory: AbsolutePath.make(options.directory),
        project: {
          id: Project.ID.global,
          directory: AbsolutePath.make(options.directory),
          canonical: AbsolutePath.make(options.directory),
        },
      })
    : undefined

  const ctx = context({
    tool: domain,
    event,
    ...(location ? { location } : {}),
    ...(options.session ? { session: options.session as Context["session"] } : {}),
  })

  return { ctx, tools: base.tools, emit, triggerHook }
}

function fixture(): { ctx: Context; tools: Map<string, Tool.Info & { readonly id: string }> } {
  const tc = testToolContext()
  return { ctx: tc.ctx, tools: tc.tools }
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
  expect(registered).toHaveLength(14)
  for (const [index, tool] of registered.entries()) {
    const name = teamNames[index] as string
    expect(tool.origin).toEqual({ type: "plugin", name: "opencode.plus" })
    expect(tool.options?.namespace).toBe("team")
    expect(tool.options?.codemode).toBe(!codemodeFalse.has(name))
    expect(tool.options?.permission).toBe(`team.${name}`)
  }
})

test("the team namespace advertises nothing it cannot do", async () => {
  const tools = await registeredTools()
  for (const name of removedNames) expect(tools.has(`team_${name}`)).toBe(false)
  expect([...tools.keys()].filter((id) => id.startsWith("team_")).toSorted()).toEqual(
    teamNames.map((name) => `team_${name}`).toSorted(),
  )
})

test("no registered team tool returns E_NOT_IMPLEMENTED for any role in its ceiling", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    await saveRun(root, makeRun("w-1111111111111111", "sol-orchestrator", "ses_team_impl_orch"))
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_impl_orch", "sol-orchestrator")
    for (const name of teamNames) {
      const outcome = await Effect.runPromise(
        need(tools, `team_${name}`).execute({}, ctx).pipe(
          Effect.map(() => ""),
          Effect.catchTag("Tool.Error", (error) => Effect.succeed(error.message)),
        ),
      )
      expect(outcome).not.toContain("E_NOT_IMPLEMENTED")
    }
  })
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
    const ctx = toolContext("ses_team_none_named", "muse-implementer")
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

test("any team tool from a no-run planner/orchestrator session bootstraps a root run, and is idempotent", async () => {
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
      const listTool = need(harness.tools, "team_list")
      const statusTool = need(harness.tools, "team_status")
      const toolCtx = toolContext("ses_team_root_001", "sol-orchestrator")

      // Any tool (e.g. team_list) from a no-run orchestrator session bootstraps a root run
      const listOutput = (await Effect.runPromise(listTool.execute({}, toolCtx).pipe(Effect.map((result) => result.output)))) as Record<
        string,
        unknown
      >[]
      expect(listOutput).toHaveLength(1)
      const created = String(listOutput[0]?.run)
      expect(created.startsWith("main-")).toBe(true)

      // A second call (e.g. team_status) is idempotent and reuses the existing main run
      const statusOutput = (await Effect.runPromise(statusTool.execute({}, toolCtx).pipe(Effect.map((result) => result.output)))) as Record<
        string,
        unknown
      >[]
      expect(statusOutput[0]?.run).toBe(created)
      const stored = await loadRun(root, created)
      expect(stored?.kind).toBe("main")
      expect(stored?.role).toBe("sol-orchestrator")
      expect(stored?.directory).toBe(repoDir)
      expect(stored?.sessionID).toBe("ses_team_root_001")
      expect(stored?.projectDirectory).toBe(repoDir)
      expect(stored?.base).toBe(head)
      expect(stored?.head).toBe(head)
      expect(stored?.paths).toEqual([])
      expect(stored?.state).toBe("working")
      expect(stored?.attempts).toHaveLength(1)
      expect(stored?.attempts[0]?.state).toBe("streaming")
      const entries = await fs.readdir(path.join(root, "runs"))
      const mains = entries.filter((entry) => entry.startsWith("main-"))
      expect(mains).toEqual([created])
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })
})

test("team_status from a no-run implementer session still fails E_NOT_ACTOR", async () => {
  await withIsolatedTeamsRoot(async () => {
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_prep_impl", "muse-implementer")
    const message = await runMessage(need(tools, "team_status"), {}, ctx)
    expect(message).toBe(notActor("unknown"))
  })
})

test("team_status naming runs from a no-run orchestrator session bootstraps a root run and queries normally", async () => {
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
      const tool = need(harness.tools, "team_status")
      const toolCtx = toolContext("ses_team_prep_orch_cwd", "sol-orchestrator")
      const message = await runMessage(tool, { runs: ["w-0000000000000000"] }, toolCtx)
      expect(message.startsWith("E_UNKNOWN_RUN:")).toBe(true)
      const bound = await bySession(root, "ses_team_prep_orch_cwd")
      expect(bound).toBeDefined()
      expect(bound?.kind).toBe("main")
      const runs = await fs.readdir(path.join(root, "runs")).catch(() => [])
      expect(runs).toEqual([bound!.id])
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })
})

// Item 19 is about the REGISTERED tool, which calls its own statusOf: assert
// through the tool seam, not through the query module's exported one.
test("team_status reports each run's worktree state through the registered tool", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const session = "ses_team_status_worktree"
    const caller = makeRun("w-5555555555555555", "sol-orchestrator", session)
    const removed: RunRecord = {
      ...makeRun("w-6666666666666666", "muse-implementer", "ses_team_status_removed"),
      parent: caller.id,
      worktree: "removed",
    }
    const live = { ...makeRun("w-7777777777777777", "muse-implementer", "ses_team_status_present"), parent: caller.id }
    await saveRun(root, caller)
    await saveRun(root, removed)
    await saveRun(root, live)
    const tools = await registeredTools()
    const output = (await runSuccess(
      need(tools, "team_status"),
      { runs: [removed.id, live.id] },
      toolContext(session, "sol-orchestrator"),
    )) as Array<Record<string, unknown>>
    expect(output.map((entry) => [entry.run, entry.worktree])).toEqual([
      [removed.id, "removed"],
      [live.id, "present"],
    ])
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
  expect([...created.tools.keys()].filter((id) => id.startsWith("team_"))).toHaveLength(14)
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

// A human rejection is audited from the permission event stream, which runs on
// its own fiber, so the line lands after the call has already failed. Wait for
// it, then let the stream settle, so "exactly one line" is a real claim.
async function settledToolCalls(
  root: string,
  match: (line: Record<string, unknown>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const select = async () =>
    (await auditLines(root).catch(() => [])).filter((line) => line.kind === "tool.call" && match(line))
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await select()).length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return select()
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for a tool.call audit line")
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

test("integrate, set_checks, supersede, stop and list reach real handlers", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    await saveRun(root, makeRun("w-dddddddddddddddd", "sol-orchestrator", "ses_team_orch"))
    const tools = await registeredTools()
    const ctx = toolContext("ses_team_orch", "sol-orchestrator")

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

function executeGated<A>(
  tool: Tool.Info & { readonly id: string },
  input: A,
  context: Tool.Context,
  permission: Permission.Interface,
  triggerHook: <Name extends "execute.before" | "execute.after">(
    name: Name,
    event: ToolHooks[Name],
  ) => Effect.Effect<void>,
): Effect.Effect<{ output?: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    yield* triggerHook("execute.before", {
      tool: tool.id,
      sessionID: context.sessionID,
      agent: context.agent,
      messageID: context.messageID,
      id: context.id,
      input,
    })

    const execution = yield* assertToolPermission(tool, tool.id, context).pipe(
      Effect.provideService(Permission.Service, permission),
      Effect.andThen(tool.execute(input, context)),
      Effect.map((result) => ({ value: result })),
      Effect.catchTag("Tool.Error", (failure) => Effect.succeed({ failure })),
    )
    const base = {
      tool: tool.id,
      sessionID: context.sessionID,
      agent: context.agent,
      messageID: context.messageID,
      id: context.id,
      input,
    }
    if ("failure" in execution) {
      const afterEvent: ToolHooks["execute.after"] = {
        ...base,
        status: "error",
        error: execution.failure,
      }
      yield* triggerHook("execute.after", afterEvent)
      return yield* Effect.fail(execution.failure)
    }
    const afterEvent: ToolHooks["execute.after"] = {
      ...base,
      status: "completed",
      result: {
        content: [],
        output: execution.value.output,
      },
    }
    yield* triggerHook("execute.after", afterEvent)
    return execution.value
  })
}

// A permission service that answers with core's own rule effects and error
// types, and publishes the two canonical permission events the way core's
// service does: `Asked` carries the whole request when one is created, and
// `Replied` is published before the deferred is resolved
// (`packages/core/src/permission.ts`).
function makeTestPermissionService(
  rules: Permission.Ruleset,
  emit?: (event: { type: string; data: unknown }) => void,
) {
  let counter = 0
  const asked: Permission.Request[] = []
  const pending = new Map<
    string,
    {
      request: Permission.Request
      deferred: Deferred.Deferred<void, Permission.DeclinedError | Permission.CorrectedError>
    }
  >()

  const service: Permission.Interface = {
    ask: () => Effect.die("unused ask"),
    assert: (input) =>
      Effect.gen(function* () {
        const winningRule = rules
          .filter(
            (r) =>
              r.action === input.action ||
              r.action === "*" ||
              (r.action.endsWith(".*") && input.action.startsWith(r.action.slice(0, -1))),
          )
          .at(-1)
        const effect = winningRule?.effect ?? "allow"
        if (effect === "deny") {
          return yield* Effect.fail(
            new Permission.BlockedError({
              permission: input.action,
              resources: [...input.resources],
              rules,
              reason: winningRule?.message,
            }),
          )
        }
        if (effect === "allow") return
        counter++
        const reqId = Schema.decodeSync(Permission.ID)(`perm_req_${counter}`)
        const deferred = yield* Deferred.make<void, Permission.DeclinedError | Permission.CorrectedError>()
        const request: Permission.Request = {
          id: reqId,
          sessionID: input.sessionID,
          action: input.action,
          resources: [...input.resources],
          source: input.source,
          message: winningRule?.message,
        }
        pending.set(reqId, { request, deferred })
        asked.push(request)
        if (emit) emit({ type: Permission.Event.Asked.type, data: request })
        return yield* Deferred.await(deferred).pipe(
          Effect.catchTag("Permission.DeclinedError", (err) => Effect.die(err)),
          Effect.ensuring(Effect.sync(() => pending.delete(reqId))),
        )
      }),
    reply: (input) =>
      Effect.gen(function* () {
        const item = pending.get(input.requestID)
        if (!item) return yield* Effect.fail(new Permission.NotFoundError({ requestID: input.requestID }))
        pending.delete(input.requestID)
        if (emit)
          emit({
            type: Permission.Event.Replied.type,
            data: { sessionID: item.request.sessionID, requestID: item.request.id, reply: input.reply },
          })
        if (input.reply === "reject") {
          return yield* Deferred.fail(
            item.deferred,
            input.message
              ? new Permission.CorrectedError({ feedback: input.message })
              : new Permission.DeclinedError(),
          )
        }
        return yield* Deferred.succeed(item.deferred, undefined)
      }),
    get: (id) => Effect.sync(() => pending.get(id)?.request),
    forSession: (sessionID) =>
      Effect.sync(() =>
        Array.from(pending.values())
          .filter((item) => item.request.sessionID === sessionID)
          .map((item) => item.request),
      ),
    list: () => Effect.sync(() => Array.from(pending.values()).map((item) => item.request)),
  }

  return {
    service,
    asked,
    pendingRequests: () => Array.from(pending.values()).map((item) => item.request),
  }
}

test("planner delegate under ask: allow creates run and audit line with asked:allow, deny refuses and writes asked:deny", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repoDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-planner-gate-"))
    try {
      await git(repoDir, ["init"])
      await git(repoDir, ["config", "user.name", "team-test"])
      await git(repoDir, ["config", "user.email", "team-test@local"])
      await fs.writeFile(path.join(repoDir, "README.md"), "# planner gate\n")
      await git(repoDir, ["add", "README.md"])
      await git(repoDir, ["commit", "-m", "feat: initial commit"])
      const head = await git(repoDir, ["rev-parse", "HEAD"])

      const sessionID = "ses_planner_gate_001"
      const plannerRun: RunRecord = {
        ...makeRun("main-planner000001", "fable-planner", sessionID),
        directory: repoDir,
        base: head,
        head,
        kind: "main",
      }
      await saveRun(root, plannerRun)

      const session = {
        create: () => Effect.succeed({ id: Session.ID.make("ses_child_001") }),
        prompt: () => Effect.succeed(undefined as never),
        switchModel: () => Effect.succeed(undefined as never),
        wait: () => Effect.succeed(undefined),
      } as unknown as Context["session"]
      const tc = testToolContext({ directory: repoDir, session })
      const api = createTeamApi(tc.ctx, createState())
      await registerTeamTools(tc.ctx, api)

      const delegateTool = need(tc.tools, "team_delegate")

      const rules: Permission.Ruleset = [
        { action: "team.delegate", resource: "*", effect: "ask", message: "Plan execution needs human approval" },
      ]

      const { service: permService, pendingRequests } = makeTestPermissionService(rules, tc.emit)

      // 1. First call: ALLOW
      const allowCtx: Tool.Context = {
        sessionID: Session.ID.make(sessionID),
        agent: Agent.ID.make("fable-planner"),
        messageID: SessionMessage.ID.make("msg_plan_allow"),
        id: Tool.CallID.make("call_plan_allow"),
        progress: () => Effect.void,
      }

      const delegateInput = Schema.decodeUnknownSync(Brief)({
        requestID: "r-allow-01",
        role: "sol-orchestrator",
        reason: "3 independent packages, each needs its own workers",
        objective: "Build the feature in an isolated worktree for test.",
        deliverable: { kind: "commit" as const },
        scope: { paths: ["packages/plus/src/*"] },
        checks: [{ id: "c1", argv: ["bun", "test", "test/a.test.ts"] }],
      })

      const allowFiber = Effect.runFork(
        executeGated(delegateTool, delegateInput, allowCtx, permService, tc.triggerHook),
      )

      while (pendingRequests().length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      const pending = pendingRequests()
      expect(pending).toHaveLength(1)
      expect(pending[0]?.action).toBe("team.delegate")
      expect(pending[0]?.source?.id).toBe("call_plan_allow")
      expect(pending[0]?.message).toBe("Plan execution needs human approval")

      await Effect.runPromise(permService.reply({ requestID: pending[0]!.id, reply: "once" }))

      const allowResult = (await Effect.runPromise(Fiber.join(allowFiber))) as { output?: Record<string, unknown> }
      expect(allowResult).toBeDefined()
      const childRunID = String(allowResult.output?.run ?? "")
      expect(childRunID.startsWith("w-")).toBe(true)

      const childRecord = await loadRun(root, childRunID)
      expect(childRecord).toBeDefined()
      expect(childRecord?.role).toBe("sol-orchestrator")

      // 2. Second call: DENY
      const denyCtx: Tool.Context = {
        sessionID: Session.ID.make(sessionID),
        agent: Agent.ID.make("fable-planner"),
        messageID: SessionMessage.ID.make("msg_plan_deny"),
        id: Tool.CallID.make("call_plan_deny"),
        progress: () => Effect.void,
      }

      const denyInput = Schema.decodeUnknownSync(Brief)({
        requestID: "r-deny-01",
        role: "sol-orchestrator",
        reason: "3 independent packages, each needs its own workers",
        objective: "Build another feature in an isolated worktree for test.",
        deliverable: { kind: "commit" as const },
        scope: { paths: ["packages/plus/src/*"] },
        checks: [{ id: "c2", argv: ["bun", "test", "test/b.test.ts"] }],
      })

      const denyFiber = Effect.runFork(
        executeGated(delegateTool, denyInput, denyCtx, permService, tc.triggerHook),
      )

      while (pendingRequests().length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      const pending2 = pendingRequests()
      expect(pending2).toHaveLength(1)
      expect(pending2[0]?.source?.id).toBe("call_plan_deny")

      await Effect.runPromise(
        permService.reply({
          requestID: pending2[0]!.id,
          reply: "reject",
          message: "Permission denied: operator rejected delegate",
        }),
      )

      const denyOutcome = await Effect.runPromise(
        Fiber.join(denyFiber).pipe(
          Effect.map(() => ({ ok: true as const, message: "" })),
          Effect.catchTag("Tool.Error", (err) => Effect.succeed({ ok: false as const, message: err.message })),
        ),
      )
      expect(denyOutcome.ok).toBe(false)
      expect(denyOutcome.message).toContain("Permission denied")

      // A rejection with feedback reaches BOTH observers: it publishes
      // permission.replied and, being a typed CorrectedError, also fires
      // execute.after. Exactly one of them writes the line.
      const denials = await settledToolCalls(root, (line) => line.tool === "team_delegate" && line.ok === false)
      expect(denials).toHaveLength(1)
      const denyLine = denials[0] as Record<string, unknown>
      expect(denyLine.code).toBe("E_PERMISSION")
      expect(denyLine.outcome).toBe("asked:deny")
      expect(denyLine.actor).toBe("fable-planner")
      expect(denyLine.sessionID).toBe(sessionID)

      const allowed = (await auditLines(root)).filter(
        (line) => line.kind === "tool.call" && line.tool === "team_delegate" && line.ok === true,
      )
      expect(allowed).toHaveLength(1)
      expect(allowed[0]?.outcome).toBe("asked:allow")
      expect(allowed[0]?.actor).toBe("fable-planner")
      expect(allowed[0]?.sessionID).toBe(sessionID)

      const v = await verify(root)
      expect(v.ok).toBe(true)
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })
})

// The plain TUI Reject: no feedback. Core answers it with DeclinedError, a
// deliberate defect, so the call never becomes a typed Tool.Error and no
// execute.after hook fires — permission.replied is the only trace it leaves.
test("a human rejection without feedback writes exactly one asked:deny line and the chain still verifies", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repoDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-decline-"))
    try {
      await git(repoDir, ["init"])
      await git(repoDir, ["config", "user.name", "team-test"])
      await git(repoDir, ["config", "user.email", "team-test@local"])
      await fs.writeFile(path.join(repoDir, "README.md"), "# planner decline\n")
      await git(repoDir, ["add", "README.md"])
      await git(repoDir, ["commit", "-m", "feat: initial commit"])
      const head = await git(repoDir, ["rev-parse", "HEAD"])

      const sessionID = "ses_planner_decline_001"
      const plannerRun: RunRecord = {
        ...makeRun("main-planner000002", "fable-planner", sessionID),
        directory: repoDir,
        base: head,
        head,
        kind: "main",
      }
      await saveRun(root, plannerRun)

      const session = {
        create: () => Effect.succeed({ id: Session.ID.make("ses_child_decline") }),
        prompt: () => Effect.succeed(undefined as never),
        switchModel: () => Effect.succeed(undefined as never),
        wait: () => Effect.succeed(undefined),
      } as unknown as Context["session"]
      const tc = testToolContext({ directory: repoDir, session })
      const api = createTeamApi(tc.ctx, createState())
      await registerTeamTools(tc.ctx, api)

      const rules: Permission.Ruleset = [
        { action: "team.delegate", resource: "*", effect: "ask", message: "Plan execution needs human approval" },
      ]
      const { service: permService, pendingRequests } = makeTestPermissionService(rules, tc.emit)

      const declineCtx: Tool.Context = {
        sessionID: Session.ID.make(sessionID),
        agent: Agent.ID.make("fable-planner"),
        messageID: SessionMessage.ID.make("msg_plan_decline"),
        id: Tool.CallID.make("call_plan_decline"),
        progress: () => Effect.void,
      }

      const declineInput = Schema.decodeUnknownSync(Brief)({
        requestID: "r-decline-01",
        role: "sol-orchestrator",
        reason: "3 independent packages, each needs its own workers",
        objective: "Delegate work the operator refuses outright, with no feedback.",
        deliverable: { kind: "commit" as const },
        scope: { paths: ["packages/plus/src/*"] },
        checks: [{ id: "c3", argv: ["bun", "test", "test/c.test.ts"] }],
      })

      const fiber = Effect.runFork(
        executeGated(need(tc.tools, "team_delegate"), declineInput, declineCtx, permService, tc.triggerHook),
      )

      while (pendingRequests().length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const request = pendingRequests()[0]!
      expect(request.source?.id).toBe("call_plan_decline")

      await Effect.runPromise(permService.reply({ requestID: request.id, reply: "reject" }))

      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
        ).toBe(true)

      const calls = await settledToolCalls(root, (line) => line.tool === "team_delegate")
      expect(calls).toHaveLength(1)
      const line = calls[0] as Record<string, unknown>
      expect(line.ok).toBe(false)
      expect(line.code).toBe("E_PERMISSION")
      expect(line.outcome).toBe("asked:deny")
      expect(line.actor).toBe("fable-planner")
      expect(line.sessionID).toBe(sessionID)
      expect(line.run).toBe(plannerRun.id)
      expect(typeof line.durationMs).toBe("number")
      expect("input" in line).toBe(false)

      const v = await verify(root)
      expect(v.ok).toBe(true)
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })
})

test("child session calling team_status executes without creating a permission request and writes outcome: allowed", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const sessionID = "ses_child_status_test"
    const childRunID = "w-child0000000001"
    const childRun: RunRecord = {
      ...makeRun(childRunID, "muse-implementer", sessionID),
      parent: "main-000000000000",
    }
    await saveRun(root, childRun)

    const tc = testToolContext()
    const api = createTeamApi(tc.ctx, createState())
    await registerTeamTools(tc.ctx, api)

    const statusTool = need(tc.tools, "team_status")

    const rules: Permission.Ruleset = [
      { action: "team.status", resource: "*", effect: "allow" },
    ]

    const { service: permService, asked, pendingRequests } = makeTestPermissionService(rules, tc.emit)

    const statusCtx: Tool.Context = {
      sessionID: Session.ID.make(sessionID),
      agent: Agent.ID.make("muse-implementer"),
      messageID: SessionMessage.ID.make("msg_child_status"),
      id: Tool.CallID.make("call_child_status"),
      progress: () => Effect.void,
    }

    const output = await Effect.runPromise(
      executeGated(statusTool, {}, statusCtx, permService, tc.triggerHook),
    )
    expect(output).toBeDefined()
    expect(asked).toHaveLength(0)
    expect(pendingRequests()).toHaveLength(0)

    const lines = await auditLines(root)
    const statusLine = lines.find((l) => l.tool === "team_status" && l.sessionID === sessionID)
    expect(statusLine).toBeDefined()
    expect(statusLine?.ok).toBe(true)
    expect(statusLine?.code).toBeNull()
    expect(statusLine?.outcome).toBe("allowed")
    expect(statusLine?.run).toBe(childRunID)
    expect(statusLine?.actor).toBe("muse-implementer")

    const v = await verify(root)
    expect(v.ok).toBe(true)
  })
})

test("partial deny: ceiling-denied team tool refuses at call time with E_PERMISSION and writes outcome: denied", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const sessionID = "ses_partial_deny_test"
    const implRunID = "w-impl0000000001"
    const implRun: RunRecord = {
      ...makeRun(implRunID, "muse-implementer", sessionID),
      parent: "main-000000000000",
    }
    await saveRun(root, implRun)

    const tc = testToolContext()
    const api = createTeamApi(tc.ctx, createState())
    await registerTeamTools(tc.ctx, api)

    const delegateTool = need(tc.tools, "team_delegate")

    const rules: Permission.Ruleset = [
      {
        action: "team.delegate",
        resource: "*",
        effect: "deny",
        message: "team_delegate is outside the implementer ceiling",
      },
    ]

    const { service: permService, asked, pendingRequests } = makeTestPermissionService(rules, tc.emit)

    const ctx: Tool.Context = {
      sessionID: Session.ID.make(sessionID),
      agent: Agent.ID.make("muse-implementer"),
      messageID: SessionMessage.ID.make("msg_partial_deny"),
      id: Tool.CallID.make("call_partial_deny"),
      progress: () => Effect.void,
    }

    const outcome = await Effect.runPromise(
      executeGated(delegateTool, {}, ctx, permService, tc.triggerHook).pipe(
        Effect.map(() => ({ ok: true as const, message: "" })),
        Effect.catchTag("Tool.Error", (err) => Effect.succeed({ ok: false as const, message: err.message })),
      ),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toBe("team_delegate is outside the implementer ceiling")
    expect(asked).toHaveLength(0)
    expect(pendingRequests()).toHaveLength(0)

    const lines = await auditLines(root)
    const denyLine = lines.find((l) => l.tool === "team_delegate" && l.sessionID === sessionID)
    expect(denyLine).toBeDefined()
    expect(denyLine?.ok).toBe(false)
    expect(denyLine?.code).toBe("E_PERMISSION")
    expect(denyLine?.outcome).toBe("denied")
    expect(denyLine?.run).toBe(implRunID)
    expect(denyLine?.actor).toBe("muse-implementer")

    const v = await verify(root)
    expect(v.ok).toBe(true)
  })
})

// Under Code Mode one `execute` runs every inner call against one Tool.Context,
// so two team tools share one CallID and one messageID. The per-call audit
// state is keyed on (session, message, CallID) and queued, so a sibling that
// completes first cannot consume the pending call's refusal line.
test("two Code Mode calls that share one CallID write two distinct audit lines", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const sessionID = "ses_shared_call_id"
    const plannerRun: RunRecord = {
      ...makeRun("main-sharedcall0001", "fable-planner", sessionID),
      kind: "main",
    }
    await saveRun(root, plannerRun)

    const tc = testToolContext()
    const api = createTeamApi(tc.ctx, createState())
    await registerTeamTools(tc.ctx, api)

    const rules: Permission.Ruleset = [
      { action: "team.delegate", resource: "*", effect: "ask", message: "Plan execution needs human approval" },
    ]
    const { service: permService, pendingRequests } = makeTestPermissionService(rules, tc.emit)

    // One Code Mode `execute` context: same CallID, same messageID, same agent.
    const shared: Tool.Context = {
      sessionID: Session.ID.make(sessionID),
      agent: Agent.ID.make("fable-planner"),
      messageID: SessionMessage.ID.make("msg_codemode_shared"),
      id: Tool.CallID.make("call_codemode_shared"),
      progress: () => Effect.void,
    }

    const brief = Schema.decodeUnknownSync(Brief)({
      requestID: "r-shared-1",
      role: "sol-orchestrator",
      reason: "3 independent packages, each needs its own workers",
      objective: "Delegate while a sibling team call shares the same CallID.",
      deliverable: { kind: "commit" as const },
      scope: { paths: ["packages/plus/src/*"] },
      checks: [{ id: "c1", argv: ["bun", "test", "test/a.test.ts"] }],
    })

    // Call 1 waits on the human's answer.
    const delegateFiber = Effect.runFork(
      executeGated(need(tc.tools, "team_delegate"), brief, shared, permService, tc.triggerHook),
    )
    while (pendingRequests().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const request = pendingRequests()[0]!
    expect(request.source?.id).toBe("call_codemode_shared")
    expect(request.source?.messageID).toBe("msg_codemode_shared")

    // Call 2 completes under the same CallID while call 1 still waits.
    const status = await Effect.runPromise(
      executeGated(need(tc.tools, "team_status"), {}, shared, permService, tc.triggerHook),
    )
    expect(status).toBeDefined()

    // Call 1 is rejected with feedback: both observers fire for it.
    await Effect.runPromise(
      permService.reply({
        requestID: request.id,
        reply: "reject",
        message: "Permission denied: operator rejected delegate",
      }),
    )
    const denied = await Effect.runPromise(
      Fiber.join(delegateFiber).pipe(
        Effect.map(() => ({ ok: true as const, message: "" })),
        Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, message: error.message })),
      ),
    )
    expect(denied.ok).toBe(false)
    expect(denied.message).toContain("Permission denied")

    await settledToolCalls(root, (line) => line.tool === "team_delegate")
    const calls = (await auditLines(root)).filter((line) => line.kind === "tool.call")
    expect(calls.map((line) => [line.tool, line.outcome, line.ok, line.sessionID, line.run])).toEqual([
      ["team_status", "allowed", true, sessionID, plannerRun.id],
      ["team_delegate", "asked:deny", false, sessionID, plannerRun.id],
    ])
    // Item 11 evidence: the two lines one shared CallID produced.
    console.log(
      `[T5 item 11] shared CallID "call_codemode_shared" →\n` +
        calls
          .map(
            (line) =>
              `  ${JSON.stringify({
                tool: line.tool,
                outcome: line.outcome,
                ok: line.ok,
                code: line.code,
                actor: line.actor,
                sessionID: line.sessionID,
                run: line.run,
                seq: line.seq,
              })}`,
          )
          .join("\n"),
    )

    const v = await verify(root)
    expect(v.ok).toBe(true)
  })
})

// Item C: null-as-omission must hold at every depth of every registered tool
// schema. Paths are derived from the schema ASTs — struct fields, array
// elements, and fields behind optional/default wrappers all appear — so a new
// field is covered automatically and a silently empty enumeration cannot pass.
// Each path is exercised through the registered schema twice: once with the
// field set to null and once with the key omitted. Omission is the oracle:
// where omission decodes, null must decode to the same value; where omission is
// invalid (a required field), null must fail with a SchemaError.
type FieldPath = ReadonlyArray<string | number>

const MISSING = Symbol("plus-test-missing-value")

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function structAt(ast: SchemaAST.AST): SchemaAST.Objects | undefined {
  if (SchemaAST.isObjects(ast)) return ast
  if (SchemaAST.isUnion(ast)) {
    for (const member of ast.types) {
      const found = structAt(member)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (SchemaAST.isSuspend(ast)) return structAt(ast.thunk())
  return undefined
}

function arrayAt(ast: SchemaAST.AST): SchemaAST.Arrays | undefined {
  if (SchemaAST.isArrays(ast)) return ast
  if (SchemaAST.isUnion(ast)) {
    for (const member of ast.types) {
      const found = arrayAt(member)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (SchemaAST.isSuspend(ast)) return arrayAt(ast.thunk())
  return undefined
}

function elementAt(array: SchemaAST.Arrays, index: number): SchemaAST.AST | undefined {
  return array.elements[index] ?? array.rest[0]
}

// A value satisfying a node's required fields, used only to materialize
// containers the base fixture does not already carry.
function materialize(ast: SchemaAST.AST): unknown {
  if (SchemaAST.isUnion(ast)) {
    for (const member of ast.types) {
      const value = materialize(member)
      if (value !== MISSING) return value
    }
    return MISSING
  }
  if (SchemaAST.isSuspend(ast)) return materialize(ast.thunk())
  if (SchemaAST.isObjects(ast)) {
    const out: Record<string, unknown> = {}
    for (const ps of ast.propertySignatures) {
      if (SchemaAST.isOptional(ps.type)) continue
      const value = materialize(ps.type)
      if (value === MISSING) return MISSING
      out[String(ps.name)] = value
    }
    return out
  }
  if (SchemaAST.isArrays(ast)) {
    const out: unknown[] = []
    for (const element of ast.elements) {
      const value = materialize(element)
      if (value === MISSING) return MISSING
      out.push(value)
    }
    return out
  }
  switch (ast._tag) {
    case "String":
      return "materialized sample value for tests"
    case "Number":
      return 1
    case "Boolean":
      return true
    case "Literal":
      return ast.literal
    case "Null":
      return null
    case "Undefined":
      return undefined
    default:
      return MISSING
  }
}

function collectFieldPaths(ast: SchemaAST.AST, prefix: FieldPath, out: FieldPath[]): void {
  if (SchemaAST.isUnion(ast)) {
    for (const member of ast.types) collectFieldPaths(member, prefix, out)
    return
  }
  if (SchemaAST.isSuspend(ast)) {
    collectFieldPaths(ast.thunk(), prefix, out)
    return
  }
  if (SchemaAST.isObjects(ast)) {
    for (const ps of ast.propertySignatures) {
      const path = [...prefix, String(ps.name)]
      out.push(path)
      collectFieldPaths(ps.type, path, out)
    }
    return
  }
  if (SchemaAST.isArrays(ast)) {
    if (ast.elements.length > 0) {
      ast.elements.forEach((element, index) => collectFieldPaths(element, [...prefix, index], out))
      return
    }
    if (ast.rest[0] !== undefined) collectFieldPaths(ast.rest[0], [...prefix, 0], out)
  }
}

// Returns `value` with `path` materialized and its leaf either set to null
// ("null") or removed ("omit"). Both modes materialize the same containers, so
// the two results differ only in the leaf key.
function mutatePath(ast: SchemaAST.AST, value: unknown, path: FieldPath, mode: "null" | "omit"): unknown {
  const head = path[0]
  if (head === undefined) return mode === "omit" ? MISSING : null
  const rest = path.slice(1)
  if (typeof head === "number") {
    const array = arrayAt(ast)
    if (array === undefined) return value
    const out: unknown[] = Array.isArray(value) ? [...value] : []
    for (let index = out.length; index < head; index++) {
      const filler = elementAt(array, index)
      const materialized = filler === undefined ? MISSING : materialize(filler)
      out[index] = materialized === MISSING ? undefined : materialized
    }
    const element = elementAt(array, head)
    if (element === undefined) return out
    const current = out[head] !== undefined ? out[head] : materialize(element)
    if (current === MISSING) return out
    const next = mutatePath(element, current, rest, mode)
    if (next === MISSING) out.splice(head, 1)
    else out[head] = next
    return out
  }
  const struct = structAt(ast)
  if (struct === undefined) return value
  const field = struct.propertySignatures.find((ps) => ps.name === head)
  if (field === undefined) return value
  const materialized = materialize(struct)
  const record = isRecord(value) ? { ...value } : isRecord(materialized) ? { ...materialized } : {}
  const current = record[head] !== undefined ? record[head] : materialize(field.type)
  if (current === MISSING) return record
  const next = mutatePath(field.type, current, rest, mode)
  if (next === MISSING) delete record[head]
  else record[head] = next
  return record
}

function pathLabel(path: FieldPath): string {
  return path
    .map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`))
    .join("")
    .replace(/^\./, "")
}

function registeredSchema(tools: Map<string, Tool.Info & { readonly id: string }>, id: string) {
  const input = need(tools, id).input
  if (!Schema.isSchema(input)) throw new Error(`${id} input is not a schema`)
  return input
}

test("C — every field path of every registered team tool treats null as omission, required null still fails", async () => {
  const tools = await registeredTools()

  const baseInputs: Record<string, Record<string, unknown>> = {
    team_delegate: {
      requestID: "req-1",
      role: "gemini-implementer",
      objective: "Implement null-tolerant tool inputs cleanly",
      deliverable: { kind: "commit" },
      scope: { paths: ["a.ts"] },
    },
    team_finish: {
      status: "done",
      summary: "Finished all changes cleanly",
    },
    team_followup: {
      run: "w-0123456789abcdef",
      requestID: "req-followup-1",
      prompt: "Followup prompt text",
    },
    team_integrate: {
      run: "w-0123456789abcdef",
      expectedParentHead: "0123456789abcdef0123456789abcdef01234567",
    },
    team_checkpoint: {
      message: "fix: clean checkpoint",
      expectedHead: "0123456789abcdef0123456789abcdef01234567",
      files: ["a.ts"],
    },
    team_set_checks: {
      checks: [{ id: "c1", argv: ["bun", "test", "test.ts"] }],
    },
    team_supersede: {
      run: "w-0123456789abcdef",
      reason: "Superseding this run for testing purposes",
    },
    team_stop: {
      run: "w-0123456789abcdef",
    },
    team_status: {},
    team_wait: {
      runs: ["w-0123456789abcdef"],
    },
    team_diff: {
      run: "w-0123456789abcdef",
    },
    team_list: {},
    team_get_context: {},
    team_check: {
      id: "check-1",
    },
  }

  const regressionPaths: Array<[string, FieldPath]> = [
    ["team_set_checks", ["checks", 0, "cwd"]],
    ["team_delegate", ["context", "interfaces", 0, "symbol"]],
    ["team_followup", ["budget", "turns"]],
  ]

  const covered = new Set<string>()
  let totalFieldPaths = 0
  let totalOptionalFieldsTested = 0
  let totalRequiredFieldsTested = 0

  for (const [id, tool] of tools) {
    if (!id.startsWith("team_")) continue
    const schema = registeredSchema(tools, id)
    const base = baseInputs[id] ?? {}
    const root = structAt(schema.ast)
    const paths: FieldPath[] = []
    collectFieldPaths(schema.ast, [], paths)
    if (root === undefined || root.propertySignatures.length > 0) expect(paths.length).toBeGreaterThan(0)

    for (const path of paths) {
      totalFieldPaths++
      const withNull = mutatePath(schema.ast, base, path, "null")
      const omitted = mutatePath(schema.ast, base, path, "omit")
      const omittedResult = Schema.decodeUnknownOption(schema)(omitted)
      const nullResult = Schema.decodeUnknownOption(schema)(withNull)
      if (Option.isSome(omittedResult)) {
        totalOptionalFieldsTested++
        covered.add(`${id}:${pathLabel(path)}`)
        let decodedNull: unknown
        try {
          decodedNull = Schema.decodeUnknownSync(schema)(withNull)
        } catch (error) {
          throw new Error(`${id}: null at ${pathLabel(path)} was rejected — ${(error as Error).message}`)
        }
        expect(decodedNull).toEqual(omittedResult.value)
      } else {
        totalRequiredFieldsTested++
        expect(Option.isNone(nullResult)).toBe(true)
        expect(() => Schema.decodeUnknownSync(schema)(withNull)).toThrow(Schema.SchemaError)
      }
    }
  }

  for (const [id, path] of regressionPaths) expect(covered.has(`${id}:${pathLabel(path)}`)).toBe(true)
  expect(totalFieldPaths).toBeGreaterThan(60)
  expect(totalOptionalFieldsTested).toBeGreaterThan(15)
  expect(totalRequiredFieldsTested).toBeGreaterThan(10)
})

test("C1 — null in an array element field decodes as omission (set_checks checks[0].cwd)", async () => {
  const schema = registeredSchema(await registeredTools(), "team_set_checks")
  const omitted = Schema.decodeUnknownSync(schema)({ checks: [{ id: "x", argv: ["bun", "test", "test/x.test.ts"] }] })
  const withNull = { checks: [{ id: "x", argv: ["bun", "test", "test/x.test.ts"], cwd: null }] }
  expect(Schema.decodeUnknownSync(schema)(withNull)).toEqual(omitted)
})

test("C2 — null inside a default-wrapped array element decodes as omission (brief context.interfaces[0].symbol)", async () => {
  const schema = registeredSchema(await registeredTools(), "team_delegate")
  const brief = {
    requestID: "T1-a",
    role: "muse-implementer",
    objective: "Make the agent filter apply in the list tool output.",
    deliverable: { kind: "commit" },
    scope: { paths: ["packages/plus/src/x.ts"] },
  }
  const omitted = Schema.decodeUnknownSync(schema)({
    ...brief,
    context: { interfaces: [{ path: "note.md", note: "test" }] },
  })
  expect(
    Schema.decodeUnknownSync(schema)({
      ...brief,
      context: { interfaces: [{ path: "note.md", note: "test", symbol: null }] },
    }),
  ).toEqual(omitted)
})

test("C3 — null inside an optional struct field decodes as omission (followup budget.turns)", async () => {
  const schema = registeredSchema(await registeredTools(), "team_followup")
  const base = { run: "w-0123456789abcdef", requestID: "probe-budget", prompt: "test" }
  const omitted = Schema.decodeUnknownSync(schema)({ ...base, budget: {} })
  expect(Schema.decodeUnknownSync(schema)({ ...base, budget: { turns: null } })).toEqual(omitted)
})

test("C4 — null on required fields still fails with a schema error at every depth", async () => {
  const tools = await registeredTools()
  const brief = {
    requestID: "T1-a",
    role: "muse-implementer",
    objective: "Make the agent filter apply in the list tool output.",
    deliverable: { kind: "commit" },
    scope: { paths: ["packages/plus/src/x.ts"] },
  }
  const cases: Array<[string, unknown]> = [
    ["team_delegate", { ...brief, objective: null }],
    ["team_delegate", { ...brief, checks: [{ id: null, argv: ["bun", "test", "test/x.test.ts"] }] }],
    ["team_delegate", { ...brief, context: { interfaces: [{ path: null, note: "test" }] } }],
    ["team_followup", { run: null, requestID: "probe-budget", prompt: "test" }],
    ["team_finish", { status: null, summary: "Finished all changes cleanly" }],
  ]
  for (const [id, input] of cases) {
    const schema = registeredSchema(tools, id)
    expect(Option.isNone(Schema.decodeUnknownOption(schema)(input))).toBe(true)
    expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow(Schema.SchemaError)
  }
})

test("D — a home session with a non-repo location gets E_NOT_ACTOR and creates no root run record", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const nonRepoDir = await fs.mkdtemp("/tmp/plus-team-no-repo-")
    try {
      const harness = toolHarness()
      const directory = AbsolutePath.make(nonRepoDir)
      const location = new Location.Info({
        directory,
        project: { id: Project.ID.global, directory, canonical: directory },
      })
      const pluginCtx = context({ tool: harness.domain, location })
      const api = createTeamApi(pluginCtx, createState())
      await registerTeamTools(pluginCtx, api)
      const tool = need(harness.tools, "team_get_context")
      const toolCtx = toolContext("ses_home_session_no_repo", "sol-orchestrator")

      const error = await Effect.runPromise(
        tool.execute({}, toolCtx).pipe(
          Effect.map(() => undefined),
          Effect.catchTag("Tool.Error", (e) => Effect.succeed(e)),
        ),
      )

      expect(error).toBeDefined()
      expect(error?.message).toBe(
        "E_NOT_ACTOR: This session has no repository directory; open the chat in a git repository to use team tools.",
      )

      const runsDir = path.join(root, "runs")
      const entries = await fs.readdir(runsDir).catch(() => [])
      expect(entries).toEqual([])
    } finally {
      await fs.rm(nonRepoDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

