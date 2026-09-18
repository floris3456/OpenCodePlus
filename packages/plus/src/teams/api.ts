// Team tool handlers: delegate, finish, checkpoint, status, get_context,
// wait, check, followup, integrate, set_checks, supersede, stop and list
// are real implementations. The other ten methods stay as E_NOT_IMPLEMENTED
// scaffolding for a later task.
//
// Every handler returns a result object and never throws: runGated in
// tools.ts turns `{ ok: false, error }` into the model-visible Tool.Error,
// while an unexpected throw would escape as an untyped Effect failure.
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Effect, Option, Schema } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import type { PlusState } from "../index.js"
import { execute, isCleanReceipt, lastReceipt, receiptsAt, run, stale } from "./checks.js"
import { reconcile } from "./lifecycle.js"
import { followupHandler } from "./api-followup.js"
import { setChecksHandler } from "./api-git-ops.js"
import { integrateHandler } from "./api-integrate.js"
import { stopHandler, supersedeHandler } from "./api-lifecycle.js"
import { listHandler } from "./api-query.js"
import { git, gitRaw } from "./git.js"
import { peek } from "./inbox.js"
import { kindOf } from "./policy.js"
import { render } from "./report.js"
import {
  attemptTransition,
  isAttemptTerminal,
  loadRun,
  newRunID,
  occupiesSlot,
  saveRun,
  startAttempt,
  transition,
  type RunRecord,
} from "./run.js"
import {
  Brief,
  Head,
  Policy,
  Report,
  RunID,
  budgetExhaustion,
  toolError,
  validateChecks,
  type Check,
} from "./schema.js"
import { atomicJson, lock, readJson, sanitizeLockKey } from "./store.js"
import { addAdhoc, claim } from "./tasks.js"
import { create as createWorktree, slug } from "./worktree.js"

export interface TeamApiError {
  readonly code: string
  readonly message: string
  readonly accepted?: unknown
}

export type TeamApiResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TeamApiError }

// The run that owns the calling session, resolved once by runGated so the
// handlers read the caller's identity without another bySession scan.
export interface TeamCaller {
  readonly sessionID: string
  readonly agent: string
  readonly run: RunRecord
}

export interface TeamApi {
  readonly delegate: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly finish: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly followup: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly review: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly integrate: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly checkpoint: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly set_checks: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly supersede: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly shutdown_request: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly stop: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly resume: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly prepare: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly plan_handoff: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly status: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly wait: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly diff: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly list: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly get_context: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly check: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly metrics: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly exa_code_search: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly tavily_search: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
  readonly tavily_extract: (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>
}

// Policy file loading lands later; the gates read bounds and effort budgets
// from the schema defaults (members 12, inFlight 4, maxDepth 3, brief 6000).
const policy = Schema.decodeUnknownSync(Policy)({})

const CheckpointInput = Schema.Struct({
  expectedHead: Head,
  files: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  message: Schema.String.check(Schema.isMaxLength(300)),
})

const StatusInput = Schema.Struct({
  runs: Schema.optional(Schema.Array(RunID).check(Schema.isMinLength(1), Schema.isMaxLength(20))),
})

const WaitInput = Schema.Struct({
  runs: Schema.Array(RunID).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  timeoutMs: Schema.optional(Schema.Number),
  until: Schema.optional(Schema.Literals(["settled", "idle"])),
})

const CheckInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
})

const GetContextInput = Schema.Struct({})

const PATHS_MESSAGE =
  `Implementers need scope.paths (files or dir/* they may edit). accepted: ["packages/plus/src/*","packages/plus/test/*"]`
const PATHS_ACCEPTED = ["packages/plus/src/*", "packages/plus/test/*"]
const PLANNERS_MESSAGE = `Planners may delegate only to opus-orchestrator or sol-orchestrator. accepted: {"role":"opus-orchestrator",...}`
const MESSAGE_ACCEPTED = "fix: apply agent filter in query"
const COMMIT_MESSAGE_RE = /^(feat|fix|docs|chore|refactor|test)(\([^)]+\))?: /

function notImplemented(tool: string): TeamApiResult {
  return { ok: false, error: { code: "E_NOT_IMPLEMENTED", message: `${tool} is not implemented yet`, accepted: null } }
}

function succeeded(value: unknown): TeamApiResult {
  return { ok: true, value }
}

function fail(code: string, message: string, accepted?: unknown): TeamApiResult {
  if (accepted === undefined) return { ok: false, error: { code, message } }
  return { ok: false, error: { code, message, accepted } }
}

// Throwing helpers (validateChecks, tasks.claim, checks.run, git) surface as
// toolError-shaped plain objects; anything else is an internal failure.
function thrownError(error: unknown): TeamApiError {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>
    if (typeof record.code === "string" && typeof record.message === "string") {
      if (record.accepted === undefined) return { code: record.code, message: record.message }
      return { code: record.code, message: record.message, accepted: record.accepted }
    }
    if (error instanceof Error) return { code: "E_INTERNAL", message: error.message }
  }
  return { code: "E_INTERNAL", message: String(error) }
}

async function guarded(work: () => Promise<TeamApiResult>): Promise<TeamApiResult> {
  try {
    return await work()
  } catch (error) {
    return { ok: false, error: thrownError(error) }
  }
}

