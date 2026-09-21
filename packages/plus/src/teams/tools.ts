import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema, Scope, Stream } from "effect"
import path from "node:path"
import { runRegistration } from "../instructions/apply.js"
import { teamsDataDir } from "../instructions/paths.js"
import { append, type ToolCallOutcome } from "./audit.js"
import type { TeamApi, TeamApiResult, TeamCaller } from "./api.js"
import { gitRaw } from "./git.js"
import { kindOf, toolsByServer, type TeamTool } from "./policy.js"
import { attemptTransition, bySession, newRunID, saveRun, startAttempt, type RunRecord } from "./run.js"
import {
  Brief,
  CheckInput,
  CheckpointInput,
  DiffInput,
  FollowupInput,
  GetContextInput,
  IntegrateInput,
  ListInput,
  Report,
  SetChecksInput,
  StatusInput,
  StopInput,
  SupersedeInput,
  WaitInput,
} from "./schema.js"

const namespace = "team"
const origin = { type: "plugin", name: "opencode.plus" } as const

const DelegateDescription = "Start a bounded task in a new isolated worktree. One call = one run."
const FinishDescription = "Declare an outcome for the current attempt.\nDone, blocked, or needs-context with evidence the parent verifies."
const FollowupDescription =
  "Send a correction to an owned child.\nThe default queue delivers it as a new attempt when the child next goes idle; delivery:\"now\" needs an already idle child and fails E_BUSY otherwise."
const IntegrateDescription = "Enqueue a child's completed commit into the merge queue.\nLands synchronously when the queue is empty and the parent is clean."
const CheckpointDescription = "Commit only intended files in your own worktree after checking expected HEAD."
const SetChecksDescription = "Record the integration checks for the current task.\nOutput is the check ids."
const SupersedeDescription = "Abandon an owned child and cancel its task.\nWorking children get a shutdown request first, then an interrupt."
const StopDescription = "Stop an owned child.\nWorking children stop after their turn; idle children stop now."
const StatusDescription =
  "Show status of your run and children in this namespace.\nDefaults to self plus direct children. Read-only; never acknowledges, but shows what wait acknowledged as acked."
const WaitDescription =
  "Wait for child runs to settle or go idle.\nReturns settled, acknowledged, timedOut, stillOpen and overBudget lists; acknowledges owned outcomes unless ack:false."
const DiffDescription = "Show a run's worktree diff against a ref or base.\nLarge patches truncate to maxBytes with truncated:true."
const ListDescription = "List runs in this namespace, optionally filtered.\nHidden states (superseded, reaped) need all:true. Read-only."
const GetContextDescription = "Load your brief, checks, siblings, inbox and budget.\nCall first, then execute the Brief."
const CheckDescription = "Run one assigned focused check in your worktree.\nUnknown ids fail with E_UNKNOWN_CHECK."

interface TeamAuditState {
  readonly askedCallIds: Set<string>
  readonly startTimes: Map<string, number>
}

function isPermissionError(error: Tool.Error): boolean {
  const cause = error.error as { _tag?: string } | undefined
  if (cause?._tag === "Permission.BlockedError" || cause?._tag === "Permission.CorrectedError") return true
  if (typeof error.message === "string" && error.message.startsWith("Permission denied")) return true
  return false
}

function handleExecuteAfter(
  event: ToolHooks["execute.after"],
  state: TeamAuditState,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!event.tool.startsWith("team_")) return
    const callId = String(event.id)
    const start = state.startTimes.get(callId)
    const durationMs = start !== undefined ? Date.now() - start : 0
    state.startTimes.delete(callId)

    if (event.status !== "error") {
      state.askedCallIds.delete(callId)
      return
    }

    if (!isPermissionError(event.error)) {
      state.askedCallIds.delete(callId)
      return
    }

    const wasAsked =
      state.askedCallIds.has(callId) ||
      (event.error.error as { _tag?: string } | undefined)?._tag === "Permission.CorrectedError"
    state.askedCallIds.delete(callId)

    const outcome: ToolCallOutcome = wasAsked ? "asked:deny" : "denied"
    const sessionID = String(event.sessionID)
    const agent = String(event.agent)
    const found = yield* Effect.promise(() => bySession(teamsDataDir(), sessionID))
    const run = found?.id ?? null

    yield* Effect.ignore(
      Effect.tryPromise({
        try: () =>
          append(teamsDataDir(), "tool.call", {
            run,
            actor: agent,
            sessionID,
            tool: event.tool,
            ok: false,
            code: "E_PERMISSION",
            durationMs,
            outcome,
          }),
        catch: () => undefined,
      }),
    )
  })
}

