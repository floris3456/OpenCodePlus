import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import {
  AttemptState,
  AttemptStates,
  Brief,
  BudgetOverBy,
  CheckInput,
  CheckpointInput,
  DiffInput,
  ExaCodeSearchInput,
  FollowupBudget,
  FollowupInput,
  GetContextInput,
  IntegrateInput,
  ListInput,
  MergeState,
  MergeStates,
  MetricsInput,
  Policy,
  Report,
  ReportStatus,
  ReportStatuses,
  ReviewInput,
  RunID,
  RunState,
  RunStates,
  StatusInput,
  StopInput,
  TaskID,
  TaskState,
  TaskStates,
  TavilyExtractInput,
  TavilySearchInput,
  ToolError,
  WorktreeState,
  WorktreeStates,
  budgetDimensions,
  budgetExhaustion,
  parseDuration,
  pathList,
  toolError,
  validateChecks,
  validateSummary,
  type Check,
} from "../../src/teams/schema.js"

function roundTrip<S extends Schema.ConstraintDecoder<unknown>>(
  name: string,
  schema: S,
  values: ReadonlyArray<S["Encoded"]>,
): void {
  test(`${name} values round-trip`, () => {
    for (const value of values) expect(Schema.decodeUnknownSync(schema)(value)).toBe(value)
    expect(Option.isNone(Schema.decodeUnknownOption(schema)("nope-not-a-state"))).toBe(true)
  })
}

roundTrip("RunState", RunState, RunStates)
roundTrip("AttemptState", AttemptState, AttemptStates)
roundTrip("TaskState", TaskState, TaskStates)
roundTrip("MergeState", MergeState, MergeStates)
roundTrip("ReportStatus", ReportStatus, ReportStatuses)
roundTrip("WorktreeState", WorktreeState, WorktreeStates)

test("identity primitives accept and reject", () => {
  expect(Schema.decodeUnknownSync(RunID)("w-0123456789abcdef")).toBe("w-0123456789abcdef")
  expect(Schema.decodeUnknownSync(RunID)("main-0123456789abcdef")).toBe("main-0123456789abcdef")
  expect(Option.isNone(Schema.decodeUnknownOption(RunID)("x-1"))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(TaskID)("nope"))).toBe(true)
  expect(Schema.decodeUnknownSync(TaskID)("T3")).toBe("T3")
  expect(Schema.decodeUnknownSync(TaskID)("T3.rework.1")).toBe("T3.rework.1")
})

// Who may be delegated to is each member's "Delegate to" rows; the team
// schema names no role and no member.
test("the policy defaults carry no roles and no member names", () => {
  const policy = Schema.decodeUnknownSync(Policy)({})
  expect("roles" in policy).toBe(false)
  expect(JSON.stringify(policy)).not.toMatch(/implementer|orchestrator|planner|reviewer|scout/)
})

const briefBase = {
  requestID: "T1-a",
  role: "muse-implementer" as const,
  objective: "Make the agent filter apply in the list tool output.",
  deliverable: { kind: "commit" as const },
  scope: { paths: ["packages/plus/src/x.ts"], forbidden: [] as string[] },
}

test("Brief.prompt of 4001 chars is rejected", () => {
  expect(Option.isNone(Schema.decodeUnknownOption(Brief)({ ...briefBase, prompt: "x".repeat(4001) }))).toBe(true)
  const decoded = Schema.decodeUnknownSync(Brief)({ ...briefBase, prompt: "x".repeat(4000) })
  expect(decoded.prompt?.length).toBe(4000)
  // Defaults apply on decode: checks, effort, scope.forbidden, interfaces, decisions.
  expect(decoded.checks).toEqual([])
  expect(decoded.effort).toBe("medium")
  expect(decoded.scope.forbidden).toEqual([])
  expect(decoded.interfaces).toEqual([])
  expect(decoded.decisions).toEqual([])
})

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")

test("Report status tells a worker to block on files or checks outside scope", () => {
  expect(Schema.toJsonSchemaDocument(Report.fields.status).schema.description).toContain(
    "Work that still needs a file or check outside your scope is not done: blocked, with one need per file (path) or check.",
  )
})

function caught(fn: () => unknown): Promise<unknown> {
  return Promise.resolve().then(fn).then(
    () => undefined,
    (error: unknown) => error,
  )
}

