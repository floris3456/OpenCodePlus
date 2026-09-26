// DESIGN §0, §6, §9.1–2: an agent behaves exactly as its rows say; nothing is
// inferred from its id. (a) the removed name rules are gone from src/; (b) any
// id linked to Plus `orchestrator` resolves exactly like the shipped
// orchestrator; (c) the same id with no preset has every team rule off; (d)
// renaming a member changes nothing but its id.
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { teamsDataDir } from "../src/instructions/paths.js"
import { createTeamApi, type TeamApiResult, type TeamCaller } from "../src/teams/api.js"
import { saveRun, type RunRecord } from "../src/teams/run.js"
import { Brief } from "../src/teams/schema.js"
import { context } from "./harness.js"
import { linked, presetInput, presetTable, resolvedStates, shippedMembers, shippedTeam, teamState, type TeamMember } from "./teams/preset-table.js"

// ── (a) the removed symbols ─────────────────────────────────────────────────

const src = path.resolve(import.meta.dir, "../src")

const forbidden: readonly { readonly what: string; readonly pattern: RegExp; readonly under?: string }[] = [
  { what: "kindOf", pattern: /\bkindOf\b/ },
  { what: "delegatesTo(", pattern: /\bdelegatesTo\(/ },
  { what: "delegatesToAny", pattern: /\bdelegatesToAny\b/ },
  { what: "reachesByDefault", pattern: /\breachesByDefault\b/ },
  { what: "requiresCleanWorktree", pattern: /\brequiresCleanWorktree\b/ },
  { what: "toolsByServer", pattern: /\btoolsByServer\b/ },
  { what: "allowedTeamTools", pattern: /\ballowedTeamTools\b/ },
  { what: "nativePermissions", pattern: /\bnativePermissions\b/ },
  { what: "isImplementerRole", pattern: /\bisImplementerRole\b/ },
  { what: "presetTargetsLine", pattern: /\bpresetTargetsLine\b/ },
  { what: "presetKind", pattern: /\bpresetKind\b/ },
  { what: "E_SPARK", pattern: /\bE_SPARK\b/ },
  { what: "E_REVIEWER", pattern: /\bE_REVIEWER\b/ },
  { what: "suffix matching on a role", pattern: /endsWith\(`-/ },
  { what: "a role read from a substring of an id", pattern: /\.includes\("(planner|orchestrator|implementer|reviewer|scout|build)"\)/ },
  { what: "a shipped member id", pattern: /spark-implementer|muse-implementer|sol-orchestrator|astra-reviewer/, under: "teams" },
  { what: "a role kind literal", pattern: /"(planner|orchestrator|implementer|reviewer|scout)"/, under: "teams" },
]

test("(a) no source file reads a role from an agent's id", async () => {
  const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: src }))
  expect(files.length).toBeGreaterThan(50)
  const found = (
    await Promise.all(
      files.map(async (file) => {
        const text = await Bun.file(path.join(src, file)).text()
        return forbidden
          .filter((rule) => (rule.under === undefined || file.startsWith(`${rule.under}/`)) && rule.pattern.test(text))
          .map((rule) => `${file}: ${rule.what}`)
      }),
    )
  ).flat()
  expect(found).toEqual([])
})

// ── (b)–(d) resolved rows ───────────────────────────────────────────────────

// Every row shared by every agent (the catalogue), by id: what a preset sets.
function sharedStates(input: ReturnType<typeof presetInput>, member: string): Record<string, "on" | "off"> {
  const shared = new Set(input.items.filter((item) => item.agents === undefined).map((item) => item.id))
  return Object.fromEntries(Object.entries(resolvedStates(input, member)).filter(([id]) => shared.has(id)))
}

test("(b) ocp-alice linked to Plus orchestrator gets the orchestrator's rows, row for row", () => {
  const input = presetInput({ members: [linked("ocp-alice", "orchestrator"), linked("sol-orchestrator", "orchestrator")] })
  const alice = sharedStates(input, "ocp-alice")
  expect(Object.keys(alice).length).toBeGreaterThan(200)
  expect(alice).toEqual(sharedStates(input, "sol-orchestrator"))
  // And that is the old orchestrator role.
  const old: Record<string, "on" | "off"> = {
    "tool:shell": "on",
    "tool:question": "off",
    "tool:subagent": "off",
    "tool:team_checkpoint": "off",
    "tool:team_delegate": "on",
    "tool:team_integrate": "on",
    "tool:search_tavily_search": "on",
    "perm:read:where.external": "on",
    "perm:read:files.keys": "off",
    "perm:read:env": "off",
    "perm:grep:files.env": "off",
    "perm:shell:git-push": "off",
    "perm:shell:commands.git-changes": "off",
    "perm:shell:commands.file-writes": "off",
    "perm:team_status:runs.others": "on",
    "perm:team_wait:runs.descendants": "on",
    "perm:team_list:runs.others": "off",
    "perm:team_followup:runs.descendants": "off",
    "perm:team_finish:requirements.clean": "off",
    "perm:team_get_context:bootstrap.chat": "on",
    "perm:team_delegate:access.delegated": "on",
    "perm:team_get_context:accepts.reason": "on",
    "perm:team_get_context:accepts.scope-paths": "off",
    "perm:team_get_context:accepts.followup": "on",
    "perm:team_delegate:approval.every": "off",
  }
  expect(Object.fromEntries(Object.keys(old).map((id) => [id, alice[id]]))).toEqual(old)
})

test("(c) ocp-alice with no preset has every team rule, tool and secret row off", () => {
  const input = presetInput({ members: [{ id: "ocp-alice", team: shippedTeam }, linked("sol-orchestrator", "orchestrator")] })
  const states = resolvedStates(input, "ocp-alice")
  const rules = Object.entries(states).filter(
    ([id]) => id.startsWith("tool:") || /^perm:(team_\w+|shell|read|grep|edit):/.test(id),
  )
  expect(rules.length).toBeGreaterThan(100)
  expect(rules.filter(([, state]) => state === "on")).toEqual([])
})

let tmp = ""
let root = ""
const priorDataHome = process.env.XDG_DATA_HOME

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plus-no-name-"))
  process.env.XDG_DATA_HOME = tmp
  root = teamsDataDir()
})

afterEach(async () => {
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  if (priorDataHome !== undefined) process.env.XDG_DATA_HOME = priorDataHome
  await fs.rm(tmp, { recursive: true, force: true })
})

function apiFor(members: readonly TeamMember[]) {
  const session = { create: () => Effect.succeed({ id: Session.ID.make("ses_x") }), prompt: () => Effect.succeed(undefined as never) } as unknown as SessionDomain
  return createTeamApi(context({ session }), teamState(presetTable({ members })))
}

function run(overrides: Partial<RunRecord> & { id: string; role: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    kind: "main",
    repo: "opencode",
    repoKey: "opencode",
    directory: path.join(tmp, "no-worktree"),
    paths: [],
    branch: "team/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "no-name-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function callerFor(record: RunRecord): TeamCaller {
  return { sessionID: String(record.sessionID ?? "ses_unknown"), agent: record.role, run: record }
}

function rejected(result: TeamApiResult) {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`)
  return result.error
}

function brief(role: string): Brief {
  return Schema.decodeUnknownSync(Brief)({
    requestID: "req-1",
    role,
    objective: "Fix the agent filter in the query module so scoped listing works as documented.",
    deliverable: { kind: "commit" },
    scope: { paths: ["packages/plus/src/*"] },
    checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] }],
    repo: "not-a-configured-repo",
  })
}

