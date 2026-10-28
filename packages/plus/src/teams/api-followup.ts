import { createHash } from "node:crypto"
import { readdir, realpath } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/schema/schema"
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
import { FollowupInput, PATH_LIST_LIMIT, pathList, toolError, type ResolvedBrief } from "./schema.js"
import { atomicJson, lock, readJson, sanitizeLockKey } from "./store.js"
import { io } from "./io.js"
import { git, gitRaw, parsePorcelain } from "./git.js"
import { NO_REPOSITORY_PROGRAMS, provision, slug } from "./worktree.js"
import { scopeEntry } from "./scope.js"
import { scopePathsRefusal, type TeamApiResult, type TeamCaller } from "./api.js"

// Every working child wakes the parent, not only this one: a parent that read
// "its settlement wakes you" as its only wake-up started a no-op run to wait on.
const WAIT = "End your turn now: its settlement wakes you, and so does every other run still working."

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
  input: FollowupInput,
  caller: TeamCaller,
  table?: PermissionTable,
): Promise<TeamApiResult> {
  const args: FollowupInput = input.paths === undefined ? input : { ...input, paths: input.paths.map(scopeEntry) }
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
    if (replay.output !== undefined) return succeeded({ ...replay.output, replayed: true, state: child.state })
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
  // accepts → Corrections by followup), read for the child, not the caller. A
  // budget raise is no correction: only a followup that sends the child text
  // (a prompt, a widened scope's note, a rebase's note) is held to the row, so
  // budget alone reaches any child still working.
  const corrections = row(table, child.role, "get_context", "accepts.followup")
  const sendsText = args.prompt !== undefined || args.paths !== undefined || args.rebase === true
  if (sendsText && (corrections === undefined || !corrections.on))
    return fail(
      "E_NO_FOLLOWUP",
      `${child.role} ${corrections?.item.message ?? "takes no corrections by followup: delegate a fresh run with team_delegate and point it at the previous report"} (Briefs it accepts → Corrections by followup). A budget raise alone is accepted: call team_followup with only budget and reason.`,
      "delegate a fresh run",
    )
  // Landed is per worktree generation: a child reopened after its landing
  // works on a new branch, which can land again.
  const landed =
    child.parent !== null &&
    (await queue(root, child.parent)).some((entry) => entry.childRun === child.id && entry.childBranch === child.branch && entry.state === "landed")
  if (args.prompt === undefined && args.budget === undefined && args.rebase !== true && !args.paths?.length)
    return fail("E_NO_CONTENT", "team_followup requires prompt, budget, paths, or rebase.", "prompt, budget, paths, or rebase")
  const briefPath = path.join(root, "runs", child.id, "brief.json")
  const brief = args.paths === undefined ? undefined : await readJson<ResolvedBrief>(briefPath)
  if (args.paths !== undefined && brief === undefined)
    return fail("E_NO_BRIEF", `Run ${child.id} has no stored brief (runs/${child.id}/brief.json).`, { run: child.id })
  // A path the parent forbade by name is the parent's to grant again: a build
  // seat that forbade src/cli.ts could not widen its own child to it, landed
  // nothing and started a cold run (b9-s15, b9-s8). A forbidden folder stays.
  const widened =
    brief === undefined
      ? undefined
      : { ...brief, scope: { paths: [...new Set([...brief.scope.paths, ...args.paths!])], forbidden: brief.scope.forbidden.filter((entry) => entry.endsWith("/*") || !args.paths!.includes(entry)) } }
  if (widened !== undefined) {
    const refused = scopePathsRefusal(table, { ...widened, role: child.role }, caller, args.paths)
    if (refused !== undefined) return refused
  }
  // A landed child whose worktree was removed is reopened below, once nothing
  // refuses; a budget alone does not need its worktree.
  const reopen = landed && child.worktree === "removed"
  if (!reopen) await requireWorktree(child)
  if (landed && !reopen)
    return fail(
      "E_ALREADY_LANDED",
      `Run ${child.id} is landed but its worktree is still there; call team_integrate on it again to clean it up, then follow up.`,
      "team_integrate it again",
    )
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
    const live = records.filter((run): run is RunRecord => run !== undefined && run.kind !== "main" && occupiesSlot(run))
    const inflight = bound(table, caller.agent, "delegate", "limits.inflight")
    const members = bound(table, caller.agent, "delegate", "limits.members")
    const children = live.filter((run) => run.parent === parent.id).map((run) => run.id).toSorted()
    if (inflight !== undefined && children.length >= inflight)
      return fail("E_BOUNDS", `In-flight limit ${inflight} reached (${children.join(", ")}). No capacity to resume this child; end your turn and retry after an active run settles.`, "retry after a run settles")
    if (members !== undefined && live.length >= members)
      return fail("E_BOUNDS", `Live team runs limit ${members} reached (${live.map((run) => run.id).toSorted().join(", ")}). No capacity to resume this child; end your turn and retry after an active run settles.`, "retry after a run settles")
  }
  // A reopened child already starts at its parent's HEAD, so it needs no rebase.
  const reopened = reopen && (args.prompt !== undefined || args.rebase === true || args.paths !== undefined) ? await reopenChild(root, parent, child) : undefined
  const rebased = reopened === undefined && args.rebase === true ? await rebaseChild(root, parent, child) : undefined
  if (rebased !== undefined && !rebased.ok) return rebased.result
  const note = reopened?.note ?? rebased?.note
  const scopeNote = args.paths === undefined ? undefined : `Plus widened your edit scope: you may now also change [${[...new Set(args.paths)].join(", ")}]; forbidden paths still apply.`
  const prompt = scopeNote === undefined && note === undefined ? args.prompt : [scopeNote, note, args.prompt].filter((part) => part !== undefined).join("\n\n")
  if (widened !== undefined) {
    await atomicJson(briefPath, widened)
    await updateRun(root, child.id, (record) => ({ ...record, paths: [...widened.scope.paths] }))
    // As at delegation, republish the per-run Edit scope row before prompting.
    await Effect.runPromise(ctx.agent.reload().pipe(Effect.ignore))
  }

  if (prompt === undefined) {
    const updated = applyBudget(child, args.budget, args.reason, parent.id)
    await saveRun(root, updated)
    const lastAttempt = updated.attempts.at(-1)?.n ?? 0
    const output = { attempt: lastAttempt, state: updated.state, next: WAIT }
    await atomicJson(requestPath, { signature, output, run: child.id })
    return succeeded(output)
  }

  return followupQueue(ctx, root, requestPath, signature, parent, child.id, prompt, args.budget, args.reason, reopened?.directory)
}

