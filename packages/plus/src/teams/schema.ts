import { Effect, Schema } from "effect"

// Optional struct field with a decoding default, the Effect Schema form of
// zod's `.default()`: absent or undefined input decodes to the default, so
// the decoded Type stays non-optional. Defaults are thunks so every decode
// gets a fresh object or array.
function field<S extends Schema.Constraint>(
  schema: S,
  def: () => S["Type"],
): Schema.withDecodingDefaultType<S, never> {
  return Schema.withDecodingDefaultType<S, never>(Effect.sync(def))(schema)
}

// Identity primitives (docs/team-v2/03-tools.md conventions).
export const Head = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
export type Head = typeof Head.Type

export const RunID = Schema.String.check(Schema.isPattern(/^(main|w)-[0-9a-f]{16}$/))
export type RunID = typeof RunID.Type

export const TaskID = Schema.String.check(Schema.isPattern(/^T[0-9]+(\.rework\.[0-9]+)?$/))
export type TaskID = typeof TaskID.Type

// Roles that may be delegated to (copied from scripts/team/roles.ts
// delegatedRoles; team2 does not import from scripts/team/).
export const delegatedRoles = [
  "fable-planner",
  "astra-planner",
  "sol-orchestrator",
  "opus-orchestrator",
  "muse-implementer",
  "gemini-implementer",
  "spark-implementer",
  "opus-implementer",
  "scout",
] as const

const E_CHECKS = "E_CHECKS"
const CHECKS_ACCEPTED = {
  id: "plus-tests",
  argv: ["bun", "test", "packages/plus/test/model.test.ts"],
} as const

// Per-check rules ported from validateChecks in scripts/team/roles.ts:52-97.
// Behaviour is verbatim: same order, same accept/reject outcomes. Array-level
// rules (max 12, distinct ids) live on ChecksArray below.
function checkViolation(check: {
  readonly id: string
  readonly argv: readonly string[]
  readonly cwd?: string | undefined
}): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(check.id)) return "Checks need distinct short IDs."
  if (check.argv[0] !== "bun" || !["test", "run"].includes(check.argv[1]) || check.argv.length < 3)
    return "Checks must be explicit bun test FILE or bun run SCRIPT commands. Whole-suite bun test is not permitted."
  if (
    check.argv[1] === "test" &&
    check.argv.slice(2).some((a) => {
      if (a.startsWith("-")) return false
      if (a === "." || a.startsWith("/") || a.split("/").includes("..")) return true
      if (/[\\\*\?\[\]{}]/.test(a)) return true
      if (/[.](test|spec)[.][cm]?[jt]sx?$/.test(a)) return false
      // Otherwise it must be a directory inside the worktree (e.g. test,
      // packages/plus/test): relative, no globs, and not a bare filename
      // that looks like a source file.
      const isDirLike = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/?$/.test(a)
      if (!isDirLike) return true
      const last = a.replace(/\/$/, "").split("/").at(-1) ?? ""
      return last.includes(".") // a dotted non-test name is a file, reject it
    })
  )
    return "Tests must name explicit test files or directories inside the worktree."
  if (check.argv[1] === "run" && !/^[a-zA-Z][a-zA-Z0-9:._-]*$/.test(check.argv[2] ?? ""))
    return "Use a named package script, not an external executable or path"
  if (check.argv[1] === "test" && check.argv.slice(2).some((a) => a.startsWith("-")))
    return "Use explicit test files without runtime-loading flags"
  if (check.argv.some((a) => a.includes("\0")) || (typeof check.argv[2] === "string" && check.argv[2].startsWith("-")))
    return "Invalid check argument."
  if (check.cwd !== undefined && (check.cwd.startsWith("/") || check.cwd.split("/").includes("..")))
    return "Check cwd must remain inside the task worktree."
  return undefined
}

export const Check = Schema.Struct({
  id: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
})
export type Check = typeof Check.Type

