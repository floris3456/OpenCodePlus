import { Effect, Schema } from "effect"

/**
 * Removes explicit null for optional fields in an input, at every depth:
 * struct fields, array elements, and fields behind optional/default wrappers
 * all follow the same rule. Required fields keep their null so decoding still
 * fails with a schema error.
 */
export function stripNullForOptional(schema: Schema.Constraint, input: unknown): unknown {
  return stripNulls(input, schema)
}

function stripNulls(input: unknown, schema: Schema.Constraint): unknown {
  if (input === null || typeof input !== "object") return input
  if (Array.isArray(input)) {
    return input.map((item, index) => {
      const element = elementAt(schema, index)
      return element === undefined ? item : stripNulls(item, element)
    })
  }
  const struct = structOf(schema)
  if (struct === undefined) return input
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const field = struct.fields[key]
    if (field === undefined) {
      out[key] = value
      continue
    }
    if (value === null && acceptsAbsent(field)) continue
    out[key] = stripNulls(value, field)
  }
  return out
}

// A field takes null as absent when undefined already decodes there. That is
// exactly what Schema.optional does: its schema is a union with Undefined, and
// the local `field` default composes from Schema.optional.
function acceptsAbsent(schema: Schema.Constraint): boolean {
  if (isUnionSchema(schema)) {
    return schema.members.some((member) => member === Schema.Undefined || acceptsAbsent(member))
  }
  if (isComposedSchema(schema)) return acceptsAbsent(schema.from)
  if (isOptionalSchema(schema)) return acceptsAbsent(schema.schema)
  return false
}

interface StructSchema {
  readonly fields: Record<string, Schema.Constraint>
}

interface ArraySchema {
  readonly value: Schema.Constraint
}

interface TupleSchema {
  readonly elements: ReadonlyArray<Schema.Constraint>
}

interface UnionSchema {
  readonly members: ReadonlyArray<Schema.Constraint>
}

interface ComposedSchema {
  readonly from: Schema.Constraint
}

interface OptionalSchema {
  readonly schema: Schema.Constraint
}

function isStructSchema(schema: Schema.Constraint): schema is Schema.Constraint & StructSchema {
  return "fields" in schema
}

function isArraySchema(schema: Schema.Constraint): schema is Schema.Constraint & ArraySchema {
  return "value" in schema
}

function isTupleSchema(schema: Schema.Constraint): schema is Schema.Constraint & TupleSchema {
  return "elements" in schema
}

function isUnionSchema(schema: Schema.Constraint): schema is Schema.Constraint & UnionSchema {
  return "members" in schema
}

function isComposedSchema(schema: Schema.Constraint): schema is Schema.Constraint & ComposedSchema {
  return "from" in schema
}

function isOptionalSchema(schema: Schema.Constraint): schema is Schema.Constraint & OptionalSchema {
  return "schema" in schema
}

// The schema that describes an object value's shape, reached through optional
// and composition wrappers (a default wrapper composes from Schema.optional).
function structOf(schema: Schema.Constraint): (Schema.Constraint & StructSchema) | undefined {
  if (isStructSchema(schema)) return schema
  if (isComposedSchema(schema)) {
    const found = structOf(schema.from)
    if (found !== undefined) return found
  }
  if (isOptionalSchema(schema)) {
    const found = structOf(schema.schema)
    if (found !== undefined) return found
  }
  if (isUnionSchema(schema)) {
    for (const member of schema.members) {
      const found = structOf(member)
      if (found !== undefined) return found
    }
  }
  return undefined
}

