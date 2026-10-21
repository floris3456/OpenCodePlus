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
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { Effect, Option, Schema } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { Release } from "../release/identity.js"
import type { PlusState } from "../index.js"
import { checkFiles, missingCheckFiles } from "./check-files.js"
import { execute, isCleanReceipt, lastReceipt, receiptsAt, run, stale, verifyReceipt } from "./checks.js"
import { requireWorktree } from "./availability.js"
import { chatEditRefusal, isScopePath, namesProtectedState, protectedStateRefusal, runScope, scopeRefusal } from "./scope.js"
import { sessionContextTokens, sessionTokens, sessionTokenUsage } from "./usage.js"
import { followupHandler } from "./api-followup.js"
import { integrateHandler } from "./api-integrate.js"
import { stopHandler } from "./api-lifecycle.js"
import { listHandler } from "./api-query.js"
import { git, gitRaw, parsePorcelain } from "./git.js"
import { peek } from "./inbox.js"
import { wildcardMatch } from "../instructions/permission-catalog.js"
import { decide, rowState, type PermissionTable } from "../instructions/permission-enforce.js"
import type { TeamTool } from "./policy.js"
import { allows, bound, delegationTargets, mayDelegate, mayReach, relationOf, row } from "./reach.js"
import { render } from "./report.js"
import {
  attemptTransition,
  isAttemptTerminal,
  loadRun,
  newRunID,
  occupiesSlot,
  openChildren,
  saveRun,
  startAttempt,
  toFinishing,
  transition,
  type AttemptRecord,
  type BudgetHistoryEntry,
  type RunRecord,
} from "./run.js"
import {
  Brief,
  CheckInput,
  CheckpointInput,
  DiffInput,
  FollowupInput,
  GetContextInput,
  IntegrateInput,
  ListInput,
  ModelIdentity,
  Policy,
  Report,
  StatusInput,
  StopInput,
  budgetExhaustion,
  isExpectedHead,
  toolError,
  validateSummary,
  type Check,
  type Deliverable,
  type ResolvedBrief,
} from "./schema.js"
import { checksNote, readProjectChecks, resolveChecks } from "./project-checks.js"
import { atomicJson, lock, readJson, sanitizeLockKey } from "./store.js"
import { addAdhoc, claim } from "./tasks.js"
import { queue } from "./merge.js"
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
  readonly stop: (input: StopInput, caller: TeamCaller) => Promise<TeamApiResult>
  readonly status: (input: StatusInput, caller: TeamCaller) => Promise<TeamApiResult>
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
const PATHS_ACCEPTED = ["src/*", "test/*"]
const PLAN_PATHS = ["docs/plans/*", "docs/handoffs/*"]
const MESSAGE_ACCEPTED = "fix: apply agent filter in query"
const COMMIT_MESSAGE_RE = /^(feat|fix|docs|chore|refactor|test)(\([^)]+\))?: /

function succeeded(value: unknown): TeamApiResult {
  return { ok: true, value }
}

function fail(code: string, message: string, accepted?: unknown): TeamApiResult {
  if (accepted === undefined) return { ok: false, error: { code, message } }
  return { ok: false, error: { code, message, accepted } }
}