test("validateSummary accepts 40 commit lines and rejects 41 with E_SUMMARY", async () => {
  expect(() => validateSummary(lines(27), "commit")).not.toThrow()
  expect(() => validateSummary(lines(40), "commit")).not.toThrow()
  const thrown = await caught(() => validateSummary(lines(41), "commit"))
  expect(thrown).toMatchObject({
    code: "E_SUMMARY",
    message: "summary is 41 lines (max 40). Detail goes to the report file automatically; keep the summary to what the parent must act on.",
    accepted: "a summary of ≤40 lines",
  })
  expect(() => validateSummary(lines(40), undefined)).not.toThrow()
  // Answers share the same limit, with their locations in findings.
  expect(() => validateSummary(lines(40), "report")).not.toThrow()
  expect(await caught(() => validateSummary(lines(41), "findings"))).toMatchObject({
    code: "E_SUMMARY",
    message: "summary is 41 lines (max 40). Detail goes to the report file automatically; keep the summary to what the parent must act on, and put each located item in findings instead.",
  })
})

test("teams/schema exports every tool input schema as the single source", () => {
  const toolSchemas = [
    Brief,
    Report,
    FollowupInput,
    ReviewInput,
    IntegrateInput,
    CheckpointInput,
    StopInput,
    StatusInput,
    DiffInput,
    ListInput,
    GetContextInput,
    CheckInput,
    MetricsInput,
    ExaCodeSearchInput,
    TavilySearchInput,
    TavilyExtractInput,
  ]
  expect(toolSchemas).toHaveLength(16)
  for (const s of toolSchemas) {
    expect(Schema.isSchema(s)).toBe(true)
  }
})

test("StopInput parses run, optional force and an optional reason of at most 300 characters", () => {
  expect(Schema.decodeUnknownSync(StopInput)({ run: "w-0123456789abcdef" })).toEqual({
    run: "w-0123456789abcdef",
  })
  expect(Schema.decodeUnknownSync(StopInput)({ run: "w-0123456789abcdef", force: true })).toEqual({
    run: "w-0123456789abcdef",
    force: true,
  })
  expect(Schema.decodeUnknownSync(StopInput)({ run: "w-0123456789abcdef", force: false })).toEqual({
    run: "w-0123456789abcdef",
    force: false,
  })
  expect(() => Schema.decodeUnknownSync(StopInput)({ run: "w-0123456789abcdef", force: "true" })).toThrow()
  expect(Schema.decodeUnknownSync(StopInput)({ run: "w-0123456789abcdef", reason: "Its quota ran out." })).toEqual({
    run: "w-0123456789abcdef",
    reason: "Its quota ran out.",
  })
  expect(() => Schema.decodeUnknownSync(StopInput)({ run: "w-0123456789abcdef", reason: "" })).toThrow()
  expect(() => Schema.decodeUnknownSync(StopInput)({ run: "w-0123456789abcdef", reason: "x".repeat(301) })).toThrow()
})

const ACCEPTED = { id: "plus-tests", argv: ["bun", "test", "test/model.test.ts"] }

describe("pathList", () => {
  test("names every path up to the limit, unchanged", () => {
    expect(pathList([])).toBe("")
    expect(pathList(["a.ts"])).toBe("a.ts")
    expect(pathList(["a.ts", "b.ts", "c.ts"])).toBe("a.ts, b.ts, c.ts")
    expect(pathList(Array.from({ length: 50 }, (_, i) => `f${i}.ts`))).toBe(Array.from({ length: 50 }, (_, i) => `f${i}.ts`).join(", "))
  })

  test("names the first 50 and counts the rest", () => {
    const paths = Array.from({ length: 51 }, (_, i) => `f${i}.ts`)
    expect(pathList(paths)).toBe(`${paths.slice(0, 50).join(", ")} and 1 more`)
    expect(pathList(Array.from({ length: 60 }, (_, i) => `f${i}.ts`))).toBe(`${Array.from({ length: 50 }, (_, i) => `f${i}.ts`).join(", ")} and 10 more`)
  })

  test("honours a custom limit", () => {
    expect(pathList(["a.ts", "b.ts", "c.ts"], 2)).toBe("a.ts, b.ts and 1 more")
    expect(pathList(["a.ts", "b.ts"], 2)).toBe("a.ts, b.ts")
  })
})

