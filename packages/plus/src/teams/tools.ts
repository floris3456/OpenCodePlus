import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import path from "node:path"
import { runRegistration } from "../instructions/apply.js"
import { teamsDataDir } from "../instructions/paths.js"
import { append } from "./audit.js"
import type { TeamApi, TeamApiResult, TeamCaller } from "./api.js"
import { gitRaw } from "./git.js"
import { kindOf, toolsByServer, type TeamTool } from "./policy.js"
import { attemptTransition, bySession, newRunID, saveRun, startAttempt, type RunRecord } from "./run.js"
import {
  Brief,
  CheckInput,
  CheckpointInput,
  DiffInput,
  ExaCodeSearchInput,
  FollowupInput,
  GetContextInput,
  IntegrateInput,
  ListInput,
  MetricsInput,
  PlanHandoffInput,
  PrepareInput,
  Report,
  ResumeInput,
  ReviewInput,
  SetChecksInput,
  ShutdownRequestInput,
  StatusInput,
  StopInput,
  SupersedeInput,
  TavilyExtractInput,
  TavilySearchInput,
  WaitInput,
} from "./schema.js"

const namespace = "team"
const origin = { type: "plugin", name: "opencode.plus" } as const

const DelegateDescription = "Start a bounded task in a new isolated worktree. One call = one run."
const FinishDescription = "Declare an outcome for the current attempt.\nDone, blocked, or needs-context with evidence the parent verifies."
const FollowupDescription = "Send a correction to an owned child.\nQueue it for idle delivery, or deliver now when the child is idle."
const ReviewDescription = "Claim completion and request independent verification.\nRuns stale checks first, then starts a reviewer run."
const IntegrateDescription = "Enqueue a child's completed commit into the merge queue.\nLands synchronously when the queue is empty and the parent is clean."
const CheckpointDescription = "Commit only intended files in your own worktree after checking expected HEAD."
const SetChecksDescription = "Record the integration checks for the current task.\nOutput is the check ids."
const SupersedeDescription = "Abandon an owned child and cancel its task.\nWorking children get a shutdown request first, then an interrupt."
const ShutdownRequestDescription = "Ask an owned child to stop after its turn.\nIdempotent; the sweeper marks stopping when the turn ends."
const StopDescription = "Stop an idle owned child.\nWorking children fail E_BUSY; stopped children succeed as a no-op."
const ResumeDescription = "Resume a stopped or dead owned child.\nDead registrations are probed once and replaced when not live."
const PrepareDescription = "Install worktree dependencies from a frozen bun.lock.\nRetained for repos without an after_create hook."
const PlanHandoffDescription = "Validate a plan file and start an orchestrator with it.\nRequires authorization:true after the human approved the plan."
const StatusDescription = "Show status of your run and children in this namespace.\nDefaults to self plus direct children. Read-only; never acknowledges."
const WaitDescription = "Wait for child runs to settle or go idle.\nReturns settled, timedOut, stillOpen and overBudget lists."
const DiffDescription = "Show a run's worktree diff against a ref or base.\nLarge patches truncate to maxBytes with truncated:true."
const ListDescription = "List runs in this namespace, optionally filtered.\nHidden states (superseded, reaped) need all:true. Read-only."
const GetContextDescription = "Load your brief, checks, siblings, inbox and budget.\nCall first, then execute the Brief."
const CheckDescription = "Run one assigned focused check in your worktree.\nUnknown ids fail with E_UNKNOWN_CHECK."
const MetricsDescription = "Aggregate tool-call metrics from the audit chain.\nComputed from tool.call events, not the SQLite stores."
const ExaCodeSearchDescription =
  "Find real code examples via Exa code search.\nBe specific about language, framework and version. Prefer highlights over full text to get targeted code snippets."
const TavilySearchDescription = "Search the web via Tavily with scored snippets.\nPrefer specific queries under 400 chars."
const TavilyExtractDescription =
  "Extract clean content from up to 20 page URLs.\nProvide a query with chunks_per_source to return only the most relevant chunks and avoid context bloat."