export function createTeamApi(ctx: Context, state: PlusState): TeamApi {
  void state
  return {
    delegate: (input, caller) => guarded(() => delegateHandler(ctx, input, caller)),
    finish: (input, caller) => guarded(() => finishHandler(input, caller)),
    followup: (input, caller) => guarded(() => followupHandler(ctx, input, caller)),
    review: async () => notImplemented("review"),
    integrate: (input, caller) => guarded(() => integrateHandler(ctx, input, caller)),
    checkpoint: (input, caller) => guarded(() => checkpointHandler(input, caller)),
    set_checks: (input, caller) => guarded(() => setChecksHandler(input, caller)),
    supersede: (input, caller) => guarded(() => supersedeHandler(ctx, input, caller)),
    shutdown_request: async () => notImplemented("shutdown_request"),
    stop: (input, caller) => guarded(() => stopHandler(ctx, input, caller)),
    resume: async () => notImplemented("resume"),
    prepare: async () => notImplemented("prepare"),
    plan_handoff: async () => notImplemented("plan_handoff"),
    status: (input, caller) => guarded(() => statusHandler(input, caller)),
    wait: (input, caller) => guarded(() => waitHandler(ctx, input, caller)),
    diff: async () => notImplemented("diff"),
    list: (input, caller) => guarded(() => listHandler(input, caller)),
    get_context: (input, caller) => guarded(() => getContextHandler(input, caller)),
    check: (input, caller) => guarded(() => checkHandler(input, caller)),
    metrics: async () => notImplemented("metrics"),
    exa_code_search: async () => notImplemented("exa_code_search"),
    tavily_search: async () => notImplemented("tavily_search"),
    tavily_extract: async () => notImplemented("tavily_extract"),
  }
}