// Moves a child's commits onto its parent's HEAD in the child's own worktree,
// so a correction builds on work that landed since it started (a worker has
// no git of its own). Its base moves with them: diffs and finish count only
// its own commits. Conflicts become ordinary unstaged work for the same child.
async function rebaseChild(
  root: string,
  parent: RunRecord,
  child: RunRecord,
): Promise<{ readonly ok: true; readonly note: string } | { readonly ok: false; readonly result: TeamApiResult }> {
  if (child.state !== "idle" && child.state !== "stopped")
    return { ok: false, result: fail("E_BUSY", `Run ${child.id} is ${child.state}; rebase it once it settles (its settlement wakes you).`, { rebase: true }) }
  const head = await git(parent.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
  const key = await realpath(child.directory).catch(() => child.directory)
  return lock(root, "wt", key, () =>
    lock(root, "repo", child.repoKey, async () => {
      const dirty = parsePorcelain(await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"]))
      if (dirty.length > 0)
        return {
          ok: false as const,
          result: fail("E_DIRTY", `Run ${child.id} has uncommitted changes in [${pathList(dirty)}]: only a clean worktree is rebased. Ask it to team_checkpoint first.`, dirty.slice(0, PATH_LIST_LIMIT)),
        }
      const oldHead = await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
      const moved = await gitRaw(child.directory, [
        ...NO_REPOSITORY_PROGRAMS,
        "-c",
        `user.name=team/${child.role}`,
        "-c",
        `user.email=${child.id}@team.local`,
        "rebase",
        head,
      ])
      if (moved.code !== 0) {
        const conflicted = await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "diff", "--name-only", "--diff-filter=U", "-z"])
        await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "rebase", "--abort"])
        if (conflicted === "") return { ok: false as const, result: fail("E_GIT", moved.err || moved.out) }
        // Keep every original commit reachable even after the branch is reset.
        const backup = `refs/opencodeplus/replay/${child.id}/${oldHead}`
        await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "update-ref", backup, oldHead])
        const touched = (await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "diff", "--name-only", "--no-renames", "-z", child.base, oldHead])).split("\0").filter(Boolean)
        await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "reset", "--hard", head])
        const replay = await gitRaw(child.directory, [...NO_REPOSITORY_PROGRAMS, "-c", "merge.conflictStyle=merge", "merge", "--squash", "--no-commit", oldHead])
        const conflicts = (await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean)
        if (replay.code !== 0 && conflicts.length === 0) {
          await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "reset", "--hard", oldHead])
          return { ok: false as const, result: fail("E_GIT", replay.err || replay.out) }
        }
        // No merge/rebase operation remains. New files become untracked and all
        // other changes unstaged, so team_checkpoint owns the entire next commit.
        await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "reset", "--mixed", head])
        const files = [...new Set([...touched, ...parsePorcelain(await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"]))])]
        await updateRun(root, child.id, (record) => ({ ...record, base: head, head }))
        return {
          ok: true as const,
          // Live, a worker committed only the conflicted file and finish refused the
          // rest (E_DIRTY): the whole change is uncommitted now, so name the one call.
          note: `Plus replayed your whole change onto your parent's current HEAD ${head}: your base and HEAD are now that commit, and every file your change touches is uncommitted in your worktree: [${pathList(files)}]. Conflict markers are in [${pathList(conflicts)}]. Resolve them keeping both sides' intent, run your checks, then commit the whole change in one call, team_checkpoint with files [${pathList(files)}], and finish. Your old commits remain at ${backup}.`,
        }
      }
      const tip = await git(child.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
      await updateRun(root, child.id, (record) => ({ ...record, base: head, head: tip }))
      return {
        ok: true as const,
        note: `Plus moved your commits onto ${head.slice(0, 12)}, your parent's current HEAD (your branch is now at ${tip.slice(0, 12)}). Run your checks there before you finish.`,
      }
    }),
  )
}