export const ChecksArray = Schema.Array(Check)
export type ChecksArray = typeof ChecksArray.Type

// Throws a ToolError-shaped object on any failure. The message is the
// underlying rule text; accepted is the documented valid example.
export function validateChecks(checks: readonly Check[] | Check[]): void {
  if (checks.length > 12)
    throw toolError(E_CHECKS, "E_CHECKS: Use at most 12 focused checks.", {
      id: CHECKS_ACCEPTED.id,
      argv: [...CHECKS_ACCEPTED.argv],
    })
  const seen = new Set<string>()
  for (const check of checks) {
    if (seen.has(check.id))
      throw toolError(E_CHECKS, "Checks need distinct short IDs.", {
        id: CHECKS_ACCEPTED.id,
        argv: [...CHECKS_ACCEPTED.argv],
      })
    seen.add(check.id)
    const violation = checkViolation(check)
    if (violation !== undefined)
      throw toolError(E_CHECKS, violation, { id: CHECKS_ACCEPTED.id, argv: [...CHECKS_ACCEPTED.argv] })
  }
}

// Brief building blocks (docs/team-v2/03-tools.md §delegate).
export const Deliverable = Schema.Struct({
  kind: Schema.Literals(["commit", "report", "plan", "findings"]),
  format: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
})
export type Deliverable = typeof Deliverable.Type

export const Interface = Schema.Struct({
  path: Schema.String,
  symbol: Schema.optional(Schema.String),
  note: Schema.String.check(Schema.isMaxLength(200)),
})
export type Interface = typeof Interface.Type

export const Need = Schema.Struct({
  kind: Schema.Literals(["path", "check", "info", "decision"]),
  detail: Schema.String.check(Schema.isMaxLength(300)),
})
export type Need = typeof Need.Type

export const Brief = Schema.Struct({
  requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  role: Schema.Literals(delegatedRoles),
  task: Schema.optional(TaskID),
  objective: Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(600)),
  deliverable: Deliverable,
  scope: Schema.Struct({
    paths: field(Schema.Array(Schema.String).check(Schema.isMaxLength(40)), () => []),
    forbidden: field(Schema.Array(Schema.String).check(Schema.isMaxLength(20)), () => []),
  }),
  context: field(
    Schema.Struct({
      interfaces: field(Schema.Array(Interface).check(Schema.isMaxLength(20)), () => []),
      decisions: field(
        Schema.Array(Schema.String.check(Schema.isMaxLength(300))).check(Schema.isMaxLength(20)),
        () => [],
      ),
    }),
    () => ({ interfaces: [], decisions: [] }),
  ),
  checks: field(ChecksArray, () => []),
  effort: field(Schema.Literals(["small", "medium", "large"]), () => "medium" as const),
  repo: Schema.optional(Schema.String),
  base: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  briefFile: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
})
export type Brief = typeof Brief.Type

// Report building blocks (docs/team-v2/03-tools.md §finish).
export const Finding = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  path: Schema.String,
  detail: Schema.String,
})
export type Finding = typeof Finding.Type

export function validateSummary(summary: string): void {
  const lines = summary.split("\n").length
  if (lines > 15) {
    throw toolError(
      "E_SUMMARY",
      `summary is ${lines} lines (max 15). Detail goes to the report file automatically; keep the summary to what the parent must act on.`,
      "a summary of ≤15 lines",
    )
  }
}

export const Report = Schema.Struct({
  status: Schema.Literals(["done", "done_with_concerns", "blocked", "needs_context", "rejected"]),
  summary: Schema.String.check(Schema.isMaxLength(1500)),
  concerns: field(
    Schema.Array(Schema.String.check(Schema.isMaxLength(300))).check(Schema.isMaxLength(10)),
    () => [],
  ),
  needs: field(Schema.Array(Need).check(Schema.isMaxLength(10)), () => []),
  findings: field(Schema.Array(Finding).check(Schema.isMaxLength(50)), () => []),
  deferred: field(
    Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(10)),
    () => [],
  ),
})
export type Report = typeof Report.Type

