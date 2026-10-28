import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { teamState } from "./preset-table.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { onSessionIdle } from "../../src/teams/lifecycle.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Brief } from "../../src/teams/schema.js"
import { atomicJson, readJson } from "../../src/teams/store.js"
import { git } from "../../src/teams/git.js"
import type { Cooldowns } from "../../src/teams/cooldown.js"
import { Effect, Schema } from "effect"
import type { SessionDomain } from "@opencode/plugin/effect/session"

// Real temp state root (scoped XDG_DATA_HOME, restored afterwards) and real run
// records. The session domain only answers `get`, so the delegate handler's
// worktree and session seams are not exercised here.
async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-cooldown-"))
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp
  try {
    return await fn(path.join(tmp, "opencode", "opencodeplus", "teams"))
  } finally {
    if (prior === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prior
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-team-cooldown",
    paths: [],
    branch: "team/implementer/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "team-cooldown-test",
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

const QUOTA_MODEL = { providerID: "cliproxyapi", modelID: "commandcode/deepseek/deepseek-v4.1-flash" }

// The settling pass prompts an idle parent with the settlement; the harness's
// session domain would die on that call. The prompts are recorded so the
// settlement text can be read where the parent actually receives it.
function settleContext() {
  const prompted: string[] = []
  const domain = {
    prompt: (input: { text: string }) => {
      prompted.push(input.text)
      return Effect.succeed(undefined as never)
    },
  }
  return { prompted, ctx: context({ session: domain }) }
}

function parentAndChild(): { parent: RunRecord; child: RunRecord } {
  const parent = baseRun({ id: "main-0123456789abcdef", role: "orchestrator", kind: "main", sessionID: "ses_parent_cooldown" })
  const child = baseRun({
    id: "w-0123456789abcdef",
    parent: parent.id,
    state: "working",
    sessionID: "ses_child_cooldown",
    requestedModel: QUOTA_MODEL,
    loadedModel: QUOTA_MODEL,
    attempts: [{ n: 1, state: "streaming", startedAt: new Date().toISOString(), trigger: "delegate" }],
  })
  return { parent, child }
}

function required<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

function rejected(result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }) {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`)
  return result.error
}

test("a quota 429 settles the attempt blocked, keeps the error line, and cools the provider", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentAndChild()
    await saveRun(root, parent)
    await saveRun(root, child)
    const settle = settleContext()
    const settled = await onSessionIdle(settle.ctx, root, child, "failed", {
      type: "provider.quota",
      status: 429,
      message: "Quota exceeded. Your limit resets in 3h12m.",
    })
    const attempt = settled.attempts.at(-1)
    expect(attempt?.state).toBe("failed")
    expect(attempt?.error).toEqual({ type: "provider.quota", status: 429, message: "Quota exceeded. Your limit resets in 3h12m." })
    const blockedUntil = Date.parse(attempt?.blockedUntil ?? "")
    expect(Number.isNaN(blockedUntil)).toBe(false)
    // The reset parsed from the message, a little under 3 h 12 min away.
    expect(blockedUntil - Date.now()).toBeGreaterThan(3 * 60 * 60_000)
    expect(blockedUntil - Date.now()).toBeLessThanOrEqual(3 * 60 * 60_000 + 12 * 60_000)

    const cooldowns = await readJson<Cooldowns>(path.join(root, "cooldowns.json"))
    expect(cooldowns).toBeDefined()
    const entry = cooldowns?.["cliproxyapi/commandcode"]
    expect(entry?.untilMs).toBe(blockedUntil)
    expect(entry?.run).toBe(child.id)
    expect(entry?.error).toContain("provider.quota (429): Quota exceeded")
    expect(entry?.at).toBeDefined()

    // The parent's settlement says blocked, the reset, and that it was not retried.
    const text = settle.prompted.join("\n")
    expect(text).toContain("settled: blocked — cliproxyapi/commandcode quota; resets at ")
    expect(text).toContain(". Not retried.")
    expect(text).toContain("next: delegate the Brief to a member on another provider, or follow up after the reset.")
    expect(text).toContain("Error: provider.quota (429): Quota exceeded. Your limit resets in 3h12m.")
  })
})

test("a plain provider.internal 500 settles as before, with no cooldown", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentAndChild()
    await saveRun(root, parent)
    await saveRun(root, child)
    const settle = settleContext()
    const settled = await onSessionIdle(settle.ctx, root, child, "failed", {
      type: "provider.internal",
      status: 500,
      message: "An unexpected error occurred.",
    })
    const attempt = settled.attempts.at(-1)
    expect(attempt?.state).toBe("failed")
    expect(attempt?.blockedUntil).toBeUndefined()
    expect(await Bun.file(path.join(root, "cooldowns.json")).exists()).toBe(false)
    const text = settle.prompted.join("\n")
    expect(text).toContain("Error: provider.internal (500): An unexpected error occurred.")
    expect(text).toContain("next: if the member's model is unavailable (quota, rate limit, provider down)")
  })
})

function delegateInput(overrides?: Record<string, unknown>): Brief {
  return Schema.decodeUnknownSync(Brief)({
    requestID: "req-cooldown",
    role: "implementer",
    objective: "Fix the agent filter in the query module so scoped listing works as documented.",
    deliverable: { kind: "commit" },
    scope: { paths: ["packages/plus/src/*"] },
    checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] }],
    ...overrides,
  })
}

function recordSession() {
  const created: unknown[] = []
  const domain = {
    get: () => Effect.succeed({ id: "ses_child_cooldown" }),
    create: (input: unknown) => {
      created.push(input)
      return Effect.succeed({ id: "ses_child_created" })
    },
    prompt: () => Effect.succeed(undefined as never),
    switchModel: () => Effect.succeed(undefined as never),
    wait: () => Effect.succeed(undefined),
  } as unknown as SessionDomain
  return { created, domain }
}

async function makeRepo(): Promise<{ dir: string; head: string }> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-cooldown-repo-"))
  await git(dir, ["init"])
  await git(dir, ["config", "user.name", "team-test"])
  await git(dir, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# team cooldown test\n")
  await fs.mkdir(path.join(dir, "packages", "plus", "test"), { recursive: true })
  await fs.writeFile(path.join(dir, "packages", "plus", "test", "unit.test.ts"), "// checked by the brief\n")
  await git(dir, ["add", "README.md", "packages/plus/test/unit.test.ts"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  return { dir, head: await git(dir, ["rev-parse", "HEAD"]) }
}

test("a team_delegate to a member on a cooling provider is refused until the reset", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_cooldown_delegate",
      })
      await saveRun(root, parent)
      const untilMs = Date.now() + 3 * 60 * 60_000
      await atomicJson(path.join(root, "cooldowns.json"), {
        "cliproxyapi/commandcode": {
          untilMs,
          text: "15:45 UTC (in 3 h 12 min)",
          error: "provider.quota (429): Quota exceeded.",
          at: new Date().toISOString(),
          run: "w-0123456789abcdef",
        },
      })
      const state = teamState()
      state.activeModels.set("implementer", QUOTA_MODEL)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), state)
      const error = rejected(await api.delegate(delegateInput(), callerFor(parent)))
      expect(error.code).toBe("E_COOLDOWN")
      expect(error.message).toContain("implementer runs on cliproxyapi/commandcode, which is out of quota until ")
      expect(error.message).toContain("(cooldown from run w-0123456789abcdef). Delegate to a member on another provider, or wait.")
      // Nothing was created: no worktree, no session.
      expect(sessions.created).toHaveLength(0)

      // Once the reset has passed, the same delegation is allowed.
      await atomicJson(path.join(root, "cooldowns.json"), {
        "cliproxyapi/commandcode": {
          untilMs: Date.now() - 1,
          text: "09:00 UTC (in 0 h 0 min)",
          error: "provider.quota (429): Quota exceeded.",
          at: new Date().toISOString(),
          run: "w-0123456789abcdef",
        },
      })
      const value = await api.delegate(delegateInput({ requestID: "req-cooldown-2" }), callerFor(parent))
      expect(value.ok).toBe(true)
      expect(sessions.created).toHaveLength(1)
    } finally {
      await fs.rm(repo.dir, { recursive: true, force: true })
    }
  })
}, 30000)

test("a team_followup that would prompt a cooling child is refused with E_COOLDOWN", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentAndChild()
    const stopped = { ...child, state: "stopped" as const }
    await saveRun(root, parent)
    await saveRun(root, stopped)
    const untilMs = Date.now() + 60 * 60_000
    await atomicJson(path.join(root, "cooldowns.json"), {
      "cliproxyapi/commandcode": {
        untilMs,
        text: "13:33 UTC (in 1 h 0 min)",
        error: "provider.quota (429): Quota exceeded.",
        at: new Date().toISOString(),
        run: child.id,
      },
    })
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const error = rejected(
      await api.followup({ run: child.id, requestID: "req-follow", prompt: "Continue where you stopped." }, callerFor(parent)),
    )
    expect(error.code).toBe("E_COOLDOWN")
    expect(error.message).toContain("implementer runs on cliproxyapi/commandcode, which is out of quota until ")
    // A budget change prompts nothing, so it is not refused for the cooldown;
    // it fails later, on the child's missing worktree, which this fixture has.
    const budget = rejected(
      await api.followup({ run: child.id, requestID: "req-budget", budget: { tokens: 1000 }, reason: "tighter" }, callerFor(parent)),
    )
    expect(budget.code).not.toBe("E_COOLDOWN")
    expect((await loadRun(root, child.id))?.state).toBe("stopped")
  })
})

test("team_status names the active cooldown of the run it reports", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { parent, child } = parentAndChild()
    const settled = { ...child, state: "idle" as const }
    await saveRun(root, parent)
    await saveRun(root, settled)
    const untilMs = Date.now() + 90 * 60_000
    await atomicJson(path.join(root, "cooldowns.json"), {
      "cliproxyapi/commandcode": {
        untilMs,
        text: "14:03 UTC (in 1 h 30 min)",
        error: "provider.quota (429): Quota exceeded.",
        at: new Date().toISOString(),
        run: child.id,
      },
    })
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const entries = required(await api.status({ runs: [child.id] }, callerFor(parent))) as Array<{
      cooldown?: { provider: string; untilMs: number; text: string; run: string }
    }>
    expect(entries[0]?.cooldown?.provider).toBe("cliproxyapi/commandcode")
    expect(entries[0]?.cooldown?.untilMs).toBe(untilMs)
    expect(entries[0]?.cooldown?.run).toBe(child.id)
    expect(entries[0]?.cooldown?.text).toBe(
      `${new Date(untilMs).getUTCHours().toString().padStart(2, "0")}:${new Date(untilMs).getUTCMinutes().toString().padStart(2, "0")} UTC (in 1 h 30 min)`,
    )
  })
})