// Throwing helpers (resolveChecks, tasks.claim, checks.run, git) surface as
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
    delegate: (input, caller) => guarded(() => lock(teamsDataDir(), "state", `admission-${caller.run.id}`, () => delegateHandler(ctx, state, input, caller))),
    finish: (input, caller) => guarded(() => finishHandler(input, caller, state.permissions)),
    followup: (input, caller) => guarded(() => followupHandler(ctx, state, input, caller, state.permissions)),
    integrate: (input, caller) => guarded(() => integrateHandler(ctx, input, caller, state.permissions)),
    checkpoint: (input, caller) => guarded(() => checkpointHandler(input, caller, state.permissions)),
    stop: (input, caller) => guarded(() => stopHandler(ctx, input, caller, state.permissions)),
    status: (input, caller) => guarded(() => statusHandler(ctx, input, caller, state.permissions)),
    diff: (input, caller) => guarded(() => diffHandler(input, caller, state.permissions)),
    list: (input, caller) => guarded(() => listHandler(input, caller, state.permissions)),
    get_context: (input, caller) => guarded(() => getContextHandler(ctx, input, caller, state.permissions)),
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
  const signature = signatureOf(brief)
  const requestPath = path.join(root, "requests", `${sanitizeLockKey(parent.id)}__${sanitizeLockKey(brief.requestID)}.json`)
  const replay = await readJson<{ signature?: string; output?: Record<string, unknown>; run?: string }>(requestPath)
  if (replay?.signature !== undefined) {
    if (replay.signature !== signature)
      return fail("E_REQUEST_ID", `requestID "${brief.requestID}" was used with different arguments; reuse only to retry the identical call, else pick a new requestID.`, "pick a new requestID")
    if (replay.output !== undefined) {
      const current = replay.run === undefined ? undefined : await loadRun(root, replay.run)
      return succeeded({ ...replay.output, state: current?.state ?? null, replayed: true, receipt: replay.output, current: current === undefined ? null : { state: current.state, attempt: current.attempts.at(-1)?.n ?? 0, worktree: current.worktree } })
    }
  }
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
      `base "${brief.base}" is not a ref or commit in ${repo.key}. Omit base to use your HEAD (${defaultHead}), or pass a branch/sha. accepted: "main"`,
      "main",
    )

  // The checks a run stores are the commands they run: a project check by
  // name (the main checkout's .opencodeplus/checks.json) or a Bun command.
  let checks: Check[]
  try {
    checks = resolveChecks(brief.checks, await readProjectChecks(repo.root))
  } catch (error) {
    return { ok: false, error: thrownError(error) }
  }
  // Forbidding protected state forbids what no run may change anyway (s3-c:
  // ".opencodeplus/*" refused two whole briefs), so it is dropped, not refused.
  const forbidden = brief.scope.forbidden.filter((entry) => !namesProtectedState(entry))
  // A member that may change plan files but no other (planner, orchestrator)
  // writes its plan, Brief and handoff files there whatever source paths the
  // delegator scoped (s5-a, s5-d: an orchestrator scoped to src/ and test/ was
  // refused its handoff file). Its stored scope takes those folders unless
  // the delegator forbade them; run and task records keep the delegator's paths.
  const writesPlans = rowState(table, brief.role, "edit", "allowed.plans")?.on === true && rowState(table, brief.role, "edit", "allowed.*")?.on === false
  const planPaths = writesPlans
    ? PLAN_PATHS.filter((entry) => !brief.scope.paths.includes(entry) && scopeRefusal({ paths: [entry], forbidden }, `${entry.slice(0, -2)}/x`) === undefined)
    : []
  const resolved: ResolvedBrief = { ...brief, scope: { paths: [...brief.scope.paths, ...planPaths], forbidden }, checks }

  const paths = brief.scope.paths
  const scopeError = scopePathsRefusal(table, { ...brief, scope: { paths, forbidden } }, caller)
  if (scopeError !== undefined) return scopeError
  const refused = briefRefusal(table, brief)
  if (refused !== undefined) return refused
  // A reviewer sees the commit its worktree starts from, by default your
  // HEAD: a review delegated while a done child is unlanded reviews the code
  // without that child's change (s12-a: the reviewer found nothing to
  // review). A base that holds a child's commits reviews it before it lands
  // (s12-c: the user asked for review before landing).
  if (brief.deliverable.kind === "findings") {
    const unlanded = await unlandedDone(root, parent, repo.root, defaultHead)
    const held = await Promise.all(unlanded.map(async (run) => (await gitRaw(repo.root, [...NO_REPOSITORY_PROGRAMS, "merge-base", "--is-ancestor", run.head, baseSha])).code === 0))
    if (unlanded.length > 0 && !held.includes(true))
      return fail(
        "E_UNLANDED",
        `Your children [${unlanded.map((run) => run.id).join(", ")}] reported done but have not landed, and a reviewer sees only the commit it starts from (your HEAD). Land them with team_integrate first, or review one before it lands with base: its commit (${unlanded.map((run) => `${run.id}: ${run.head.slice(0, 12)}`).join(", ")}).`,
        { run: unlanded[0]!.id, base: unlanded[0]!.head },
      )
  }

  // A file up to the member's "Attached brief file" limit (limits.attachment,
  // default 8,000 chars) is pasted into the Brief; a larger one is named by
  // path and the child reads only what it needs.
  let attached: { path: string; content: string } | undefined
  const briefFile = brief.briefFile
  if (briefFile !== undefined) {
    // A relative briefFile is relative to the caller's checkout, the same
    // directory a shell tool in that session would start in.
    const resolvedBrief = path.resolve(parent.directory, briefFile)
    const realBrief = await realpath(resolvedBrief).catch(() => resolvedBrief)
    const callerReal = await realpath(parent.directory).catch(() => parent.directory)
    const runDir = path.join(root, "runs", parent.id)
    const runReal = await realpath(runDir).catch(() => runDir)
    const inside =
      realBrief === callerReal ||
      realBrief.startsWith(`${callerReal}${path.sep}`) ||
      realBrief === runReal ||
      realBrief.startsWith(`${runReal}${path.sep}`)
    if (!inside)
      return fail(
        "E_PATHS",
        `briefFile must be inside your checkout (${callerReal}) or this run's directory (${runReal}); got ${realBrief}.`,
        [parent.directory, runDir],
      )
    const content = await readFile(realBrief, "utf8").catch(() => undefined)
    if (content === undefined)
      return fail("E_PATHS", `briefFile ${briefFile} does not exist or cannot be read: write it first, or leave briefFile out.`, [parent.directory, runDir])
    attached = { path: briefFile, content }
  }
  const attachmentLimit = bound(table, agent, "delegate", "limits.attachment")

  const childID = newRunID("w")
  let taskID = brief.task
  if (taskID !== undefined) {
    const planRun = await findPlanForTask(root, taskID)
    if (planRun === undefined)
      return fail(
        "E_TASK_BLOCKED",
        `Task ${taskID} not found: task claims only a rework task a team_integrate returned you. Omit it for any other work.`,
        { task: null },
      )
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
      `In-flight limit ${inFlightLimit} reached (${inFlight.join(", ")}). End your turn; a settling child wakes you, then delegate.`,
      "end your turn and delegate after a child settles",
    )
  const membersLimit = bound(table, agent, "delegate", "limits.members")
  if (membersLimit !== undefined && live.length >= membersLimit) {
    const all = live.map((record) => record.id).toSorted()
    return fail(
      "E_BOUNDS",
      `Live team runs limit ${membersLimit} reached (${all.join(", ")}). End your turn; a settling child wakes you, then delegate.`,
      "end your turn and delegate after a child settles",
    )
  }

  const ifaceChars = brief.context.interfaces.reduce((n, item) => n + item.path.length + (item.symbol?.length ?? 0) + item.note.length, 0)
  const decisionChars = brief.context.decisions.reduce((n, decision) => n + decision.length, 0)
  // The brief limit counts the text the caller wrote; an attached file has
  // its own limit. Counting a pasted file too refused a 4,473-char plan with
  // 1,682 chars of Brief (s5-d), and any file of 6,000-8,000 chars whatever
  // the Brief, which no shortening could fix.
  const briefChars = brief.objective.length + (brief.prompt?.length ?? 0) + ifaceChars + decisionChars
  const briefLimit = bound(table, agent, "delegate", "limits.brief")
  if (briefLimit !== undefined && briefChars > briefLimit)
    return fail(
      "E_TOO_LONG",
      `Brief text is ${briefChars} chars (max ${briefLimit}). Shorten it: keep the outcome, the files, the decisions and the checks; move detail out of the Brief.`,
      "a shorter brief",
    )

  // A missing check file is writable only when the Brief includes it in scope.
  // This is also the checkpoint check-files row's explicit scope exception.
  const missingChecks = (await missingCheckFiles(repo.root, baseSha, checks)).filter(
    (missing) => scopeRefusal({ paths: [...paths], forbidden: [...forbidden] }, missing.file) !== undefined,
  )
  if (missingChecks.length > 0) {
    const first = missingChecks[0]!
    return fail(
      "E_CHECKS",
      `Check "${first.id}" runs bun test ${first.file}, which base ${baseSha.slice(0, 12)} does not hold and the child's scope does not allow it to write. Include the file in scope.paths without forbidding it, or use a test file the base already has.`,
      "an existing test file or a writable file in scope.paths",
    )
  }

  if (taskID === undefined) {
    const title = brief.objective.split("\n")[0] ?? ""
    taskID = await addAdhoc(root, {
      title: title.slice(0, 100) || `Work for ${brief.requestID}`,
      role: brief.role,
      effort: brief.effort,
      paths: [...paths],
      checks: [...checks],
      deliverable: { ...brief.deliverable },
    })
  }

  const briefModule = await import("./brief.js")
  const budget = briefModule.budgetFor(brief.effort, { effort: policy.effort })

  // A review starts where the delegating run started and ends at the commit
  // the reviewer's worktree starts from; the run's own check results there
  // travel with it, because a reviewer can neither run checks nor read them.
  const review =
    brief.deliverable.kind === "findings"
      ? {
          run: childID,
          from: parent.base,
          to: baseSha,
          checks: await Promise.all(
            (await readChecks(root, parent.id)).map(async (check) => {
              const receipt = await lastReceipt(root, parent.id, check.id, baseSha)
              return { id: check.id, passed: receipt !== undefined && isCleanReceipt(receipt) ? receipt.passed : null }
            }),
          ),
        }
      : undefined
  const rendered = briefModule.render(resolved, {
    budget,
    ...(attached === undefined ? {} : { attached }),
    ...(attachmentLimit === undefined ? {} : { attachmentLimit }),
    ...(review === undefined ? {} : { review }),
  })
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
  const gitCommonDir = await realpath(await git(repo.root, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--path-format=absolute", "--git-common-dir"]))
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
          ...(state.teamOutputIds.get(brief.role) === undefined ? {} : { team: state.teamOutputIds.get(brief.role)!.team }),
          kind: "w",
          repo: repo.key,
          repoKey: repo.key,
          gitCommonDir,
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
  // Titled from its Brief: an untitled chat would spend a model request on a
  // title as its first prompt lands.
  const title = `${brief.role}: ${(brief.objective.split("\n")[0] ?? "").slice(0, 100)}`
  const child = await Effect.runPromise(sessions.create({ agent: Agent.ID.make(brief.role), location, title })).catch(
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
  await atomicJson(path.join(runDir, "brief.json"), resolved)
  await atomicJson(path.join(runDir, "checks.json"), [...checks])

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
    checks,
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
  const assignedBrief = await readJson<{ deliverable?: { kind?: Deliverable["kind"] } }>(path.join(root, "runs", caller.run.id, "brief.json"))
  validateSummary(args.summary, assignedBrief?.deliverable?.kind)
  const stored = await loadRun(root, caller.run.id)
  if (stored === undefined) return fail("E_INTERNAL", `Unknown run "${caller.run.id}".`, caller.run.id)
  const last = stored.attempts[stored.attempts.length - 1]
  if (last === undefined) return fail("E_INTERNAL", `Run ${stored.id} has no attempts to finish.`, stored.id)
  const n = last.n
  const recorded = await readJson<unknown>(path.join(root, "runs", stored.id, `report-${n}.json`))
  if (recorded !== undefined)
    return fail("E_FINISH_TWICE", `Report already recorded for attempt ${n}. Corrections arrive as a new attempt; just stop.`, "stop")
  if (isAttemptTerminal(last.state))
    return fail("E_ATTEMPT_ENDED", `Attempt ${n} ended ${last.state} without a report. Continue the Session to open a new attempt.`, "continue the Session")

  // Done is the parent's final word on this run: never while children still
  // work or their done commits are not in this run's HEAD (s13-b: an
  // orchestrator reported done right after delegating its first task).
  const done = args.status === "done" || args.status === "done_with_concerns"
  if (done) {
    const working = await openChildren(root, stored.id)
    if (working.length > 0)
      return fail(
        "E_WAITING",
        `Your children [${working.join(", ")}] are still working, so you are waiting, not done. End your turn without team_finish: each settlement wakes you with its report and a next: line. team_stop a child you no longer need.`,
        "end your turn",
      )
  }

  const worktree = stored.directory
  const assigned = await readChecks(root, stored.id)
  const head = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
  if (done) {
    const unlanded = (await unlandedDone(root, stored, worktree, head)).map((run) => run.id)
    if (unlanded.length > 0)
      return fail(
        "E_UNLANDED",
        `Your children [${unlanded.join(", ")}] reported done but have not landed. Land them with team_integrate, or team_stop the ones you reject, then finish.`,
        { run: unlanded[0] },
      )
  }
  const tree = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD^{tree}"])
  const porcelain = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"])
  const dirtyFiles = parsePorcelain(porcelain)

  // Compound behaviour: reuse same-tree proof only for a clean worktree;
  // assigned checks with no matching receipt run now,
  // through the same executor as team_check, before any gate judges them.
  const missing = await stale(root, assigned, stored.id, head, dirtyFiles.length === 0 ? tree : undefined)
  for (const checkDef of missing) await execute(root, { runID: stored.id, check: checkDef, worktree })

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
      firstLines.set(checkDef.id, await failureLine(receipt?.outputPath))
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
    if (assignedBrief?.deliverable?.kind === "commit" && commits.length === 0)
      return fail(
        "E_NO_COMMIT",
        `This run's deliverable is a commit and it has none since ${stored.base}. Call team_checkpoint first, or finish blocked with needs=[{kind:"info",...}].`,
        { status: "blocked", needs: [{ kind: "info", detail: "why nothing was committed" }] },
      )
  }
  const reportChecks = (await receiptsAt(root, stored.id, head))
    .map((receipt) => ({ id: receipt.id, passed: receipt.passed, head: receipt.head, at: receipt.at, ...(receipt.reused ? { reused: true, reusedFrom: receipt.reusedFrom } : {}) }))
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
  const budgetHistory = stored.history.filter((h): h is BudgetHistoryEntry => "reason" in h)
  await writeFile(
    reportPath,
    render(body, { run: stored.id, attempt: n, head, commits, checks: reportChecks, budgetHistory }),
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
  // The child wrote the report: echoing it back costs its next request the
  // whole text again (a scout's 6 KB of findings). It gets what Plus added.
  return succeeded({ run: body.run, attempt: n, status: args.status, head, commits, checks: reportChecks, dirty: body.dirty, dirtyFiles: body.dirtyFiles, reportPath })
}

async function checkpointHandler(args: CheckpointInput, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const record = stored ?? caller.run
  await requireWorktree(record)
  // A delegated run commits inside its Brief's scope. A chat run has no Brief:
  // it commits what its agent may edit (its edit rows), so a build seat
  // commits anywhere in its checkout and a planner in the chat only its plan
  // files. Protected state (.git, .opencodeplus, …) stays out either way.
  const chat = record.kind === "main"
  const scope = chat ? undefined : await runScope(root, record)
  // Requirements for a commit (rows a Basic member preset turns on): a
  // delegated run that must commit only what its agent may edit does so like a
  // chat run (a Basic orchestrator: its tests and plan files), and a run whose
  // checks judge it leaves the files they run alone unless scope.paths names
  // the file itself (check-files.ts; a Basic implementer).
  const editable = chat || allows(table, record.role, "checkpoint", "requirements.editable")
  const locked = allows(table, record.role, "checkpoint", "requirements.check-files")
    ? await checkFiles(record.directory, record.base, await readChecks(root, record.id))
    : new Set<string>()
  // A test assigned for this run to create has no existing assertion to
  // protect. Its admission already required writable scope, including dir/*.
  if (locked.size > 0) {
    for (const missing of await missingCheckFiles(record.directory, record.base, await readChecks(root, record.id))) locked.delete(missing.file)
  }
  const lockRefusal = (file: string): string | undefined =>
    locked.has(file) && !(scope?.paths.includes(file) ?? false)
      ? `"${file}" is a file your checks run, so it is not yours to change (Requirements for a commit). If it is wrong, commit everything else, then finish blocked with needs=[{kind:"path",detail:"${file}: why it must change"}].`
      : undefined
  const refusalOf = (file: string): string | undefined =>
    (scope !== undefined ? scopeRefusal(scope, file) : protectedStateRefusal(file)) ??
    (editable ? chatEditRefusal(table, caller.agent, record.directory, file) : undefined) ??
    lockRefusal(file)
  const key = await realpath(record.directory).catch(() => record.directory)
  return lock(root, "wt", key, async () => {
    const head = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
    if (!isExpectedHead(head, args.expectedHead)) return fail("E_STALE_HEAD", `HEAD is ${head}, not ${args.expectedHead}.`)
    for (const file of args.files) {
      const refusal = refusalOf(file)
      if (refusal !== undefined) return fail("E_SCOPE", refusal)
    }
    if (args.message.length === 0 || args.message.length > 300 || !COMMIT_MESSAGE_RE.test(args.message))
      return fail(
        "E_MESSAGE",
        `Use "<type>(<scope>)?: <subject>" with type in feat|fix|docs|chore|refactor|test. accepted: "${MESSAGE_ACCEPTED}"`,
        MESSAGE_ACCEPTED,
      )
    // Expand directories before staging: validating only "src" would otherwise
    // let git add include a forbidden descendant. Disable pathspec magic and
    // rename folding so every changed source and destination is checked.
    const selected = await Promise.all([
      git(record.directory, [...NO_REPOSITORY_PROGRAMS, "--literal-pathspecs", "diff", "HEAD", "--name-only", "--no-renames", "-z", "--", ...args.files]),
      git(record.directory, [...NO_REPOSITORY_PROGRAMS, "--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ...args.files]),
    ])
    const files = [...new Set(selected.flatMap((output) => output.split("\0").filter(Boolean)))]
    for (const file of files) {
      const refusal = refusalOf(file)
      if (refusal !== undefined) return fail("E_SCOPE", refusal)
    }
    const staged = (await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "diff", "--cached", "--name-only", "--no-renames", "-z"])).split("\0").filter(Boolean)
    const wanted = new Set(files)
    const offenders = staged.filter((line) => !wanted.has(line))
    if (offenders.length > 0)
      return fail("E_STAGED", `Index has staged changes [${offenders.join(", ")}] not in files[]; include them or unstage.`)
    if (files.length === 0) return succeeded({ head, committed: false })
    // Ref-writing git ops serialize per repository, like the reference.
    const committed = await lock(root, "repo", record.repoKey, async () => {
      await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "--literal-pathspecs", "add", "--", ...files])
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

async function statusHandler(ctx: Context, args: StatusInput, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
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
  for (const id of ids) entries.push(await statusOf(ctx, root, id))
  return succeeded(entries)
}

async function getContextHandler(ctx: Context, _args: GetContextInput, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
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
  const siblings = allows(table, record.role, "get_context", "contents.siblings") ? await siblingsOf(root, record) : []
  const pending = await peek(root, record.id)
  const briefPath = brief === null ? null : path.join(root, "runs", record.id, "brief.md")
  const scope =
    brief === null
      ? { paths: [...record.paths], forbidden: [] }
      : { paths: [...brief.scope.paths], forbidden: [...brief.scope.forbidden] }
  // The Brief is the run's first message: it comes back here only once the
  // model no longer sees it (a compaction summarised it away), as the text it
  // read then. Its interfaces and decisions are in it.
  const briefText =
    brief === null || briefPath === null || (await briefVisible(ctx, record, brief))
      ? undefined
      : await Bun.file(briefPath)
          .text()
          .catch(() => undefined)
  // The live HEAD: it is what checkpoint and integrate compare against, and the
  // stored head lags behind a landing or a commit made outside team tools.
  const head = await git(record.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"]).catch(() => record.head)
  return succeeded({
    run: record.id,
    role: record.role,
    task: record.task,
    directory: record.directory,
    branch: record.branch,
    base: record.base,
    head,
    ...(briefText === undefined ? {} : { brief: briefText }),
    briefPath,
    scope,
    checks,
    // What a run may be given as checks in this project (a delegator's view).
    projectChecks: checksNote(await readProjectChecks(record.directory).catch(() => undefined)),
    siblings,
    budget: {
      turns: record.budget.turns ?? null,
      tokens: record.budget.tokens ?? null,
      wallMs: record.budget.wallMs ?? null,
      used: {
        attemptsUsed: record.attempts.length,
        tokensUsed: (await sessionTokens(ctx, record)) ?? null,
        cacheReads: (await sessionTokenUsage(ctx, record))?.cacheRead ?? null,
        usageBasis: "Session-cumulative",
      },
      contextTokens: (await sessionContextTokens(ctx, record)) ?? null,
    },
    inbox: pending.map((item) => ({ id: item.id, from: item.from, kind: item.kind, text: item.text })),
  })
}

// Whether the model still sees the run's Brief: its first message, which starts
// with the rendered header. Unknown (no session, unreadable) counts as gone.
async function briefVisible(ctx: Context, record: RunRecord, brief: Brief): Promise<boolean> {
  const sessionID = record.sessionID
  if (sessionID === null) return false
  const messages = await Effect.runPromise(
    Effect.suspend(() => ctx.session.context({ sessionID: Session.ID.make(sessionID) })),
  ).catch(() => undefined)
  // The header render() writes.
  const header = `# Brief — ${brief.task ?? brief.requestID} — ${brief.role}`
  return messages?.some((message) => message.type === "user" && message.text.startsWith(header)) === true
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
  const directory = target.worktree === "removed" ? await historicalRepository(root, target) : target.directory
  // A generated patch is the one diff output that runs a program named by
  // repository config (`diff.external`) or a `.gitattributes` diff driver
  // (`command`/`textconv`), so both opt-outs travel with this call.
  const result = await gitRaw(directory, [
    ...NO_REPOSITORY_PROGRAMS,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    from,
    ...(target.worktree === "removed" ? [target.head] : []),
    ...(paths.length === 0 ? [] : ["--", ...paths]),
  ])
  if (result.code !== 0)
    return fail("E_INTERNAL", `git diff ${from} failed in ${target.directory}: ${result.err || result.out || "unknown error"}`)
  const bytes = Buffer.byteLength(result.out, "utf8")
  const truncated = bytes > maxBytes
  const head = target.worktree === "removed" ? target.head : await git(directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
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

async function historicalRepository(root: string, target: RunRecord): Promise<string> {
  const records = await listRuns(root)
  for (const record of records.filter((run) => run.repoKey === target.repoKey && run.worktree !== "removed")) {
    const common = await gitRaw(record.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => undefined)
    if (common?.code !== 0) continue
    if (target.gitCommonDir !== undefined && await realpath(common.out) !== target.gitCommonDir) continue
    // Older records have no common-directory identity: their retained branch
    // must still identify the exact saved head, not merely a same-named repo.
    if (target.gitCommonDir === undefined) {
      const branch = await gitRaw(record.directory, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "--verify", `refs/heads/${target.branch}`])
      if (branch.code !== 0 || branch.out !== target.head) continue
    }
    const commits = await Promise.all([target.base, target.head].map((sha) => gitRaw(record.directory, [...NO_REPOSITORY_PROGRAMS, "cat-file", "-e", `${sha}^{commit}`])))
    if (commits.every((result) => result.code === 0)) return record.directory
  }
  throw toolError("E_HISTORY_UNAVAILABLE", `No surviving repository holds the retained history for ${target.id}.`, "retain the repository and child branch")
}

async function checkHandler(args: CheckInput, caller: TeamCaller, table: PermissionTable | undefined): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const record = stored ?? caller.run
  await requireWorktree(record)
  const assigned = await readChecks(root, record.id)
  // Beyond its assigned checks a run may run any project check: the project's
  // people named those commands, so they run unattended. Its result informs
  // the run; only assigned checks judge its finish.
  const assignedCheck = assigned.find((entry) => entry.id === args.id && args.path === undefined) ?? (await projectCheck(record, args, assigned))
  // Checks it may run (Permissions of team_check): a test-file check or a
  // package-script check this member's rows turned off is refused before it
  // runs, with the report that says what to do instead.
  const family = assignedCheck.argv[1] === "test" ? "checks.tests" : assignedCheck.argv[1] === "run" ? "checks.scripts" : undefined
  if (family !== undefined && !allows(table, record.role, "check", family))
    return fail(
      "E_PERMISSION",
      `${record.role} may not run ${family === "checks.tests" ? "test-file" : "package-script"} checks here (Permissions → Checks it may run). Finish with needs=[{kind:"check",...}] instead.`,
      { status: "blocked", needs: [{ kind: "check", detail: args.id }] },
    )
  try {
    return succeeded(await run(root, record.id, assignedCheck.id, [assignedCheck], record.directory))
  } catch (error) {
    return { ok: false, error: thrownError(error) }
  }
}

// A project check the run was not assigned, resolved as a delegator's would
// be. An id that is neither throws E_UNKNOWN_CHECK naming both lists.
async function projectCheck(record: RunRecord, args: CheckInput, assigned: readonly Check[]): Promise<Check> {
  const project = await readProjectChecks(record.directory).catch(() => undefined)
  if (project?.checks.some((check) => check.id === args.id) !== true)
    throw toolError(
      "E_UNKNOWN_CHECK",
      `Check "${args.id}" is neither assigned nor a project check. Assigned: [${assigned.map((check) => check.id).join(", ")}]. ${checksNote(project)}`,
      { id: assigned[0]?.id ?? project?.checks[0]?.id ?? "test" },
    )
  // Its receipts must not pass for an assigned check's of the same id (one
  // named with another path).
  const id = assigned.some((check) => check.id === args.id) ? `${args.id}-own` : args.id
  return resolveChecks([{ id, use: args.id, ...(args.path === undefined ? {} : { path: args.path }) }], project)[0]!
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

// Delegation and followup grant paths through the same caller rows and target
// limits. A followup validates the whole widened scope, but grants only additions.
export function scopePathsRefusal(
  table: PermissionTable | undefined,
  brief: Pick<Brief, "role" | "scope" | "deliverable">,
  caller: TeamCaller,
  grants = brief.scope.paths,
): TeamApiResult | undefined {
  const target = brief.role
  const paths = brief.scope.paths
  const invalid = [...paths, ...brief.scope.forbidden].find((candidate) => !isScopePath(candidate))
  if (invalid !== undefined) return fail("E_PATHS", `${PATHS_MESSAGE} Not one: "${invalid}".`, PATHS_ACCEPTED)
  const permission = decide(table?.toolRows(caller.agent, "team_delegate").filter((row) => row.item.category === "scope") ?? [], {
    tool: "team_delegate",
    input: { scope: { paths: grants } },
    sessionID: caller.sessionID,
    agent: caller.agent,
    directory: caller.run.directory,
    teamMembers: table?.teamMembers ?? new Set<string>(),
  })
  if (permission.refuse !== undefined) return fail("E_PERMISSION", permission.refuse)
  const forbidden = grants.map((candidate) => scopeRefusal(brief.scope, candidate.endsWith("/*") ? candidate.slice(0, -2) : candidate)).find((message) => message !== undefined)
  if (forbidden !== undefined) return fail("E_SCOPE", forbidden)
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
  const maxPaths = Math.min(bound(table, target, "get_context", "limits.paths") ?? 40, 40)
  if (paths.length > maxPaths)
    return fail("E_BRIEF", `${target} accepts at most ${maxPaths} scope paths per brief (Brief limits → Paths per brief); this brief has ${paths.length}.`, { paths: maxPaths })
  return undefined
}

// The target's remaining Brief requirements do not change with a scope grant.
function briefRefusal(table: PermissionTable | undefined, brief: Brief): TeamApiResult | undefined {
  const target = brief.role
  const says = (id: string) => `${target} ${messageOf(table, target, "get_context", id)}`
  if (allows(table, target, "get_context", "accepts.reason") && (brief.reason === undefined || brief.reason.trim() === ""))
    return fail("E_REASON", `${says("accepts.reason")} (Briefs it accepts → A reason).`, { reason: "3 independent packages, each needs its own workers" })
  if (allows(table, target, "get_context", "accepts.check") && brief.checks.length === 0)
    return fail("E_BRIEF", `${says("accepts.check")} (Briefs it accepts → A check).`, { checks: 1 })
  const maxChecks = bound(table, target, "get_context", "limits.checks")
  if (maxChecks !== undefined && brief.checks.length > maxChecks)
    return fail("E_BRIEF", `${target} accepts at most ${maxChecks} checks per brief (Brief limits → Checks per brief); this brief has ${brief.checks.length}.`, { checks: maxChecks })
  return undefined
}

// A team row's refusal text as the model reads it.
function messageOf(table: PermissionTable | undefined, agent: string, tool: TeamTool, id: string): string {
  return row(table, agent, tool, id)?.item.message ?? `is refused by its ${tool} row ${id}`
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

// What a red check's log says went wrong, short enough for a needs detail: its
// first two error or failure lines (a runner's banner comes first and says
// nothing), else its last line, which is usually the summary.
async function failureLine(outputPath: string | undefined): Promise<string> {
  if (outputPath === undefined) return "failed"
  const lines = (await readFile(outputPath, "utf8").catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const failing = lines
    .filter((line) => /\b(error|fail(ed|ure)?|assert(ion)?)\b/i.test(line) && !/^(\(pass\)|✓|ok\b|PASS\b)/.test(line))
    .slice(0, 2)
  const said = failing.length > 0 ? failing.join(" — ") : (lines.at(-1) ?? "")
  return said === "" ? "failed" : said.slice(0, 200)
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

// The caller's children whose last report is done (or done with concerns)
// with commits `head` does not hold: still open, not stopped, worktree
// present. A reviewer's or scout's findings carry no commits and never land;
// a child whose commits came in with another's landing is in (s12-d: a fix
// built on the first implementer's commit landed both).
async function unlandedDone(root: string, parent: RunRecord, directory: string, head: string): Promise<RunRecord[]> {
  // Landed per worktree generation: a reopened child's new branch is open again.
  const landed = new Set((await queue(root, parent.id)).filter((entry) => entry.state === "landed").map((entry) => `${entry.childRun} ${entry.childBranch}`))
  const children = await Promise.all(parent.children.map((id) => loadRun(root, id)))
  const open = children.filter(
    (run): run is RunRecord =>
      run !== undefined && !landed.has(`${run.id} ${run.branch}`) && run.worktree !== "removed" && !["stopped", "dead", "superseded", "reaped"].includes(run.state),
  )
  const reports = await Promise.all(open.map(async (run) => ({ run, report: await latestReport(root, run.id) })))
  const done = reports
    .filter((entry) => (entry.report?.data.status === "done" || entry.report?.data.status === "done_with_concerns") && Array.isArray(entry.report.data.commits) && entry.report.data.commits.length > 0)
    .map((entry) => entry.run)
  const held = await Promise.all(done.map(async (run) => (await gitRaw(directory, [...NO_REPOSITORY_PROGRAMS, "merge-base", "--is-ancestor", run.head, head])).code === 0))
  return done.filter((_, index) => !held[index])
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

// The parent's other children still at work: who else may be changing which
// files now. Not the task graph: every delegation adds its task to the one
// install-wide ad-hoc graph, so its tasks are no run's siblings.
async function siblingsOf(root: string, record: RunRecord): Promise<Array<{ run: string; role: string; paths: string[]; state: string }>> {
  const parent = record.parent === null ? undefined : await loadRun(root, record.parent)
  if (parent === undefined) return []
  const runs = await Promise.all(parent.children.filter((id) => id !== record.id).map((id) => loadRun(root, id)))
  return runs.flatMap((run) =>
    run === undefined || run.worktree === "removed" || ENDED_RUN_STATES.has(run.state)
      ? []
      : [{ run: run.id, role: run.role, paths: [...run.paths], state: run.state }],
  )
}

const ENDED_RUN_STATES = new Set<string>(["stopped", "dead", "superseded", "reaped"])

async function statusOf(ctx: Context, root: string, id: string) {
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
  const usage = await sessionTokenUsage(ctx, record)
  const tokensUsed = usage?.used
  const contextTokens = await sessionContextTokens(ctx, record)
  const exhaustion = budgetExhaustion(record, { tokensUsed })
  return {
    run: record.id,
    role: record.role,
    state: record.state,
    ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
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
    // A run idle with its attempt still open is waiting on these children;
    // their settlements wake it and continue the same attempt.
    waitingOn: record.state === "idle" && last !== undefined && !isAttemptTerminal(last.state) ? await openChildren(root, id) : [],
    budget: {
      attemptsUsed: record.attempts.length,
      turnsUsed: record.attempts.length, // compatibility alias: attempts, never model calls
      turns: record.budget.turns ?? 0,
      tokensUsed: tokensUsed ?? null,
      cacheReads: usage?.cacheRead ?? null,
      usageBasis: "Session-cumulative",
      contextTokens: contextTokens ?? null,
      tokens: record.budget.tokens ?? 0,
      overBy: exhaustion.overBy,
      exhausted: exhaustion.exhausted,
      history: record.history.filter((h): h is BudgetHistoryEntry => "reason" in h),
    },
    retrying: activeRetrying(record.retrying),
  }
}

function activeRetrying(retrying?: RunRecord["retrying"]): RunRecord["retrying"] | null {
  if (retrying === undefined) return null
  const until = Date.parse(retrying.until)
  if (Number.isNaN(until) || until <= Date.now()) return null
  return retrying
}