export async function registerTeamTools(ctx: Context, api: TeamApi): Promise<Registration> {
  return runRegistration(ctx.tool.transform, (editor) => {
    editor.namespace({ name: namespace, description: "Team runs: delegate work, report outcomes, and read run state." })
    editor.add({
      name: "delegate",
      description: DelegateDescription,
      input: Brief,
      output: Schema.Unknown,
      options: teamOptions("delegate", false),
      origin,
      execute: (input, context) => runGated("delegate", input, context, ctx, (args, caller) => api.delegate(args, caller)),
    })
    editor.add({
      name: "finish",
      description: FinishDescription,
      input: Report,
      output: Schema.Unknown,
      options: teamOptions("finish", false),
      origin,
      execute: (input, context) => runGated("finish", input, context, ctx, (args, caller) => api.finish(args, caller)),
    })
    editor.add({
      name: "followup",
      description: FollowupDescription,
      input: FollowupInput,
      output: Schema.Unknown,
      options: teamOptions("followup", false),
      origin,
      execute: (input, context) => runGated("followup", input, context, ctx, (args, caller) => api.followup(args, caller)),
    })
    editor.add({
      name: "review",
      description: ReviewDescription,
      input: ReviewInput,
      output: Schema.Unknown,
      options: teamOptions("review", false),
      origin,
      execute: (input, context) => runGated("review", input, context, ctx, (args, caller) => api.review(args, caller)),
    })
    editor.add({
      name: "integrate",
      description: IntegrateDescription,
      input: IntegrateInput,
      output: Schema.Unknown,
      options: teamOptions("integrate", false),
      origin,
      execute: (input, context) => runGated("integrate", input, context, ctx, (args, caller) => api.integrate(args, caller)),
    })
    editor.add({
      name: "checkpoint",
      description: CheckpointDescription,
      input: CheckpointInput,
      output: Schema.Unknown,
      options: teamOptions("checkpoint", false),
      origin,
      execute: (input, context) => runGated("checkpoint", input, context, ctx, (args, caller) => api.checkpoint(args, caller)),
    })
    editor.add({
      name: "set_checks",
      description: SetChecksDescription,
      input: SetChecksInput,
      output: Schema.Unknown,
      options: teamOptions("set_checks", false),
      origin,
      execute: (input, context) => runGated("set_checks", input, context, ctx, (args, caller) => api.set_checks(args, caller)),
    })
    editor.add({
      name: "supersede",
      description: SupersedeDescription,
      input: SupersedeInput,
      output: Schema.Unknown,
      options: teamOptions("supersede", false),
      origin,
      execute: (input, context) => runGated("supersede", input, context, ctx, (args, caller) => api.supersede(args, caller)),
    })
    editor.add({
      name: "shutdown_request",
      description: ShutdownRequestDescription,
      input: ShutdownRequestInput,
      output: Schema.Unknown,
      options: teamOptions("shutdown_request", false),
      origin,
      execute: (input, context) => runGated("shutdown_request", input, context, ctx, (args, caller) => api.shutdown_request(args, caller)),
    })
    editor.add({
      name: "stop",
      description: StopDescription,
      input: StopInput,
      output: Schema.Unknown,
      options: teamOptions("stop", false),
      origin,
      execute: (input, context) => runGated("stop", input, context, ctx, (args, caller) => api.stop(args, caller)),
    })
    editor.add({
      name: "resume",
      description: ResumeDescription,
      input: ResumeInput,
      output: Schema.Unknown,
      options: teamOptions("resume", false),
      origin,
      execute: (input, context) => runGated("resume", input, context, ctx, (args, caller) => api.resume(args, caller)),
    })
    editor.add({
      name: "prepare",
      description: PrepareDescription,
      input: PrepareInput,
      output: Schema.Unknown,
      options: teamOptions("prepare", false),
      origin,
      execute: (input, context) => runGated("prepare", input, context, ctx, (args, caller) => api.prepare(args, caller)),
    })
    editor.add({
      name: "plan_handoff",
      description: PlanHandoffDescription,
      input: PlanHandoffInput,
      output: Schema.Unknown,
      options: teamOptions("plan_handoff", false),
      origin,
      execute: (input, context) => runGated("plan_handoff", input, context, ctx, (args, caller) => api.plan_handoff(args, caller)),
    })
    editor.add({
      name: "status",
      description: StatusDescription,
      input: StatusInput,
      output: Schema.Unknown,
      options: teamOptions("status", true),
      origin,
      execute: (input, context) => runGated("status", input, context, ctx, (args, caller) => api.status(args, caller)),
    })
    editor.add({
      name: "wait",
      description: WaitDescription,
      input: WaitInput,
      output: Schema.Unknown,
      options: teamOptions("wait", true),
      origin,
      execute: (input, context) => runGated("wait", input, context, ctx, (args, caller) => api.wait(args, caller)),
    })
    editor.add({
      name: "diff",
      description: DiffDescription,
      input: DiffInput,
      output: Schema.Unknown,
      options: teamOptions("diff", true),
      origin,
      execute: (input, context) => runGated("diff", input, context, ctx, (args, caller) => api.diff(args, caller)),
    })
    editor.add({
      name: "list",
      description: ListDescription,
      input: ListInput,
      output: Schema.Unknown,
      options: teamOptions("list", true),
      origin,
      execute: (input, context) => runGated("list", input, context, ctx, (args, caller) => api.list(args, caller)),
    })
    editor.add({
      name: "get_context",
      description: GetContextDescription,
      input: GetContextInput,
      output: Schema.Unknown,
      options: teamOptions("get_context", true),
      origin,
      execute: (input, context) => runGated("get_context", input, context, ctx, (args, caller) => api.get_context(args, caller)),
    })
    editor.add({
      name: "check",
      description: CheckDescription,
      input: CheckInput,
      output: Schema.Unknown,
      options: teamOptions("check", true),
      origin,
      execute: (input, context) => runGated("check", input, context, ctx, (args, caller) => api.check(args, caller)),
    })
    editor.add({
      name: "metrics",
      description: MetricsDescription,
      input: MetricsInput,
      output: Schema.Unknown,
      options: teamOptions("metrics", true),
      origin,
      execute: (input, context) => runGated("metrics", input, context, ctx, (args, caller) => api.metrics(args, caller)),
    })
    editor.add({
      name: "exa_code_search",
      description: ExaCodeSearchDescription,
      input: ExaCodeSearchInput,
      output: Schema.Unknown,
      options: teamOptions("exa_code_search", true),
      origin,
      execute: (input, context) => runGated("exa_code_search", input, context, ctx, (args, caller) => api.exa_code_search(args, caller)),
    })
    editor.add({
      name: "tavily_search",
      description: TavilySearchDescription,
      input: TavilySearchInput,
      output: Schema.Unknown,
      options: teamOptions("tavily_search", true),
      origin,
      execute: (input, context) => runGated("tavily_search", input, context, ctx, (args, caller) => api.tavily_search(args, caller)),
    })
    editor.add({
      name: "tavily_extract",
      description: TavilyExtractDescription,
      input: TavilyExtractInput,
      output: Schema.Unknown,
      options: teamOptions("tavily_extract", true),
      origin,
      execute: (input, context) => runGated("tavily_extract", input, context, ctx, (args, caller) => api.tavily_extract(args, caller)),
    })
  })
}