async function installHook(ctx: Context, state: TeamAuditState): Promise<Registration> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const afterReg = yield* Effect.suspend(() =>
        ctx.tool.hook("execute.after", (event) => handleExecuteAfter(event, state)),
      ).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.catchCause((cause) =>
          Effect.logWarning("plus team tool execute.after hook registration failed", { cause }).pipe(
            Effect.as({ dispose: Effect.void }),
          ),
        ),
      )
      const beforeReg = yield* Effect.suspend(() =>
        ctx.tool.hook("execute.before", (event) => {
          if (event.tool.startsWith("team_")) {
            state.startTimes.set(String(event.id), Date.now())
          }
          return Effect.void
        }),
      ).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.catchCause((cause) =>
          Effect.logWarning("plus team tool execute.before hook registration failed", { cause }).pipe(
            Effect.as({ dispose: Effect.void }),
          ),
        ),
      )
      return {
        dispose: Effect.all([afterReg.dispose, beforeReg.dispose, Scope.close(scope, Exit.void)], { discard: true }),
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("plus team tool hook install failed", { cause }).pipe(
          Effect.as({ dispose: Effect.void }),
        ),
      ),
    ),
  )
}

async function listenAskedEvents(ctx: Context, state: TeamAuditState): Promise<Registration> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "permission.asked"),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            const data = event.data as { source?: { type?: string; id?: string } } | undefined
            if (data?.source?.type === "tool" && typeof data.source.id === "string") {
              state.askedCallIds.add(data.source.id)
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("plus team event subscription failed", { cause }).pipe(Effect.asVoid),
        ),
        Effect.forkScoped({ startImmediately: true }),
        Effect.provideService(Scope.Scope, scope),
      )
      return {
        dispose: Scope.close(scope, Exit.void),
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("plus team event listener install failed", { cause }).pipe(
          Effect.as({ dispose: Effect.void }),
        ),
      ),
    ),
  )
}

export async function registerTeamTools(ctx: Context, api: TeamApi): Promise<Registration> {
  const state: TeamAuditState = {
    askedCallIds: new Set<string>(),
    startTimes: new Map<string, number>(),
  }

  const toolReg = await runRegistration(ctx.tool.transform, (editor) => {
    editor.namespace({ name: namespace, description: "Team runs: delegate work, report outcomes, and read run state." })
    editor.add({
      name: "delegate",
      description: DelegateDescription,
      input: Brief,
      output: Schema.Unknown,
      options: teamOptions("delegate", false),
      origin,
      execute: (input, context) => runGated("delegate", input, context, ctx, state, (args, caller) => api.delegate(args, caller)),
    })
    editor.add({
      name: "finish",
      description: FinishDescription,
      input: Report,
      output: Schema.Unknown,
      options: teamOptions("finish", false),
      origin,
      execute: (input, context) => runGated("finish", input, context, ctx, state, (args, caller) => api.finish(args, caller)),
    })
    editor.add({
      name: "followup",
      description: FollowupDescription,
      input: FollowupInput,
      output: Schema.Unknown,
      options: teamOptions("followup", false),
      origin,
      execute: (input, context) => runGated("followup", input, context, ctx, state, (args, caller) => api.followup(args, caller)),
    })
    editor.add({
      name: "integrate",
      description: IntegrateDescription,
      input: IntegrateInput,
      output: Schema.Unknown,
      options: teamOptions("integrate", false),
      origin,
      execute: (input, context) => runGated("integrate", input, context, ctx, state, (args, caller) => api.integrate(args, caller)),
    })
    editor.add({
      name: "checkpoint",
      description: CheckpointDescription,
      input: CheckpointInput,
      output: Schema.Unknown,
      options: teamOptions("checkpoint", false),
      origin,
      execute: (input, context) => runGated("checkpoint", input, context, ctx, state, (args, caller) => api.checkpoint(args, caller)),
    })
    editor.add({
      name: "set_checks",
      description: SetChecksDescription,
      input: SetChecksInput,
      output: Schema.Unknown,
      options: teamOptions("set_checks", false),
      origin,
      execute: (input, context) => runGated("set_checks", input, context, ctx, state, (args, caller) => api.set_checks(args, caller)),
    })
    editor.add({
      name: "supersede",
      description: SupersedeDescription,
      input: SupersedeInput,
      output: Schema.Unknown,
      options: teamOptions("supersede", false),
      origin,
      execute: (input, context) => runGated("supersede", input, context, ctx, state, (args, caller) => api.supersede(args, caller)),
    })
    editor.add({
      name: "stop",
      description: StopDescription,
      input: StopInput,
      output: Schema.Unknown,
      options: teamOptions("stop", false),
      origin,
      execute: (input, context) => runGated("stop", input, context, ctx, state, (args, caller) => api.stop(args, caller)),
    })
    editor.add({
      name: "status",
      description: StatusDescription,
      input: StatusInput,
      output: Schema.Unknown,
      options: teamOptions("status", true),
      origin,
      execute: (input, context) => runGated("status", input, context, ctx, state, (args, caller) => api.status(args, caller)),
    })
    editor.add({
      name: "wait",
      description: WaitDescription,
      input: WaitInput,
      output: Schema.Unknown,
      options: teamOptions("wait", true),
      origin,
      execute: (input, context) => runGated("wait", input, context, ctx, state, (args, caller) => api.wait(args, caller)),
    })
    editor.add({
      name: "diff",
      description: DiffDescription,
      input: DiffInput,
      output: Schema.Unknown,
      options: teamOptions("diff", true),
      origin,
      execute: (input, context) => runGated("diff", input, context, ctx, state, (args, caller) => api.diff(args, caller)),
    })
    editor.add({
      name: "list",
      description: ListDescription,
      input: ListInput,
      output: Schema.Unknown,
      options: teamOptions("list", true),
      origin,
      execute: (input, context) => runGated("list", input, context, ctx, state, (args, caller) => api.list(args, caller)),
    })
    editor.add({
      name: "get_context",
      description: GetContextDescription,
      input: GetContextInput,
      output: Schema.Unknown,
      options: teamOptions("get_context", true),
      origin,
      execute: (input, context) => runGated("get_context", input, context, ctx, state, (args, caller) => api.get_context(args, caller)),
    })
    editor.add({
      name: "check",
      description: CheckDescription,
      input: CheckInput,
      output: Schema.Unknown,
      options: teamOptions("check", true),
      origin,
      execute: (input, context) => runGated("check", input, context, ctx, state, (args, caller) => api.check(args, caller)),
    })
  })
  const hookReg = await installHook(ctx, state)
  const eventReg = await listenAskedEvents(ctx, state)
  return {
    dispose: Effect.gen(function* () {
      yield* toolReg.dispose
      yield* hookReg.dispose
      yield* eventReg.dispose
      state.askedCallIds.clear()
      state.startTimes.clear()
    }),
  }
}