async function delegateHandler(ctx: Context, input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(Brief)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid delegate input.")
  const brief = decoded.value
  const stored = await loadRun(root, caller.run.id)
  const parent = stored ?? caller.run

  const callerKind = kindOf(parent.role)
  if (!callerKind.ok)
    return fail("E_ROLE", PLANNERS_MESSAGE, { role: "opus-orchestrator" })
  const targetKind = kindOf(brief.role)
  if (!targetKind.ok) return fail("E_ROLE", PLANNERS_MESSAGE, { role: "opus-orchestrator" })
  if ((await depthOf(root, parent)) >= policy.bounds.maxDepth)
    return fail(
      "E_ROLE",
      `Depth limit ${policy.bounds.maxDepth} reached; this run cannot delegate. Report blocked with needs=[{kind:"decision",...}] instead.`,
      `report blocked with needs=[{kind:"decision"}]`,
    )
  if (callerKind.kind === "planner" && !policy.roles.planner.delegateTo.includes(brief.role))
    return fail("E_ROLE", PLANNERS_MESSAGE, { role: "opus-orchestrator" })
  if (callerKind.kind === "orchestrator" && !policy.roles.orchestrator.delegateTo.includes(brief.role)) {
    const first = policy.roles.orchestrator.delegateTo[0] ?? "muse-implementer"
    return fail("E_ROLE", `Role "${brief.role}" is not allowed for orchestrator. accepted: {"role":"${first}",...}`, {
      role: first,
    })
  }
  if (callerKind.kind !== "planner" && callerKind.kind !== "orchestrator")
    return fail("E_ROLE", `Role ${parent.role} cannot delegate. accepted: {"role":"muse-implementer",...}`, {
      role: "muse-implementer",
    })

  const rawRepo = brief.repo ?? parent.repoKey ?? parent.repo
  const repo = await resolveRepo(rawRepo, parent)
  if (repo === undefined) {
    const keys = [...new Set([parent.repoKey, parent.repo].filter((key) => key.length > 0))]
    return fail(
      "E_REPO",
      `repo must be a configured key (${keys.map((key) => `"${key}"`).join(",")}) or an absolute path under repos/ or worktrees/. Got "${rawRepo}". accepted: "${parent.repoKey}"`,
      parent.repoKey,
    )
  }

  const defaultHead = await callerHead(parent.directory, repo.root)
  const baseSha = await resolveBase(repo.root, brief.base, defaultHead)
  if (baseSha === undefined)
    return fail(
      "E_BASE",
      `base "${brief.base}" is not a ref or commit in ${repo.key}. Omit base to use your HEAD (${defaultHead}), or pass a branch/sha. accepted: "ocp-main"`,
      "ocp-main",
    )

  try {
    validateChecks([...brief.checks])
  } catch (error) {
    return { ok: false, error: thrownError(error) }
  }

  const paths = brief.scope.paths
  for (const candidate of paths) {
    if (!isScopePath(candidate)) return fail("E_PATHS", PATHS_MESSAGE, PATHS_ACCEPTED)
  }
  if (targetKind.kind === "implementer" && brief.deliverable.kind === "commit" && paths.length === 0)
    return fail("E_PATHS", PATHS_MESSAGE, PATHS_ACCEPTED)

  if (brief.role === "spark-implementer" && (brief.reason?.trim() === "" || brief.reason === undefined || paths.length > 5 || brief.checks.length !== 1))
    return fail("E_SPARK", `spark-implementer needs reason, ≤5 paths and exactly one check. accepted: {...}`, {
      reason: "...",
      paths: ["src/a.ts"],
      checks: 1,
    })

  if (targetKind.kind === "orchestrator" && (brief.reason === undefined || brief.reason.trim() === ""))
    return fail(
      "E_REASON",
      `Delegating to an orchestrator needs reason (why coordination, not implementation). accepted: {"reason":"3 independent packages, each needs its own workers"}`,
      { reason: "3 independent packages, each needs its own workers" },
    )

  const childID = newRunID("w")
  let taskID = brief.task
  if (taskID !== undefined) {
    const planRun = await findPlanForTask(root, taskID)
    if (planRun === undefined) return fail("E_TASK_BLOCKED", `Task ${taskID} not found.`, [])
    try {
      await claim(root, planRun, taskID, childID)
    } catch (error) {
      return { ok: false, error: thrownError(error) }
    }
  }

  const records = await listRuns(root)
  const live = records.filter((record) => occupiesSlot(record))
  const inFlight = live
    .filter((record) => record.parent === parent.id)
    .map((record) => record.id)
    .toSorted()
  if (inFlight.length >= policy.bounds.inFlight)
    return fail(
      "E_BOUNDS",
      `In-flight limit ${policy.bounds.inFlight} reached (${inFlight.join(", ")}). Call wait first or raise bounds.inFlight in policy.`,
      "call wait first",
    )
  if (live.length >= policy.bounds.members) {
    const all = live.map((record) => record.id).toSorted()
    return fail(
      "E_BOUNDS",
      `Members limit ${policy.bounds.members} reached (${all.join(", ")}). Call wait first or raise bounds.members in policy.`,
      "raise bounds.members in policy",
    )
  }

  const signature = signatureOf(input)
  const requestPath = path.join(root, "requests", `${sanitizeLockKey(parent.id)}__${sanitizeLockKey(brief.requestID)}.json`)
  const replay = await readJson<{ signature?: string; output?: Record<string, unknown> }>(requestPath)
  if (replay?.signature !== undefined) {
    if (replay.signature !== signature)
      return fail(
        "E_REQUEST_ID",
        `requestID "${brief.requestID}" was used with different arguments; reuse only to retry the identical call, else pick a new requestID.`,
        "pick a new requestID",
      )
    if (replay.output !== undefined) return succeeded(replay.output)
  }

  const ifaceChars = brief.context.interfaces.reduce((n, item) => n + item.path.length + (item.symbol?.length ?? 0) + item.note.length, 0)
  const decisionChars = brief.context.decisions.reduce((n, decision) => n + decision.length, 0)
  const briefChars = brief.objective.length + (brief.prompt?.length ?? 0) + ifaceChars + decisionChars
  if (briefChars > policy.bounds.briefChars)
    return fail(
      "E_TOO_LONG",
      `Brief text is ${briefChars} chars (max ${policy.bounds.briefChars}). Move long material into a file and pass briefFile.`,
      "pass briefFile",
    )

  if (taskID === undefined) {
    const title = brief.objective.split("\n")[0] ?? ""
    taskID = await addAdhoc(root, {
      title: title.slice(0, 100) || `Work for ${brief.requestID}`,
      role: brief.role,
      effort: brief.effort,
      paths: [...paths],
      checks: [...brief.checks],
      deliverable: { ...brief.deliverable },
    })
  }

  const briefModule = await import("./brief.js")
  const budget = briefModule.budgetFor(brief.effort, { effort: policy.effort })

  let attached: { path: string; content: string } | undefined
  const briefFile = brief.briefFile
  if (briefFile !== undefined) {
    const realBrief = await realpath(briefFile).catch(() => briefFile)
    const callerReal = await realpath(parent.directory).catch(() => parent.directory)
    const runDir = path.join(root, "runs", parent.id)
    const runReal = await realpath(runDir).catch(() => runDir)
    const inside =
      realBrief === callerReal ||
      realBrief.startsWith(`${callerReal}${path.sep}`) ||
      realBrief === runReal ||
      realBrief.startsWith(`${runReal}${path.sep}`)
    if (!inside) return fail("E_PATHS", PATHS_MESSAGE, PATHS_ACCEPTED)
    attached = { path: briefFile, content: await readFile(realBrief, "utf8") }
  }

  const rendered = briefModule.render(brief, { budget, ...(attached === undefined ? {} : { attached }) })
  const briefSha = createHash("sha256").update(rendered, "utf8").digest("hex")

  const created = await createWorktree(root, {
    repoRoot: repo.root,
    repoKey: repo.key,
    role: targetKind.kind,
    name: slug(taskID ?? brief.requestID, childID),
    base: baseSha,
    workspaceRoot: root,
  })

  // The child run is a session in this same process, created directly in its
  // worktree; no session.move is needed.
  const sessions = ctx.session
  const directory = AbsolutePath.make(created.dir)
  const location =
    ctx.location.workspaceID === undefined
      ? Location.Ref.make({ directory })
      : Location.Ref.make({ directory, workspaceID: ctx.location.workspaceID })
  const child = await Effect.runPromise(sessions.create({ agent: Agent.ID.make(brief.role), location }))

  const now = new Date().toISOString()
  const opened = startAttempt(
    {
      id: childID,
      role: brief.role,
      kind: "w",
      repo: repo.key,
      repoKey: repo.key,
      directory: created.dir,
      paths: [...paths],
      branch: created.branch,
      base: baseSha,
      head: created.head,
      state: "starting",
      attempts: [],
      task: taskID,
      parent: parent.id,
      children: [],
      briefSha,
      bundle: parent.bundle,
      budget: { turns: budget.turns, tokens: budget.tokens, wallMs: budget.wallMs },
      createdAt: now,
      lastUsed: now,
      sessionID: String(child.id),
      configDigest: null,
      history: [],
    },
    { trigger: "delegate" },
  )
  const admitted = attemptTransition(opened, "admitted", "admit")
  const streaming = attemptTransition(admitted, "streaming", "first_event")
  await saveRun(root, streaming)

  const latest = await loadRun(root, parent.id)
  if (latest !== undefined && !latest.children.includes(childID))
    await saveRun(root, { ...latest, children: [...latest.children, childID], lastUsed: now }).catch(() => undefined)

  const runDir = path.join(root, "runs", childID)
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, "brief.md"), rendered, "utf8")
  await atomicJson(path.join(runDir, "brief.json"), brief)
  await atomicJson(path.join(runDir, "checks.json"), [...brief.checks])

  await Effect.runPromise(sessions.prompt({ sessionID: child.id, text: rendered }))

  const output = {
    run: childID,
    session: String(child.id),
    task: taskID,
    state: "starting",
    directory: created.dir,
    branch: created.branch,
    base: baseSha,
    briefPath: path.join(runDir, "brief.md"),
    budget: { turns: budget.turns, tokens: budget.tokens, wallMs: budget.wallMs },
  }
  await atomicJson(requestPath, { signature, output, run: childID })
  return succeeded(output)
}

