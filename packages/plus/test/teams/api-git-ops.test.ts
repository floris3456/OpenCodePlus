import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setChecksHandler } from "../../src/teams/api-git-ops.js"
import type { TeamCaller } from "../../src/teams/api.js"
import { saveRun, type RunRecord } from "../../src/teams/run.js"
import type { Check } from "../../src/teams/schema.js"
import { atomicJson, readJson } from "../../src/teams/store.js"

// A real temp XDG_DATA_HOME state root, real RunRecords written with
// saveRun. No mocks of our own code.
async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-git-ops-"))
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
    role: "opus-orchestrator",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-team-git-ops",
    paths: [],
    branch: "team/orchestrator/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "working",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "team-git-ops-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: "ses_orch_001",
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function callerFor(record: RunRecord): TeamCaller {
  return { sessionID: String(record.sessionID ?? "ses_unknown"), agent: record.role, run: record }
}

function required<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

function rejected(result: {
  ok: true
  value: unknown
} | {
  ok: false
  error: { code: string; message: string; accepted?: unknown }
}): {
  code: string
  message: string
  accepted?: unknown
} {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`)
  return result.error
}

test("valid checks are written to the caller checks.json and output in input order", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const caller = baseRun({ id: "main-0123456789abcdef" })
    await saveRun(root, caller)
    const checks = [
      { id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] },
      { id: "lint", argv: ["bun", "run", "lint"] },
    ]
    const value = required(await setChecksHandler({ checks }, callerFor(caller))) as { checks: string[] }
    expect(value).toEqual({ checks: ["unit", "lint"] })
    expect(await readJson<Check[]>(path.join(root, "runs", caller.id, "checks.json"))).toEqual(checks)
  })
})

test("an invalid check fails E_CHECKS with the exact validateChecks message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const caller = baseRun({ id: "main-0123456789abcdef" })
    await saveRun(root, caller)
    const error = rejected(
      await setChecksHandler({ checks: [{ id: "Bad_ID!", argv: ["bun", "test", "x.test.ts"] }] }, callerFor(caller)),
    )
    expect(error.code).toBe("E_CHECKS")
    expect(error.message).toBe("Checks need distinct short IDs.")
    expect(error.accepted).toEqual({ id: "plus-tests", argv: ["bun", "test", "packages/plus/test/model.test.ts"] })
  })
})

test("more than 12 checks is refused", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const caller = baseRun({ id: "main-0123456789abcdef" })
    await saveRun(root, caller)
    const checks = Array.from({ length: 13 }, (_, n) => ({
      id: `check-${n}`,
      argv: ["bun", "test", `packages/plus/test/unit-${n}.test.ts`],
    }))
    const error = rejected(await setChecksHandler({ checks }, callerFor(caller)))
    expect(error.code).toBe("E_CHECKS")
    expect(error.message).toBe("E_CHECKS: Use at most 12 focused checks.")
  })
})

test("an empty array succeeds and clears the file", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const caller = baseRun({ id: "main-0123456789abcdef" })
    await saveRun(root, caller)
    await atomicJson(path.join(root, "runs", caller.id, "checks.json"), [
      { id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] },
    ])
    const value = required(await setChecksHandler({ checks: [] }, callerFor(caller))) as { checks: string[] }
    expect(value).toEqual({ checks: [] })
    expect(await readJson<Check[]>(path.join(root, "runs", caller.id, "checks.json"))).toEqual([])
  })
})

test("calling set_checks twice replaces rather than appends", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const caller = baseRun({ id: "main-0123456789abcdef" })
    await saveRun(root, caller)
    const first = required(
      await setChecksHandler({ checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] }] }, callerFor(caller)),
    ) as { checks: string[] }
    expect(first).toEqual({ checks: ["unit"] })
    const second = required(
      await setChecksHandler({ checks: [{ id: "lint", argv: ["bun", "run", "lint"] }] }, callerFor(caller)),
    ) as { checks: string[] }
    expect(second).toEqual({ checks: ["lint"] })
    expect(await readJson<Check[]>(path.join(root, "runs", caller.id, "checks.json"))).toEqual([
      { id: "lint", argv: ["bun", "run", "lint"] },
    ])
  })
})