function teamOptions(name: TeamTool, codemode: boolean) {
  return { namespace, codemode, permission: `team.${name}` }
}

function runGated(
  name: TeamTool,
  input: unknown,
  toolCtx: Tool.Context,
  pluginCtx: Context,
  call: (args: any, caller: TeamCaller) => Promise<TeamApiResult>,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const agent = String(toolCtx.agent)
    const sessionID = String(toolCtx.sessionID)
    const start = Date.now()
    const auditState: { run: string | null } = { run: null }
    const settled = yield* runGatedInner(name, input, toolCtx, pluginCtx, call, auditState).pipe(
      Effect.map((result) => ({ ok: true as const, output: result.output })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, message: error.message })),
    )
    const durationMs = Date.now() - start
    const ok = settled.ok
    const code = settled.ok ? null : codeOf(settled.message)
    yield* Effect.ignore(
      Effect.tryPromise({
        try: () =>
          append(teamsDataDir(), "tool.call", {
            run: auditState.run,
            actor: agent,
            sessionID,
            tool: `team_${name}`,
            ok,
            code,
            durationMs,
          }),
        catch: () => undefined,
      }),
    )
    if (!settled.ok) return yield* Effect.fail(new Tool.Error({ message: settled.message }))
    return { output: settled.output }
  })
}