async function finishHandler(input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(Report)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid finish input.")
  const args = decoded.value
  const stored = await loadRun(root, caller.run.id)
  if (stored === undefined) return fail("E_INTERNAL", `Unknown run "${caller.run.id}".`, caller.run.id)
  const last = stored.attempts[stored.attempts.length - 1]
  if (last === undefined) return fail("E_INTERNAL", `Run ${stored.id} has no attempts to finish.`, stored.id)
  const n = last.n
  const recorded = await readJson<unknown>(path.join(root, "runs", stored.id, `report-${n}.json`))
  if (recorded !== undefined || isAttemptTerminal(last.state))
    return fail("E_FINISH_TWICE", `Report already recorded for attempt ${n}. Corrections arrive as a new attempt; just stop.`, "stop")

  const worktree = stored.directory
  const assigned = await readChecks(root, stored.id)
  const head = await git(worktree, ["rev-parse", "HEAD"])
  const porcelain = await git(worktree, ["status", "--porcelain"])
  const dirtyFiles = parsePorcelain(porcelain)

  // Compound behaviour: assigned checks with no receipt at HEAD run now,
  // through the same executor as team_check, before any gate judges them.
  const missing = await stale(root, assigned, stored.id, head)
  for (const checkDef of missing) await execute(root, { runID: stored.id, check: checkDef, worktree })

  if (args.status === "done" || args.status === "done_with_concerns") {
    const receipts = await receiptsAt(root, stored.id, head)
    const byId = new Map(receipts.map((receipt) => [receipt.id, receipt] as const))
    const red: string[] = []
    const firstLines = new Map<string, string>()
    for (const checkDef of assigned) {
      const receipt = byId.get(checkDef.id)
      if (receipt !== undefined && receipt.passed) continue
      red.push(checkDef.id)
      firstLines.set(checkDef.id, await firstLogLine(receipt?.outputPath))
    }
    if (red.length > 0) {
      const first = red[0]
      const line = firstLines.get(first) ?? "failed"
      return fail(
        "E_CHECKS_RED",
        `Cannot report done: checks red at HEAD ${head}: [${red.join(", ")}]. Fix and finish again, or finish with status "blocked" and needs=[{kind:"check",detail:"${first} fails: ${line}"}].`,
        { status: "blocked", needs: [{ kind: "check", detail: `${first} fails: ${line}` }] },
      )
    }
  }

  if (args.status === "done" && isImplementerRole(stored.role) && dirtyFiles.length > 0)
    return fail(
      "E_DIRTY",
      `Worktree has uncommitted changes in [${dirtyFiles.join(", ")}]. Call team_checkpoint first, or list them in deferred with a reason and use done_with_concerns.`,
      { files: [...dirtyFiles] },
    )

  if ((args.status === "blocked" || args.status === "needs_context" || args.status === "rejected") && args.needs.length === 0)
    return fail(
      "E_NEEDS",
      `status "${args.status}" needs at least one entry in needs. accepted: [{"kind":"path","detail":"packages/core/src/x.ts is outside scope; needed to add the export"}]`,
      [{ kind: "path", detail: "packages/core/src/x.ts is outside scope; needed to add the export" }],
    )

  const lineCount = args.summary.split("\n").length
  if (lineCount > 15)
    return fail(
      "E_SUMMARY",
      `summary is ${lineCount} lines (max 15). Detail goes to the report file automatically; keep the summary to what the parent must act on.`,
      "a summary of ≤15 lines",
    )

  const commits = await loadCommits(worktree, stored.base)
  const reportChecks = (await receiptsAt(root, stored.id, head))
    .map((receipt) => ({ id: receipt.id, passed: receipt.passed, head: receipt.head, at: receipt.at }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
  const now = new Date().toISOString()
  const reportPath = path.join(root, "runs", stored.id, `report-${n}.md`)
  const body = {
    run: stored.id,
    attempt: n,
    status: args.status,
    summary: args.summary,
    concerns: [...args.concerns],
    needs: [...args.needs],
    findings: [...args.findings],
    deferred: [...args.deferred],
    commits,
    checks: reportChecks,
    head,
    base: stored.base,
    dirty: dirtyFiles.length > 0,
    dirtyFiles: [...dirtyFiles],
    reportPath,
    at: now,
  }
  await mkdir(path.join(root, "runs", stored.id), { recursive: true })
  await writeFile(
    reportPath,
    render(body, { run: stored.id, attempt: n, head, commits, checks: reportChecks }),
    "utf8",
  )
  await atomicJson(path.join(root, "runs", stored.id, `report-${n}.json`), body)

  const fresh = (await loadRun(root, stored.id)) ?? stored
  const terminal = args.status === "done" || args.status === "done_with_concerns" ? "succeeded" : "reported"
  const moved = attemptTransition(finishAttempt(fresh), terminal, "validated")
  // The finished attempt means the session turn ended, so the run is idle
  // again (02 §1 working → idle on turn_ended). Runs still in starting
  // reach the same idle via connected; already-idle runs need no move.
  const settled = { ...moved, head, lastUsed: now }
  const idle =
    settled.state === "working" || settled.state === "starting"
      ? transition(settled, "idle", settled.state === "working" ? "turn_ended" : "connected")
      : settled
  await saveRun(root, idle)
  return succeeded(body)
}

async function checkpointHandler(input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(CheckpointInput)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid checkpoint input.")
  const args = decoded.value
  const stored = await loadRun(root, caller.run.id)
  const record = stored ?? caller.run
  const key = await realpath(record.directory).catch(() => record.directory)
  return lock(root, "wt", key, async () => {
    const head = await git(record.directory, ["rev-parse", "HEAD"])
    if (head !== args.expectedHead) return fail("E_STALE_HEAD", `HEAD is ${head}, not ${args.expectedHead}.`)
    for (const file of args.files) {
      if (!inScope(record.paths, file))
        return fail("E_SCOPE", `"${file}" is outside your scope.paths [${record.paths.join(", ")}]. Report it in needs=[{kind:"path"...}].`)
    }
    if (args.message.length === 0 || args.message.length > 300 || !COMMIT_MESSAGE_RE.test(args.message))
      return fail(
        "E_MESSAGE",
        `Use "<type>(<scope>)?: <subject>" with type in feat|fix|docs|chore|refactor|test. accepted: "${MESSAGE_ACCEPTED}"`,
        MESSAGE_ACCEPTED,
      )
    const stagedOut = await git(record.directory, ["diff", "--cached", "--name-only"])
    const staged = stagedOut
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const wanted = new Set(args.files)
    const offenders = staged.filter((line) => !wanted.has(line))
    if (offenders.length > 0)
      return fail("E_STAGED", `Index has staged changes [${offenders.join(", ")}] not in files[]; include them or unstage.`)
    const status = await git(record.directory, ["status", "--porcelain", "--", ...args.files])
    if (status.trim() === "") return succeeded({ head, committed: false })
    // Ref-writing git ops serialize per repository, like the reference.
    const committed = await lock(root, "repo", record.repoKey, async () => {
      await git(record.directory, ["add", "--", ...args.files])
      const cached = await gitRaw(record.directory, ["diff", "--cached", "--quiet"])
      if (cached.code === 0) return false
      await git(record.directory, [
        "-c",
        `user.name=team/${record.role}`,
        "-c",
        `user.email=${record.id}@team.local`,
        "commit",
        "-m",
        args.message,
      ])
      return true
    })
    if (!committed) {
      const current = await git(record.directory, ["rev-parse", "HEAD"])
      return succeeded({ head: current, committed: false })
    }
    const sha = await git(record.directory, ["rev-parse", "HEAD"])
    const subject = await git(record.directory, ["log", "-1", "--format=%s"])
    const fresh = (await loadRun(root, record.id)) ?? record
    await saveRun(root, { ...fresh, head: sha, lastUsed: new Date().toISOString() })
    return succeeded({ head: sha, committed: true, sha, subject })
  })
}

async function statusHandler(input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(StatusInput)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid status input.")
  const stored = await loadRun(root, caller.run.id)
  const self = stored ?? caller.run
  const all = await listRuns(root)
  const ids = decoded.value.runs ?? [self.id, ...all.filter((record) => record.parent === self.id).map((record) => record.id)]
  const entries = []
  for (const id of ids) entries.push(await statusOf(root, id))
  return succeeded(entries)
}

async function waitHandler(ctx: Context, input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(WaitInput)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid wait input.")
  const args = decoded.value
  const timeoutMs = args.timeoutMs ?? 60000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10000)
    return fail("E_TIMEOUT_MIN", `timeoutMs ${String(args.timeoutMs)} is below the 10000ms floor.`, { timeoutMs: 10000 })
  const until = args.until ?? "settled"
  for (const id of args.runs) {
    if ((await loadRun(root, id)) === undefined)
      return fail("E_NOT_VISIBLE", `Run ${id} is not in this namespace.`, "a run id from list{}")
  }
  const settledNow = await settledIds(root, args.runs, until)
  if (settledNow.length > 0) return succeeded(await waitResult(root, caller.run.id, args.runs, settledNow, until))
  // Race the host's session.wait per listed run against the timeout; no
  // polling loop by the model.
  const sessions = ctx.session
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const racers: Array<Promise<unknown>> = []
    for (const id of args.runs) {
      const record = await loadRun(root, id)
      if (record === undefined || record.sessionID === null) continue
      const sid = record.sessionID
      racers.push(
        Effect.runPromise(sessions.wait({ sessionID: Session.ID.make(sid) })).then(
          () => null,
          () => null,
        ),
      )
    }
    if (racers.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(150, remaining)))
    } else {
      await Promise.race([...racers, new Promise((resolve) => setTimeout(resolve, remaining))])
    }
    const settled = await settledIds(root, args.runs, until)
    if (settled.length > 0) return succeeded(await waitResult(root, caller.run.id, args.runs, settled, until))
    await new Promise((resolve) => setTimeout(resolve, Math.min(150, Math.max(deadline - Date.now(), 0))))
  }
  const settled = await settledIds(root, args.runs, until)
  if (settled.length > 0) return succeeded(await waitResult(root, caller.run.id, args.runs, settled, until))
  await Effect.runPromise(Effect.promise(() => reconcile(ctx, root)).pipe(Effect.ignore))
  const resettled = await settledIds(root, args.runs, until)
  if (resettled.length > 0) return succeeded(await waitResult(root, caller.run.id, args.runs, resettled, until))
  return succeeded({ settled: [], timedOut: true, stillOpen: [...args.runs], overBudget: await overBudgetIds(root, args.runs) })
}

