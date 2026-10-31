import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Permission } from "@opencode/schema/permission"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Option, Schema, Scope, Stream } from "effect"
import path from "node:path"
import { runRegistration } from "../instructions/apply.js"
import { teamsDataDir } from "../instructions/paths.js"
import { append, type ToolCallOutcome } from "./audit.js"
import type { TeamApi, TeamApiResult, TeamCaller } from "./api.js"
import { gitRaw } from "./git.js"
import { rowState, unattendedMessage, type PermissionTable } from "../instructions/permission-enforce.js"
import type { TeamTool } from "./policy.js"
import { delegationTargets } from "./reach.js"
import { attemptTransition, bySession, newRunID, saveRun, startAttempt, updateRun, type RunRecord } from "./run.js"
import { lock } from "./store.js"
import { NO_REPOSITORY_PROGRAMS } from "./worktree.js"
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
  StatusInput,
  StopInput,
  nullTolerant,
} from "./schema.js"

const namespace = "team"
const origin = { type: "plugin", name: "opencode.plus" } as const

// Descriptions say what a tool does and when to use it; how each value must
// look is the input schema's field descriptions. A direct tool's description
// is sent with every request, and a Code Mode catalog shows only the first
// line, so each first line stands on its own and stays short.
const DelegateDescription =
  "Start a run for a team member in its own worktree, from your last commit.\nEach call starts one run; to start several, make their calls together in one step. Its settlement wakes you with the report, so end your turn instead of polling."
const FinishDescription =
  "In a delegated run: report your task's outcome to your parent; it ends your turn. Once per attempt; corrections arrive as new messages. The summary's line limit is your member's, and a longer one is refused. In the user's chat, answer the user instead."
const FollowupDescription =
  "Send a correction, more scope, work or budget to your child. Budget alone (with reason) needs no corrections row and prompts nothing. A child whose work has landed gets a new worktree at your HEAD and keeps its context."
const IntegrateDescription =
  "Land a done child's commits on your branch: rebased onto your HEAD, verified (its checks, landed children's and your Brief's; only its own failures or new breakages block), then fast-forwarded."
const CheckpointDescription = "Commit chosen files in your own worktree."
const StopDescription =
  "Stop a child run you no longer need: now, or after its turn while it works (force ends it now)."
const StatusDescription =
  "State, latest report, checks and HEAD of your children or your own run; each child's budget includes contextTokens, its latest step's context size. A settlement already carries its run's report, so this is for a run you have not heard from. Not for waiting: settlements wake you."
const DiffDescription = "Git diff of your run or a child's, against its base, its parent or a commit."
const ListDescription = "List the team runs of this repository still in play. Not for waiting: settlements wake you."
const GetContextDescription = "After a compaction: your Brief again, with your scope, checks, HEAD and budget. Not needed at the start: your Brief is your first message."
const CheckDescription =
  "Run one of your assigned checks in your worktree, or any project check (path when it needs one). Only assigned checks judge your finish."

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
  /** The permission table of the latest publish: whether a chat may start a team run is its row. */
  readonly permissions: () => PermissionTable | undefined
  readonly team?: (agent: string) => string | undefined
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
    // A refusal of any other tool is audited only inside a delegated run: a
    // chat's refusals stay out of the team audit, and a run's are not watched.
    if (!event.tool.startsWith("team_") && found?.kind !== "w") return

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

// The safety net behind the evaluate hook, which already refuses a delegated
// run's ask before it is published. Only an ask that reaches the stream anyway
// gets here, and it is answered at once because nobody watches the run.
function rejectUnattended(ctx: Context, data: unknown): Effect.Effect<void> {
  return Effect.gen(function* () {
    const request = Option.getOrUndefined(Schema.decodeUnknownOption(Permission.Request)(data))
    if (request === undefined) return
    const run = yield* Effect.promise(() => bySession(teamsDataDir(), String(request.sessionID)))
    if (run?.kind !== "w") return
    yield* ctx.permission
      .reply({
        sessionID: request.sessionID,
        requestID: request.id,
        decision: "reject",
        message: unattendedMessage(request.action, request.resources),
      })
      .pipe(Effect.catchCause((cause) => Effect.logWarning("plus team delegated ask rejection failed", { cause })))
  })
}

