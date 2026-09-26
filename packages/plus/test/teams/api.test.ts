import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect, Exit, Schema, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context, fullContext } from "../harness.js"
import { teamState } from "./preset-table.js"
import plus, { activationDirectory, createHandlers, createPlusApi, createState } from "../../src/index.js"
import { formatMarkdown } from "../../src/agents/files.js"
import { load, save } from "../../src/instructions/store.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { lastReceipt } from "../../src/teams/checks.js"
import { git } from "../../src/teams/git.js"
import { gc } from "../../src/teams/lifecycle.js"
import { byDirectory, loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Brief, Report } from "../../src/teams/schema.js"
import { atomicJson } from "../../src/teams/store.js"
import { read } from "../../src/project.js"

// Real temp git repositories plus a real temp state root (scoped
// XDG_DATA_HOME redirect, restored afterwards). The session domain is a
// recording fake supplied through the shared harness context: it records
// what the handlers asked for instead of spawning sessions. No mocks of our
// own code.
async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-api-"))
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
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-api-repo-"))
  await git(dir, ["init"])
  await git(dir, ["config", "user.name", "team-test"])
  await git(dir, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# team api test\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { dir, head }
}

async function removeRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

function recordSession() {
  const created: unknown[] = []
  const prompted: Array<{ sessionID: unknown; text: unknown }> = []
  const switched: Array<{ sessionID: unknown; model: unknown }> = []
  const order: string[] = []
  const waited: unknown[] = []
  let seq = 0
  // Narrow host doubles: the handlers only read child.id and pass plain
  // inputs through, so minimal shapes behind one boundary cast are enough.
  const domain = {
    create: (input: unknown) => {
      created.push(input)
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_child_${seq}`) })
    },
    prompt: (input: { sessionID: unknown; text: unknown }) => {
      prompted.push({ sessionID: input.sessionID, text: input.text })
      order.push("prompt")
      return Effect.succeed(undefined as never)
    },
    switchModel: (input: { sessionID: unknown; model: unknown }) => {
      switched.push({ sessionID: input.sessionID, model: input.model })
      order.push("switchModel")
      return Effect.succeed(undefined as never)
    },
    wait: (input: unknown) => {
      waited.push(input)
      return Effect.succeed(undefined)
    },
  } as unknown as SessionDomain
  return { created, prompted, switched, order, waited, domain }
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-team-api",
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
  return { sessionID: String(record.sessionID ?? "ses_unknown"), agent: record.role, run: record }
}

function delegateInput(overrides?: Record<string, unknown>): Brief {
  return Schema.decodeUnknownSync(Brief)({
    requestID: "req-1",
    role: "muse-implementer",
    objective: "Fix the agent filter in the query module so scoped listing works as documented.",
    deliverable: { kind: "commit" },
    scope: { paths: ["packages/plus/src/*"] },
    checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] }],
    ...overrides,
  })
}

function finishInput(input: Partial<typeof Report.Encoded> & Pick<typeof Report.Encoded, "status" | "summary">): Report {
  return Schema.decodeUnknownSync(Report)(input)
}

function required<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

function rejected(result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; accepted?: unknown } }): {
  code: string
  message: string
  accepted?: unknown
} {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`)
  return result.error
}

test("delegate creates a worktree session, record, brief and prompt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_001",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const value = required(await api.delegate(delegateInput(), callerFor(parent))) as {
        run: string
        session: string
        directory: string
        branch: string
        base: string
        briefPath: string
        task: string
        state: string
      }
      expect(value.state).toBe("starting")
      expect(value.base).toBe(repo.head)
      expect((await fs.stat(value.directory)).isDirectory()).toBe(true)
      expect(sessions.created).toHaveLength(1)
      const create = sessions.created[0] as { agent: string; location: { directory: string } }
      expect(create.agent).toBe("muse-implementer")
      expect(create.location.directory).toBe(value.directory)
      const persisted = await loadRun(root, value.run)
      expect(persisted?.sessionID).toBe(value.session)
      expect(persisted?.paths).toEqual(["packages/plus/src/*"])
      expect(persisted?.parent).toBe(parent.id)
      expect(await Bun.file(value.briefPath).exists()).toBe(true)
      const brief = await Bun.file(value.briefPath).text()
      expect(brief).toContain("Fix the agent filter in the query module")
      expect(sessions.prompted).toHaveLength(1)
      expect(sessions.prompted[0]?.sessionID).toBe(value.session)
      expect(sessions.prompted[0]?.text).toContain("Fix the agent filter in the query module")
      // The child worktree carries no copied project config: it is activated
      // through the parent directory recorded on its run (item 13).
      expect(await Bun.file(path.join(value.directory, ".opencodeplus", "project.json")).exists()).toBe(false)
      expect(await git(value.directory, ["status", "--porcelain"])).toBe("")
      expect(persisted?.projectDirectory).toBe(repo.dir)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("delegate activates the child through the parent project, with no copy", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      // Parent runs in a Plus project; the child worktree is outside its tree.
      // (enable() itself resolves upward, so write the parent's own file.)
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(
        path.join(repo.dir, ".opencodeplus", "project.json"),
        `${JSON.stringify({ version: 1, protectedAgents: ["muse-implementer"] }, null, 2)}\n`,
      )
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_project",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "project-1" }), callerFor(parent))) as {
        run: string
        session: string
        directory: string
      }
      // The child carries no project config at all...
      expect(await Bun.file(path.join(value.directory, ".opencodeplus", "project.json")).exists()).toBe(false)
      // ...and the activation seam resolves the parent's project through the
      // run record the delegate wrote, so Plus activates in the child worktree
      // with the parent's protectedAgents, not a copy and not a stray ancestor.
      const child = await loadRun(root, value.run)
      expect(child?.projectDirectory).toBe(repo.dir)
      const activation = await activationDirectory(value.directory)
      expect(activation).toBe(repo.dir)
      expect(await read(activation)).toEqual({ version: 1, protectedAgents: ["muse-implementer"] })
      // Item 13 evidence: no copy in the child, activation through the record.
      console.log(
        `[T5 item 13] child ${value.directory}\n  child/.opencodeplus/project.json exists: false\n` +
          `  run.projectDirectory: ${String(child?.projectDirectory)}\n` +
          `  activationDirectory(child): ${activation}\n` +
          `  project.read(activation): ${JSON.stringify(await read(activation))}`,
      )
      // The recorded directory is the worktree the child's session opened in.
      expect(child?.directory).toBe(value.directory)
      expect((sessions.created[0] as { location: { directory: string } }).location.directory).toBe(value.directory)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// The host's session create runs inside `delegate`: it resolves the location
// directory (`FileSystem.realPath`), activation reads it, and the plugin's
// startup sweep runs against the same runs root. This test drives that exact
// window with the real `create`, the real `gc` and a real `realpath`.
test("the first delegate registers the child run before the host opens its session", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_gc_race",
      })
      await saveRun(root, parent)

      const during = {
        resolveError: undefined as string | undefined,
        activation: undefined as string | undefined,
        sessionID: undefined as string | null | undefined,
        orphansRemoved: undefined as string[] | undefined,
        afterSweepError: undefined as string | undefined,
      }
      const resolveCode = (error: { code?: string }) => error.code ?? String(error)
      const sessions = recordSession()
      const domain = {
        ...sessions.domain,
        create: (input: unknown) =>
          Effect.promise(async () => {
            const location = (input as { location: { directory: string } }).location.directory
            during.resolveError = await fs.realpath(location).then(
              () => undefined,
              resolveCode,
            )
            during.activation = await activationDirectory(location)
            during.sessionID = (await byDirectory(root, location))?.sessionID
            // The real sweep a plugin instance runs against this data root,
            // while the delegate is between `create` and its next write.
            during.orphansRemoved = (await gc(root)).orphansRemoved
            during.afterSweepError = await fs.realpath(location).then(
              () => undefined,
              resolveCode,
            )
            return { id: Session.ID.make("ses_child_gc_race") }
          }),
      } as unknown as SessionDomain

      const api = createTeamApi(context({ session: domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "gc-race-1" }), callerFor(parent))) as {
        run: string
        directory: string
      }

      // The host's realPath boundary: the directory it resolves exists, and it
      // still exists after the sweep that ran during session creation.
      expect(await fs.realpath(value.directory)).toBe(value.directory)
      expect(during.resolveError).toBeUndefined()
      expect(during.afterSweepError).toBeUndefined()
      expect(during.orphansRemoved).toEqual([])
      expect(during.activation).toBe(repo.dir)
      expect(during.sessionID).toBeNull()
      expect((await loadRun(root, value.run))?.sessionID).toBe("ses_child_gc_race")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// The real plugin entrypoint, the shared harness host, and the real activation
