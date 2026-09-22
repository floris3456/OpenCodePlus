import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Permission } from "@opencode/schema/permission"
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
  nullTolerant,
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

// One team tool call in flight, remembered at `tool.execute.before` so a refusal
// seen on the event stream can be audited with the same actor, session and
// duration the call itself would have reported. Under Code Mode one `execute`
// runs many inner calls against the SAME Tool.Context — one CallID, one
// messageID — so state is queued per (session, message, CallID) and every
// invocation claims its own entry: two calls that share a CallID can neither
// overwrite nor consume each other's state.
interface TeamCall {
  readonly tool: string
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string
  readonly start: number
  /** A permission request named this call. */
  asked: boolean
  /** The tool body took this entry. */
  claimed: boolean
  /** A permission request already owns this entry. */
  bound: boolean
}

interface AskedCall {
  readonly key: string
  readonly call: TeamCall
}

interface TeamAuditState {
  readonly calls: Map<string, TeamCall[]>
  readonly askedRequests: Map<string, AskedCall>
}

const PermissionEvents: Set<string> = new Set([Permission.Event.Asked.type, Permission.Event.Replied.type])

function callKey(sessionID: string, messageID: string, callID: string): string {
  return `${sessionID}\u0000${messageID}\u0000${callID}`
}

function queueCall(state: TeamAuditState, key: string, call: TeamCall): void {
  state.calls.set(key, [...(state.calls.get(key) ?? []), call])
}

function dropCall(state: TeamAuditState, key: string, call: TeamCall): void {
  const left = (state.calls.get(key) ?? []).filter((entry) => entry !== call)
  if (left.length === 0) state.calls.delete(key)
  else state.calls.set(key, left)
}

// The first queued entry of this tool that no body has taken yet. Two
// concurrent invocations of one tool that share a CallID get distinct entries.
function claimCall(state: TeamAuditState, key: string, tool: string): TeamCall | undefined {
  const call = (state.calls.get(key) ?? []).find((entry) => entry.tool === tool && !entry.claimed)
  if (call !== undefined) call.claimed = true
  return call
}

// A refusal seen on the after hook never ran the body, so it owns an unclaimed
// entry; removing it here is what keeps a later sibling's cleanup from taking it.
function takeCall(state: TeamAuditState, key: string, tool: string): TeamCall | undefined {
  const call = (state.calls.get(key) ?? []).find((entry) => entry.tool === tool && !entry.claimed)
  if (call !== undefined) dropCall(state, key, call)
  return call
}

// Team tool permissions are `team.<name>` (teamOptions below); the tool id is
// `team_<name>`.
function toolOfAction(action: unknown): string | undefined {
  if (typeof action !== "string" || !action.startsWith(`${namespace}.`)) return undefined
  return `team_${action.slice(namespace.length + 1)}`
}

function bindAsked(
  state: TeamAuditState,
  request: { id: string; sessionID: string; action?: string; source: { id: string; messageID: string } },
): void {
  const key = callKey(request.sessionID, request.source.messageID, request.source.id)
  const entries = state.calls.get(key) ?? []
  const tool = toolOfAction(request.action)
  const call =
    entries.find((entry) => !entry.bound && (tool === undefined || entry.tool === tool)) ??
    entries.find((entry) => !entry.bound)
  if (call === undefined) return
  call.bound = true
  call.asked = true
  state.askedRequests.set(request.id, { key, call })
}

function appendToolCall(line: {
  run: string | null
  actor: string
  sessionID: string
  tool: string
  ok: boolean
  code: string | null
  durationMs: number
  outcome: ToolCallOutcome
}): Effect.Effect<void> {
  return Effect.ignore(
    Effect.tryPromise({
      try: () => append(teamsDataDir(), "tool.call", line),
      catch: () => undefined,
    }),
  )
}

function isPermissionError(error: Tool.Error): boolean {
  const cause = error.error as { _tag?: string } | undefined
  if (cause?._tag === "Permission.BlockedError" || cause?._tag === "Permission.CorrectedError") return true
  if (typeof error.message === "string" && error.message.startsWith("Permission denied")) return true
  return false
}

// Exactly one `tool.call` line per refused call, split by which refusals can
// reach which observer. A human rejection always publishes `permission.replied`
// and is written there; a rule denial never creates a request, so no reply will
// ever arrive for it and this hook owns it. The only refusal that reaches both
// is a rejection WITH feedback, which core types as `Permission.CorrectedError`
// — recognising that cause here is what keeps the line from being written twice.
function handleExecuteAfter(
  event: ToolHooks["execute.after"],
  state: TeamAuditState,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!event.tool.startsWith("team_")) return
    if (event.status !== "error") return
    const key = callKey(String(event.sessionID), String(event.messageID), String(event.id))
    // Leave the call state alone for a rejection with feedback: the replied
    // observer owns that line and still needs it, and the two observers reach
    // this call in no guaranteed order.
    if ((event.error.error as { _tag?: string } | undefined)?._tag === "Permission.CorrectedError") return
    // Only a call whose body never ran still has an entry here; a body that ran
    // wrote its own line in runGated and dropped the entry, so a sibling sharing
    // the CallID is never mistaken for this one.
    const call = takeCall(state, key, event.tool)
    if (!isPermissionError(event.error)) return

    const sessionID = String(event.sessionID)
    const found = yield* Effect.promise(() => bySession(teamsDataDir(), sessionID))

    yield* appendToolCall({
      run: found?.id ?? null,
      actor: String(event.agent),
      sessionID,
      tool: event.tool,
      ok: false,
      code: "E_PERMISSION",
      durationMs: call === undefined ? 0 : Date.now() - call.start,
      outcome: "denied",
    })
  })
}

