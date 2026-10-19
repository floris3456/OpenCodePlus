import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { put, take } from "./inbox.js"
import { queue } from "./merge.js"
import { requireSession, requireWorktree } from "./availability.js"
import { consumeStopIntent, withoutHold } from "./lifecycle.js"
import { armColdCompaction, isSessionWarm } from "./cold-compaction.js"
import { coldPlanOf } from "../compaction/cold-now.js"
import type { PlusState } from "../index.js"
import type { PermissionTable } from "../instructions/permission-enforce.js"
import { bound, mayReach, relationOf, row } from "./reach.js"
import {
  attemptTransition,
  isAttemptTerminal,
  isTerminal,
  loadRun,
  occupiesSlot,
  recordInboxDelivery,
  saveRun,
  startAttempt,
  transition,
  updateRun,
  type BudgetHistoryEntry,
  type RunBudget,
  type RunRecord,
} from "./run.js"
import { FollowupInput, toolError } from "./schema.js"
import { atomicJson, lock, readJson, sanitizeLockKey } from "./store.js"
import { io } from "./io.js"
import type { TeamApiResult, TeamCaller } from "./api.js"

function succeeded(value: unknown): TeamApiResult {
  return { ok: true, value }
}

function fail(code: string, message: string, accepted?: unknown): TeamApiResult {
  if (accepted === undefined) return { ok: false, error: { code, message } }
  return { ok: false, error: { code, message, accepted } }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? ""
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`
}

function signatureOf(input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (key !== "requestID") rest[key] = record[key]
  }
  return createHash("sha256").update(stable(rest), "utf8").digest("hex")
}

export async function followupHandler(
  ctx: Context,
  state: PlusState,
  args: FollowupInput,
  caller: TeamCaller,
  table?: PermissionTable,
): Promise<TeamApiResult> {
  // Serialize admissions/replays for this parent; the Session prompt is an
  // admission call, not a wait for model execution.
  return lock(teamsDataDir(), "state", `admission-${caller.run.id}`, () => followupLocked(ctx, state, args, caller, table))
}

async function followupLocked(ctx: Context, state: PlusState, args: FollowupInput, caller: TeamCaller, table?: PermissionTable): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const parent = stored ?? caller.run
  const child = await loadRun(root, args.run)
  // A direct child always; a deeper descendant or any other run only when the
  // member's Runs rows for team_followup allow it.
  const relation = child === undefined ? undefined : await relationOf(root, parent, child)
  if (child === undefined || relation === "self" || relation === undefined || !mayReach(table, caller.agent, "followup", relation))
    return fail(
      "E_NOT_CHILD",
      `Run ${args.run} is not your direct child. Your children: [${parent.children.join(", ")}]. Use status to read others.`,
      parent.children,
    )
  const signature = signatureOf(args)
  const requestPath = path.join(root, "requests", `${sanitizeLockKey(parent.id)}__${sanitizeLockKey(args.requestID)}.json`)
  const replay = await readJson<{ signature?: string; output?: Record<string, unknown> }>(requestPath)
  if (replay?.signature !== undefined) {
    if (replay.signature !== signature)
      return fail("E_REQUEST_ID", `requestID "${args.requestID}" was used with different arguments; reuse only to retry the identical call, else pick a new requestID.`, "pick a new requestID")
    if (replay.output !== undefined) return succeeded({ ...replay.output, replayed: true, receipt: replay.output, current: { run: child.id, state: child.state, attempt: child.attempts.at(-1)?.n ?? 0, worktree: child.worktree } })
  }
  const rounds = bound(table, caller.agent, "followup", "limits.rounds")
  if (rounds !== undefined && child.attempts.length > rounds)
    return fail(
      "E_ROUNDS",
      `Run ${child.id} has had ${child.attempts.length - 1} corrections (limit ${rounds}, Permissions → Limits). Stop it with team_stop and delegate a fresh run.`,
      "team_stop and delegate a fresh run",
    )
  if (isTerminal(child.state))
    return fail(
      "E_TERMINAL",
      `Run ${args.run} is superseded/reaped; delegate a fresh run.`,
      "delegate a fresh run",
    )

  // Whether the child takes corrections is the child's own row (Briefs it
  // accepts → Corrections by followup), read for the child, not the caller.
  const corrections = row(table, child.role, "get_context", "accepts.followup")
  if (corrections === undefined || !corrections.on)
    return fail(
      "E_NO_FOLLOWUP",
      `${child.role} ${corrections?.item.message ?? "takes no corrections by followup: delegate a fresh run with team_delegate and point it at the previous report"} (Briefs it accepts → Corrections by followup).`,
      "delegate a fresh run",
    )
  await requireWorktree(child)
  if (child.parent !== null && (await queue(root, child.parent)).some((entry) => entry.childRun === child.id && entry.state === "landed"))
    return fail("E_ALREADY_LANDED", `Run ${child.id} is already landed; delegate fresh from current parent.`, "delegate fresh from current parent")
  if (args.prompt === undefined && args.budget === undefined)
    return fail("E_NO_CONTENT", "team_followup requires prompt, budget, or both.", "prompt or budget")
  if (args.budget !== undefined) {
    if (args.reason === undefined || args.reason.trim().length === 0)
      return fail("E_BUDGET_REASON", "A budget change requires a reason (1–300 characters).", "provide a reason")
    if (args.reason.length > 300)
      return fail("E_BUDGET_REASON", "Budget reason must be at most 300 characters.", "provide a reason")
  }
  await requireSession(ctx, child)
  if (child.state === "stopped") {
    const warm = child.sessionID ? await isSessionWarm(child.sessionID) : false
    if (!warm) {
      const explicit = args.compactWith?.trim()
      const cold = explicit || child.sessionID === null ? undefined : await coldPlanOf(ctx, state, child.sessionID)
      const models = explicit ? [explicit] : (cold?.models ?? [])
      if (models.length === 0) {
        const model = cold?.model ?? "<provider/model>"
        return fail(
          "E_STOPPED",
          `Run ${child.id} is stopped and its cache is cold. Call team_followup again with compactWith: "${model}" (its chat is compacted with that model before it resumes), or delegate a fresh run.`,
          { compactWith: model },
        )
      }
      if (child.sessionID === null)
        return fail("E_INTERNAL", `Run ${child.id} has no session to compact.`)
      armColdCompaction(child.sessionID, models)
      await Effect.runPromise(ctx.session.compact({ sessionID: Session.ID.make(child.sessionID) }))
    }
  }
  if (!["idle", "working", "starting", "blocked_input", "stopped"].includes(child.state) || (child.stopRequested && child.state !== "stopped"))
    return fail("E_UNRESUMABLE", `Run ${child.id} is ${child.state} or stopping; delegate fresh from current parent.`, "delegate fresh from current parent")
  if (!occupiesSlot(child)) {
    const records = await Promise.all((await readdir(path.join(root, "runs"))).filter((name) => !name.startsWith(".")).map((name) => loadRun(root, name)))
    const live = records.filter((run): run is RunRecord => run !== undefined && occupiesSlot(run))
    const inflight = bound(table, caller.agent, "delegate", "limits.inflight")
    const members = bound(table, caller.agent, "delegate", "limits.members")
    if ((inflight !== undefined && live.filter((run) => run.parent === parent.id).length >= inflight) || (members !== undefined && live.length >= members))
      return fail("E_BOUNDS", "No capacity to resume this child; end your turn and retry after an active run settles.", "retry after a run settles")
  }

  if (args.prompt === undefined) {
    const updated = applyBudget(child, args.budget, args.reason, parent.id)
    await saveRun(root, updated)
    const lastAttempt = updated.attempts.at(-1)?.n ?? 0
    const output = { attempt: lastAttempt, state: updated.state, budget: updated.budget }
    await atomicJson(requestPath, { signature, output, run: child.id })
    return succeeded(output)
  }

  const delivery = args.delivery ?? "queue"
  if (delivery === "now") return followupNow(ctx, root, requestPath, signature, parent, child.id, args.prompt, args.budget, args.reason)
  return followupQueue(ctx, root, requestPath, signature, parent, child.id, args.prompt, args.budget, args.reason)
}

type FollowupBudgetInput = { turns?: number | undefined; tokens?: number | undefined; wallMs?: number | undefined } | undefined

function applyBudget(
  current: RunRecord,
  budget: FollowupBudgetInput,
  reason: string | undefined,
  parentId: string,
): RunRecord {
  if (budget === undefined) return current
  const updatedBudget: RunBudget = {
    ...current.budget,
    ...(budget.turns !== undefined ? { turns: budget.turns } : {}),
    ...(budget.tokens !== undefined ? { tokens: budget.tokens } : {}),
    ...(budget.wallMs !== undefined ? { wallMs: budget.wallMs } : {}),
  }
  const entry: BudgetHistoryEntry = {
    at: new Date().toISOString(),
    by: parentId,
    from: { ...current.budget },
    to: { ...updatedBudget },
    reason: reason ?? "",
  }
  const updated: RunRecord = {
    ...current,
    budget: updatedBudget,
    history: [...current.history, entry],
  }
  delete updated.budgetExceededAt
  delete updated.lastBudgetPingAt
  return updated
}

async function followupQueue(
  ctx: Context,
  root: string,
  requestPath: string,
  signature: string,
  parent: RunRecord,
  childID: string,
  text: string,
  budget: FollowupBudgetInput,
  reason?: string,
): Promise<TeamApiResult> {
  const current = await loadRun(root, childID)
  if (current === undefined)
    return fail(
      "E_NOT_CHILD",
      `Run ${childID} is not your direct child. Your children: [${parent.children.join(", ")}]. Use status to read others.`,
      parent.children,
    )
  if (isTerminal(current.state))
    return fail(
      "E_TERMINAL",
      `Run ${childID} is superseded/reaped; delegate a fresh run.`,
      "delegate a fresh run",
    )
  await requireWorktree(current)
  if (current.state !== "idle" && current.state !== "stopped") {
    const budgeted = applyBudget(current, budget, reason, parent.id)
    await saveRun(root, budgeted)
    if (budgeted.sessionID === null)
      throw toolError("E_INTERNAL", `Run ${budgeted.id} has no session to prompt.`, budgeted.id)
    const queued = await put(root, childID, { kind: "followup", from: parent.id, text })
    await Effect.runPromise(
      ctx.session.prompt({ sessionID: Session.ID.make(budgeted.sessionID), text, delivery: "steer" }),
    )
    await updateRun(root, childID, (fresh) => recordInboxDelivery(fresh, [queued.id]))
    await take(root, childID, [queued.id])
    const last = budgeted.attempts.at(-1)
    const output = { attempt: last?.n ?? 1, state: "queued" }
    await atomicJson(requestPath, { signature, output, run: childID })
    return succeeded(output)
  }
  // An idle child is prompted now, so the item it was prompted with is
  // recorded as delivered and the idle drain will not repeat it.
  const queued = await put(root, childID, { kind: "followup", from: parent.id, text })
  const admitted = await admitIdleChild(ctx, root, current, text, budget, reason, parent.id, queued.id)
  const done = admitted.attempts[admitted.attempts.length - 1]
  const output = { attempt: done?.n ?? 1, state: "admitted" }
  await atomicJson(requestPath, { signature, output, run: childID })
  return succeeded(output)
}

async function followupNow(
  ctx: Context,
  root: string,
  requestPath: string,
  signature: string,
  parent: RunRecord,
  childID: string,
  text: string,
  budget: FollowupBudgetInput,
  reason?: string,
): Promise<TeamApiResult> {
  const current = await loadRun(root, childID)
  if (current === undefined)
    return fail(
      "E_NOT_CHILD",
      `Run ${childID} is not your direct child. Your children: [${parent.children.join(", ")}]. Use status to read others.`,
      parent.children,
    )
  if (isTerminal(current.state))
    return fail(
      "E_TERMINAL",
      `Run ${childID} is superseded/reaped; delegate a fresh run.`,
      "delegate a fresh run",
    )
  const last = current.attempts[current.attempts.length - 1]
  await requireWorktree(current)
  if (current.state !== "idle" && current.state !== "stopped")
    return fail(
      "E_BUSY",
      `Child is working (attempt ${last?.n ?? 1}). Use delivery:"queue" (default); it is delivered when the child goes idle.`,
      { delivery: "queue" },
    )
  const admitted = await admitIdleChild(ctx, root, current, text, budget, reason, parent.id)
  const done = admitted.attempts[admitted.attempts.length - 1]
  const output = { attempt: done?.n ?? 1, state: "admitted" }
  await atomicJson(requestPath, { signature, output, run: childID })
  return succeeded(output)
}

async function admitIdleChild(
  ctx: Context,
  root: string,
  current: RunRecord,
  text: string,
  budget: FollowupBudgetInput,
  reason: string | undefined,
  parentId: string,
  itemID?: string,
): Promise<RunRecord> {
  const resumed = withoutHold(current.state === "stopped" ? transition(consumeStopIntent(current), "starting", "followup") : current)
  const open = resumed.attempts.at(-1)
  const started = open === undefined || isAttemptTerminal(open.state) ? startAttempt(resumed, { trigger: "followup", prompt: text }) : resumed
  const queued = started.attempts[started.attempts.length - 1]
  const admitted = queued !== undefined && queued.state === "queued" ? attemptTransition(started, "admitted", "admit") : started
  const delivered = itemID === undefined ? admitted : recordInboxDelivery(admitted, [itemID])
  const budgeted = applyBudget(delivered, budget, reason, parentId)
  const working = budgeted.state === "idle" || budgeted.state === "starting" ? transition(budgeted, "working", "prompt") : budgeted
  if (working.sessionID === null) throw toolError("E_INTERNAL", `Run ${working.id} has no session to prompt.`, working.id)
  const previous = current
  await saveRun(root, working)
  await Effect.runPromise(
    ctx.session.prompt({ sessionID: Session.ID.make(working.sessionID), text }).pipe(
      Effect.onError(() => Effect.ignore(io(() => saveRun(root, previous)))),
    ),
  )
  return working
}