// State enums (docs/team-v2/02-state-machines.md).
export const RunStates = [
  "created",
  "preparing",
  "ready",
  "starting",
  "idle",
  "working",
  "blocked_input",
  "stopping",
  "stopped",
  "dead",
  "superseded",
  "reaped",
] as const
export const RunState = Schema.Literals(RunStates)
export type RunState = typeof RunState.Type

export const AttemptStates = [
  "queued",
  "admitted",
  "streaming",
  "finishing",
  "succeeded",
  "reported",
  "no_report",
  "failed",
  "interrupted",
  "timed_out",
  "stalled",
] as const
export const AttemptState = Schema.Literals(AttemptStates)
export type AttemptState = typeof AttemptState.Type

export const TaskStates = [
  "open",
  "blocked",
  "claimed",
  "working",
  "reported",
  "queued_merge",
  "merged",
  "rework",
  "done",
  "cancelled",
] as const
export const TaskState = Schema.Literals(TaskStates)
export type TaskState = typeof TaskState.Type

export const MergeStates = [
  "pending",
  "rebasing",
  "verifying",
  "landing",
  "landed",
  "conflict",
  "red",
  "stale_parent",
  "paused",
] as const
export const MergeState = Schema.Literals(MergeStates)
export type MergeState = typeof MergeState.Type

export const ReportStatuses = ["done", "done_with_concerns", "blocked", "needs_context", "rejected"] as const
export const ReportStatus = Schema.Literals(ReportStatuses)
export type ReportStatus = typeof ReportStatus.Type

// Policy file front matter (docs/team-v2/05-runtime-and-storage.md §Policy file).
const EffortBudget = Schema.Struct({
  turns: field(Schema.Number, () => 0),
  tokens: field(Schema.Number, () => 0),
  wallMs: field(Schema.Number, () => 0),
})

const defaultBounds = {
  members: 12,
  inFlight: 4,
  maxDepth: 3,
  defaultTurns: 200,
  defaultWallMs: 5400000,
  tasksPerPlan: 20,
  inboxUnreadBytes: 262144,
  briefChars: 6000,
}

const defaultEffort = {
  small: { turns: 25, tokens: 400000, wallMs: 1200000 },
  medium: { turns: 60, tokens: 1500000, wallMs: 3600000 },
  large: { turns: 150, tokens: 5000000, wallMs: 5400000 },
}

const defaultTimeouts = { startMs: 60000, stallMs: 600000, deadGraceMs: 300000, hookMs: 120000 }

const defaultRetry = { maxAttempts: 3, baseMs: 10000, maxMs: 300000 }

const defaultOrchestratorDelegateTo = [
  "muse-implementer",
  "gemini-implementer",
  "spark-implementer",
  "opus-implementer",
  "opus-orchestrator",
  "sol-orchestrator",
  "astra-reviewer",
  "scout",
  "astra-planner",
  "fable-planner",
]