// path: a Location whose directory is the child worktree must install the
// parent project's team agents and the team/instructions tools, and closing
// the plugin scope must dispose them.
test("activation in a child worktree installs the parent project's agents and tools", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus", "teams", "crew"), { recursive: true })
      await fs.writeFile(
        path.join(repo.dir, ".opencodeplus", "project.json"),
        `${JSON.stringify({ version: 1, protectedAgents: ["muse-implementer"] }, null, 2)}\n`,
      )
      await fs.writeFile(
        path.join(repo.dir, ".opencodeplus", "teams", "crew", "alpha.md"),
        formatMarkdown({ description: "crew/alpha" }, "crew alpha body"),
      )
      const loaded = await load(repo.dir)
      const enabled = await save(repo.dir, {
        expectedProjectRevision: loaded.projectRevision,
        expectedGlobalRevision: loaded.globalRevision,
        records: [
          ...loaded.records,
          { type: "team", level: "project", team: "crew", enabled: true, updated: new Date().toISOString() },
          // DESIGN §3.3: a member's shared rows fall back to off unless a
          // preset sets them; alpha stands for a member created from Native
          // `build`, so activation installs it without rows of its own.
          {
            type: "link",
            level: "project",
            agent: "alpha",
            team: { level: "project", team: "crew" },
            preset: { kind: "agent", id: "build" },
            updated: new Date().toISOString(),
          },
        ],
      })
      expect(enabled.ok).toBe(true)

      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_activation",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "activation-1" }), callerFor(parent))) as {
        directory: string
      }

      // A plugin instance whose Location is the child worktree: the harness
      // records the session-creation seam but nothing about activation.
      const ctx = fullContext({ directory: value.directory })
      const pluginCtx = {
        ...ctx,
        rpc: Object.assign(
          () => {
            throw new Error("unused rpc.client")
          },
          {
            register: () => Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } }),
          },
        ),
      } as Context
      const scope = await Effect.runPromise(Scope.make())
      try {
        await Effect.runPromise(plus.effect(pluginCtx).pipe(Effect.provideService(Scope.Scope, scope)))
        const toolIds = await installedToolIds(ctx)
        expect(toolIds).toContain("team_delegate")
        expect(toolIds).toContain("team_status")
        expect(toolIds.filter((id) => id.startsWith("instructions_"))).toHaveLength(8)
        const listed = await Effect.runPromise(ctx.agent.list())
        expect(listed.data.map((agent) => String(agent.id))).toContain("alpha")
        console.log(
          `[T5 item 13] child plugin activation through the real entrypoint\n` +
            `  location: ${value.directory}\n` +
            `  team tools installed: ${toolIds.filter((id) => id.startsWith("team_")).length}\n` +
            `  instructions tools installed: ${toolIds.filter((id) => id.startsWith("instructions_")).length}\n` +
            `  team member agents installed: ${listed.data.map((agent) => String(agent.id)).filter((id) => id === "alpha").join(", ")}`,
        )
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
      // Activation is real and scoped: the child instance's registrations went
      // away with it.
      expect(await installedToolIds(ctx)).toEqual([])
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// Guards, snapshot and mutate all resolve the same directory activation does:
// the run's recorded projectDirectory, never the copy-free child worktree.
test("project guards, snapshot and mutate resolve a child worktree through its run's projectDirectory", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(
        path.join(repo.dir, ".opencodeplus", "project.json"),
        `${JSON.stringify({ version: 1, protectedAgents: ["muse-implementer"] }, null, 2)}\n`,
      )
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_api_project",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "api-inherit-1" }), callerFor(parent))) as {
        directory: string
      }

      // The child worktree carries no config, and no ancestor of it is enabled.
      expect(await Bun.file(path.join(value.directory, ".opencodeplus", "project.json")).exists()).toBe(false)
      const ctx = fullContext({ directory: value.directory })
      const state = createState()
      const handlers = createHandlers(ctx, state, { builtins: [] })
      const status = await Effect.runPromise(handlers["project.status"](undefined, throwingContext({})))
      expect(status).toEqual({ enabled: true, directory: repo.dir })
      const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
      const childApi = createPlusApi(ctx, state, { builtins: [] })
      const mutated = await childApi.mutate({
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [],
      })
      expect(mutated.ok).toBe(true)
      console.log(
        `[T5 item 13] child API resolves the inherited project\n` +
          `  location: ${value.directory}\n` +
          `  project.status: ${JSON.stringify(status)}\n` +
          `  snapshot revisions: project=${snapshot.revision} global=${snapshot.globalRevision}\n` +
          `  mutate ok: ${mutated.ok}`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// The session create is the one step that can fail after the run is on disk;
// the pre-registered record must not keep claiming a bounds slot forever.
test("a failed session create retires the pre-registered child run", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_create_fail",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const domain = {
        ...sessions.domain,
        create: () => Effect.die(new Error("host session create failed")),
      } as unknown as SessionDomain

      const api = createTeamApi(context({ session: domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ requestID: "create-fail-1" }), callerFor(parent)))
      expect(error.code).toBe("E_INTERNAL")

      const entries = await fs.readdir(path.join(root, "runs"))
      const records = (await Promise.all(entries.map((entry) => loadRun(root, entry)))).filter(
        (record): record is RunRecord => record !== undefined && record.parent === parent.id,
      )
      expect(records).toHaveLength(1)
      expect(records[0]?.state).toBe("superseded")
      expect(records[0]?.sessionID).toBeNull()
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// Declared-error side channel for handlers that fail: the harness context
// records which error type a handler selected.
interface CapturedError {
  type: string
  message: string
  data?: unknown
}

function throwingContext(captured: { current?: CapturedError }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure: CapturedError = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

async function installedToolIds(ctx: Context): Promise<string[]> {
  const ids: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      ctx.tool.transform((editor) => {
        for (const tool of editor.list()) ids.push(String((tool as { id?: unknown }).id ?? tool.name))
      }),
    ),
  )
  return ids
}