describe("validateChecks", () => {
  test("rejects bare bun test with E_CHECKS and accepted", async () => {
    const thrown = await caught(() => validateChecks([{ id: "x", argv: ["bun", "test"] }]))
    expect(thrown).toMatchObject({ code: "E_CHECKS" })
    expect(thrown).toMatchObject({
      message: "Checks must be explicit bun test FILE or bun run SCRIPT commands. Whole-suite bun test is not permitted.",
      accepted: ACCEPTED,
    })
    expect(JSON.parse(JSON.stringify(thrown))).toMatchObject({ code: "E_CHECKS" })
  })

  test("rejects bun run with a path, not a named script", async () => {
    const thrown = await caught(() => validateChecks([{ id: "x", argv: ["bun", "run", "scripts/build.ts"] }]))
    expect(thrown).toMatchObject({
      code: "E_CHECKS",
      message: "Use a named package script, not an external executable or path",
      accepted: ACCEPTED,
    })
  })

  test("accepts a named script with relative cwd", () => {
    validateChecks([{ id: "x", argv: ["bun", "run", "build"], cwd: "scripts" }])
  })

  test("accepts an explicit test file and a directory", () => {
    validateChecks([
      { id: "a", argv: ["bun", "test", "test/model.test.ts"] },
      { id: "b", argv: ["bun", "test", "test"] },
    ])
  })

  test("rejects duplicate ids, oversize arrays, bad ids, flags, NUL, and bad cwd", async () => {
    const dup = await caught(() =>
      validateChecks([
        { id: "x", argv: ["bun", "run", "build"] },
        { id: "x", argv: ["bun", "run", "build"] },
      ]),
    )
    expect(dup).toMatchObject({ code: "E_CHECKS", message: "Checks need distinct short IDs.", accepted: ACCEPTED })

    const many: Check[] = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, argv: ["bun", "run", "build"] }))
    const over = await caught(() => validateChecks(many))
    expect(over).toMatchObject({
      code: "E_CHECKS",
      message: "E_CHECKS: Use at most 12 focused checks.",
      accepted: ACCEPTED,
    })

    const badId = await caught(() => validateChecks([{ id: "Bad_ID", argv: ["bun", "run", "build"] }]))
    expect(badId).toMatchObject({ code: "E_CHECKS", message: "Checks need distinct short IDs." })

    const dotted = await caught(() => validateChecks([{ id: "x", argv: ["bun", "test", "app.js"] }]))
    expect(dotted).toMatchObject({
      code: "E_CHECKS",
      message: "Tests must name explicit test files or directories inside the worktree.",
    })

    const flags = await caught(() => validateChecks([{ id: "x", argv: ["bun", "test", "--watch", "test/a.test.ts"] }]))
    expect(flags).toMatchObject({ code: "E_CHECKS", message: "Use explicit test files without runtime-loading flags" })

    const nul = await caught(() => validateChecks([{ id: "x", argv: ["bun", "run", "build", "x\0y"] }]))
    expect(nul).toMatchObject({ code: "E_CHECKS", message: "Invalid check argument." })

    const cwd = await caught(() => validateChecks([{ id: "x", argv: ["bun", "run", "build"], cwd: "/tmp" }]))
    expect(cwd).toMatchObject({ code: "E_CHECKS", message: "Check cwd must remain inside the task worktree." })
  })
})

test("Policy.parse({}) yields documented defaults", () => {
  const policy = Schema.decodeUnknownSync(Policy)({})
  expect(policy.bounds.inFlight).toBe(4)
  expect(policy.bounds.members).toBe(12)
  expect(policy.bounds.maxDepth).toBe(3)
  expect(policy.bounds.defaultTurns).toBe(200)
  expect(policy.bounds.defaultWallMs).toBe(5400000)
  expect(policy.timeouts.stallMs).toBe(600000)
  expect(policy.sweep.tickMs).toBe(2000)
  expect(policy.integrate.auto).toBe(false)
  expect(policy.retry.baseMs).toBe(10000)
  expect(policy.effort.medium.turns).toBe(60)
})

test("toolError returns a plain JSON-safe object", () => {
  const err = toolError("E_REPO", "bad repo", "opencode")
  expect(err).not.toBeInstanceOf(Error)
  expect(Schema.decodeUnknownSync(ToolError)(err)).toEqual(err)
  expect(JSON.parse(JSON.stringify(err))).toEqual(err)
  expect(toolError("E_REPO", "bad repo")).toEqual({ code: "E_REPO", message: "bad repo" })
})