export const Policy = Schema.Struct({
  policy: field(Schema.Literal(1), () => 1 as const),
  bounds: field(
    Schema.Struct({
      members: field(Schema.Number, () => defaultBounds.members),
      inFlight: field(Schema.Number, () => defaultBounds.inFlight),
      maxDepth: field(Schema.Number, () => defaultBounds.maxDepth),
      defaultTurns: field(Schema.Number, () => defaultBounds.defaultTurns),
      defaultWallMs: field(Schema.Number, () => defaultBounds.defaultWallMs),
      tasksPerPlan: field(Schema.Number, () => defaultBounds.tasksPerPlan),
      inboxUnreadBytes: field(Schema.Number, () => defaultBounds.inboxUnreadBytes),
      briefChars: field(Schema.Number, () => defaultBounds.briefChars),
    }),
    () => ({ ...defaultBounds }),
  ),
  effort: field(
    Schema.Struct({
      small: field(EffortBudget, () => ({ ...defaultEffort.small })),
      medium: field(EffortBudget, () => ({ ...defaultEffort.medium })),
      large: field(EffortBudget, () => ({ ...defaultEffort.large })),
    }),
    () => ({ small: { ...defaultEffort.small }, medium: { ...defaultEffort.medium }, large: { ...defaultEffort.large } }),
  ),
  timeouts: field(
    Schema.Struct({
      startMs: field(Schema.Number, () => defaultTimeouts.startMs),
      stallMs: field(Schema.Number, () => defaultTimeouts.stallMs),
      deadGraceMs: field(Schema.Number, () => defaultTimeouts.deadGraceMs),
      hookMs: field(Schema.Number, () => defaultTimeouts.hookMs),
    }),
    () => ({ ...defaultTimeouts }),
  ),
  retry: field(
    Schema.Struct({
      maxAttempts: field(Schema.Number, () => defaultRetry.maxAttempts),
      baseMs: field(Schema.Number, () => defaultRetry.baseMs),
      maxMs: field(Schema.Number, () => defaultRetry.maxMs),
    }),
    () => ({ ...defaultRetry }),
  ),
  gc: field(
    Schema.Struct({
      reapAfter: field(Schema.String, () => "7d"),
      keepPromotedFrom: field(Schema.Boolean, () => true),
    }),
    () => ({ reapAfter: "7d", keepPromotedFrom: true }),
  ),
  integrate: field(
    Schema.Struct({
      auto: field(Schema.Boolean, () => false),
    }),
    () => ({ auto: false }),
  ),
  roles: field(
    Schema.Struct({
      planner: field(
        Schema.Struct({
          delegateTo: field(Schema.Array(Schema.String), () => ["opus-orchestrator", "sol-orchestrator"]),
        }),
        () => ({ delegateTo: ["opus-orchestrator", "sol-orchestrator"] }),
      ),
      orchestrator: field(
        Schema.Struct({
          delegateTo: field(Schema.Array(Schema.String), () => [...defaultOrchestratorDelegateTo]),
          allowOwnCommits: field(Schema.Boolean, () => false),
          fixRounds: field(Schema.Number, () => 5),
          freshWorkerAfterRound: field(Schema.Number, () => 3),
        }),
        () => ({
          delegateTo: [...defaultOrchestratorDelegateTo],
          allowOwnCommits: false,
          fixRounds: 5,
          freshWorkerAfterRound: 3,
        }),
      ),
    }),
    () => ({
      planner: { delegateTo: ["opus-orchestrator", "sol-orchestrator"] },
      orchestrator: {
        delegateTo: [...defaultOrchestratorDelegateTo],
        allowOwnCommits: false,
        fixRounds: 5,
        freshWorkerAfterRound: 3,
      },
    }),
  ),
  sweep: field(
    Schema.Struct({
      tickMs: field(Schema.Number, () => 2000),
      reconcileMs: field(Schema.Number, () => 30000),
    }),
    () => ({ tickMs: 2000, reconcileMs: 30000 }),
  ),
})
export type Policy = typeof Policy.Type

// Plan front matter (docs/team-v2/04-handoff-contract.md §3).
export const PlanTask = Schema.Struct({
  id: TaskID,
  title: Schema.String,
  dependsOn: Schema.Array(TaskID),
  role: Schema.String.check(Schema.isMinLength(1)),
  effort: Schema.Literals(["small", "medium", "large"]),
  deliverable: Deliverable,
  paths: Schema.Array(Schema.String),
  checks: ChecksArray,
})
export type PlanTask = typeof PlanTask.Type

export const PlanFrontMatter = Schema.Struct({
  plan: Schema.Literal(1),
  title: Schema.String,
  repo: Schema.String,
  base: Schema.String,
  globalConstraints: field(Schema.Array(Schema.String), () => []),
  tasks: Schema.Array(PlanTask),
})
export type PlanFrontMatter = typeof PlanFrontMatter.Type