// The schema of one array element, reached through the same wrappers.
function elementAt(schema: Schema.Constraint, index: number): Schema.Constraint | undefined {
  if (isArraySchema(schema)) return schema.value
  if (isTupleSchema(schema)) return schema.elements[index] ?? schema.elements.at(-1)
  if (isComposedSchema(schema)) return elementAt(schema.from, index)
  if (isOptionalSchema(schema)) return elementAt(schema.schema, index)
  if (isUnionSchema(schema)) {
    for (const member of schema.members) {
      const found = elementAt(member, index)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * Shared schema helper for tool boundaries: decodes explicit null as absent/omitted
 * for any optional fields while preserving strict schema failure for required fields.
 */
export function nullTolerant<S extends Schema.Constraint>(schema: S): S {
  const origAst = schema.ast as any
  const wrappedAst = Object.create(origAst, {
    getParser: {
      value: function (compile: any, compileConstructorDefault: any) {
        const innerParser = origAst.getParser(compile, compileConstructorDefault)
        return (input: unknown, options: any) => {
          const cleaned = stripNullForOptional(schema, input)
          return innerParser(cleaned, options)
        }
      },
    },
  })
  const s = Schema.make(wrappedAst) as any
  if ("fields" in schema) {
    s.fields = (schema as any).fields
  }
  return s
}

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

export const ModelIdentity = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
})
export type ModelIdentity = typeof ModelIdentity.Type

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
  id: Schema.String.annotate({ description: "Short kebab-case id, e.g. \"unit\"." }),
  argv: Schema.Array(Schema.String).annotate({
    description: "[\"bun\",\"test\",<test file or directory>] or [\"bun\",\"run\",<package script>]; no other command runs.",
  }),
  cwd: Schema.optional(Schema.String).annotate({ description: "Repository-relative directory to run in; omit for the root." }),
})
export type Check = typeof Check.Type

export const ChecksArray = Schema.Array(Check).annotate({
  description: "Focused checks (at most 12); each must pass at HEAD for done.",
})
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
  kind: Schema.Literals(["commit", "report", "plan", "findings"]).annotate({
    description:
      "commit: committed changes you land with team_integrate. report: an answer. plan: a committed plan file. findings: a review.",
  }),
  format: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description: "Shape of the result, e.g. \"file:line list\".",
  }),
})
export type Deliverable = typeof Deliverable.Type

export const Interface = Schema.Struct({
  path: Schema.String,
  symbol: Schema.optional(Schema.String),
  note: Schema.String.check(Schema.isMaxLength(200)).annotate({ description: "Why the child must read it." }),
})
export type Interface = typeof Interface.Type

export const Need = Schema.Struct({
  kind: Schema.Literals(["path", "check", "info", "decision"]).annotate({
    description: "path: a file outside your scope. check: a failing or missing check. info: missing information. decision: a choice your parent must make.",
  }),
  detail: Schema.String.check(Schema.isMaxLength(300)).annotate({ description: "Exactly what you need and why." }),
})
export type Need = typeof Need.Type

// Field descriptions reach the model with the tool's schema: they carry how a
// value must look, so the role texts carry only when and why to delegate. A
// description on a defaulted field lands in its non-null branch, which the
// provider still receives.
export const Brief = Schema.Struct({
  requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)).annotate({
    description: "Your id for this call, e.g. \"auth-fix-1\"; reusing it with identical input returns the first result.",
  }),
  // Any member id: who may delegate to whom is the caller's "Delegate to"
  // rows, not a fixed list, and each agent's team_delegate schema lists the
  // members open to it.
  role: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({ description: "The member to delegate to." }),
  task: Schema.optional(TaskID).annotate({
    description: "Only to claim the rework task team_integrate returned after a conflict or red checks, e.g. \"T3.rework.1\". Omit otherwise.",
  }),
  objective: Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(600)).annotate({
    description: "The outcome to reach. The child knows only this Brief and what it reads.",
  }),
  deliverable: Deliverable.annotate({ description: "What the child hands back." }),
  scope: Schema.Struct({
    paths: field(
      Schema.Array(Schema.String)
        .check(Schema.isMaxLength(40))
        .annotate({ description: "Files or dir/* the child may edit, repository-relative. Empty: it edits nothing." }),
      () => [],
    ),
    forbidden: field(
      Schema.Array(Schema.String)
        .check(Schema.isMaxLength(20))
        .annotate({ description: "Paths it must not touch, even inside paths." }),
      () => [],
    ),
  }).annotate({ description: "What the child may edit." }),
  context: field(
    Schema.Struct({
      interfaces: field(
        Schema.Array(Interface)
          .check(Schema.isMaxLength(20))
          .annotate({ description: "Code the child must read before changing anything." }),
        () => [],
      ),
      decisions: field(
        Schema.Array(Schema.String.check(Schema.isMaxLength(300)))
          .check(Schema.isMaxLength(20))
          .annotate({ description: "Choices already made, so the child does not reopen them." }),
        () => [],
      ),
    }).annotate({ description: "What the child must know before it starts." }),
    () => ({ interfaces: [], decisions: [] }),
  ),
  checks: field(ChecksArray, () => []),
  effort: field(
    Schema.Literals(["small", "medium", "large"]).annotate({
      description: "small ≈ 1 file, medium ≈ 2–5 files, large ≈ a package; sets an advisory budget.",
    }),
    () => "medium" as const,
  ),
  repo: Schema.optional(Schema.String).annotate({ description: "Another configured repository; omit for yours." }),
  base: Schema.optional(Schema.String).annotate({ description: "Commit or branch the child starts from; omit for your HEAD." }),
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))).annotate({
    description: "Extra instructions appended to the Brief.",
  }),
  briefFile: Schema.optional(Schema.String).annotate({
    description:
      "A file in your checkout attached to the Brief (inline up to 40 KB): the only way an uncommitted file reaches the child.",
  }),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(300))).annotate({
    description: "Why this work needs its own run; an orchestrator requires one.",
  }),
})
export type Brief = typeof Brief.Type

