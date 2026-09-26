import { describe, expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { teamState } from "../teams/preset-table.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Brief } from "../../src/teams/schema.js"

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-model-pins-"))
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

async function makeRepo(): Promise<{ dir: string; head: string }> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-model-pins-repo-"))
  await git(dir, ["init", "-b", "main"])
  await git(dir, ["config", "user.name", "team-test"])
  await git(dir, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# model pins test\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { dir, head }
}

async function removeRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "opus-orchestrator",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-model-pins",
    paths: [],
    branch: "team/orchestrator/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "team-api-test",
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
  return { sessionID: String(record.sessionID ?? "ses_parent_caller"), agent: record.role, run: record }
}

function delegateInput(overrides?: Record<string, unknown>): Brief {
  return Schema.decodeUnknownSync(Brief)({
    requestID: "req-default-1",
    role: "muse-implementer",
    objective: "Implement required model pin verification and configuration hashing.",
    deliverable: { kind: "commit" },
    scope: { paths: ["packages/plus/src/*"] },
    checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] }],
    ...overrides,
  })
}

function makeSessionDouble(opts?: {
  resolvedModel?: { providerID: string; id: string; variant?: string }
  switchFail?: boolean
  switchError?: string
}) {
  const created: unknown[] = []
  const prompted: Array<{ sessionID: unknown; text: unknown }> = []
  const switched: Array<{ sessionID: unknown; model: unknown }> = []
  let seq = 0

  const domain = {
    create: (input: unknown) => {
      created.push(input)
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_child_${seq}`) })
    },
    switchModel: (input: { sessionID: unknown; model: unknown }) => {
      switched.push(input)
      if (opts?.switchFail) {
        return Effect.fail(new Error(opts.switchError ?? "Host rejected model switch"))
      }
      return Effect.succeed(undefined as never)
    },
    get: (input: { sessionID: unknown }) => {
      const model = opts?.resolvedModel
      return Effect.succeed({
        id: input.sessionID,
        ...(model !== undefined ? { model: { providerID: model.providerID, id: model.id, variant: model.variant } } : {}),
      })
    },
    prompt: (input: { sessionID: unknown; text: unknown }) => {
      prompted.push(input)
      return Effect.succeed(undefined as never)
    },
    wait: () => Effect.succeed(undefined),
  } as unknown as SessionDomain

  return { created, prompted, switched, domain }
}

// Each api runs on the shipped team's permission table (every member linked to
// its member preset), so opus-orchestrator may delegate to muse-implementer
// and the call reaches model pinning; without a table every team row is off.
describe("model and attempt pinning", () => {
  test("persists requested and loaded identities as distinct fields", async () => {
    await withIsolatedTeamsRoot(async (root) => {
      const repo = await makeRepo()
      try {
        const parent = baseRun({
          id: "main-0123456789abcdef",
          directory: repo.dir,
          base: repo.head,
          head: repo.head,
          sessionID: "ses_parent_pins",
        })
        await saveRun(root, parent)

        const requested = { providerID: "cliproxyapi", modelID: "model-alpha-1.0", variant: "high" }
        const resolved = { providerID: "cliproxyapi", id: "model-alpha-1.0", variant: "high" }

        const sessions = makeSessionDouble({ resolvedModel: resolved })
        const state = teamState()
        state.activeModels.set("muse-implementer", requested)

        const api = createTeamApi(context({ session: sessions.domain }), state)
        const result = await api.delegate(delegateInput({ requestID: "req-pins-distinct" }), callerFor(parent))
        expect(result.ok).toBe(true)
        if (!result.ok) return

        const childRun = await loadRun(root, (result.value as { run: string }).run)
        expect(childRun).toBeDefined()
        expect(childRun?.requestedModel).toEqual(requested)
        expect(childRun?.loadedModel).toEqual({
          providerID: resolved.providerID,
          modelID: resolved.id,
          variant: resolved.variant,
        })

        const attempt = childRun?.attempts[0]
        expect(attempt).toBeDefined()
        expect(attempt?.requestedModel).toEqual(requested)
        expect(attempt?.loadedModel).toEqual({
          providerID: resolved.providerID,
          modelID: resolved.id,
          variant: resolved.variant,
        })

        expect(childRun?.requestedModel).not.toBeNull()
        expect(childRun?.loadedModel).not.toBeNull()
      } finally {
        await removeRepo(repo.dir)
      }
    })
  })

  test("raises toolError before prompting when required model switch fails", async () => {
    await withIsolatedTeamsRoot(async (root) => {
      const repo = await makeRepo()
      try {
        const parent = baseRun({
          id: "main-0123456789abcdef",
          directory: repo.dir,
          base: repo.head,
          head: repo.head,
          sessionID: "ses_parent_switch_fail",
        })
        await saveRun(root, parent)

        const sessions = makeSessionDouble({ switchFail: true, switchError: "Provider quota exceeded" })
        const state = teamState()
        state.activeModels.set("muse-implementer", {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          variant: "default",
        })

        const api = createTeamApi(context({ session: sessions.domain }), state)
        const result = await api.delegate(delegateInput({ requestID: "req-switch-fails" }), callerFor(parent))

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error.code).toBe("E_MODEL")
        expect(result.error.message).toContain("Required model switch")
        expect(sessions.prompted).toHaveLength(0)
      } finally {
        await removeRepo(repo.dir)
      }
    })
  })

  test("raises toolError before prompting when host silently resolves a different model", async () => {
    await withIsolatedTeamsRoot(async (root) => {
      const repo = await makeRepo()
      try {
        const parent = baseRun({
          id: "main-0123456789abcdef",
          directory: repo.dir,
          base: repo.head,
          head: repo.head,
          sessionID: "ses_parent_silent_degrade",
        })
        await saveRun(root, parent)

        const requested = { providerID: "anthropic", modelID: "claude-3-5-sonnet", variant: "high" }
        const degraded = { providerID: "anthropic", id: "claude-3-haiku", variant: "default" }

        const sessions = makeSessionDouble({ resolvedModel: degraded })
        const state = teamState()
        state.activeModels.set("muse-implementer", requested)

        const api = createTeamApi(context({ session: sessions.domain }), state)
        const result = await api.delegate(delegateInput({ requestID: "req-silent-degrade" }), callerFor(parent))

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error.code).toBe("E_MODEL")
        expect(result.error.message).toContain("could not be satisfied; host resolved")
        expect(sessions.prompted).toHaveLength(0)
      } finally {
        await removeRepo(repo.dir)
      }
    })
  })

  test("records resolved model and configuration hash on successful attempt", async () => {
    await withIsolatedTeamsRoot(async (root) => {
      const repo = await makeRepo()
      try {
        const parent = baseRun({
          id: "main-0123456789abcdef",
          directory: repo.dir,
          base: repo.head,
          head: repo.head,
          sessionID: "ses_parent_success_hashes",
        })
        await saveRun(root, parent)

        const requested = { providerID: "openai", modelID: "gpt-4o", variant: "high" }
        const resolved = { providerID: "openai", id: "gpt-4o", variant: "high" }

        const sessions = makeSessionDouble({ resolvedModel: resolved })
        const state = teamState()
        state.activeModels.set("muse-implementer", requested)

        const api = createTeamApi(context({ session: sessions.domain }), state)
        const result = await api.delegate(delegateInput({ requestID: "req-success-hashes" }), callerFor(parent))

        expect(result.ok).toBe(true)
        if (!result.ok) return

        expect(sessions.prompted).toHaveLength(1)

        const childRun = await loadRun(root, (result.value as { run: string }).run)
        expect(childRun).toBeDefined()
        expect(childRun?.loadedModel).toEqual({ providerID: "openai", modelID: "gpt-4o", variant: "high" })
        expect(childRun?.resolvedModel).toEqual({ providerID: "openai", modelID: "gpt-4o", variant: "high" })
        expect(typeof childRun?.configDigest).toBe("string")
        expect(childRun?.configDigest).toMatch(/^[a-f0-9]{64}$/)
        expect(typeof childRun?.instructionsHash).toBe("string")
        expect(childRun?.instructionsHash).toMatch(/^[a-f0-9]{64}$/)

        const attempt = childRun?.attempts[0]
        expect(attempt).toBeDefined()
        expect(attempt?.loadedModel).toEqual({ providerID: "openai", modelID: "gpt-4o", variant: "high" })
        expect(attempt?.resolvedModel).toEqual({ providerID: "openai", modelID: "gpt-4o", variant: "high" })
        expect(attempt?.configDigest).toBe(childRun?.configDigest)
        expect(attempt?.instructionsHash).toBe(childRun?.instructionsHash)
      } finally {
        await removeRepo(repo.dir)
      }
    })
  })
})
