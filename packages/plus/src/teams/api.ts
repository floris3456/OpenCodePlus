// Team tool handlers. Every method here is a real implementation and every
// one of them is registered: the namespace advertises nothing that cannot
// work, so there is no E_NOT_IMPLEMENTED path left.
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
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Effect, Option, Schema } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { Release } from "../release/identity.js"
import type { PlusState } from "../index.js"
import { execute, isCleanReceipt, lastReceipt, receiptsAt, run, stale, verifyReceipt } from "./checks.js"
import { reconcile } from "./lifecycle.js"
import { followupHandler } from "./api-followup.js"
import { setChecksHandler } from "./api-git-ops.js"
import { integrateHandler } from "./api-integrate.js"
import { stopHandler, supersedeHandler } from "./api-lifecycle.js"
import { listHandler } from "./api-query.js"
import { git, gitRaw, parsePorcelain } from "./git.js"
import { peek } from "./inbox.js"
import { wildcardMatch } from "../instructions/permission-catalog.js"
import type { PermissionTable } from "../instructions/permission-enforce.js"
import type { TeamTool } from "./policy.js"
import { allows, bound, delegationTargets, mayDelegate, mayReach, relationOf, row } from "./reach.js"
import { render } from "./report.js"
import {
  attemptTransition,
  isAttemptTerminal,
  loadRun,
  newRunID,
  occupiesSlot,
  saveRun,
  startAttempt,
  toFinishing,
  transition,
  type AttemptRecord,
  type RunRecord,
} from "./run.js"
import {
  Brief,
  CheckInput,
  CheckpointInput,
  DiffInput,
  FollowupInput,
  GetContextInput,
  Head,
  IntegrateInput,
  ListInput,
  ModelIdentity,
  Policy,
  Report,
  RunAck,
  RunID,
  SetChecksInput,
  StatusInput,
  StopInput,
  SupersedeInput,
  WaitInput,
  budgetExhaustion,
  toolError,
  validateChecks,
  validateSummary,
  type Check,
} from "./schema.js"
import { atomicJson, lock, readJson, sanitizeLockKey } from "./store.js"
import { addAdhoc, claim } from "./tasks.js"
import { provision, slug, NO_REPOSITORY_PROGRAMS } from "./worktree.js"

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
  readonly delegate: (input: Brief, caller: TeamCaller) => Promise<TeamApiResult>
  readonly finish: (input: Report, caller: TeamCaller) => Promise<TeamApiResult>
  readonly followup: (input: FollowupInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly integrate: (input: IntegrateInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly checkpoint: (input: CheckpointInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly set_checks: (input: SetChecksInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly supersede: (input: SupersedeInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly stop: (input: StopInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly status: (input: StatusInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly wait: (input: WaitInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly diff: (input: DiffInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly list: (input: ListInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly get_context: (input: GetContextInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly check: (input: CheckInput, caller: TeamCaller) => Promise<TeamApiResult>
}

// Policy file loading lands later; effort budgets come from the schema
// defaults. Delegation bounds are the caller's Limits rows.
const policy = Schema.decodeUnknownSync(Policy)({})

const PATHS_MESSAGE =
  "scope.paths must be files or dir/* inside the repository, never version-control state."
const PATHS_ACCEPTED = ["packages/plus/src/*", "packages/plus/test/*"]
const MESSAGE_ACCEPTED = "fix: apply agent filter in query"
const COMMIT_MESSAGE_RE = /^(feat|fix|docs|chore|refactor|test)(\([^)]+\))?: /

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
  return {
    delegate: (input, caller) => guarded(() => delegateHandler(ctx, state, input, caller)),
    finish: (input, caller) => guarded(() => finishHandler(input, caller, state.permissions)),
    followup: (input, caller) => guarded(() => followupHandler(ctx, input, caller, state.permissions)),
    integrate: (input, caller) => guarded(() => integrateHandler(ctx, input, caller, state.permissions)),
    checkpoint: (input, caller) => guarded(() => checkpointHandler(input, caller)),
    set_checks: (input, caller) => guarded(() => setChecksHandler(input, caller)),
    supersede: (input, caller) => guarded(() => supersedeHandler(ctx, input, caller, state.permissions)),
    stop: (input, caller) => guarded(() => stopHandler(ctx, input, caller, state.permissions)),
    status: (input, caller) => guarded(() => statusHandler(input, caller, state.permissions)),
    wait: (input, caller) => guarded(() => waitHandler(ctx, input, caller, state.permissions)),
    diff: (input, caller) => guarded(() => diffHandler(input, caller, state.permissions)),
    list: (input, caller) => guarded(() => listHandler(input, caller, state.permissions)),
    get_context: (input, caller) => guarded(() => getContextHandler(input, caller, state.permissions)),
    check: (input, caller) => guarded(() => checkHandler(input, caller, state.permissions)),
  }
}

function toDelegateModelRef(wanted: { readonly providerID: string; readonly modelID: string; readonly variant?: string }): Model.Ref {
  return Model.Ref.make({
    providerID: Provider.ID.make(wanted.providerID),
    id: Model.ID.make(wanted.modelID),
    ...(wanted.variant === undefined ? {} : { variant: Model.VariantID.make(wanted.variant) }),
  })
}

async function delegateHandler(ctx: Context, state: PlusState, brief: Brief, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const parent = stored ?? caller.run

  // Who may delegate to whom is the caller's "Delegate to" rows (Permissions
  // of team_delegate), which a member preset sets and every level can change.
  // A brief may name only a member of an enabled team.
  const table = state.permissions
  const agent = caller.agent
  const accepted = delegationTargets(table, agent)
  const acceptedLine = accepted.length > 0 ? `You may delegate to: ${accepted.join(", ")}.` : "No member is open to you for delegation."
  const acceptedRole = accepted.length > 0 ? { role: accepted[0] } : undefined
  if (accepted.length === 0 && !allows(table, agent, "delegate", "to.other-teams"))
    return fail("E_ROLE", `${agent} may not delegate. ${acceptedLine}`)
  // A delegated run delegates further only while its member's Access row
  // "Delegate from a delegated run" is on.
  if (parent.parent !== null && !allows(table, agent, "delegate", "access.delegated"))
    return fail("E_ROLE", `${agent}: ${messageOf(table, agent, "delegate", "access.delegated")}`, `report blocked with needs=[{kind:"decision"}]`)
  if (typeof brief.role !== "string" || brief.role.length === 0 || table === undefined || !table.teamMembers.has(brief.role))
    return fail("E_ROLE", `"${brief.role}" is not a member of an enabled team. ${acceptedLine}`, acceptedRole)
  if (!mayDelegate(table, agent, brief.role))
    return fail("E_ROLE", `${agent} may not delegate to "${brief.role}". ${acceptedLine}`, acceptedRole)
  const maxDepth = bound(table, agent, "delegate", "limits.depth")
  if (maxDepth !== undefined && (await depthOf(root, parent)) >= maxDepth)
    return fail(
      "E_ROLE",
      `Depth limit ${maxDepth} reached; this run cannot delegate. Report blocked with needs=[{kind:"decision",...}] instead.`,
      `report blocked with needs=[{kind:"decision"}]`,
    )

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
  const refused = briefRefusal(table, brief)
  if (refused !== undefined) return refused

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
  const inFlightLimit = bound(table, agent, "delegate", "limits.inflight")
  if (inFlightLimit !== undefined && inFlight.length >= inFlightLimit)
    return fail(
      "E_BOUNDS",
      `In-flight limit ${inFlightLimit} reached (${inFlight.join(", ")}). Wait for a child to settle (tools.team.wait) first.`,
      "call wait first",
    )
  const membersLimit = bound(table, agent, "delegate", "limits.members")
  if (membersLimit !== undefined && live.length >= membersLimit) {
    const all = live.map((record) => record.id).toSorted()
    return fail(
      "E_BOUNDS",
      `Live team runs limit ${membersLimit} reached (${all.join(", ")}). Wait for a run to settle (tools.team.wait) first.`,
      "call wait first",
    )
  }

  const signature = signatureOf(brief)
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
  const briefLimit = bound(table, agent, "delegate", "limits.brief")
  if (briefLimit !== undefined && briefChars > briefLimit)
    return fail(
      "E_TOO_LONG",
      `Brief text is ${briefChars} chars (max ${briefLimit}). Move long material into a file and pass briefFile.`,
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

  // The worktree is created and its starting child run registered in one
  // repository-lock hold. Creating the session activates Plus in the new
  // worktree, and the periodic sweep collects any worktree no run record
  // claims as an orphan; a record saved after the sweep's decision leaves a
  // window in which this worktree is removed before the host's
  // FileSystem.realPath resolves it. `provision` closes that window: the
  // sweep takes the same lock and re-lists records inside it. Activation has
  // no session id yet, so this record is found by directory (run.byDirectory)
  // and names the project directory it inherits.
  const now = new Date().toISOString()
  const { created, value: streaming } = await provision(
    root,
    {
      repoRoot: repo.root,
      repoKey: repo.key,
      role: brief.role,
      name: slug(taskID ?? brief.requestID, childID),
      base: baseSha,
      workspaceRoot: root,
    },
    async (worktree) => {
      const opened = startAttempt(
        {
          id: childID,
          role: brief.role,
          kind: "w",
          repo: repo.key,
          repoKey: repo.key,
          directory: worktree.dir,
          paths: [...paths],
          branch: worktree.branch,
          base: baseSha,
          head: worktree.head,
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
          sessionID: null,
          // The child worktree is outside the parent's tree and carries no
          // copied project.json; its session activates Plus through this
          // directory.
          projectDirectory: parent.projectDirectory ?? parent.directory,
          configDigest: null,
          history: [],
        },
        { trigger: "delegate" },
      )
      const admitted = attemptTransition(opened, "admitted", "admit")
      const registered = attemptTransition(admitted, "streaming", "first_event")
      await saveRun(root, registered)
      return registered
    },
  )

  // The child run is a session in this same process, created directly in its
  // worktree; no session.move is needed.
  const sessions = ctx.session
  const directory = AbsolutePath.make(created.dir)
  const location =
    ctx.location.workspaceID === undefined
      ? Location.Ref.make({ directory })
      : Location.Ref.make({ directory, workspaceID: ctx.location.workspaceID })
  const child = await Effect.runPromise(sessions.create({ agent: Agent.ID.make(brief.role), location })).catch(
    async (error) => {
      // The session never started. The pre-registered run would otherwise
      // claim a bounds slot forever (reconcile skips records with no session
      // id), so retire it before surfacing the host failure.
      await saveRun(root, transition(streaming, "superseded", "supersede", { reason: "session creation failed" })).catch(
        () => undefined,
      )
      throw error
    },
  )
  // The session id is what the parent's tool calls resolve the child by.
  await saveRun(root, { ...streaming, sessionID: String(child.id) })

  // The child's edit scope is an instructions row derived from this record,
  // so the record must be published before the child is prompted. Asking the
  // host to reload agents republishes Plus through the same event a file edit
  // uses; a host without the seam just ignores it.
  await Effect.runPromise(ctx.agent.reload().pipe(Effect.ignore))

  const latest = await loadRun(root, parent.id)
  if (latest !== undefined && !latest.children.includes(childID))
    await saveRun(root, { ...latest, children: [...latest.children, childID], lastUsed: now }).catch(() => undefined)

  const runDir = path.join(root, "runs", childID)
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, "brief.md"), rendered, "utf8")
  await atomicJson(path.join(runDir, "brief.json"), brief)
  await atomicJson(path.join(runDir, "checks.json"), [...brief.checks])

  const wanted = state.activeModels.get(brief.role)
  if (wanted !== undefined) {
    try {
      await Effect.runPromise(sessions.switchModel({ sessionID: child.id, model: toDelegateModelRef(wanted) }))
    } catch (err) {
      await saveRun(root, transition(streaming, "superseded", "supersede", { reason: "model switch failed" })).catch(
        () => undefined,
      )
      throw toolError(
        "E_MODEL",
        `Required model switch to ${wanted.providerID}/${wanted.modelID} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  let sessionInfo: unknown
  if (typeof sessions.get === "function") {
    try {
      sessionInfo = await Effect.runPromise(sessions.get({ sessionID: child.id }))
    } catch {
      sessionInfo = undefined
    }
  }
  const currentModel =
    sessionInfo && typeof sessionInfo === "object" && "model" in sessionInfo
      ? (sessionInfo as { model?: { providerID?: unknown; id?: unknown; variant?: unknown } }).model
      : undefined

  if (wanted !== undefined && currentModel !== undefined && currentModel !== null) {
    const curProvider = String(currentModel.providerID ?? "")
    const curModelId = String(currentModel.id ?? "")
    const curVariant =
      currentModel.variant !== undefined && currentModel.variant !== null ? String(currentModel.variant) : undefined
    const mismatch =
      curProvider !== wanted.providerID ||
      curModelId !== wanted.modelID ||
      (wanted.variant !== undefined && curVariant !== wanted.variant)
    if (mismatch) {
      await saveRun(root, transition(streaming, "superseded", "supersede", { reason: "host resolved different model" })).catch(
        () => undefined,
      )
      throw toolError(
        "E_MODEL",
        `Required model ${wanted.providerID}/${wanted.modelID} could not be satisfied; host resolved ${curProvider}/${curModelId}.`,
      )
    }
  }

  const requestedModel: ModelIdentity | null = wanted
    ? {
        providerID: wanted.providerID,
        modelID: wanted.modelID,
        ...(wanted.variant !== undefined ? { variant: wanted.variant } : {}),
      }
    : null

  const loadedModel: ModelIdentity | null = currentModel
    ? {
        providerID: String(currentModel.providerID ?? ""),
        modelID: String(currentModel.id ?? ""),
        ...(currentModel.variant !== undefined && currentModel.variant !== null ? { variant: String(currentModel.variant) } : {}),
      }
    : requestedModel

  const resolvedModel: ModelIdentity | null = loadedModel
  const instructionsHash = Release.digest(rendered)
  const configDigest = Release.digest({
    role: brief.role,
    scope: brief.scope,
    checks: brief.checks,
    budget: { turns: budget.turns, tokens: budget.tokens, wallMs: budget.wallMs },
  })

  const childRecord = (await loadRun(root, childID)) ?? streaming
  const lastAttempt = childRecord.attempts[childRecord.attempts.length - 1]
  const updatedAttempt: AttemptRecord = {
    ...lastAttempt,
    requestedModel,
    loadedModel,
    resolvedModel,
    instructionsHash,
    configDigest,
  }
  const updatedChild: RunRecord = {
    ...childRecord,
    sessionID: String(child.id),
    requestedModel,
    loadedModel,
    resolvedModel,
    instructionsHash,
    configDigest,
    attempts: [...childRecord.attempts.slice(0, -1), updatedAttempt],
  }
  await saveRun(root, updatedChild)

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
    requestedModel,
    loadedModel,
    resolvedModel,
    instructionsHash,
    configDigest,
  }
  await atomicJson(requestPath, { signature, output, run: childID })
  return succeeded(output)
}

async function finishHandler(args: Report, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
  const root = teamsDataDir()
  validateSummary(args.summary)
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
  const head = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
  const tree = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD^{tree}"])
  const porcelain = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"])
  const dirtyFiles = parsePorcelain(porcelain)

  // Compound behaviour: assigned checks with no receipt at HEAD run now,
  // through the same executor as team_check, before any gate judges them.
  const missing = await stale(root, assigned, stored.id, head)
  for (const checkDef of missing) await execute(root, { runID: stored.id, check: checkDef, worktree })

  const done = args.status === "done" || args.status === "done_with_concerns"
  if (done && allows(table, stored.role, "finish", "requirements.checks")) {
    const receipts = await receiptsAt(root, stored.id, head)
    const byId = new Map(receipts.map((receipt) => [receipt.id, receipt] as const))
    const red: string[] = []
    const firstLines = new Map<string, string>()
    for (const checkDef of assigned) {
      const receipt = byId.get(checkDef.id)
      const verified = receipt !== undefined ? verifyReceipt(receipt, checkDef, { head, tree }) : null
      if (receipt !== undefined && receipt.passed && verified?.ok) continue
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

  if (args.status === "done" && allows(table, stored.role, "finish", "requirements.clean") && dirtyFiles.length > 0)
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

  const commits = await loadCommits(worktree, stored.base)
  if (done && allows(table, stored.role, "finish", "requirements.commit")) {
    const assignedBrief = await readJson<{ deliverable?: { kind?: string } }>(path.join(root, "runs", stored.id, "brief.json"))
    if (assignedBrief?.deliverable?.kind === "commit" && commits.length === 0)
      return fail(
        "E_NO_COMMIT",
        `This run's deliverable is a commit and it has none since ${stored.base}. Call team_checkpoint first, or finish blocked with needs=[{kind:"info",...}].`,
        { status: "blocked", needs: [{ kind: "info", detail: "why nothing was committed" }] },
      )
  }
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
  const moved = attemptTransition(toFinishing(fresh), terminal, "validated")
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

async function checkpointHandler(args: CheckpointInput, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const record = stored ?? caller.run
  const key = await realpath(record.directory).catch(() => record.directory)
  return lock(root, "wt", key, async () => {
    const head = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
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
    const stagedOut = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "diff", "--cached", "--name-only"])
    const staged = stagedOut
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const wanted = new Set(args.files)
    const offenders = staged.filter((line) => !wanted.has(line))
    if (offenders.length > 0)
      return fail("E_STAGED", `Index has staged changes [${offenders.join(", ")}] not in files[]; include them or unstage.`)
    const status = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "--", ...args.files])
    if (status.trim() === "") return succeeded({ head, committed: false })
    // Ref-writing git ops serialize per repository, like the reference.
    const committed = await lock(root, "repo", record.repoKey, async () => {
      await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "add", "--", ...args.files])
      const cached = await gitRaw(record.directory, [...NO_REPOSITORY_PROGRAMS, "diff", "--cached", "--quiet"])
      if (cached.code === 0) return false
      await git(record.directory, [
        ...NO_REPOSITORY_PROGRAMS,
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
      const current = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
      return succeeded({ head: current, committed: false })
    }
    const sha = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
    const subject = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "log", "-1", "--format=%s"])
    const fresh = (await loadRun(root, record.id)) ?? record
    await saveRun(root, { ...fresh, head: sha, lastUsed: new Date().toISOString() })
    return succeeded({ head: sha, committed: true, sha, subject })
  })
}

async function statusHandler(args: StatusInput, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const self = stored ?? caller.run
  const all = await listRuns(root)
  const ids = args.runs ?? [self.id, ...all.filter((record) => record.parent === self.id).map((record) => record.id)]
  for (const id of ids) {
    const target = await loadRun(root, id)
    if (target === undefined) continue
    if (!mayReach(table, caller.agent, "status", await relationOf(root, self, target)))
      return fail("E_NOT_VISIBLE", `Run ${id} is outside what team_status may read for ${caller.agent} (Permissions → Runs).`, self.id)
  }
  const entries = []
  for (const id of ids) entries.push(await statusOf(root, id))
  return succeeded(entries)
}

async function waitHandler(ctx: Context, args: WaitInput, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const timeoutMs = args.timeoutMs ?? 60000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10000)
    return fail("E_TIMEOUT_MIN", `timeoutMs ${String(args.timeoutMs)} is below the 10000ms floor.`, { timeoutMs: 10000 })
  const until = args.until ?? "settled"
  const ack = args.ack ?? true
  const self = (await loadRun(root, caller.run.id)) ?? caller.run
  for (const id of args.runs) {
    const target = await loadRun(root, id)
    if (target === undefined)
      return fail("E_NOT_VISIBLE", `Run ${id} is not in this namespace.`, "a run id from list{}")
    if (!mayReach(table, caller.agent, "wait", await relationOf(root, self, target)))
      return fail("E_NOT_VISIBLE", `Run ${id} is outside what team_wait may wait on for ${caller.agent} (Permissions → Runs).`, self.id)
  }
  const settledNow = await settledIds(root, args.runs, until)
  if (settledNow.length > 0) return succeeded(await waitResult(root, caller.run.id, args.runs, settledNow, until, ack))
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
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await new Promise((resolve) => {
          timer = setTimeout(resolve, Math.min(150, remaining))
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          ...racers,
          new Promise((resolve) => {
            timer = setTimeout(resolve, remaining)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    const settled = await settledIds(root, args.runs, until)
    if (settled.length > 0) return succeeded(await waitResult(root, caller.run.id, args.runs, settled, until, ack))
    let pauseTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise((resolve) => {
        pauseTimer = setTimeout(resolve, Math.min(150, Math.max(deadline - Date.now(), 0)))
      })
    } finally {
      if (pauseTimer !== undefined) clearTimeout(pauseTimer)
    }
  }
  const settled = await settledIds(root, args.runs, until)
  if (settled.length > 0) return succeeded(await waitResult(root, caller.run.id, args.runs, settled, until, ack))
  await Effect.runPromise(Effect.promise(() => reconcile(ctx, root)).pipe(Effect.ignore))
  const resettled = await settledIds(root, args.runs, until)
  if (resettled.length > 0) return succeeded(await waitResult(root, caller.run.id, args.runs, resettled, until, ack))
  return succeeded({
    settled: [],
    acknowledged: [],
    timedOut: true,
    stillOpen: [...args.runs],
    overBudget: await overBudgetIds(root, args.runs),
  })
}

async function getContextHandler(_args: GetContextInput, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const record = stored ?? caller.run
  const raw = await readJson<unknown>(path.join(root, "runs", record.id, "brief.json"))
  const isRoot = record.kind === "main" || record.parent === null || record.id.startsWith("main-")
  if (raw === undefined && !isRoot)
    throw toolError("E_NO_BRIEF", `Run ${record.id} has no stored brief (runs/${record.id}/brief.json).`, { run: record.id })
  let brief: Brief | null = null
  if (raw !== undefined) {
    const briefParsed = Schema.decodeUnknownOption(Brief)(raw)
    if (Option.isNone(briefParsed))
      throw toolError("E_NO_BRIEF", `Run ${record.id} has an unreadable brief.`, {
        run: record.id,
      })
    brief = briefParsed.value
  }
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
  const siblings =
    record.task === null || !allows(table, record.role, "get_context", "contents.siblings") ? [] : await siblingsOf(root, record.task)
  const pending = await peek(root, record.id)
  const briefPath = brief === null ? null : path.join(root, "runs", record.id, "brief.md")
  const scope =
    brief === null
      ? { paths: [...record.paths], forbidden: [] }
      : { paths: [...brief.scope.paths], forbidden: [...brief.scope.forbidden] }
  const interfaces = brief === null ? [] : [...brief.context.interfaces]
  const decisions = brief === null ? [] : [...brief.context.decisions]
  return succeeded({
    run: record.id,
    role: record.role,
    task: record.task,
    directory: record.directory,
    branch: record.branch,
    base: record.base,
    head: record.head,
    brief,
    briefPath,
    scope,
    checks,
    interfaces,
    decisions,
    siblings,
    budget: {
      turns: record.budget.turns ?? null,
      tokens: record.budget.tokens ?? null,
      wallMs: record.budget.wallMs ?? null,
      used: { turns: record.attempts.length },
    },
    inbox: pending.map((item) => ({ id: item.id, from: item.from, kind: item.kind, text: item.text })),
  })
}

// Read-only `git diff` of a run the caller can see: its own worktree or one
// of its children's. Nothing is written, no ref moves, and a large patch is
// truncated to maxBytes with truncated:true so a diff can never flood the
// context. Visibility is the same rule wait and integrate use — self or an
// owned child — so a run can never read a stranger's worktree.
const DIFF_MAX_BYTES = 200_000

async function diffHandler(args: DiffInput, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const self = (await loadRun(root, caller.run.id)) ?? caller.run
  const target = args.run === self.id ? self : await loadRun(root, args.run)
  if (target === undefined) return fail("E_NOT_VISIBLE", `Run ${args.run} is not in this namespace.`, "a run id from list{}")
  if (!mayReach(table, caller.agent, "diff", await relationOf(root, self, target)))
    return fail("E_NOT_VISIBLE", `Run ${args.run} is neither your run nor one of your children.`, self.id)
  const from = await diffFrom(root, target, args.from)
  const maxBytes = args.maxBytes === undefined || args.maxBytes <= 0 ? DIFF_MAX_BYTES : Math.trunc(args.maxBytes)
  const paths = args.paths ?? []
  // A generated patch is the one diff output that runs a program named by
  // repository config (`diff.external`) or a `.gitattributes` diff driver
  // (`command`/`textconv`), so both opt-outs travel with this call.
  const result = await gitRaw(target.directory, [
    ...NO_REPOSITORY_PROGRAMS,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    from,
    ...(paths.length === 0 ? [] : ["--", ...paths]),
  ])
  if (result.code !== 0)
    return fail("E_INTERNAL", `git diff ${from} failed in ${target.directory}: ${result.err || result.out || "unknown error"}`)
  const bytes = Buffer.byteLength(result.out, "utf8")
  const truncated = bytes > maxBytes
  const head = await git(target.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"]).catch(() => target.head)
  return succeeded({
    run: target.id,
    from,
    head,
    bytes,
    truncated,
    patch: truncated ? Buffer.from(result.out, "utf8").subarray(0, maxBytes).toString("utf8") : result.out,
  })
}

async function diffFrom(root: string, target: RunRecord, from: DiffInput["from"]): Promise<string> {
  if (from === undefined || from === "base") return target.base
  if (from !== "parent") return from
  if (target.parent === null) return target.base
  const parent = await loadRun(root, target.parent)
  return parent?.head ?? target.base
}

async function checkHandler(args: CheckInput, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const record = stored ?? caller.run
  const assigned = await readChecks(root, record.id)
  // Checks it may run (Permissions of team_check): a test-file check or a
  // package-script check this member's rows turned off is refused before it
  // runs, with the report that says what to do instead.
  const assignedCheck = assigned.find((entry) => entry.id === args.id)
  const family = assignedCheck?.argv[1] === "test" ? "checks.tests" : assignedCheck?.argv[1] === "run" ? "checks.scripts" : undefined
  if (family !== undefined && !allows(table, record.role, "check", family))
    return fail(
      "E_PERMISSION",
      `${record.role} may not run ${family === "checks.tests" ? "test-file" : "package-script"} checks here (Permissions → Checks it may run). Finish with needs=[{kind:"check",...}] instead.`,
      { status: "blocked", needs: [{ kind: "check", detail: args.id }] },
    )
  try {
    return succeeded(await run(root, record.id, args.id, assigned, record.directory))
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
    const top = await gitRaw(parent.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--show-toplevel"])
    if (top.code !== 0) throw new Error(`Cannot resolve repository from ${parent.directory}: ${top.err || top.out || "unknown error"}`)
    return { key: parent.repoKey, root: top.out }
  }
  if (!path.isAbsolute(raw)) return undefined
  const top = await gitRaw(raw, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--show-toplevel"])
  if (top.code !== 0) return undefined
  return { key: path.basename(top.out), root: top.out }
}

async function callerHead(callerDir: string, repoRoot: string): Promise<string> {
  const head = await gitRaw(callerDir, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
  if (head.code === 0) return head.out
  const fallback = await gitRaw(repoRoot, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
  if (fallback.code === 0) return fallback.out
  return "unknown"
}

async function resolveBase(repoRoot: string, base: string | undefined, defaultHead: string): Promise<string | undefined> {
  if (base === undefined) return defaultHead
  const verify = await gitRaw(repoRoot, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--verify", `${base}^{commit}`])
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

// What the member a brief names accepts: its own "Briefs it accepts" and
// "Brief limits" rows (Permissions of team_get_context), read for the target,
// never for the caller. Undefined when the brief passes them all.
function briefRefusal(table: PermissionTable | undefined, brief: Brief): TeamApiResult | undefined {
  const target = brief.role
  const paths = brief.scope.paths
  const says = (id: string) => `${target} ${messageOf(table, target, "get_context", id)}`
  if (allows(table, target, "get_context", "accepts.scope-paths") && brief.deliverable.kind === "commit" && paths.length === 0)
    return fail("E_PATHS", `${says("accepts.scope-paths")} (Briefs it accepts → Scope paths for a commit).`, PATHS_ACCEPTED)
  const plans = row(table, target, "get_context", "accepts.plan-files")
  if (plans?.on === true) {
    const patterns = plans.item.patterns ?? []
    const outside = paths.filter((candidate) => !patterns.some((pattern) => wildcardMatch(candidate, pattern) || wildcardMatch(candidate, `*/${pattern}`)))
    if (outside.length > 0)
      return fail("E_PATHS", `${says("accepts.plan-files")} [${patterns.join(", ")}]; outside them: [${outside.join(", ")}].`, [...patterns])
  }
  if (allows(table, target, "get_context", "accepts.reason") && (brief.reason === undefined || brief.reason.trim() === ""))
    return fail("E_REASON", `${says("accepts.reason")} (Briefs it accepts → A reason).`, { reason: "3 independent packages, each needs its own workers" })
  if (allows(table, target, "get_context", "accepts.check") && brief.checks.length === 0)
    return fail("E_BRIEF", `${says("accepts.check")} (Briefs it accepts → A check).`, { checks: 1 })
  const maxPaths = bound(table, target, "get_context", "limits.paths")
  if (maxPaths !== undefined && paths.length > maxPaths)
    return fail("E_BRIEF", `${target} accepts at most ${maxPaths} scope paths per brief (Brief limits → Paths per brief); this brief has ${paths.length}.`, { paths: maxPaths })
  const maxChecks = bound(table, target, "get_context", "limits.checks")
  if (maxChecks !== undefined && brief.checks.length > maxChecks)
    return fail("E_BRIEF", `${target} accepts at most ${maxChecks} checks per brief (Brief limits → Checks per brief); this brief has ${brief.checks.length}.`, { checks: maxChecks })
  return undefined
}

// A team row's refusal text as the model reads it.
function messageOf(table: PermissionTable | undefined, agent: string, tool: TeamTool, id: string): string {
  return row(table, agent, tool, id)?.item.message ?? `is refused by its ${tool} row ${id}`
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

async function firstLogLine(outputPath: string | undefined): Promise<string> {
  if (outputPath === undefined) return "failed"
  const log = await readFile(outputPath, "utf8").catch(() => "")
  const first = log.split("\n").find((line) => line.trim().length > 0) ?? ""
  if (first.trim() === "") return "failed"
  return first.trim().slice(0, 300)
}

async function loadCommits(worktree: string, base: string): Promise<Array<{ sha: string; subject: string }>> {
  if (base === "") return []
  const out = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "log", "--format=%H%x1f%s", `${base}..HEAD`]).catch(() => "")
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
  const head = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"]).catch(() => record.head)
  const porcelain = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"]).catch(() => "")
  const dirtyFiles = parsePorcelain(porcelain)
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
    dirty: dirtyFiles.length > 0,
    branch: record.branch,
    // The same value `list` reports: `dirty` above is a live git read, while
    // this is the record's own account of whether the worktree still exists.
    worktree: record.worktree ?? "present",
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
    acked: await ackedAt(root, id),
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

async function waitResult(
  root: string,
  callerID: string,
  runs: readonly string[],
  settled: readonly string[],
  until: "settled" | "idle",
  ack: boolean,
) {
  const entries: Array<{ run: string; attemptState: string; report: { status: string; summary: string; path: string } | null }> = []
  const acknowledged: string[] = []
  for (const id of settled) {
    const record = await loadRun(root, id)
    const last = record?.attempts[record.attempts.length - 1]
    entries.push({ run: id, attemptState: last?.state ?? "queued", report: last === undefined ? null : await waitReport(root, id, last.n) })
    // Waiting acknowledges owned outcomes so the sweeper stops re-nudging.
    // ack:false reads the same outcomes without taking responsibility for them.
    if (ack && record !== undefined && record.parent === callerID) {
      await atomicJson(path.join(root, "runs", id, "ack.json"), {
        by: callerID,
        attempt: last?.n ?? 0,
        attemptState: last?.state ?? "queued",
        at: new Date().toISOString(),
        until,
      })
      acknowledged.push(id)
    }
  }
  const done = new Set(settled)
  return {
    settled: entries,
    acknowledged,
    timedOut: false,
    stillOpen: runs.filter((id) => !done.has(id)),
    overBudget: await overBudgetIds(root, runs),
  }
}

// status never acknowledges; it reports what wait already acknowledged, so
// the two agree on which outcomes the parent has taken responsibility for.
async function ackedAt(root: string, runID: string): Promise<{ attempt: number; at: string } | null> {
  const raw = await readJson<unknown>(path.join(root, "runs", runID, "ack.json"))
  if (raw === undefined) return null
  const parsed = Schema.decodeUnknownOption(RunAck)(raw)
  if (Option.isNone(parsed)) return null
  return { attempt: parsed.value.attempt, at: parsed.value.at }
}