// F1.2 additive tool-surface budgets (advisory; never enforced).
//
// - FollowupBudget: optional followup({budget}) input. When present the run's
//   whole budget object is REPLACED (omitted dimensions become unconfigured).
// - BudgetOverBy: status.budget addition reporting how far PAST the budget
//   each dimension is (0 when under, never negative).
// - wait.overBudget is just RunID[] (see tools/wait.ts WaitResult); it needs
//   no new shape here.
//
// All three are optional additions: omitting them validates exactly as before.
//
// Single home of the "how far over budget" math (F1.4b): budgetDimensions
// computes the per-dimension usage (turns = attempts.length, tokens = live
// session tokensUsed, wall = run age, or attempt age when only the sweeper's
// advisory wall fallback is configured). budgetExhaustion is the thin
// overBy/exhausted wrapper used by status/wait; sweeper.ts notifyBudget calls
// budgetDimensions directly for the same numbers plus the ratios it needs
// for its notify steps and line. There is no second copy.
export const FollowupBudget = Schema.Struct({
  turns: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  wallMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type FollowupBudget = typeof FollowupBudget.Type

export const BudgetOverBy = Schema.Struct({
  turns: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  tokens: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  wallMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type BudgetOverBy = typeof BudgetOverBy.Type

export interface BudgetDimension {
  name: "turns" | "tokens" | "wall"
  used: number
  budget: number
  ratio: number
}

export interface BudgetUsageOpts {
  tokensUsed?: number | undefined
  now?: number | undefined
  /** Advisory wall denominator when run.budget.wallMs is not configured
   * (the sweeper's policy defaultWallMs fallback). */
  wallMsFallback?: number | undefined
  /** Attempt start for the fallback wall dimension (the sweeper passes the
   * last attempt's startedAt so the fallback compares attempt age). */
  attemptStartedAt?: string | undefined
}

/** Per-dimension budget usage; unconfigured dimensions are omitted. */
export function budgetDimensions(
  run: {
    attempts: readonly unknown[]
    budget: { turns?: number | undefined; tokens?: number | undefined; wallMs?: number | undefined }
    createdAt: string
  },
  opts?: BudgetUsageOpts,
): BudgetDimension[] {
  const now = opts?.now ?? Date.now()
  const dims: BudgetDimension[] = []
  if (typeof run.budget.turns === "number" && run.budget.turns > 0) {
    dims.push({
      name: "turns",
      used: run.attempts.length,
      budget: run.budget.turns,
      ratio: run.attempts.length / run.budget.turns,
    })
  }
  const tokensUsed = opts?.tokensUsed
  if (typeof run.budget.tokens === "number" && run.budget.tokens > 0 && typeof tokensUsed === "number") {
    dims.push({
      name: "tokens",
      used: tokensUsed,
      budget: run.budget.tokens,
      ratio: tokensUsed / run.budget.tokens,
    })
  }
  const wallBudget = run.budget.wallMs ?? opts?.wallMsFallback
  if (typeof wallBudget === "number" && wallBudget > 0) {
    const createdAt = Date.parse(run.createdAt)
    if (typeof run.budget.wallMs === "number" && run.budget.wallMs > 0 && Number.isFinite(createdAt)) {
      // Run budget wall: run age vs budget.wallMs.
      const wallUsed = now - createdAt
      dims.push({ name: "wall", used: wallUsed, budget: wallBudget, ratio: wallUsed / wallBudget })
    } else {
      // Advisory attempt wall: attempt age vs the fallback denominator.
      const startedAt = opts?.attemptStartedAt !== undefined ? Date.parse(opts.attemptStartedAt) : NaN
      if (Number.isFinite(startedAt)) {
        const wallUsed = now - (startedAt as number)
        dims.push({ name: "wall", used: wallUsed, budget: wallBudget, ratio: wallUsed / wallBudget })
      }
    }
  }
  return dims
}

export function budgetExhaustion(
  run: {
    attempts: readonly unknown[]
    budget: { turns?: number | undefined; tokens?: number | undefined; wallMs?: number | undefined }
    createdAt: string
  },
  opts?: BudgetUsageOpts,
): { overBy: BudgetOverBy; exhausted: boolean } {
  const dims = budgetDimensions(run, opts)
  let turnsOver = 0
  let tokensOver = 0
  let wallOver = 0
  let exhausted = false
  for (const d of dims) {
    const over = Math.max(0, d.used - d.budget)
    if (d.name === "turns") turnsOver = over
    else if (d.name === "tokens") tokensOver = over
    else wallOver = over
    if (d.ratio >= 1) exhausted = true
  }
  return {
    overBy: { turns: turnsOver, tokens: tokensOver, wallMs: wallOver },
    exhausted,
  }
}

// Tool error envelope: a plain object (never an Error subclass) so it
// survives structured-clone and JSON round-trips.
export const ToolError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  accepted: Schema.optional(Schema.Unknown),
})
export type ToolError = typeof ToolError.Type

export function toolError(code: string, message: string, accepted?: unknown): ToolError {
  return accepted === undefined ? { code, message } : { code, message, accepted }
}

// Tool input schemas (docs/team-v2/03-tools.md). Every tool has exactly one
// input schema, exported from here and shared between registration and handlers.
export const FollowupInput = Schema.Struct({
  run: RunID,
  requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  delivery: Schema.optional(Schema.Literals(["now", "queue"])),
  budget: Schema.optional(FollowupBudget),
})
export type FollowupInput = typeof FollowupInput.Type

export const ReviewInput = Schema.Struct({
  requestID: Schema.String,
  expectedHead: Head,
  completion: Schema.String.check(Schema.isMinLength(40), Schema.isMaxLength(3000)),
  previous: Schema.optional(Schema.Union([Schema.Literal("latest"), RunID, Schema.Literal("none")])),
  scope: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(40))),
})
export type ReviewInput = typeof ReviewInput.Type