test("delegate rejects E_ROLE when an implementer delegates", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "muse-implementer",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_002",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ role: "scout" }), callerFor(parent)))
      expect(error.code).toBe("E_ROLE")
      // An implementer's preset opens no delegation (its "Delegate to" rows
      // ship off); the refusal says so instead of suggesting another role.
      expect(error.message).toBe(`muse-implementer may not delegate. No member is open to you for delegation.`)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("delegate rejects E_BASE for an unknown ref", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_003",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ base: "no-such-ref" }), callerFor(parent)))
      expect(error.code).toBe("E_BASE")
      expect(error.message).toBe(
        `base "no-such-ref" is not a ref or commit in opencode. Omit base to use your HEAD (${repo.head}), or pass a branch/sha. accepted: "ocp-main"`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

// The target's own "Scope paths for a commit" row (its Plus implementer
// preset turns it on), not its id, asks for scope.paths.
test("delegate rejects E_PATHS when a commit for an implementer-preset member has no paths", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_004",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ scope: { paths: [] } }), callerFor(parent)))
      expect(error.code).toBe("E_PATHS")
      expect(error.message).toBe(
        "muse-implementer needs scope.paths (files or dir/* it may edit) for a commit deliverable (Briefs it accepts → Scope paths for a commit).",
      )
      expect(error.accepted).toEqual(["packages/plus/src/*", "packages/plus/test/*"])
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("delegate rejects E_REQUEST_ID when the id is reused with new arguments", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_005",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const first = await api.delegate(
        delegateInput({ requestID: "dup-1", objective: "First objective text that is long enough to validate." }),
        callerFor(parent),
      )
      expect(first.ok).toBe(true)
      const error = rejected(
        await api.delegate(
          delegateInput({ requestID: "dup-1", objective: "Second objective text that differs from the first one." }),
          callerFor(parent),
        ),
      )
      expect(error.code).toBe("E_REQUEST_ID")
      expect(error.message).toBe(
        `requestID "dup-1" was used with different arguments; reuse only to retry the identical call, else pick a new requestID.`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

function childInRepo(id: string, repo: { dir: string; head: string }): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    role: "muse-implementer",
    directory: repo.dir,
    paths: ["docs/*"],
    base: repo.head,
    head: repo.head,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    parent: "main-0123456789abcdef",
    sessionID: "ses_child_001",
  })
}

test("checkpoint commits an in-scope file and moves HEAD", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), "# notes\n")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(
        await api.checkpoint({ expectedHead: repo.head, files: ["docs/notes.md"], message: "fix: update notes" }, callerFor(child)),
      ) as { head: string; committed: boolean; sha?: string; subject?: string }
      expect(value.committed).toBe(true)
      expect(value.sha).toBe(value.head)
      expect(value.head).not.toBe(repo.head)
      expect(value.subject).toBe("fix: update notes")
      expect((await loadRun(root, child.id))?.head).toBe(value.head)
      expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(value.head)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("checkpoint rejects an out-of-scope file with E_SCOPE", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "outside"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "outside", "o.md"), "out of scope\n")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(
        await api.checkpoint({ expectedHead: repo.head, files: ["outside/o.md"], message: "fix: out of scope" }, callerFor(child)),
      )
      expect(error.code).toBe("E_SCOPE")
      expect(error.message).toBe(`"outside/o.md" is outside your scope.paths [docs/*]. Report it in needs=[{kind:"path"...}].`)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("checkpoint rejects a non-conventional message with E_MESSAGE", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), "# notes\n")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(
        await api.checkpoint({ expectedHead: repo.head, files: ["docs/notes.md"], message: "update notes without a type" }, callerFor(child)),
      )
      expect(error.code).toBe("E_MESSAGE")
      expect(error.message).toBe(
        `Use "<type>(<scope>)?: <subject>" with type in feat|fix|docs|chore|refactor|test. accepted: "fix: apply agent filter in query"`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("checkpoint with an empty diff succeeds without committing", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), "# notes\n")
      await git(repo.dir, ["add", "docs/notes.md"])
      await git(repo.dir, ["commit", "-m", "fix: track notes"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(
        await api.checkpoint({ expectedHead: head, files: ["docs/notes.md"], message: "fix: nothing to do" }, callerFor(child)),
      ) as { head: string; committed: boolean }
      expect(value).toEqual({ head, committed: false })
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

const PASSING_TEST = `import { expect, test } from "bun:test"\n\ntest("ok", () => {\n  expect(1).toBe(1)\n})\n`
const FAILING_TEST = `import { expect, test } from "bun:test"\n\ntest("ok", () => {\n  expect(1).toBe(2)\n})\n`

async function finishChild(root: string, repo: { dir: string; head: string }, body: string): Promise<RunRecord> {
  await fs.writeFile(path.join(repo.dir, "t.test.ts"), body)
  await git(repo.dir, ["add", "t.test.ts"])
  await git(repo.dir, ["commit", "-m", "test: add unit test"])
  const head = await git(repo.dir, ["rev-parse", "HEAD"])
  const child = childInRepo("w-bbbbbbbbbbbbbbbb", { dir: repo.dir, head })
  const record: RunRecord = { ...child, base: repo.head, paths: ["t.test.ts"] }
  await saveRun(root, record)
  await atomicJson(path.join(root, "runs", record.id, "checks.json"), [{ id: "t", argv: ["bun", "test", "t.test.ts"] }])
  return record
}

test("finish done with a green check records the report and commits", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, PASSING_TEST)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child))) as {
        head: string
        reportPath: string
        commits: Array<{ sha: string; subject: string }>
        checks: Array<{ id: string; passed: boolean; head: string; at: number }>
      }
      expect(value.checks).toEqual([{ id: "t", passed: true, head: value.head, at: expect.any(Number) }])
      expect(value.commits).toEqual([{ sha: value.head, subject: "test: add unit test" }])
      expect(await Bun.file(value.reportPath).exists()).toBe(true)
      const moved = await loadRun(root, child.id)
      expect(moved?.attempts[moved.attempts.length - 1]?.state).toBe("succeeded")
      expect(moved?.head).toBe(value.head)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done with a red check fails E_CHECKS_RED", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, FAILING_TEST)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child)))
      expect(error.code).toBe("E_CHECKS_RED")
      expect(error.message).toContain("Cannot report done: checks red at HEAD")
      expect(error.message).toContain("[t]")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish runs a stale check instead of refusing it", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, PASSING_TEST)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean; head: string }
      expect(checked.passed).toBe(true)
      await fs.writeFile(path.join(repo.dir, "extra.md"), "more work\n")
      await git(repo.dir, ["add", "extra.md"])
      await git(repo.dir, ["commit", "-m", "docs: extra notes"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      expect(head).not.toBe(checked.head)
      const value = required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child))) as {
        head: string
      }
      expect(value.head).toBe(head)
      expect((await lastReceipt(root, child.id, "t"))?.head).toBe(head)
      expect((await lastReceipt(root, child.id, "t"))?.passed).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish re-runs a dirty-tree receipt at the commit and fails E_CHECKS_RED with the exact message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-dddddddddddddddd", repo)
      await saveRun(root, child)
      await atomicJson(path.join(root, "runs", child.id, "checks.json"), [{ id: "t", argv: ["bun", "test", "t.test.ts"] }])
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      // Edit without committing: the passing test is dirty, so the green
      // receipt is dirty-tree proof and must never satisfy finish at HEAD.
      await fs.writeFile(path.join(repo.dir, "t.test.ts"), PASSING_TEST)
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean; head: string }
      expect(checked.passed).toBe(true)
      // Commit a failing version, then finish: the stale check is re-run
      // at the commit and the exact 03 E_CHECKS_RED message results.
      await fs.writeFile(path.join(repo.dir, "t.test.ts"), FAILING_TEST)
      await git(repo.dir, ["add", "t.test.ts"])
      await git(repo.dir, ["commit", "-m", "test: add unit test"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      expect(head).not.toBe(checked.head)
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child)))
      expect(error.code).toBe("E_CHECKS_RED")
      const receipt = await lastReceipt(root, child.id, "t")
      if (receipt === undefined) throw new Error("missing receipt after finish re-run")
      expect(receipt.head).toBe(head)
      expect(receipt.passed).toBe(false)
      const log = await fs.readFile(receipt.outputPath, "utf8")
      const first = log.split("\n").find((line) => line.trim().length > 0) ?? ""
      const line = first.trim() === "" ? "failed" : first.trim().slice(0, 300)
      expect(error.message).toBe(
        `Cannot report done: checks red at HEAD ${head}: [t]. Fix and finish again, or finish with status "blocked" and needs=[{kind:"check",detail:"t fails: ${line}"}].`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done moves run.state to idle and status reports it", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, PASSING_TEST)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child))) as {
        head: string
      }
      expect(value.head).toBeDefined()
      const moved = await loadRun(root, child.id)
      expect(moved?.attempts[moved.attempts.length - 1]?.state).toBe("succeeded")
      expect(moved?.state).toBe("idle")
      const entries = required(await api.status({ runs: [child.id] }, callerFor(child))) as Array<{
        run: string
        state: string
        attemptState: string
      }>
      expect(entries).toHaveLength(1)
      expect(entries[0]?.run).toBe(child.id)
      expect(entries[0]?.state).toBe("idle")
      expect(entries[0]?.attemptState).toBe("succeeded")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish blocked without needs fails E_NEEDS", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.finish(finishInput({ status: "blocked", summary: "Stuck on scope." }), callerFor(child)))
      expect(error.code).toBe("E_NEEDS")
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("get_context returns the stored brief, checks and scope", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_006",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const delegated = required(await api.delegate(delegateInput({ requestID: "ctx-1" }), callerFor(parent))) as {
        run: string
        session: string
      }
      const child = await loadRun(root, delegated.run)
      if (child === undefined) throw new Error("missing child run")
      const value = required(await api.get_context({}, callerFor(child))) as {
        run: string
        brief: { objective: string }
        scope: { paths: string[] }
        checks: Array<{ id: string }>
        inbox: unknown[]
      }
      expect(value.run).toBe(delegated.run)
      expect(value.brief.objective).toContain("Fix the agent filter in the query module")
      expect(value.scope.paths).toEqual(["packages/plus/src/*"])
      expect(value.checks.map((check) => check.id)).toEqual(["unit"])
      expect(value.inbox).toEqual([])
      expect((value as Record<string, unknown>).conventions).toBeUndefined()
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("get_context on a root run returns brief: null without conventions", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        kind: "main",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_006_root",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.get_context({}, callerFor(parent))) as Record<string, unknown>
      expect(value.run).toBe("main-0123456789abcdef")
      expect(value.brief).toBeNull()
      expect(value.briefPath).toBeNull()
      expect(value.interfaces).toEqual([])
      expect(value.decisions).toEqual([])
      expect(value.scope).toEqual({ paths: [], forbidden: [] })
      expect(value.conventions).toBeUndefined()
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("status shows the child head and the check receipt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_007",
      })
      await saveRun(root, parent)
      await fs.writeFile(path.join(repo.dir, "t.test.ts"), PASSING_TEST)
      await git(repo.dir, ["add", "t.test.ts"])
      await git(repo.dir, ["commit", "-m", "test: add unit test"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      const child = childInRepo("w-cccccccccccccccc", { dir: repo.dir, head })
      const record: RunRecord = { ...child, base: repo.head, paths: ["t.test.ts"] }
      await saveRun(root, record)
      await saveRun(root, { ...parent, children: [record.id] })
      await atomicJson(path.join(root, "runs", record.id, "checks.json"), [{ id: "t", argv: ["bun", "test", "t.test.ts"] }])
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(record))) as { passed: boolean }
      expect(checked.passed).toBe(true)
      const entries = required(await api.status({ runs: [record.id] }, callerFor(parent))) as Array<{
        run: string
        head: string
        dirty: boolean
        checks: Array<{ id: string; passed: boolean | null; atHead: boolean }>
        report: unknown
      }>
      expect(entries).toHaveLength(1)
      expect(entries[0]?.run).toBe(record.id)
      expect(entries[0]?.head).toBe(head)
      expect(entries[0]?.dirty).toBe(false)
      expect(entries[0]?.checks).toEqual([{ id: "t", passed: true, atHead: true }])
      expect(entries[0]?.report).toBeNull()
      const defaults = required(await api.status({}, callerFor(parent))) as Array<{ run: string }>
      expect(defaults.map((entry) => entry.run).toSorted()).toEqual([parent.id, record.id].toSorted())
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("wait returns the settled report for an already-terminal attempt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_008",
      })
      await saveRun(root, parent)
      const child = await finishChild(root, repo, PASSING_TEST)
      await saveRun(root, { ...parent, children: [child.id] })
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const finished = required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child)))
      expect(finished).toBeDefined()
      const value = required(await api.wait({ runs: [child.id], timeoutMs: 10000 }, callerFor(parent))) as {
        settled: Array<{ run: string; attemptState: string; report: { status: string; summary: string; path: string } | null }>
        timedOut: boolean
        stillOpen: string[]
      }
      expect(value.timedOut).toBe(false)
      expect(value.stillOpen).toEqual([])
      expect(value.settled).toHaveLength(1)
      expect(value.settled[0]?.run).toBe(child.id)
      expect(value.settled[0]?.attemptState).toBe("succeeded")
      expect(value.settled[0]?.report?.status).toBe("done")
      expect(sessions.waited).toEqual([])
      expect(await Bun.file(path.join(root, "runs", child.id, "ack.json")).exists()).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("wait names what it acknowledged and status reports the same acked entry", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_ack",
      })
      await saveRun(root, parent)
      const child = await finishChild(root, repo, PASSING_TEST)
      await saveRun(root, { ...parent, children: [child.id] })
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child)))
      const before = required(await api.status({ runs: [child.id] }, callerFor(parent))) as Array<{
        acked: { attempt: number; at: string } | null
      }>
      expect(before[0]?.acked).toBeNull()
      const value = required(await api.wait({ runs: [child.id], timeoutMs: 10000 }, callerFor(parent))) as {
        acknowledged: string[]
        settled: Array<{ run: string }>
      }
      expect(value.acknowledged).toEqual([child.id])
      const after = required(await api.status({ runs: [child.id] }, callerFor(parent))) as Array<{
        attempt: number
        acked: { attempt: number; at: string } | null
      }>
      expect(after[0]?.acked?.attempt).toBe(after[0]?.attempt ?? -1)
      expect(typeof after[0]?.acked?.at).toBe("string")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("wait with ack:false reads the outcome without acknowledging it", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_noack",
      })
      await saveRun(root, parent)
      const child = await finishChild(root, repo, PASSING_TEST)
      await saveRun(root, { ...parent, children: [child.id] })
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child)))
      const value = required(await api.wait({ runs: [child.id], timeoutMs: 10000, ack: false }, callerFor(parent))) as {
        acknowledged: string[]
        settled: Array<{ run: string; attemptState: string }>
      }
      expect(value.settled[0]?.attemptState).toBe("succeeded")
      expect(value.acknowledged).toEqual([])
      expect(await Bun.file(path.join(root, "runs", child.id, "ack.json")).exists()).toBe(false)
      const entries = required(await api.status({ runs: [child.id] }, callerFor(parent))) as Array<{ acked: unknown }>
      expect(entries[0]?.acked).toBeNull()
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("wait rejects an unknown run with E_NOT_VISIBLE", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_009",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.wait({ runs: ["w-ffffffffffffffff"], timeoutMs: 10000 }, callerFor(parent)))
      expect(error.code).toBe("E_NOT_VISIBLE")
      expect(error.message).toBe("Run w-ffffffffffffffff is not in this namespace.")
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

async function dirtyChild(root: string, repo: { dir: string; head: string }, id: string): Promise<RunRecord> {
  await fs.mkdir(path.join(repo.dir, "src"), { recursive: true })
  await fs.writeFile(path.join(repo.dir, "src", "greeting.ts"), "export const greeting = 'hi'\n")
  await fs.writeFile(path.join(repo.dir, "t.test.ts"), PASSING_TEST)
  await git(repo.dir, ["add", "src/greeting.ts", "t.test.ts"])
  await git(repo.dir, ["commit", "-m", "test: add greeting and unit test"])
  const head = await git(repo.dir, ["rev-parse", "HEAD"])
  const child = childInRepo(id, { dir: repo.dir, head })
  const record: RunRecord = { ...child, base: repo.head, paths: ["src/*"] }
  await saveRun(root, record)
  await atomicJson(path.join(root, "runs", record.id, "checks.json"), [{ id: "t", argv: ["bun", "test", "t.test.ts"] }])
  return record
}

test("finish done with an unstaged modification names the full path in E_DIRTY", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await dirtyChild(root, repo, "w-eeeeeeeeeeeeeeee")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean }
      expect(checked.passed).toBe(true)
      await fs.writeFile(path.join(repo.dir, "src", "greeting.ts"), "export const greeting = 'hello'\n")
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Greeting updated." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toBe(
        "Worktree has uncommitted changes in [src/greeting.ts]. Call team_checkpoint first, or list them in deferred with a reason and use done_with_concerns.",
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done with an untracked file names the full path in E_DIRTY", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await dirtyChild(root, repo, "w-ffffffffffffffff")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean }
      expect(checked.passed).toBe(true)
      await fs.writeFile(path.join(repo.dir, "src", "untracked.ts"), "export const extra = 1\n")
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Greeting updated." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toBe(
        "Worktree has uncommitted changes in [src/untracked.ts]. Call team_checkpoint first, or list them in deferred with a reason and use done_with_concerns.",
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done with a spaced path names the full path in E_DIRTY", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await dirtyChild(root, repo, "w-1111111111111111")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean }
      expect(checked.passed).toBe(true)
      await fs.writeFile(path.join(repo.dir, "src", "with space.ts"), "export const spaced = 1\n")
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Greeting updated." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toBe(
        "Worktree has uncommitted changes in [src/with space.ts]. Call team_checkpoint first, or list them in deferred with a reason and use done_with_concerns.",
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

function finishedChild(id: string, repo: { dir: string; head: string }): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    role: "muse-implementer",
    directory: repo.dir,
    paths: ["docs/*"],
    base: repo.head,
    head: repo.head,
    state: "idle",
    attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
    parent: "main-0123456789abcdef",
    sessionID: `ses_finished_${id.slice(2, 6)}`,
  })
}