function rememberAsked(data: unknown, state: TeamAuditState): void {
  const request = data as
    | { id?: unknown; sessionID?: unknown; action?: unknown; source?: { type?: unknown; id?: unknown; messageID?: unknown } }
    | undefined
  if (request?.source?.type !== "tool") return
  if (typeof request.id !== "string" || typeof request.sessionID !== "string") return
  if (typeof request.source.id !== "string" || typeof request.source.messageID !== "string") return
  bindAsked(state, {
    id: request.id,
    sessionID: request.sessionID,
    ...(typeof request.action === "string" ? { action: request.action } : {}),
    source: { id: request.source.id, messageID: request.source.messageID },
  })
}

// The only trace a rejection WITHOUT feedback leaves: core answers it with
// `DeclinedError`, deliberately a defect, so the call never becomes a typed
// `Tool.Error` and no `tool.execute.after` fires for it. The reply event is
// published for every answered request, including the ones core cascades onto
// the session's other pending requests, and one request is mapped once, so the
// rejected call is audited exactly once whether or not it carried feedback.
function handleReplied(data: unknown, state: TeamAuditState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const replied = data as { requestID?: string; reply?: string } | undefined
    if (typeof replied?.requestID !== "string") return
    const asked = state.askedRequests.get(replied.requestID)
    if (asked === undefined) return
    state.askedRequests.delete(replied.requestID)
    if (replied.reply !== "reject") return
    dropCall(state, asked.key, asked.call)

    const found = yield* Effect.promise(() => bySession(teamsDataDir(), asked.call.sessionID))

    yield* appendToolCall({
      run: found?.id ?? null,
      actor: asked.call.agent,
      sessionID: asked.call.sessionID,
      tool: asked.call.tool,
      ok: false,
      code: "E_PERMISSION",
      durationMs: Date.now() - asked.call.start,
      outcome: "asked:deny",
    })
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
            const sessionID = String(event.sessionID)
            const messageID = String(event.messageID)
            queueCall(state, callKey(sessionID, messageID, String(event.id)), {
              tool: event.tool,
              sessionID,
              messageID,
              agent: String(event.agent),
              start: Date.now(),
              asked: false,
              claimed: false,
              bound: false,
            })
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

// Both permission events share one subscription so they stay ordered: the
// request is always remembered before the reply that resolves it arrives.
async function listenPermissionEvents(ctx: Context, state: TeamAuditState): Promise<Registration> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => PermissionEvents.has(event.type)),
        Stream.runForEach((event) =>
          event.type === Permission.Event.Asked.type
            ? Effect.sync(() => rememberAsked(event.data, state))
            : handleReplied(event.data, state),
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
    calls: new Map<string, TeamCall[]>(),
    askedRequests: new Map<string, AskedCall>(),
  }

  const toolReg = await runRegistration(ctx.tool.transform, (editor) => {
    editor.namespace({ name: namespace, description: "Team runs: delegate work, report outcomes, and read run state." })
    const add = (tool: Tool.Info) => {
      editor.add({
        ...tool,
        input: nullTolerant(tool.input as any),
      })
    }
    add({
      name: "delegate",
      description: DelegateDescription,
      input: Brief,
      output: Schema.Unknown,
      options: teamOptions("delegate", false),
      origin,
      execute: (input, context) => runGated("delegate", input, context, ctx, state, (args, caller) => api.delegate(args, caller)),
    })
    add({
      name: "finish",
      description: FinishDescription,
      input: Report,
      output: Schema.Unknown,
      options: teamOptions("finish", false),
      origin,
      execute: (input, context) => runGated("finish", input, context, ctx, state, (args, caller) => api.finish(args, caller)),
    })
    add({
      name: "followup",
      description: FollowupDescription,
      input: FollowupInput,
      output: Schema.Unknown,
      options: teamOptions("followup", false),
      origin,
      execute: (input, context) => runGated("followup", input, context, ctx, state, (args, caller) => api.followup(args, caller)),
    })
    add({
      name: "integrate",
      description: IntegrateDescription,
      input: IntegrateInput,
      output: Schema.Unknown,
      options: teamOptions("integrate", false),
      origin,
      execute: (input, context) => runGated("integrate", input, context, ctx, state, (args, caller) => api.integrate(args, caller)),
    })
    add({
      name: "checkpoint",
      description: CheckpointDescription,
      input: CheckpointInput,
      output: Schema.Unknown,
      options: teamOptions("checkpoint", false),
      origin,
      execute: (input, context) => runGated("checkpoint", input, context, ctx, state, (args, caller) => api.checkpoint(args, caller)),
    })
    add({
      name: "set_checks",
      description: SetChecksDescription,
      input: SetChecksInput,
      output: Schema.Unknown,
      options: teamOptions("set_checks", false),
      origin,
      execute: (input, context) => runGated("set_checks", input, context, ctx, state, (args, caller) => api.set_checks(args, caller)),
    })
    add({
      name: "supersede",
      description: SupersedeDescription,
      input: SupersedeInput,
      output: Schema.Unknown,
      options: teamOptions("supersede", false),
      origin,
      execute: (input, context) => runGated("supersede", input, context, ctx, state, (args, caller) => api.supersede(args, caller)),
    })
    add({
      name: "stop",
      description: StopDescription,
      input: StopInput,
      output: Schema.Unknown,
      options: teamOptions("stop", false),
      origin,
      execute: (input, context) => runGated("stop", input, context, ctx, state, (args, caller) => api.stop(args, caller)),
    })
    add({
      name: "status",
      description: StatusDescription,
      input: StatusInput,
      output: Schema.Unknown,
      options: teamOptions("status", true),
      origin,
      execute: (input, context) => runGated("status", input, context, ctx, state, (args, caller) => api.status(args, caller)),
    })
    add({
      name: "wait",
      description: WaitDescription,
      input: WaitInput,
      output: Schema.Unknown,
      options: teamOptions("wait", true),
      origin,
      execute: (input, context) => runGated("wait", input, context, ctx, state, (args, caller) => api.wait(args, caller)),
    })
    add({
      name: "diff",
      description: DiffDescription,
      input: DiffInput,
      output: Schema.Unknown,
      options: teamOptions("diff", true),
      origin,
      execute: (input, context) => runGated("diff", input, context, ctx, state, (args, caller) => api.diff(args, caller)),
    })
    add({
      name: "list",
      description: ListDescription,
      input: ListInput,
      output: Schema.Unknown,
      options: teamOptions("list", true),
      origin,
      execute: (input, context) => runGated("list", input, context, ctx, state, (args, caller) => api.list(args, caller)),
    })
    add({
      name: "get_context",
      description: GetContextDescription,
      input: GetContextInput,
      output: Schema.Unknown,
      options: teamOptions("get_context", true),
      origin,
      execute: (input, context) => runGated("get_context", input, context, ctx, state, (args, caller) => api.get_context(args, caller)),
    })
    add({
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
  const eventReg = await listenPermissionEvents(ctx, state)
  return {
    dispose: Effect.gen(function* () {
      yield* toolReg.dispose
      yield* hookReg.dispose
      yield* eventReg.dispose
      state.calls.clear()
      state.askedRequests.clear()
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
    const messageID = String(toolCtx.messageID)
    const key = callKey(sessionID, messageID, String(toolCtx.id))
    // Claim this invocation's own before-hook state. Under Code Mode every inner
    // call shares one CallID, so the queue entry is the only per-invocation
    // identity available; a call with no entry keeps a local one.
    const mine: TeamCall = claimCall(state, key, `team_${name}`) ?? {
      tool: `team_${name}`,
      sessionID,
      messageID,
      agent,
      start: Date.now(),
      asked: false,
      claimed: true,
      bound: false,
    }
    const auditState: { run: string | null } = { run: null }
    const settled = yield* runGatedInner(name, input, toolCtx, pluginCtx, call, auditState).pipe(
      Effect.map((result) => ({ ok: true as const, output: result.output })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, message: error.message })),
    )
    const durationMs = Date.now() - mine.start
    const ok = settled.ok
    const code = settled.ok ? null : codeOf(settled.message)
    dropCall(state, key, mine)
    const outcome: ToolCallOutcome = mine.asked ? "asked:allow" : "allowed"
    yield* appendToolCall({
      run: auditState.run,
      actor: agent,
      sessionID,
      tool: `team_${name}`,
      ok,
      code,
      durationMs,
      outcome,
    })
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
        const directory = pluginCtx.location?.directory ? String(pluginCtx.location.directory) : ""
        if (!directory)
          return yield* Effect.fail(
            new Tool.Error({
              message:
                "E_NOT_ACTOR: This session has no repository directory; open the chat in a git repository to use team tools.",
            }),
          )
        const top = yield* Effect.promise(() => gitRaw(directory, ["rev-parse", "--show-toplevel"]))
        if (top.code !== 0)
          return yield* Effect.fail(
            new Tool.Error({
              message:
                "E_NOT_ACTOR: This session has no repository directory; open the chat in a git repository to use team tools.",
            }),
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
            projectDirectory: directory,
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
