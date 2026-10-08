import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { teamState } from "./preset-table.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { peek } from "../../src/teams/inbox.js"
import { checkBudgets } from "../../src/teams/lifecycle.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { sessionContextTokens, sessionTokens, sessionTokenUsage } from "../../src/teams/usage.js"
import { render as renderReport } from "../../src/teams/report.js"

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-budget-"))
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp
  try {
    return await fn(path.join(tmp, "opencode", "opencodeplus", "teams"))
  } finally {
    if (prior === undefined) delete process.env.XDG_DATA_HOME
    if (prior !== undefined) process.env.XDG_DATA_HOME = prior
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
    directory: process.cwd(),
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
    bundle: "team-test",
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

test("session token usage leaves out cache reads", async () => {
  const tokens = { input: 100, output: 25, reasoning: 15, cache: { read: 5000, write: 40 } }
  const ctx = context({
    session: {
      get: () => Effect.succeed({ tokens }),
    } as unknown as SessionDomain,
  })
  const run = baseRun({ id: "w-token-test", sessionID: "ses_tokens_1" })
  const used = await sessionTokens(ctx, run)
  expect(used).toBe(180)

  const details = await sessionTokenUsage(ctx, run)
  expect(details).toEqual({ used: 180, cacheRead: 5000 })
})

test("budget notification fires at limit, merges for several children, and repeats after interval", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = Date.now()
    const childA = baseRun({
      id: "w-child-a",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_child_a",
      state: "working",
      budget: { tokens: 100 },
      createdAt: new Date(now - 10000).toISOString(),
      attempts: [{ n: 1, state: "streaming", startedAt: new Date(now - 10000).toISOString(), trigger: "delegate" }],
    })
    const childB = baseRun({
      id: "w-child-b",
      role: "reviewer",
      parent: parent.id,
      sessionID: "ses_child_b",
      state: "working",
      budget: { turns: 1 },
      createdAt: new Date(now - 5000).toISOString(),
      attempts: [
        { n: 1, state: "failed", startedAt: new Date(now - 5000).toISOString(), trigger: "delegate" },
        { n: 2, state: "streaming", startedAt: new Date(now - 1000).toISOString(), trigger: "followup" },
      ],
    })
    await saveRun(root, parent)
    await saveRun(root, childA)
    await saveRun(root, childB)

    const sessionTokensMap: Record<string, number> = {
      ses_child_a: 150,
      ses_child_b: 50,
    }
    const ctx = context({
      session: {
        get: (req: { sessionID: string }) => {
          const t = sessionTokensMap[req.sessionID] ?? 0
          return Effect.succeed({ tokens: { input: t, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
        },
      } as unknown as SessionDomain,
    })

    await checkBudgets(ctx, root, undefined, now)

    const parentInbox = await peek(root, parent.id)
    expect(parentInbox).toHaveLength(1)
    expect(parentInbox[0]?.kind).toBe("notify")
    expect(parentInbox[0]?.text).toContain("w-child-a")
    expect(parentInbox[0]?.text).toContain("w-child-b")

    expect(await peek(root, childA.id)).toHaveLength(0)
    expect(await peek(root, childB.id)).toHaveLength(0)

    await checkBudgets(ctx, root, undefined, now + 1000)
    expect(await peek(root, parent.id)).toHaveLength(1)

    await checkBudgets(ctx, root, undefined, now + 901_000)
    const parentInboxAfter = await peek(root, parent.id)
    expect(parentInboxAfter).toHaveLength(2)
  })
})

test("team_followup with budget: validates reason, preserves other dimensions, writes history, stops pings", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = Date.now()
    const child = baseRun({
      id: "w-child-1",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_child_1",
      state: "working",
      budget: { turns: 5, tokens: 100, wallMs: 3_600_000 },
      createdAt: new Date(now - 10000).toISOString(),
      attempts: [{ n: 1, state: "streaming", startedAt: new Date(now - 10000).toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)

    let promptCalled = false
    const ctx = context({
      session: {
        get: () => Effect.succeed({ tokens: { input: 150, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
        prompt: () => {
          promptCalled = true
          return Effect.succeed(undefined as never)
        },
      } as unknown as SessionDomain,
    })

    await checkBudgets(ctx, root, undefined, now)
    expect(await peek(root, parent.id)).toHaveLength(1)

    const api = createTeamApi(ctx, teamState())

    const failEmptyReason = await api.followup(
      { run: child.id, requestID: "b-1", budget: { tokens: 300 } },
      callerFor(parent),
    )
    expect(failEmptyReason.ok).toBe(false)
    if (!failEmptyReason.ok) {
      expect(failEmptyReason.error.code).toBe("E_BUDGET_REASON")
    }

    promptCalled = false
    const success = await api.followup(
      { run: child.id, requestID: "b-2", budget: { tokens: 300 }, reason: "Warranted: large test suite addition" },
      callerFor(parent),
    )
    expect(success.ok).toBe(true)
    expect(promptCalled).toBe(false)

    const updated = await loadRun(root, child.id)
    expect(updated?.budget).toEqual({ turns: 5, tokens: 300, wallMs: 3_600_000 })

    const historyEntry = updated?.history.find((h) => "reason" in h)
    expect(historyEntry).toBeDefined()
    expect(historyEntry).toMatchObject({
      by: parent.id,
      from: { turns: 5, tokens: 100, wallMs: 3_600_000 },
      to: { turns: 5, tokens: 300, wallMs: 3_600_000 },
      reason: "Warranted: large test suite addition",
    })

    await checkBudgets(ctx, root, undefined, now + 950_000)
    expect(await peek(root, parent.id)).toHaveLength(1)

    const budgetHistory = historyEntry ? [historyEntry as { at: string; by: string; from: { tokens?: number; turns?: number; wallMs?: number }; to: { tokens?: number; turns?: number; wallMs?: number }; reason: string }] : []
    const renderedReport = renderReport(
      { status: "done", summary: "Completed task" },
      { run: child.id, attempt: 1, head: "0123456", commits: [], checks: [], budgetHistory },
    )
    expect(renderedReport).toContain("## Budget history")
    expect(renderedReport).toContain("Warranted: large test suite addition")
  })
})

test("prompt-only followup does not end the pings", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = Date.now()
    const child = baseRun({
      id: "w-child-prompt-only",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_child_p",
      state: "working",
      budget: { tokens: 100 },
      createdAt: new Date(now - 10000).toISOString(),
      attempts: [{ n: 1, state: "streaming", startedAt: new Date(now - 10000).toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)

    const ctx = context({
      session: {
        get: () => Effect.succeed({ tokens: { input: 150, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
        prompt: () => Effect.succeed(undefined as never),
      } as unknown as SessionDomain,
    })

    await checkBudgets(ctx, root, undefined, now)
    expect(await peek(root, parent.id)).toHaveLength(1)

    const api = createTeamApi(ctx, teamState())

    const nudge = await api.followup(
      { run: child.id, requestID: "p-1", prompt: "Please finish up soon." },
      callerFor(parent),
    )
    expect(nudge.ok).toBe(true)

    await checkBudgets(ctx, root, undefined, now + 901_000)
    expect(await peek(root, parent.id)).toHaveLength(2)
  })
})

// A completed step is an assistant message carrying its token usage; the
// prompt size is what that step sent, not what the session spent.
function assistantStep(input: number, cacheRead: number, cacheWrite: number) {
  return {
    type: "assistant",
    agent: "implementer",
    model: { providerID: "acme", id: "nova" },
    tokens: { input, output: 10, reasoning: 5, cache: { read: cacheRead, write: cacheWrite } },
  }
}

function contextHarness(historyBySession: Record<string, readonly unknown[]>) {
  return context({
    session: {
      get: () => Effect.succeed({ tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      context: (req: { sessionID: unknown }) => Effect.succeed((historyBySession[String(req.sessionID)] ?? []) as never),
    } as unknown as SessionDomain,
  })
}

test("a child's context size is its latest step's input + cache read + cache write", async () => {
  const ctx = contextHarness({
    ses_ctx_one: [assistantStep(2_000, 120_000, 1_000)],
  })
  const run = baseRun({ id: "w-ctx-one", sessionID: "ses_ctx_one" })
  expect(await sessionContextTokens(ctx, run)).toBe(123_000)
})

test("a child with no completed step has no context size", async () => {
  const ctx = contextHarness({ ses_ctx_none: [] })
  const run = baseRun({ id: "w-ctx-none", sessionID: "ses_ctx_none" })
  expect(await sessionContextTokens(ctx, run)).toBeUndefined()
})

test("context notice fires once when a child's context passes 100k", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = Date.now()
    const child = baseRun({
      id: "w-child-ctx",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_child_ctx",
      state: "working",
      createdAt: new Date(now - 10000).toISOString(),
      attempts: [{ n: 1, state: "streaming", startedAt: new Date(now - 10000).toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)

    const histories: Record<string, readonly unknown[]> = {
      ses_child_ctx: [assistantStep(2_000, 120_000, 1_000)],
    }
    const ctx = contextHarness(histories)

    await checkBudgets(ctx, root, undefined, now)

    const inbox = await peek(root, parent.id)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]?.kind).toBe("notify")
    expect(inbox[0]?.text).toContain("w-child-ctx")
    expect(inbox[0]?.text).toContain("123k")

    // A larger context later does not speak again: one message per child run.
    histories.ses_child_ctx = [assistantStep(3_000, 200_000, 1_000)]
    await checkBudgets(ctx, root, undefined, now + 60_000)
    expect(await peek(root, parent.id)).toHaveLength(1)
  })
})

test("a child below 100k context stays silent", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const now = Date.now()
    const child = baseRun({
      id: "w-child-small",
      role: "implementer",
      parent: parent.id,
      sessionID: "ses_child_small",
      state: "working",
      createdAt: new Date(now - 10000).toISOString(),
      attempts: [{ n: 1, state: "streaming", startedAt: new Date(now - 10000).toISOString(), trigger: "delegate" }],
    })
    await saveRun(root, parent)
    await saveRun(root, child)

    const ctx = contextHarness({ ses_child_small: [assistantStep(10_000, 80_000, 0)] })
    await checkBudgets(ctx, root, undefined, now)
    expect(await peek(root, parent.id)).toHaveLength(0)
  })
})

test("team_status reports contextTokens from the latest step and null without one", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-parent", role: "orchestrator", sessionID: "ses_parent" })
    const child = baseRun({ id: "w-child-status", role: "implementer", parent: parent.id, sessionID: "ses_child_status", state: "working" })
    const noStep = baseRun({ id: "w-child-nostep", role: "implementer", parent: parent.id, sessionID: "ses_child_nostep", state: "working" })
    await saveRun(root, { ...parent, children: [child.id, noStep.id] })
    await saveRun(root, child)
    await saveRun(root, noStep)

    const ctx = contextHarness({ ses_child_status: [assistantStep(2_000, 120_000, 1_000)] })
    const api = createTeamApi(ctx, teamState())
    const status = (await api.status({ runs: [child.id, noStep.id] }, callerFor(parent))) as
      | { ok: true; value: Array<{ run: string; budget: { contextTokens: number | null } }> }
      | { ok: false }
    if (!status.ok) throw new Error("expected status ok")
    const withStep = status.value.find((entry) => entry.run === child.id)
    const withoutStep = status.value.find((entry) => entry.run === noStep.id)
    expect(withStep?.budget.contextTokens).toBe(123_000)
    expect(withoutStep?.budget.contextTokens).toBeNull()
  })
})