export const IntegrateInput = Schema.Struct({
  run: RunID,
  expectedParentHead: Head,
})
export type IntegrateInput = typeof IntegrateInput.Type

export const CheckpointInput = Schema.Struct({
  expectedHead: Head,
  files: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  message: Schema.String.check(Schema.isMaxLength(300)),
})
export type CheckpointInput = typeof CheckpointInput.Type

export const SetChecksInput = Schema.Struct({
  checks: ChecksArray,
})
export type SetChecksInput = typeof SetChecksInput.Type

export const SupersedeInput = Schema.Struct({
  run: RunID,
  reason: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(500)),
  waitMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(120000))),
})
export type SupersedeInput = typeof SupersedeInput.Type

export const ShutdownRequestInput = Schema.Struct({
  run: RunID,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
})
export type ShutdownRequestInput = typeof ShutdownRequestInput.Type

export const StopInput = Schema.Struct({
  run: RunID,
})
export type StopInput = typeof StopInput.Type

export const ResumeInput = Schema.Struct({
  run: RunID,
})
export type ResumeInput = typeof ResumeInput.Type

export const PrepareInput = Schema.Struct({
  cwd: Schema.optional(Schema.String),
})
export type PrepareInput = typeof PrepareInput.Type

export const PlanHandoffInput = Schema.Struct({
  requestID: Schema.String,
  planFile: Schema.String,
  role: Schema.optional(Schema.Literals(["opus-orchestrator", "sol-orchestrator"])),
  repo: Schema.optional(Schema.String),
  base: Schema.optional(Schema.String),
  authorization: Schema.Literal(true),
})
export type PlanHandoffInput = typeof PlanHandoffInput.Type