test("(c) ocp-alice with no preset: the team tools refuse her, and name the rule that does", async () => {
  const alice: TeamMember = { id: "ocp-alice", team: shippedTeam }
  const members = [...shippedMembers(), alice]
  const api = apiFor(members)
  const own = run({ id: "main-0123456789abcdef", role: alice.id, sessionID: "ses_alice" })
  const stranger = run({ id: "w-bbbbbbbbbbbbbbbb", kind: "w", role: "muse-implementer", parent: "main-ffffffffffffffff" })
  const orchestrator = run({ id: "main-1111111111111111", role: "sol-orchestrator", children: ["w-cccccccccccccccc"], sessionID: "ses_sol" })
  const child = run({
    id: "w-cccccccccccccccc",
    kind: "w",
    role: alice.id,
    parent: orchestrator.id,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
  })
  for (const record of [own, stranger, orchestrator, child]) await saveRun(root, record)

  // Delegate to: every row off.
  const delegate = rejected(await api.delegate(brief("muse-implementer"), callerFor(own)))
  expect([delegate.code, delegate.message]).toEqual(["E_ROLE", "ocp-alice may not delegate. No member is open to you for delegation."])
  // Runs: another run is out of reach.
  expect(rejected(await api.status({ runs: [stranger.id] }, callerFor(own))).code).toBe("E_NOT_VISIBLE")
  // Corrections by followup: off, with the row's words.
  const followup = rejected(await api.followup({ run: child.id, requestID: "f-1", prompt: "again" }, callerFor(orchestrator)))
  expect(followup.code).toBe("E_NO_FOLLOWUP")
  expect(followup.message).toStartWith("ocp-alice takes no corrections by followup: delegate a fresh run with team_delegate and point it at the previous report")
  // The shipped orchestrator may not delegate to her either: her id is in no preset.
  expect(rejected(await api.delegate(brief(alice.id), callerFor(orchestrator))).message).toContain(`sol-orchestrator may not delegate to "ocp-alice"`)
})

test("(d) renaming a member changes nothing but its id", async () => {
  const renamed = shippedMembers().map((member) => (member.id === "sol-orchestrator" ? { ...member, id: "anything-at-all" } : member))
  const before = resolvedStates(presetInput(), "sol-orchestrator")
  const after = resolvedStates(presetInput({ members: renamed }), "anything-at-all")
  expect(after).toEqual(before)
  // The handlers answer it the same way: past the role gates to the repository check.
  const caller = run({ id: "main-0123456789abcdef", role: "anything-at-all", sessionID: "ses_renamed" })
  await saveRun(root, caller)
  const refusal = rejected(await apiFor(renamed).delegate(brief("muse-implementer"), callerFor(caller)))
  expect(refusal.code).toBe("E_REPO")
  const original = run({ id: "main-1111111111111111", role: "sol-orchestrator", sessionID: "ses_sol" })
  await saveRun(root, original)
  expect(rejected(await apiFor(shippedMembers()).delegate(brief("muse-implementer"), callerFor(original))).code).toBe("E_REPO")
})