function teamOptions(name: TeamTool, codemode: boolean) {
  return { namespace, codemode, permission: `team.${name}` }
}

function runGated<A>(
  name: TeamTool,
  input: A,
  toolCtx: Tool.Context,
  pluginCtx: Context,
  state: TeamAuditState,
  call: (args: A, caller: TeamCaller) => Promise<TeamApiResult>,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const agent = String(toolCtx.agent)
    const sessionID = String(toolCtx.sessionID)
    const callId = String(toolCtx.id)
    const start = state.startTimes.get(callId) ?? Date.now()
    const auditState: { run: string | null } = { run: null }
    const settled = yield* runGatedInner(name, input, toolCtx, pluginCtx, call, auditState).pipe(
      Effect.map((result) => ({ ok: true as const, output: result.output })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, message: error.message })),
    )
    const durationMs = Date.now() - start
    const ok = settled.ok
    const code = settled.ok ? null : codeOf(settled.message)
    const wasAsked = state.askedCallIds.has(callId)
    state.askedCallIds.delete(callId)
    state.startTimes.delete(callId)
    const outcome: ToolCallOutcome = wasAsked ? "asked:allow" : "allowed"
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
            outcome,
          }),
        catch: () => undefined,
      }),
    )
    if (!settled.ok) return yield* Effect.fail(new Tool.Error({ message: settled.message }))
    return { output: settled.output }
  })
}

function runGatedInner<A>(
  name: TeamTool,
  input: A,
  toolCtx: Tool.Context,
  pluginCtx: Context,
  call: (args: A, caller: TeamCaller) => Promise<TeamApiResult>,
  auditState: { run: string | null },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const agent = String(toolCtx.agent)
    const sessionID = String(toolCtx.sessionID)
    const found = yield* Effect.promise(() => bySession(teamsDataDir(), sessionID))
    auditState.run = found?.id ?? null
    let run = found
    if (run === undefined) {
      const kind = kindOf(agent)
      // Root-run bootstrap: a planner or orchestrator session calling any team
      // tool becomes the main run, then continues through the normal gate.
      // All other no-run calls keep the byte-exact E_NOT_ACTOR message.
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
        // A second call finds this run through bySession, so the bootstrap is
        // idempotent without a second branch.
        run = streaming
      }
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