test("F1.2 followup.budget parses and is optional", () => {
  expect(Schema.decodeUnknownSync(FollowupBudget)({ turns: 200 })).toEqual({ turns: 200 })
  expect(Schema.decodeUnknownSync(FollowupBudget)({ turns: 200, tokens: 100, wallMs: 60000 })).toEqual({
    turns: 200,
    tokens: 100,
    wallMs: 60000,
  })
  expect(Option.isNone(Schema.decodeUnknownOption(FollowupBudget)({ turns: -1 }))).toBe(true)
})

test("F1.2 status.budget overBy/exhausted math", () => {
  expect(Schema.decodeUnknownSync(BudgetOverBy)({ turns: 1, tokens: 0, wallMs: 0 })).toEqual({
    turns: 1,
    tokens: 0,
    wallMs: 0,
  })
  const over = budgetExhaustion(
    { attempts: [{}, {}, {}], budget: { turns: 2 }, createdAt: new Date().toISOString() },
    { now: Date.now() },
  )
  expect(over.overBy.turns).toBe(1)
  expect(over.exhausted).toBe(true)
  const under = budgetExhaustion(
    { attempts: [{}], budget: { turns: 2 }, createdAt: new Date().toISOString() },
    { now: Date.now() },
  )
  expect(under.overBy).toEqual({ turns: 0, tokens: 0, wallMs: 0 })
  expect(under.exhausted).toBe(false)
})

test("the wall budget counts attempt time, not run age while a settled run waits", () => {
  const settledAt = Date.parse("2026-10-27T14:08:00Z")
  const attempt = { startedAt: "2026-10-27T14:05:00Z", endedAt: "2026-10-27T14:08:00Z" }
  const settled = {
    attempts: [attempt],
    budget: { wallMs: 1_200_000 },
    createdAt: "2026-10-27T14:05:00Z",
  }
  expect(budgetDimensions(settled, { now: settledAt }).find((d) => d.name === "wall")?.used).toBe(180_000)
  // 47 minutes later the settled run has not spent another millisecond.
  expect(budgetDimensions(settled, { now: settledAt + 47 * 60_000 }).find((d) => d.name === "wall")?.used).toBe(180_000)
  expect(budgetExhaustion(settled, { now: settledAt + 47 * 60_000 }).exhausted).toBe(false)

  // An open attempt counts to now; earlier attempts keep their measured time.
  const running = {
    attempts: [attempt, { startedAt: "2026-10-27T14:54:00Z" }],
    budget: { wallMs: 1_200_000 },
    createdAt: "2026-10-27T14:05:00Z",
  }
  expect(budgetDimensions(running, { now: settledAt + 47 * 60_000 }).find((d) => d.name === "wall")?.used).toBe(240_000)
})

describe("parseDuration", () => {
  test("parses single unit durations", () => {
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000)
    expect(parseDuration("1day")).toBe(24 * 60 * 60 * 1000)
    expect(parseDuration("2days")).toBe(2 * 24 * 60 * 60 * 1000)
    expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000)
    expect(parseDuration("1hour")).toBe(60 * 60 * 1000)
    expect(parseDuration("2hours")).toBe(2 * 60 * 60 * 1000)
    expect(parseDuration("30m")).toBe(30 * 60 * 1000)
    expect(parseDuration("10min")).toBe(10 * 60 * 1000)
    expect(parseDuration("15minutes")).toBe(15 * 60 * 1000)
    expect(parseDuration("60s")).toBe(60 * 1000)
    expect(parseDuration("10sec")).toBe(10 * 1000)
    expect(parseDuration("5seconds")).toBe(5 * 1000)
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("0s")).toBe(0)
  })

  test("parses compound and decimal durations", () => {
    expect(parseDuration("7d12h")).toBe(7 * 24 * 3600000 + 12 * 3600000)
    expect(parseDuration("1d 2h 30m")).toBe(24 * 3600000 + 2 * 3600000 + 30 * 60000)
    expect(parseDuration("1.5h")).toBe(90 * 60000)
    expect(parseDuration(" 2h ")).toBe(2 * 3600000)
  })

  test("throws E_DURATION on invalid input", () => {
    expect(() => parseDuration("")).toThrow()
    expect(() => parseDuration("foo")).toThrow()
    expect(() => parseDuration("7")).toThrow()
    expect(() => parseDuration("-5d")).toThrow()
    try {
      parseDuration("invalid")
    } catch (e: any) {
      expect(e.code).toBe("E_DURATION")
    }
  })
})