async function getContextHandler(input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(GetContextInput)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid get_context input.")
  const stored = await loadRun(root, caller.run.id)
  const record = stored ?? caller.run
  const raw = await readJson<unknown>(path.join(root, "runs", record.id, "brief.json"))
  if (raw === undefined)
    throw toolError("E_NO_BRIEF", `Run ${record.id} has no stored brief (runs/${record.id}/brief.json).`, { run: record.id })
  const briefParsed = Schema.decodeUnknownOption(Brief)(raw)
  if (Option.isNone(briefParsed))
    throw toolError("E_NO_BRIEF", `Run ${record.id} has an unreadable brief.`, {
      run: record.id,
    })
  const brief = briefParsed.value
  const assigned = await readChecks(root, record.id)
  const checks = await Promise.all(
    assigned.map(async (checkDef) => {
      const receipt = await lastReceipt(root, record.id, checkDef.id)
      // Only a clean receipt proves its HEAD; dirty-tree (or pre-flag)
      // receipts never count as the last passed HEAD.
      const clean = receipt !== undefined && isCleanReceipt(receipt)
      return {
        id: checkDef.id,
        argv: [...checkDef.argv],
        cwd: checkDef.cwd ?? "",
        lastPassedHead: clean && receipt.passed ? receipt.head : null,
      }
    }),
  )
  const siblings = record.task === null ? [] : await siblingsOf(root, record.task)
  const pending = await peek(root, record.id)
  return succeeded({
    run: record.id,
    role: record.role,
    task: record.task,
    directory: record.directory,
    branch: record.branch,
    base: record.base,
    head: record.head,
    brief,
    briefPath: path.join(root, "runs", record.id, "brief.md"),
    scope: { paths: [...brief.scope.paths], forbidden: [...brief.scope.forbidden] },
    checks,
    interfaces: [...brief.context.interfaces],
    decisions: [...brief.context.decisions],
    siblings,
    conventions: "",
    budget: {
      turns: record.budget.turns ?? null,
      tokens: record.budget.tokens ?? null,
      wallMs: record.budget.wallMs ?? null,
      used: { turns: record.attempts.length },
    },
    inbox: pending.map((item) => ({ id: item.id, from: item.from, kind: item.kind, text: item.text })),
  })
}