// Report building blocks (docs/team-v2/03-tools.md §finish).
export const Finding = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "note"]).annotate({
    description: "error: a demonstrated defect. warning: a risk or missing test. note: a located fact (a scout's answer).",
  }),
  path: Schema.String.annotate({ description: "file:line" }),
  detail: Schema.String.annotate({ description: "Evidence and practical effect; one line for a note." }),
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
  status: Schema.Literals(["done", "done_with_concerns", "blocked", "needs_context", "rejected"]).annotate({
    description:
      "done: complete, assigned checks passing at HEAD (finish runs any not yet run), commit work committed. done_with_concerns: complete but unsure, or uncommitted files named in deferred. blocked, needs_context (information missing) and rejected (outside your role or scope) need at least one entry in needs.",
  }),
  summary: Schema.String.check(Schema.isMaxLength(1500)).annotate({
    description: "What your parent must act on, at most 15 lines; it receives it in full.",
  }),
  concerns: field(
    Schema.Array(Schema.String.check(Schema.isMaxLength(300)))
      .check(Schema.isMaxLength(10))
      .annotate({ description: "Doubts about correctness, and bugs you fixed inside your scope." }),
    () => [],
  ),
  needs: field(Schema.Array(Need).check(Schema.isMaxLength(10)).annotate({ description: "What you need to go on." }), () => []),
  findings: field(
    Schema.Array(Finding).check(Schema.isMaxLength(50)).annotate({ description: "Review findings, or located items for a lookup." }),
    () => [],
  ),
  deferred: field(
    Schema.Array(Schema.String.check(Schema.isMaxLength(200)))
      .check(Schema.isMaxLength(10))
      .annotate({ description: "In-scope items you deliberately left undone, each with its reason." }),
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

export const WorktreeStates = ["present", "removed", "dirty"] as const
export const WorktreeState = Schema.Literals(WorktreeStates)
export type WorktreeState = typeof WorktreeState.Type

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
//
// Both are optional additions: omitting them validates exactly as before.
//
// Single home of the "how far over budget" math (F1.4b): budgetDimensions
// computes the per-dimension usage (turns = attempts.length, tokens = live
// session tokensUsed, wall = run age, or attempt age when only the sweeper's
// advisory wall fallback is configured). budgetExhaustion is the thin
// overBy/exhausted wrapper used by status; sweeper.ts notifyBudget calls
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

const DURATION_RE = /^\s*(?:(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)\s*)+$/i
const DURATION_PART_RE = /(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)/gi

const UNIT_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
}

export function parseDuration(raw: string): number {
  const trimmed = raw.trim()
  if (trimmed === "" || !DURATION_RE.test(trimmed)) {
    throw toolError(
      "E_DURATION",
      `Invalid duration "${raw}". Expected format like "7d", "24h", "30m", "60s", or "500ms".`,
      "7d",
    )
  }
  let totalMs = 0
  for (const match of trimmed.matchAll(DURATION_PART_RE)) {
    const val = parseFloat(match[1])
    const unit = match[2].toLowerCase()
    const mult = UNIT_MULTIPLIERS[unit] ?? 0
    totalMs += val * mult
  }
  return Math.round(totalMs)
}