// Gives a landed child whose worktree was removed a new one at the HEAD it
// landed on, which holds its landed commits and everything landed since, so a
// followup keeps its context instead of a fresh run reading it all again. The
// worktree and the record that claims it are written in one repository-lock
// hold (`provision`), so the orphan sweep never sees one without the other.
// The chat moves there with its prompt (admitIdleChild) and keeps its pinned
// system prompt.
async function reopenChild(root: string, caller: RunRecord, child: RunRecord): Promise<{ readonly note: string; readonly directory: string }> {
  const parent = child.parent === caller.id ? caller : await loadRun(root, child.parent ?? "")
  if (parent === undefined) throw toolError("E_INTERNAL", `Run ${child.id}'s parent ${child.parent} has no record.`)
  if (child.sessionID === null) throw toolError("E_INTERNAL", `Run ${child.id} has no session to move.`, child.id)
  const head = await git(parent.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
  // The delegated name plus the generation: a landed branch is kept, and a
  // reopen in the same minute as the branch it follows would reuse its name.
  const generation = child.history.filter((entry) => "trigger" in entry && entry.trigger === "reopened").length + 2
  const name = /^team\/[^/]+\/(.+?)(?:-r\d+)?-\d{8}-\d{4}$/.exec(child.branch)?.[1] ?? slug(child.task ?? child.id, child.id)
  const provisioned = await provision(
    root,
    {
      repoRoot: parent.directory,
      repoKey: child.repoKey,
      role: child.role,
      name: `${name}-r${generation}`,
      base: head,
      workspaceRoot: root,
    },
    (created) =>
      updateRun(root, child.id, (record) => ({
        ...record,
        directory: created.dir,
        branch: created.branch,
        base: head,
        head: created.head,
        worktree: "present",
        history: [...record.history, { at: new Date().toISOString(), from: record.state, to: record.state, trigger: "reopened" }],
      })),
  )
  return {
    directory: provisioned.created.dir,
    note: `Plus made you a new worktree at ${provisioned.created.dir}, on your parent's current HEAD ${head.slice(0, 12)}: it holds your landed commits and the work landed since. Work and commit there.`,
  }
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
  moveTo?: string,
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
    if (moveTo !== undefined && current.sessionID !== null) await Effect.runPromise(moveChat(ctx, current.sessionID, moveTo))
    const budgeted = applyBudget(current, budget, reason, parent.id)
    await saveRun(root, budgeted)
    if (budgeted.sessionID === null)
      throw toolError("E_INTERNAL", `Run ${budgeted.id} has no session to prompt.`, budgeted.id)
    const queued = await put(root, childID, { kind: "followup", from: parent.id, text })
    // team_finish holds a report the child wrote before this reached it (b12-s6).
    const steered = SessionMessage.ID.create()
    await Effect.runPromise(
      ctx.session.prompt({ id: steered, sessionID: Session.ID.make(budgeted.sessionID), text, delivery: "steer" }),
    )
    await updateRun(root, childID, (fresh) => ({ ...recordInboxDelivery(fresh, [queued.id]), steeredMessage: steered }))
    await take(root, childID, [queued.id])
    const last = budgeted.attempts.at(-1)
    const output = { attempt: last?.n ?? 1, state: "queued", next: WAIT }
    await atomicJson(requestPath, { signature, output, run: childID })
    return succeeded(output)
  }
  // An idle child is prompted now, so the item it was prompted with is
  // recorded as delivered and the idle drain will not repeat it. A prompt the
  // host refused leaves the run as it was, and the item goes too: a retry
  // brings its own.
  const queued = await put(root, childID, { kind: "followup", from: parent.id, text })
  const admitted = await admitIdleChild(ctx, root, current, text, budget, reason, parent.id, queued.id, moveTo).catch(async (error: unknown) => {
    await take(root, childID, [queued.id])
    throw error
  })
  const done = admitted.attempts[admitted.attempts.length - 1]
  const output = { attempt: done?.n ?? 1, state: "admitted", next: WAIT }
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
  moveTo?: string,
): Promise<RunRecord> {
  if (moveTo !== undefined && current.sessionID !== null) await Effect.runPromise(moveChat(ctx, current.sessionID, moveTo))
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

// The old folder of a reopened child is gone, so core commits the move at
// once, and a prompt can reach the chat only in its new folder. The move wakes
// the chat into an empty run; this waits it out, so the follow-up's attempt
// starts after it, and the lifecycle leaves that run alone (movedRun).
function moveChat(ctx: Context, sessionID: string, directory: string) {
  return ctx.session
    .move({
      sessionID: Session.ID.make(sessionID),
      directory: AbsolutePath.make(directory),
      ...(ctx.location.workspaceID === undefined ? {} : { workspaceID: ctx.location.workspaceID }),
      delivery: "steer",
    })
    .pipe(Effect.andThen(ctx.session.wait({ sessionID: Session.ID.make(sessionID) })))
}