function workingChild(id: string, repo: { dir: string; head: string }): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    role: "muse-implementer",
    directory: repo.dir,
    paths: ["docs/*"],
    base: repo.head,
    head: repo.head,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    parent: "main-0123456789abcdef",
    sessionID: `ses_working_${id.slice(2, 6)}`,
  })
}

test("delegate succeeds after four finished children free their slots", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_bounds_free",
      })
      await saveRun(root, parent)
      const ids = ["w-aaaaaaaaaaaaaaaa", "w-bbbbbbbbbbbbbbbb", "w-cccccccccccccccc", "w-dddddddddddddddd"]
      for (const id of ids) await saveRun(root, finishedChild(id, repo))
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "bounds-free-1" }), callerFor(parent))) as {
        run: string
      }
      expect(typeof value.run).toBe("string")
      expect(value.run.startsWith("w-")).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("delegate refuses a fifth working child with E_BOUNDS", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_bounds_full",
      })
      await saveRun(root, parent)
      const ids = ["w-aaaaaaaaaaaaaaaa", "w-bbbbbbbbbbbbbbbb", "w-cccccccccccccccc", "w-dddddddddddddddd"]
      for (const id of ids) await saveRun(root, workingChild(id, repo))
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ requestID: "bounds-full-1" }), callerFor(parent)))
      expect(error.code).toBe("E_BOUNDS")
      // The bound is the member's "Children working at once" row; the old
      // text pointed at a policy file that is never loaded.
      expect(error.message).toBe(
        "In-flight limit 4 reached (w-aaaaaaaaaaaaaaaa, w-bbbbbbbbbbbbbbbb, w-cccccccccccccccc, w-dddddddddddddddd). Wait for a child to settle (tools.team.wait) first.",
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("B — four live children plus one superseded-on-create → a fifth delegate succeeds", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_bounds_d3",
      })
      await saveRun(root, parent)

      // 3 live working children for parent
      const parentLiveIds = ["w-aaaaaaaaaaaaaaaa", "w-bbbbbbbbbbbbbbbb", "w-cccccccccccccccc"]
      for (const id of parentLiveIds) await saveRun(root, workingChild(id, repo))

      // 1 live working child for another parent (total 4 live children in workspace)
      const otherChild = { ...workingChild("w-dddddddddddddddd", repo), parent: "main-other0000000000" }
      await saveRun(root, otherChild)

      // 1 child whose session creation failed (superseded-on-create, sessionID is null)
      const failedChild = baseRun({
        id: "w-eeeeeeeeeeeeeeee",
        role: "muse-implementer",
        directory: repo.dir,
        paths: ["docs/*"],
        base: repo.head,
        head: repo.head,
        state: "starting",
        attempts: [],
        parent: parent.id,
        sessionID: null,
      })
      await saveRun(root, failedChild)

      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const result = await api.delegate(delegateInput({ requestID: "fifth-delegate-1" }), callerFor(parent))
      const value = required(result) as { run: string }
      expect(typeof value.run).toBe("string")
      expect(value.run.startsWith("w-")).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("delegate switches the child to the role pin before prompting", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_pin_switch",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const state = teamState()
      state.activeModels.set("muse-implementer", { providerID: "cliproxyapi", modelID: "muse-spark-1.3-contributor", variant: "high" })
      const api = createTeamApi(context({ session: sessions.domain }), state)
      const value = required(await api.delegate(delegateInput({ requestID: "pin-switch-1" }), callerFor(parent))) as {
        run: string
        session: string
      }
      expect(sessions.switched).toHaveLength(1)
      expect(sessions.switched[0]?.sessionID).toBe(value.session)
      const model = sessions.switched[0]?.model as { providerID: unknown; id: unknown; variant?: unknown }
      expect(model.providerID).toBe("cliproxyapi")
      expect(model.id).toBe("muse-spark-1.3-contributor")
      expect(model.variant).toBe("high")
      expect(sessions.order).toEqual(["switchModel", "prompt"])
      expect(sessions.prompted).toHaveLength(1)
      expect(sessions.prompted[0]?.sessionID).toBe(value.session)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("delegate without a role pin never switches but still prompts", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "opus-orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_pin_missing",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "pin-missing-1" }), callerFor(parent))) as {
        run: string
        session: string
      }
      expect(sessions.switched).toHaveLength(0)
      expect(sessions.prompted).toHaveLength(1)
      expect(sessions.prompted[0]?.sessionID).toBe(value.session)
      expect(typeof value.run).toBe("string")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish ignores Plus project.json but still reports real untracked files", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)
      const child = childInRepo("w-3333333333333333", repo)
      await saveRun(root, child)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child))) as {
        dirty: boolean
        dirtyFiles: string[]
      }
      expect(value.dirty).toBe(false)
      expect(value.dirtyFiles).toEqual([])
      const entries = required(await api.status({ runs: [child.id] }, callerFor(child))) as Array<{ dirty: boolean }>
      expect(entries).toHaveLength(1)
      expect(entries[0]?.dirty).toBe(false)
      const child2 = childInRepo("w-4444444444444444", repo)
      await saveRun(root, child2)
      await fs.writeFile(path.join(repo.dir, "real-untracked.txt"), "real\n")
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Greeting updated." }), callerFor(child2)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toContain("real-untracked.txt")
      expect(error.message).not.toContain(".opencodeplus")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done succeeds with an untracked Plus project.json and passing assigned check", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, PASSING_TEST)
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.finish(finishInput({ status: "done", summary: "Completed task with passing check." }), callerFor(child))) as {
        head: string
        reportPath: string
        dirty: boolean
        dirtyFiles: string[]
        checks: Array<{ id: string; passed: boolean; head: string; at: number }>
      }
      expect(value.dirty).toBe(false)
      expect(value.dirtyFiles).toEqual([])
      expect(value.checks).toEqual([{ id: "t", passed: true, head: value.head, at: expect.any(Number) }])
      expect(await Bun.file(value.reportPath).exists()).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish reports modified tracked project.json as dirty", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)
      await git(repo.dir, ["add", ".opencodeplus/project.json"])
      await git(repo.dir, ["commit", "-m", "chore: track project.json"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      const child = childInRepo("w-5555555555555555", { dir: repo.dir, head })
      await saveRun(root, child)

      // Modify the tracked project.json
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":2,"protectedAgents":["new"]}\n`)

      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Modified tracked project." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toContain(".opencodeplus/project.json")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish reports new untracked file under .opencodeplus as dirty", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "agent.json"), `{"agent":"custom"}\n`)
      const child = childInRepo("w-6666666666666666", repo)
      await saveRun(root, child)

      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Added untracked config." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toContain(".opencodeplus/agent.json")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)