async function checkHandler(input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(CheckInput)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid check input.")
  const stored = await loadRun(root, caller.run.id)
  const record = stored ?? caller.run
  const assigned = await readChecks(root, record.id)
  try {
    return succeeded(await run(root, record.id, decoded.value.id, assigned, record.directory))
  } catch (error) {
    return { ok: false, error: thrownError(error) }
  }
}

async function depthOf(root: string, record: RunRecord): Promise<number> {
  let depth = 0
  let current: RunRecord | undefined = record
  const seen = new Set<string>()
  for (let i = 0; i < 100; i++) {
    if (current === undefined || current.parent === null || seen.has(current.id)) break
    seen.add(current.id)
    const parent = await loadRun(root, current.parent)
    if (parent === undefined) break
    depth += 1
    current = parent
  }
  return depth
}

async function resolveRepo(raw: string, parent: RunRecord): Promise<{ key: string; root: string } | undefined> {
  if (raw === parent.repoKey || raw === parent.repo) {
    const top = await gitRaw(parent.directory, ["rev-parse", "--show-toplevel"])
    if (top.code !== 0) throw new Error(`Cannot resolve repository from ${parent.directory}: ${top.err || top.out || "unknown error"}`)
    return { key: parent.repoKey, root: top.out }
  }
  if (!path.isAbsolute(raw)) return undefined
  const top = await gitRaw(raw, ["rev-parse", "--show-toplevel"])
  if (top.code !== 0) return undefined
  return { key: path.basename(top.out), root: top.out }
}

async function callerHead(callerDir: string, repoRoot: string): Promise<string> {
  const head = await gitRaw(callerDir, ["rev-parse", "HEAD"])
  if (head.code === 0) return head.out
  const fallback = await gitRaw(repoRoot, ["rev-parse", "HEAD"])
  if (fallback.code === 0) return fallback.out
  return "unknown"
}

async function resolveBase(repoRoot: string, base: string | undefined, defaultHead: string): Promise<string | undefined> {
  if (base === undefined) return defaultHead
  const verify = await gitRaw(repoRoot, ["rev-parse", "--verify", `${base}^{commit}`])
  if (verify.code !== 0) return undefined
  return verify.out
}

function isScopePath(candidate: string): boolean {
  if (candidate.endsWith("/*")) {
    const base = candidate.slice(0, -2)
    return base.length > 0 && isScopePath(base)
  }
  if (candidate === "" || candidate.startsWith("/") || candidate.endsWith("/")) return false
  if (candidate.split("/").includes("..")) return false
  return !/(^|\/)(\.git|\.cairn|\.beads)(\/|$)/.test(candidate)
}