// Tool input schemas (docs/team-v2/03-tools.md). Every tool has exactly one
// input schema, exported from here and shared between registration and handlers.
export const FollowupInput = Schema.Struct({
  run: RunID.annotate({ description: "Your child's run id." }),
  requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)).annotate({
    description: "Your id for this followup; repeat it only to retry the identical call.",
  }),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)).annotate({
    description: "The correction or answer; it is the child's next message.",
  }),
  delivery: Schema.optional(Schema.Literals(["now", "queue"])).annotate({
    description: "queue (default): delivered when the child next goes idle. now: only for a child that is idle already.",
  }),
  budget: Schema.optional(FollowupBudget).annotate({
    description: "Replaces the child's advisory budget; dimensions you omit are cleared.",
  }),
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
  run: RunID.annotate({ description: "The child run whose commits to land." }),
  expectedParentHead: Head.annotate({
    description: "Your own current HEAD (team_get_context head, or the head your last team_integrate returned); never the child's commit.",
  }),
})
export type IntegrateInput = typeof IntegrateInput.Type

export const CheckpointInput = Schema.Struct({
  expectedHead: Head.annotate({
    description: "Your current HEAD: team_get_context head, or the head your last team_checkpoint returned.",
  }),
  files: Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
    description: "Repository-relative files (or directories) to commit: inside your Brief's scope, or in a chat run, files you may edit.",
  }),
  message: Schema.String.check(Schema.isMaxLength(300)).annotate({
    description: "\"<type>(<scope>)?: <subject>\" with type feat, fix, docs, chore, refactor or test.",
  }),
})
export type CheckpointInput = typeof CheckpointInput.Type

export const SetChecksInput = Schema.Struct({
  checks: ChecksArray.annotate({
    description: "Your run's integration checks (replaces the list, at most 12): each landing is verified with them.",
  }),
})
export type SetChecksInput = typeof SetChecksInput.Type

export const SupersedeInput = Schema.Struct({
  run: RunID.annotate({ description: "The child run to abandon." }),
  reason: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(500)).annotate({ description: "Why it is abandoned." }),
  waitMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(120000))).annotate({
    description: "How long a working child may take to stop before it is interrupted (default 30000).",
  }),
})
export type SupersedeInput = typeof SupersedeInput.Type

export const StopInput = Schema.Struct({
  run: RunID.annotate({ description: "The child run to stop." }),
})
export type StopInput = typeof StopInput.Type

export const StatusInput = Schema.Struct({
  runs: Schema.optional(Schema.Array(RunID).check(Schema.isMinLength(1), Schema.isMaxLength(20))).annotate({
    description: "Runs to show; omit for your run and its direct children.",
  }),
})
export type StatusInput = typeof StatusInput.Type

export const DiffInput = Schema.Struct({
  run: RunID.annotate({ description: "Your run or a child's." }),
  from: Schema.optional(Schema.Union([Head, Schema.Literal("base"), Schema.Literal("parent")])).annotate({
    description: "\"base\" (default): the run's starting commit. \"parent\": its parent's HEAD. Or a full commit sha.",
  }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Only these paths." }),
  maxBytes: Schema.optional(Schema.Number).annotate({ description: "Truncate after this many bytes (default 200000)." }),
})
export type DiffInput = typeof DiffInput.Type

export const ListInput = Schema.Struct({
  all: Schema.optional(Schema.Boolean).annotate({ description: "Include superseded and reaped runs." }),
  role: Schema.optional(Schema.String).annotate({ description: "Only this member's runs." }),
  state: Schema.optional(RunState).annotate({ description: "Only runs in this state." }),
  parent: Schema.optional(RunID).annotate({ description: "Only this run's children." }),
})
export type ListInput = typeof ListInput.Type

export const GetContextInput = Schema.Struct({})
export type GetContextInput = typeof GetContextInput.Type

export const CheckInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "One of your assigned check ids." }),
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