// Both permission events share one subscription so they stay ordered: the
// request is always remembered before the reply that resolves it arrives. The
// rejection reply therefore follows the remembering, and its Replied event is
// audited against the call that asked.
async function listenPermissionEvents(ctx: Context, state: TeamAuditState): Promise<Registration> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => PermissionEvents.has(event.type)),
        Stream.runForEach((event) =>
          event.type === Permission.Event.Asked.type
            ? Effect.andThen(
                Effect.sync(() => rememberAsked(event.data, state)),
                rejectUnattended(ctx, event.data),
              )
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

export async function registerTeamTools(
  ctx: Context,
  api: TeamApi,
  permissions: () => PermissionTable | undefined = () => undefined,
  team?: (agent: string) => string | undefined,
): Promise<Registration> {
  const state: TeamAuditState = {
    calls: new Map<string, TeamCall[]>(),
    askedRequests: new Map<string, AskedCall>(),
    permissions,
    ...(team === undefined ? {} : { team }),
  }

  const toolReg = await runRegistration(ctx.tool.transform, (editor) => {
    editor.namespace({ name: namespace, description: "Team runs: read run state and run checks." })
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
      options: teamOptions("delegate"),
      origin,
      execute: (input, context) => runGated("delegate", input, context, ctx, state, (args, caller) => api.delegate(args, caller)),
    })
    add({
      name: "finish",
      description: FinishDescription,
      input: Report,
      output: Schema.Unknown,
      options: teamOptions("finish"),
      origin,
      execute: (input, context) => runGated("finish", input, context, ctx, state, (args, caller) => api.finish(args, caller)),
    })
    add({
      name: "followup",
      description: FollowupDescription,
      input: FollowupInput,
      output: Schema.Unknown,
      options: teamOptions("followup"),
      origin,
      execute: (input, context) => runGated("followup", input, context, ctx, state, (args, caller) => api.followup(args, caller)),
    })
    add({
      name: "integrate",
      description: IntegrateDescription,
      input: IntegrateInput,
      output: Schema.Unknown,
      options: teamOptions("integrate"),
      origin,
      execute: (input, context) => runGated("integrate", input, context, ctx, state, (args, caller) => api.integrate(args, caller)),
    })
    add({
      name: "checkpoint",
      description: CheckpointDescription,
      input: CheckpointInput,
      output: Schema.Unknown,
      options: teamOptions("checkpoint"),
      origin,
      execute: (input, context) => runGated("checkpoint", input, context, ctx, state, (args, caller) => api.checkpoint(args, caller)),
    })
    add({
      name: "stop",
      description: StopDescription,
      input: StopInput,
      output: Schema.Unknown,
      options: teamOptions("stop"),
      origin,
      execute: (input, context) => runGated("stop", input, context, ctx, state, (args, caller) => api.stop(args, caller)),
    })
    add({
      name: "status",
      description: StatusDescription,
      input: StatusInput,
      output: Schema.Unknown,
      options: teamOptions("status"),
      origin,
      execute: (input, context) => runGated("status", input, context, ctx, state, (args, caller) => api.status(args, caller)),
    })
    add({
      name: "diff",
      description: DiffDescription,
      input: DiffInput,
      output: Schema.Unknown,
      options: teamOptions("diff"),
      origin,
      execute: (input, context) => runGated("diff", input, context, ctx, state, (args, caller) => api.diff(args, caller)),
    })
    add({
      name: "list",
      description: ListDescription,
      input: ListInput,
      output: Schema.Unknown,
      options: teamOptions("list"),
      origin,
      execute: (input, context) => runGated("list", input, context, ctx, state, (args, caller) => api.list(args, caller)),
    })
    add({
      name: "get_context",
      description: GetContextDescription,
      input: GetContextInput,
      output: Schema.Unknown,
      options: teamOptions("get_context"),
      origin,
      execute: (input, context) => runGated("get_context", input, context, ctx, state, async (args, caller) => {
        const result = await api.get_context(args, caller)
        if (!result.ok) return result
        const table = permissions()
        const targets = delegationTargets(table, caller.agent).filter((target) => table?.teamMembers.has(target))
        return { ok: true, value: { ...(result.value as object), ...(targets.length === 0 ? {} : { delegationTargets: targets }) } }
      }),
    })
    add({
      name: "check",
      description: CheckDescription,
      input: CheckInput,
      output: Schema.Unknown,
      options: teamOptions("check"),
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

// Direct, every one (policy.ts says why); the namespace names their group.
function teamOptions(name: TeamTool) {
  return { namespace, codemode: false, permission: `team.${name}` }
}

function runGated<A>(
  name: TeamTool,
  input: A,
  toolCtx: Tool.Context,
  pluginCtx: Context,
  state: TeamAuditState,
  call: (args: A, caller: TeamCaller) => Promise<TeamApiResult>,
): Effect.Effect<Tool.Result, Tool.Error> {
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
    const settled = yield* runGatedInner(name, input, toolCtx, pluginCtx, call, auditState, state.permissions(), state.team?.(agent)).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
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
    return settled.result
  })
}

function runGatedInner<A>(
  name: TeamTool,
  input: A,
  toolCtx: Tool.Context,
  pluginCtx: Context,
  call: (args: A, caller: TeamCaller) => Promise<TeamApiResult>,
  auditState: { run: string | null },
  table: PermissionTable | undefined,
  team?: string,
): Effect.Effect<Tool.Result, Tool.Error> {
  return Effect.gen(function* () {
    const agent = String(toolCtx.agent)
    const sessionID = String(toolCtx.sessionID)
    const found = yield* Effect.promise(() => bySession(teamsDataDir(), sessionID))
    auditState.run = found?.id ?? null
    let run = found
    if (run === undefined) {
      // Root-run bootstrap: a chat of a member whose "Start a team run from a
      // chat" row is on becomes that member's main run on its first team
      // tool call, then continues through the normal gate. Every other no-run
      // call says why it cannot act: a member whose row is off hears the row's
      // own words, an agent of no enabled team (team tools can be on for any
      // agent) that it is none.
      const member = table?.teamMembers.has(agent) === true
      if (!member) return yield* Effect.fail(new Tool.Error({ message: noRunError(name, input, notMemberWords(agent, table)) }))
      const start = rowState(table, agent, "team_get_context", "bootstrap.chat")
      if (start?.on !== true) {
        const words = start?.item.message ?? "you do not start a team run from a chat"
        return yield* Effect.fail(
          new Tool.Error({
            message: noRunError(name, input, `${words.charAt(0).toUpperCase()}${words.slice(1)} (team_get_context → Team runs → Start a team run from a chat).`),
          }),
        )
      }
      if (start?.on === true) {
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
        // `--verify --quiet` exits 1 without a message when HEAD is unborn (a
        // fresh `git init` with no commit); `rev-parse HEAD` prints a raw git
        // error. A repository with no commit has no base for a run, so it is a
        // classified refusal telling the caller to make a first commit, not an
        // internal failure.
        const headOut = yield* Effect.promise(() => gitRaw(directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--verify", "--quiet", "HEAD"]))
        if (headOut.code !== 0) {
          const commits = yield* Effect.promise(() => gitRaw(directory, [...NO_REPOSITORY_PROGRAMS, "rev-list", "--all", "--count"]))
          if (commits.code === 0 && commits.out === "0")
            return yield* Effect.fail(
              new Tool.Error({
                message: `E_NO_COMMIT_REPO: This repository has no commits yet, so a team run has no base to start from. Make a first commit (git add . && git commit -m "feat: initial commit") and call again.`,
              }),
            )
          return yield* Effect.fail(
            new Tool.Error({ message: `E_INTERNAL: Cannot read HEAD from ${directory}: ${headOut.err || headOut.out || "unknown error"}` }),
          )
        }
        const branchOut = yield* Effect.promise(() => gitRaw(directory, ["rev-parse", "--abbrev-ref", "HEAD"]))
        const branch = branchOut.code === 0 && branchOut.out.length > 0 ? branchOut.out : "HEAD"
        const now = new Date().toISOString()
        const repoKey = path.basename(top.out) || top.out
        const root = teamsDataDir()
        // Team calls of one step run side by side (team_list and team_status
        // as a chat's first calls): each missed bySession above. Under the
        // lock a later call finds the first one's run, instead of making a
        // second main run whose attempt nothing ever settles.
        const bootstrapped = yield* Effect.promise(() =>
          lock(root, "state", `bootstrap-${sessionID}`, async () => {
            const existing = await bySession(root, sessionID)
            if (existing !== undefined) return existing
            const base = startAttempt(
              {
                id: newRunID("main"),
                role: agent,
                ...(team === undefined ? {} : { team }),
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
            const streaming = attemptTransition(attemptTransition(base, "admitted", "admit"), "streaming", "first_event")
            await saveRun(root, streaming)
            return streaming
          }),
        )
        auditState.run = bootstrapped.id
        run = bootstrapped
      }
    }
    const owned = yield* requireActor(run, input, agent)
    // A root run with an open child stays in the folder it was tied to; its
    // chat moved elsewhere. The call refuses with the run's folder named, so
    // the model learns why landing happens where it does instead of being told
    // never to move the chat.
    if (owned.parent === null && owned.movedTo !== undefined && owned.movedTo !== owned.directory) {
      const movedTo = owned.movedTo
      yield* Effect.promise(() => clearMovedTo(teamsDataDir(), owned.id))
      return yield* Effect.fail(new Tool.Error({ message: movedRunError(owned.id, owned.directory, movedTo) }))
    }
    const caller: TeamCaller = { sessionID, agent, run: owned, messageID: String(toolCtx.messageID) }
    const result = yield* Effect.promise(() => call(input, caller))
    if (!result.ok) {
      const acceptedLine =
        result.error.accepted !== undefined ? `\naccepted: ${JSON.stringify(result.error.accepted)}` : ""
      return yield* Effect.fail(
        new Tool.Error({ message: `${result.error.code}: ${result.error.message}${acceptedLine}` }),
      )
    }
    // team_status and team_list are looks: they never end the caller's turn
    // (owner, 2026-10-28: whether to wait is the agent's own decision).
    if (name === "finish" && owned.parent != null) return { output: result.value, endTurn: true }
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

// A call from a chat that is no team run: what the tool needs (a team run)
// and why this caller has none. A call that names a run says it is not that
// run's owner.
function noRunError(name: TeamTool, input: unknown, why: string): string {
  const id = runIdOf(input)
  const head = id === undefined
    ? `E_NOT_ACTOR: team_${name} acts on a team run, and this chat is not one.`
    : `${notActorError(id).message}`
  return `${head} ${why}`
}

function notMemberWords(agent: string, table: PermissionTable | undefined): string {
  if (table === undefined) return `Plus has not loaded its Instructions yet, so it cannot tell whether ${agent} is a team member; call again once the chat has started.`
  return `${agent} is not a member of an enabled team, so it cannot start one: a team run starts in the chat of a member of an enabled team (its team_get_context → Team runs → Start a team run from a chat row on), or through that member's team_delegate.`
}

function notActorError(id: string): Tool.Error {
  return new Tool.Error({
    message: `E_NOT_ACTOR: This session is not the owner of run ${id}. Call team tools from the run's own chat.`,
  })
}

// A root run whose chat moved while it has an open child stays in its folder.
// The call refuses with the run's own folder named; the record's `movedTo` is
// cleared so the notice is said once, not on every later call.
function movedRunError(id: string, directory: string, movedTo: string): string {
  return `E_NOT_ACTOR: This chat moved to ${movedTo}, but run ${id} stays in ${directory}: it has an open child, and a child's worktree and landing belong to that checkout. Finish or stop the child and move the chat back to ${directory}, or start a fresh run in ${movedTo}.`
}

async function clearMovedTo(root: string, id: string): Promise<void> {
  await updateRun(root, id, (record) => {
    if (record.movedTo === undefined) return record
    const next: RunRecord = { ...record }
    delete next.movedTo
    return next
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