function inScope(scopePaths: readonly string[], file: string): boolean {
  if (file === "" || file.startsWith("/") || file.endsWith("/") || file.split("/").includes("..")) return false
  for (const pattern of scopePaths) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2)
      if (file === base || file.startsWith(`${base}/`)) return true
    } else if (file === pattern) return true
  }
  return false
}

function isImplementerRole(role: string): boolean {
  const kind = kindOf(role)
  if (kind.ok) return kind.kind === "implementer"
  return role.toLowerCase().includes("implementer")
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

async function findPlanForTask(root: string, taskID: string): Promise<string | undefined> {
  const dir = path.join(root, "tasks")
  const entries = await readdir(dir).catch(() => [])
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue
    const graph = await readJson<{ tasks?: Record<string, unknown> }>(path.join(dir, name))
    if (graph?.tasks !== undefined && Object.hasOwn(graph.tasks, taskID)) return name.slice(0, -5)
  }
  return undefined
}

async function listRuns(root: string): Promise<RunRecord[]> {
  const dir = path.join(root, "runs")
  const entries = await readdir(dir).catch(() => [])
  const out: RunRecord[] = []
  for (const name of entries) {
    if (name.startsWith(".")) continue
    const record = await readJson<RunRecord>(path.join(dir, name, "run.json"))
    if (record !== undefined && typeof record.id === "string") out.push(record)
  }
  return out
}

async function readChecks(root: string, runID: string): Promise<Check[]> {
  const data = await readJson<Check[]>(path.join(root, "runs", runID, "checks.json"))
  return data ?? []
}

function parsePorcelain(out: string): string[] {
  const trimmed = out.trim()
  if (trimmed === "") return []
  const files: string[] = []
  for (const line of trimmed.split("\n")) {
    if (line.trim() === "") continue
    const match = /^(.{1,2}) (.+)$/.exec(line)
    if (match === null) continue
    const raw = match[2]?.trim() ?? ""
    if (raw === "") continue
    const arrow = raw.indexOf(" -> ")
    const picked = arrow < 0 ? raw : raw.slice(arrow + 4).trim()
    if (picked === "") continue
    files.push(picked.length >= 2 && picked.startsWith('"') && picked.endsWith('"') ? picked.slice(1, -1) : picked)
  }
  files.sort()
  return files
}

async function firstLogLine(outputPath: string | undefined): Promise<string> {
  if (outputPath === undefined) return "failed"
  const log = await readFile(outputPath, "utf8").catch(() => "")
  const first = log.split("\n").find((line) => line.trim().length > 0) ?? ""
  if (first.trim() === "") return "failed"
  return first.trim().slice(0, 300)
}

async function loadCommits(worktree: string, base: string): Promise<Array<{ sha: string; subject: string }>> {
  if (base === "") return []
  const out = await git(worktree, ["log", "--format=%H%x1f%s", `${base}..HEAD`]).catch(() => "")
  if (out.trim() === "") return []
  const commits: Array<{ sha: string; subject: string }> = []
  for (const line of out.split("\n")) {
    if (line === "") continue
    // Unit separator, matching %x1f in the git format above.
    const sep = line.indexOf(String.fromCharCode(31))
    if (sep < 0) continue
    const sha = line.slice(0, sep)
    if (!/^[0-9a-f]{40}$/.test(sha)) continue
    commits.push({ sha, subject: line.slice(sep + 1) })
  }
  return commits
}

// Walk a working attempt to finishing so finish can mark it terminal. Only
// the queued → admitted → streaming → finishing chain is legal here; a
// terminal attempt is refused before this runs.
function finishAttempt(record: RunRecord): RunRecord {
  const last = record.attempts[record.attempts.length - 1]
  if (last === undefined) return record
  let next = record
  if (last.state === "queued") next = attemptTransition(next, "admitted", "admit")
  const admitted = next.attempts[next.attempts.length - 1]
  if (admitted !== undefined && admitted.state === "admitted") next = attemptTransition(next, "streaming", "first_event")
  const streaming = next.attempts[next.attempts.length - 1]
  if (streaming !== undefined && streaming.state === "streaming") next = attemptTransition(next, "finishing", "finish")
  return next
}

async function latestReport(root: string, runID: string): Promise<{ n: number; jsonPath: string; data: Record<string, unknown> } | undefined> {
  const dir = path.join(root, "runs", runID)
  const entries = await readdir(dir).catch(() => [])
  let best: { n: number; jsonPath: string; data: Record<string, unknown> } | undefined
  for (const name of entries) {
    const match = /^report-([0-9]+)\.json$/.exec(name)
    if (match === null) continue
    const data = await readJson<Record<string, unknown>>(path.join(dir, name))
    if (data === undefined) continue
    const n = Number(match[1])
    if (best === undefined || n > best.n) best = { n, jsonPath: path.join(dir, name), data }
  }
  return best
}

async function reportDisplayPath(root: string, runID: string, stored: { n: number; jsonPath: string }): Promise<string> {
  const md = path.join(root, "runs", runID, `report-${stored.n}.md`)
  const exists = await readFile(md, "utf8").then(
    () => true,
    () => false,
  )
  if (exists) return md
  return stored.jsonPath
}