function runGatedInner(
  name: TeamTool,
  input: unknown,
  toolCtx: Tool.Context,
  pluginCtx: Context,
  call: (args: any, caller: TeamCaller) => Promise<TeamApiResult>,
  auditState: { run: string | null },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const agent = String(toolCtx.agent)
    const sessionID = String(toolCtx.sessionID)
    const run = yield* Effect.promise(() => bySession(teamsDataDir(), sessionID))
    auditState.run = run?.id ?? null
    if (run === undefined && name === "prepare" && isRootPrepareInput(input)) {
      const kind = kindOf(agent)
      // Root-run bootstrap, the single no-run exception: a planner or
      // orchestrator session calling prepare becomes the main run. All
      // other no-run calls fall through to requireActor and keep the
      // byte-exact E_NOT_ACTOR message.
      if (kind.ok && (kind.kind === "planner" || kind.kind === "orchestrator")) {
        const directory = String(pluginCtx.location.directory)
        const top = yield* Effect.promise(() => gitRaw(directory, ["rev-parse", "--show-toplevel"]))
        if (top.code !== 0)
          return yield* Effect.fail(
            new Tool.Error({ message: `E_INTERNAL: Cannot resolve repository from ${directory}: ${top.err || top.out || "unknown error"}` }),
          )
        const headOut = yield* Effect.promise(() => gitRaw(directory, ["rev-parse", "HEAD"]))
        if (headOut.code !== 0)
          return yield* Effect.fail(
            new Tool.Error({ message: `E_INTERNAL: Cannot read HEAD from ${directory}: ${headOut.err || headOut.out || "unknown error"}` }),
          )
        const branchOut = yield* Effect.promise(() => gitRaw(directory, ["rev-parse", "--abbrev-ref", "HEAD"]))
        const branch = branchOut.code === 0 && branchOut.out.length > 0 ? branchOut.out : "HEAD"
        const now = new Date().toISOString()
        const repoKey = path.basename(top.out) || top.out
        const base = startAttempt(
          {
            id: newRunID("main"),
            role: agent,
            kind: "main",
            repo: repoKey,
            repoKey,
            directory,
            paths: [],
            branch,
            base: headOut.out,
            head: headOut.out,
            state: "working",
            attempts: [],
            task: null,
            parent: null,
            children: [],
            briefSha: "",
            bundle: "root",
            budget: {},
            createdAt: now,
            lastUsed: now,
            sessionID,
            configDigest: null,
            history: [],
          },
          { trigger: "prepare" },
        )
        const admitted = attemptTransition(base, "admitted", "admit")
        const streaming = attemptTransition(admitted, "streaming", "first_event")
        yield* Effect.promise(() => saveRun(teamsDataDir(), streaming))
        auditState.run = streaming.id
        return { output: rootPrepareOutput(streaming) }
      }
    }
    if (run !== undefined && name === "prepare" && run.kind === "main" && isRootPrepareInput(input)) {
      // Idempotent root form: a repeat no-arg prepare from the bound session
      // returns the existing main run instead of creating another. This
      // precedes the role gate so planners (whose ceiling lacks prepare)
      // still bootstrap idempotently; prepare with cwd keeps the full gate.
      return { output: rootPrepareOutput(run) }
    }
    const owned = yield* requireActor(run, input, agent)
    yield* requireRole(owned, name)
    const caller: TeamCaller = { sessionID, agent, run: owned }
    const result = yield* Effect.promise(() => call(input, caller))
    if (!result.ok) {
      const acceptedLine =
        result.error.accepted !== undefined ? `\naccepted: ${JSON.stringify(result.error.accepted)}` : ""
      return yield* Effect.fail(
        new Tool.Error({ message: `${result.error.code}: ${result.error.message}${acceptedLine}` }),
      )
    }
    return { output: result.value }
  })
}

function isRootPrepareInput(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return true
  return (input as Record<string, unknown>).cwd === undefined
}

function rootPrepareOutput(run: RunRecord): Record<string, unknown> {
  return {
    run: run.id,
    session: run.sessionID,
    directory: run.directory,
    role: run.role,
    state: run.state,
    base: run.base,
    head: run.head,
  }
}

function requireActor(
  run: RunRecord | undefined,
  input: unknown,
  agent: string,
): Effect.Effect<RunRecord, Tool.Error> {
  if (run === undefined) return Effect.fail(notActorError(runIdOf(input) ?? "unknown"))
  if (run.role !== agent) return Effect.fail(notActorError(runIdOf(input) ?? run.id))
  return Effect.succeed(run)
}

function requireRole(run: RunRecord, name: TeamTool): Effect.Effect<void, Tool.Error> {
  const kind = kindOf(run.role)
  if (!kind.ok) return Effect.fail(new Tool.Error({ message: `E_ROLE: ${kind.reason}` }))
  const ceiling = toolsByServer(kind.kind)
  const allowed = [...ceiling.direct, ...ceiling.code]
  if (!allowed.includes(name)) return Effect.fail(roleError(run.role, name))
  return Effect.void
}

function notActorError(id: string): Tool.Error {
  return new Tool.Error({
    message: `E_NOT_ACTOR: This session is not the owner of run ${id}. Call team tools from the run's own chat; do not session_move.`,
  })
}

function codeOf(message: string): string | null {
  const idx = message.indexOf(":")
  if (idx <= 0) {
    const trimmed = message.trim()
    if (trimmed.length === 0) return null
    return trimmed
  }
  const code = message.slice(0, idx).trim()
  if (code.length === 0) return null
  return code
}

function roleError(role: string, name: TeamTool): Tool.Error {
  return new Tool.Error({ message: `E_ROLE: Role "${role}" may not call "team_${name}".` })
}

// The E_NOT_ACTOR message names the run the input names when it names one
// (run, first of runs, or parent), so the model sees which id was rejected.
function runIdOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const fields = input as Record<string, unknown>
  if (typeof fields.run === "string") return fields.run
  if (Array.isArray(fields.runs) && typeof fields.runs[0] === "string") return fields.runs[0]
  if (typeof fields.parent === "string") return fields.parent
  return undefined
}