export const StatusInput = Schema.Struct({
  runs: Schema.optional(Schema.Array(RunID).check(Schema.isMinLength(1), Schema.isMaxLength(20))),
})
export type StatusInput = typeof StatusInput.Type

export const WaitInput = Schema.Struct({
  runs: Schema.Array(RunID).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  timeoutMs: Schema.optional(Schema.Number),
  until: Schema.optional(Schema.Literals(["settled", "idle"])),
  /** Acknowledge the settled outcome of owned children (default true); the
   * acknowledged run ids come back in the result. */
  ack: Schema.optional(Schema.Boolean),
})
export type WaitInput = typeof WaitInput.Type

// runs/<run>/ack.json: the parent's receipt for one settled attempt. wait
// writes it, status reads it back as `acked`, and the settlement notice is
// never repeated for an acknowledged attempt.
export const RunAck = Schema.Struct({
  by: Schema.String,
  attempt: Schema.Number,
  attemptState: Schema.String,
  at: Schema.String,
  until: Schema.Literals(["settled", "idle"]),
})
export type RunAck = typeof RunAck.Type

export const DiffInput = Schema.Struct({
  run: RunID,
  from: Schema.optional(Schema.Union([Head, Schema.Literal("base"), Schema.Literal("parent")])),
  paths: Schema.optional(Schema.Array(Schema.String)),
  maxBytes: Schema.optional(Schema.Number),
})
export type DiffInput = typeof DiffInput.Type

export const ListInput = Schema.Struct({
  all: Schema.optional(Schema.Boolean),
  role: Schema.optional(Schema.String),
  state: Schema.optional(RunState),
  parent: Schema.optional(RunID),
})
export type ListInput = typeof ListInput.Type

export const GetContextInput = Schema.Struct({})
export type GetContextInput = typeof GetContextInput.Type

export const CheckInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
})
export type CheckInput = typeof CheckInput.Type

export const MetricsInput = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["self", "tree", "namespace"])),
  since: Schema.optional(Schema.String),
})
export type MetricsInput = typeof MetricsInput.Type

export const ExaContentsInput = Schema.Struct({
  text: Schema.optional(Schema.Union([Schema.Boolean, Schema.Struct({ maxCharacters: Schema.Number })])),
  highlights: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.Boolean),
})
export type ExaContentsInput = typeof ExaContentsInput.Type

export const ExaCodeSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.optional(Schema.Literals(["fast", "auto", "neural", "keyword"])),
  numResults: Schema.optional(Schema.Number),
  includeDomains: Schema.optional(Schema.Array(Schema.String)),
  excludeDomains: Schema.optional(Schema.Array(Schema.String)),
  startPublishedDate: Schema.optional(Schema.String),
  endPublishedDate: Schema.optional(Schema.String),
  contents: Schema.optional(ExaContentsInput),
})
export type ExaCodeSearchInput = typeof ExaCodeSearchInput.Type

export const TavilySearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  search_depth: Schema.optional(Schema.Literals(["ultra-fast", "fast", "basic", "advanced"])),
  topic: Schema.optional(Schema.Literals(["general", "news", "finance"])),
  max_results: Schema.optional(Schema.Number),
  time_range: Schema.optional(Schema.Literals(["day", "week", "month", "year"])),
  include_domains: Schema.optional(Schema.Array(Schema.String)),
  exclude_domains: Schema.optional(Schema.Array(Schema.String)),
})
export type TavilySearchInput = typeof TavilySearchInput.Type

export const TavilyExtractInput = Schema.Struct({
  urls: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  extract_depth: Schema.optional(Schema.Literals(["basic", "advanced"])),
  query: Schema.optional(Schema.String),
  chunks_per_source: Schema.optional(Schema.Number),
  format: Schema.optional(Schema.Literals(["markdown", "text"])),
})
export type TavilyExtractInput = typeof TavilyExtractInput.Type