async function taskStateOf(root: string, taskID: string): Promise<string | null> {
  const dir = path.join(root, "tasks")
  const entries = await readdir(dir).catch(() => [])
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue
    const graph = await readJson<{ tasks?: Record<string, { state?: unknown }> }>(path.join(dir, name))
    const task = graph?.tasks?.[taskID]
    if (task !== undefined && typeof task.state === "string") return task.state
  }
  return null
}

async function siblingsOf(root: string, taskID: string): Promise<Array<{ task: string; paths: string[]; state: string }>> {
  const dir = path.join(root, "tasks")
  const entries = await readdir(dir).catch(() => [])
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue
    const graph = await readJson<{ tasks?: Record<string, { paths?: unknown; state?: unknown }> }>(path.join(dir, name))
    const tasks = graph?.tasks
    if (tasks === undefined || tasks[taskID] === undefined) continue
    return Object.entries(tasks)
      .filter(([id]) => id !== taskID)
      .flatMap(([id, task]): Array<{ task: string; paths: string[]; state: string }> => {
        if (typeof task.state !== "string") return []
        const paths = Array.isArray(task.paths) ? task.paths.filter((entry): entry is string => typeof entry === "string") : []
        return [{ task: id, paths, state: task.state }]
      })
  }
  return []
}

async function statusOf(root: string, id: string) {
  const record = await loadRun(root, id)
  if (record === undefined) throw toolError("E_UNKNOWN_RUN", `Run ${id} not found in this namespace.`, "a run id from list{}")
  const last = record.attempts[record.attempts.length - 1]
  const assigned = await readChecks(root, id)
  // Live worktree reads with stored fallbacks, so a parent sees the child's
  // current commit even when the child's record lags behind.
  const head = await git(record.directory, ["rev-parse", "HEAD"]).catch(() => record.head)
  const porcelain = await git(record.directory, ["status", "--porcelain"]).catch(() => "")
  const checks = []
  for (const checkDef of assigned) {
    const receipt = await lastReceipt(root, id, checkDef.id)
    // Dirty-tree (or pre-flag) receipts never read as present at HEAD.
    const atHead = receipt !== undefined && receipt.head === head && isCleanReceipt(receipt)
    checks.push({ id: checkDef.id, passed: receipt?.passed ?? null, atHead })
  }
  const stored = await latestReport(root, id)
  const taskState = record.task === null ? null : await taskStateOf(root, record.task)
  const exhaustion = budgetExhaustion(record)
  return {
    run: record.id,
    role: record.role,
    state: record.state,
    attempt: last?.n ?? 0,
    attemptState: last?.state ?? "queued",
    task: record.task,
    taskState,
    head,
    base: record.base,
    dirty: porcelain.trim().length > 0,
    branch: record.branch,
    checks,
    report:
      stored === undefined
        ? null
        : {
            status: typeof stored.data.status === "string" ? stored.data.status : "unknown",
            summary: typeof stored.data.summary === "string" ? stored.data.summary : "",
            needs: Array.isArray(stored.data.needs) ? stored.data.needs : [],
            path: await reportDisplayPath(root, id, stored),
          },
    children: [...record.children],
    parent: record.parent,
    budget: {
      turnsUsed: record.attempts.length,
      turns: record.budget.turns ?? 0,
      tokensUsed: 0,
      tokens: record.budget.tokens ?? 0,
      overBy: exhaustion.overBy,
      exhausted: exhaustion.exhausted,
    },
  }
}

function isSettled(record: RunRecord, until: "settled" | "idle"): boolean {
  if (until === "idle") return record.state === "idle"
  const last = record.attempts[record.attempts.length - 1]
  if (last === undefined) return false
  return isAttemptTerminal(last.state)
}

async function settledIds(root: string, ids: readonly string[], until: "settled" | "idle"): Promise<string[]> {
  const out: string[] = []
  for (const id of ids) {
    const record = await loadRun(root, id)
    if (record !== undefined && isSettled(record, until)) out.push(id)
  }
  return out
}

async function waitReport(root: string, runID: string, attempt: number): Promise<{ status: string; summary: string; path: string } | null> {
  const jsonPath = path.join(root, "runs", runID, `report-${attempt}.json`)
  const data = await readJson<Record<string, unknown>>(jsonPath)
  if (data === undefined) return null
  if (typeof data.status !== "string" || typeof data.summary !== "string") return null
  return { status: data.status, summary: data.summary, path: jsonPath }
}

async function overBudgetIds(root: string, ids: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const id of ids) {
    const record = await loadRun(root, id)
    if (record !== undefined && budgetExhaustion(record).exhausted) out.push(id)
  }
  return out
}

async function waitResult(root: string, callerID: string, runs: readonly string[], settled: readonly string[], until: "settled" | "idle") {
  const entries: Array<{ run: string; attemptState: string; report: { status: string; summary: string; path: string } | null }> = []
  for (const id of settled) {
    const record = await loadRun(root, id)
    const last = record?.attempts[record.attempts.length - 1]
    entries.push({ run: id, attemptState: last?.state ?? "queued", report: last === undefined ? null : await waitReport(root, id, last.n) })
    // Waiting acknowledges owned outcomes so the sweeper stops re-nudging.
    if (record !== undefined && record.parent === callerID)
      await atomicJson(path.join(root, "runs", id, "ack.json"), {
        by: callerID,
        attempt: last?.n ?? 0,
        attemptState: last?.state ?? "queued",
        at: new Date().toISOString(),
        until,
      })
  }
  const done = new Set(settled)
  return {
    settled: entries,
    timedOut: false,
    stillOpen: runs.filter((id) => !done.has(id)),
    overBudget: await overBudgetIds(root, runs),
  }
}
